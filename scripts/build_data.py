#!/usr/bin/env python3
"""Convert MTA subway static GTFS (raw/gtfs/*.txt) into public/data/subway.json.

Output (all coordinates in kilometres on a local plane, x = east, z = south):
  routes    {route_id: {short, long, color, text, slot}}
  stations  {parent_id: [name, x, z, [route_ids], complex_id, [night_route_ids], ada, ada_n, ada_s, ada_notes]}
  shapes    {shape_id: [x0, z0, x1, z1, ...]}          simplified, station points pinned
  lines     {route_id: [shape_id, ...]}                minimal set of shapes to draw per route
  nightLines {route_id: [shape_id, ...]}               same, over late-night trips (regular feed)
  patterns  [[route_id, shape_id, [stops], [point idx per stop], [seconds between stops], trip_count, night_trip_count]]
  elevators {equipmentno: [parent_stop_id, 'EL'|'ES', short_description, ada_flag]}
  meta      {built, regularFeed, supplementedFeed}

Patterns come from the regular feed AND the hourly supplemented feed (so live rerouted trains still match);
lines / nightLines / station route lists come from the regular feed only. Staten Island (SI) is dropped.

Live trips are matched to a pattern on the client by stop sequence (live trip_ids often carry
origin times that differ from the static schedule, so exact trip_id matching is unreliable).
"""
import csv, datetime, json, math, os, re, statistics, sys
from collections import defaultdict, Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
G = os.path.join(ROOT, "raw", "gtfs")
GS = os.path.join(ROOT, "raw", "gtfs_supplemented")
SKIP_ROUTES = {"SI"}
NIGHT_LO, NIGHT_HI = 30 * 60, 4 * 3600 + 30 * 60   # first departure (mod 24h) window for "late night"
NIGHT_MIN_TRIPS = 5                                 # a pattern needs this many night trips to count
PRUNE_SUPP_MAX = 2                                  # drop supplemented-only patterns with <= this many trips
MAP_MIN_TRIPS = 6                                   # the standard map shows a route at a stop / on a segment only with
                                                    # this many scheduled daytime (7 AM-7 PM) trips there, or all of
                                                    # the route's daytime trips if fewer. As on the MTA map, this keeps
                                                    # late-night and evening-only service (the 2 at 86 St, the D or N at
                                                    # Union St) and
                                                    # one-off moves (an R to 96 St, a W to Bay Pkwy) off the standard
                                                    # map; live trains on them still match their patterns.
DAY_LO, DAY_HI = 7 * 3600, 19 * 3600
OUT = os.path.join(ROOT, "public", "data", "subway.json")


def rows(name, d=None):
    with open(os.path.join(d or G, name), newline="", encoding="utf-8-sig") as f:
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
    if r["route_id"] in SKIP_ROUTES:
        continue
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

# ---------- trips / stop_times -> patterns (both feeds) ----------
seg_times = defaultdict(list)          # (from_parent, to_parent) -> [seconds]
pattern_ids = {}                       # (route, shape, stops tuple) -> idx
patterns = []
cnt_reg, cnt_supp, cnt_night = Counter(), Counter(), Counter()
shape_trips = Counter()                # regular feed, for the minimal covers
shape_night = Counter()
route_trips, route_stop_trips, route_pair_trips = Counter(), Counter(), Counter()   # daytime, regular feed


def is_day(t):
    return DAY_LO <= t % 86400 < DAY_HI


shape_stoplist = {}        # shape -> longest regular stop list on it
_resolved = {}
unresolved_stats = Counter()


def lcs(a, b):
    prev = [0] * (len(b) + 1)
    for x in a:
        cur = [0]
        for j, y in enumerate(b):
            cur.append(prev[j] + 1 if x == y else max(prev[j + 1], cur[j]))
        prev = cur
    return prev[-1]


