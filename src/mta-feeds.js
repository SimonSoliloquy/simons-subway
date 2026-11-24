// The MTA feeds the relay serves: feed name -> upstream path, content type, seconds a response
// may be reused. Shared by api/mta.js (Vercel, dev server) and cf/worker.js (Cloudflare).
const trips = (name) => ({ path: 'nyct-v2%2F' + name, type: 'application/x-protobuf', ttl: 10 });

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
