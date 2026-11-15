// Static network model built from public/data/subway.json, plus the logic that places
// a live GTFS-realtime trip on the track geometry.

export async function loadNetwork() {
  const [net, ground] = await Promise.all([
    fetch(import.meta.env.BASE_URL + 'data/subway.json').then((r) => r.json()),
    fetch(import.meta.env.BASE_URL + 'data/ground.json').then((r) => r.json()),
  ]);

  const stations = new Map();
  for (const [id, [name, x, z, routes, complex]] of Object.entries(net.stations)) {
    if (routes.length) stations.set(id, { id, name, x, z, routes, complex });
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
    c.name = [...names].sort((a, b) => b[1] - a[1])[0][0];
    c.ids = new Set(c.members.map((m) => m.id));
    c.routes = [...new Set(c.members.flatMap((m) => m.routes))].sort((a, b) => (net.routes[a]?.sort ?? 99) - (net.routes[b]?.sort ?? 99));
    c.x = c.members.reduce((t, m) => t + m.x, 0) / c.members.length;
    c.z = c.members.reduce((t, m) => t + m.z, 0) / c.members.length;
  }

  // cumulative arc length per shape, for interpolation
  const shapes = new Map();
  for (const [id, flat] of Object.entries(net.shapes)) {
    const n = flat.length / 2;
    const cum = new Float32Array(n);
    for (let i = 1; i < n; i++) {
      const dx = flat[2 * i] - flat[2 * i - 2], dz = flat[2 * i + 1] - flat[2 * i - 1];
      cum[i] = cum[i - 1] + Math.hypot(dx, dz);
    }
    shapes.set(id, { pts: flat, cum });
  }

  const patterns = net.patterns.map(([route, shape, stops, idx, dt, count]) => {
    const pos = new Map();
    stops.forEach((s, i) => { if (!pos.has(s)) pos.set(s, i); });
    return { route, shape, stops, idx, dt, count, pos };
  });
  const byRoute = new Map();
  for (const p of patterns) {
    if (!byRoute.has(p.route)) byRoute.set(p.route, []);
    byRoute.get(p.route).push(p);
  }

  return { origin: net.origin, routes: net.routes, lines: net.lines, stations, complexes, shapes, patterns, byRoute, ground };
}

const FAMILY = { '6X': '6', '7X': '7', FX: 'F', SS: 'SI' };

function score(p, parents) {
  let i = p.pos.get(parents[0]);
  if (i === undefined) return -1;
  let s = 1;
  for (let n = 1; n < parents.length && n < 8; n++) {
    const q = p.stops.indexOf(parents[n], i + 1);
    if (q < 0) break;
    s++; i = q;
  }
  return s;
}

/** Choose the static stopping pattern that best explains a live trip's remaining stops. */
export function matchPattern(net, trip) {
  const parents = trip.stus.map((s) => s.parent);
  const pick = (cands) => {
    let best = null, bs = 0;
    for (const p of cands) {
      const s = score(p, parents);
      // prefer more matched stops, then patterns where the next stop has a predecessor, then popularity
      const k = s * 1e7 + (p.pos.get(parents[0]) > 0 ? 1e6 : 0) + p.count;
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
 * NYCT feeds carry no coordinates, so we interpolate between the previous station and the
 * next one (the first stop_time_update), using the predicted arrival time and the scheduled
 * running time of that segment.
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
  const stoppedHere = trip.vehicle?.status === 'STOPPED_AT' && trip.vehicle.parent === next.parent;
  const sNext = shape.cum[p.idx[j]];
  if (j === 0 || stoppedHere) {
    const [x, z, h] = alongShape(shape, p.idx[j], p.idx[j], 0);
    return { x, z, h, state: j === 0 && !stoppedHere ? 'origin' : 'stopped', from: null, to: next.parent, shape, sEst: sNext, sNext, arr: now };
  }
  const run = Math.max(30, p.dt[j - 1]);
  const remaining = next.arr - now;
  const frac = Math.min(1, Math.max(0, 1 - remaining / run));
  const [x, z, h] = alongShape(shape, p.idx[j - 1], p.idx[j], frac);
  const sPrev = shape.cum[p.idx[j - 1]];
  return { x, z, h, state: 'moving', from: p.stops[j - 1], to: next.parent, frac, shape, sEst: sPrev + frac * (sNext - sPrev), sPrev, sNext, arr: next.arr };
}
