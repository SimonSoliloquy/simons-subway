import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { loadNetwork, placeTrip, pointAt, offsetFlat, shapeSign, mapScale, MAX_MAG } from './network.js';
import { TrainRenderer, consistOf } from './trains.js';
import { initProtos, fetchTrips, fetchAlerts, fetchOutages, routeStatus, TRIP_FEEDS } from './realtime.js';

const TRIP_REFRESH_MS = 15_000;
const ALERT_REFRESH_MS = 30_000;
const OUTAGE_REFRESH_MS = 120_000;
const STALE_S = 60;        // MTA terms: older data must be flagged as possibly not real time
const KEEP_FAILED_FEED_S = 300; // a failed feed's last trains stay this long (flagged as not real time)
const BASE_Y = 0.1;        // km above ground of the lowest route layer
const TUBE_R = 0.016;      // km
const LANE_W = 0.1;        // map km between parallel services on a shared trunk
// Every service is its own line, side by side where services share a trunk (as on the MTA map).
const LANE_GROUPS = [['1', '2', '3'], ['4', '5', '6', '6X'], ['7', '7X'], ['A', 'C', 'E'], ['B', 'D', 'F', 'FX', 'M'], ['N', 'Q', 'R', 'W'], ['J', 'Z']];
const lane = new Map();    // route -> {slot, off}
for (const g of LANE_GROUPS) g.forEach((r, i) => lane.set(r, { slot: i, off: (i - (g.length - 1) / 2) * LANE_W }));
const laneOf = (r) => lane.get(r) || { slot: 0, off: 0 };
// Palette sampled from the MTA subway maps (mta.info/map/5341 and the late-night map, 2026).
// Everything that carries one of these colours is drawn unlit so it renders at exactly that value.
const C = { ink: 0x000000, grey: 0x939597, white: 0xffffff, adaBlue: 0x155e9b, warn: 0xf3d255 };
const PALETTE = {
  day: { water: 0xc8d6ed, land: 0xf9f0e3, park: 0xeaf1cf, airport: 0xe5dbc2 },
  night: { water: 0x8196ad, land: 0xdce3e7, park: 0xc7d6cc, airport: 0xc7b291 },
};
// Flat route colours as rendered from the MTA geographic map PDFs (April 2026, standard and late night).
const MAP_COLORS = {
  '#2d69b1': ['A', 'C', 'E'],
  '#e6883c': ['B', 'D', 'F', 'FX', 'M'],
  '#8cc056': ['G'],
  '#a67639': ['J', 'Z'],
  '#939597': ['L'],
  '#6d6e71': ['GS', 'FS', 'H'],
  '#f8d64f': ['N', 'Q', 'R', 'W'],
  '#dc4d4a': ['1', '2', '3'],
  '#459b5e': ['4', '5', '6', '6X'],
  '#914392': ['7', '7X'],
};
// service status box rows, one per trunk line (MTA service status box guidance)
const TRUNKS = [['1', '2', '3'], ['4', '5', '6'], ['7'], ['A', 'C', 'E'], ['B', 'D', 'F', 'M'], ['G'], ['J', 'Z'], ['L'], ['N', 'Q', 'R', 'W'], ['GS', 'FS', 'H']];
const VMAX = 0.025 * MAX_MAG; // map km/s: ≈ 90 km/h where the schematic map is most enlarged
// The MTA geographic map is drawn with Manhattan's avenues vertical: screen-up on the ground is
// ~29° east of true north. Ground axes: +x east, +z south.
const MAP_ROT = THREE.MathUtils.degToRad(29);
const MAP_UP = { x: Math.sin(MAP_ROT), z: -Math.cos(MAP_ROT) };
const MAP_RIGHT = { x: Math.cos(MAP_ROT), z: Math.sin(MAP_ROT) };
const REVEAL_STEP = 0.12;  // s between routes when the first live trains appear

const $ = (s) => document.querySelector(s);
const nyHour = +new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date());
const state = {
  spacing: +$('#spacing').value,
  focusRoute: null,
  selected: null,          // {kind:'train', id} | {kind:'station', id}
  follow: false,
  showTrains: true, showLabels: true, showWaiting: false,
  night: nyHour < 6,       // late-night map, about midnight to 6 AM New York time
  ada: false,              // accessible-stations map
  timeScale: 1,
  zoomK: 0, wpp: 0,        // wpp: km per screen pixel at the orbit target
  trips: new Map(),
  alerts: [],
  status: new Map(),       // route -> {type, rank, planned, count}
  outages: null,           // {current, upcoming} from fetchOutages
  feedTime: 0, feedTimes: {}, oldest: 0, newest: 0, moving: 0, feedErrors: [],
  revealClock: -1,         // seconds since the first live data arrived (-1: not yet)
};

// ---------- renderer / scene ----------
const canvas = $('#scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.NoToneMapping;

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.day.water);
scene.fog = new THREE.Fog(PALETTE.day.water, 45, 120);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture; // reflections on the stainless cars

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.05, 400);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 0.04;
controls.maxDistance = 120;
controls.screenSpacePanning = false;
// map-style controls: drag (one finger) moves the map, right-drag (two fingers) turns and tilts
// the view, scroll or pinch zooms
controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
// Rotation settles quickly so it stops where it is let go; panning keeps its soft glide.
const ROTATING = new Set([0, 3, 6]); // OrbitControls states: ROTATE, TOUCH_ROTATE, TOUCH_DOLLY_ROTATE
function tuneDamping() {
  if (controls.state !== -1) controls.dampingFactor = ROTATING.has(controls.state) ? 0.3 : 0.05;
}

// lighting kept near 1.0 on top faces so route colours render at their true values
scene.add(new THREE.HemisphereLight(0xffffff, 0xcfc6b0, 0.75));
const sun = new THREE.DirectionalLight(0xffffff, 0.4);
sun.position.set(-20, 40, 15);
scene.add(sun);

// True while the camera still shows the opening overview (nothing touched yet), so a resize,
// e.g. a tab that gets its real size only after load, re-frames the map instead of leaving
// the view computed for the old size.
let atHome = false;
addEventListener('resize', () => {
  if (!innerWidth || !innerHeight) return;
  camera.aspect = innerWidth / innerHeight;
  if (viewShift) camera.setViewOffset(innerWidth, innerHeight, 0, viewShift, innerWidth, innerHeight);
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  if (atHome && stationList) {
    computeHome();
    flight = null;
    controls.target.copy(HOME.target);
    camera.position.copy(HOME.pos);
  }
});

const menuEl = $('#left'), serviceEl = $('#service');
// ---------- helpers ----------
let net;
let nightSet = new Set();          // routes with late-night service
const routeColor = new Map();
// Trunks get a polygon offset so fat lines of different colours that overlap at city scale don't z-fight.
const trunkIndex = new Map();
Object.values(MAP_COLORS).forEach((ids, i) => ids.forEach((r) => trunkIndex.set(r, i)));
const heightOf = (route) => BASE_Y + laneOf(route).slot * state.spacing;
// As on the MTA map, each trunk is one line in its colour (the 4, 5 and 6 share one green line).
// Where trunks share a corridor (E/F/R on Queens Blvd, B/Q on Brighton, F/G on Culver, 2/5 and
// 3/4) they run side by side: each trunk has a fixed slot, offset by whole line widths.
const TRUNK_SLOT = new Map();
for (const [ids, slot] of [[['A', 'C', 'E'], -1], [['B', 'D', 'F', 'FX', 'M'], 0], [['N', 'Q', 'R', 'W'], 1], [['G'], 1], [['J', 'Z'], -1],
  [['L'], 0], [['GS', 'FS', 'H'], 0], [['1', '2', '3'], -0.5], [['4', '5', '6', '6X'], 0.5], [['7', '7X'], 0]]) ids.forEach((r) => TRUNK_SLOT.set(r, slot));
const slotOf = (route) => TRUNK_SLOT.get(route) ?? 0;
const trunkOf = (route) => trunkIndex.get(route) ?? route;
const SLOT_W = 1.96; // slot spacing in line radii (lines just touch)
/** Sideways offset (km, positive = right of travel along `sid`) of a route's trunk line. */
const slotOffset = (route, sid) => slotOf(route) * shapeSign(sid) * SLOT_W * tubeRadius.value;

