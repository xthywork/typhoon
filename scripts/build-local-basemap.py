# /// script
# requires-python = ">=3.11"
# dependencies = ["mapbox-vector-tile>=2.2,<3", "shapely>=2.1,<3"]
# ///
"""Build the local OSM water/coastline geometry: uv run scripts/build-local-basemap.py.

The preparation step uses OpenFreeMap's permitted small offline download:
fewer than 3000 tiles / 50 MB, four requests at most, identifiable User-Agent.
The running website never contacts the tile service.
"""
import concurrent.futures
import gzip
import hashlib
import json
import math
from pathlib import Path
import subprocess
import tempfile
import threading

import mapbox_vector_tile
from shapely import make_valid, transform
from shapely.geometry import box, mapping, shape
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parent.parent
CACHE = Path(tempfile.gettempdir()) / "typhoon-local-basemap"
OUT = ROOT / "data" / "basemap"
UA = "TyphoonLocalBasemap/1.0 (https://github.com/xthybot/typhoon)"
DETAIL_BOUNDS = (95, -5, 165, 55)
LIMIT = 44_000_000  # Leave headroom under the provider's 50 MB download limit.
lock = threading.Lock()
downloaded = 0


def get(url):
    return subprocess.check_output([
        "curl", "-fsSL", "--compressed", "--max-time", "45", "-A", UA, url
    ])


def tile_y(lat, z):
    return int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 2**z)


def tile_lon(x, z):
    return x / 2**z * 360 - 180


def tile_lat(y, z):
    return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / 2**z))))


def water(tile, template):
    global downloaded
    z, x, y = tile
    target = CACHE / f"{z}-{x}-{y}.pbf"
    data = target.read_bytes() if target.exists() else get(
        template.replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))
    )
    with lock:
        downloaded += len(data)
        if downloaded > LIMIT:
            raise RuntimeError("Offline download budget reached; reduce the detailed region.")
    target.write_bytes(data)
    layer = mapbox_vector_tile.decode(data, default_options={"y_coord_down": True}).get("water")
    if not layer:
        return []
    extent = layer["extent"]
    clip = box(tile_lon(x, z), tile_lat(y + 1, z), tile_lon(x + 1, z), tile_lat(y, z))

    def project(xs, ys, zs=None):
        return (
            [tile_lon(x + u / extent, z) for u in xs],
            [tile_lat(y + v / extent, z) for v in ys],
        )

    polygons = []
    for feature in layer["features"]:
        geom = feature["geometry"]
        if geom["type"] not in ("Polygon", "MultiPolygon"):
            continue
        coast = make_valid(transform(shape(geom), project, interleaved=False)).intersection(clip)
        if not coast.is_empty:
            polygons.append(coast)
    return polygons


def main():
    CACHE.mkdir(exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    source = json.loads(get("https://tiles.openfreemap.org/planet"))
    template = source["tiles"][0]
    # Cache files belong to a fixed dataset snapshot, never mix dates.
    snapshot = CACHE / "source.txt"
    if snapshot.exists() and snapshot.read_text() != template:
        for cached in CACHE.glob("*.pbf"):
            cached.unlink()
    snapshot.write_text(template)
    global_tiles = [(2, x, y) for x in range(4) for y in range(4)]
    west, south, east, north = DETAIL_BOUNDS
    detailed_tiles = [
        (6, x, y)
        for x in range(int((west + 180) / 360 * 64), int((east + 180) / 360 * 64) + 1)
        for y in range(tile_y(north, 6), tile_y(south, 6) + 1)
    ]
    tasks = global_tiles + detailed_tiles
    if len(tasks) > 3000:
        raise RuntimeError("Too many offline tiles")
    print(f"Preparing {len(tasks)} tiles, at most 4 concurrent downloads", flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        parts = list(pool.map(lambda t: water(t, template), tasks))
    global_water = make_valid(unary_union([g for part in parts[:len(global_tiles)] for g in part]))
    detailed_water = make_valid(unary_union([g for part in parts[len(global_tiles):] for g in part]))
    region = box(*DETAIL_BOUNDS)
    merged = unary_union([
        global_water.difference(region), detailed_water.intersection(region)
    ]).simplify(0.003, preserve_topology=True)
    # Keep polygon geometry only; clipping can produce tiny line fragments.
    def polygons(geom):
        if geom.geom_type == "Polygon":
            return [geom]
        return [p for g in getattr(geom, "geoms", []) for p in polygons(g)]
    merged = unary_union([p for p in polygons(merged) if p.area >= 0.005])
    geojson = {"type": "Feature", "properties": {}, "geometry": mapping(merged)}
    # Four decimals are about 10 metres, finer than this overview basemap needs.
    def rounded(value):
        if isinstance(value, float):
            return round(value, 4)
        if isinstance(value, (tuple, list)):
            return [rounded(v) for v in value]
        if isinstance(value, dict):
            return {k: rounded(v) for k, v in value.items()}
        return value
    payload = json.dumps(rounded(geojson), separators=(",", ":")).encode()
    (OUT / "water.geojson").write_bytes(payload)
    compressed = gzip.compress(payload, compresslevel=9, mtime=0)
    (OUT / "water.geojson.gz").write_bytes(compressed)
    provenance = {
        "source": "OpenStreetMap via OpenFreeMap / OpenMapTiles",
        "source_tiles": template, "global_source_zoom": 2, "detailed_source_zoom": 6,
        "detailed_bounds": DETAIL_BOUNDS, "tile_count": len(tasks),
        "source_bytes": downloaded, "local_bytes": len(payload), "compressed_bytes": len(compressed),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "license": "ODbL-1.0", "copyright": "© OpenStreetMap contributors",
        "build": "uv run scripts/build-local-basemap.py",
    }
    (OUT / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    print(json.dumps(provenance, indent=2), flush=True)


if __name__ == "__main__":
    main()
