import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { loadNetwork, placeTrip, pointAt, offsetFlat, shapeSign } from './network.js';
import { TrainRenderer, consistOf } from './trains.js';
import { initProtos, fetchTrips, fetchAlerts } from './realtime.js';

const TRIP_REFRESH_MS = 30_000;
const ALERT_REFRESH_MS = 60_000;
const BASE_Y = 0.1;        // km above ground of the lowest route layer
const TUBE_R = 0.016;      // km
const LANE_W = 0.044;      // km between parallel services on a shared trunk
// Every service is its own line, side by side where services share a trunk (as on the MTA map).
const LANE_GROUPS = [['1', '2', '3'], ['4', '5', '6', '6X'], ['7', '7X'], ['A', 'C', 'E'], ['B', 'D', 'F', 'FX', 'M'], ['N', 'Q', 'R', 'W'], ['J', 'Z']];
const lane = new Map();    // route -> {slot, off}
for (const g of LANE_GROUPS) g.forEach((r, i) => lane.set(r, { slot: i, off: (i - (g.length - 1) / 2) * LANE_W }));
const laneOf = (r) => lane.get(r) || { slot: 0, off: 0 };
// Palette sampled from the MTA subway map (mta.info/map/5341, April 2026). Everything that
// carries one of these colours is drawn unlit so it renders at exactly that value.
const C = { water: 0xc8d6ed, land: 0xf9f0e3, park: 0xeaf1cf, airport: 0xd8c3a5, ink: 0x000000, grey: 0x939597, white: 0xffffff };
const MAP_COLORS = {
  '#2d69b1': ['A', 'C', 'E', 'SI'],
  '#ea9a40': ['B', 'D', 'F', 'FX', 'M'],
  '#aecd54': ['G'],
  '#a77639': ['J', 'Z'],
  '#939597': ['L', 'GS', 'FS', 'H'],
  '#f7d248': ['N', 'Q', 'R', 'W'],
  '#dc4c4a': ['1', '2', '3'],
  '#4aa363': ['4', '5', '6', '6X'],
  '#a64592': ['7', '7X'],
};
const VMAX = 0.025;        // km/s ≈ 90 km/h, a cap on catch-up speed

const $ = (s) => document.querySelector(s);
const state = {
  spacing: +$('#spacing').value,
  focusRoute: null,
  selected: null,          // {kind:'train', id} | {kind:'station', id}
  follow: false,
  showTrains: true, showLabels: true, showWaiting: false,
  timeScale: 1,
  zoomK: 0,
  trips: new Map(),
  alerts: [],
  feedTime: 0,
};

// ---------- renderer / scene ----------
const canvas = $('#scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.NoToneMapping;

const scene = new THREE.Scene();
scene.background = new THREE.Color(C.water);
scene.fog = new THREE.Fog(C.water, 45, 120);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture; // reflections on the stainless cars

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.05, 400);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 0.04;
controls.maxDistance = 120;
controls.screenSpacePanning = false;

// lighting kept near 1.0 on top faces so route colours render at their true values
scene.add(new THREE.HemisphereLight(0xffffff, 0xcfc6b0, 0.75));
const sun = new THREE.DirectionalLight(0xffffff, 0.4);
sun.position.set(-20, 40, 15);
scene.add(sun);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- helpers ----------
let net;
const routeColor = new Map();
const heightOf = (route) => BASE_Y + laneOf(route).slot * state.spacing;
const nyTime = (ts) => new Date(ts * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit' });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

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
  return esc(text).replace(/\[([A-Z0-9]{1,3})\]/g, (m, id) => {
    const key = id === 'S' ? 'GS' : id === 'SIR' ? 'SI' : id;
    const r = net.routes[key];
    return r ? `<span class="inline-bullet" style="background:${r.color};color:${r.text}">${esc(r.short === 'SIR' ? 'SI' : r.short.replace(/X$/, ''))}</span>` : m;
  });
}