// ---------- over and under crossings ----------
// Where two trunk lines cross, one passes over the other, as drawn on the MTA map (read off
// Weekday_2026-04-03). The map has no single stacking order, so there is a default order
// (bottom to top) plus the places where the map does it differently.
const CROSS_ORDER = [['L'], ['G'], ['1', '2', '3'], ['N', 'Q', 'R', 'W'], ['4', '5', '6', '6X'], ['J', 'Z'], ['A', 'C', 'E'], ['B', 'D', 'F', 'FX', 'M'], ['GS', 'FS', 'H'], ['7', '7X']];
const trunkRank = new Map(); // trunk key -> rank
CROSS_ORDER.forEach((ids, i) => ids.forEach((r) => trunkRank.set(trunkOf(r), i)));
const CROSS_OVERRIDES = [
  { near: 'Cortlandt St', within: 1.2, over: 'R', under: 'A' },        // Broadway line over 8 Av
  { near: 'Prince St', within: 1.2, over: 'R', under: 'D' },           // Broadway line over Houston St
  { near: '42 St-Bryant Pk', within: 0.8, over: 'D', under: '7' },     // 6 Av over the Flushing line
  { near: '42 St-Bryant Pk', within: 0.8, over: 'D', under: 'GS' },    // ... and over the shuttle
  { near: 'Queensboro Plaza', within: 1.6, over: 'N', under: 'E' },    // Astoria line over Queens Blvd
  { near: 'Queensboro Plaza', within: 1.6, over: 'N', under: 'F' },
];
let crossings = [];            // {x, z, over: trunk key, rank}
const crossGrid = new Map();   // 1 km cells -> crossings
const CROSS_CELL = 1;
const LIFT_MAX = 9;            // km: "no crossing nearby"
/** Find where trunks cross (centrelines of different trunks meeting at a real angle). */
function buildCrossings() {
  const segs = new Map(), seen = new Set(), CELL = 0.3;
  for (const set of Object.values(routeOffsetLines)) for (const [route, list] of set) {
    const trunk = trunkOf(route);
    for (const { flat } of list) for (let i = 0; i + 3 < flat.length; i += 2) {
      const x1 = flat[i], z1 = flat[i + 1], x2 = flat[i + 2], z2 = flat[i + 3];
      const key = `${trunk}|${x1.toFixed(3)},${z1.toFixed(3)},${x2.toFixed(3)},${z2.toFixed(3)}`, rkey = `${trunk}|${x2.toFixed(3)},${z2.toFixed(3)},${x1.toFixed(3)},${z1.toFixed(3)}`;
      if (seen.has(key) || seen.has(rkey)) continue;
      seen.add(key);
      const seg = { trunk, x1, z1, x2, z2 };
      for (let cx = Math.floor(Math.min(x1, x2) / CELL); cx <= Math.floor(Math.max(x1, x2) / CELL); cx++) {
        for (let cz = Math.floor(Math.min(z1, z2) / CELL); cz <= Math.floor(Math.max(z1, z2) / CELL); cz++) {
          const k = cx + ',' + cz;
          if (!segs.has(k)) segs.set(k, []);
          segs.get(k).push(seg);
        }
      }
    }
  }
  const found = [];
  for (const list of segs.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    if (a.trunk === b.trunk) continue;
    const ax = a.x2 - a.x1, az = a.z2 - a.z1, bx = b.x2 - b.x1, bz = b.z2 - b.z1;
    const den = ax * bz - az * bx, la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (!la || !lb || Math.abs(den) / (la * lb) < 0.3) continue; // parallel or a shallow weave on shared track
    const t = ((b.x1 - a.x1) * bz - (b.z1 - a.z1) * bx) / den, u = ((b.x1 - a.x1) * az - (b.z1 - a.z1) * ax) / den;
    if (t < 0 || t > 1 || u < 0 || u > 1) continue;
    const x = a.x1 + t * ax, z = a.z1 + t * az;
    if (found.some((c) => ((c.a === a.trunk && c.b === b.trunk) || (c.a === b.trunk && c.b === a.trunk)) && Math.hypot(c.x - x, c.z - z) < 0.25)) continue;
    found.push({ x, z, a: a.trunk, b: b.trunk });
  }
  const byName = (name) => [...net.stations.values()].filter((st) => st.name === name);
  crossings = found.map((c) => {
    let over = (trunkRank.get(c.a) ?? 0) >= (trunkRank.get(c.b) ?? 0) ? c.a : c.b;
    for (const o of CROSS_OVERRIDES) {
      const ko = trunkOf(o.over), ku = trunkOf(o.under);
      if (!((c.a === ko && c.b === ku) || (c.a === ku && c.b === ko))) continue;
      if (byName(o.near).some((st) => Math.hypot(st.x - c.x, st.z - c.z) < o.within)) over = ko;
    }
    return { x: c.x, z: c.z, over, rank: trunkRank.get(over) ?? 0 };
  });
  crossGrid.clear();
  for (const c of crossings) {
    const k = Math.floor(c.x / CROSS_CELL) + ',' + Math.floor(c.z / CROSS_CELL);
    if (!crossGrid.has(k)) crossGrid.set(k, []);
    crossGrid.get(k).push(c);
  }
}
/** Distance (km) from a point to the nearest crossing where `trunk` passes over (LIFT_MAX: none). */
function liftDistance(x, z, trunk) {
  let best = LIFT_MAX;
  const cx = Math.floor(x / CROSS_CELL), cz = Math.floor(z / CROSS_CELL);
  for (let i = cx - 2; i <= cx + 2; i++) for (let j = cz - 2; j <= cz + 2; j++) {
    for (const c of crossGrid.get(i + ',' + j) || []) {
      if (trunk !== null && c.over !== trunk) continue;
      const d = Math.hypot(c.x - x, c.z - z);
      if (d < best) best = d;
    }
  }
  return best;
}
// the hump: a smooth rise over about five line widths; higher-ranked trunks rise a little more,
// so two raised lines that meet still stack in the default order (same formula as the shader)
const liftHeight = (d, rank) => {
  const r = tubeRadius.value, t = Math.min(1, Math.max(0, 1 - d / Math.max(0.25, 5 * r)));
  return t * t * (3 - 2 * t) * r * (2.2 + 0.25 * rank);
};
/** Height a trunk's line (and its trains) is raised at a point. */
const trunkLift = (x, z, route) => { const k = trunkOf(route); return liftHeight(liftDistance(x, z, k), trunkRank.get(k) ?? 0); };
/** Height of the top line at a point, whichever trunk it is (station symbols sit on top). */
function topLift(x, z) {
  let best = 0;
  const cx = Math.floor(x / CROSS_CELL), cz = Math.floor(z / CROSS_CELL);
  for (let i = cx - 2; i <= cx + 2; i++) for (let j = cz - 2; j <= cz + 2; j++) {
    for (const c of crossGrid.get(i + ',' + j) || []) best = Math.max(best, liftHeight(Math.hypot(c.x - x, c.z - z), c.rank));
  }
  return best;
}
const nyTime = (ts) => new Date(ts * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit' });
const nyDate = (ts) => new Date(ts * 1000).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
/** Routes serving a station or complex in the current map mode (late night or all day). */
const routesOf = (st) => (state.night ? st.nightRoutes || [] : st.routes);
const routeRuns = (route) => !state.night || nightSet.has(route);
const ADA_TEXT = ['Not accessible', 'Fully accessible', 'Partially accessible'];
// International Symbol of Access on MTA accessibility blue; `partial` draws it outlined
const isa = (a, cls = '') => a ? `<svg class="isa ${a === 2 ? 'partial' : ''} ${cls}" viewBox="0 0 16 16" role="img" aria-label="${ADA_TEXT[a]}"><title>${ADA_TEXT[a]}</title><rect x=".75" y=".75" width="14.5" height="14.5" rx="2"/><circle cx="8.4" cy="3.3" r="1.35"/><path d="M7.7 5.6v3.6h3.2l1.5 3.2" /><path d="M6.2 7.6a3.3 3.3 0 1 0 4.5 4" /></svg>` : '';
const hasElevatorOutage = (id) => !!state.outages?.current.get(id)?.some((o) => o.type === 'EL');

function bullet(route, cls = '') {
  const r = net.routes[route];
  if (!r) return `<span class="bullet sm" style="--c:#555">${esc(route)}</span>`;
  const label = r.short.replace(/X$/, '');
  const express = /X$/.test(route) ? ' express' : '';
  const wide = label.length > 2 ? ' wide' : '';
  return `<span class="bullet ${cls}${express}${wide}" style="--c:${r.color};--t:${r.text}"><span>${esc(label)}</span></span>`;
}
// "[N][R] trains are delayed" → inline bullets
function richText(text) {
  return esc(text)
    .replace(/\[accessibility icon\]/gi, isa(1, 'inline'))
    .replace(/\[([A-Z0-9]{1,3})\]/g, (m, id) => {
      const key = id === 'S' ? 'GS' : id;
      const r = net.routes[key];
      return r ? `<span class="inline-bullet" style="background:${r.color};color:${r.text}">${esc(r.short.replace(/X$/, ''))}</span>` : m;
    });
}

// ---------- static scene ----------
const lineSets = { day: new Map(), night: new Map() };          // route -> Group of tubes
const routeOffsetLines = { day: new Map(), night: new Map() };  // route -> [{flat centreline, sid}]
const routeMats = new Map();
const groundMats = {};
// Line thickness follows zoom: thinner up close, a bold map stroke far out.
// Tubes are built at TUBE_R and re-inflated in the vertex shader along their radial normals.
const tubeRadius = { value: TUBE_R };
function zoomableTube(mat, k = 1) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uRadius = tubeRadius;
    sh.vertexShader = 'uniform float uRadius;\nattribute vec3 aSide;\nattribute vec2 aLift;\n' + sh.vertexShader.replace('#include <begin_vertex>',
      `vec3 transformed = position + normal * (uRadius * ${k.toFixed(2)} - ${TUBE_R.toFixed(4)}) + aSide * (${SLOT_W.toFixed(2)} * uRadius);
      float liftT = clamp(1.0 - aLift.x / max(0.25, 5.0 * uRadius), 0.0, 1.0);
      transformed.y += liftT * liftT * (3.0 - 2.0 * liftT) * uRadius * (2.2 + 0.25 * aLift.y);`);
  };
  return mat;
}

/** Tube along a centreline, with a per-vertex sideways unit vector × trunk slot (aSide) so the
 *  shader can set trunks side by side at whatever line width the zoom calls for. */
function trunkTube(pts, slotSigned, route, radial = 6) {
  const curve = new PolylineCurve(pts);
  const segs = Math.min(4000, Math.max(16, Math.round(curve.total / 0.05)));
  const geo = new THREE.TubeGeometry(curve, segs, TUBE_R, radial, false);
  const ring = radial + 1, n = geo.attributes.position.count;
  const side = new Float32Array(n * 3), lift = new Float32Array(n * 2);
  const trunk = trunkOf(route), rank = trunkRank.get(trunk) ?? 0, pos = geo.attributes.position, c = new THREE.Vector3();
  for (let i = 0; i <= segs; i++) {
    const t = geo.tangents[i], l = Math.hypot(t.x, t.z) || 1;
    const sx = (-t.z / l) * slotSigned, sz = (t.x / l) * slotSigned;
    // ring centre: where this ring sits on the centreline
    c.set(0, 0, 0);
    for (let j = 0; j < radial; j++) { c.x += pos.getX(i * ring + j); c.z += pos.getZ(i * ring + j); }
    const d = liftDistance(c.x / radial, c.z / radial, trunk);
    for (let j = 0; j < ring; j++) {
      const k = i * ring + j;
      side[k * 3] = sx; side[k * 3 + 2] = sz;
      lift[k * 2] = d; lift[k * 2 + 1] = rank;
    }
  }
  geo.setAttribute('aSide', new THREE.BufferAttribute(side, 3));
  geo.setAttribute('aLift', new THREE.BufferAttribute(lift, 2));
  return geo;
}

class PolylineCurve extends THREE.Curve {
  constructor(points) {
    super();
    this.points = points;
    this.cum = [0];
    for (let i = 1; i < points.length; i++) this.cum.push(this.cum[i - 1] + points[i].distanceTo(points[i - 1]));
    this.total = this.cum[this.cum.length - 1] || 1;
  }
  getPoint(t, target = new THREE.Vector3()) {
    const d = t * this.total, c = this.cum;
    let lo = 0, hi = c.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] < d) lo = m; else hi = m; }
    const seg = c[hi] - c[lo] || 1;
    return target.lerpVectors(this.points[lo], this.points[hi], (d - c[lo]) / seg);
  }
}

function buildGround() {
  // flat, unlit layers: water < land < parks / airports, as on the printed map
  const toV = (flat) => { const v = []; for (let i = 0; i < flat.length; i += 2) v.push(new THREE.Vector2(flat[i], -flat[i + 1])); return v; };
  const layer = (polys, key, y, order) => {
    const geos = polys.map((rings) => {
      const shape = new THREE.Shape(toV(rings[0]));
      for (const h of rings.slice(1)) shape.holes.push(new THREE.Path(toV(h)));
      return new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
    });
    groundMats[key] = new THREE.MeshBasicMaterial({ color: PALETTE.day[key], fog: true, depthTest: false, depthWrite: false });
    const mesh = new THREE.Mesh(mergeGeometries(geos), groundMats[key]);
    mesh.position.y = y;
    mesh.renderOrder = order - 10;
    scene.add(mesh);
  };
  // The ground layers are a few metres apart, far below depth-buffer precision at city scale, so
  // they are painted in order (water, land, parks) with no depth test; everything else sits above.
  groundMats.water = new THREE.MeshBasicMaterial({ color: PALETTE.day.water, depthTest: false, depthWrite: false });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), groundMats.water);
  water.rotation.x = -Math.PI / 2;
  water.position.y = -0.01;
  water.renderOrder = -10;
  scene.add(water);
  layer(net.ground.land, 'land', 0, 1);
  layer(net.ground.parks, 'park', 0.002, 2);
  layer(net.ground.airports, 'airport', 0.002, 2);
}

