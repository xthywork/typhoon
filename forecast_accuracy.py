"""Read-only 24h track verification against one JMA reference per cyclone.

No upstream downloads. Scores describe stored forecasts, not future probability.
"""
from bisect import bisect_left
from collections import defaultdict
import json
import math
from statistics import median

HOUR = 3600000
LEAD = 24 * HOUR
THRESHOLD_KM = 100
WINDOW = 365 * 24 * HOUR


def distance(a, b):
    lat1, lat2 = math.radians(a['lat']), math.radians(b['lat'])
    delta_lat = lat2 - lat1
    delta_lon = math.radians(b['lon'] - a['lon'])
    hav = math.sin(delta_lat / 2)**2 + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2)**2
    return 6371.0088 * 2 * math.asin(math.sqrt(min(1, max(0, hav))))


def position(history, times, when):
    """Exact reference, or spherical interpolation inside a <=6h gap only."""
    index = bisect_left(times, when)
    if index < len(times) and times[index] == when:
        return history[index], False
    if not 0 < index < len(times) or times[index] - times[index - 1] > 6 * HOUR:
        return None, False
    a, b = history[index - 1], history[index]
    ratio = (when - a['time']) / (b['time'] - a['time'])
    def vector(p):
        lat, lon = math.radians(p['lat']), math.radians(p['lon'])
        return (math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat))
    va, vb = vector(a), vector(b)
    angle = math.acos(max(-1, min(1, sum(x*y for x, y in zip(va, vb)))))
    if angle < 1e-10:
        return dict(a, time=when), True
    if math.pi - angle < 1e-8:
        return None, False
    weights = math.sin((1-ratio)*angle)/math.sin(angle), math.sin(ratio*angle)/math.sin(angle)
    x, y, z = (weights[0]*a + weights[1]*b for a, b in zip(va, vb))
    return dict(time=when, lat=math.degrees(math.atan2(z, math.hypot(x, y))),
                lon=math.degrees(math.atan2(y, x))), True


def summarize(cases, *, provisional, comparable, reference, reason='', eligible=0, waiting=0, unmatched=0):
    errors = [case['error'] for case in cases]
    hits = sum(error <= THRESHOLD_KM for error in errors)
    return dict(sampleCount=len(errors), hits=hits,
        rate=round(100*hits/len(errors), 1) if errors else None,
        meanKm=round(sum(errors)/len(errors), 1) if errors else None,
        medianKm=round(median(errors), 1) if errors else None,
        stormCount=len({case['storm'] for case in cases}),
        interpolated=sum(case['interpolated'] for case in cases),
        firstValid=min((case['valid'] for case in cases), default=None),
        lastValid=max((case['valid'] for case in cases), default=None),
        provisional=provisional, comparable=comparable, reference=reference, reason=reason,
        eligibleCount=eligible, waitingCount=waiting, unmatchedCount=unmatched)


def build_accuracy(db, displayed_storms, checked, agencies):
    records = defaultdict(lambda: defaultdict(list))
    for storm, agency, payload in db.execute('SELECT storm,agency,payload FROM bulletins ORDER BY issued'):
        records[storm][agency].append(json.loads(payload))
    archives = {}
    if db.execute("SELECT 1 FROM sqlite_master WHERE name='archive_storms' AND type='table'").fetchone():
        for (payload,) in db.execute('SELECT payload FROM archive_storms'):
            archive = json.loads(payload)
            archives[archive['id']] = archive
            for agency, source in archive.get('sources', {}).items():
                # Imported history alone is never synthesized into a forecast.
                for batch in source.get('batches', []):
                    records[archive['id']][agency].append(dict(batch, history=[]))

    active = {key for key, storm in displayed_storms.items() if storm.get('active')}
    verified, details, finalized = {}, {}, set()
    for storm in set(records) | set(archives):
        sources = records[storm]
        best = archives.get(storm, {}).get('sources', {}).get('JMA', {})
        final = storm not in active and best.get('transport') == 'jma-best-track'
        if final:
            finalized.add(storm)
            history = best.get('history', [])
        else:
            fixes = {p['time']: p for r in sorted(sources.get('JMA', []), key=lambda r: r['issued'])
                     for p in r.get('history', []) if r['issued'] <= checked}
            history = list(fixes.values())
        history = sorted((p for p in history if p['time'] <= checked), key=lambda p: p['time'])
        times = [p['time'] for p in history]
        per_agency, meta = {}, {}
        for agency in agencies:
            candidates = {}
            for record in sorted(sources.get(agency, []), key=lambda r: r['issued']):
                base, issued = record['base'], record['issued']
                target = base + LEAD
                # Common synoptic origins; hourly analysis refreshes are not new forecasts.
                if base % (6*HOUR) or not base <= issued < target or issued > checked:
                    continue
                forecast = next((p for p in record['points'] if p['time'] == target), None)
                if forecast is not None:
                    candidates.setdefault(base, forecast)
            cases, waiting, unmatched = {}, 0, 0
            for base, forecast in candidates.items():
                target = base + LEAD
                if target > checked:
                    waiting += 1
                    continue
                reference, interpolated = position(history, times, target)
                if reference is None:
                    unmatched += 1
                    continue
                cases[base] = dict(storm=storm, valid=target, error=distance(forecast, reference),
                                   interpolated=interpolated)
            per_agency[agency] = cases
            meta[agency] = dict(eligible=len(cases), waiting=waiting, unmatched=unmatched,
                reason=('no_reference' if not history else 'waiting' if waiting else
                        'no_matching_reference' if unmatched else 'no_forecasts'))
        participating = [set(cases) for cases in per_agency.values() if cases]
        common = set.intersection(*participating) if len(participating) >= 2 else set()
        comparable = bool(common)
        # If no common sample exists, show explicitly labelled own-sample estimates.
        verified[storm] = {agency: [case for base, case in cases.items() if not common or base in common]
                           for agency, cases in per_agency.items()}
        details[storm] = dict(meta=meta, comparable=comparable, provisional=not final,
            reference='JMA 最佳路徑' if final else 'JMA 即時分析')

    by_storm = {}
    for selected in displayed_storms:
        current, historical = {}, {}
        detail = details.get(selected, dict(meta={}, comparable=False, provisional=True, reference='JMA 即時分析'))
        for agency in agencies:
            meta = detail['meta'].get(agency, {})
            cases = verified.get(selected, {}).get(agency, [])
            current[agency] = summarize(cases, provisional=detail['provisional'],
                comparable=detail['comparable'], reference=detail['reference'],
                reason='' if cases else meta.get('reason', 'no_forecasts'),
                eligible=meta.get('eligible', 0), waiting=meta.get('waiting', 0), unmatched=meta.get('unmatched', 0))
            past = [case for storm in finalized if storm != selected
                    for case in verified.get(storm, {}).get(agency, [])
                    if checked-WINDOW <= case['valid'] <= checked]
            historical[agency] = summarize(past, provisional=False,
                comparable=bool(past) and all(details[c['storm']]['comparable'] for c in past),
                reference='JMA 最佳路徑', reason='' if past else 'no_finalized_history', eligible=len(past))
        by_storm[selected] = dict(current=current, history=historical)
    return dict(method='track-hit-v1', leadHours=24, thresholdKm=THRESHOLD_KM,
                windowDays=365, byStorm=by_storm)
