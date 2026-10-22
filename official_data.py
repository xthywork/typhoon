"""Fetch official products without evaluating provider JavaScript or filling missing data."""
from __future__ import annotations
import ast
import json
import math
import os
from pathlib import Path
import re
import subprocess
import time
from datetime import datetime, timedelta, timezone
from xml.etree import ElementTree as ET
from urllib.parse import urlencode

UTC = timezone.utc
SOURCES = {
    'CWA': ('台灣中央氣象署', '10 分鐘', 'https://www.cwa.gov.tw/V8/C/P/Typhoon/TY_NEWS.html'),
    'JMA': ('日本氣象廳', '10 分鐘', 'https://www.jma.go.jp/bosai/typhoon/'),
    'KMA': ('韓國氣象廳', '10 分鐘', 'https://apihub.kma.go.kr/apiList.do?seqApi=8'),
    'HKO': ('香港天文台', '10 分鐘', 'https://data.gov.hk/en-data/dataset/hk-hko-rss-tc-track-info'),
    'JTWC': ('美國聯合颱風警報中心', '1 分鐘', 'https://www.metoc.navy.mil/jtwc/jtwc.html'),
    'CMA': ('中國氣象局', '2 分鐘', 'https://typhoon.nmc.cn/'),
}


def now_ms():
    return int(time.time() * 1000)


def timestamp(value):
    return int(datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp() * 1000)


def num(value):
    try:
        n = float(value)
        return n if math.isfinite(n) else None
    except (TypeError, ValueError):
        return None


def point(when, lat, lon, wind=None, pressure=None, **extra):
    lat, lon = num(lat), num(lon)
    if lat is None or lon is None or not -90 <= lat <= 90 or not -180 <= lon <= 180:
        raise ValueError('Invalid official coordinates')
    if not isinstance(when, (int, float)) or not math.isfinite(when):
        raise ValueError('Invalid official timestamp')
    wind, pressure = num(wind), num(pressure)
    if wind is not None and not 0 <= wind <= 150:
        raise ValueError('Invalid wind speed')
    if pressure is not None and not 800 <= pressure <= 1100:
        raise ValueError('Invalid pressure')
    return dict(time=int(when), lat=lat, lon=lon, w=wind, p=pressure, **extra)


def fetch(url):
    # curl's deadlines cover DNS too, and retain certificate/hostname verification.
    r = subprocess.run(['curl', '--fail', '--silent', '--show-error', '--location',
        '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '5',
        '--max-time', '12', '--max-filesize', '5000000', '--user-agent',
        'TyphoonComparison/1.0 (official public weather data)', url],
        capture_output=True, timeout=15)
    if r.returncode:
        raise RuntimeError('上游連線失敗（HTTP、DNS 或逾時）')
    if len(r.stdout) > 5000000:
        raise ValueError('Upstream product too large')
    return r.stdout.decode('utf-8-sig')


def json_product(url):
    text = fetch(url)
    # Strict JSON or an anchored JSONP wrapper. Never evaluate downloaded code.
    if text.lstrip().startswith(('[', '{')):
        return json.loads(text)
    m = re.fullmatch(r'\s*[\w]+\(\(?\s*(\{.*\})\s*\)?\);?\s*', text, re.S)
    if not m:
        raise ValueError('官方資料格式已變更')
    return json.loads(m[1])


def storm_record(agency, name, name_zh, issued, base, points, history=(), number=None, product_url=None):
    if not name or not points:
        raise ValueError('官方資料缺少名稱或路徑')
    points = sorted({p['time']: p for p in points}.values(), key=lambda p: p['time'])
    year = datetime.fromtimestamp(base / 1000, UTC).year
    # Names are matched only within the same season; unnamed depressions stay source-specific.
    key = re.sub(r'[^A-Z0-9]+', '', name.upper())
    if key in ('NAMELESS', 'UNNAMED', 'TD'):
        key = agency + '-' + str(number)
    return {'id': f'{year}-{key}', 'nameEn': name.upper(), 'nameZh': name_zh or '',
        'number': str(number or ''), 'agency': agency, 'issued': issued, 'base': base,
        'points': points, 'history': list(history), 'url': product_url or SOURCES[agency][2]}


