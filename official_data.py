"""Fetch official products without evaluating provider JavaScript or filling missing data."""
from __future__ import annotations
import ast
from concurrent.futures import ThreadPoolExecutor
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
    'JTWC': ('美國聯合颱風警報中心', '1 分鐘', 'https://tgftp.nws.noaa.gov/data/raw/ab/abpw10.pgtw..txt'),
    'CMA': ('中國氣象局', '2 分鐘', 'https://typhoon.nmc.cn/'),
}


def now_ms():
    return int(time.time() * 1000)


def timestamp(value):
    parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('Official timestamp must include a timezone')
    return int(parsed.timestamp() * 1000)


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
    history = list(history)
    year = datetime.fromtimestamp(min([base] + [p['time'] for p in history]) / 1000, UTC).year
    if agency in ('JMA', 'CMA', 'HKO'):
        season = re.fullmatch(r'(?:TC)?(\d{2})\d{2}', str(number or ''))
        if season:
            year = min((year // 100 * 100 + int(season[1]) + shift for shift in (-100, 0, 100)),
                key=lambda candidate: abs(candidate - year))
    # Names are matched only within the same season; unnamed depressions stay source-specific.
    key = re.sub(r'[^A-Z0-9]+', '', name.upper())
    if key in ('NAMELESS', 'UNNAMED', 'TD'):
        if not number:
            raise ValueError('Unnamed cyclone requires a provider identifier')
        key = agency + '-' + str(number)
    if not key:
        raise ValueError('Invalid cyclone name')
    return {'id': f'{year}-{key}', 'nameEn': name.upper(), 'nameZh': name_zh or '',
        'number': str(number or ''), 'agency': agency, 'issued': issued, 'base': base,
        'points': points, 'history': history, 'url': product_url or SOURCES[agency][2]}


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
            [points[0]], title.get('typhoonNumber') or code, url))
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
        history, points, base = [], [], None
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
        if base is None:
            raise ValueError('HKO official analysis is missing')
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
        result.extend(cma_records(data, url))
    return result


def cma_records(data, url, skip_incomplete=False):
    result = []
    history = [point(p[2], p[5], p[4], p[7], p[6]) for p in data[8]]
    for entry in data[8]:
        forecasts = (entry[11] or {}).get('BABJ', [])
        if not forecasts:
            continue
        base = int(entry[2])
        # Product explicitly supplies the bulletin's local publishing time.
        pub = entry[12][0] if len(entry) > 12 and entry[12] else None
        if not pub or not re.fullmatch(r'\d{12}', pub):
            if skip_incomplete:
                continue
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
        forecasts = cyclone.findall('./ForecastData/Fix')
        origins = {timestamp(fix.findtext('InitialTime')) for fix in forecasts}
        if len(origins) > 1:
            raise ValueError('CWA forecast origins are inconsistent')
        # Hourly analyses may advance while the current forecast still starts
        # from an earlier official fix. Keep both original clocks and positions.
        base = next(iter(origins)) if origins else history[-1]['time']
        analysis = next((p for p in history if p['time'] == base), None)
        if analysis is None:
            raise ValueError('CWA forecast origin has no matching official analysis')
        points = [analysis]
        for fix in forecasts:
            initial = timestamp(fix.findtext('InitialTime'))
            lead = num(fix.findtext('ForecastHour'))
            if initial != base or lead is None or lead < 0:
                raise ValueError('CWA forecast initial time is invalid')
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


def jtwc_date(day, month, year):
    months = 'JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC'.split()
    return datetime(int(year), months.index(month) + 1, int(day), tzinfo=UTC)


def jtwc_time(token, reference):
    """Resolve WMO DDHHMM using the dated bulletin, including month/year rollovers."""
    candidates = []
    for offset in (-1, 0, 1):
        month = reference.year * 12 + reference.month - 1 + offset
        try:
            candidates.append(datetime(month // 12, month % 12 + 1,
                int(token[:2]), int(token[2:4]), int(token[4:6]), tzinfo=UTC))
        except ValueError:
            continue
    if not candidates:
        raise ValueError('Invalid JTWC WMO timestamp')
    return min(candidates, key=lambda when: abs((when - reference).total_seconds()))