def resolve_shape(route, st):
    """Shape-less (supplemented reroute) trip -> the regular shape whose stop list covers most of its stops."""
    key = (route, st)
    if key in _resolved:
        return _resolved[key]
    sset = set(st)
    ranked = sorted(shape_stoplist.items(),
                    key=lambda kv: (-len(sset & set(kv[1])), kv[0].split(".")[0] != route))[:10]
    best = max(ranked, key=lambda kv: (lcs(st, kv[1]), kv[0].split(".")[0] == route))
    cov = lcs(st, best[1]) / len(st)
    unresolved_stats[round(cov, 1)] += 1
    _resolved[key] = (best[0], cov)
    return _resolved[key]


def load_feed(d, is_reg):
    trips = {}
    for r in rows("trips.txt", d):
        if r["route_id"] in SKIP_ROUTES:
            continue
        trips[r["trip_id"]] = (r["route_id"], r["shape_id"])   # supplemented reroutes often have no shape_id
        if is_reg and r["shape_id"]:
            shape_trips[r["shape_id"]] += 1
    cnt = cnt_reg if is_reg else cnt_supp

    def flush(tid, seq):
        if not seq or tid not in trips:
            return
        seq.sort()
        route, shape = trips[tid]
        st, times = [], []
        for _, sid, arr, dep in seq:
            p = parent_of.get(sid, sid)
            if p not in station_xy:
                continue
            if st and st[-1] == p:
                continue
            st.append(p)
            times.append((arr, dep))
        if len(st) < 2:
            return
        for i in range(1, len(st)):
            seg_times[(st[i - 1], st[i])].append(max(15, times[i][0] - times[i - 1][1]))
        if not shape:
            shape = resolve_shape(route, tuple(st))[0]
        key = (route, shape, tuple(st))
        if key not in pattern_ids:
            pattern_ids[key] = len(patterns)
            patterns.append(key)
        i = pattern_ids[key]
        cnt[i] += 1
        if is_reg:
            if any(is_day(a) for a, _ in times):
                route_trips[route] += 1
            for p, (a, _) in zip(st, times):
                if is_day(a):
                    route_stop_trips[(route, p)] += 1
            for (p, (_, d)), q in zip(zip(st, times), st[1:]):
                if is_day(d):
                    route_pair_trips[(route, frozenset((p, q)))] += 1
            first = seq[0][3] % 86400
            if NIGHT_LO <= first <= NIGHT_HI:
                cnt_night[i] += 1
                shape_night[shape] += 1

    cur, seq = None, []
    for r in rows("stop_times.txt", d):
        tid = r["trip_id"]
        if tid != cur:
            flush(cur, seq)
            cur, seq = tid, []
        if tid in trips:
            seq.append((int(r["stop_sequence"]), r["stop_id"], secs(r["arrival_time"]), secs(r["departure_time"])))
    flush(cur, seq)


load_feed(G, True)
n_reg_patterns = len(patterns)
for route, shape, st in patterns:
    if len(st) > len(shape_stoplist.get(shape, ())):
        shape_stoplist[shape] = st
load_feed(GS, False)
print(f"shape-less supplemented patterns resolved to nearest shape, stop-coverage histogram: {sorted(unresolved_stats.items())}", file=sys.stderr)
print(f"patterns: {n_reg_patterns} regular, {len(patterns)} total", file=sys.stderr)

# prune supplemented-only patterns with 1-2 trips (one-off reroutes) to keep the file small
pruned = [i for i in range(len(patterns)) if cnt_reg[i] == 0 and cnt_supp[i] <= PRUNE_SUPP_MAX]
pruned_set = set(pruned)
print(f"pruned {len(pruned)} supplemented-only patterns with <= {PRUNE_SUPP_MAX} trips", file=sys.stderr)
keep_idx = [i for i in range(len(patterns)) if i not in pruned_set]

# station route lists (regular feed only): daytime service, leaving out stops a route serves only a handful of times
def map_min(route):
    return min(MAP_MIN_TRIPS, route_trips[route])


station_routes, station_night = defaultdict(set), defaultdict(set)
for i, (route, shape, st) in enumerate(patterns):
    if cnt_reg[i]:
        for p in st:
            if route_stop_trips[(route, p)] >= map_min(route):
                station_routes[p].add(route)
    if cnt_night[i] >= NIGHT_MIN_TRIPS:
        for p in st:
            station_night[p].add(route)