function buildLineSet(lines, key) {
  for (const [route, shapeIds] of Object.entries(lines)) {
    if (!net.routes[route]) continue;
    if (!routeColor.has(route)) routeColor.set(route, new THREE.Color(net.routes[route].color));
    if (!routeMats.has(route)) {
      const gi = trunkRank.get(trunkOf(route)) ?? 0;
      routeMats.set(route, zoomableTube(new THREE.MeshBasicMaterial({
        color: routeColor.get(route), transparent: true, polygonOffset: true, polygonOffsetFactor: -gi, polygonOffsetUnits: -2 * gi,
      })));
    }
    const mat = routeMats.get(route);
    const group = new THREE.Group();
    for (const { flat, sid } of routeOffsetLines[key].get(route) || []) {
      const pts = [];
      for (let i = 0; i < flat.length; i += 2) pts.push(new THREE.Vector3(flat[i], 0, flat[i + 1]));
      if (pts.length < 2) continue;
      group.add(new THREE.Mesh(trunkTube(pts, slotOf(route) * shapeSign(sid), route), mat));
    }
    group.userData.route = route;
    lineSets[key].set(route, group);
    scene.add(group);
  }
}
function buildLines() {
  // centrelines first, so the crossings are known before the tubes are built
  for (const [key, lines] of [['day', net.lines], ['night', net.nightLines || {}]]) {
    for (const [route, shapeIds] of Object.entries(lines)) {
      if (!net.routes[route]) continue;
      routeOffsetLines[key].set(route, shapeIds.map((sid) => ({ flat: net.shapes.get(sid)?.pts, sid })).filter((x) => x.flat));
    }
  }
  buildCrossings();
  buildLineSet(net.lines, 'day');
  buildLineSet(net.nightLines || {}, 'night');
}

// Station symbols as on the MTA map: one per trunk line at each station. A black dot is a local
// stop; a white circle with a black outline is where express trains stop too. The stations of
// a transfer complex are joined by thin black connector lines.
/** True where one of `group`'s routes runs express past a stop that another makes next to `id`. */
function isExpressStop(id, group) {
  if (group.length < 2) return false;
  const usable = (r) => { const ps = net.byRoute.get(r) || []; const top = Math.max(1, ...ps.map((p) => p.count)); return ps.filter((p) => p.count >= top * 0.15 && p.pos.has(id)); };
  for (const r of group) for (const pr of usable(r)) {
    const next = pr.stops[pr.pos.get(id) + 1];
    if (!next) continue;
    for (const q of group) {
      if (q === r) continue;
      // q also goes from here to r's next stop, but stops somewhere in between
      for (const pq of usable(q)) if (pq.pos.has(next) && pq.pos.get(next) > pq.pos.get(id) + 1) return true;
    }
  }
  return false;
}
let nodeMesh, nodeInner, linkOuter, stationList, nodeList, linkList;
const nodeLists = { day: [], night: [] }, linkLists = { day: [], night: [] };
const adaMeshes = {};
function buildNodes(mode) {
  const list = [];
  for (const st of stationList) {
    const routes = mode === 'night' ? st.nightRoutes || [] : st.routes;
    const groups = new Map();
    for (const r of routes) { const k = trunkOf(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    for (const group of groups.values()) {
      // nearest point on the trunk's centreline, with the line's sideways direction there
      let bx = st.x, bz = st.z, bd = 0.25 ** 2, sx = 0, sz = 0, sid = null, route = group[0];
      for (const r of group) {
        for (const { flat, sid: id } of routeOffsetLines[mode].get(r) || routeOffsetLines.day.get(r) || []) {
          for (let i = 0; i < flat.length; i += 2) {
            const d = (flat[i] - st.x) ** 2 + (flat[i + 1] - st.z) ** 2;
            if (d >= bd) continue;
            const j = i + 2 < flat.length ? i : i - 2;
            const tx = flat[j + 2] - flat[j], tz = flat[j + 3] - flat[j + 1], l = Math.hypot(tx, tz) || 1;
            bd = d; bx = flat[i]; bz = flat[i + 1]; sx = -tz / l; sz = tx / l; sid = id; route = r;
          }
        }
      }
      const slot = sid ? slotOf(route) * shapeSign(sid) : 0;
      list.push({ st, route, routes: group, bx, bz, sx, sz, slot, x: bx, z: bz, express: isExpressStop(st.id, group) });
    }
  }
  // transfers: the symbols of a complex are joined to their nearest neighbours (a minimum
  // spanning tree, skipping members far apart)
  const byComplex = new Map();
  list.forEach((n, i) => { if (!byComplex.has(n.st.complex)) byComplex.set(n.st.complex, []); byComplex.get(n.st.complex).push(i); });
  const links = [];
  for (const ids of byComplex.values()) {
    if (ids.length < 2) continue;
    const inTree = new Set([ids[0]]);
    while (inTree.size < ids.length) {
      let best = null, bd = Infinity;
      for (const a of inTree) for (const b of ids) {
        if (inTree.has(b)) continue;
        const d = Math.hypot(list[a].bx - list[b].bx, list[a].bz - list[b].bz);
        if (d < bd) { bd = d; best = [a, b]; }
      }
      inTree.add(best[1]);
      if (bd < 1.2) links.push(best);
    }
  }
  linkLists[mode] = links;
  return list;
}
function buildStations() {
  stationList = [...net.stations.values()];
  nodeLists.day = buildNodes('day');
  nodeLists.night = buildNodes('night');
  nodeList = nodeLists.day;
  linkList = linkLists.day;
  const maxNodes = Math.max(nodeLists.day.length, nodeLists.night.length);
  // map symbols: black dot = local stop; white circle with black outline = express & local stop.
  // Node colour is per instance so the accessible map can grey out non-accessible stops.
  const disc = new THREE.CylinderGeometry(1, 1, 1, 24).translate(0, 0.5, 0);
  nodeMesh = new THREE.InstancedMesh(disc, new THREE.MeshBasicMaterial({ color: C.white }), maxNodes);
  nodeInner = new THREE.InstancedMesh(disc, new THREE.MeshBasicMaterial({ color: C.white }), maxNodes);
  const bar = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const maxLinks = Math.max(linkLists.day.length, linkLists.night.length, 1);
  linkOuter = new THREE.InstancedMesh(bar, new THREE.MeshBasicMaterial({ color: C.white }), maxLinks);
  for (const m of [nodeMesh, nodeInner, linkOuter]) m.frustumCulled = false;
  // accessible-stations symbols: ring/disc (fully accessible), diamond (partly), triangle (elevator out)
  const flat = (segs) => new THREE.CylinderGeometry(1, 1, 1, segs).translate(0, 0.5, 0);
  const mk = (geo, color) => {
    const m = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color }), stationList.length);
    m.count = 0;
    // three computes an InstancedMesh's bounding sphere once, on first render: these start empty,
    // so with culling on they would stay invisible after the accessible map is switched on
    m.frustumCulled = false;
    scene.add(m);
    return m;
  };
  const ring = flat(32), diamond = flat(4), tri = flat(3);
  Object.assign(adaMeshes, {
    fullOuter: mk(ring, C.adaBlue), fullInner: mk(ring, C.white),
    partOuter: mk(diamond, C.adaBlue), partInner: mk(diamond, C.white),
    warnOuter: mk(tri, C.ink), warnInner: mk(tri, C.warn),
  });
  scene.add(nodeMesh, nodeInner, linkOuter);
  layoutStations();
}
function stationTop(st) {
  const routes = routesOf(st);
  return Math.max(...(routes.length ? routes : st.routes).map(heightOf));
}
const _ink = new THREE.Color(C.ink), _grey = new THREE.Color(C.grey);
function layoutStations() {
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const r = tubeRadius.value, top = r * 1.02, t = r * 0.25;
  let w = 0;
  // bold symbols when zoomed in; when the whole city is on screen they shrink toward the line
  // width so neighbouring stations don't merge into beads
  const far = Math.min(1, Math.max(0, (state.wpp - 0.01) / 0.04));
  const kLocal = 1.3 - 0.15 * far, kExpress = 1.6 - 0.25 * far, kInner = 1.05 - 0.2 * far;
  const off = SLOT_W * r;
  nodeList.forEach((n, i) => {
    // sit on the trunk's slot at the current line width, on top of whatever crosses there
    n.x = n.bx + n.sx * n.slot * off; n.z = n.bz + n.sz * n.slot * off;
    n.y = heightOf(n.route) + topLift(n.bx, n.bz) + top;
    const y = n.y;
    const dim = state.ada && n.st.ada === 0; // non-accessible: a small grey dot
    const rad = dim ? r * 0.8 : r * (n.express ? kExpress : kLocal);
    m.compose(p.set(n.x, y, n.z), q, s.set(rad, t, rad));
    nodeMesh.setMatrixAt(i, m);
    nodeMesh.setColorAt(i, dim ? _grey : _ink);
    if (n.express && !dim) {
      m.compose(p.set(n.x, y + t * 0.5, n.z), q, s.set(r * kInner, t, r * kInner));
      nodeInner.setMatrixAt(w++, m);
    }
  });
  // transfer connectors: a thin black line joining the station symbols of a complex, drawn
  // just under the symbols
  let nl = 0;
  const up = new THREE.Vector3(0, 1, 0);
  for (const [a, b] of linkList) {
    const A = nodeList[a], B = nodeList[b];
    const dx = B.x - A.x, dz = B.z - A.z, len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    q.setFromAxisAngle(up, -Math.atan2(dz, dx));
    m.compose(p.set((A.x + B.x) / 2, Math.max(A.y, B.y) - t * 0.4, (A.z + B.z) / 2), q, s.set(len, t, r * 0.55));
    linkOuter.setMatrixAt(nl, m);
    linkOuter.setColorAt(nl, state.ada ? _grey : _ink);
    nl++;
  }
  q.identity();
  linkOuter.count = nl;
  nodeMesh.count = nodeList.length;
  nodeInner.count = w;
  for (const mesh of [nodeMesh, nodeInner, linkOuter]) mesh.instanceMatrix.needsUpdate = true;
  if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;
  if (linkOuter.instanceColor) linkOuter.instanceColor.needsUpdate = true;
  layoutAda();
}
// accessible-station symbols, sized to stay legible at city scale
function layoutAda() {
  const A = adaMeshes;
  const counts = { fullOuter: 0, fullInner: 0, partOuter: 0, partInner: 0, warnOuter: 0, warnInner: 0 };
  if (state.ada) {
    const m = new THREE.Matrix4(), q0 = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    // point the diamond and triangle at screen-up of the map view
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI - MAP_ROT);
    const r = tubeRadius.value, t = r * 0.25;
    const R = Math.max(r * 2.4, state.wpp * 5.5);
    const put = (key, x, y, z, rad, rot = q0) => { m.compose(p.set(x, y, z), rot, s.set(rad, t, rad)); A[key].setMatrixAt(counts[key]++, m); };
    for (const st of stationList) {
      if (!routesOf(st).length) continue;
      const y = stationTop(st) + r * 1.3 + t;
      if (st.ada === 1) { put('fullOuter', st.x, y, st.z, R); put('fullInner', st.x, y + t * 0.5, st.z, R * 0.58); }
      else if (st.ada === 2) { put('partOuter', st.x, y, st.z, R * 1.2, q); put('partInner', st.x, y + t * 0.5, st.z, R * 0.72, q); }
      if (hasElevatorOutage(st.id)) {
        const d = st.ada ? R * 1.7 : R * 0.6;
        const x = st.x + MAP_RIGHT.x * d, z = st.z + MAP_RIGHT.z * d;
        put('warnOuter', x, y + t, z, R * 1.0, q);
        put('warnInner', x, y + t * 1.5, z, R * 0.66, q);
      }
    }
  }
  for (const [k, mesh] of Object.entries(A)) { mesh.count = counts[k]; mesh.instanceMatrix.needsUpdate = true; }
}
function layoutLines() {
  for (const set of Object.values(lineSets)) for (const [route, g] of set) g.position.y = heightOf(route);
  layoutStations();
}