// ---------- static scene ----------
const routeGroups = new Map();     // route -> Group of tubes
const routeMats = new Map();
const routeOffsetLines = new Map(); // route -> [flat offset polylines]
// Line thickness follows zoom: thinner up close, a bold map stroke far out.
// Tubes are built at TUBE_R and re-inflated in the vertex shader along their radial normals.
const tubeRadius = { value: TUBE_R };
function zoomableTube(mat, k = 1) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uRadius = tubeRadius;
    sh.vertexShader = 'uniform float uRadius;\n' + sh.vertexShader.replace('#include <begin_vertex>',
      `vec3 transformed = position + normal * (uRadius * ${k.toFixed(2)} - ${TUBE_R.toFixed(4)});`);
  };
  return mat;
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
  const layer = (polys, color, y, order) => {
    const geos = polys.map((rings) => {
      const shape = new THREE.Shape(toV(rings[0]));
      for (const h of rings.slice(1)) shape.holes.push(new THREE.Path(toV(h)));
      return new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
    });
    const mesh = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshBasicMaterial({ color, fog: true }));
    mesh.position.y = y;
    mesh.renderOrder = order;
    scene.add(mesh);
  };
  const water = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshBasicMaterial({ color: C.water }));
  water.rotation.x = -Math.PI / 2;
  water.position.y = -0.01;
  scene.add(water);
  layer(net.ground.land, C.land, 0, 1);
  layer(net.ground.parks, C.park, 0.002, 2);
  layer(net.ground.airports, C.airport, 0.002, 2);
}

function buildLines() {
  for (const [route, shapeIds] of Object.entries(net.lines)) {
    const color = new THREE.Color(net.routes[route].color);
    routeColor.set(route, color);
    const mat = zoomableTube(new THREE.MeshBasicMaterial({ color, transparent: true }));
    routeMats.set(route, mat);
    const group = new THREE.Group();
    const offs = [];
    routeOffsetLines.set(route, offs);
    for (const sid of shapeIds) {
      const flat = offsetFlat(net.shapes.get(sid).pts, laneOf(route).off * shapeSign(sid));
      offs.push(flat);
      const pts = [];
      for (let i = 0; i < flat.length; i += 2) pts.push(new THREE.Vector3(flat[i], 0, flat[i + 1]));
      if (pts.length < 2) continue;
      const curve = new PolylineCurve(pts);
      const segs = Math.min(4000, Math.max(32, Math.round(curve.total / 0.05)));
      group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, segs, TUBE_R, 6, false), mat));
    }
    group.userData.route = route;
    routeGroups.set(route, group);
    scene.add(group);
  }
}

// stations: a pillar from the ground up to the highest layer, and a node at each layer served
let pillarMesh, nodeMesh, nodeInner, stationList, nodeList;
function buildStations() {
  stationList = [...net.stations.values()];
  nodeList = [];
  for (const st of stationList) {
    for (const r of st.routes) {
      // a black stop dot sitting on each service's own (offset) line
      let bx = st.x, bz = st.z, bd = 0.25 ** 2;
      for (const flat of routeOffsetLines.get(r) || []) {
        for (let i = 0; i < flat.length; i += 2) {
          const d = (flat[i] - st.x) ** 2 + (flat[i + 1] - st.z) ** 2;
          if (d < bd) { bd = d; bx = flat[i]; bz = flat[i + 1]; }
        }
      }
      nodeList.push({ st, route: r, x: bx, z: bz });
    }
  }
  pillarMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.008, 0.008, 1, 6).translate(0, 0.5, 0),
    new THREE.MeshBasicMaterial({ color: C.grey, transparent: true, opacity: 0.6 }),
    stationList.length,
  );
  // map symbols: black dot = local stop; white circle with black outline = express & local stop
  const disc = new THREE.CylinderGeometry(1, 1, 1, 24).translate(0, 0.5, 0);
  nodeMesh = new THREE.InstancedMesh(disc, new THREE.MeshBasicMaterial({ color: C.ink }), nodeList.length);
  nodeInner = new THREE.InstancedMesh(disc, new THREE.MeshBasicMaterial({ color: C.white }), nodeList.length);
  for (const n of nodeList) n.express = n.st.routes.length > 1;
  scene.add(pillarMesh, nodeMesh, nodeInner);
  layoutStations();
}
function stationTop(st) { return Math.max(...st.routes.map(heightOf)); }
function layoutStations() {
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  stationList.forEach((st, i) => {
    const pr = tubeRadius.value * 0.35 / 0.008; // pillar thickness follows line weight
    m.compose(p.set(st.x, 0, st.z), q, s.set(pr, stationTop(st), pr));
    pillarMesh.setMatrixAt(i, m);
  });
  const r = tubeRadius.value, top = r * 1.02, t = r * 0.25;
  let w = 0;
  nodeList.forEach((n, i) => {
    const y = heightOf(n.route) + top;
    m.compose(p.set(n.x, y, n.z), q, s.set(r * (n.express ? 1.55 : 1.15), t, r * (n.express ? 1.55 : 1.15)));
    nodeMesh.setMatrixAt(i, m);
    if (n.express) {
      m.compose(p.set(n.x, y + t * 0.5, n.z), q, s.set(r * 1.05, t, r * 1.05));
      nodeInner.setMatrixAt(w++, m);
    }
  });
  nodeInner.count = w;
  pillarMesh.instanceMatrix.needsUpdate = nodeMesh.instanceMatrix.needsUpdate = nodeInner.instanceMatrix.needsUpdate = true;
}
function layoutLines() {
  for (const [route, g] of routeGroups) g.position.y = heightOf(route);
  layoutStations();
}

