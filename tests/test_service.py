"""Security and persistence regressions using local HTTP and disposable databases."""
from contextlib import contextmanager
from datetime import datetime
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import official_data
import server


@contextmanager
def running_server(root, store):
    with patch.object(server, 'ROOT', root):
        httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), server.handler_for(store))
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            yield httpd.server_address
        finally:
            httpd.shutdown()
            thread.join()
            httpd.server_close()


def request(address, path, method='GET', headers=None):
    connection = http.client.HTTPConnection(*address, timeout=2)
    try:
        connection.request(method, path, headers=headers or {})
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        connection.close()


class PublicFileTests(unittest.TestCase):
    def test_http_connections_have_deadlines_and_bounded_workers(self):
        with server.WeatherHTTPServer(('127.0.0.1', 0), server.handler_for(None)) as httpd:
            # Holding every slot models slow clients; the next connection must
            # be refused without creating another unbounded handler thread.
            held = []
            while httpd.request_slots.acquire(blocking=False):
                held.append(True)
            try:
                import socket
                client, accepted = socket.socketpair()
                with client, accepted:
                    client.settimeout(1)
                    httpd.process_request(accepted, ('127.0.0.1', 0))
                    self.assertIn(b'503', client.recv(1024))
                with socket.create_connection(httpd.server_address) as client:
                    accepted, _ = httpd.get_request()
                    with accepted:
                        self.assertGreater(accepted.gettimeout(), 0)
                        self.assertLessEqual(accepted.gettimeout(), 30)
            finally:
                for _ in held:
                    httpd.request_slots.release()

    def test_symlinks_cannot_expose_private_files_in_project(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / '.env').write_text('PRIVATE_TEST_VALUE')
            (root / 'map.js').symlink_to(root / '.env')
            with running_server(root, None) as address:
                for method in ('GET', 'HEAD'):
                    status, _, body = request(address, '/map.js', method)
                    self.assertEqual(status, 404)
                    self.assertNotIn(b'PRIVATE_TEST_VALUE', body)

    def test_root_without_index_never_lists_project_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / '.env').write_text('PRIVATE_TEST_VALUE')
            with running_server(root, None) as address:
                self.assertEqual(request(address, '/')[0], 404)

    def test_private_and_encoded_paths_denied_and_public_assets_work(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'index.html').write_text('safe page')
            (root / '.env').write_text('PRIVATE_TEST_VALUE')
            with running_server(root, None) as address:
                for path in ('/.env', '/%2eenv', '/vendor/../.env', '/.git/config', '/server.py', '/vendor/'):
                    self.assertEqual(request(address, path)[0], 404, path)
                status, headers, body = request(address, '/?view=1')
                self.assertEqual((status, body), (200, b'safe page'))
                self.assertEqual(headers.get('Cache-Control'), 'no-cache')

    def test_cross_site_visits_cannot_trigger_upstream_collection(self):
        class Store:
            snapshot = {'version': 'abc'}
            visits = 0
            def refresh_for_visit(self):
                self.visits += 1
            def cached(self):
                return self.snapshot
        store = Store()
        with tempfile.TemporaryDirectory() as tmp, running_server(Path(tmp), store) as address:
            status, _, _ = request(address, '/api/typhoons?visit=1', headers={'Sec-Fetch-Site': 'cross-site'})
            self.assertEqual(status, 403)
            self.assertEqual(store.visits, 0)
            status, headers, _ = request(address, '/api/typhoons?visit=1')
            self.assertEqual((status, store.visits), (200, 1))
            status, _, body = request(address, '/api/typhoons', headers={'If-None-Match': headers['ETag']})
            self.assertEqual((status, body, store.visits), (304, b'', 1))


