// Static network model built from public/data/subway.json, plus the logic that places
// a live GTFS-realtime trip on the track geometry.

// ---------- schematic distortion ----------
// The MTA map is not to scale: dense Manhattan and Downtown Brooklyn are drawn larger and the
// outer boroughs smaller, so stations in the core have room. Every coordinate (track, stations,
// land, labels) goes through the same radial magnification, strongest around Lower Manhattan
// and fading to true scale about 14 km out: m(r) = 1 + A·exp(-(r/S)²).
const CORE = { x: 1.0, z: -1.5 }; // km from the origin (City Hall), about Canal St
const MAG_A = 1.4, MAG_S = 7;    // 2.4x at the core, 1.5x 7 km out, ~1x beyond 14 km
const SQRT_PI_2 = Math.sqrt(Math.PI) / 2;
function erf(x) { // Abramowitz-Stegun 7.1.26, |error| < 1.5e-7
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
/** Map a true (km) position to its schematic position. */
export function distort(x, z) {
  const dx = x - CORE.x, dz = z - CORE.z, r = Math.hypot(dx, dz);
  if (r < 1e-9) return [x, z];
  const k = (r + MAG_A * MAG_S * SQRT_PI_2 * erf(r / MAG_S)) / r; // ∫ m(r) dr / r
  return [CORE.x + dx * k, CORE.z + dz * k];
}
/** Local magnification along the track at a schematic position (for honest speeds). */
export function mapScale(x, z) {
  // invert roughly: the schematic radius is at least the true radius, so search outward
  const dx = x - CORE.x, dz = z - CORE.z, R = Math.hypot(dx, dz);
  let lo = 0, hi = R;
  for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; const [px, pz] = distort(CORE.x + m, CORE.z); if (px - CORE.x < R) lo = m; else hi = m; }
  return 1 + MAG_A * Math.exp(-((lo / MAG_S) ** 2));
}
export const MAX_MAG = 1 + MAG_A;
const distortFlat = (flat) => {
  const out = new Float32Array(flat.length);
  for (let i = 0; i < flat.length; i += 2) { const [x, z] = distort(flat[i], flat[i + 1]); out[i] = x; out[i + 1] = z; }
  return out;
};

// ---------- cleaning and rounding the GTFS shapes ----------
// GTFS shapes have a vertex only every ~200 m, so bends are angular, and a few fold back on
// themselves (the N via City Hall runs out to the Canal St bridge platforms and straight back;
// the 5 folds at 149 St-Grand Concourse). Folds are flattened onto their chord, then every
// corner is rounded with a short curve. Vertex i of the raw shape maps to vertex
// roundedIndex(i, n) of the result, so stop positions stay valid.
const ROUND_K = 5;       // points per rounded corner
const ROUND_D = 0.3;     // km: how far along each leg a corner's curve may start
export const roundedIndex = (i, n) => (i <= 0 ? 0 : i >= n - 1 ? (n - 2) * ROUND_K + 1 : 1 + (i - 1) * ROUND_K + 2);
function flattenFolds(flat) {
  const n = flat.length / 2;
  for (let i = 0; i < n - 2; i++) {
    let arc = 0, best = -1;
    for (let j = i + 1; j < n; j++) {
      arc += Math.hypot(flat[2 * j] - flat[2 * j - 2], flat[2 * j + 1] - flat[2 * j - 1]);
      if (arc > 1.5) break;
      // the path has turned back on itself (sharper than about 120 degrees): everything in between is a fold
      if (j >= i + 2 && arc > 0.15 && Math.hypot(flat[2 * j] - flat[2 * i], flat[2 * j + 1] - flat[2 * i + 1]) < 0.5 * arc) best = j;
    }
    if (best < 0) continue;
    for (let k = i + 1; k < best; k++) {
      const t = (k - i) / (best - i);
      flat[2 * k] = flat[2 * i] + (flat[2 * best] - flat[2 * i]) * t;
      flat[2 * k + 1] = flat[2 * i + 1] + (flat[2 * best + 1] - flat[2 * i + 1]) * t;
    }
    i = best - 1;
  }
}
function roundCorners(flat) {
  const n = flat.length / 2;
  if (n < 3) return flat;
  const out = new Float32Array(((n - 2) * ROUND_K + 2) * 2);
  let o = 0;
  const put = (x, z) => { out[o++] = x; out[o++] = z; };
  put(flat[0], flat[1]);
  for (let i = 1; i < n - 1; i++) {
    const ax = flat[2 * i - 2], az = flat[2 * i - 1], bx = flat[2 * i], bz = flat[2 * i + 1], cx = flat[2 * i + 2], cz = flat[2 * i + 3];
    const l1 = Math.hypot(ax - bx, az - bz), l2 = Math.hypot(cx - bx, cz - bz);
    const d1 = l1 ? Math.min(0.45 * l1, ROUND_D) / l1 : 0, d2 = l2 ? Math.min(0.45 * l2, ROUND_D) / l2 : 0;
    const px = bx + (ax - bx) * d1, pz = bz + (az - bz) * d1, qx = bx + (cx - bx) * d2, qz = bz + (cz - bz) * d2;
    for (let k = 0; k < ROUND_K; k++) {
      const t = k / (ROUND_K - 1), u = 1 - t;
      put(u * u * px + 2 * u * t * bx + t * t * qx, u * u * pz + 2 * u * t * bz + t * t * qz);
    }
  }
  put(flat[2 * n - 2], flat[2 * n - 1]);
  return out;
}

