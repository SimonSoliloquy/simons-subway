// Rerouted trains stay on the drawn track. Run: npm test (also before every build).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadNetwork, matchPattern, placeTrip } from '../src/network.js';

const pub = new URL('../public/', import.meta.url);
globalThis.fetch = async (url) => ({ json: async () => JSON.parse(readFileSync(new URL(url.replace(/^\//, ''), pub), 'utf8')) });
const net = await loadNetwork();

// every drawn centreline (day and late-night maps), each from its first stop to its last, as on the map
const range = new Map();
for (const p of net.patterns) {
  const r = range.get(p.shape) || [Infinity, -Infinity];
  r[0] = Math.min(r[0], p.idx[0]); r[1] = Math.max(r[1], p.idx.at(-1));
  range.set(p.shape, r);
}
const drawn = [];
for (const sid of new Set([...Object.values(net.lines).flat(), ...Object.values(net.nightLines).flat()])) {
  const { pts } = net.shapes.get(sid), [a, b] = range.get(sid);
  for (let i = a; i < b; i++) drawn.push([pts[2 * i], pts[2 * i + 1], pts[2 * i + 2], pts[2 * i + 3]]);
}
const CELL = 0.3; // km: offTrack sees lines up to one cell away, enough for the limits below
const cellKey = (x, z) => Math.floor(x / CELL) + ',' + Math.floor(z / CELL);
const grid = new Map();
for (const s of drawn) {
  const n = Math.ceil(Math.hypot(s[2] - s[0], s[3] - s[1]) / (CELL / 2)) + 1;
  for (let j = 0; j <= n; j++) {
    const k = cellKey(s[0] + ((s[2] - s[0]) * j) / n, s[1] + ((s[3] - s[1]) * j) / n);
    if (!grid.has(k)) grid.set(k, new Set());
    grid.get(k).add(s);
  }
}
/** Distance (map km) from a point to the nearest drawn centreline (Infinity beyond about CELL). */
function offTrack(x, z) {
  let best = Infinity;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    for (const [ax, az, bx, bz] of grid.get(cellKey(x + dx * CELL, z + dz * CELL)) || []) {
      const ux = bx - ax, uz = bz - az, L = ux * ux + uz * uz;
      const t = L ? Math.max(0, Math.min(1, ((x - ax) * ux + (z - az) * uz) / L)) : 0;
      best = Math.min(best, Math.hypot(x - ax - t * ux, z - az - t * uz));
    }
  }
  return best;
}
/** Worst distance from the drawn lines along a pattern's run (sampled every 100 m). */
function worstOffTrack(p) {
  const { pts, cum } = net.shapes.get(p.shape);
  let worst = 0;
  for (let i = p.idx[0]; i < p.idx.at(-1); i++) {
    const n = Math.max(1, Math.ceil((cum[i + 1] - cum[i]) / 0.1));
    for (let j = 0; j < n; j++) {
      const t = j / n;
      worst = Math.max(worst, offTrack(pts[2 * i] + (pts[2 * i + 2] - pts[2 * i]) * t, pts[2 * i + 1] + (pts[2 * i + 3] - pts[2 * i + 1]) * t));
    }
  }
  return worst;
}

const stu = (parent, t) => ({ parent, stop: parent + 'N', arr: t, dep: t, seq: -1 });
/** A live trip as realtime.js builds it: stops made so far in `past`, the rest in `stus`. */
function trip(id, route, stops, at, now = 1e9) {
  const all = stops.map((s, i) => stu(s, now + (i - at) * 120));
  return { id, route, past: all.slice(0, at), stus: all.slice(at), vehicle: null };
}

test('every static pattern, detours (~ shapes) included, runs on drawn track', () => {
  const bad = [];
  for (const p of net.patterns) {
    const w = worstOffTrack(p);
    if (w > 0.25) bad.push(`${p.shape} ${w.toFixed(2)} km`);
  }
  assert.deepEqual(bad, []);
});

// Nov 16 2026, late night: A trains ran via the F line from Jay St to W 4 St, a reroute in no static pattern
const A_VIA_F = 'H11 H10 H09 H08 H07 H06 H04 H03 H02 H01 A61 A60 A59 A57 A55 A54 A53 A52 A51 A50 A49 A48 A47 A46 A45 A44 A43 A42 A41 F18 F16 F15 F14 D21 A32 A31 A30 A28 A27 A25 A24 A15 A14 A12 A11 A10 A09 A07 A06 A05 A03 A02'.split(' ');

test('a reroute no static pattern knows gets its own pattern, on drawn track', () => {
  const t = trip('004200_A..N', 'A', A_VIA_F, A_VIA_F.indexOf('A32'));
  const p = matchPattern(net, t);
  assert.ok(p.live, `matched ${p.shape}, a static pattern that does not cover the trip`);
  assert.deepEqual(p.stops, A_VIA_F);
  assert.ok(worstOffTrack(p) < 0.05, `live shape leaves the drawn lines by ${worstOffTrack(p).toFixed(2)} km`);
  // the same trip a minute later reuses the same shape, so the train does not snap
  assert.equal(matchPattern(net, trip('004200_A..N', 'A', A_VIA_F, A_VIA_F.indexOf('A32'))).shape, p.shape);
});

test('between Broadway-Lafayette St and W 4 St the train is on the 6 Av line, not back on 8 Av', () => {
  const now = 1e9, at = A_VIA_F.indexOf('A32');
  const t = trip('004200_A..N', 'A', A_VIA_F, at, now);
  t.past.at(-1).dep = now - 60; t.stus[0].arr = now + 60; // halfway
  const pos = placeTrip(net, t, now);
  assert.equal(pos.from, 'D21');
  assert.equal(pos.to, 'A32');
  assert.ok(offTrack(pos.x, pos.z) < 0.05);
  // on the 6 Av line's track from Broadway-Lafayette St to W 4 St (before: on 8 Av, from Spring St)
  const six = net.patterns.find((q) => { const i = q.stops.indexOf('D21'); return i >= 0 && q.stops[i + 1] === 'D20'; });
  const { pts } = net.shapes.get(six.shape), i0 = six.idx[six.stops.indexOf('D21')], i1 = six.idx[six.stops.indexOf('D20')];
  let near = Infinity;
  for (let i = i0; i <= i1; i++) near = Math.min(near, Math.hypot(pts[2 * i] - pos.x, pts[2 * i + 1] - pos.z));
  assert.ok(near < 0.1, `train is ${near.toFixed(2)} km from the 6 Av track`);
  const hop = net.shapes.get(t.pattern.shape), k = t.pattern.stops.indexOf('D21');
  const arc = hop.cum[t.pattern.idx[k + 1]] - hop.cum[t.pattern.idx[k]];
  const [ax, az] = net.stationXY.get('D21'), [bx, bz] = net.stationXY.get('A32');
  assert.ok(arc > 1.1 * Math.hypot(bx - ax, bz - az), 'the hop is a straight chord');
});

test('a trip that runs as scheduled keeps its static pattern', () => {
  const p = net.patterns.filter((q) => q.route === 'A' && !q.shape.includes('~')).sort((a, b) => b.count - a.count)[0];
  const t = trip('000000_A..N', 'A', p.stops, 5);
  const m = matchPattern(net, t);
  assert.ok(!m.live);
  assert.ok(m.stops.join() === p.stops.join() || m.count >= p.count);
});
