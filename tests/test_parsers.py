from contextlib import closing
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import import_history
import official_data


class ParserSafetyTests(unittest.TestCase):
    def test_unnamed_jma_cyclones_have_distinct_ids(self):
        listing = [{'tropicalCyclone': code} for code in ('TC2601', 'TC2602')]
        product = [{'issue': {'UTC': '2026-10-22T00:00:00Z'}, 'name': {'en': 'TD'}},
            {'position': {'deg': [20, 125]}, 'validtime': {'UTC': '2026-10-22T00:00:00Z'}}]
        with patch.object(official_data, 'json_product', side_effect=[listing, product, product]):
            records = official_data.jma()
        self.assertEqual(len({r['id'] for r in records}), 2)

    def test_cross_year_product_keeps_season_from_official_number(self):
        actual = official_data.point(official_data.timestamp('2027-01-01T06:00:00Z'), 20, 125)
        r = official_data.storm_record('CMA', 'CHECK', '', actual['time'], actual['time'], [actual], [actual], '2630')
        self.assertEqual(r['id'], '2026-CHECK')

    def test_naive_timestamp_is_not_interpreted_in_host_timezone(self):
        with self.assertRaises(ValueError):
            official_data.timestamp('2026-10-22T00:00:00')
        self.assertEqual(official_data.timestamp('2026-10-22T08:00:00+08:00'), 1792627200000)

    def test_hko_missing_analysis_cannot_reuse_previous_cyclone_base(self):
        listing = '<TropicalCycloneList>' + ''.join(
            f'<TropicalCyclone><TropicalCycloneID>{i}</TropicalCycloneID><TropicalCycloneEnglishName>STORM{i}</TropicalCycloneEnglishName></TropicalCyclone>'
            for i in (1, 2)) + '</TropicalCycloneList>'
        def product(analysis):
            entry = '<Time>2026-10-22T00:00:00Z</Time><Latitude>20.0N</Latitude><Longitude>125.0E</Longitude>'
            return '<root><BulletinHeader><BulletinTime>2026-10-22T01:00:00Z</BulletinTime></BulletinHeader><WeatherReport>' + (
                f'<AnalysisInformation>{entry}</AnalysisInformation>' if analysis else f'<PastInformation>{entry}</PastInformation>') + f'<ForecastInformation>{entry}</ForecastInformation></WeatherReport></root>'
        with patch.object(official_data, 'fetch', side_effect=[listing, product(True), product(False)]):
            with self.assertRaises(ValueError):
                official_data.hko()

    def test_jma_archive_uses_requested_century(self):
        text = '66666 5801 1 1 0 6 TEST 19580101\n58010100 002 2 100 1200 1000 000\n'
        with patch.object(import_history, 'fetch', return_value=text):
            result = import_history.jma_history(1958)
        when = result['TEST']['history'][0]['time']
        self.assertEqual(datetime.fromtimestamp(when / 1000, timezone.utc).year, 1958)

    def test_empty_jma_archive_is_rejected(self):
        with patch.object(import_history, 'fetch', return_value=''):
            with self.assertRaises(ValueError):
                import_history.jma_history(2026)

    def test_partial_successful_import_cannot_delete_previous_provider_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'archive.db'
            original = dict(id='2026-TEST', sources={'JMA': {'history': [{'time': 1792627200000}], 'batches': []}})
            with closing(sqlite3.connect(path)) as db, db:
                db.execute('CREATE TABLE archive_storms (storm TEXT PRIMARY KEY, year INTEGER, payload TEXT)')
                db.execute('INSERT INTO archive_storms VALUES (?,?,?)', ('2026-TEST', 2026, json.dumps(original)))
            listing = {'typhoonList': [[1, 'TEST']]}
            detail = {'typhoon': [1, 'TEST', '測試', '2601', None, None, None, None,
                [[None, None, 1792627200000, None, 125, 20, 980, 30, None, None, None, {}, None]]]}
            with patch.object(import_history, 'cwa_catalog', return_value=[{'id': '202601', 'eng_name': 'TEST', 'cht_name': '測試'}]), \
                    patch.object(import_history, 'json_product', side_effect=[listing, detail]), \
                    patch.object(import_history, 'jma_history', return_value={}):
                with self.assertRaises(RuntimeError):
                    import_history.run(2026, path)
            with closing(sqlite3.connect(path)) as db, db:
                self.assertEqual(json.loads(db.execute('SELECT payload FROM archive_storms').fetchone()[0]), original)

    def test_cma_archive_accepts_cyclone_crossing_new_year(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'archive.db'
            listing = {'typhoonList': [[1, 'TEST']]}
            times = [official_data.timestamp('2026-12-31T18:00:00Z'), official_data.timestamp('2027-01-01T00:00:00Z')]
            detail = {'typhoon': [1, 'TEST', '測試', '2630', None, None, None, None,
                [[None, None, stamp, None, 125, 20, 980, 30, None, None, None, {}, None] for stamp in times]]}
            with patch.object(import_history, 'cwa_catalog', return_value=[{'id': '202630', 'eng_name': 'TEST', 'cht_name': '測試'}]), \
                    patch.object(import_history, 'json_product', side_effect=[listing, detail]), \
                    patch.object(import_history, 'jma_history', return_value={'TEST': {'history': [{'time': times[0]}], 'batches': []}}):
                import_history.run(2026, path)
            with closing(sqlite3.connect(path)) as db:
                storm = json.loads(db.execute('SELECT payload FROM archive_storms').fetchone()[0])
                self.assertEqual([p['time'] for p in storm['sources']['CMA']['history']], times)