def jma():
    root = 'https://www.jma.go.jp/bosai/typhoon/data/'
    listing = json_product(root + 'targetTc.json')
    if not isinstance(listing, list):
        raise ValueError('JMA list schema changed')
    result = []
    for item in listing[:20]:
        code = item['tropicalCyclone']
        if not re.fullmatch(r'TC\d+', code):
            raise ValueError('Invalid JMA storm ID')
        url = root + code + '/specifications.json'
        data = json_product(url)
        title = data[0]
        issued = timestamp(title['issue']['UTC'])
        points = []
        for entry in data[1:]:
            if 'position' not in entry or 'validtime' not in entry:
                continue
            lat, lon = entry['position']['deg']
            wind = entry.get('maximumWind', {})
            cone = entry.get('probabilityCircleRadius', {}).get('km')
            points.append(point(timestamp(entry['validtime']['UTC']), lat, lon,
                wind.get('sustained', {}).get('m/s'), entry.get('pressure'),
                gust=num(wind.get('gust', {}).get('m/s')), cone=num(cone),
                coneProbability=70 if cone is not None else None))
        base = points[0]['time']
        result.append(storm_record('JMA', title['name']['en'], '', issued, base, points,
            [points[0]], title.get('typhoonNumber'), url))
    return result


def hko_coord(value):
    if not value:
        raise ValueError('Missing HKO coordinate')
    return float(value[:-1]) * (-1 if value[-1] in 'SW' else 1)


def hko():
    root = ET.fromstring(fetch('https://www.hko.gov.hk/wxinfo/currwx/tc_list.xml'))
    if root.tag != 'TropicalCycloneList':
        raise ValueError('HKO list schema changed')
    result = []
    for item in root.findall('TropicalCyclone')[:20]:
        ident = item.findtext('TropicalCycloneID')
        if not re.fullmatch(r'\d+', ident or ''):
            raise ValueError('Invalid HKO storm ID')
        url = 'https://www.weather.gov.hk/wxinfo/currwx/hko_tctrack_' + ident + '.xml'
        data = ET.fromstring(fetch(url))
        issued = timestamp(data.findtext('./BulletinHeader/BulletinTime'))
        report = data.find('WeatherReport')
        history, points = [], []
        for tag in ('PastInformation', 'AnalysisInformation', 'ForecastInformation'):
            for entry in report.findall(tag):
                # HKO also publishes interpolated drawing vertices without a time.
                # Only explicitly timestamped official forecast points are imported.
                when = entry.findtext('Time')
                if not when:
                    continue
                w = entry.findtext('MaximumWind')
                match = re.fullmatch(r'([\d.]+)km/h', w or '')
                wind = float(match[1]) / 3.6 if match else None
                p = point(timestamp(when), hko_coord(entry.findtext('Latitude')),
                    hko_coord(entry.findtext('Longitude')), wind)
                (history if tag == 'PastInformation' else points).append(p)
                if tag == 'AnalysisInformation':
                    history.append(p)
                    base = p['time']
        result.append(storm_record('HKO', item.findtext('TropicalCycloneEnglishName'),
            item.findtext('TropicalCycloneChineseName'), issued, base, points, history,
            ident, url))
    return result


def cma():
    root = 'https://typhoon.nmc.cn/weatherservice/typhoon/jsons/'
    listing = json_product(root + 'list_default')
    if not isinstance(listing.get('typhoonList'), list):
        raise ValueError('CMA list schema changed')
    result = []
    for item in listing['typhoonList']:
        if item[7] != 'start':
            continue
        ident = str(item[0])
        if not ident.isdigit():
            raise ValueError('Invalid CMA storm ID')
        url = root + 'view_' + ident
        data = json_product(url)['typhoon']
        history = [point(p[2], p[5], p[4], p[7], p[6]) for p in data[8]]
        for entry in data[8]:
            forecasts = entry[11].get('BABJ', [])
            if not forecasts:
                continue
            base = int(entry[2])
            # Product explicitly supplies the bulletin's local publishing time.
            pub = entry[12][0] if len(entry) > 12 and entry[12] else None
            if not pub or not re.fullmatch(r'\d{12}', pub):
                raise ValueError('Missing CMA bulletin timestamp')
            issued = int(datetime.strptime(pub, '%Y%m%d%H%M').replace(
                tzinfo=timezone(timedelta(hours=8))).timestamp() * 1000)
            points = [point(base, entry[5], entry[4], entry[7], entry[6])]
            for p in forecasts:
                points.append(point(base + int(p[0]) * 3600000, p[3], p[2], p[5], p[4]))
            result.append(storm_record('CMA', data[1], data[2], issued, base, points,
                [p for p in history if p['time'] <= base], data[3], url))
    return result


