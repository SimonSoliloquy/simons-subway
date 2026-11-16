# Simon's Subway

A geographically accurate 3D subway map in Three.js, styled after the current MTA subway map
(https://www.mta.info/map/5341: its exact land, water, park, airport and route colours, black stop
dots and white express-stop circles, Helvetica), with live trains from the MTA GTFS-realtime feeds
rendered as R62-style stainless consists.

Click a station (or press `/` to search) and the camera flies to it, with a live countdown board
in the scene and full northbound / southbound arrivals in the side panel; station complexes such as
Union Sq or Times Sq are merged so every line is shown. Click an arrival to jump to and follow that
train; click a train's upcoming stop to jump to that station.

```bash
npm install
npm run dev        # http://localhost:5191
```

The processed data in `public/data/` is committed, so the app runs without the raw downloads.
To rebuild it: `npm run fetch` (downloads the sources into `raw/`), then `npm run data`.

## Data

- **Static** (`npm run fetch`, then `npm run data`):
  - MTA regular subway GTFS (`gtfs_subway.zip`): the lines drawn, station routes and late-night
    service (trips starting 00:30–04:30). As on the MTA map, the standard map shows a route at a stop
    only with at least 6 scheduled daytime (7 AM–7 PM) trips there, so late-night-only stops (the 2
    at 86 St) and one-off moves (an R to 96 St) are left off; live trains on them are still placed.
  - MTA supplemented GTFS (`gtfs_supplemented.zip`, refreshed hourly by the MTA with the next seven
    days of service changes): extra stopping patterns so rerouted live trains can be placed. Where a
    reroute's stops do not lie on its shape (the MTA often gives it the usual shape, or none), the
    build stitches a shape from the regular track between each pair of stops.
  - NY Open Data `39hk-dx4f` (station accessibility) and the MTA elevator/escalator equipment list.
  - Ground layers: NYC Open Data (`gthc-hcne` boroughs, `enfh-gkve` parks, `6dic-zdhf` airports) and
    US Census `cb_2023_us_county_500k` for the neighbouring shoreline (needs `pyshp` in `.venv`).
  - Staten Island Railway is deliberately left out.
- **Realtime**, all through this site's own relay `api/mta.js` (a Vercel function; the same handler
  is mounted by Vite in development). The MTA data-feed terms do not allow an app to hand end users
  data straight from MTA servers, so the browser never calls the MTA directly.
  - Trips: the seven v2 subway feeds (`nyct-v2/gtfs…`), polled every 15 s. v2 lists the stops a
    train has already made with actual times.
  - Alerts: `camsys/subway-alerts` (protobuf with Mercury extensions), every 30 s. Line status
    follows the MTA "service status box" rule: the highest-ranked active alert per line.
  - Elevator and escalator outages: `nyct/nyct_ene.json`, every 2 min.
  - Protos are in `public/proto/` (`gtfs-realtime-NYCT.proto` for trips,
    `gtfs-realtime-service-status.proto` for alerts; separate roots, both claim extension 1001).
- `raw/mta-gtfs-rt-reference.pdf` is the NYCT GTFS-realtime reference (mta.info document 134521).
  Feed changes are announced on the MTA developer Google Group and in `nymta/gtfs-documentation`.

Not affiliated with or endorsed by the MTA. The MTA asks for a licence to use its logos, maps and
symbols in public apps; this project uses none of its artwork or logo, but the styling follows its map.

## How train positions are estimated

NYCT feeds carry no coordinates, only stops and times. Each live trip is matched to a static
stopping pattern by its stop sequence (live trip ids often don't match the schedule). The train
then drives along the real track shape from the station it last left (actual departure time, from
the v2 feed) toward the next one, at whatever speed gets it there at the predicted arrival time:
faster when behind the estimate, slower when ahead, capped at ~90 km/h. It holds still once the
VehiclePosition timestamp is over 90 s old (the MTA's own "not moving" rule). See `placeTrip` in
`src/network.js` and `updateTrains` in `src/main.js`.

## Scale

Track and stations are at true positions. Lines and trains are drawn as symbols whose size follows
zoom: up close the cars are true length, and at city scale they are enlarged and parallel services
touch like the bands on the printed map. Same-trunk services (A/C/E, B/D/F/M…) are offset side by side, and the
"Layer height" slider can also stack them vertically.

## Rides

Tap a train and choose **I'm on this train**, or pick your line under **On a train?** in the menu.
The ride card shows a live strip map of the stops to your stop, takes an optional stop to get off at
(alerts at the stop before and on arrival, while the page is open), and **Share tracker** sends a
link (`?ride=<id>`) that opens the same train for anyone.

Rides are kept by a small Cloudflare Worker in `worker/` (`simons-subway-rides`) in the shared
`leaderboards` D1 database, table `subway_rides`, with its own migrations table so it never touches
the games' tables or migration history. No accounts: the rider's page holds a random secret (only its
hash is stored) that lets it change the stop or end the ride. The ride's train glows gold on the map
for the rider and for anyone who opens the link. A ride ends when the train reaches the
rider's stop, reaches its last stop, leaves the feed, or the rider taps **I got off**; any page
watching the ride can report the first three. Open rides end on their own after 4 hours. Rows are
kept, so a link keeps working and shows the previous ride after it ends. If the Worker is unreachable, sharing falls back to `?trip=<trip id>&to=<stop>`.

    cd worker
    npx wrangler d1 migrations apply leaderboards --remote   # create the table
    npx wrangler deploy
    # local: npx wrangler d1 migrations apply leaderboards --local && npx wrangler dev --port 18797,
    # then run the site with VITE_RIDES_API=http://localhost:18797/rides