class CollectionTests(unittest.TestCase):
    def test_named_cyclone_continues_across_new_year_without_splitting(self):
        clock = [official_data.timestamp('2026-12-31T18:00:00Z')]
        def adapter():
            p = official_data.point(clock[0], 20, 125)
            return [official_data.storm_record('CWA', 'CHECK', '', clock[0], clock[0], [p], [p], '29')]
        adapters = {key: lambda: [] for key in official_data.SOURCES}
        adapters['CWA'] = adapter
        with tempfile.TemporaryDirectory() as tmp, patch.object(server, 'ADAPTERS', adapters), patch.object(server, 'now_ms', lambda: clock[0]):
            store = server.WeatherStore(Path(tmp) / 'cache.db')
            self.addCleanup(store.db.close)
            store.collect()
            clock[0] += 12 * 3600000
            result = store.collect()
            self.assertEqual(result['typhoons'][0]['id'], '2026-CHECK')
            self.assertEqual(len(result['typhoons'][0]['sources']['CWA']['history']), 2)

    def test_unnamed_cyclone_continues_only_with_same_source_number(self):
        clock = [official_data.timestamp('2026-12-31T18:00:00Z')]
        def adapter():
            p = official_data.point(clock[0], 20, 125)
            return [official_data.storm_record('JTWC', 'TD', '', clock[0], clock[0], [p], [p], '29W')]
        adapters = {key: lambda: [] for key in official_data.SOURCES}
        adapters['JTWC'] = adapter
        with tempfile.TemporaryDirectory() as tmp, patch.object(server, 'ADAPTERS', adapters), patch.object(server, 'now_ms', lambda: clock[0]):
            store = server.WeatherStore(Path(tmp) / 'cache.db')
            self.addCleanup(store.db.close)
            store.collect()
            clock[0] += 12 * 3600000
            result = store.collect()
            self.assertEqual(result['typhoons'][0]['id'], '2026-JTWC-29W')
            self.assertEqual(len(result['typhoons'][0]['history']), 2)

    def test_cold_cache_does_not_block_request_threads(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = server.WeatherStore(Path(tmp) / 'cache.db')
            self.addCleanup(store.db.close)
            with patch.object(store.ready, 'wait', side_effect=AssertionError('HTTP blocked on collection')):
                with self.assertRaises(RuntimeError):
                    store.cached()

    def test_round_failure_rolls_back_all_source_states(self):
        clock = [1792650000000]
        adapters = {key: lambda: [] for key in official_data.SOURCES}
        with tempfile.TemporaryDirectory() as tmp, patch.object(server, 'ADAPTERS', adapters), patch.object(server, 'now_ms', lambda: clock[0]):
            store = server.WeatherStore(Path(tmp) / 'cache.db')
            self.addCleanup(store.db.close)
            first = store.collect()
            clock[0] += 300001
            with patch.object(store, 'build_snapshot', side_effect=ValueError('failed publication')):
                with self.assertRaises(ValueError):
                    store.collect()
            self.assertIs(store.snapshot, first)
            self.assertEqual({row[0] for row in store.db.execute('SELECT checked FROM source_state')}, {1792650000000})

    def test_stale_products_and_malformed_history_preserve_last_good_data(self):
        clock = [1792650000000]
        p = official_data.point(clock[0], 20, 125)
        record = official_data.storm_record('JMA', 'CHECK', '', clock[0], clock[0], [p], [p])
        adapters = {key: lambda: [] for key in official_data.SOURCES}
        adapters['JMA'] = lambda: [record]
        with tempfile.TemporaryDirectory() as tmp, patch.object(server, 'ADAPTERS', adapters), patch.object(server, 'now_ms', lambda: clock[0]):
            store = server.WeatherStore(Path(tmp) / 'cache.db')
            self.addCleanup(store.db.close)
            store.collect()
            clock[0] += 300001
            bad = dict(record, history=[])
            adapters['JMA'] = lambda: [bad]
            result = store.collect()
            self.assertEqual(result['sources']['JMA']['status'], 'late')
            self.assertEqual(len(result['typhoons']), 1)
            clock[0] += 49 * 3600000
            adapters['JMA'] = lambda: [record]
            result = store.collect()
            self.assertEqual(result['sources']['JMA']['status'], 'error')
            self.assertEqual(result['typhoons'], [])

    def test_unchanged_content_keeps_version(self):
        clock = [1792650000000]
        adapters = {key: lambda: [] for key in official_data.SOURCES}
        with tempfile.TemporaryDirectory() as tmp, patch.object(server, 'ADAPTERS', adapters), patch.object(server, 'now_ms', lambda: clock[0]):
            store = server.WeatherStore(Path(tmp) / 'cache.db')
            self.addCleanup(store.db.close)
            first = store.collect()
            clock[0] += 300001
            second = store.collect()
            self.assertNotEqual(first['synced'], second['synced'])
            self.assertEqual(first['version'], second['version'])

    def test_schedule_uses_taiwan_clock_and_rolls_over_day(self):
        for current, expected in (
            ('2026-10-22T00:04:59+08:00', '2026-10-22T00:05:00+08:00'),
            ('2026-10-22T00:05:00+08:00', '2026-10-22T00:20:00+08:00'),
            ('2026-10-22T00:20:00+08:00', '2026-10-22T00:25:00+08:00'),
            ('2026-10-22T00:25:00+08:00', '2026-10-22T00:50:00+08:00'),
            ('2026-10-22T23:50:00+08:00', '2026-10-23T00:05:00+08:00'),
        ):
            self.assertEqual(server.next_collection_time(datetime.fromisoformat(current).timestamp()), datetime.fromisoformat(expected).timestamp())