// labels for major stations
const labelEls = [];
function buildLabels() {
  const host = $('#labels');
  const major = stationList.filter((s) => s.routes.length >= 4 || /Terminal|Coney Island|St George|Jamaica Center|Flushing|Inwood|Van Cortlandt/.test(s.name));
  for (const b of net.ground.labels) {
    const el = document.createElement('div');
    el.className = 'label borough';
    el.textContent = b.name;
    host.appendChild(el);
    labelEls.push({ el, borough: b });
  }
  for (const st of major) {
    const el = document.createElement('div');
    el.className = 'label';
    el.textContent = st.name;
    host.appendChild(el);
    labelEls.push({ el, st });
  }
}
const _v = new THREE.Vector3();
function updateLabels() {
  const show = state.showLabels;
  for (const { el, st, borough } of labelEls) {
    if (!show) { el.style.display = 'none'; continue; }
    if (borough) _v.set(borough.pos[0], 0, borough.pos[1]); else _v.set(st.x, stationTop(st) + 0.08, st.z);
    const dist = _v.distanceTo(camera.position);
    _v.project(camera);
    const alpha = borough ? Math.min(1, Math.max(0, (dist - 4) / 6)) : Math.min(1, Math.max(0, (22 - dist) / 8));
    if (_v.z > 1 || alpha <= 0 || Math.abs(_v.x) > 1.1 || Math.abs(_v.y) > 1.1) { el.style.display = 'none'; continue; }
    el.style.display = '';
    el.style.opacity = alpha;
    el.style.transform = borough
      ? `translate(${((_v.x + 1) / 2) * innerWidth}px, ${((1 - _v.y) / 2) * innerHeight}px) translate(-50%, -50%)`
      : `translate(${((_v.x + 1) / 2) * innerWidth + 8}px, ${((1 - _v.y) / 2) * innerHeight - 7}px)`;
  }
}

// ---------- trains ----------
let trainRenderer;
const trainView = new Map();   // trip id -> {x,z,h,y,s,speed,shape,pos}
let drawnTrains = [];          // trip ids drawn this frame (for picking)
function buildTrains() { trainRenderer = new TrainRenderer(scene); }

const _p = new THREE.Vector3(), _c = new THREE.Color(), _sc = new THREE.Color(), _w = new THREE.Color(0xffffff);
function lerpAngle(a, b, t) { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return a + d * t; }