// labels: major stations always; in the accessible map, every accessible station too
const labelEls = [];
function buildLabels() {
  const host = $('#labels');
  const add = (item) => {
    const el = document.createElement('div');
    el.className = item.borough ? 'label borough' : 'label';
    el.textContent = item.borough ? item.borough.name : item.st.name;
    el.style.display = 'none';
    host.appendChild(el);
    labelEls.push({ el, shown: false, ...item });
  };
  for (const b of net.ground.labels) if (b.name !== 'Staten Island') add({ borough: b });
  // one label per station complex (Union Sq's three platforms would otherwise be labelled three times)
  const major = (st) => st.routes.length >= 4 || /Terminal|Coney Island|Jamaica Center|Flushing|Inwood|Van Cortlandt/.test(st.name);
  for (const c of net.complexes.values()) {
    if (c.members.some(major)) add({ st: c });
    else if (c.ada) add({ st: c, adaOnly: true });
  }
  applyLabelModes();
}
const adaOf = (st) => st.ada || 0;
function applyLabelModes() {
  for (const l of labelEls) {
    if (!l.st) continue;
    const a = adaOf(l.st);
    l.el.innerHTML = esc(l.st.name) + (state.ada && a ? ' ' + isa(a) : '');
    l.el.classList.toggle('acc', state.ada && a > 0);
    l.el.classList.toggle('dim', (state.ada && !a) || !routesOf(l.st).length);
  }
}
const _v = new THREE.Vector3();
function showLabel(l, on) { if (l.shown !== on) { l.shown = on; l.el.style.display = on ? '' : 'none'; } }
function updateLabels() {
  const show = state.showLabels;
  for (const l of labelEls) {
    const { el, st, borough } = l;
    if (!show || (l.adaOnly && !state.ada)) { showLabel(l, false); continue; }
    if (borough) _v.set(borough.pos[0], 0, borough.pos[1]);
    else _v.set(st.x, (st.members ? complexTop(st) : stationTop(st)) + 0.08, st.z);
    const dist = _v.distanceTo(camera.position);
    _v.project(camera);
    const alpha = borough ? Math.min(1, Math.max(0, (dist - 4) / 6)) : Math.min(1, Math.max(0, (22 - dist) / 8));
    if (_v.z > 1 || alpha <= 0 || Math.abs(_v.x) > 1.1 || Math.abs(_v.y) > 1.1) { showLabel(l, false); continue; }
    showLabel(l, true);
    el.style.opacity = alpha;
    el.style.transform = borough
      ? `translate(${((_v.x + 1) / 2) * innerWidth}px, ${((1 - _v.y) / 2) * innerHeight}px) translate(-50%, -50%)`
      : `translate(${((_v.x + 1) / 2) * innerWidth + 8}px, ${((1 - _v.y) / 2) * innerHeight - 7}px)`;
  }
}

// ---------- trains ----------
let trainRenderer;
const trainView = new Map();   // trip id -> {x,z,h,y,s,speed,shape,pos}
let drawnTrains = [];          // {id, head, tail} of each train drawn this frame (for picking)
const revealIndex = new Map(); // route -> position in the legend, for the line-by-line reveal
function buildTrains() {
  trainRenderer = new TrainRenderer(scene, (route) => {
    const r = net.routes[route] || { short: route, color: '#6d6e71', text: '#ffffff' };
    return { label: r.short.replace(/X$/, ''), color: r.color, text: r.text, express: /X$/.test(route) };
  });
}
const revealed = (route) => state.revealClock >= REVEAL_STEP * (revealIndex.get(route) ?? revealIndex.size);

const _p = new THREE.Vector3(), _c = new THREE.Color(), _sc = new THREE.Color(), _w = new THREE.Color(0xffffff);
const _red = new THREE.Color(0xdc4d4a);
function lerpAngle(a, b, t) { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return a + d * t; }

// Place each car of the consist on the track: position and heading come from the two bogie
// points, so the train bends through curves instead of sliding as a rigid block.
/** Sideways place of a train: on its trunk's slot, on the right-hand half of the line. */
const trainOffset = (trip) => slotOffset(trip.route, trip.pattern.shape) + tubeRadius.value * 0.6;
function consistCars(v, trip, len, lenK, n) {
  const cars = [];
  const L = len * lenK;
  if (v.shape) {
    const off = trainOffset(trip);
    for (let i = 0; i < n; i++) {
      const c = v.s - (i + 0.5) * L;
      const [xf, zf] = pointAt(v.shape, c + L * 0.35), [xb, zb] = pointAt(v.shape, c - L * 0.35);
      const h = Math.atan2(zf - zb, xf - xb);
      const mx = (xf + xb) / 2, mz = (zf + zb) / 2;
      cars.push({ x: mx - Math.sin(h) * off, z: mz + Math.cos(h) * off, y: v.y + trunkLift(mx, mz, trip.route), h });
    }
  } else {
    for (let i = 0; i < n; i++) {
      const d = (i + 0.5) * L;
      cars.push({ x: v.x - Math.cos(v.h) * d, z: v.z - Math.sin(v.h) * d, y: v.y, h: v.h });
    }
  }
  return cars;
}

// ---------- creeping and arrival glows ----------
const CREEP = 0.0025; // map km/s, a slow roll (~5-9 km/h)
/** How far along its shape a train may creep: partway to the station after its next one. */
function creepLimit(trip, pos, waiting) {
  const p = trip.pattern, cum = pos.shape.cum;
  if (waiting) return pos.sNext + 0.02;
  const j = p?.pos.get(pos.to);
  const sAfter = j !== undefined && j + 1 < p.idx.length ? cum[p.idx[j + 1]] : null;
  if (sAfter === null || sAfter <= pos.sNext) return Math.min(pos.sNext + 0.03, cum[cum.length - 1]);
  return pos.sNext + Math.min(0.25 * (sAfter - pos.sNext), 0.2);
}

// A pulse at a station when a train arrives: a soft glow and a ripple ring in the route colour
// that swell and fade, with a quick sparkle at the centre. Sprites keep a constant screen size.
function glowTexture(kind) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (kind === 'ring') {
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, 'rgba(255,255,255,0)'); r.addColorStop(0.62, 'rgba(255,255,255,0)'); r.addColorStop(0.8, 'rgba(255,255,255,1)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  } else if (kind === 'spark') {
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.25, 'rgba(255,255,255,.7)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, 64, 64);
    g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(32, 2); g.lineTo(32, 62); g.moveTo(2, 32); g.lineTo(62, 32); g.stroke();
  } else {
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, 'rgba(255,255,255,.9)'); r.addColorStop(0.45, 'rgba(255,255,255,.45)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  }
  return new THREE.CanvasTexture(c);
}
const GLOW_LIFE = 1.6; // s
const glowPool = [];
let glowTex, sparkTex, ringTex;
function arrivalGlow(trip, shape, s) {
  if (state.revealClock < 2) return; // not while the trains are first appearing
  if (!glowTex) { glowTex = glowTexture('glow'); sparkTex = glowTexture('spark'); ringTex = glowTexture('ring'); }
  let g = glowPool.find((x) => x.t >= GLOW_LIFE);
  if (!g) {
    if (glowPool.length >= 96) return;
    const mk = (map) => {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, depthTest: false, fog: false }));
      sp.renderOrder = 5;
      scene.add(sp);
      return sp;
    };
    g = { disc: mk(glowTex), ring: mk(ringTex), spark: mk(sparkTex), t: GLOW_LIFE };
    glowPool.push(g);
  }
  const [x, z, h] = pointAt(shape, s);
  const off = trainOffset(trip);
  const y = heightOf(trip.route) + tubeRadius.value * 2;
  g.disc.position.set(x - Math.sin(h) * off, y, z + Math.cos(h) * off);
  g.spark.position.copy(g.disc.position);
  g.ring.position.copy(g.disc.position);
  const col = routeColor.get(trip.route) || _w;
  g.disc.material.color.copy(col);
  g.ring.material.color.copy(col);
  g.spark.material.color.copy(col).lerp(_w, 0.55);
  g.t = 0;
}
function updateGlows(dt) {
  const px = state.wpp || 0.01;
  for (const g of glowPool) {
    if (g.t >= GLOW_LIFE) { g.disc.visible = g.ring.visible = g.spark.visible = false; continue; }
    g.t += dt;
    const k = Math.min(1, g.t / GLOW_LIFE), ease = 1 - (1 - k) ** 3;
    g.disc.visible = g.ring.visible = g.spark.visible = true;
    g.disc.scale.setScalar(px * (30 + 30 * ease));
    g.disc.material.opacity = 0.6 * (1 - k) ** 1.5;
    g.ring.scale.setScalar(px * (14 + 62 * ease));
    g.ring.material.opacity = 0.85 * (1 - k) ** 1.4;
    const ks = Math.min(1, g.t / 0.8);
    g.spark.scale.setScalar(px * 26 * (1 - ks * 0.5));
    g.spark.material.opacity = (1 - ks) ** 2;
    g.spark.material.rotation = g.t * 1.5;
  }
}