// ---------- one line per trunk, reaching its terminals ----------
// The MTA map draws each trunk as one line: express and local share it, the express just
// skipping stops. GTFS shapes follow the real tracks, and in places the express tracks take a
// path of their own (Queens Blvd between 36 St and Northern Blvd, Culver around 15 St-Prospect
// Park) that would draw as a second strand. There the express hop takes the path of a local
// pattern running between the same two stops (same colour preferred), so the line and the
// trains on it follow one strand. Shapes are flat [x, z, ...] arrays in map km.
const HOP_DEV = 0.02;   // km: an express hop closer than this to the local path is left as it is
const TERMINAL_PIN = 0.3; // km: a shape ending this close to its terminal station is pulled onto it
const polyLen = (p, i0, i1) => { let l = 0; for (let i = i0; i < i1; i++) l += Math.hypot(p[2 * i + 2] - p[2 * i], p[2 * i + 3] - p[2 * i + 1]); return l; };
function distToPolyline(x, z, p) {
  let best = Infinity;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i], az = p[i + 1], dx = p[i + 2] - ax, dz = p[i + 3] - az, l2 = dx * dx + dz * dz;
    const t = l2 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z));
  }
  return best;
}
/** Make the shapes draw as the map does. `patterns` are the raw [route, shape, stops, idx, ...]
 *  rows; their idx (vertex index per stop) is updated in place where vertices are spliced. */
