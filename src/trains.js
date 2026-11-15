// Procedural NYCT subway cars, after the R62/R62A: brushed stainless body, dark window band,
// three door pairs per side, dark end bonnets with storm door and headlights.
// A train is rendered as its full consist, each car placed along the track so trains bend
// through curves. Geometry is built in "car units": length 1 along x, so instances scale by
// the real car length (51 ft A division, 60 ft B division).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const H = 0.235, W = 0.169; // R62: 51 ft x 8.6 ft x 12 ft
const MAX_CARS = 8000;
const FT = 0.0003048; // km

// consist lengths (best guesses at typical current consists)
const CONSIST = { GS: [6, 51], FS: [2, 75], H: [4, 75], G: [5, 75], L: [8, 60], '7': [11, 51], '7X': [11, 51] };
const A_DIV = new Set(['1', '2', '3', '4', '5', '6', '6X']);
export function consistOf(route) {
  const [n, ft] = CONSIST[route] || (A_DIV.has(route) ? [10, 51] : [10, 60]);
  return { cars: n, len: ft * FT };
}

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function sideTexture() {
  return canvasTex(1024, 240, (g, w, h) => {
    const steel = g.createLinearGradient(0, 0, 0, h);
    steel.addColorStop(0, '#e3e6e9'); steel.addColorStop(0.5, '#c4c9ce'); steel.addColorStop(1, '#9aa1a8');
    g.fillStyle = steel; g.fillRect(0, 0, w, h);
    g.fillStyle = '#7d848b'; g.fillRect(0, 0, w, h * 0.05);             // roof seam
    // lower-body flutes
    g.strokeStyle = 'rgba(80,88,96,.35)'; g.lineWidth = 1;
    for (let y = h * 0.6; y < h * 0.9; y += 6) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    // window band between doors
    const doors = [0.17, 0.5, 0.83], dw = 0.078;
    const win = (x0, x1) => {
      const gr = g.createLinearGradient(0, h * 0.17, 0, h * 0.5);
      gr.addColorStop(0, '#3c4650'); gr.addColorStop(1, '#151a1f');
      g.fillStyle = gr;
      const n = Math.max(1, Math.round((x1 - x0) / 0.11));
      const pw = (x1 - x0) / n;
      for (let i = 0; i < n; i++) g.fillRect((x0 + i * pw + 0.008) * w, h * 0.17, (pw - 0.016) * w, h * 0.33);
    };
    let prev = 0.02;
    for (const d of doors) { win(prev, d - dw / 2 - 0.01); prev = d + dw / 2 + 0.01; }
    win(prev, 0.98);
    // doors
    for (const d of doors) {
      const x = (d - dw / 2) * w, dwp = dw * w;
      g.fillStyle = '#b3b9bf'; g.fillRect(x, h * 0.1, dwp, h * 0.86);
      g.strokeStyle = '#4a5157'; g.lineWidth = 2; g.strokeRect(x, h * 0.1, dwp, h * 0.86);
      g.beginPath(); g.moveTo(x + dwp / 2, h * 0.1); g.lineTo(x + dwp / 2, h * 0.96); g.stroke();
      g.fillStyle = '#1a2026';
      g.fillRect(x + dwp * 0.12, h * 0.2, dwp * 0.3, h * 0.28);
      g.fillRect(x + dwp * 0.58, h * 0.2, dwp * 0.3, h * 0.28);
    }
    g.fillStyle = '#2a2e33'; g.fillRect(0, h * 0.95, w, h * 0.05);     // underframe
  });
}

