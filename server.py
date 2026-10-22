#!/usr/bin/env python3
"""Same-origin official weather API and local map server (Python 3.10+, curl)."""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
from pathlib import Path
import sqlite3
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

from official_data import ADAPTERS, SOURCES, now_ms

ROOT = Path(__file__).resolve().parent
CACHE_SECONDS = 3600


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
        self.snapshot = None
        self.expires = 0
        # Restore a fresh persisted result without contacting any upstream.
        states = self.db.execute('SELECT agency,checked FROM source_state').fetchall()
        if {row[0] for row in states} == set(SOURCES):
            saved = self.db.execute('SELECT completed FROM collection_state WHERE id=1').fetchone()
            checks = {row[1] for row in states}
            # Migrate the previous cache only when all sources completed the same round.
            completed = saved[0] if saved else (next(iter(checks)) if len(checks) == 1 else None)
            age = (now_ms() - completed) / 1000 if completed is not None else None
            if age is not None and 0 <= age < CACHE_SECONDS:
                self.snapshot = self.build_snapshot(completed)
                self.expires = time.monotonic() + CACHE_SECONDS - age

    def collect(self):
        with self.lock:
            if self.snapshot is not None and time.monotonic() < self.expires:
                return self.snapshot
            checked = now_ms()
            with ThreadPoolExecutor(max_workers=6) as pool:
                futures = {pool.submit(adapter): agency for agency, adapter in ADAPTERS.items()}
                for future in as_completed(futures):
                    agency = futures[future]
                    try:
                        records = future.result()
                        active = sorted({r['id'] for r in records})
                        with self.db:
                            for record in records:
                                self.db.execute('INSERT OR REPLACE INTO bulletins VALUES (?,?,?,?)',
                                    (record['id'], agency, record['issued'], json.dumps(record, ensure_ascii=False)))
                            self.db.execute('INSERT OR REPLACE INTO source_state VALUES (?,?,?,?,?)',
                                (agency, checked, checked, json.dumps(active), None))
                    except Exception as error:
                        message = str(error) if isinstance(error, RuntimeError) else '官方資料格式解析失敗'
                        old = self.db.execute('SELECT succeeded,active FROM source_state WHERE agency=?',
                            (agency,)).fetchone()
                        with self.db:
                            self.db.execute('INSERT OR REPLACE INTO source_state VALUES (?,?,?,?,?)',
                                (agency, checked, old[0] if old else None,
                                    old[1] if old else '[]', message))
            completed = now_ms()
            with self.db:
                self.db.execute('INSERT OR REPLACE INTO collection_state VALUES (1,?)', (completed,))
            self.snapshot = self.build_snapshot(completed)
            self.expires = time.monotonic() + CACHE_SECONDS
            return self.snapshot

    def build_snapshot(self, checked):
        statuses, storms = {}, {}
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
                if newest['nameZh'] and (agency == 'CWA' or not t['nameZh']):
                    t['nameZh'] = newest['nameZh']
                # Combine only observations from this same provider and cyclone.
                history = {p['time']: dict(p, agency=agency)
                    for r in reversed(records) for p in r['history']}
                t['sources'][agency] = dict(url=newest['url'], transport=newest.get('transport', 'official-public-product'),
                    batches=[dict(issued=r['issued'], base=r['base'], points=r['points']) for r in records],
                    history=sorted(history.values(), key=lambda p: p['time']))
        for t in storms.values():
            t['name'] = (t['nameZh'] + ' ' if t['nameZh'] else '') + t['nameEn']
            # A timeline uses one provider's actual observations, not an interleaved synthetic track.
            available = [(key, source['history']) for key, source in t['sources'].items() if source['history']]
            priority = {'CWA': 3, 'JMA': 2, 'HKO': 1, 'CMA': 0}
            key, history = next((pair for pair in available if pair[0] == 'CWA' and len(pair[1]) > 1), None) or max(available, key=lambda pair: (len(pair[1]), priority.get(pair[0], -1)))
            t['historyAgency'], t['history'] = key, history
            t['batchTimes'] = sorted({b['issued'] for src in t['sources'].values() for b in src['batches']}, reverse=True)
        return dict(schemaVersion=1, mock=False, synced=checked, sources=statuses,
            typhoons=sorted(storms.values(), key=lambda t: t['id']))


def handler_for(store):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(ROOT), **kwargs)

        def do_GET(self):
            path = unquote(urlsplit(self.path).path)
            if path == '/api/typhoons':
                try:
                    payload = store.collect()
                    self.send_json(payload)
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
            allowed = path in ('/', '/index.html', '/map.js', '/map.css', '/basemap-style.json', '/favicon.ico') or \
                path.startswith(('/vendor/', '/data/basemap/'))
            resolved = (ROOT / path.lstrip('/')).resolve()
            if not allowed or not resolved.is_relative_to(ROOT) or any(part.startswith('.') for part in Path(path).parts):
                self.send_error(404)
                return
            if resolved.is_dir() and path != '/':
                self.send_error(404)
                return
            super().do_GET()

        def send_json(self, data, status=200):
            body = json.dumps(data, ensure_ascii=False, allow_nan=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_HEAD(self):
            path = unquote(urlsplit(self.path).path)
            if path.startswith('/api/'):
                self.send_error(405)
                return
            resolved = (ROOT / path.lstrip('/')).resolve()
            allowed = path in ('/', '/index.html', '/map.js', '/map.css', '/basemap-style.json', '/favicon.ico') or path.startswith(('/vendor/', '/data/basemap/'))
            if not allowed or not resolved.is_relative_to(ROOT) or any(p.startswith('.') for p in Path(path).parts):
                self.send_error(404)
                return
            super().do_HEAD()

        def end_headers(self):
            self.send_header('X-Content-Type-Options', 'nosniff')
            if self.path.endswith(('.html', '.js', '.css')) or self.path == '/':
                self.send_header('Cache-Control', 'no-cache')
            super().end_headers()
    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--bind', default='0.0.0.0')
    parser.add_argument('--port', default=8000, type=int)
    parser.add_argument('--cache', type=Path, default=ROOT / '.cache/weather.sqlite3')
    args = parser.parse_args()
    store = WeatherStore(args.cache)
    server = ThreadingHTTPServer((args.bind, args.port), handler_for(store))
    print(f'Typhoon server listening at http://{args.bind}:{args.port}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
