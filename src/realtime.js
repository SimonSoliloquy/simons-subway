// Decodes the MTA subway GTFS-realtime feeds in the browser.
//
// The bytes come from this site's own endpoint (`api/mta.js`, a short-lived cache in front of
// the MTA's public feeds) rather than from the MTA's servers directly: the MTA data-feed terms
// do not allow an app to hand end users data straight from MTA servers.
// Trip feeds are the v2 feeds (`nyct-v2/...`, Oct 2026): they also list the stops a train has
// already made, with actual times, which is what `trip.past` carries.
//
// Staten Island (gtfs-si, routes SI/SS) is deliberately not part of this map.
//
// Two protobuf roots are needed because gtfs-realtime-NYCT.proto and
// gtfs-realtime-service-status.proto both claim extension number 1001 on FeedHeader.
import protobuf from 'protobufjs';

const SITE = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/';
// the store apps bundle the page but read the feeds from the live site's relay
const API_ORIGIN = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_ORIGIN) || '';
const BASE = (API_ORIGIN ? API_ORIGIN + '/' : SITE) + 'api/mta?feed=';
export const TRIP_FEED_NAMES = ['gtfs', 'gtfs-ace', 'gtfs-bdfm', 'gtfs-g', 'gtfs-jz', 'gtfs-nqrw', 'gtfs-l'];
export const TRIP_FEEDS = TRIP_FEED_NAMES.map((f) => BASE + f);
export const ALERT_FEED = BASE + 'alerts';
export const OUTAGE_FEED = BASE + 'ene';

const PROTO_DIR = SITE + 'proto/';
const EXT = (name) => '.transit_realtime.' + name;
const DECODE_OPTS = { longs: Number, enums: String, defaults: false };

async function loadRoot(dir, file) {
  const root = new protobuf.Root();
  // imports are written as "com/google/transit/realtime/gtfs-realtime.proto"
  root.resolvePath = (_origin, target) => dir + target.replace(/^.*?(com\/google\/)/, 'com/google/');
  await root.load('com/google/transit/realtime/' + file, { keepCase: false });
  return root.lookupType('transit_realtime.FeedMessage');
}

let nyctType, mercuryType;
/** `dir` (optional, must end in "/") overrides where the .proto files are read from (Node tests). */
export async function initProtos(dir = PROTO_DIR) {
  [nyctType, mercuryType] = await Promise.all([
    loadRoot(dir, 'gtfs-realtime-NYCT.proto'),
    loadRoot(dir, 'gtfs-realtime-service-status.proto'),
  ]);
}

async function fetchFeed(url, type) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  return type.toObject(type.decode(buf), DECODE_OPTS);
}

const parentOf = (stopId) => stopId.replace(/[NS]$/, '');

/** All trips across the seven subway feeds (no Staten Island). */
export async function fetchTrips() {
  const results = await Promise.allSettled(TRIP_FEEDS.map((u) => fetchFeed(u, nyctType)));
  const trips = new Map();
  const errors = [];
  const feedTimes = {};
  let feedTime = 0, oldest = 0, newest = 0;
  results.forEach((r, i) => {
    const name = TRIP_FEED_NAMES[i];
    if (r.status !== 'fulfilled') { errors.push(name); return; }
    const msg = r.value;
    const ts = msg.header?.timestamp || 0;
    feedTimes[name] = ts;
    feedTime = Math.max(feedTime, ts);
    newest = Math.max(newest, ts);
    if (ts) oldest = oldest ? Math.min(oldest, ts) : ts;
    const get = (tripId) => {
      if (!trips.has(tripId)) trips.set(tripId, { id: tripId, feed: name, stus: [], vehicle: null, delayed: false });
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
            seq: s.stopSequence ?? -1,
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
          seq: e.vehicle.currentStopSequence ?? -1,
          parent: e.vehicle.stopId ? parentOf(e.vehicle.stopId) : null,
          ts: e.vehicle.timestamp || 0,
        };
      } else if (e.alert) {
        // NYCT trip-feed alerts are always "Train delayed" for a specific trip
        for (const ie of e.alert.informedEntity || []) if (ie.trip?.tripId) get(ie.trip.tripId).delayed = true;
      }
    }
  });
  for (const [id, t] of trips) {
    if (t.route) splitPastStops(t, feedTime);
    if (!t.route || !t.stus.length) trips.delete(id);
  }
  return { trips, feedTime, feedTimes, oldest, newest, errors };
}

