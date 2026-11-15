#!/usr/bin/env python3
"""Convert MTA subway static GTFS (raw/gtfs/*.txt) into public/data/subway.json.

Output (all coordinates in kilometres on a local plane, x = east, z = south):
  routes    {route_id: {short, long, color, text, slot}}
  stations  {parent_id: [name, x, z, [route_ids], complex_id]}
  shapes    {shape_id: [x0, z0, x1, z1, ...]}          simplified, station points pinned
  lines     {route_id: [shape_id, ...]}                minimal set of shapes to draw per route
  patterns  [[route_id, shape_id, [stops], [point idx per stop], [seconds between stops], trip_count]]

Live trips are matched to a pattern on the client by stop sequence (live trip_ids often carry
origin times that differ from the static schedule, so exact trip_id matching is unreliable).
"""
import csv, json, math, os, statistics, sys
from collections import defaultdict, Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
G = os.path.join(ROOT, "raw", "gtfs")
OUT = os.path.join(ROOT, "public", "data", "subway.json")


def rows(name):
    with open(os.path.join(G, name), newline="", encoding="utf-8-sig") as f:
        yield from csv.DictReader(f)


def secs(t):
    h, m, s = t.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


# ---------- stops / projection ----------
stops = {r["stop_id"]: r for r in rows("stops.txt")}
parent_of = {sid: (r["parent_station"] or sid) for sid, r in stops.items()}
parents = {sid: r for sid, r in stops.items() if r["location_type"] == "1"}
lats = [float(r["stop_lat"]) for r in parents.values()]
lons = [float(r["stop_lon"]) for r in parents.values()]
LAT0 = (min(lats) + max(lats)) / 2
LON0 = (min(lons) + max(lons)) / 2
KX = 111.320 * math.cos(math.radians(LAT0))
KZ = 110.574


def proj(lat, lon):
    return ((lon - LON0) * KX, -(lat - LAT0) * KZ)


station_xy = {sid: proj(float(r["stop_lat"]), float(r["stop_lon"])) for sid, r in parents.items()}

# ---------- routes ----------
routes = {}
for r in rows("routes.txt"):
    routes[r["route_id"]] = {
        "short": r["route_short_name"],
        "long": r["route_long_name"],
        "color": "#" + (r["route_color"] or "808183"),
        "text": "#" + (r["route_text_color"] or "FFFFFF"),
        "sort": int(r["route_sort_order"] or 99),
    }
# vertical slot: routes that share a trunk colour stack on top of each other
by_color = defaultdict(list)
for rid, r in sorted(routes.items(), key=lambda kv: kv[1]["sort"]):
    by_color[r["color"]].append(rid)
for color, rids in by_color.items():
    for i, rid in enumerate(rids):
        routes[rid]["slot"] = i

# ---------- trips ----------
trips = {}
shape_trips = Counter()
for r in rows("trips.txt"):
    trips[r["trip_id"]] = (r["route_id"], r["service_id"], r["shape_id"])
    shape_trips[r["shape_id"]] += 1


# ---------- stop_times -> patterns ----------
seg_times = defaultdict(list)          # (from_parent, to_parent) -> [seconds]
pattern_ids = {}                       # (route, shape, stops tuple) -> idx
patterns = []
pattern_count = Counter()
station_routes = defaultdict(set)


def flush(tid, seq):
    if not seq or tid not in trips:
        return
    seq.sort()
    route, service, shape = trips[tid]
    st = []
    times = []
    for _, sid, arr, dep in seq:
        p = parent_of.get(sid, sid)
        if st and st[-1] == p:
            continue
        st.append(p)
        times.append((arr, dep))
        station_routes[p].add(route)
    for i in range(1, len(st)):
        seg_times[(st[i - 1], st[i])].append(max(15, times[i][0] - times[i - 1][1]))
    key = (route, shape, tuple(st))
    if key not in pattern_ids:
        pattern_ids[key] = len(patterns)
        patterns.append(key)
    pattern_count[pattern_ids[key]] += 1


cur, seq = None, []
for r in rows("stop_times.txt"):
    tid = r["trip_id"]
    if tid != cur:
        flush(cur, seq)
        cur, seq = tid, []
    seq.append((int(r["stop_sequence"]), r["stop_id"], secs(r["arrival_time"]), secs(r["departure_time"])))
flush(cur, seq)
print(f"patterns: {len(patterns)}", file=sys.stderr)

# ---------- shapes ----------
raw_shapes = defaultdict(list)
for r in rows("shapes.txt"):
    raw_shapes[r["shape_id"]].append((int(r["shape_pt_sequence"]), float(r["shape_pt_lat"]), float(r["shape_pt_lon"])))
