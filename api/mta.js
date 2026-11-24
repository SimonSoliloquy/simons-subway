// Server-side relay for the MTA subway feeds, with a short shared cache.
//
// The MTA data-feed terms do not allow an app to serve end users data directly from MTA
// servers, so the browser reads the feeds from here. Runs as a Vercel function in production
// and as Vite middleware in development (see vite.config.js), so it uses only Node's own
// request/response API.
import { brotliCompressSync, gzipSync, constants as zlib } from 'node:zlib';

const MTA = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/';
import { FEEDS } from '../src/mta-feeds.js';
export { FEEDS };

// the store apps (Capacitor) load the page from their own origin and read the feeds from here
const APP_ORIGINS = new Set(['capacitor://localhost', 'https://localhost', 'ionic://localhost']);

export default async function handler(req, res) {
  const origin = req.headers?.origin;
  res.setHeader('Vary', 'Origin');
  if (origin && APP_ORIGINS.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  const name = new URL(req.url, 'http://localhost').searchParams.get('feed');
  const feed = Object.hasOwn(FEEDS, name) ? FEEDS[name] : null;
  if (!feed) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Unknown feed');
    return;
  }
  try {
    const upstream = await fetch(MTA + feed.path, { signal: AbortSignal.timeout(8000) });
    if (!upstream.ok) throw new Error('MTA responded ' + upstream.status);
    let body = Buffer.from(await upstream.arrayBuffer());
    // the CDN does not compress protobuf itself, and the feeds shrink about 7x (gtfs: 400 KB -> 55 KB)
    const accept = String(req.headers?.['accept-encoding'] || '');
    res.setHeader('Vary', 'Origin, Accept-Encoding');
    if (/\bbr\b/.test(accept)) {
      body = brotliCompressSync(body, { params: { [zlib.BROTLI_PARAM_QUALITY]: 5 } });
      res.setHeader('Content-Encoding', 'br');
    } else if (/\bgzip\b/.test(accept)) {
      body = gzipSync(body, { level: 6 });
      res.setHeader('Content-Encoding', 'gzip');
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', feed.type);
    res.setHeader('Cache-Control', `public, max-age=0, s-maxage=${feed.ttl}, stale-while-revalidate=${feed.ttl * 2}`);
    res.end(body);
  } catch (err) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Cache-Control', 'no-store');
    res.end('MTA feed unavailable: ' + err.message);
  }
}