/**
 * v2 feeds list every stop of the trip. Split them so `stus[0]` is the stop the train is
 * approaching or standing at (as in v1) and `past` holds the stops already made, whose times
 * are actual. The VehiclePosition says which stop is current; without one, fall back to time.
 */
export function splitPastStops(t, now) {
  const all = t.stus;
  let i = -1;
  if (t.vehicle?.stop) {
    i = all.findIndex((s) => s.stop === t.vehicle.stop && (t.vehicle.seq < 0 || s.seq < 0 || s.seq === t.vehicle.seq));
    if (i < 0) i = all.findIndex((s) => s.stop === t.vehicle.stop);
  }
  if (i < 0) i = all.findIndex((s) => (s.dep || s.arr) >= now - 30);
  if (i < 0) i = all.length; // every stop is behind the train: the trip is over
  t.past = all.slice(0, i);
  t.stus = all.slice(i);
}

// ---------------------------------------------------------------------------
// Alerts

/** Alert status by rank (index = rank 1..35); index 0 unused. */
export const STATUS_NAMES = [
  '', 'No Scheduled Service', 'Information Outage', 'Station Notice', 'Special Notice',
  'Weekday Schedule', 'Weekend Schedule', 'Saturday Schedule', 'Sunday Schedule',
  'Extra Service', 'Boarding Change', 'Special Schedule', 'Expect Delays', 'Reduced Service',
  'Planned - Express to Local', 'Planned - Extra Transfer', 'Planned - Stops Skipped',
  'Planned - Detour', 'Planned - Reroute', 'Planned - Substitute Buses',
  'Planned - Part Suspended', 'Planned - Suspended', 'Service Change', 'Planned Work',
  'Some Delays', 'Express to Local', 'Delays', 'Cancellations', 'Delays and Cancellations',
  'Stops Skipped', 'Severe Delays', 'Detour', 'Reroute', 'Substitute Buses',
  'Part Suspended', 'Suspended',
];

const en = (ts) => {
  const tr = ts?.translation || [];
  return (tr.find((t) => t.language === 'en') || tr.find((t) => !t.language?.includes('html')) || tr[0])?.text || '';
};

const SI_ROUTES = new Set(['SI', 'SS']);
const isSIStop = (id) => /^S\d/.test(id); // Staten Island Railway stop ids (S01..S31)

/**
 * Pure: turn a decoded camsys/subway-alerts message into the alert list.
 * `now` is unix seconds.
 */
export function normalizeAlerts(msg, now = Date.now() / 1000) {
  const out = [];
  for (const e of msg.entity || []) {
    const a = e.alert;
    if (!a) continue;
    const merc = a[EXT('mercuryAlert')] || {};

    // active now? (start widened by display_before_active)
    const periods = a.activePeriod || [];
    const before = merc.displayBeforeActive || 0;
    const active = !periods.length
      || periods.some((p) => (!p.start || p.start - before <= now) && (!p.end || p.end >= now));
    if (!active) continue;

    // "lmm:alert:532243:31" → 31. Planned-work ids ("lmm:planned_work:35778") carry no rank suffix.
    let idRank = +(String(e.id).match(/^[^:]+:[^:]+:\d+:(\d+)$/)?.[1]) || 0;
    if (idRank > 35) idRank = 0;
    const routes = new Set(), ranks = new Map(), stops = new Map();
    let maxRoute = 0;
    for (const ie of a.informedEntity || []) {
      if (ie.agencyId && ie.agencyId !== 'MTASBWY') continue;
      if (ie.routeId && SI_ROUTES.has(ie.routeId)) continue;
      const so = ie[EXT('mercuryEntitySelector')]?.sortOrder; // "MTASBWY:7:3" – last field is that route's rank
      const r = so ? (+so.split(':').pop() || 0) : 0;
      if (ie.routeId) {
        routes.add(ie.routeId);
        if (r) ranks.set(ie.routeId, Math.max(ranks.get(ie.routeId) || 0, r));
        maxRoute = Math.max(maxRoute, r);
      }
      if (ie.stopId) {
        if (isSIStop(ie.stopId)) continue;
        const id = parentOf(ie.stopId);
        // direction: GTFS directionId 0 = north, 1 = south; N/S suffix on the id also counts
        let d = ie.directionId === 0 ? 'N' : ie.directionId === 1 ? 'S' : 'both';
        if (d === 'both') { const m = ie.stopId.match(/([NS])$/); if (m) d = m[1]; }
        const prev = stops.get(id);
        stops.set(id, !prev || prev === d ? d : 'both');
      }
    }
    if (!routes.size && !stops.size) continue;

    const rank = Math.max(idRank, maxRoute);
    out.push({
      id: e.id,
      rank,
      type: merc.alertType || STATUS_NAMES[rank] || 'Alert',
      planned: rank > 0 && rank <= 23,
      header: en(a.headerText),
      description: en(a.descriptionText),
      period: en(merc.humanReadableActivePeriod),
      updated: merc.updatedAt || merc.createdAt || 0,
      routes, ranks, stops,
    });
  }
  // Mercury sends one entity per status for the same incident ("lmm:alert:276475:30" Severe Delays
  // on A/C and "lmm:alert:276475:26" Delays on F, same text): show it once, keeping each route's rank.
  const merged = [], byIncident = new Map();
  out.sort((a, b) => b.rank - a.rank || b.updated - a.updated);
  for (const a of out) {
    const key = /^[^:]+:alert:\d+:\d+$/.test(String(a.id)) ? String(a.id).replace(/:\d+$/, '') : null;
    const m = key && byIncident.get(key);
    if (!m || m.header !== a.header) { if (key && !m) byIncident.set(key, a); merged.push(a); continue; }
    for (const r of a.routes) {
      m.routes.add(r);
      const rank = a.ranks.get(r) ?? a.rank;
      if (rank > (m.ranks.get(r) ?? 0)) m.ranks.set(r, rank);
    }
    for (const [id, d] of a.stops) { const prev = m.stops.get(id); m.stops.set(id, !prev || prev === d ? d : 'both'); }
    m.updated = Math.max(m.updated, a.updated);
  }
  return merged;
}