# ---------- shapes ----------
raw_shapes = defaultdict(list)
supp_only_shapes_seen = set()
for r in rows("shapes.txt"):
    raw_shapes[r["shape_id"]].append((int(r["shape_pt_sequence"]), float(r["shape_pt_lat"]), float(r["shape_pt_lon"])))
for r in rows("shapes.txt", GS):
    if r["shape_id"] in raw_shapes and r["shape_id"] not in supp_only_shapes_seen:
        continue   # regular feed geometry wins
    supp_only_shapes_seen.add(r["shape_id"])
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


# Patterns whose stops do not lie on their shape (supplemented reroutes such as an A via the F line or a
# D via the Sea Beach line: the MTA gives them the usual shape or none at all) get a stitched shape: each
# hop between stops taken from a regular pattern that makes the same hop, else a straight line.
STOP_OFF_SHAPE = 0.2   # km


def fits(pts, st):
    return all(d2(pts[j], station_xy[s]) < STOP_OFF_SHAPE ** 2 for s, j in zip(st, locate(pts, st)))


hop_geom = {}
for i in keep_idx:
    route, shape, st = patterns[i]
    if not cnt_reg[i]:
        continue
    pts = raw_shapes[shape]
    loc = locate(pts, st)
    if not all(d2(pts[j], station_xy[s]) < STOP_OFF_SHAPE ** 2 for s, j in zip(st, loc)):
        continue
    for k in range(len(st) - 1):
        seg = pts[loc[k]:loc[k + 1] + 1]
        if len(seg) >= 2:
            hop_geom.setdefault((st[k], st[k + 1]), seg)
            hop_geom.setdefault((st[k + 1], st[k]), seg[::-1])

stitched, n_straight = {}, 0
for i in keep_idx:
    route, shape, st = patterns[i]
    if fits(raw_shapes[shape], st):
        continue
    if st not in stitched:
        m = re.search(r"\.([NS])", shape)
        sid = f"{route}..{m.group(1) if m else 'N'}~{len(stitched)}"
        pts = [station_xy[st[0]]]
        for a, b in zip(st, st[1:]):
            seg = hop_geom.get((a, b))
            if not seg:
                n_straight += 1
                seg = [station_xy[a], station_xy[b]]
            pts += seg[1:] if d2(seg[0], pts[-1]) < 1e-8 else seg
        raw_shapes[sid] = pts
        stitched[st] = sid
    patterns[i] = (route, stitched[st], st)
print(f"stitched {len(stitched)} shapes for patterns off their shape ({n_straight} straight hops)", file=sys.stderr)

used_shapes = {patterns[i][1] for i in keep_idx}
shape_pins = defaultdict(set)
pattern_locs = {}
for i in keep_idx:
    route, shape, st = patterns[i]
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
for i in keep_idx:
    route, shape, st = patterns[i]
    idx = [remap[shape][j] for j in pattern_locs[i]]
    dts = []
    for a, b in zip(st, st[1:]):
        v = seg_times.get((a, b))
        dts.append(int(statistics.median(v)) if v else 90)
    patterns_out.append([route, shape, list(st), idx, dts, cnt_reg[i] or cnt_supp[i], cnt_night[i]])

# ---------- minimal set of shapes to draw per route (regular feed only) ----------
def cover(weight, eligible, pair_ok=lambda route, pair: True):
    out = {}
    for route in routes:
        cand = Counter()
        pairs_of = defaultdict(set)
        for i in eligible:
            route2, shape, st = patterns[i]
            if route2 != route:
                continue
            cand[shape] = weight[shape]
            pairs_of[shape] |= {frozenset(p) for p in zip(st, st[1:]) if pair_ok(route, frozenset(p))}
        covered, chosen = set(), []
        for shape, _ in cand.most_common():
            if pairs_of[shape] - covered:
                chosen.append(shape)
                covered |= pairs_of[shape]
        if chosen:
            out[route] = chosen
    return out


