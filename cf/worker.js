// Simon's Subway at https://simonsoliloquy.com/simons-subway/ on Cloudflare.
//
// The page and data are plain files (served free, no Worker code runs for them). Only
// /simons-subway/api/mta runs this code: the MTA feed relay that api/mta.js is on Vercel, with
// the same feeds and the same cache times (trip feeds 10 s: Simon ruled a longer cache would show
// trains up to 30 s late), kept in Cloudflare's cache so one MTA fetch serves every visitor.
//
// ⛔ Every request here spends the account's shared free allowance (100,000 Worker requests a day,
// shared with the games' leaderboards). An open, visible tab asks ~30 times a minute (7 trip feeds
// every 15 s, alerts every 30 s, elevators every 2 min), so each address is capped by the free
// rate-limit binding (FEEDS: 90 a minute, three times a normal tab) and gets 429 past it; a loop
// in the page or a stuck tab stops there instead of eating the day's allowance (2026-11-15).
import { FEEDS } from '../src/mta-feeds.js';

const MTA = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/';
const APP_ORIGINS = new Set(['capacitor://localhost', 'https://localhost', 'ionic://localhost']);

const text = (status, body, extra = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', ...extra } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.endsWith('/api/mta')) return env.ASSETS.fetch(request);
    const origin = request.headers.get('Origin');
    const cors = origin && APP_ORIGINS.has(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { Vary: 'Origin' };
    const name = url.searchParams.get('feed');
    const feed = Object.hasOwn(FEEDS, name) ? FEEDS[name] : null;
    if (!feed) return text(404, 'Unknown feed', cors);

    const who = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = env.FEEDS_LIMIT ? await env.FEEDS_LIMIT.limit({ key: who }) : { success: true };
    if (!success) return text(429, 'Too many requests: slow down', { ...cors, 'Retry-After': '60' });

    const cache = caches.default;
    const key = new Request(`https://cache.simons-subway/${name}`);
    let hit = await cache.match(key);
    if (!hit) {
      try {
        const upstream = await fetch(MTA + feed.path, { signal: AbortSignal.timeout(8000) });
        if (!upstream.ok) throw new Error('MTA responded ' + upstream.status);
        hit = new Response(await upstream.arrayBuffer(), {
          headers: { 'Content-Type': feed.type, 'Cache-Control': `public, max-age=${feed.ttl}` },
        });
        ctx.waitUntil(cache.put(key, hit.clone()));
      } catch (err) {
        return text(502, 'MTA feed unavailable: ' + err.message, cors);
      }
    }
    // Cloudflare does not compress protobuf on its own; the feeds shrink about 7x with gzip
    const gz = /\bgzip\b/.test(request.headers.get('Accept-Encoding') || '');
    const headers = {
      'Content-Type': feed.type, 'Cache-Control': 'public, max-age=0, must-revalidate',
      ...cors, Vary: 'Origin, Accept-Encoding',
    };
    if (!gz) return new Response(hit.body, { headers });
    return new Response(hit.body.pipeThrough(new CompressionStream('gzip')),
      { headers: { ...headers, 'Content-Encoding': 'gzip' }, encodeBody: 'manual' });
  },
};