function updateTrains(dt) {
  const now = Date.now() / 1000;
  const k = Math.min(1, dt * 2.5);
  if (state.revealClock >= 0) state.revealClock += dt;
  // Cars are drawn as symbols: R62 proportions, scaled with zoom so they stay legible
  // (about 1.5x real length up close, 6x at city scale), cross-section fattened further.
  const far = Math.min(1, Math.max(0, (state.wpp - 0.01) / 0.04)); // 1 when the whole city is on screen
  // Cars keep their real R62 proportions, scaled up evenly so a car is a little wider than half
  // the line (one half per direction) and at least a few pixels wide. Zoomed out, a full consist would be kilometres long, so only
  // the front cars are drawn: as many as fit in ~30 px, or the whole train up close.
  const r = tubeRadius.value;
  const maxLen = Math.max(state.wpp * 30, 0.35);
  drawnTrains = [];
  trainRenderer.begin();
  for (const trip of state.trips.values()) {
    const pos = placeTrip(net, trip, now);
    if (!pos) continue;
    // v2 feeds give every trip a VehiclePosition, even ones not due out for half an hour, so a
    // train counts as waiting until it has left (or is standing at) its first stop
    const waiting = pos.state === 'origin';
    const sel = state.selected?.kind === 'train' && state.selected.id === trip.id;
    const visible = state.showTrains && (sel || ((state.showWaiting || !waiting) && routeRuns(trip.route) && revealed(trip.route)
      && (!state.focusRoute || trip.route === state.focusRoute)));
    let v = trainView.get(trip.id);
    const y = heightOf(trip.route) + tubeRadius.value * 0.45; // riding on the line
    if (!v) { v = { x: pos.x, z: pos.z, h: pos.h, y, speed: 0 }; trainView.set(trip.id, v); }
    if (pos.shape) {
      // Drive along the real track: speed is chosen so the train reaches its next station at
      // the predicted arrival time (faster when behind the estimate, slower when ahead).
      // Trains never stand still: early, dwelling or stalled trains creep on very slowly.
      // New feed data often moves the estimate; a train that is behind speeds up to catch it
      // and one that is ahead waits, so trains never jump. Only a large error snaps.
      const fresh = v.shape !== pos.shape || v.s === undefined;
      const behind = pos.sEst - v.s;
      if (fresh || behind > 3 || behind < -1.5) {
        v.shape = pos.shape; v.s = pos.sEst; v.speed = 0;
      } else {
        const left = pos.sNext - v.s;
        const stalled = trip.vehicle?.ts && state.feedTime - trip.vehicle.ts > 90;
        const timeLeft = pos.state === 'moving' ? Math.max(4, pos.arr - now) : 3;
        let want = left <= 0 || stalled ? 0 : Math.min(VMAX, left / timeLeft);
        if (behind > 0.05 && left > 0) want = Math.min(left / 2, Math.max(want, behind / 6)); // close the gap in ~6 s
        // creep: a little way past the next station at most (part of the way to the one after),
        // ever slower as it nears that limit, so it never visibly stops and never runs far ahead
        const limit = creepLimit(trip, pos, waiting);
        want = Math.max(want, Math.min(CREEP, Math.max(0, limit - v.s) * 0.004));
        v.speed += (want - v.speed) * Math.min(1, dt * 1.5); // ease acceleration
        const before = v.s;
        v.s = Math.min(Math.max(v.s, limit), v.s + v.speed * dt * state.timeScale);
        // arrival: the train just reached its next station
        const at = pos.sNext - 0.004;
        if (before < at && v.s >= at && visible && v.arrived !== pos.to) { v.arrived = pos.to; arrivalGlow(trip, pos.shape, pos.sNext); }
      }
      const [x, z, h] = pointAt(pos.shape, v.s);
      const off = trainOffset(trip);
      v.x = x - Math.sin(h) * off; v.z = z + Math.cos(h) * off;
      v.h = h;
    } else {
      // off-pattern trip: ease toward the next station
      v.x += (pos.x - v.x) * k; v.z += (pos.z - v.z) * k;
      v.h = lerpAngle(v.h, pos.h, k);
      v.shape = null; v.s = undefined; v.speed = 0;
    }
    v.y += (y - v.y) * Math.min(1, dt * 6);
    v.pos = pos;
    if (!visible) continue;
    const { len, cars: nCars } = consistOf(trip.route);
    const S = Math.max(1.5, Math.max(r * 1.4 * (1 - 0.4 * far), state.wpp * (4.5 - 2 * far)) / (0.169 * len)) * (sel ? 1.25 : 1);
    const lenK = S, girth = S;
    const shown = Math.max(1, Math.min(nCars, Math.floor(maxLen / (len * S))));
    _c.set(waiting ? 0xeef0f2 : 0xb4bac0);
    if (sel) _c.set(C.ink);
    _sc.copy(_w);
    if (trip.delayed) _sc.set(0xff8a80); // the sign glows red on a delayed train
    const cars = consistCars(v, trip, len, lenK, shown);
    const g = girth;
    // direction arrow: on the lead car's roof, never smaller than ~7 px on screen
    const carW = len * g * 0.169;
    const arrow = { len: Math.max(len * lenK * 0.6, state.wpp * 5), width: Math.max(carW * 0.85, state.wpp * 4), color: trip.delayed ? _red : _ink };
    // with the whole city on screen the arrows would only clutter the map
    trainRenderer.add(cars, len, lenK, g, _c, trip.route, _sc, 1, far < 0.6 || sel ? arrow : null, routeColor.get(trip.route) || _grey);
    const last = cars[cars.length - 1] || v, first = cars[0] || v;
    drawnTrains.push({ id: trip.id, head: [v.x, first.y, v.z], tail: [last.x, last.y, last.z] });
  }
  trainRenderer.end();
  for (const id of trainView.keys()) if (!state.trips.has(id)) trainView.delete(id);
}

// highlighted path for the selected train
let pathMesh = null;
function updatePath() {
  if (pathMesh) { scene.remove(pathMesh); pathMesh.geometry.dispose(); pathMesh = null; }
  const sel = state.selected;
  if (sel?.kind !== 'train') return;
  const trip = state.trips.get(sel.id);
  const p = trip?.pattern;
  if (!p || !p.pos.has(trip.stus[0].parent)) return;
  const j = p.pos.get(trip.stus[0].parent);
  const shape = net.shapes.get(p.shape);
  const a = p.idx[Math.max(0, j - 1)], b = p.idx[p.idx.length - 1];
  const flat = shape.pts.slice(2 * a, 2 * b + 2);
  const pts = [];
  for (let i = 0; i < flat.length; i += 2) pts.push(new THREE.Vector3(flat[i], heightOf(trip.route), flat[i + 1]));
  if (pts.length < 2) return;
  pathMesh = new THREE.Mesh(
    trunkTube(pts, slotOf(trip.route) * shapeSign(p.shape), trip.route, 8),
    zoomableTube(new THREE.MeshBasicMaterial({ color: C.ink, transparent: true, opacity: 0.3 }), 1.9),
  );
  scene.add(pathMesh);
}

// ---------- focus / dimming ----------
function applyFocus() {
  for (const [route, mat] of routeMats) {
    const on = !state.focusRoute || route === state.focusRoute;
    mat.opacity = on ? 1 : 0.18;
    mat.depthWrite = on;
  }
  document.querySelectorAll('#legend .bullet').forEach((b) => {
    b.classList.toggle('on', b.dataset.route === state.focusRoute);
    b.classList.toggle('off', !routeRuns(b.dataset.route));
  });
  $('#legend').classList.toggle('focused', !!state.focusRoute);
  renderStatusBox();
  renderAlerts();
}
function toggleFocus(route) {
  state.focusRoute = state.focusRoute === route ? null : route;
  applyFocus();
}

// ---------- map modes ----------
const cssHex = (n) => '#' + n.toString(16).padStart(6, '0');
function setNight(on) {
  state.night = on;
  $('#late-night').checked = on;
  const pal = on ? PALETTE.night : PALETTE.day;
  for (const k of ['water', 'land', 'park', 'airport']) groundMats[k].color.setHex(pal[k]);
  scene.background.setHex(pal.water);
  scene.fog.color.setHex(pal.water);
  document.documentElement.style.setProperty('--bg', cssHex(pal.water));
  document.documentElement.style.setProperty('--land', cssHex(pal.land));
  document.body.classList.toggle('night', on);
  for (const g of lineSets.day.values()) g.visible = !on;
  for (const g of lineSets.night.values()) g.visible = on;
  nodeList = on ? nodeLists.night : nodeLists.day;
  linkList = on ? linkLists.night : linkLists.day;
  layoutLines();
  applyLabelModes();
  updateCaption();
  applyFocus();
  runSearch();
  renderDetails();
  renderBoard();
}
function setAda(on) {
  state.ada = on;
  $('#accessible').checked = on;
  document.body.classList.toggle('ada', on);
  layoutStations();
  applyLabelModes();
  updateCaption();
  renderDetails();
}
function updateCaption() {
  const lines = [];
  if (state.night) lines.push('Late night service, about midnight to 6 AM');
  if (state.ada) lines.push('Accessible stations highlighted, non-accessible stations dimmed');
  const el = $('#mode-caption');
  el.hidden = !lines.length;
  el.innerHTML = lines.map((l) => `<div>${esc(l)}</div>`).join('');
}

// ---------- UI ----------
function buildLegend() {
  const host = $('#legend');
  const ids = Object.keys(net.lines).sort((a, b) => net.routes[a].sort - net.routes[b].sort);
  ids.forEach((r, i) => revealIndex.set(r, i));
  host.innerHTML = ids.map((r) => bullet(r).replace('<span class="bullet', `<button title="${esc(net.routes[r].long)}" data-route="${r}" class="bullet`).replace(/<\/span>$/, '</button>')).join('');
  host.addEventListener('click', (e) => {
    const b = e.target.closest('[data-route]');
    if (b) toggleFocus(b.dataset.route);
  });
}

function setStatus(text, cls) {
  $('#status-text').textContent = text;
  $('#status').className = cls || '';
}

const lineStatus = (r) => [state.status.get(r), state.status.get(r + 'X')].filter(Boolean).reduce((a, b) => (!a || b.rank > a.rank ? b : a), null);
const severityOf = (s) => (!s ? 'none' : !s.planned && s.rank >= 24 ? 'severe' : s.planned ? 'planned' : 'notice');
function renderStatusBox() {
  if (!net) return;
  const rows = TRUNKS.map((trunk) => {
    // lines of a trunk that share a status are listed together
    const segs = new Map();
    for (const r of trunk) {
      if (!net.routes[r]) continue;
      const s = lineStatus(r);
      const text = s ? s.type : 'No Active Alerts';
      if (!segs.has(text)) segs.set(text, { s, routes: [] });
      segs.get(text).routes.push(r);
    }
    return `<div class="trunk">${[...segs].map(([text, { s, routes }]) => `
      <div class="seg ${severityOf(s)}">
        <span class="sbs">${routes.map((r) => bullet(r, 'sm').replace('<span class="bullet', `<button data-route="${r}" title="${esc(net.routes[r].long)}" class="bullet${r === state.focusRoute ? ' on' : ''}${routeRuns(r) ? '' : ' off'}`).replace(/<\/span>$/, '</button>')).join('')}</span>
        <span class="stext">${esc(text)}${s?.count > 1 ? ` <span class="muted">· ${s.count} alerts</span>` : ''}</span>
      </div>`).join('')}</div>`;
  });
  // one-line summary kept in the header so the collapsed box is useful at a glance
  const lines = TRUNKS.flat().filter((r) => net.routes[r]);
  const severe = lines.filter((r) => severityOf(lineStatus(r)) === 'severe').length;
  const affected = lines.filter((r) => lineStatus(r)).length;
  const sum = $('#status-summary');
  sum.textContent = severe ? `${severe} line${severe > 1 ? 's' : ''} with delays or disruptions`
    : affected ? 'No unplanned disruptions' : state.alerts.length || state.status.size ? 'No active alerts' : '';
  sum.classList.toggle('severe', severe > 0);
  const box = $('#status-box');
  box.classList.toggle('focused', !!state.focusRoute);
  box.innerHTML = rows.join('');
}
$('#status-box').addEventListener('click', (e) => {
  const b = e.target.closest('[data-route]');
  if (b) toggleFocus(b.dataset.route);
});