function mapShapes(shapes, patterns, stations, routes) {
  const colour = (r) => routes[r]?.color || r;
  const byStop = new Map(); // station id -> [[pattern, position]]
  patterns.forEach((p) => p[2].forEach((s, k) => { if (!byStop.has(s)) byStop.set(s, []); byStop.get(s).push([p, k]); }));
  const stopVerts = new Map(); // shape id -> Set of vertex indices that are some pattern's stop
  for (const p of patterns) { if (!stopVerts.has(p[1])) stopVerts.set(p[1], new Set()); p[3].forEach((i) => stopVerts.get(p[1]).add(i)); }

  // the local path from station a to station b, as a flat array (null: no local runs a..b)
  const localCache = new Map();
  const localPath = (a, b, route) => {
    const key = `${a}|${b}|${colour(route)}`;
    if (localCache.has(key)) return localCache.get(key);
    let best = null, bs = 0;
    for (const [q, qa] of byStop.get(a) || []) {
      const qb = q[2].indexOf(b);
      if (qb < 0 || Math.abs(qb - qa) < 2) continue;
      const i = q[3][qa], j = q[3][qb], pts = shapes.get(q[1]);
      if (!pts || i === j || (qb > qa) !== (j > i)) continue;
      const score = (colour(q[0]) === colour(route) ? 1000 : 0) + Math.abs(qb - qa) + q[5] / 1e6;
      if (score <= bs) continue;
      const lo = Math.min(i, j), hi = Math.max(i, j), path = pts.slice(2 * lo, 2 * hi + 2);
      if (j < i) for (let k = 0, n = path.length / 2; k < n / 2; k++) {
        const m = n - 1 - k;
        [path[2 * k], path[2 * m]] = [path[2 * m], path[2 * k]];
        [path[2 * k + 1], path[2 * m + 1]] = [path[2 * m + 1], path[2 * k + 1]];
      }
      best = path; bs = score;
    }
    localCache.set(key, best);
    return best;
  };

  // plan every express hop that leaves the local path, then splice (all reads see the original shapes)
  const plans = new Map(); // shape id -> Map("ia,ib" -> inner points)
  for (const [route, sid, stops, idx] of patterns) {
    const pts = shapes.get(sid);
    if (!pts) continue;
    for (let k = 0; k + 1 < stops.length; k++) {
      const ia = idx[k], ib = idx[k + 1];
      if (ib <= ia || plans.get(sid)?.has(ia + ',' + ib)) continue;
      const path = localPath(stops[k], stops[k + 1], route);
      if (!path) continue;
      let inside = false;
      for (const v of stopVerts.get(sid)) if (v > ia && v < ib) { inside = true; break; }
      if (inside) continue; // another pattern stops on this stretch of the shape
      const n = path.length / 2, hopLen = polyLen(pts, ia, ib), pathLen = polyLen(path, 0, n - 1);
      if (!hopLen || pathLen / hopLen > 1.5 || pathLen / hopLen < 0.67) continue;
      if (Math.hypot(path[0] - pts[2 * ia], path[1] - pts[2 * ia + 1]) > 0.1 || Math.hypot(path[2 * n - 2] - pts[2 * ib], path[2 * n - 1] - pts[2 * ib + 1]) > 0.1) continue;
      let dev = 0;
      for (let i = ia + 1; i < ib; i++) dev = Math.max(dev, distToPolyline(pts[2 * i], pts[2 * i + 1], path));
      // a hop with no vertex in between: check its midpoint
      if (ib === ia + 1) dev = distToPolyline((pts[2 * ia] + pts[2 * ib]) / 2, (pts[2 * ia + 1] + pts[2 * ib + 1]) / 2, path);
      if (dev < HOP_DEV) continue;
      if (!plans.has(sid)) plans.set(sid, new Map());
      plans.get(sid).set(ia + ',' + ib, path.slice(2, -2));
    }
  }
  const onShape = new Map();
  for (const p of patterns) { if (!onShape.has(p[1])) onShape.set(p[1], []); onShape.get(p[1]).push(p); }
  for (const [sid, plan] of plans) {
    const pts = shapes.get(sid);
    let floor = Infinity; // hops are applied from the end of the shape back; skip any overlap
    const hops = [...plan].map(([k, inner]) => [...k.split(',').map(Number), inner]).sort((x, y) => y[0] - x[0]);
    for (const [ia, ib, inner] of hops) {
      if (ib > floor) continue;
      floor = ia;
      const delta = inner.length / 2 - (ib - ia - 1);
      pts.splice(2 * ia + 2, 2 * (ib - ia - 1), ...inner);
      for (const p of onShape.get(sid)) for (let k = 0; k < p[3].length; k++) if (p[3][k] >= ib) p[3][k] += delta;
    }
  }

  // a line ends at its terminal's station symbol (the Q's shape stops ~140 m short of 96 St)
  for (const [, sid, stops, idx] of patterns) {
    const pts = shapes.get(sid), n = pts ? pts.length / 2 : 0;
    if (n < 2) continue;
    for (const [k, v] of [[0, 0], [stops.length - 1, n - 1]]) {
      const st = stations.get(stops[k]);
      if (!st || idx[k] !== v) continue;
      const d = Math.hypot(st.x - pts[2 * v], st.z - pts[2 * v + 1]);
      if (d > 0.005 && d < TERMINAL_PIN) { pts[2 * v] = st.x; pts[2 * v + 1] = st.z; }
    }
  }

  // where the MTA map runs a line beside another trunk that its GTFS track crosses or runs on
  // top of: that stretch is moved onto the other line's track, and the slots set them side by side
  for (const { routes: rs, onto, near, within, full } of SHARED_TRACK) {
    const [a, b = a] = near.map((id) => stations.get(id));
    if (!a || !b) continue;
    const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
    const inZone = (x, z) => { const u = l2 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / l2)) : 0; return Math.hypot(x - a.x - dx * u, z - a.z - dz * u) < within; };
    const targets = [...new Set(patterns.filter((p) => onto.includes(p[0])).map((p) => p[1]))].map((id) => shapes.get(id)).filter(Boolean);
    for (const sid of new Set(patterns.filter((p) => rs.includes(p[0])).map((p) => p[1]))) {
      const pts = shapes.get(sid), n = pts.length / 2, zone = [];
      for (let i = 0; i < n; i++) if (inZone(pts[2 * i], pts[2 * i + 1])) zone.push(i);
      if (!zone.length) continue;
      // the other line's shape that runs closest along this stretch
      let target = null, bs = 0;
      for (const t of targets) {
        const close = zone.filter((i) => distToPolyline(pts[2 * i], pts[2 * i + 1], t) < full).length;
        if (close > bs) { bs = close; target = t; }
      }
      if (!target) continue;
      // vertices within `full` go onto it; a little further out they are drawn part of the way
      // there (so the line eases onto the other), further still they stay
      const runs = [];
      for (const i of zone) {
        const d = distToPolyline(pts[2 * i], pts[2 * i + 1], target);
        if (d < full) {
          if (runs.length && runs.at(-1)[1] === i - 1) runs.at(-1)[1] = i; else runs.push([i, i]);
        } else if (d < SHARED_GAP) {
          const w = (SHARED_GAP - d) / (SHARED_GAP - full), k = w * w * (3 - 2 * w);
          const q = nearestOn(pts[2 * i], pts[2 * i + 1], target);
          pts[2 * i] += (q[0] - pts[2 * i]) * k; pts[2 * i + 1] += (q[1] - pts[2 * i + 1]) * k;
        }
      }
      const pats = patterns.filter((p) => p[1] === sid);
      for (const [i0, i1] of runs.reverse()) snapOnto(pts, i0, i1, target, pats);
    }
  }
}
// Where the GTFS track of one line crosses or runs on top of another's but the MTA map draws them
// side by side. `near`: one station, or two (the stretch between them); `within` km of it.
const SHARED_TRACK = [
  // the 1 into South Ferry: its shape runs straight from Rector St across the 4/5 and ends on top
  // of them; on the MTA map it reaches South Ferry beside the 4/5, without crossing them
  { routes: ['1'], onto: ['4', '5'], near: ['142'], within: 0.6, full: 0.1 },
  // the N/W between Queensboro Plaza and 39 Av run along the E/F/M/R a few metres off its track,
  // half covering it; on its track, their slot (main.js) sets them just west of it
  { routes: ['N', 'W'], onto: ['E'], near: ['G21', 'R08'], within: 0.25, full: 0.03 },
];
const SHARED_GAP = 0.1; // km: beyond this from the other line, a stretch stays where it is
function nearestOn(x, z, p) {
  let best = null, bd = Infinity;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i], az = p[i + 1], dx = p[i + 2] - ax, dz = p[i + 3] - az, l2 = dx * dx + dz * dz;
    const t = l2 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
    const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
    if (d < bd) { bd = d; best = [ax + dx * t, az + dz * t]; }
  }
  return best;
}
/** Move vertices i0..i1 of a shape onto a target polyline (adding the target's vertices in
 *  between, so the stretch follows its curves), and update the stop indices of `pats`. */
