#!/usr/bin/env python3
"""Same-origin official weather API and local map server (Python 3.10+, curl)."""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

from official_data import ADAPTERS, SOURCES, now_ms

ROOT = Path(__file__).resolve().parent
FETCH_MINUTES = (5, 20, 25, 50)
VISIT_REFRESH_SECONDS = 5 * 60
SCHEDULE_TIMEZONE = timezone(timedelta(hours=8))
PUBLIC_FILES = frozenset({
    '/index.html', '/app.js', '/bootstrap.mjs', '/map.js', '/map.css', '/basemap-style.json',
    '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css', '/vendor/leaflet/LICENSE',
    '/vendor/maplibre/maplibre-gl.mjs', '/vendor/maplibre/maplibre-gl-shared.mjs',
    '/vendor/maplibre/maplibre-gl-worker.mjs', '/vendor/maplibre/maplibre-gl.css',
    '/vendor/maplibre/leaflet-maplibre-gl.js', '/vendor/maplibre/LICENSE.txt',
    '/vendor/maplibre/leaflet-LICENSE', '/data/basemap/water.geojson',
    '/data/basemap/water.geojson.gz', '/data/basemap/provenance.json', '/data/basemap/README.md',
})


def validate_records(agency, records, checked):
    """Reject malformed or stale active products before they enter the cache."""
    if not isinstance(records, list):
        raise ValueError('Invalid official records')
    latest = {}
    for record in records:
        if record['agency'] != agency or not record['points'] or not record['history']:
            raise ValueError('Missing official analysis or forecast')
        for stamp in (record['issued'], record['base']):
            if not isinstance(stamp, (int, float)) or not math.isfinite(stamp):
                raise ValueError('Invalid official time')
            if stamp > checked + 3600000:
                raise ValueError('Official product is dated in the future')
        for p in record['points'] + record['history']:
            if not all(isinstance(p[k], (int, float)) and math.isfinite(p[k]) for k in ('time', 'lat', 'lon')):
                raise ValueError('Invalid official point')
            if not -90 <= p['lat'] <= 90 or not -180 <= p['lon'] <= 180:
                raise ValueError('Invalid official coordinates')
        if any(p['time'] > record['issued'] + 3600000 for p in record['history']):
            raise ValueError('Official analysis is dated in the future')
        latest[record['id']] = max(latest.get(record['id'], 0), min(record['issued'], record['base']))
    if any(checked - stamp > 48 * 3600000 for stamp in latest.values()):
        raise RuntimeError('官方活動產品已超過 48 小時，保留上次成功資料')


def next_collection_time(current=None):
    current = time.time() if current is None else current
    hour = datetime.fromtimestamp(current, SCHEDULE_TIMEZONE).replace(minute=0, second=0, microsecond=0)
    for minute in FETCH_MINUTES:
        candidate = (hour + timedelta(minutes=minute)).timestamp()
        if candidate > current:
            return candidate
    return (hour + timedelta(hours=1, minutes=FETCH_MINUTES[0])).timestamp()


