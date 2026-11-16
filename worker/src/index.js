// Simon's Subway rides: "I'm on this train", shared by link. One row per ride in the shared D1.
//
//   POST /rides                {trip, route, dir, terminal, start?, dest?}  -> {id, secret, ride}
//   GET  /rides/:id                                                  -> ride
//   POST /rides/:id            {secret, dest}                        change where the rider gets off
//   POST /rides/:id/end        {reason, station?, secret?}           end the ride
//
// A ride ends when the train reaches the rider's stop, when it reaches its last stop, or when the
// rider says so. The first two are seen by whichever page is watching (the rider's, or anyone's
// with the link), so they need only the ride id; ending by hand needs the rider's secret.
// Rides left open end on their own after RIDE_TTL. Rows are kept, so a link keeps showing the ride
// after it ends.

const ORIGINS = [
  /^https:\/\/simons-subway(-[a-z0-9-]+)?\.vercel\.app$/,
  /^http:\/\/(localhost|127\.0\.0\.1):\d+$/,
];
const RIDE_TTL = 4 * 3600;          // seconds
const CREATES_PER_HOUR = 30;        // per address
const OPEN_REASONS = new Set(['arrived', 'last_stop', 'left_feed']);
const SECRET_REASONS = new Set(['got_off', 'stopped', 'replaced']);
const PUBLIC = 'id, trip, route, dir, terminal, start_station, dest, status, end_reason, end_station, created_at, updated_at, ended_at';

class BadInput extends Error {}
const str = (v, re, name, optional = false) => {
  if (v == null || v === '') { if (optional) return null; throw new BadInput(`${name} is required`); }
  if (typeof v !== 'string' || !re.test(v)) throw new BadInput(`bad ${name}`);
  return v;
};
const TRIP = /^[\w.~+-]{1,64}$/, ROUTE = /^[0-9A-Z]{1,3}$/, STOP = /^[0-9A-Z]{1,8}$/, ID = /^[0-9a-zA-Z]{10}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const allowed = !!origin && ORIGINS.some((re) => re.test(origin));
    const cors = allowed ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { Vary: 'Origin' };
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: allowed ? 204 : 403, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });
    }
    const [root, id, action, ...rest] = url.pathname.split('/').filter(Boolean);
    if (root !== 'rides' || rest.length) return reply(404, { error: 'not found' });
    try {
      const now = Math.floor(Date.now() / 1000);
      if (!id) {
        if (request.method !== 'POST') return reply(405, { error: 'use POST' });
        if (!allowed) return reply(403, { error: 'origin not allowed' });
        return await create(env.DB, await body(request), request, now, reply);
      }
      str(id, ID, 'ride id');
      if (!action && request.method === 'GET') {
        const ride = await load(env.DB, id, now);
        return ride ? reply(200, ride) : reply(404, { error: 'no such ride' });
      }
      if (request.method !== 'POST') return reply(405, { error: 'use POST' });
      if (!allowed) return reply(403, { error: 'origin not allowed' });
      const b = await body(request);
      if (!action) return await update(env.DB, id, b, now, reply);
      if (action === 'end') return await end(env.DB, id, b, now, reply);
      return reply(404, { error: 'not found' });
    } catch (err) {
      if (err instanceof BadInput) return reply(400, { error: err.message });
      console.error(err);
      return reply(500, { error: 'server error' });
    }
  },
};

async function body(request) {
  const text = await request.text();
  if (text.length > 2000) throw new BadInput('body too large');
  try {
    const b = JSON.parse(text);
    if (b && typeof b === 'object' && !Array.isArray(b)) return b;
  } catch { /* fall through */ }
  throw new BadInput('body must be a JSON object');
}

async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
function randomId(n) {
  const abc = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => abc[b % 62]).join('');
}

async function create(db, b, request, now, reply) {
  const trip = str(b.trip, TRIP, 'trip'), route = str(b.route, ROUTE, 'route');
  const dir = b.dir === 'N' || b.dir === 'S' ? b.dir : null;
  const terminal = str(b.terminal, STOP, 'terminal', true), dest = str(b.dest, STOP, 'dest', true), start = str(b.start, STOP, 'start', true);
  const ipHash = await sha256('subway-rides:' + (request.headers.get('CF-Connecting-IP') || ''));
  const recent = await db.prepare('SELECT count(*) AS n FROM subway_rides WHERE ip_hash = ? AND created_at > ?').bind(ipHash, now - 3600).first('n');
  if (recent >= CREATES_PER_HOUR) return reply(429, { error: 'too many rides from this address, try again later' });
  const id = randomId(10), secret = randomId(24);
  await db.prepare(`INSERT INTO subway_rides (id, secret_hash, trip, route, dir, terminal, start_station, dest, ip_hash, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, await sha256(secret), trip, route, dir, terminal, start, dest, ipHash, now, now).run();
  return reply(201, { id, secret, ride: await load(db, id, now) });
}

/** The public view of a ride; an open ride past its time is closed on the way out. */
async function load(db, id, now) {
  const ride = await db.prepare(`SELECT ${PUBLIC} FROM subway_rides WHERE id = ?`).bind(id).first();
  if (ride && ride.status === 'active' && now - ride.created_at > RIDE_TTL) {
    await db.prepare("UPDATE subway_rides SET status = 'ended', end_reason = 'expired', ended_at = ?, updated_at = ? WHERE id = ? AND status = 'active'").bind(now, now, id).run();
    Object.assign(ride, { status: 'ended', end_reason: 'expired', ended_at: now, updated_at: now });
  }
  return ride;
}

async function checkSecret(db, id, secret) {
  if (typeof secret !== 'string' || secret.length !== 24) return false;
  const h = await db.prepare('SELECT secret_hash FROM subway_rides WHERE id = ?').bind(id).first('secret_hash');
  return !!h && h === await sha256(secret);
}

async function update(db, id, b, now, reply) {
  if (!await checkSecret(db, id, b.secret)) return reply(403, { error: 'only the rider can change this ride' });
  const dest = str(b.dest, STOP, 'dest', true);
  await db.prepare("UPDATE subway_rides SET dest = ?, updated_at = ? WHERE id = ? AND status = 'active'").bind(dest, now, id).run();
  const ride = await load(db, id, now);
  return ride ? reply(200, ride) : reply(404, { error: 'no such ride' });
}

async function end(db, id, b, now, reply) {
  const reason = b.reason;
  if (!OPEN_REASONS.has(reason) && !SECRET_REASONS.has(reason)) throw new BadInput('bad reason');
  if (SECRET_REASONS.has(reason) && !await checkSecret(db, id, b.secret)) return reply(403, { error: 'only the rider can end this ride' });
  const station = str(b.station, STOP, 'station', true);
  await db.prepare("UPDATE subway_rides SET status = 'ended', end_reason = ?, end_station = ?, ended_at = ?, updated_at = ? WHERE id = ? AND status = 'active'")
    .bind(reason, station, now, now, id).run();
  const ride = await load(db, id, now);
  return ride ? reply(200, ride) : reply(404, { error: 'no such ride' });
}
