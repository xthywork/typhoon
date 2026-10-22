#!/usr/bin/env python3
"""Explicit one-time import, using the CWA historical catalogue as the scope."""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sqlite3
import subprocess

from official_data import cma_records, fetch, json_product, now_ms, point

CWA = 'https://rdc28.cwa.gov.tw/TDB/public/basic_query/search'
CMA = 'https://typhoon.nmc.cn/weatherservice/typhoon/jsons/'


def normalize(name):
    return re.sub(r'[^A-Z0-9]', '', name.upper())


def cwa_catalog(year):
    response = subprocess.run(['curl', '--fail', '--silent', '--show-error',
        '--proto', '=https', '--connect-timeout', '5', '--max-time', '25',
        '-H', 'X-Requested-With: XMLHttpRequest', '--data',
        f'warning_status=all&intensity=all&start_time={year}-1&end_time={year}-12&track=all',
        CWA], capture_output=True, timeout=30, check=True)
    rows = json.loads(response.stdout)
    if not isinstance(rows, list) or not rows:
        raise ValueError('CWA 未回傳該年度名單')
    if any(not re.fullmatch(str(year) + r'\d{2}', r['id']) or not r['eng_name'] for r in rows):
        raise ValueError('CWA 歷史名單格式不符')
    return rows


def jma_history(year):
    url = f'https://www.jma.go.jp/jma/jma-eng/jma-center/rsmc-hp-pub-eg/Besttracks/bst{year}.txt'
    text = fetch(url)
    histories, current, expected = {}, None, 0
    for line in text.splitlines():
        if line.startswith('66666'):
            if expected:
                raise ValueError('JMA 歷史路徑筆數不符')
            fields = line.split()
            current = normalize(fields[-2])
            expected = int(fields[2])
            if not current or expected <= 0:
                raise ValueError('JMA 歷史路徑表頭無效')
            histories[current] = dict(url=url, transport='jma-best-track',
                number=fields[1], batches=[], history=[], historical=True)
        elif line.strip():
            if current is None or expected <= 0:
                raise ValueError('JMA 歷史路徑格式不符')
            fields = line.split()
            token = fields[0]
            if not re.fullmatch(r'\d{8}', token):
                raise ValueError('JMA 歷史時間格式不符')
            # strptime's %y maps 58 to 2058; resolve the century from the requested season.
            candidate_year = min((year // 100 * 100 + int(token[:2]) + shift
                for shift in (-100, 0, 100)), key=lambda value: abs(value - year))
            if abs(candidate_year - year) > 1:
                raise ValueError('JMA 歷史年份與請求不符')
            when = datetime(candidate_year, int(token[2:4]), int(token[4:6]),
                int(token[6:8]), tzinfo=timezone.utc)
            # Wind 000 means not provided, rather than calm winds.
            histories[current]['history'].append(point(when.timestamp()*1000,
                int(fields[3])/10, int(fields[4])/10,
                int(fields[6])*0.514444 if int(fields[6]) else None, int(fields[5]) or None))
            expected -= 1
    if expected or not histories:
        raise ValueError('JMA 歷史路徑不完整')
    return histories