// Place each car of the consist on the track: position and heading come from the two bogie
// points, so the train bends through curves instead of sliding as a rigid block.
function consistCars(v, trip, len, lenK) {
  const cars = [];
  const { cars: n } = consistOf(trip.route);
  const L = len * lenK;
  if (v.shape) {
    const off = laneOf(trip.route).off * shapeSign(trip.pattern.shape);
    for (let i = 0; i < n; i++) {
      const c = v.s - (i + 0.5) * L;
      const [xf, zf] = pointAt(v.shape, c + L * 0.35), [xb, zb] = pointAt(v.shape, c - L * 0.35);
      const h = Math.atan2(zf - zb, xf - xb);
      cars.push({ x: (xf + xb) / 2 - Math.sin(h) * off, z: (zf + zb) / 2 + Math.cos(h) * off, y: v.y, h });
    }
  } else {
    for (let i = 0; i < n; i++) {
      const d = (i + 0.5) * L;
      cars.push({ x: v.x - Math.cos(v.h) * d, z: v.z - Math.sin(v.h) * d, y: v.y, h: v.h });
    }
  }
  return cars;
}

function updateTrains(dt) {
  const now = Date.now() / 1000;
  const k = Math.min(1, dt * 2.5);
  // Cars are drawn as symbols: R62 proportions, scaled with zoom so they stay legible
  // (about 1.5x real length up close, 6x at city scale), cross-section fattened further.
  const lenK = Math.min(4, Math.max(1, state.zoomK));          // never shorter than real
  const girth = lenK * 2;                                      // cars about as wide as their line
  drawnTrains = [];
  trainRenderer.begin();
  for (const trip of state.trips.values()) {
    const pos = placeTrip(net, trip, now);
    if (!pos) continue;
    const waiting = pos.state === 'origin' && !trip.vehicle;
    const sel = state.selected?.kind === 'train' && state.selected.id === trip.id;
    const visible = state.showTrains && (state.showWaiting || !waiting) && (!state.focusRoute || trip.route === state.focusRoute || sel);
    let v = trainView.get(trip.id);
    const y = heightOf(trip.route) + tubeRadius.value * 0.85; // riding on top of the line
    if (!v) { v = { x: pos.x, z: pos.z, h: pos.h, y, speed: 0 }; trainView.set(trip.id, v); }
    if (pos.shape) {
      // Drive along the real track: speed is chosen so the train reaches its next station at
      // the predicted arrival time (faster when behind the estimate, slower when ahead), and
      // the train holds still when the feed says it has stopped moving.
      const fresh = v.shape !== pos.shape || v.s === undefined;
      if (fresh || Math.abs(v.s - pos.sEst) > 2.5 || v.s > pos.sNext + 0.05 || (pos.sPrev !== undefined && v.s < pos.sPrev - 0.3)) {
        v.shape = pos.shape; v.s = pos.sEst; v.speed = 0;
      } else {
        const left = pos.sNext - v.s;
        const stalled = trip.vehicle?.ts && state.feedTime - trip.vehicle.ts > 90;
        const timeLeft = pos.state === 'moving' ? Math.max(4, pos.arr - now) : 3;
        const want = left <= 0 || stalled ? 0 : Math.min(VMAX, left / timeLeft);
        v.speed += (want - v.speed) * Math.min(1, dt * 1.5); // ease acceleration
        v.s = Math.min(pos.sNext, v.s + v.speed * dt * state.timeScale);
      }
      const [x, z, h] = pointAt(pos.shape, v.s);
      const off = laneOf(trip.route).off * shapeSign(trip.pattern.shape);
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
    const { len } = consistOf(trip.route);
    _c.set(waiting ? 0xe4e6e8 : 0x9aa1a8);
    if (trip.delayed && (now * 2) % 2 < 1) _c.set(0xdc4c4a);
    if (sel) _c.set(C.ink);
    _sc.copy(routeColor.get(trip.route) || _w);
    if (trip.delayed && (now * 2) % 2 < 1) _sc.set(0xdc4c4a);
    trainRenderer.add(consistCars(v, trip, len, lenK), len, lenK, girth * (sel ? 1.3 : 1), _c, _sc);
    drawnTrains.push(trip.id);
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
  const flat = offsetFlat(shape.pts.slice(2 * a, 2 * b + 2), laneOf(trip.route).off * shapeSign(p.shape));
  const pts = [];
  for (let i = 0; i < flat.length; i += 2) pts.push(new THREE.Vector3(flat[i], heightOf(trip.route), flat[i + 1]));
  if (pts.length < 2) return;
  const curve = new PolylineCurve(pts);
  pathMesh = new THREE.Mesh(
    new THREE.TubeGeometry(curve, Math.max(16, Math.round(curve.total / 0.05)), TUBE_R * 1.8, 8, false),
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
  document.querySelectorAll('#legend .bullet').forEach((b) => b.classList.toggle('on', b.dataset.route === state.focusRoute));
  $('#legend').classList.toggle('focused', !!state.focusRoute);
  renderAlerts();
}

// ---------- UI ----------
function buildLegend() {
  const host = $('#legend');
  const ids = Object.keys(net.lines).sort((a, b) => net.routes[a].sort - net.routes[b].sort);
  host.innerHTML = ids.map((r) => bullet(r).replace('<span class="bullet', `<button title="${esc(net.routes[r].long)}" data-route="${r}" class="bullet`).replace(/<\/span>$/, '</button>')).join('');
  host.addEventListener('click', (e) => {
    const b = e.target.closest('[data-route]');
    if (!b) return;
    state.focusRoute = state.focusRoute === b.dataset.route ? null : b.dataset.route;
    applyFocus();
  });
}

function setStatus(text, cls) {
  $('#status-text').textContent = text;
  $('#status').className = cls || '';
}

function renderAlerts() {
  const list = state.focusRoute ? state.alerts.filter((a) => a.routes.has(state.focusRoute)) : state.alerts;
  $('#alert-count').textContent = list.length ? `(${list.length})` : '';
  $('#alert-list').innerHTML = list.length ? list.slice(0, 60).map((a) => `
    <div class="alert">
      <div class="type ${a.priority >= 24 ? 'severe' : ''}">${esc(a.type)}${a.period ? ' · ' + esc(a.period) : ''}</div>
      <p>${richText(a.header)}</p>
      ${a.description ? `<details><summary>More</summary>${richText(a.description).replace(/\n/g, '<br>')}</details>` : ''}
    </div>`).join('') : '<p class="muted">No active alerts' + (state.focusRoute ? ' for this route' : '') + '.</p>';
}

const destName = (trip) => {
  const last = trip.pattern?.stops.at(-1) || trip.stus.at(-1)?.parent;
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
      if (s.arr >= now - 15 && s.arr - now < horizon) out[s.stop.endsWith('S') ? 'S' : 'N'].push({ t, s });
      break;
    }
  }
  out.N.sort((a, b) => a.s.arr - b.s.arr);
  out.S.sort((a, b) => a.s.arr - b.s.arr);
  return out;
}
const DIR_LABEL = { N: 'Northbound', S: 'Southbound' };
const complexOf = (stationId) => net.complexes.get(net.stations.get(stationId)?.complex);
const complexTop = (c) => Math.max(...c.members.map(stationTop));
const arrivalRow = ({ t, s }, now, cls = '') => `<tr class="click ${cls}" data-trip="${esc(t.id)}"><td class="b">${bullet(t.route, 'sm')}</td><td>${esc(destName(t))}${t.delayed ? ' <span class="tag bad">delayed</span>' : ''}</td><td class="t">${mins(s.arr, now)}</td></tr>`;

function renderDetails() {
  const el = $('#details');
  const sel = state.selected;
  if (!sel) { el.hidden = true; return; }
  const now = Date.now() / 1000;
  el.hidden = false;
  if (sel.kind === 'station') {
    const st = complexOf(sel.id);
    const arr = stationArrivals(sel.id, now);
    const alerts = state.alerts.filter((a) => [...st.ids].some((i) => a.stops.has(i)) || st.routes.some((r) => a.routes.has(r) && a.priority >= 24));
    const dirBlock = (d) => `<div class="dir">${DIR_LABEL[d]}</div><table>${arr[d].slice(0, 8).map((x) => arrivalRow(x, now)).join('') || '<tr><td class="muted">No trains in the next 45 min</td></tr>'}</table>`;
    el.innerHTML = `
      <div class="head"><div><h3>${esc(st.name)}</h3><div class="sub">${st.routes.map((r) => bullet(r, 'sm')).join(' ')}</div></div><button class="close" aria-label="Close">×</button></div>
      ${dirBlock('N')}${dirBlock('S')}
      <div class="sub" style="margin-top:6px">Live from MTA feeds · updated ${nyTime(state.feedTime)}</div>
      ${alerts.length ? `<div style="margin-top:8px">${alerts.slice(0, 4).map((a) => `<div class="alert"><div class="type ${a.priority >= 24 ? 'severe' : ''}">${esc(a.type)}</div><p>${richText(a.header)}</p></div>`).join('')}</div>` : ''}`;
  } else {
    const t = state.trips.get(sel.id);
    if (!t) { el.innerHTML = '<div class="head"><p class="muted">This trip has left the feed.</p><button class="close" aria-label="Close">×</button></div>'; return; }
    const v = trainView.get(t.id)?.pos;
    const where = !v ? '' : v.state === 'moving' ? `Between ${esc(net.stations.get(v.from)?.name)} and ${esc(net.stations.get(v.to)?.name)}` : v.state === 'stopped' ? `At ${esc(net.stations.get(v.to)?.name)}` : v.state === 'origin' ? `Waiting at ${esc(net.stations.get(v.to)?.name)}` : 'Position unknown (off-pattern)';
    const stale = t.vehicle?.ts && state.feedTime - t.vehicle.ts > 90;
    el.innerHTML = `
      <div class="head">${bullet(t.route)}<div><h3>to ${esc(destName(t))}</h3><div class="sub">${t.dir === 'N' ? 'Northbound' : 'Southbound'} · ${esc(t.trainId || t.id)}</div></div><button class="close" aria-label="Close">×</button></div>
      <div style="margin-bottom:6px">${t.assigned ? '<span class="tag">assigned</span>' : '<span class="tag">unassigned</span>'}${t.delayed ? '<span class="tag bad">delayed</span>' : ''}${stale ? '<span class="tag bad">not moving</span>' : ''}</div>
      <div class="sub" style="margin-bottom:6px">${where}${trainView.get(t.id)?.shape ? ` · est. ${Math.round(trainView.get(t.id).speed * 3600)} km/h` : ''}</div>
      <table>${t.stus.slice(0, 16).map((s) => `<tr class="click" data-station="${esc(s.parent)}"><td>${esc(net.stations.get(s.parent)?.name || s.stop)}${s.track ? ` <span class="tag">trk ${esc(s.track)}</span>` : ''}</td><td class="t">${mins(s.arr, now)} <span class="muted">${nyTime(s.arr).replace(/:\d\d /, ' ')}</span></td></tr>`).join('')}</table>
      <button class="act" id="follow">${state.follow ? 'Stop following' : 'Follow train'}</button>`;
  }
}

// countdown board floating above the selected station in the 3D view
const board = $('#board');
function renderBoard() {
  const sel = state.selected;
  if (sel?.kind !== 'station') { board.hidden = true; return; }
  const st = complexOf(sel.id);
  const now = Date.now() / 1000;
  const arr = stationArrivals(sel.id, now, 30 * 60);
  const rows = (d) => arr[d].slice(0, 4).map((x) => `<div class="brow click" data-trip="${esc(x.t.id)}">${bullet(x.t.route, 'sm')}<span class="bdest">${esc(destName(x.t))}</span><span class="bmin">${mins(x.s.arr, now)}</span></div>`).join('') || '<div class="brow muted">—</div>';
  board.innerHTML = `<div class="bhead">${esc(st.name)}</div><div class="bdir">${DIR_LABEL.N}</div>${rows('N')}<div class="bdir">${DIR_LABEL.S}</div>${rows('S')}`;
  board.hidden = false;
}
function positionBoard() {
  if (board.hidden || state.selected?.kind !== 'station') return;
  const st = complexOf(state.selected.id);
  _v.set(st.x, complexTop(st) + tubeRadius.value * 2, st.z).project(camera);
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
const HOME = { target: new THREE.Vector3(), pos: new THREE.Vector3() };
$('#overview').addEventListener('click', () => {
  select(null);
  flight = { t0: performance.now(), dur: 1600, fromT: controls.target.clone(), toT: HOME.target.clone(), fromP: camera.position.clone(), toP: HOME.pos.clone() };
});

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
const searchEl = $('#search'), resultsEl = $('#results');
const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
let searchIndex = [];
function buildSearch() {
  // one entry per complex, searchable by any member's name
  searchIndex = [...net.complexes.values()].map((c) => ({ st: { id: c.members[0].id, name: c.name, routes: c.routes }, key: norm([...new Set(c.members.map((m) => m.name))].join(' ')) }))
    .sort((a, b) => a.st.name.localeCompare(b.st.name));
}
function runSearch() {
  const q = norm(searchEl.value);
  if (!q) { resultsEl.innerHTML = ''; return; }
  const hits = searchIndex.filter((x) => x.key.includes(q)).sort((a, b) => (b.key.startsWith(q) - a.key.startsWith(q)) || b.st.routes.length - a.st.routes.length).slice(0, 8);
  resultsEl.innerHTML = hits.map(({ st }) => `<button class="result" data-station="${esc(st.id)}"><span>${esc(st.name)}</span><span class="rb">${st.routes.map((r) => bullet(r, 'sm')).join('')}</span></button>`).join('') || '<div class="muted" style="padding:6px 0">No station found</div>';
}
searchEl.addEventListener('input', runSearch);
searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const first = resultsEl.querySelector('[data-station]'); if (first) first.click(); }
  if (e.key === 'Escape') { searchEl.value = ''; runSearch(); searchEl.blur(); }
});
resultsEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-station]');
  if (!b) return;
  select({ kind: 'station', id: b.dataset.station }, { fly: true });
  searchEl.value = ''; runSearch();
});