def parse_cwa_api(text):
    root = ET.fromstring(text)
    # CWA uses a default namespace; normalize only local element names.
    for element in root.iter():
        element.tag = element.tag.rsplit('}', 1)[-1]
    if root.tag != 'cwaopendata' or root.find('./Dataset/TropicalCyclones') is None:
        raise ValueError('CWA formal API schema changed')
    if root.findtext('Status') != 'Actual':
        raise ValueError('CWA API product is not operational data')
    issued = timestamp(root.findtext('Sent'))
    result = []
    for cyclone in root.findall('./Dataset/TropicalCyclones/TropicalCyclone'):
        def decode(fix, valid):
            cone = num(fix.findtext('Radius70PercentProbability'))
            quadrants = {radius.get('dir'): num(radius.text)
                for radius in fix.findall('./Circle15ms/QuadrantRadii/Radius')}
            quadrants25 = {radius.get('dir'): num(radius.text)
                for radius in fix.findall('./Circle25ms/QuadrantRadii/Radius')}
            return point(valid, fix.findtext('CoordinateLatitude'),
                fix.findtext('CoordinateLongitude'), fix.findtext('MaxWindSpeed'),
                fix.findtext('Pressure'), gust=num(fix.findtext('MaxGustSpeed')),
                windRadius15ms=num(fix.findtext('./Circle15ms/Radius')),
                windRadius25ms=num(fix.findtext('./Circle25ms/Radius')),
                windRadii15ms=quadrants or None, windRadii25ms=quadrants25 or None,
                movingSpeed=num(fix.findtext('MovingSpeed')),
                movingDirection=fix.findtext('MovingDirection'),
                stateTransfer=fix.findtext('StateTransfer[@lang="zh-hant"]'), cone=cone,
                coneProbability=70 if cone is not None else None)
        history = [decode(fix, timestamp(fix.findtext('DateTime')))
            for fix in cyclone.findall('./AnalysisData/Fix')]
        history.sort(key=lambda p: p['time'])
        if not history:
            raise ValueError('CWA official analysis is missing')
        base = history[-1]['time']
        points = [history[-1]]
        for fix in cyclone.findall('./ForecastData/Fix'):
            initial = timestamp(fix.findtext('InitialTime'))
            lead = num(fix.findtext('ForecastHour'))
            if initial != base or lead is None or lead < 0:
                raise ValueError('CWA forecast initial time does not match latest analysis')
            points.append(decode(fix, initial + lead * 3600000))
        name = (cyclone.findtext('TyphoonName') or '').strip() or 'TD'
        number = cyclone.findtext('CwaTyNo') or cyclone.findtext('CwaTdNo')
        record = storm_record('CWA', name, cyclone.findtext('CwaTyphoonName'),
            issued, base, points, history, number,
            'https://opendata.cwa.gov.tw/dataset/warning/W-C0034-005')
        record['transport'] = 'cwa-member-api'
        result.append(record)
    return result


def cwa_api_key():
    value = os.environ.get('CWA_API_KEY', '').strip()
    if value:
        return value
    path = Path(__file__).resolve().parent / '.env'
    if path.exists():
        for line in path.read_text().splitlines():
            if line.strip().startswith('CWA_API_KEY='):
                return line.strip().split('=', 1)[1].strip().strip('"\'')
    return ''


def fetch_cwa_api(key):
    endpoint = 'https://opendata.cwa.gov.tw/fileapi/v1/opendataapi/W-C0034-005'
    url = endpoint + '?' + urlencode({'Authorization': key, 'format': 'XML'})
    # Put the credential-bearing URL on stdin, not command arguments or logs.
    command = ['curl', '--fail', '--silent', '--show-error', '--location',
        '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '5',
        '--max-time', '20', '--max-filesize', '5000000', '--config', '-',
        '--write-out', '\n%{http_code}']
    try:
        response = subprocess.run(command, input=('url = '+json.dumps(url)+'\n').encode(),
            capture_output=True, timeout=23)
    except subprocess.TimeoutExpired:
        raise RuntimeError('CWA 正式 API 連線逾時') from None
    body, _, status = response.stdout.rpartition(b'\n')
    if status in (b'401', b'403'):
        raise RuntimeError('CWA API 授權失敗，請確認授權碼與資料權限')
    if response.returncode or status != b'200':
        raise RuntimeError('CWA 正式 API 連線失敗（HTTP、DNS 或逾時）')
    if len(body) > 5000000:
        raise ValueError('CWA API response too large')
    return body.decode('utf-8-sig')


