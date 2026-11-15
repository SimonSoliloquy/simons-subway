#!/usr/bin/env python3
"""Ground layers styled after the MTA subway map, in the same local projection as subway.json.

Inputs (raw/):
  boroughs.geojson   NYC Open Data gthc-hcne (borough boundaries, clipped to shoreline)
  parks.geojson      NYC Open Data enfh-gkve (Parks Properties, acres > 25)
  airports.geojson   NYC Open Data 6dic-zdhf (airport polygons)
  counties/          US Census cb_2023_us_county_500k (neighbouring NJ / NY counties)
Output: public/data/ground.json  {land, parks, airports, labels}
"""
import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw")
sub = json.load(open(os.path.join(ROOT, "public", "data", "subway.json")))
LAT0, LON0, KX, KZ = sub["origin"]

# counties around the city that appear on the map (NJ shore, Westchester, Long Island)
NEIGHBOURS = {"34017", "34003", "34013", "34039", "34023", "34031", "34025", "34035", "34027",
              "36119", "36059", "36087", "36103"}


def proj(lon, lat):
    return ((lon - LON0) * KX, -(lat - LAT0) * KZ)


def simplify(pts, tol):
    if len(pts) < 4:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, az), (bx, bz) = pts[a], pts[b]
        dx, dz = bx - ax, bz - az
        L = dx * dx + dz * dz or 1e-12
        best, bi = 0, -1
        for i in range(a + 1, b):
            px, pz = pts[i]
            t = max(0, min(1, ((px - ax) * dx + (pz - az) * dz) / L))
            d = (px - ax - t * dx) ** 2 + (pz - az - t * dz) ** 2
            if d > best:
                best, bi = d, i
        if best > tol * tol:
            keep[bi] = True
            stack += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]


def area(r):
    return abs(sum(r[i][0] * r[i - 1][1] - r[i - 1][0] * r[i][1] for i in range(len(r)))) / 2


def polys_of(geom):
    if geom["type"] == "Polygon":
        return [geom["coordinates"]]
    if geom["type"] == "MultiPolygon":
        return geom["coordinates"]
    return []


def convert(polys, tol, min_area, hole_area=0.005):
    out = []
    for poly in polys:
        rings = [simplify([proj(*c[:2]) for c in ring], tol) for ring in poly]
        if len(rings[0]) < 4 or area(rings[0]) < min_area:
            continue
        rings = [rings[0]] + [r for r in rings[1:] if len(r) >= 4 and area(r) > hole_area]
        out.append([[c for p in r for c in (round(p[0], 3), round(p[1], 3))] for r in rings])
    return out


def centroid(flat):
    xs, zs = flat[0::2], flat[1::2]
    return sum(xs) / len(xs), sum(zs) / len(zs)


land, labels = [], []
for f in json.load(open(os.path.join(RAW, "boroughs.geojson")))["features"]:
    polys = convert(polys_of(f["geometry"]), 0.012, 0.02)
    land += polys
    big = max(polys, key=lambda p: area(list(zip(p[0][0::2], p[0][1::2]))))
    name = f["properties"]["boroname"]
    labels.append({"name": "The Bronx" if name == "Bronx" else name, "pos": [round(v, 3) for v in centroid(big[0])]})

try:
    import shapefile  # pyshp
    sf = shapefile.Reader(os.path.join(RAW, "counties", "cb_2023_us_county_500k"))
    for rec, shp in zip(sf.iterRecords(), sf.iterShapes()):
        if rec["GEOID"] not in NEIGHBOURS:
            continue
        land += convert(polys_of(shp.__geo_interface__), 0.03, 0.05)
except ImportError:
    print("pyshp not installed: skipping neighbouring counties", file=sys.stderr)

parks = []
for f in json.load(open(os.path.join(RAW, "parks.geojson")))["features"]:
    parks += convert(polys_of(f["geometry"]), 0.012, 0.06, 0.01)

airports = []
for f in json.load(open(os.path.join(RAW, "airports.geojson")))["features"]:
    airports += convert(polys_of(f["geometry"]), 0.01, 0.05)

dst = os.path.join(ROOT, "public", "data", "ground.json")
json.dump({"land": land, "parks": parks, "airports": airports, "labels": labels}, open(dst, "w"), separators=(",", ":"))
print(f"wrote {dst}: land {len(land)}, parks {len(parks)}, airports {len(airports)}, {os.path.getsize(dst)/1e3:.0f} KB")