def parse_jtwc_bulletin(text, url):
    header = re.search(r'^(WTPN3[1-5])\s+PGTW\s+(\d{6})\b', text, re.M)
    dated = re.search(r'\b(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})\.', text)
    subject = re.search(r'SUBJ/[^\n]*?\b(\d{2}W)\s+\(([^)]+)\)\s+WARNING NR\s+(\d+)', text)
    if not header or not dated or not subject:
        raise ValueError('JTWC bulletin identity or date is missing')
    dated_reference = jtwc_date(dated[1], dated[2], 2000 + int(dated[3]))
    issued_dt = jtwc_time(header[2], dated_reference)
    issued = int(issued_dt.timestamp() * 1000)
    if not -3600000 <= now_ms() - issued <= 18 * 3600000:
        raise RuntimeError('JTWC 官方轉送警報已過期或時間異常')
    # The final warning is not an active forecast. Earlier bulletins remain in SQLite.
    if re.search(r'THIS IS THE FINAL WARNING ON THIS SYSTEM', text):
        return dict(number=subject[1], issued=issued, warningChannel=header[1], final=True)
    position_pattern = r'(\d{6})Z\s*---\s*(?:NEAR\s+)?([\d.]+)([NS])\s+([\d.]+)([EW])'
    analysis = re.search(r'WARNING POSITION:\s*' + position_pattern, text)
    if not analysis:
        raise ValueError('JTWC analysis position is missing')
    base_dt = jtwc_time(analysis[1], issued_dt)
    base = int(base_dt.timestamp() * 1000)
    if not 0 <= issued - base <= 12 * 3600000:
        raise ValueError('JTWC analysis time does not match bulletin')
    forecasts = list(re.finditer(r'(\d+)\s+HRS,\s*VALID AT:\s*' + position_pattern, text))
    if not forecasts:
        raise ValueError('JTWC forecast coordinates are missing')

    def decode(match, chunk, when, analysis_point=False):
        token, lat, ns, lon, ew = match
        if token != datetime.fromtimestamp(when / 1000, UTC).strftime('%d%H%M'):
            raise ValueError('JTWC forecast valid time does not match lead hour')
        wind = re.search(r'MAX SUSTAINED WINDS\s*-\s*(\d+) KT,\s*GUSTS\s*(\d+) KT', chunk)
        if not wind:
            raise ValueError('JTWC wind data is missing')
        extra = dict(gust=int(wind[2]) * 0.514444)
        for speed in (34, 50, 64):
            radius = re.search(r'RADIUS OF\s+0*' + str(speed) + r' KT WINDS\s*-\s*'
                r'(.*?)(?=RADIUS OF|VECTOR TO|REPEAT POSIT|---|$)', chunk, re.S)
            if radius:
                values = re.findall(r'(\d+) NM (NORTHEAST|SOUTHEAST|SOUTHWEST|NORTHWEST) QUADRANT', radius[1])
                directions = dict(NORTHEAST='NE', SOUTHEAST='SE', SOUTHWEST='SW', NORTHWEST='NW')
                if len(values) != 4 or {direction for _, direction in values} != set(directions):
                    raise ValueError('JTWC wind quadrants are incomplete')
                extra[f'windRadii{speed}kt'] = {directions[direction]: int(value) * 1.852 for value, direction in values}
        pressure = None
        if analysis_point:
            pressure_match = re.search(r'MINIMUM CENTRAL PRESSURE AT\s+' + token +
                r'Z IS\s*(\d+) MB', text)
            pressure = int(pressure_match[1]) if pressure_match else None
        return point(when, float(lat) * (-1 if ns == 'S' else 1),
            float(lon) * (-1 if ew == 'W' else 1), int(wind[1]) * 0.514444, pressure, **extra)

    actual = decode(analysis.groups(), text[analysis.end():forecasts[0].start()], base, True)
    points = [actual]
    for index, match in enumerate(forecasts):
        lead = int(match[1])
        if not 0 < lead <= 240:
            raise ValueError('Invalid JTWC forecast lead')
        end = forecasts[index + 1].start() if index + 1 < len(forecasts) else text.find('REMARKS:', match.end())
        if end < 0:
            raise ValueError('JTWC remarks boundary is missing')
        points.append(decode(match.groups()[1:], text[match.end():end], base + lead * 3600000))
    name = subject[2].strip()
    if re.fullmatch(r'(?:ZERO|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN|ELEVEN|TWELVE|THIRTEEN|FOURTEEN|FIFTEEN|SIXTEEN|SEVENTEEN|EIGHTEEN|NINETEEN|TWENTY|THIRTY)+', name):
        name = 'TD'
    record = storm_record('JTWC', name, '', issued, base, points, [actual], subject[1], url)
    record.update(transport='noaa-nws-jtwc-bulletin', warningNumber=subject[3], warningChannel=header[1])
    return record


def jtwc():
    # NOAA/NWS officially redistributes the original JTWC PGTW bulletins.
    root = 'https://tgftp.nws.noaa.gov/data/raw/'
    advisory = fetch(root + 'ab/abpw10.pgtw..txt')
    validity = re.search(r'(\d{6})Z-(\d{6})Z(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{4})', advisory)
    if 'JOINT TYPHOON WRNCEN' not in advisory or not validity:
        raise ValueError('JTWC advisory schema changed')
    end = jtwc_date(validity[2][:2], validity[3], validity[4]).replace(
        hour=int(validity[2][2:4]), minute=int(validity[2][4:6]))
    if not -48 * 3600000 <= now_ms() - end.timestamp() * 1000 <= 12 * 3600000:
        raise RuntimeError('JTWC 官方轉送概況已過期或時間異常')
    summary = re.search(r'1\. WESTERN NORTH PACIFIC AREA.*?A\. TROPICAL CYCLONE SUMMARY:(.*?)B\. TROPICAL DISTURBANCE SUMMARY:', advisory, re.S)
    if not summary:
        raise ValueError('JTWC western Pacific summary is missing')
    references = {}
    for channel, token in re.findall(r'\b(WTPN3[1-5])\s+PGTW\s+(\d{6})\b', summary[1]):
        reference = int(jtwc_time(token, end).timestamp() * 1000)
        references[channel] = max(references.get(channel, reference), reference)
    channels = sorted(references)
    if not channels:
        if re.search(r'\b(?:NONE|NO TROPICAL CYCLONES)\b', summary[1]):
            return []
        raise ValueError('JTWC active warning references are missing')
    numbers = set(re.findall(r'\b\d{2}W\b', summary[1]))
    urls = [root + 'wt/' + channel.lower() + '.pgtw..txt' for channel in channels]
    with ThreadPoolExecutor(max_workers=5) as pool:
        texts = list(pool.map(fetch, urls))
    result = []
    for channel, url, text in zip(channels, urls, texts):
        record = parse_jtwc_bulletin(text, url)
        if record['warningChannel'] != channel or record['number'] not in numbers:
            raise ValueError('JTWC bulletin cyclone or channel does not match advisory')
        if record['issued'] < references[channel]:
            raise RuntimeError('JTWC 官方轉送警報尚未同步至概況引用的發布批次')
        if not record.get('final'):
            result.append(record)
    return result


ADAPTERS = dict(CWA=cwa, JMA=jma, KMA=kma, HKO=hko, JTWC=jtwc, CMA=cma)