def run(year, db_path):
    catalog = cwa_catalog(year)
    listing = json_product(CMA + f'list_{year}')['typhoonList']
    lookup = {}
    for row in listing:
        lookup.setdefault(normalize(row[1]), []).append(row)
    try:
        jma = jma_history(year)
        jma_error = None
    except Exception as error:
        jma, jma_error = {}, str(error)
    storms, report = [], []
    for row in catalog:
        key = normalize(row['eng_name'])
        storm = dict(id=f'{year}-{key}', nameEn=row['eng_name'].upper(),
            nameZh=row['cht_name'], cwaCatalogId=row['id'], sources={})
        status = dict(cwaId=row['id'], name=row['eng_name'], sources={}, errors={})
        matches = lookup.get(key, [])
        if len(matches) == 1:
            try:
                ident = str(matches[0][0])
                if not ident.isdigit():
                    raise ValueError('Invalid CMA ID')
                url = CMA + 'view_' + ident
                data = json_product(url)['typhoon']
                if normalize(data[1]) != key:
                    raise ValueError('CMA 名稱與名單不符')
                history = sorted({p[2]: point(p[2], p[5], p[4], p[7], p[6])
                    for p in data[8]}.values(), key=lambda p: p['time'])
                number = str(data[3])
                dates = [datetime.fromtimestamp(p['time']/1000, timezone.utc) for p in history]
                if (not history or not re.fullmatch(r'\d{4}', number) or int(number[:2]) != year % 100
                        or any(not (date.year == year
                            or (date.year == year - 1 and date.month == 12)
                            or (date.year == year + 1 and date.month == 1)) for date in dates)):
                    raise ValueError('CMA 年份與名單不符')
                # Older products omit publishing times. Keep their observations,
                # but never manufacture a release time from an analysis time.
                records = cma_records(data, url, skip_incomplete=True)
                storm['sources']['CMA'] = dict(url=url, transport='cma-public-archive',
                    number=str(data[3]), history=history, historical=True,
                    batches=[dict(issued=r['issued'], base=r['base'], points=r['points'])
                        for r in sorted(records, key=lambda r: r['issued'], reverse=True)])
                status['sources']['CMA'] = len(history)
            except Exception as error:
                status['errors']['CMA'] = str(error)
        else:
            status['errors']['CMA'] = '無唯一同名資料'
        if key in jma:
            storm['sources']['JMA'] = jma[key]
            status['sources']['JMA'] = len(jma[key]['history'])
        if not storm['sources']:
            status['errors']['archive'] = '尚無可匯入的逐點資料'
        storms.append(storm)
        report.append(status)
        print(f"{row['id']} {row['eng_name']}: {status['sources']} {status['errors']}", flush=True)
    completed = now_ms()
    manifest = dict(year=year, imported=completed, catalogUrl=CWA, catalog=catalog,
        storms=report, jmaError=jma_error,
        notes='CWA 為名單來源；逐點資料依實際提供商標記。未匯入需研究用帳號之 CWA 逐點資料。')
    # A retry must never replace a complete archive with a transiently partial one.
    if jma_error or any(item['errors'] for item in report):
        raise RuntimeError('歷史來源擷取不完整，未更新資料庫；既有歷史資料保留，請稍後重試')
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(db_path)) as db, db:
        db.execute('CREATE TABLE IF NOT EXISTS archive_imports (year INTEGER PRIMARY KEY, payload TEXT NOT NULL)')
        db.execute('CREATE TABLE IF NOT EXISTS archive_storms (storm TEXT PRIMARY KEY, year INTEGER NOT NULL, payload TEXT NOT NULL)')
        incoming = {storm['id']: storm for storm in storms}
        # Even a syntactically valid file can be truncated at a complete storm
        # boundary. A repeated import must not silently lose existing coverage.
        for (payload,) in db.execute('SELECT payload FROM archive_storms WHERE year=?', (year,)):
            previous = json.loads(payload)
            replacement = incoming.get(previous['id'], {}).get('sources', {})
            for agency, source in previous['sources'].items():
                new = replacement.get(agency, {})
                if (not {p['time'] for p in source['history']} <= {p['time'] for p in new.get('history', [])}
                        or not {b['issued'] for b in source['batches']} <= {b['issued'] for b in new.get('batches', [])}):
                    raise RuntimeError('歷史來源覆蓋範圍縮減，未更新資料庫；既有資料保留')
        # Replace only this explicitly requested year, atomically, after collection completes.
        db.execute('DELETE FROM archive_storms WHERE year=?', (year,))
        db.executemany('INSERT INTO archive_storms VALUES (?,?,?)',
            [(s['id'], year, json.dumps(s, ensure_ascii=False)) for s in storms if s['sources']])
        db.execute('INSERT OR REPLACE INTO archive_imports VALUES (?,?)',
            (year, json.dumps(manifest, ensure_ascii=False)))
    path = db_path.parent / f'history-{year}-manifest.json'
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(f'已儲存 {sum(bool(s["sources"]) for s in storms)}/{len(catalog)} 個颱風；報告：{path}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--year', type=int, required=True)
    parser.add_argument('--cache', type=Path, default=Path(__file__).resolve().parent / '.cache/weather.sqlite3')
    args = parser.parse_args()
    if not 1958 <= args.year <= datetime.now().year:
        parser.error('年份必須介於 1958 與今年之間')
    run(args.year, args.cache)
