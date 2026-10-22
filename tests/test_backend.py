"""Offline contract checks. No real credentials, downloads or network service required."""
import json
from pathlib import Path
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import patch

import official_data
import server


class DemandCacheTests(unittest.TestCase):
    def test_hourly_cache_restart_and_concurrent_requests(self):
        calls = []
        clock = [1792650000000]
        def make_adapter(key):
            def run():
                calls.append(key)
                return []
            return run
        adapters = {key: make_adapter(key) for key in official_data.SOURCES}
        with tempfile.TemporaryDirectory() as tmp, patch.object(server, 'ADAPTERS', adapters), \
                patch.object(server, 'now_ms', lambda: clock[0]):
            path = Path(tmp) / 'weather.sqlite3'
            store = server.WeatherStore(path)
            self.assertEqual(calls, [])
            first = store.collect()
            self.assertEqual(len(calls), len(adapters))
            self.assertIs(store.collect(), first)
            store.db.close()
            clock[0] += 3599000
            restored = server.WeatherStore(path)
            self.assertIsNotNone(restored.snapshot)
            restored.collect()
            self.assertEqual(len(calls), len(adapters))
            restored.db.close()
            clock[0] += 2000
            expired = server.WeatherStore(path)
            self.assertIsNone(expired.snapshot)
            self.assertEqual(len(calls), len(adapters))
            with ThreadPoolExecutor(max_workers=12) as pool:
                results = list(pool.map(lambda _: expired.collect(), range(12)))
            self.assertEqual(len(calls), 2 * len(adapters))
            self.assertTrue(all(result is results[0] for result in results))
            expired.db.close()

    def test_failure_retains_data_but_explicit_empty_clears_it(self):
        now = 1792650000000
        record = official_data.storm_record('JMA', 'CHECK', '', now, now,
            [official_data.point(now, 20, 125, 30, 980)],
            [official_data.point(now, 20, 125, 30, 980)])
        adapters = {key: lambda: [] for key in official_data.SOURCES}
        adapters['JMA'] = lambda: [record]
        with tempfile.TemporaryDirectory() as tmp, patch.object(server, 'ADAPTERS', adapters), \
                patch.object(server, 'now_ms', lambda: now):
            store = server.WeatherStore(Path(tmp) / 'weather.sqlite3')
            self.assertEqual(len(store.collect()['typhoons']), 1)
            def failed():
                raise RuntimeError('controlled upstream failure')
            adapters['JMA'] = failed
            store.expires = 0
            result = store.collect()
            self.assertEqual(result['sources']['JMA']['status'], 'late')
            self.assertEqual(len(result['typhoons']), 1)
            adapters['JMA'] = lambda: []
            store.expires = 0
            result = store.collect()
            self.assertEqual(result['sources']['JMA']['status'], 'none')
            self.assertEqual(result['typhoons'], [])
            store.db.close()


class CwaContractTests(unittest.TestCase):
    def test_authorization_stays_out_of_arguments_and_error_messages(self):
        key = 'test-credential-not-a-real-key'
        with patch('official_data.subprocess.run', return_value=SimpleNamespace(
                returncode=0, stdout=b'<product/>\n200')) as run:
            self.assertEqual(official_data.fetch_cwa_api(key), '<product/>')
            args, kwargs = run.call_args
            self.assertTrue(all(key not in str(value) for value in args[0]))
            self.assertIn(key, kwargs['input'].decode())
        with patch('official_data.subprocess.run', return_value=SimpleNamespace(
                returncode=22, stdout=b'\n401')):
            with self.assertRaises(RuntimeError) as raised:
                official_data.fetch_cwa_api(key)
            self.assertIn('授權失敗', str(raised.exception))
            self.assertNotIn(key, str(raised.exception))

    def test_namespaced_cwa_positions_radii_and_missing_values(self):
        # Schema from CWA's published product specification, using synthetic test values.
        text = '''<cwaopendata xmlns="urn:cwa:gov:tw:cwacommon:0.1">
          <Sent>2026-10-22T14:37:37+08:00</Sent><Status>Actual</Status>
          <Dataset><TropicalCyclones><TropicalCyclone>
          <TyphoonName>TEST</TyphoonName><CwaTyphoonName>測試</CwaTyphoonName>
          <CwaTyNo>01</CwaTyNo><AnalysisData><Fix>
          <DateTime>2026-10-22T14:00:00+08:00</DateTime>
          <CoordinateLatitude>20.9</CoordinateLatitude><CoordinateLongitude>125.4</CoordinateLongitude>
          <MaxWindSpeed>51</MaxWindSpeed><MaxGustSpeed>63</MaxGustSpeed><Pressure>925</Pressure>
          <Circle15ms><Radius>320</Radius><QuadrantRadii><Radius dir="NE">350</Radius>
          <Radius dir="SE">300</Radius><Radius dir="SW">290</Radius><Radius dir="NW">350</Radius>
          </QuadrantRadii></Circle15ms><Circle25ms><Radius>160</Radius></Circle25ms>
          </Fix></AnalysisData><ForecastData><Fix>
          <InitialTime>2026-10-22T14:00:00+08:00</InitialTime><ForecastHour>6</ForecastHour>
          <CoordinateLatitude>21.4</CoordinateLatitude><CoordinateLongitude>124.8</CoordinateLongitude>
          <Pressure>925</Pressure><Radius70PercentProbability>30</Radius70PercentProbability>
          </Fix></ForecastData></TropicalCyclone></TropicalCyclones></Dataset></cwaopendata>'''
        record = official_data.parse_cwa_api(text)[0]
        analysis, forecast = record['points']
        self.assertEqual(analysis['windRadii15ms']['SW'], 290)
        self.assertEqual(analysis['windRadius25ms'], 160)
        self.assertEqual(forecast['time'] - analysis['time'], 6 * 3600000)
        self.assertEqual(forecast['coneProbability'], 70)
        self.assertIsNone(forecast['w'])
        self.assertNotIn('Authorization', record['url'])
        self.assertEqual(record['transport'], 'cwa-member-api')


if __name__ == '__main__':
    unittest.main()