for sid in raw_shapes:
    raw_shapes[sid] = [proj(lat, lon) for _, lat, lon in sorted(raw_shapes[sid])]


def d2(a, b):
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2


def locate(pts, stations):
    """Index of the shape point nearest each station, monotonically increasing."""
    out, start = [], 0
    for s in stations:
        p = station_xy[s]
        best, bi = float("inf"), start
        for i in range(start, len(pts)):
            d = d2(pts[i], p)
            if d < best:
                best, bi = d, i
            elif best < 0.15 ** 2 and d > 1.0:
                break
        out.append(bi)
        start = bi
    return out


def seg_dist2(p, a, b):
    ax, az = a
    dx, dz = b[0] - ax, b[1] - az
    L = dx * dx + dz * dz
    t = 0 if L == 0 else max(0, min(1, ((p[0] - ax) * dx + (p[1] - az) * dz) / L))
    return d2(p, (ax + t * dx, az + t * dz))


def dp(pts, lo, hi, tol2, keep):
    stack = [(lo, hi)]
    while stack:
        a, b = stack.pop()
        best, bi = 0, -1
        for i in range(a + 1, b):
            d = seg_dist2(pts[i], pts[a], pts[b])
            if d > best:
                best, bi = d, i
        if best > tol2:
            keep.add(bi)
            stack += [(a, bi), (bi, b)]


used_shapes = {k[1] for k in patterns}
shape_pins = defaultdict(set)
pattern_locs = {}
for i, (route, shape, st) in enumerate(patterns):
    pts = raw_shapes[shape]
    # snap station locations onto the shape (exact station point inserted later)
    loc = locate(pts, st)
    pattern_locs[i] = loc
    shape_pins[shape].update(loc)

shapes_out, remap = {}, {}
for shape in used_shapes:
    pts = raw_shapes[shape]
    pins = sorted(shape_pins[shape] | {0, len(pts) - 1})
    keep = set(pins)
    for a, b in zip(pins, pins[1:]):
        dp(pts, a, b, 0.004 ** 2, keep)
    kept = sorted(keep)
    remap[shape] = {old: new for new, old in enumerate(kept)}
    flat = []
    for k in kept:
        flat += [round(pts[k][0], 4), round(pts[k][1], 4)]
    shapes_out[shape] = flat

patterns_out = []
for i, (route, shape, st) in enumerate(patterns):
    idx = [remap[shape][j] for j in pattern_locs[i]]
    dts = []
    for a, b in zip(st, st[1:]):
        v = seg_times.get((a, b))
        dts.append(int(statistics.median(v)) if v else 90)
    patterns_out.append([route, shape, list(st), idx, dts, pattern_count[i]])

# ---------- minimal set of shapes to draw per route ----------
lines = {}
for route in routes:
    cand = Counter()
    pairs_of = defaultdict(set)
    for route2, shape, st in patterns:
        if route2 != route:
            continue
        cand[shape] = shape_trips[shape]
        pairs_of[shape] |= {frozenset(p) for p in zip(st, st[1:])}
    covered, chosen = set(), []
    for shape, _ in cand.most_common():
        new = pairs_of[shape] - covered
        if len(new) >= 1:
            chosen.append(shape)
            covered |= pairs_of[shape]
    if chosen:
        lines[route] = chosen

# station complexes (e.g. 14 St-Union Sq = 635 + R20 + L03): union-find over in-system transfers
complex_of = {sid: sid for sid in parents}


def find(x):
    while complex_of[x] != x:
        complex_of[x] = complex_of[complex_of[x]]
        x = complex_of[x]
    return x


for r in rows("transfers.txt"):
    a, b = parent_of.get(r["from_stop_id"]), parent_of.get(r["to_stop_id"])
    if a in complex_of and b in complex_of and a != b:
        complex_of[find(a)] = find(b)

stations_out = {sid: [r["stop_name"], round(station_xy[sid][0], 4), round(station_xy[sid][1], 4),
                      sorted(station_routes.get(sid, []), key=lambda x: routes.get(x, {}).get("sort", 99)), find(sid)]
                for sid, r in parents.items()}

out = {
    "origin": [LAT0, LON0, KX, KZ],
    "routes": {k: {kk: v for kk, v in r.items() if kk != "sort"} | {"sort": r["sort"]} for k, r in routes.items()},
    "stations": stations_out,
    "shapes": shapes_out,
    "lines": lines,
    "patterns": patterns_out,
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w") as f:
    json.dump(out, f, separators=(",", ":"))
print(f"wrote {OUT}: {os.path.getsize(OUT)/1e6:.2f} MB, {len(shapes_out)} shapes, "
      f"{sum(len(v) for v in shapes_out.values())//2} pts, lines {sum(len(v) for v in lines.values())}", file=sys.stderr)
