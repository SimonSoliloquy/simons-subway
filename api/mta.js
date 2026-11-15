// Server-side relay for the MTA subway feeds, with a short shared cache.
//
// The MTA data-feed terms do not allow an app to serve end users data directly from MTA
// servers, so the browser reads the feeds from here. Runs as a Vercel function in production
// and as Vite middleware in development (see vite.config.js), so it uses only Node's own
// request/response API.
const MTA = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/';
const trips = (name) => ({ path: 'nyct-v2%2F' + name, type: 'application/x-protobuf', ttl: 10 });

// feed name -> upstream path, content type, seconds the CDN may reuse a response
export const FEEDS = {
  gtfs: trips('gtfs'),
  'gtfs-ace': trips('gtfs-ace'),
  'gtfs-bdfm': trips('gtfs-bdfm'),
  'gtfs-g': trips('gtfs-g'),
  'gtfs-jz': trips('gtfs-jz'),
  'gtfs-nqrw': trips('gtfs-nqrw'),
  'gtfs-l': trips('gtfs-l'),
  alerts: { path: 'camsys%2Fsubway-alerts', type: 'application/x-protobuf', ttl: 20 },
  ene: { path: 'nyct%2Fnyct_ene.json', type: 'application/json', ttl: 60 },
};

export default async function handler(req, res) {
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
    const body = Buffer.from(await upstream.arrayBuffer());
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