def cwa():
    key = cwa_api_key()
    return parse_cwa_api(fetch_cwa_api(key)) if key else cwa_web()


def cwa_web():
    url = 'https://www.cwa.gov.tw/Data/js/typhoon/TY_NEWS-Data.js'
    text = fetch(url)
    # The public official website publishes HTML strings in a JS assignment.
    # Extract literal strings only; never execute JavaScript or HTML.
    m = re.search(r"TY_LIST_2\['C'\]\s*=\s*(.*?);", text, re.S)
    if not m:
        if re.search(r'TY_COUNT\s*=\s*\[\s*0\s*,\s*0\s*\]', text):
            return []
        raise ValueError('CWA website product schema changed')
    strings = re.findall(r"'(?:[^'\\]|\\.)*'", m[1])
    html = ''.join(ast.literal_eval(x) for x in strings)
    base_match = re.search(r"TY_DataTime\s*=\s*'(\d{12})'", text)
    update_match = re.search(r'Update:\s*([\d-]+ [\d:]+)', text)
    if not base_match or not update_match:
        raise ValueError('Missing CWA timestamps')
    base = int(datetime.strptime(base_match[1], '%Y%m%d%H%M').replace(tzinfo=UTC).timestamp()*1000)
    issued = int(datetime.strptime(update_match[1], '%Y-%m-%d %H:%M:%S').replace(
        tzinfo=timezone(timedelta(hours=8))).timestamp()*1000)
    result = []
    for section in html.split('<div class="panel panel-default">')[1:]:
        name = re.search(r'國際命名\s*([A-Z0-9-]+)', section)
        zh = re.search(r'<span class="fa-blue">([^<]+)</span>', section)
        if not name:
            raise ValueError('Missing CWA storm name')
        blocks = re.findall(r'<ul\b[^>]*>(.*?)</ul>', section, re.S)
        points = []
        for block in blocks:
            pos = re.search(r'北緯\s*([\d.]+)\s*度，東經\s*([\d.]+)', block)
            if not pos:
                continue
            when = re.search(r'預測\s*(\d+)月(\d+)日(\d+)時', block)
            if when:
                ref = datetime.fromtimestamp(base/1000, UTC)+timedelta(hours=8)
                month, day, hour = map(int, when.groups())
                year = ref.year + (1 if ref.month == 12 and month == 1 else 0)
                valid = int(datetime(year, month, day, hour,
                    tzinfo=timezone(timedelta(hours=8))).timestamp()*1000)
            else:
                valid = base
            def value(pattern):
                found = re.search(pattern, block)
                return num(found[1]) if found else None
            cone = value(r'70%機率半徑\s*([\d.]+)')
            points.append(point(valid, pos[1], pos[2],
                value(r'近中心最大風速每秒\s*([\d.]+)'), value(r'中心氣壓\s*([\d.]+)'),
                gust=value(r'瞬間最大陣風每秒\s*([\d.]+)'),
                windRadius15ms=value(r'七級風暴風半徑\s*([\d.]+)'), cone=cone,
                coneProbability=70 if cone is not None else None))
        result.append(storm_record('CWA', name[1], zh[1] if zh else '', issued,
            base, points, [p for p in points if p['time'] == base], product_url=url))
    if not result:
        raise ValueError('No CWA records parsed')
    return result


def kma():
    # Do not pretend a key is valid or substitute another agency's forecast.
    raise RuntimeError('待設定 KMA API 認證與完成正式介面驗證')


def jtwc():
    # Test official access explicitly; a failed host is an error, not "no cyclone".
    fetch('https://www.metoc.navy.mil/jtwc/products/abpwweb.txt')
    raise RuntimeError('官方文字產品可連線；ATCF 路徑介面尚待驗證')


ADAPTERS = dict(CWA=cwa, JMA=jma, KMA=kma, HKO=hko, JTWC=jtwc, CMA=cma)