// `more`: include the expandable description (left out of panels that re-render every second)
const alertHtml = (a, extra = '', more = true) => `
  <div class="alert">
    <div class="type ${!a.planned && a.rank >= 24 ? 'severe' : ''}">${esc(a.type)}${extra}${a.period ? ' · ' + esc(a.period) : ''}</div>
    <p>${richText(a.header)}</p>
    ${more && a.description ? `<details><summary>More</summary>${richText(a.description).replace(/\n/g, '<br>')}</details>` : ''}
  </div>`;
function renderAlerts() {
  const list = state.focusRoute ? state.alerts.filter((a) => a.routes.has(state.focusRoute) || a.routes.has(state.focusRoute + 'X')) : state.alerts;
  $('#alert-count').textContent = list.length ? `(${list.length})` : '';
  const now = list.filter((a) => !a.planned), planned = list.filter((a) => a.planned);
  const group = (title, items) => items.length ? `<div class="agroup">${title} <span class="muted">${items.length}</span></div>${items.slice(0, 40).map((a) => alertHtml(a)).join('')}` : '';
  $('#alert-list').innerHTML = list.length
    ? group('Now', now) + group('Planned work', planned)
    : '<p class="muted">No active alerts' + (state.focusRoute ? ' for this route' : '') + '.</p>';
}

const destName = (trip) => {
  // v2 trip updates run to the end of the trip, so the feed's own last stop is the destination (the
  // matched static pattern can end elsewhere, e.g. an A rerouted via the F matched to an F pattern)
  const last = trip.stus.at(-1)?.parent || trip.pattern?.stops.at(-1);
  return net.stations.get(last)?.name || last || '?';
};
// MTA countdown-clock style: whole minutes, rounded down; under 30 s reads "now"
const mins = (t, now) => { const d = t - now; return d < 30 ? 'now' : `${Math.floor(d / 60)} min`; };

/** Live arrivals at a station, split by direction, from every trip's stop_time_updates. */
function stationArrivals(id, now, horizon = 45 * 60) {
  const out = { N: [], S: [] };
  const ids = complexOf(id)?.ids || new Set([id]);
  for (const t of state.trips.values()) {
    for (const s of t.stus) {
      if (!ids.has(s.parent)) continue;
      if (s === t.stus.at(-1)) break; // terminating here: not a departure, as on the countdown clocks
      if (s.arr >= now - 15 && s.arr - now < horizon) out[s.stop.endsWith('S') ? 'S' : 'N'].push({ t, s });
      break;
    }
  }
  out.N.sort((a, b) => a.s.arr - b.s.arr);
  out.S.sort((a, b) => a.s.arr - b.s.arr);
  return out;
}
const DIR_LABEL = { N: 'Northbound', S: 'Southbound', both: 'Both directions' };
const complexOf = (stationId) => net.complexes.get(net.stations.get(stationId)?.complex);
const complexTop = (c) => Math.max(...c.members.map(stationTop));
const arrivalRow = ({ t, s }, now, cls = '') => `<tr class="click ${cls}" data-trip="${esc(t.id)}"><td class="b">${bullet(t.route, 'sm')}</td><td>${esc(destName(t))}${t.delayed ? ' <span class="tag bad">delayed</span>' : ''}</td><td class="t">${mins(s.arr, now)}</td></tr>`;
const routeBullets = (st) => {
  const rs = routesOf(st);
  return rs.length ? rs.map((r) => bullet(r, 'sm')).join(' ') : '<span class="muted">No late-night service</span>';
};

function freshText() {
  if (!state.newest) return '';
  const age = Math.max(0, Math.round(Date.now() / 1000 - state.newest));
  return `updated ${age < 60 ? age + ' s' : Math.floor(age / 60) + ' min'} ago`;
}
const isStale = () => !!state.oldest && Date.now() / 1000 - state.oldest > STALE_S;

function accessibilityHtml(c) {
  const memberLine = (m) => `${isa(m.ada)} <b>${ADA_TEXT[m.ada]}</b>${m.adaNotes ? ` <span class="muted">· ${esc(m.adaNotes)}</span>` : ''}`;
  const uniform = c.members.every((m) => m.ada === c.members[0].ada && !m.adaNotes);
  const status = c.members.length === 1 || uniform
    ? `<div class="ada-line">${memberLine(c.members[0])}</div>`
    : c.members.map((m) => `<div class="ada-line"><span class="ada-routes">${(routesOf(m).length ? routesOf(m) : m.routes).map((r) => bullet(r, 'sm')).join('')}</span>${memberLine(m)}</div>`).join('');
  const kind = (o) => (o.type === 'EL' ? 'Elevator' : 'Escalator');
  let out = '';
  if (state.outages) {
    const cur = [...c.ids].flatMap((i) => state.outages.current.get(i) || []).sort((a, b) => (a.type === 'EL' ? 0 : 1) - (b.type === 'EL' ? 0 : 1));
    const up = [...c.ids].flatMap((i) => state.outages.upcoming.get(i) || []);
    out = cur.length
      ? `<ul class="outages">${cur.map((o) => `<li class="${o.type === 'EL' ? 'el' : ''}"><b>${kind(o)} out of service</b>${o.serving ? ': ' + esc(o.serving) : ''}<div class="sub">${esc(o.reason || 'Outage')}${o.eta ? ` · expected back ${esc(nyDate(o.eta))}` : ''}</div></li>`).join('')}</ul>`
      : '<div class="sub">All elevators and escalators in service.</div>';
    if (up.length) out += `<div class="sub upcoming">Planned: ${up.slice(0, 3).map((o) => `${kind(o).toLowerCase()} ${o.serving ? esc(o.serving) : esc(o.equipment)}${o.since ? ` from ${esc(nyDate(o.since))}` : ''}`).join('; ')}${up.length > 3 ? ` and ${up.length - 3} more` : ''}.</div>`;
  }
  return `<div class="dir">Accessibility</div>${status}${out}`;
}

function renderDetails() {
  const el = $('#details');
  const sel = state.selected;
  if (!sel) { el.hidden = true; return; }
  const now = Date.now() / 1000;
  el.hidden = false;
  if (sel.kind === 'station') {
    const st = complexOf(sel.id);
    const arr = stationArrivals(sel.id, now);
    const ids = [...st.ids];
    // alerts that name this station, with the direction they affect
    const here = state.alerts.filter((a) => ids.some((i) => a.stops.has(i)));
    const dirOf = (a) => { const ds = new Set(ids.map((i) => a.stops.get(i)).filter(Boolean)); return ds.size === 1 ? [...ds][0] : 'both'; };
    const lineAlerts = state.alerts.filter((a) => !here.includes(a) && !a.planned && a.rank >= 24 && st.routes.some((r) => a.routes.has(r)));
    const dirBlock = (d) => `<div class="dir">${DIR_LABEL[d]}</div><table>${arr[d].slice(0, 8).map((x) => arrivalRow(x, now)).join('') || '<tr><td class="muted">No trains in the next 45 min</td></tr>'}</table>`;
    el.innerHTML = `
      <div class="head"><div><h3>${esc(st.name)} ${isa(st.ada)}</h3><div class="sub">${routeBullets(st)}</div></div><button class="close" aria-label="Close">×</button></div>
      ${dirBlock('N')}${dirBlock('S')}
      <div class="sub" style="margin-top:6px">Live from MTA feeds${state.newest ? ' · ' + freshText() : ''}${isStale() ? ' · <span class="stale">may not be real time</span>' : ''}</div>
      ${accessibilityHtml(st)}
      ${here.length || lineAlerts.length ? `<div class="dir">Service alerts</div>${here.slice(0, 6).map((a) => alertHtml(a, ' · ' + DIR_LABEL[dirOf(a)], false)).join('')}${lineAlerts.slice(0, 3).map((a) => alertHtml(a, '', false)).join('')}` : ''}`;
  } else {
    const t = state.trips.get(sel.id);
    if (!t) { el.innerHTML = '<div class="head"><p class="muted">This trip has left the feed.</p><button class="close" aria-label="Close">×</button></div>'; return; }
    const where = trainWhere(t);
    const stale = t.vehicle?.ts && state.feedTime - t.vehicle.ts > 90;
    el.innerHTML = `
      <div class="head">${bullet(t.route)}<div><h3>to ${esc(destName(t))}</h3><div class="sub">${t.dir === 'N' ? 'Northbound' : 'Southbound'} · ${esc(t.trainId || t.id)}</div></div><button class="close" aria-label="Close">×</button></div>
      <div style="margin-bottom:6px">${t.assigned ? '<span class="tag">assigned</span>' : '<span class="tag">unassigned</span>'}${t.delayed ? '<span class="tag bad">delayed</span>' : ''}${stale ? '<span class="tag bad">not moving</span>' : ''}</div>
      <div class="sub" style="margin-bottom:6px">${where}${trainView.get(t.id)?.shape ? ` · est. ${Math.round(trainView.get(t.id).speed * 3600 / mapScale(trainView.get(t.id).x, trainView.get(t.id).z))} km/h` : ''}</div>
      <table>${t.stus.slice(0, 16).map((s) => `<tr class="click" data-station="${esc(s.parent)}"><td>${esc(net.stations.get(s.parent)?.name || s.stop)}${s.track ? ` <span class="tag">trk ${esc(s.track)}</span>` : ''}</td><td class="t">${mins(s.arr, now)} <span class="muted">${nyTime(s.arr).replace(/:\d\d /, ' ')}</span></td></tr>`).join('')}</table>
      <button class="act" id="follow">${state.follow ? 'Stop following' : 'Follow train'}</button>`;
  }
}

/** Where a train is, in words: between two stations, stopped at one, or waiting to depart. */
function trainWhere(t) {
  const v = trainView.get(t.id)?.pos;
  const name = (id) => `<b>${esc(net.stations.get(id)?.name || id)}</b>`;
  if (!v) return '';
  if (v.state === 'moving') return v.from ? `Between ${name(v.from)} and ${name(v.to)}` : `Approaching ${name(v.to)}`;
  if (v.state === 'stopped') return `Stopped at ${name(v.to)}`;
  if (v.state === 'origin') return `Waiting to depart ${name(v.to)}`;
  return `Next stop ${name(v.to)} (position estimated)`;
}