function endTexture() {
  return canvasTex(256, 360, (g, w, h) => {
    g.fillStyle = '#2b3036'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#c3c8cd'; g.fillRect(0, 0, w * 0.08, h); g.fillRect(w * 0.92, 0, w * 0.08, h);
    g.fillStyle = '#11161b';
    g.fillRect(w * 0.38, h * 0.14, w * 0.24, h * 0.36);                 // storm door window
    g.fillRect(w * 0.12, h * 0.16, w * 0.2, h * 0.24);
    g.fillRect(w * 0.68, h * 0.16, w * 0.2, h * 0.24);
    g.strokeStyle = '#596067'; g.lineWidth = 3; g.strokeRect(w * 0.35, h * 0.1, w * 0.3, h * 0.86);
    g.fillStyle = '#fff6d8';
    for (const x of [0.2, 0.8]) { g.beginPath(); g.arc(w * x, h * 0.62, w * 0.04, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = '#b8292f';
    for (const x of [0.2, 0.8]) { g.beginPath(); g.arc(w * x, h * 0.72, w * 0.025, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = '#16191c'; g.fillRect(0, h * 0.9, w, h * 0.1);
  });
}

// Route sign in the lead car's front window: the route bullet (circle, or diamond for express
// variants) on the dark glass, drawn once per route.
function signTexture(label, color, text, express) {
  return canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = '#0d1114'; g.fillRect(0, 0, w, h);
    g.fillStyle = color;
    g.beginPath();
    if (express) { g.moveTo(w / 2, 6); g.lineTo(w - 6, h / 2); g.lineTo(w / 2, h - 6); g.lineTo(6, h / 2); g.closePath(); }
    else g.arc(w / 2, h / 2, w * 0.44, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = text;
    g.font = `bold ${label.length > 1 ? 54 : 76}px Helvetica, Arial, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(label, w / 2, h / 2 + 5);
  });
}

// Direction arrow on the roof of the lead cars: a chevron pointing the way the train is going.
function chevronGeometry() {
  const sh = new THREE.Shape();
  sh.moveTo(0.5, 0); sh.lineTo(-0.5, 0.5); sh.lineTo(-0.18, 0); sh.lineTo(-0.5, -0.5); sh.closePath();
  return new THREE.ShapeGeometry(sh).rotateX(-Math.PI / 2);
}

export class TrainRenderer {
  /** routeInfo(route) -> {label, color, text, express} for the front-window sign. */
  constructor(scene, routeInfo) {
    this.scene = scene;
    this.routeInfo = routeInfo;
    this.signs = new Map(); // route -> {front, rear, side} InstancedMeshes with that route's sign
    // Route signs at true size on the model: in the front window of the lead car, the rear
    // window of the last car, and a small sign in a side window near each end of every car.
    const SZ = W * 0.4, SIDE = 0.042, y = H * 0.7;
    this.signGeo = {
      front: new THREE.PlaneGeometry(SZ, SZ).rotateY(Math.PI / 2).translate(0.5025, y, 0),
      rear: new THREE.PlaneGeometry(SZ, SZ).rotateY(-Math.PI / 2).translate(-0.5025, y, 0),
      side: mergeGeometries([
        new THREE.PlaneGeometry(SIDE, SIDE).translate(0.36, y, W / 2 + 0.004),
        new THREE.PlaneGeometry(SIDE, SIDE).rotateY(Math.PI).translate(-0.36, y, -W / 2 - 0.004),
      ]),
    };
    this.signMax = { front: 600, rear: 600, side: MAX_CARS };
    // route-colour stripe: a belt band along both sides at the window sill, and a strip down the
    // middle of the roof (what you see from above); the rest of the car stays stainless
    const band = () => new THREE.BoxGeometry(0.97, H * 0.09, 0.006);
    const stripeGeo = mergeGeometries([
      band().translate(0, H * 0.56, W / 2 + 0.003),
      band().translate(0, H * 0.56, -W / 2 - 0.003),
      new THREE.BoxGeometry(0.9, 0.006, W * 0.34).translate(0, H + 0.015, 0),
    ]);
    this.stripe = new THREE.InstancedMesh(stripeGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_CARS);
    const chev = chevronGeometry();
    this.arrowEdge = new THREE.InstancedMesh(chev, new THREE.MeshBasicMaterial({ color: 0xffffff }), 3000);
    this.arrow = new THREE.InstancedMesh(chev, new THREE.MeshBasicMaterial({ color: 0xffffff }), 3000); // coloured per train
    const side = new THREE.MeshStandardMaterial({ map: sideTexture(), metalness: 0.55, roughness: 0.38 });
    const end = new THREE.MeshStandardMaterial({ map: endTexture(), metalness: 0.3, roughness: 0.5 });
    const roof = new THREE.MeshStandardMaterial({ color: 0x8f969d, metalness: 0.4, roughness: 0.6 });
    const under = new THREE.MeshBasicMaterial({ color: 0x1b1e21 });
    const bodyGeo = new THREE.BoxGeometry(0.985, H, W).translate(0, H / 2, 0);
    this.body = new THREE.InstancedMesh(bodyGeo, [end, end, roof, under, side, side], MAX_CARS);
    // roof panel (grey; red when delayed, black when selected) + lit route sign on the leading end
    this.roof = new THREE.InstancedMesh(new THREE.BoxGeometry(0.9, 0.012, W * 0.7).translate(0, H + 0.006, 0), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAX_CARS);
    for (const m of [this.body, this.roof, this.stripe, this.arrow, this.arrowEdge]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      scene.add(m);
    }
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }
  begin() { this.nc = 0; this.na = 0; for (const set of this.signs.values()) for (const m of Object.values(set)) m.count = 0; }
  signMesh(route) {
    let set = this.signs.get(route);
    if (!set) {
      const info = this.routeInfo(route);
      const mat = new THREE.MeshBasicMaterial({ map: signTexture(info.label, info.color, info.text, info.express) });
      set = {};
      for (const k of ['front', 'rear', 'side']) {
        const m = new THREE.InstancedMesh(this.signGeo[k], mat, this.signMax[k]);
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        m.frustumCulled = false;
        m.count = 0;
        this.scene.add(m);
        set[k] = m;
      }
      this.signs.set(route, set);
    }
    return set;
  }
  putSign(m, k, tint) {
    if (m.count >= this.signMax[k]) return;
    m.setMatrixAt(m.count, this._m); m.setColorAt(m.count, tint); m.count++;
  }
  /** cars: [{x,y,z,h}] lead car first; len: real car length (km); girth: cross-section multiplier;
   *  tall: extra height on top of girth, so trains stand up from the line in a tilted view;
   *  route: for the front sign; tint: sign tint (white, or red when delayed);
   *  arrow: {len, width, color} of the direction chevron on the lead cars' roof (km);
   *  stripe: route colour for the side and roof stripe. */
  add(cars, len, lenK, girth, color, route, tint, tall = 1, arrow = null, stripe = null) {
    for (let i = 0; i < cars.length && this.nc < MAX_CARS; i++) {
      const c = cars[i];
      this._q.setFromAxisAngle(this._up, -c.h);
      this._m.compose(this._p.set(c.x, c.y, c.z), this._q, this._s.set(len * lenK, len * girth * tall, len * girth));
      this.body.setMatrixAt(this.nc, this._m);
      this.roof.setMatrixAt(this.nc, this._m);
      this.roof.setColorAt(this.nc, color);
      this.stripe.setMatrixAt(this.nc, this._m);
      this.stripe.setColorAt(this.nc, stripe || color);
      this.nc++;
      const set = this.signMesh(route);
      this.putSign(set.side, 'side', tint);
      if (i === 0) this.putSign(set.front, 'front', tint);
      if (i === cars.length - 1) this.putSign(set.rear, 'rear', tint);
    }
    const c = cars[0];
    if (arrow && c && this.na < 3000) {
      // tip at the front of the train, lying on the roof of the lead car(s)
      const L = len * lenK, fx = Math.cos(c.h), fz = Math.sin(c.h);
      const back = L / 2 - arrow.len * 0.6; // just behind the cab end
      const top = c.y + len * girth * tall * (H + 0.02); // above the roof strip
      const e = arrow.width * 0.02;
      this._q.setFromAxisAngle(this._up, -c.h);
      this._p.set(c.x + fx * back, top + e, c.z + fz * back);
      this._m.compose(this._p, this._q, this._s.set(arrow.len * 1.18, 1, arrow.width * 1.2));
      this.arrowEdge.setMatrixAt(this.na, this._m);
      this._p.y = top + 2 * e;
      this._m.compose(this._p, this._q, this._s.set(arrow.len, 1, arrow.width));
      this.arrow.setMatrixAt(this.na, this._m);
      this.arrow.setColorAt(this.na, arrow.color);
      this.na++;
    }
  }
  end() {
    this.body.count = this.roof.count = this.stripe.count = this.nc;
    this.arrow.count = this.arrowEdge.count = this.na;
    for (const m of [this.body, this.roof, this.stripe, this.arrow, this.arrowEdge, ...[...this.signs.values()].flatMap(Object.values)]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }
}