// ---------- picking (screen space, forgiving at any zoom) ----------
const tooltip = $('#tooltip');
function pick(cx, cy) {
  let best = null, bd = 14 * 14;
  const test = (x, y, z, item, bias = 0) => {
    _v.set(x, y, z).project(camera);
    if (_v.z > 1) return;
    const dx = ((_v.x + 1) / 2) * innerWidth - cx, dy = ((1 - _v.y) / 2) * innerHeight - cy;
    const d = dx * dx + dy * dy - bias;
    if (d < bd) { bd = d; best = item; }
  };
  for (const id of drawnTrains) {
    const v = trainView.get(id);
    if (v) test(v.x, v.y, v.z, { kind: 'train', id }, 40);
  }
  for (const n of nodeList) {
    if (state.focusRoute && !n.st.routes.includes(state.focusRoute)) continue;
    test(n.x, heightOf(n.route), n.z, { kind: 'station', id: n.st.id });
  }
  return best;
}
let pointer = null, downAt = null;
canvas.addEventListener('pointermove', (e) => { pointer = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerleave', () => { pointer = null; tooltip.hidden = true; });
canvas.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; flight = null; });
canvas.addEventListener('wheel', () => { flight = null; }, { passive: true });
controls.addEventListener('start', () => { if (state.follow) { state.follow = false; renderDetails(); } });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
  const hit = pick(e.clientX, e.clientY);
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
    html = `<b>${esc(st.name)}</b><div class="row">${st.routes.map((r) => bullet(r, 'sm')).join('')}</div>${line('N')}${line('S')}<div class="muted" style="margin-top:3px">Click for live times</div>`;
  } else {
    const t = state.trips.get(hit.id);
    if (!t) return;
    html = `<div class="row" style="margin:0;align-items:center">${bullet(t.route, 'sm')} <b>to ${esc(destName(t))}</b></div><div class="muted">next: ${esc(net.stations.get(t.stus[0].parent)?.name || '')} · ${mins(t.stus[0].arr, Date.now() / 1000)}</div>`;
  }
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  tooltip.style.left = Math.min(pointer.x + 14, innerWidth - 270) + 'px';
  tooltip.style.top = pointer.y + 14 + 'px';
}