lines = cover(shape_trips, [i for i in keep_idx if cnt_reg[i]],
              lambda route, pair: route_pair_trips[(route, pair)] >= map_min(route))
nightLines = cover(shape_night, [i for i in keep_idx if cnt_night[i] >= NIGHT_MIN_TRIPS])

# station complexes (e.g. 14 St-Union Sq = 635 + R20 + L03): union-find over in-system transfers
complex_of = {sid: sid for sid in parents}


def find(x):
    while complex_of[x] != x:
        complex_of[x] = complex_of[complex_of[x]]
        x = complex_of[x]
    return x


# free in-system transfers the MTA map shows that the GTFS transfers.txt leaves out
EXTRA_TRANSFERS = [
    ("142", "R27"),   # South Ferry (1) - Whitehall St-South Ferry (R/W), one station complex since 2009
]
pairs = [(parent_of.get(r["from_stop_id"]), parent_of.get(r["to_stop_id"])) for r in rows("transfers.txt")]
for a, b in pairs + EXTRA_TRANSFERS:
    if a in complex_of and b in complex_of and a != b:
        complex_of[find(a)] = find(b)

ada = {}
for r in json.load(open(os.path.join(ROOT, "raw", "stations_ada.json"))):
    sid = parent_of.get(r["gtfs_stop_id"], r["gtfs_stop_id"])
    def n(v):
        return int(v) if str(v) in ("0", "1", "2") else 0
    notes = r.get("ada_notes") or ""
    new = [n(r.get("ada")), n(r.get("ada_northbound")), n(r.get("ada_southbound")), "" if notes == "NaN" else notes]
    if sid not in ada or new[0] > ada[sid][0]:
        ada[sid] = new

def rsort(rs):
    return sorted(rs, key=lambda x: routes.get(x, {}).get("sort", 99))

stations_out = {sid: [r["stop_name"], round(station_xy[sid][0], 4), round(station_xy[sid][1], 4),
                      rsort(station_routes.get(sid, [])), find(sid), rsort(station_night.get(sid, []))]
                     + ada.get(sid, [0, 0, 0, ""])
                for sid, r in parents.items()}

elevators = {}
for e in json.load(open(os.path.join(ROOT, "raw", "ene_equipments.json"))):
    # inactive equipment is kept: long-term outages (e.g. an elevator being replaced) are listed as
    # inactive in the equipment list but still appear in the live outage feed
    ids = [x for x in re.split(r"[/\s,]+", e.get("elevatorsgtfsstopid") or "") if x]
    ids = [parent_of.get(x, x) for x in ids]
    ids = [x for x in ids if x in parents]
    if not ids:
        continue
    elevators[e["equipmentno"]] = [ids[0], e["equipmenttype"], e.get("shortdescription", ""), e.get("ADA", "")]


def feed_meta(d):
    try:
        r = next(rows("feed_info.txt", d))
        return {"version": r.get("feed_version"), "start": r.get("feed_start_date"), "end": r.get("feed_end_date")}
    except Exception:
        return None


out = {
    "origin": [LAT0, LON0, KX, KZ],
    "routes": {k: {kk: v for kk, v in r.items() if kk != "sort"} | {"sort": r["sort"]} for k, r in routes.items()},
    "stations": stations_out,
    "shapes": shapes_out,
    "lines": lines,
    "nightLines": nightLines,
    "patterns": patterns_out,
    "elevators": elevators,
    "meta": {"built": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
             "regularFeed": feed_meta(G), "supplementedFeed": feed_meta(GS)},
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w") as f:
    json.dump(out, f, separators=(",", ":"))
print(f"wrote {OUT}: {os.path.getsize(OUT)/1e6:.2f} MB, {len(shapes_out)} shapes, {len(patterns_out)} patterns, {len(elevators)} elevators, "
      f"{sum(len(v) for v in shapes_out.values())//2} pts, lines {sum(len(v) for v in lines.values())}", file=sys.stderr)