// countdown board floating above the selected station (or train) in the 3D view
const board = $('#board');
function renderBoard() {
  const sel = state.selected;
  if (sel?.kind === 'train') {
    const t = state.trips.get(sel.id);
    if (!t) { board.hidden = true; return; }
    const now = Date.now() / 1000, next = t.stus[0];
    board.innerHTML = `<div class="bhead brow">${bullet(t.route, 'sm')}<span class="bdest">to ${esc(destName(t))}</span></div>
      <div class="bwhere">${trainWhere(t)}</div>
      ${next ? `<div class="brow"><span class="bdest muted">Next: ${esc(net.stations.get(next.parent)?.name || next.stop)}</span><span class="bmin">${mins(next.arr, now)}</span></div>` : ''}`;
    board.hidden = false;
    return;
  }
  if (sel?.kind !== 'station') { board.hidden = true; return; }
  const st = complexOf(sel.id);
  const now = Date.now() / 1000;
  const arr = stationArrivals(sel.id, now, 30 * 60);
  const rows = (d) => arr[d].slice(0, 4).map((x) => `<div class="brow click" data-trip="${esc(x.t.id)}">${bullet(x.t.route, 'sm')}<span class="bdest">${esc(destName(x.t))}</span><span class="bmin">${mins(x.s.arr, now)}</span></div>`).join('') || '<div class="brow muted">—</div>';
  board.innerHTML = `<div class="bhead">${esc(st.name)}</div><div class="bdir">${DIR_LABEL.N}</div>${rows('N')}<div class="bdir">${DIR_LABEL.S}</div>${rows('S')}`;
  board.hidden = false;
}
function positionBoard() {
  const sel = state.selected;
  if (board.hidden || !sel) return;
  if (sel.kind === 'train') {
    const v = trainView.get(sel.id);
    if (!v) return;
    _v.set(v.x, v.y + tubeRadius.value * 2, v.z).project(camera);
  } else {
    const st = complexOf(sel.id);
    _v.set(st.x, complexTop(st) + tubeRadius.value * 2, st.z).project(camera);
  }
  if (_v.z > 1 || Math.abs(_v.x) > 1.2 || Math.abs(_v.y) > 1.2) { board.style.visibility = 'hidden'; return; }
  board.style.visibility = '';
  board.style.transform = `translate(${((_v.x + 1) / 2) * innerWidth}px, ${((1 - _v.y) / 2) * innerHeight}px) translate(-50%, calc(-100% - 14px))`;
}

function onPanelClick(e) {
  if (e.target.closest('.close')) { select(null); return; }
  if (e.target.id === 'follow') { state.follow = !state.follow; renderDetails(); return; }
  const tr = e.target.closest('[data-trip]');
  if (tr) { select({ kind: 'train', id: tr.dataset.trip }, { fly: true }); return; }
  const st = e.target.closest('[data-station]');
  if (st) select({ kind: 'station', id: st.dataset.station }, { fly: true });
}
$('#details').addEventListener('click', onPanelClick);
board.addEventListener('click', onPanelClick);

// ---------- camera flights ----------
let flight = null;
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
function flyTo(target, dist, seconds = 1.4) {
  atHome = false;
  const dir = camera.position.clone().sub(controls.target).normalize();
  if (dir.y < 0.45) { dir.y = 0.6; dir.normalize(); }
  flight = { t0: performance.now(), dur: seconds * 1000, fromT: controls.target.clone(), toT: target.clone(), fromP: camera.position.clone(), toP: target.clone().addScaledVector(dir, dist) };
}
function updateFlight() {
  if (!flight) return;
  const k = Math.min(1, (performance.now() - flight.t0) / flight.dur), e = ease(k);
  controls.target.lerpVectors(flight.fromT, flight.toT, e);
  camera.position.lerpVectors(flight.fromP, flight.toP, e);
  if (k >= 1) flight = null;
}
function flyToSelection() {
  const sel = state.selected;
  if (sel?.kind === 'station') {
    const st = complexOf(sel.id);
    flyTo(new THREE.Vector3(st.x, complexTop(st), st.z), 1.0);
  } else if (sel?.kind === 'train') {
    const v = trainView.get(sel.id);
    if (v) { flyTo(new THREE.Vector3(v.x, v.y, v.z), 0.7); state.follow = true; }
  }
}

// Home view: straight down, rotated like the MTA map, framing every station. On wide screens the
// network is fitted into the gap between the two side panels.
const HOME = { target: new THREE.Vector3(), pos: new THREE.Vector3() };
function computeHome() {
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const st of stationList) {
    const u = st.x * MAP_RIGHT.x + st.z * MAP_RIGHT.z, v = st.x * MAP_UP.x + st.z * MAP_UP.z;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  let left = 0, right = innerWidth;
  // fit between the panels that are open (collapsed, they only cover the top corners)
  if (innerWidth > 760) {
    if (menuEl.open) left = menuEl.getBoundingClientRect().right + 8;
    if (serviceEl.open || state.selected) right = $('#right').getBoundingClientRect().left - 8;
  }
  // too narrow a gap: fit the full width, then slide toward the gap as far as the screen allows
  const fitW = right - left >= innerWidth * 0.3 ? right - left : innerWidth, margin = 1.06;
  const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const d = Math.min(controls.maxDistance, Math.max(((v1 - v0) / 2) * margin / tan, ((u1 - u0) / 2) * margin * innerHeight / (tan * fitW)));
  const wpp = (2 * d * tan) / innerHeight;
  const wPx = ((u1 - u0) * margin) / wpp;
  const cx = wPx < innerWidth ? Math.min(innerWidth - wPx / 2, Math.max(wPx / 2, (left + right) / 2)) : innerWidth / 2;
  const cu = (u0 + u1) / 2 - (cx - innerWidth / 2) * wpp, cv = (v0 + v1) / 2;
  HOME.target.set(cu * MAP_RIGHT.x + cv * MAP_UP.x, 0, cu * MAP_RIGHT.z + cv * MAP_UP.z);
  // OrbitControls derives the azimuth from the camera offset, so it sits a hair off vertical,
  // on the side opposite screen-up.
  const phi = 1e-3;
  HOME.pos.set(HOME.target.x - MAP_UP.x * d * Math.sin(phi), d * Math.cos(phi), HOME.target.z - MAP_UP.z * d * Math.sin(phi));
}
function goHome() {
  select(null);
  computeHome();
  flight = { t0: performance.now(), dur: 1600, fromT: controls.target.clone(), toT: HOME.target.clone(), fromP: camera.position.clone(), toP: HOME.pos.clone() };
  atHome = true;
}
$('#overview').addEventListener('click', goHome);

// selected-station marker
const marker = new THREE.Mesh(new THREE.RingGeometry(1, 1.35, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: C.ink, side: THREE.DoubleSide }));
marker.visible = false;
scene.add(marker);
function updateMarker() {
  const sel = state.selected;
  marker.visible = sel?.kind === 'station';
  if (!marker.visible) return;
  const st = complexOf(sel.id);
  marker.position.set(st.x, complexTop(st) + tubeRadius.value * 1.3, st.z);
  marker.scale.setScalar(Math.max(0.03, tubeRadius.value * 4) * (1 + 0.12 * Math.sin(performance.now() / 250)));
}

function select(sel, { fly = false } = {}) {
  state.selected = sel;
  state.follow = false;
  renderDetails();
  renderBoard();
  updatePath();
  if (fly) flyToSelection();
}

// ---------- station search ----------
const searchEl = $('#search'), resultsEl = $('#results'), finderEl = $('#finder');
function openFinder() { menuEl.open = true; finderEl.open = true; searchEl.focus(); }
function closeFinder() { searchEl.value = ''; runSearch(); searchEl.blur(); finderEl.open = false; }
finderEl.addEventListener('toggle', () => { if (finderEl.open) searchEl.focus(); });
const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
let searchIndex = [];
function buildSearch() {
  // one entry per complex, searchable by any member's name
  searchIndex = [...net.complexes.values()].map((c) => ({ c, key: norm([...new Set(c.members.map((m) => m.name))].join(' ')) }))
    .sort((a, b) => a.c.name.localeCompare(b.c.name));
}
function runSearch() {
  const q = norm(searchEl.value);
  if (!q) { resultsEl.innerHTML = ''; return; }
  const hits = searchIndex.filter((x) => x.key.includes(q)).sort((a, b) => (b.key.startsWith(q) - a.key.startsWith(q)) || b.c.routes.length - a.c.routes.length).slice(0, 8);
  resultsEl.innerHTML = hits.map(({ c }) => {
    const rs = routesOf(c);
    return `<button class="result" data-station="${esc(c.members[0].id)}"><span class="rn">${esc(c.name)} ${isa(c.ada)}</span><span class="rb">${rs.length ? rs.map((r) => bullet(r, 'sm')).join('') : '<span class="muted">no late-night service</span>'}</span></button>`;
  }).join('') || '<div class="muted" style="padding:6px 0">No station found</div>';
}
searchEl.addEventListener('input', runSearch);
searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const first = resultsEl.querySelector('[data-station]'); if (first) first.click(); }
  if (e.key === 'Escape') { e.preventDefault(); closeFinder(); finderEl.querySelector('summary').focus(); }
});
resultsEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-station]');
  if (!b) return;
  select({ kind: 'station', id: b.dataset.station }, { fly: true });
  closeFinder();
});