/** Active service alerts (Mercury extensions) from camsys/subway-alerts. */
export async function fetchAlerts() {
  return normalizeAlerts(await fetchFeed(ALERT_FEED, mercuryType));
}

/** routeId → {type, rank, planned, count}: worst active alert per route; routes with none are absent. */
export function routeStatus(alerts) {
  const out = new Map();
  for (const a of alerts) {
    for (const route of a.routes) {
      const rank = a.ranks.get(route) ?? a.rank;
      const type = (a.ranks.has(route) && STATUS_NAMES[rank]) || a.type;
      const cur = out.get(route);
      if (!cur) out.set(route, { type, rank, planned: rank > 0 && rank <= 23, count: 1 });
      else {
        cur.count++;
        if (rank > cur.rank) { cur.type = type; cur.rank = rank; cur.planned = rank > 0 && rank <= 23; }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Elevator / escalator outages

const NY_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
});
function nyOffsetMs(utcMs) {
  const p = {};
  for (const x of NY_FMT.formatToParts(new Date(utcMs))) p[x.type] = +x.value;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}

/** "MM/DD/YYYY hh:mm:ss AM" in New York wall time → unix seconds (0 if blank/unparseable). */
export function parseNYTime(str) {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?/i.exec(str || '');
  if (!m) return 0;
  let h = +m[4] % 12;
  if (/p/i.test(m[7] || '')) h += 12;
  else if (!m[7]) h = +m[4];
  const wall = Date.UTC(+m[3], +m[1] - 1, +m[2], h, +m[5], +(m[6] || 0));
  let utc = wall - nyOffsetMs(wall);
  utc = wall - nyOffsetMs(utc); // second pass settles times near a DST switch
  return Math.round(utc / 1000);
}

/** Pure: JSON array from nyct_ene.json + static `elevators` table. */
export function normalizeOutages(rows, elevators) {
  const current = new Map(), upcoming = new Map();
  let unmatched = 0;
  for (const r of rows || []) {
    const info = elevators?.[r.equipment];
    if (!info) { unmatched++; continue; }
    const [stop, type] = info;
    const item = {
      equipment: r.equipment,
      type: r.equipmenttype === 'ES' ? 'ES' : r.equipmenttype === 'EL' ? 'EL' : type,
      serving: r.serving || info[2] || '',
      reason: r.reason || '',
      since: parseNYTime(r.outagedate),
      eta: parseNYTime(r.estimatedreturntoservice),
      ada: r.ADA ? r.ADA === 'Y' : !!info[3],
    };
    const map = r.isupcomingoutage === 'Y' ? upcoming : current;
    if (!map.has(stop)) map.set(stop, []);
    map.get(stop).push(item);
  }
  return { current, upcoming, unmatched };
}

/** Elevator/escalator outages. `elevators` = {equipmentno: [parentStopId, type, shortdescription, adaFlag]}. */
export async function fetchOutages(elevators) {
  const res = await fetch(OUTAGE_FEED, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${OUTAGE_FEED} → HTTP ${res.status}`);
  return normalizeOutages(await res.json(), elevators);
}
