// Decodes the MTA subway GTFS-realtime feeds in the browser.
// The feeds are public (no API key) and send `Access-Control-Allow-Origin: *`.
//
// Two protobuf roots are needed because gtfs-realtime-NYCT.proto and
// gtfs-realtime-service-status.proto both claim extension number 1001 on FeedHeader.
import protobuf from 'protobufjs';

const BASE = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/';
export const TRIP_FEEDS = ['gtfs', 'gtfs-ace', 'gtfs-bdfm', 'gtfs-g', 'gtfs-jz', 'gtfs-nqrw', 'gtfs-l', 'gtfs-si']
  .map((f) => BASE + 'nyct%2F' + f);
export const ALERT_FEED = BASE + 'camsys%2Fsubway-alerts';

const PROTO_DIR = import.meta.env.BASE_URL + 'proto/';
const EXT = (name) => '.transit_realtime.' + name;
const DECODE_OPTS = { longs: Number, enums: String, defaults: false };

async function loadRoot(file) {
  const root = new protobuf.Root();
  // imports are written as "com/google/transit/realtime/gtfs-realtime.proto"
  root.resolvePath = (_origin, target) => PROTO_DIR + target.replace(/^.*?(com\/google\/)/, 'com/google/');
  await root.load('com/google/transit/realtime/' + file, { keepCase: false });
  return root.lookupType('transit_realtime.FeedMessage');
}

let nyctType, mercuryType;
export async function initProtos() {
  [nyctType, mercuryType] = await Promise.all([
    loadRoot('gtfs-realtime-NYCT.proto'),
    loadRoot('gtfs-realtime-service-status.proto'),
  ]);
}

async function fetchFeed(url, type) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  return type.toObject(type.decode(buf), DECODE_OPTS);
}

const parentOf = (stopId) => stopId.replace(/[NS]$/, '');

/** All trips across the eight subway feeds. */
export async function fetchTrips() {
  const results = await Promise.allSettled(TRIP_FEEDS.map((u) => fetchFeed(u, nyctType)));
  const trips = new Map();
  const errors = [];
  let feedTime = 0;
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') { errors.push(TRIP_FEEDS[i].split('%2F')[1]); return; }
    const msg = r.value;
    feedTime = Math.max(feedTime, msg.header?.timestamp || 0);
    const get = (tripId) => {
      if (!trips.has(tripId)) trips.set(tripId, { id: tripId, stus: [], vehicle: null, delayed: false });
      return trips.get(tripId);
    };
    for (const e of msg.entity || []) {
      if (e.tripUpdate) {
        const td = e.tripUpdate.trip;
        const t = get(td.tripId);
        const nyct = td[EXT('nyctTripDescriptor')] || {};
        t.route = td.routeId;
        t.startDate = td.startDate;
        t.trainId = nyct.trainId || '';
        t.assigned = !!nyct.isAssigned;
        t.dir = nyct.direction === 'SOUTH' ? 'S' : 'N';
        t.stus = (e.tripUpdate.stopTimeUpdate || []).map((s) => {
          const ext = s[EXT('nyctStopTimeUpdate')] || {};
          return {
            stop: s.stopId,
            parent: parentOf(s.stopId),
            arr: s.arrival?.time || s.departure?.time || 0,
            dep: s.departure?.time || s.arrival?.time || 0,
            track: ext.actualTrack || ext.scheduledTrack || '',
          };
        });
      } else if (e.vehicle) {
        const t = get(e.vehicle.trip.tripId);
        t.vehicle = {
          status: e.vehicle.currentStatus || 'IN_TRANSIT_TO',
          stop: e.vehicle.stopId,
          parent: e.vehicle.stopId ? parentOf(e.vehicle.stopId) : null,
          ts: e.vehicle.timestamp || 0,
        };
      } else if (e.alert) {
        // NYCT trip-feed alerts are always "Train delayed" for a specific trip
        for (const ie of e.alert.informedEntity || []) if (ie.trip?.tripId) get(ie.trip.tripId).delayed = true;
      }
    }
  });
  for (const [id, t] of trips) if (!t.route || !t.stus.length) trips.delete(id);
  return { trips, feedTime, errors };
}

const en = (ts) => {
  const tr = ts?.translation || [];
  return (tr.find((t) => t.language === 'en') || tr.find((t) => !t.language?.includes('html')) || tr[0])?.text || '';
};

/** Active service alerts (Mercury extensions) from camsys/subway-alerts. */
export async function fetchAlerts() {
  const msg = await fetchFeed(ALERT_FEED, mercuryType);
  const now = Date.now() / 1000;
  const out = [];
  for (const e of msg.entity || []) {
    const a = e.alert;
    if (!a) continue;
    const periods = a.activePeriod || [];
    const active = !periods.length || periods.some((p) => (!p.start || p.start <= now) && (!p.end || p.end >= now));
    if (!active) continue;
    const merc = a[EXT('mercuryAlert')] || {};
    const routes = new Set(), stops = new Set();
    let priority = 0;
    for (const ie of a.informedEntity || []) {
      if (ie.routeId) routes.add(ie.routeId);
      if (ie.stopId) stops.add(parentOf(ie.stopId));
      const so = ie[EXT('mercuryEntitySelector')]?.sortOrder; // "MTASBWY:N:26" – last field is Priority enum
      if (so) priority = Math.max(priority, +so.split(':').pop() || 0);
    }
    out.push({
      id: e.id,
      type: merc.alertType || 'Alert',
      header: en(a.headerText),
      description: en(a.descriptionText),
      period: en(merc.humanReadableActivePeriod),
      updated: merc.updatedAt || merc.createdAt || 0,
      routes, stops, priority,
    });
  }
  out.sort((a, b) => b.priority - a.priority || b.updated - a.updated);
  return out;
}