function snapOnto(pts, i0, i1, target, pats) {
  const tn = target.length / 2, cum = [0];
  for (let i = 1; i < tn; i++) cum.push(cum[i - 1] + Math.hypot(target[2 * i] - target[2 * i - 2], target[2 * i + 1] - target[2 * i - 1]));
  const proj = (x, z) => {
    let best = null;
    for (let i = 0; i + 1 < tn; i++) {
      const ax = target[2 * i], az = target[2 * i + 1], dx = target[2 * i + 2] - ax, dz = target[2 * i + 3] - az, l2 = dx * dx + dz * dz;
      const t = l2 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
      const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(px - x, pz - z);
      if (!best || d < best.d) best = { x: px, z: pz, d, s: cum[i] + t * Math.sqrt(l2) };
    }
    return best;
  };
  const ps = [];
  for (let i = i0; i <= i1; i++) ps.push(proj(pts[2 * i], pts[2 * i + 1]));
  const up = ps.at(-1).s >= ps[0].s;
  for (let k = 1; k < ps.length; k++) if ((ps[k].s >= ps[k - 1].s) !== up && ps[k].s !== ps[k - 1].s) return; // doubles back: leave it
  const out = [], at = [];
  ps.forEach((p, k) => {
    at.push(out.length / 2);
    out.push(p.x, p.z);
    const q = ps[k + 1];
    if (!q) return;
    for (let j = up ? 0 : tn - 1; up ? j < tn : j >= 0; j += up ? 1 : -1) {
      if (up ? cum[j] > p.s && cum[j] < q.s : cum[j] < p.s && cum[j] > q.s) out.push(target[2 * j], target[2 * j + 1]);
    }
  });
  const delta = out.length / 2 - (i1 - i0 + 1);
  pts.splice(2 * i0, 2 * (i1 - i0 + 1), ...out);
  for (const p of pats) for (let k = 0; k < p[3].length; k++) {
    const v = p[3][k];
    if (v > i1) p[3][k] = v + delta;
    else if (v >= i0) p[3][k] = i0 + at[v - i0];
  }
}