// ---------- controls ----------
$('#spacing').addEventListener('input', (e) => { state.spacing = +e.target.value; layoutLines(); updatePath(); });
$('#show-trains').addEventListener('change', (e) => { state.showTrains = e.target.checked; });
$('#show-labels').addEventListener('change', (e) => { state.showLabels = e.target.checked; });
$('#show-waiting').addEventListener('change', (e) => { state.showWaiting = e.target.checked; });
addEventListener('keydown', (e) => {
  if (e.target === searchEl) return;
  if (e.key === 'Escape') { select(null); state.focusRoute = null; applyFocus(); }
  if (e.key === '/') { e.preventDefault(); searchEl.focus(); }
});

// ---------- data refresh ----------
async function refreshTrips() {
  try {
    const { trips, feedTime, errors } = await fetchTrips();
    state.trips = trips;
    state.feedTime = feedTime;
    let moving = 0;
    for (const t of trips.values()) if (t.vehicle) moving++;
    setStatus(`${moving} trains running · ${trips.size} trips · ${nyTime(feedTime)}${errors.length ? ` · ${errors.length} feed(s) failed` : ''}`, errors.length === 8 ? 'error' : 'live');
    renderDetails();
    renderBoard();
    updatePath();
  } catch (err) {
    console.error(err);
    setStatus('Realtime feeds unavailable: ' + err.message, 'error');
  }
}
async function refreshAlerts() {
  try { state.alerts = await fetchAlerts(); renderAlerts(); } catch (err) { console.error(err); $('#alert-list').innerHTML = `<p class="muted">Alerts unavailable: ${esc(err.message)}</p>`; }
}