// ---------- picking (screen space, forgiving at any zoom) ----------
const tooltip = $('#tooltip');
const toScreen = (x, y, z) => {
  _v.set(x, y, z).project(camera);
  return _v.z > 1 ? null : [((_v.x + 1) / 2) * innerWidth, ((1 - _v.y) / 2) * innerHeight];
};
function pick(cx, cy, touch = false) {
  // A train is hit anywhere along its body, from the lead car to the last, and wins over the
  // station symbols under it (a train standing at a platform covers them).
  let train = null, td = (touch ? 16 : 10) ** 2;
  for (const d of drawnTrains) {
    const a = toScreen(...d.head), b = toScreen(...d.tail);
    if (!a || !b) continue;
    const ex = b[0] - a[0], ey = b[1] - a[1], l = ex * ex + ey * ey || 1;
    const t = Math.max(0, Math.min(1, ((cx - a[0]) * ex + (cy - a[1]) * ey) / l));
    const dx = a[0] + t * ex - cx, dy = a[1] + t * ey - cy, dd = dx * dx + dy * dy;
    if (dd < td) { td = dd; train = { kind: 'train', id: d.id }; }
  }
  if (train) return train;
  let best = null, bd = (touch ? 20 : 14) ** 2;
  const test = (x, y, z, item) => {
    const p = toScreen(x, y, z);
    if (!p) return;
    const d = (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
    if (d < bd) { bd = d; best = item; }
  };
  for (const n of nodeList) {
    if (state.focusRoute && !routesOf(n.st).includes(state.focusRoute)) continue;
    test(n.x, n.y ?? heightOf(n.route), n.z, { kind: 'station', id: n.st.id });
  }
  return best;
}
let pointer = null, downAt = null;
canvas.addEventListener('pointermove', (e) => { pointer = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerleave', () => { pointer = null; tooltip.hidden = true; });
// a tap selects only if it was a single finger (a two-finger rotate or pinch never selects)
const touching = new Set();
let multiTouch = false;
canvas.addEventListener('pointerdown', (e) => {
  touching.add(e.pointerId);
  if (touching.size === 1) multiTouch = false; else multiTouch = true;
  downAt = { x: e.clientX, y: e.clientY }; flight = null;
});
for (const ev of ['pointerup', 'pointercancel']) canvas.addEventListener(ev, (e) => { queueMicrotask(() => touching.delete(e.pointerId)); });
canvas.addEventListener('wheel', () => { flight = null; }, { passive: true });
controls.addEventListener('start', () => { atHome = false; if (state.follow) { state.follow = false; renderDetails(); } });
canvas.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || multiTouch) return; // right-click turns the view; only a plain click or tap selects
  if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
  const hit = pick(e.clientX, e.clientY, e.pointerType === 'touch');
  select(hit, { fly: !!hit });
});
function updateHover() {
  if (!pointer) return;
  const hit = pick(pointer.x, pointer.y);
  canvas.style.cursor = hit ? 'pointer' : '';
  if (!hit) { tooltip.hidden = true; return; }
  let html;
  if (hit.kind === 'station') {
    const st = complexOf(hit.id);
    const now = Date.now() / 1000, arr = stationArrivals(hit.id, now, 30 * 60);
    const line = (d) => arr[d].length ? `<div class="trow"><span class="muted">${d === 'N' ? 'N' : 'S'}</span>${arr[d].slice(0, 3).map((x) => `${bullet(x.t.route, 'sm')}<span>${mins(x.s.arr, now)}</span>`).join('')}</div>` : '';
    const ada = st.ada ? `<div class="trow">${isa(st.ada)}<span>${ADA_TEXT[st.ada]}</span></div>` : '';
    const out = [...st.ids].some(hasElevatorOutage) ? '<div class="trow"><span class="warn-dot"></span><span>Elevator out of service</span></div>' : '';
    html = `<b>${esc(st.name)}</b><div class="row">${routeBullets(st)}</div>${line('N')}${line('S')}${ada}${out}<div class="muted" style="margin-top:3px">Click for live times</div>`;
  } else {
    const t = state.trips.get(hit.id);
    if (!t) return;
    html = `<div class="row" style="margin:0;align-items:center">${bullet(t.route, 'sm')} <b>to ${esc(destName(t))}</b></div><div class="muted">${trainWhere(t)}</div><div class="muted">next: ${esc(net.stations.get(t.stus[0].parent)?.name || '')} · ${mins(t.stus[0].arr, Date.now() / 1000)}</div><div class="muted" style="margin-top:3px">Click for its stops</div>`;
  }
  // only touch the DOM when the content changes; position follows the pointer
  if (tooltip._html !== html) { tooltip._html = html; tooltip.innerHTML = html; }
  tooltip.hidden = false;
  tooltip.style.left = Math.min(pointer.x + 14, innerWidth - 270) + 'px';
  tooltip.style.top = pointer.y + 14 + 'px';
}

// ---------- collapsible panels (all start closed) ----------
const narrow = () => innerWidth <= 760;
for (const [el, other] of [[menuEl, serviceEl], [serviceEl, menuEl]]) {
  el.addEventListener('toggle', () => {
    if (el.open && narrow()) other.open = false; // one panel at a time on a phone
  });
}
// on a phone, touching the map tucks the panels away
canvas.addEventListener('pointerdown', () => { if (narrow()) menuEl.open = serviceEl.open = false; });

// ---------- controls ----------
$('#spacing').addEventListener('input', (e) => { state.spacing = +e.target.value; layoutLines(); updatePath(); });
$('#show-trains').addEventListener('change', (e) => { state.showTrains = e.target.checked; });
$('#show-labels').addEventListener('change', (e) => { state.showLabels = e.target.checked; });
$('#show-waiting').addEventListener('change', (e) => { state.showWaiting = e.target.checked; });
$('#late-night').addEventListener('change', (e) => setNight(e.target.checked));
$('#accessible').addEventListener('change', (e) => setAda(e.target.checked));
addEventListener('keydown', (e) => {
  if (e.target === searchEl || e.target.matches?.('input[type=text], input[type=search], textarea')) return;
  if (e.key === 'Escape') { select(null); state.focusRoute = null; applyFocus(); }
  if (e.key === '/') { e.preventDefault(); openFinder(); }
});

// ---------- data refresh ----------
function renderLiveStatus() {
  if (!state.newest) return;
  const errs = state.feedErrors.length ? ` · ${state.feedErrors.length} feed(s) failed` : '';
  const stale = isStale();
  setStatus(`${state.moving} trains running · ${freshText()}${stale ? ' · may not be real time' : ''}${errs}`,
    state.feedErrors.length === TRIP_FEEDS.length ? 'error' : stale ? 'live stale' : 'live');
}
async function refreshTrips() {
  try {
    const { trips, feedTime, feedTimes, newest, errors } = await fetchTrips();
    let oldest = 0;
    if (!trips.size && errors.length === TRIP_FEEDS.length) throw new Error('all feeds failed');
    // a feed that fails once keeps its last trains for up to 5 minutes (flagged by the data age)
    // rather than wiping a whole line off the map
    const nowS = Date.now() / 1000;
    for (const name of errors) {
      const ts = state.feedTimes[name];
      if (!ts || nowS - ts > KEEP_FAILED_FEED_S) continue;
      for (const [id, t] of state.trips) if (t.feed === name && !trips.has(id)) trips.set(id, t);
      feedTimes[name] = ts;
    }
    for (const ts of Object.values(feedTimes)) if (ts) oldest = oldest ? Math.min(oldest, ts) : ts;
    state.trips = trips;
    state.feedTimes = feedTimes;
    state.feedTime = feedTime;
    state.oldest = oldest;
    state.newest = newest || feedTime;
    state.feedErrors = errors;
    // trains on the road: everything except trips still waiting to leave their terminal
    let moving = 0;
    const now = Date.now() / 1000;
    for (const t of trips.values()) if (placeTrip(net, t, now)?.state !== 'origin') moving++;
    state.moving = moving;
    if (state.revealClock < 0 && trips.size) state.revealClock = 0; // trains appear line by line
    renderLiveStatus();
    renderDetails();
    renderBoard();
    updatePath();
  } catch (err) {
    console.error(err);
    setStatus('Realtime feeds unavailable: ' + err.message, 'error');
  }
}
async function refreshAlerts() {
  try {
    state.alerts = await fetchAlerts();
    state.status = routeStatus(state.alerts);
    renderStatusBox();
    renderAlerts();
  } catch (err) {
    console.error(err);
    $('#alert-list').innerHTML = `<p class="muted">Alerts unavailable: ${esc(err.message)}</p>`;
  }
}
async function refreshOutages() {
  try {
    const o = await fetchOutages(net.elevators || {});
    state.outages = o;
    layoutAda();
    renderDetails();
  } catch (err) { console.error(err); }
}

// On a phone the station card covers the lower half of the screen, so the view is lifted
// (camera view offset) to put the orbit target in the middle of the map that is still visible.
let viewShift = 0;
const detailsEl = $('#details');
function updateViewOffset() {
  const want = innerWidth <= 760 && !detailsEl.hidden ? Math.round($('#right').getBoundingClientRect().height / 2) : 0;
  if (Math.abs(want - viewShift) < 0.5) return;
  viewShift += (want - viewShift) * 0.15;
  if (Math.abs(want - viewShift) < 0.5) viewShift = want;
  if (viewShift) camera.setViewOffset(innerWidth, innerHeight, 0, viewShift, innerWidth, innerHeight);
  else camera.clearViewOffset();
}

// ---------- zoom-dependent sizing ----------
function updateZoom() {
  updateViewOffset();
  const dist = camera.position.distanceTo(controls.target);
  // near plane follows the zoom: a fixed 50 m near plane leaves too little depth precision at
  // city scale and the overlapping lines shimmer
  const near = Math.min(1, Math.max(0.002, dist * 0.01));
  if (Math.abs(near - camera.near) / camera.near > 0.05) { camera.near = near; camera.updateProjectionMatrix(); }
  const k = Math.min(10, Math.max(0.35, dist / 3));
  const wpp = (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / innerHeight;
  if (state.wpp && Math.abs(k - state.zoomK) / state.zoomK < 0.004 && Math.abs(wpp - state.wpp) / state.wpp < 0.004) return;
  state.zoomK = k;
  state.wpp = wpp;
  // far out, parallel services touch like the map's bands, and lines never get thinner than ~3 px
  tubeRadius.value = Math.max(Math.min(0.065, Math.max(0.008, 0.022 * k)), wpp * (innerWidth <= 760 ? 2.2 : 3.0));
  scene.fog.near = Math.max(45, dist * 1.3);
  scene.fog.far = scene.fog.near + 75;
  layoutStations();
}

// ---------- main loop ----------
const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(0.1, clock.getDelta());
  updateFlight();
  updateZoom();
  updateTrains(dt);
  updateGlows(dt);
  if (state.follow && !flight && state.selected?.kind === 'train') {
    const v = trainView.get(state.selected.id);
    if (v) {
      const delta = _p.set(v.x, v.y, v.z).sub(controls.target).multiplyScalar(Math.min(1, dt * 3));
      controls.target.add(delta);
      camera.position.add(delta);
    }
  }
  tuneDamping();
  controls.update();
  updateLabels();
  updateHover();
  updateMarker();
  positionBoard();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
// text that ticks: countdowns and data age, once a second (also runs while rAF is paused)
function tick() {
  renderLiveStatus();
  renderDetails();
  renderBoard();
}

async function start() {
  net = await loadNetwork();
  for (const [color, ids] of Object.entries(MAP_COLORS)) {
    for (const id of ids) if (net.routes[id]) Object.assign(net.routes[id], { color, text: color === '#f8d64f' ? '#000000' : '#ffffff' });
  }
  nightSet = new Set(Object.entries(net.nightLines || {}).filter(([, s]) => s.length).map(([r]) => r));
  buildGround();
  buildLines();
  buildStations();
  buildLabels();
  buildTrains();
  buildLegend();
  buildSearch();
  setNight(state.night);
  setAda(state.ada);
  // open on the whole network as the printed map: overhead, flat, rotated like the MTA map
  computeHome();
  controls.target.copy(HOME.target);
  camera.position.copy(HOME.pos);
  controls.update();
  atHome = true;
  if (import.meta.env.DEV) {
    window.__subway = {
      state, trainView, get trains() { return trainRenderer; }, get drawn() { return drawnTrains; }, get glows() { return glowPool; }, get crossings() { return crossings; }, camera, controls, net, select, setNight, setAda, goHome,
      step(dt = 0.05) { updateFlight(); updateZoom(); updateTrains(dt); updateGlows(dt); tuneDamping(); controls.update(); updateLabels(); updateMarker(); renderBoard(); positionBoard(); renderer.render(scene, camera); },
    };
  }
  frame();
  setInterval(tick, 1000);
  setStatus('Connecting to MTA feeds…');
  refreshOutages();
  setInterval(refreshOutages, OUTAGE_REFRESH_MS);
  await initProtos();
  await Promise.all([refreshTrips(), refreshAlerts()]);
  setInterval(refreshTrips, TRIP_REFRESH_MS);
  setInterval(refreshAlerts, ALERT_REFRESH_MS);
}
start().catch((err) => { console.error(err); setStatus('Failed to start: ' + err.message, 'error'); });