export async function loadNetwork() {
  const [net, ground] = await Promise.all([
    fetch(import.meta.env.BASE_URL + 'data/subway.json').then((r) => r.json()),
    fetch(import.meta.env.BASE_URL + 'data/ground.json').then((r) => r.json()),
  ]);

  const stations = new Map();
  for (const [id, [name, x, z, routes, complex, nightRoutes, ada, adaNorth, adaSouth, adaNotes]] of Object.entries(net.stations)) {
    // stations with no routes (e.g. Staten Island Railway, not part of this map) are dropped
    if (routes.length) stations.set(id, { id, name, ...((([x2, z2]) => ({ x: x2, z: z2 }))(distort(x, z))), routes, complex, nightRoutes: nightRoutes || [], ada: ada || 0, adaNorth: adaNorth || 0, adaSouth: adaSouth || 0, adaNotes: adaNotes || '' });
  }
  // station complexes: one "station" on the map, possibly several GTFS parent stations
  const complexes = new Map();
  for (const st of stations.values()) {
    if (!complexes.has(st.complex)) complexes.set(st.complex, { id: st.complex, members: [] });
    complexes.get(st.complex).members.push(st);
  }
  for (const c of complexes.values()) {
    const names = new Map();
    for (const m of c.members) names.set(m.name, (names.get(m.name) || 0) + 1);
    // the name most members share; when none leads (Bleecker St + Broadway-Lafayette St), all of
    // them, busiest platform first, so the complex isn't named after just one of its stations
    const ranked = [...names].sort((a, b) => b[1] - a[1]);
    if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) {
      const routesOf = (name) => Math.max(...c.members.filter((m) => m.name === name).map((m) => m.routes.length));
      c.name = ranked.map(([n]) => n).sort((a, b) => routesOf(b) - routesOf(a)).join(' / ');
    } else c.name = ranked[0][0];
    c.ids = new Set(c.members.map((m) => m.id));
    c.routes = [...new Set(c.members.flatMap((m) => m.routes))].sort((a, b) => (net.routes[a]?.sort ?? 99) - (net.routes[b]?.sort ?? 99));
    c.nightRoutes = c.routes.filter((r) => c.members.some((m) => m.nightRoutes.includes(r)));
    // accessibility of the complex: 1 = every part fully accessible, 0 = none, 2 = partly
    c.ada = c.members.every((m) => m.ada === 1) ? 1 : c.members.every((m) => m.ada === 0) ? 0 : 2;
    c.x = c.members.reduce((t, m) => t + m.x, 0) / c.members.length;
    c.z = c.members.reduce((t, m) => t + m.z, 0) / c.members.length;
  }

  // schematic shapes, made to draw as the map does (one line per trunk, lines reaching their
  // terminals); this may splice vertices, so it updates the patterns' stop indices to match
  const bentShapes = new Map(Object.entries(net.shapes).map(([id, raw]) => [id, Array.from(distortFlat(raw))]));
  mapShapes(bentShapes, net.patterns, stations, net.routes);

  // cumulative arc length per shape, for interpolation
  const shapes = new Map();
  const rawCount = new Map(); // shape id -> vertex count before rounding (for stop indices)
  for (const [id, arr] of bentShapes) {
    const bent = Float32Array.from(arr);
    rawCount.set(id, bent.length / 2);
    flattenFolds(bent);
    const flat = roundCorners(bent);
    const n = flat.length / 2;
    const cum = new Float32Array(n);
    for (let i = 1; i < n; i++) {
      const dx = flat[2 * i] - flat[2 * i - 2], dz = flat[2 * i + 1] - flat[2 * i - 1];
      cum[i] = cum[i - 1] + Math.hypot(dx, dz);
    }
    shapes.set(id, { pts: flat, cum });
  }

  for (const key of ['land', 'parks', 'airports']) ground[key] = ground[key].map((poly) => poly.map(distortFlat));
  for (const l of ground.labels) l.pos = distort(l.pos[0], l.pos[1]);

  const patterns = net.patterns.map(([route, shape, stops, idx, dt, count, night]) => {
    const pos = new Map();
    stops.forEach((s, i) => { if (!pos.has(s)) pos.set(s, i); });
    const n = rawCount.get(shape) ?? 0;
    return { route, shape, stops, idx: n >= 3 ? idx.map((i) => roundedIndex(i, n)) : idx, dt, count, night: night || 0, pos };
  });
  const byRoute = new Map();
  for (const p of patterns) {
    if (!byRoute.has(p.route)) byRoute.set(p.route, []);
    byRoute.get(p.route).push(p);
  }

  return {
    origin: net.origin, routes: net.routes, lines: net.lines, nightLines: net.nightLines || {},
    elevators: net.elevators || {}, meta: net.meta || {},
    stations, complexes, shapes, patterns, byRoute, ground,
  };
}