// ---------- zoom-dependent sizing ----------
function updateZoom() {
  const k = Math.min(10, Math.max(0.35, camera.position.distanceTo(controls.target) / 3));
  if (Math.abs(k - state.zoomK) / state.zoomK < 0.015) return;
  state.zoomK = k;
  tubeRadius.value = Math.min(LANE_W / 2, Math.max(0.0035, 0.0032 * k)); // far out, parallel services touch like the map's bands
  layoutStations();
}

// ---------- main loop ----------
const clock = new THREE.Clock();
let detailTimer = 0;
function frame() {
  const dt = Math.min(0.1, clock.getDelta());
  updateFlight();
  updateZoom();
  updateTrains(dt);
  if (state.follow && !flight && state.selected?.kind === 'train') {
    const v = trainView.get(state.selected.id);
    if (v) {
      const delta = _p.set(v.x, v.y, v.z).sub(controls.target).multiplyScalar(Math.min(1, dt * 3));
      controls.target.add(delta);
      camera.position.add(delta);
    }
  }
  controls.update();
  updateLabels();
  updateHover();
  updateMarker();
  positionBoard();
  if ((detailTimer += dt) > 1) { detailTimer = 0; renderDetails(); renderBoard(); } // live countdowns
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

async function start() {
  net = await loadNetwork();
  for (const [color, ids] of Object.entries(MAP_COLORS)) {
    for (const id of ids) if (net.routes[id]) Object.assign(net.routes[id], { color, text: color === '#f7d248' ? '#000000' : '#ffffff' });
  }
  buildGround();
  buildLines();
  buildStations();
  buildLabels();
  buildTrains();
  buildLegend();
  layoutLines();
  applyFocus();
  // open on lower Manhattan / downtown Brooklyn looking north
  const tsq = net.stations.get('127') || { x: 0, z: 0 };
  controls.target.set(tsq.x, 0, tsq.z + 2);
  camera.position.set(tsq.x + 6, 9, tsq.z + 16);
  HOME.target.copy(controls.target); HOME.pos.copy(camera.position);
  buildSearch();
  if (import.meta.env.DEV) window.__subway = { state, trainView, get trains() { return trainRenderer; }, camera, controls, net, select, step(dt = 0.05) { updateFlight(); updateZoom(); updateTrains(dt); controls.update(); updateLabels(); updateMarker(); renderBoard(); positionBoard(); renderer.render(scene, camera); } };
  frame();
  setStatus('Connecting to MTA feeds…');
  await initProtos();
  await Promise.all([refreshTrips(), refreshAlerts()]);
  setInterval(refreshTrips, TRIP_REFRESH_MS);
  setInterval(refreshAlerts, ALERT_REFRESH_MS);
}
start().catch((err) => { console.error(err); setStatus('Failed to start: ' + err.message, 'error'); });