class WeatherStore:
    def __init__(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute('''CREATE TABLE IF NOT EXISTS bulletins (
            storm TEXT, agency TEXT, issued INTEGER, payload TEXT,
            PRIMARY KEY(storm, agency, issued))''')
        self.db.execute('''CREATE TABLE IF NOT EXISTS source_state (
            agency TEXT PRIMARY KEY, checked INTEGER, succeeded INTEGER,
            active TEXT, error TEXT)''')
        self.db.execute('CREATE TABLE IF NOT EXISTS collection_state (id INTEGER PRIMARY KEY CHECK(id=1), completed INTEGER NOT NULL)')
        self.db.commit()
        self.lock = threading.Lock()
        self.ready = threading.Event()
        self.request_lock = threading.Lock()
        self.request_worker = None
        self.snapshot = None
        # Serve the last persisted result while waiting for the next scheduled refresh.
        states = self.db.execute('SELECT agency,checked FROM source_state').fetchall()
        if {row[0] for row in states} == set(SOURCES):
            saved = self.db.execute('SELECT completed FROM collection_state WHERE id=1').fetchone()
            checks = {row[1] for row in states}
            # Migrate the previous cache only when all sources completed the same round.
            completed = saved[0] if saved else (next(iter(checks)) if len(checks) == 1 else None)
            age = (now_ms() - completed) / 1000 if completed is not None else None
            if age is not None and age >= 0:
                self.snapshot = self.build_snapshot(completed)
                self.ready.set()

    def collect(self, force=False):
        requested = now_ms()
        with self.lock:
            if self.snapshot is not None:
                completed = self.snapshot['synced']
                if completed >= requested or (not force and 0 <= requested - completed <= VISIT_REFRESH_SECONDS * 1000):
                    return self.snapshot
            checked = now_ms()
            outcomes = {}
            with ThreadPoolExecutor(max_workers=6) as pool:
                futures = {pool.submit(adapter): agency for agency, adapter in ADAPTERS.items()}
                for future in as_completed(futures):
                    agency = futures[future]
                    try:
                        records = future.result()
                        validate_records(agency, records, checked)
                        json.dumps(records, allow_nan=False)
                        outcomes[agency] = (records, None)
                    except Exception as error:
                        message = str(error) if isinstance(error, RuntimeError) else '官方資料格式解析失敗'
                        outcomes[agency] = ([], message)
            current_records = [r for records, _ in outcomes.values() for r in records]
            completed = now_ms()
            # Publish a complete round atomically. A crash or invalid snapshot must
            # not persist partially refreshed sources with an old completion time.
            with self.db:
                for agency, (records, error) in outcomes.items():
                    if error is None:
                        records = [self.resolve_season(r, current_records) for r in records]
                        active = sorted({r['id'] for r in records})
                        rows = [(r['id'], agency, r['issued'], json.dumps(r,
                            ensure_ascii=False, allow_nan=False)) for r in records]
                        self.db.executemany('INSERT OR REPLACE INTO bulletins VALUES (?,?,?,?)', rows)
                        self.db.execute('INSERT OR REPLACE INTO source_state VALUES (?,?,?,?,?)',
                            (agency, checked, checked, json.dumps(active), None))
                    else:
                        old = self.db.execute('SELECT succeeded,active FROM source_state WHERE agency=?',
                            (agency,)).fetchone()
                        self.db.execute('INSERT OR REPLACE INTO source_state VALUES (?,?,?,?,?)',
                            (agency, checked, old[0] if old else None, old[1] if old else '[]', error))
                self.db.execute('INSERT OR REPLACE INTO collection_state VALUES (1,?)', (completed,))
                snapshot = self.build_snapshot(completed)
            self.snapshot = snapshot
            self.ready.set()
            return self.snapshot

    def resolve_season(self, record, current_records):
        # CWA/JTWC numbers omit the season year. Carry cyclones over New Year
        # using recent products. Unnamed systems additionally require the same
        # provider and original number; they must never merge across providers.
        year, name = record['id'].split('-', 1)
        previous_id = f'{int(year) - 1}-{name}'
        candidates = [r for r in current_records if r['id'] == previous_id]
        row = self.db.execute('SELECT payload FROM bulletins WHERE storm=? ORDER BY issued DESC LIMIT 1',
            (previous_id,)).fetchone()
        if row:
            candidates.append(json.loads(row[0]))
        if '-' in name:
            candidates = [r for r in candidates if r['agency'] == record['agency']
                and r.get('number') and r['number'] == record.get('number')]
        if any(abs(record['base'] - r['base']) <= 7 * 86400000 for r in candidates):
            return dict(record, id=previous_id)
        return record

    def refresh_for_visit(self):
        with self.request_lock:
            if self.snapshot is not None and 0 <= now_ms() - self.snapshot['synced'] <= VISIT_REFRESH_SECONDS * 1000:
                return
            if self.request_worker is not None and self.request_worker.is_alive():
                return
            def run():
                try:
                    self.collect()
                except Exception:
                    print('Visitor collection failed; retaining previous data', flush=True)
            self.request_worker = threading.Thread(target=run, name='visitor-collection', daemon=True)
            self.request_worker.start()

    def cached(self):
        # Existing snapshots are immutable after publication, so readers need
        # not wait for the collection lock or trigger another upstream request.
        if self.snapshot is None:
            raise RuntimeError('首次資料擷取尚未完成')
        return self.snapshot

    def build_snapshot(self, checked):
        statuses, storms = {}, {}
        if self.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='archive_storms'").fetchone():
            for (payload,) in self.db.execute('SELECT payload FROM archive_storms'):
                storm = json.loads(payload)
                storms[storm['id']] = storm
        for agency, (name, average, url) in SOURCES.items():
            state = self.db.execute('SELECT checked,succeeded,active,error FROM source_state WHERE agency=?',
                (agency,)).fetchone()
            last_check, succeeded, active, error = state
            active = json.loads(active)
            # Failed fetches may use a previous successful product, never invent new data.
            if error and (succeeded is None or checked - succeeded > 48*3600000):
                active = []
            statuses[agency] = dict(name=name, average=average, url=url, checked=last_check,
                succeeded=succeeded, status=('late' if active else 'error') if error else ('ok' if active else 'none'),
                message=error or ('擷取成功' if active else '目前沒有活動中的熱帶氣旋'))
            if agency == 'KMA':
                statuses[agency]['status'] = 'unconfigured'
            for ident in active:
                rows = self.db.execute('SELECT payload FROM bulletins WHERE storm=? AND agency=? ORDER BY issued DESC',
                    (ident, agency)).fetchall()
                if not rows:
                    continue
                records = [json.loads(row[0]) for row in rows]
                newest = records[0]
                t = storms.setdefault(ident, dict(id=ident, nameEn=newest['nameEn'], nameZh='', sources={}))
                t['active'] = True
                if newest['nameZh'] and (agency == 'CWA' or not t['nameZh']):
                    t['nameZh'] = newest['nameZh']
                # Combine only observations from this same provider and cyclone.
                history = {p['time']: dict(p, agency=agency)
                    for r in reversed(records) for p in r['history']}
                archived = t['sources'].get(agency, {})
                combined_history = {p['time']: p for p in archived.get('history', [])}
                combined_history.update(history)
                batches = {b['issued']: b for b in archived.get('batches', [])}
                batches.update({r['issued']: dict(issued=r['issued'], base=r['base'], points=r['points']) for r in records})
                t['sources'][agency] = dict(archived, url=newest['url'], transport=newest.get('transport', 'official-public-product'),
                    number=newest.get('number', archived.get('number', '')),
                    batches=sorted(batches.values(), key=lambda b: b['issued'], reverse=True),
                    history=sorted(combined_history.values(), key=lambda p: p['time']))
        for t in storms.values():
            t['name'] = (t['nameZh'] + ' ' if t['nameZh'] else '') + t['nameEn']
            # A timeline uses one provider's actual observations, not an interleaved synthetic track.
            available = [(key, source['history']) for key, source in t['sources'].items() if source['history']]
            priority = {'CWA': 3, 'JMA': 2, 'HKO': 1, 'CMA': 0}
            key, history = next((pair for pair in available if pair[0] == 'CWA' and len(pair[1]) > 1), None) or max(available, key=lambda pair: (len(pair[1]), priority.get(pair[0], -1)))
            t['historyAgency'], t['history'] = key, history
            t['batchTimes'] = sorted({b['issued'] for src in t['sources'].values() for b in src['batches']}, reverse=True)
        snapshot = dict(schemaVersion=1, mock=False, synced=checked, sources=statuses,
            typhoons=sorted(storms.values(), key=lambda t: (not t.get('active', False), -t['history'][-1]['time'], t['id'])))
        # Collection timestamps change even if the upstream content is identical.
        content = dict(snapshot, sources={key: {k: v for k, v in source.items()
            if k not in ('checked', 'succeeded')} for key, source in statuses.items()})
        content.pop('synced')
        snapshot['version'] = hashlib.sha256(json.dumps(content, sort_keys=True,
            ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        return snapshot


class WeatherHTTPServer(ThreadingHTTPServer):
    """Bound slow connections so LAN clients cannot exhaust handler threads."""
    request_queue_size = 64

    def __init__(self, *args, **kwargs):
        self.request_slots = threading.BoundedSemaphore(64)
        super().__init__(*args, **kwargs)

    def get_request(self):
        request, address = super().get_request()
        request.settimeout(15)
        return request, address

    def process_request(self, request, address):
        if not self.request_slots.acquire(blocking=False):
            try:
                request.sendall(b'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n'
                    b'Content-Length: 0\r\nRetry-After: 1\r\n\r\n')
            except OSError:
                pass
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except Exception:
            self.request_slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.request_slots.release()


def handler_for(store):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(ROOT), **kwargs)

        def do_GET(self):
            try:
                target = urlsplit(self.path)
                path = unquote(target.path)
            except ValueError:
                self.send_error(400)
                return
            if path.startswith('/api/'):
                origin = self.headers.get('Origin')
                if self.headers.get('Sec-Fetch-Site') == 'cross-site' or (
                        origin and origin != 'http://' + self.headers.get('Host', '')):
                    self.send_json(dict(error='不允許跨網站請求'), 403)
                    return
            if path == '/api/typhoons':
                try:
                    if parse_qs(target.query, max_num_fields=20).get('visit') == ['1']:
                        store.refresh_for_visit()
                    payload = store.cached()
                    etag = '"' + payload['version'] + '"'
                    if self.headers.get('If-None-Match') == etag:
                        self.send_response(304)
                        self.send_header('ETag', etag)
                        self.send_header('Cache-Control', 'no-cache')
                        self.end_headers()
                        return
                    self.send_json(payload, etag=etag)
                except Exception:
                    self.send_json(dict(error='資料服務暫時無法更新'), 503)
                return
            if path == '/api/health':
                self.send_json(dict(status='ok', weatherReady=store.snapshot is not None))
                return
            if path == '/favicon.ico':
                self.send_response(204)
                self.end_headers()
                return
            super().do_GET()

        def send_json(self, data, status=200, etag=None):
            body = json.dumps(data, ensure_ascii=False, allow_nan=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            if etag:
                self.send_header('ETag', etag)
            self.send_header('Cache-Control', 'no-cache' if etag else 'no-store')
            if status == 503:
                self.send_header('Retry-After', '1')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def send_head(self):
            # Both GET and HEAD use the same exact asset list. Resolve the path
            # before opening it and reject symlinks even inside the project.
            try:
                path = unquote(urlsplit(self.path).path)
                path = '/index.html' if path == '/' else path
                file = ROOT / path.lstrip('/')
                if path not in PUBLIC_FILES or file.resolve() != file or not file.is_file():
                    self.send_error(404)
                    return None
            except (ValueError, OSError):
                self.send_error(404)
                return None
            return super().send_head()

        def list_directory(self, path):
            self.send_error(404)
            return None

        def end_headers(self):
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('X-Frame-Options', 'DENY')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Content-Security-Policy',
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                "img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; "
                "object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
            try:
                path = unquote(urlsplit(self.path).path)
            except ValueError:
                path = ''
            if path.endswith(('.html', '.js', '.mjs', '.css')) or path == '/':
                self.send_header('Cache-Control', 'no-cache')
            super().end_headers()
    return Handler


def scheduled_collection(store, stop):
    while not stop.is_set():
        next_run = next_collection_time()
        label = datetime.fromtimestamp(next_run, SCHEDULE_TIMEZONE).isoformat()
        print(f'Next weather collection: {label}', flush=True)
        # Recheck the wall clock regularly so clock corrections do not cause drift.
        while next_run > time.time():
            if stop.wait(min(30, max(0, next_run - time.time()))):
                return
        if stop.is_set():
            return
        try:
            snapshot = store.collect(force=True)
            print(f"Weather collection completed: {snapshot['synced']} ({len(snapshot['typhoons'])} storms)", flush=True)
        except Exception:
            # A failed round must not stop subsequent scheduled collections.
            print('Weather collection failed; retaining previous data', flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--bind', default='0.0.0.0')
    parser.add_argument('--port', default=8000, type=int)
    parser.add_argument('--cache', type=Path, default=ROOT / '.cache/weather.sqlite3')
    args = parser.parse_args()
    store = WeatherStore(args.cache)
    server = WeatherHTTPServer((args.bind, args.port), handler_for(store))
    stop = threading.Event()
    worker = threading.Thread(target=scheduled_collection, args=(store, stop),
        name='weather-collection', daemon=True)
    worker.start()
    print(f'Typhoon server listening at http://{args.bind}:{args.port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        server.server_close()
        worker.join()
        if store.request_worker is not None:
            store.request_worker.join()
        store.db.close()


if __name__ == '__main__':
    main()