const FAMILY = { '6X': '6', '7X': '7', FX: 'F' };

// How well a static stopping pattern explains a live trip: the stop it is heading for must be
// on the pattern; then count upcoming stops found in order after it, and (v2 feeds) the last
// few stops already made found in order before it.
function score(p, past, future) {
  const j = p.pos.get(future[0]);
  if (j === undefined) return -1;
  let s = 1, i = j;
  for (let n = 1; n < future.length && n < 10; n++) {
    const q = p.stops.indexOf(future[n], i + 1);
    if (q < 0) break;
    s++; i = q;
  }
  i = j;
  for (let n = past.length - 1; n >= 0 && n >= past.length - 4 && i > 0; n--) {
    const q = p.stops.lastIndexOf(past[n], i - 1);
    if (q < 0) break;
    s++; i = q;
  }
  return s;
}

/** Choose the static stopping pattern that best explains a live trip's stops. */
export function matchPattern(net, trip) {
  const future = trip.stus.map((s) => s.parent);
  const past = (trip.past || []).map((s) => s.parent);
  const pick = (cands) => {
    let best = null, bs = 0;
    for (const p of cands) {
      const s = score(p, past, future);
      // prefer more matched stops, then patterns where the next stop has a predecessor, then popularity
      const k = s * 1e7 + (p.pos.get(future[0]) > 0 ? 1e6 : 0) + p.count;
      if (s > 0 && k > bs) { bs = k; best = p; }
    }
    return best;
  };
  const fam = [...(net.byRoute.get(trip.route) || []), ...(net.byRoute.get(FAMILY[trip.route]) || [])];
  return pick(fam) || pick(net.patterns); // fall back to any line (reroutes)
}

/** Point at fractional arc length between two shape vertex indices. Returns [x, z, heading]. */
export function alongShape(shape, a, b, frac) {
  const { pts, cum } = shape;
  if (a === b) {
    const j = Math.min(a + 1, cum.length - 1), i = j - 1;
    return [pts[2 * a], pts[2 * a + 1], Math.atan2(pts[2 * j + 1] - pts[2 * i + 1], pts[2 * j] - pts[2 * i])];
  }
  const target = cum[a] + frac * (cum[b] - cum[a]);
  let i = a;
  while (i < b - 1 && cum[i + 1] < target) i++;
  const seg = cum[i + 1] - cum[i] || 1;
  const t = Math.min(1, Math.max(0, (target - cum[i]) / seg));
  const x0 = pts[2 * i], z0 = pts[2 * i + 1], x1 = pts[2 * i + 2], z1 = pts[2 * i + 3];
  return [x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, Math.atan2(z1 - z0, x1 - x0)];
}

/** +1 for northbound shapes ("A..N55R"), -1 for southbound, so a lateral offset lands on the
 *  same side of the track whichever direction's shape is used. */
export const shapeSign = (id) => (/\.\.S/.test(id) ? -1 : 1);

/** Offset a flat [x,z,...] polyline sideways by `off` km (positive = left of travel). */
export function offsetFlat(flat, off) {
  const n = flat.length / 2, out = new Array(flat.length);
  for (let i = 0; i < n; i++) {
    let nx = 0, nz = 0;
    if (i > 0) { const dx = flat[2 * i] - flat[2 * i - 2], dz = flat[2 * i + 1] - flat[2 * i - 1], l = Math.hypot(dx, dz) || 1; nx -= dz / l; nz += dx / l; }
    if (i < n - 1) { const dx = flat[2 * i + 2] - flat[2 * i], dz = flat[2 * i + 3] - flat[2 * i + 1], l = Math.hypot(dx, dz) || 1; nx -= dz / l; nz += dx / l; }
    const l = Math.hypot(nx, nz) || 1;
    out[2 * i] = flat[2 * i] + (nx / l) * off;
    out[2 * i + 1] = flat[2 * i + 1] + (nz / l) * off;
  }
  return out;
}

/** Point at arc length `s` (km) along a shape. Returns [x, z, heading]. */
export function pointAt(shape, s) {
  const { pts, cum } = shape;
  const n = cum.length;
  s = Math.min(cum[n - 1], Math.max(0, s));
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
  const t = (s - cum[lo]) / (cum[hi] - cum[lo] || 1);
  const x0 = pts[2 * lo], z0 = pts[2 * lo + 1], x1 = pts[2 * hi], z1 = pts[2 * hi + 1];
  return [x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, Math.atan2(z1 - z0, x1 - x0)];
}

/**
 * Estimated position of a live trip at time `now` (unix seconds).
 * For matched trips it also returns arc-length targets on the shape so the renderer can
 * drive the train smoothly: `sEst` (best guess right now) and `sNext` (next station, to be
 * reached at time `arr`).
 * NYCT feeds carry no coordinates, so we interpolate between the last station the train made
 * and the next one: from its actual departure time (v2 feeds) to the predicted arrival, or
 * with the scheduled running time when the departure is unknown.
 */
export function placeTrip(net, trip, now) {
  const next = trip.stus[0];
  if (!trip.pattern) trip.pattern = matchPattern(net, trip);
  const p = trip.pattern;
  if (!p || !p.pos.has(next.parent)) {
    const st = net.stations.get(next.parent);
    return st ? { x: st.x, z: st.z, h: 0, state: 'unmatched', from: null, to: next.parent } : null;
  }
  const j = p.pos.get(next.parent);
  const shape = net.shapes.get(p.shape);
  const prev = trip.past?.at(-1); // last stop actually made (v2 feeds), with its real departure time
  const stoppedHere = trip.vehicle?.status === 'STOPPED_AT' && trip.vehicle.parent === next.parent;
  const sNext = shape.cum[p.idx[j]];
  if (j === 0 || stoppedHere) {
    const [x, z, h] = alongShape(shape, p.idx[j], p.idx[j], 0);
    return { x, z, h, state: j === 0 && !stoppedHere && !prev ? 'origin' : 'stopped', from: null, to: next.parent, shape, sEst: sNext, sNext, arr: now };
  }
  // the segment runs from the stop the train last made (if it is on this pattern) to the next one
  let jp = j - 1;
  if (prev) { const q = p.stops.lastIndexOf(prev.parent, j - 1); if (q >= 0) jp = q; }
  const left = prev && p.stops[jp] === prev.parent ? prev.dep : 0;
  let frac;
  if (left && next.arr > left) {
    frac = (now - left) / (next.arr - left); // real departure -> predicted arrival
  } else {
    let run = 0;
    for (let i = jp; i < j; i++) run += p.dt[i];
    frac = 1 - (next.arr - now) / Math.max(30, run); // scheduled running time
  }
  frac = Math.min(1, Math.max(0, frac));
  const [x, z, h] = alongShape(shape, p.idx[jp], p.idx[j], frac);
  const sPrev = shape.cum[p.idx[jp]];
  return { x, z, h, state: 'moving', from: p.stops[jp], to: next.parent, frac, shape, sEst: sPrev + frac * (sNext - sPrev), sPrev, sNext, arr: next.arr };
}
