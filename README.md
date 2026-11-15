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

- **Static** — `raw/gtfs_subway.zip` (MTA static GTFS, https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip);
  ground layers from NYC Open Data (`gthc-hcne` boroughs, `enfh-gkve` parks, `6dic-zdhf` airports)
  and US Census `cb_2023_us_county_500k` for the neighbouring NJ / NY shoreline. `npm run data`
  regenerates `public/data/subway.json` and `public/data/ground.json` (needs `pyshp` in `.venv`).
- **Realtime** — the eight `nyct/gtfs-*` trip feeds and `camsys/subway-alerts`, fetched directly
  from the browser (public, no key, CORS open) and decoded with protobufjs using the protos in
  `public/proto/` (`gtfs-realtime-NYCT.proto` for trips, `gtfs-realtime-service-status.proto`
  for alerts; they need separate roots because both claim extension 1001).
- `raw/mta-gtfs-rt-reference.pdf` is the NYCT GTFS-realtime reference (mta.info document 134521).

## How train positions are estimated

NYCT feeds carry no coordinates, only the remaining stops with predicted times
(`raw/mta-gtfs-rt-reference.pdf`). Each live trip is matched to a static stopping pattern by its
stop sequence (live trip_ids often don't match the schedule). The train then drives along the real
track shape at whatever speed gets it to the next station at the predicted arrival time: faster when
behind the estimate, slower when ahead, capped at ~90 km/h, and it holds still once the
VehiclePosition timestamp is over 90 s old (the MTA's own "not moving" rule). See
`placeTrip` in `src/network.js` and `updateTrains` in `src/main.js`.

## Scale

Track and stations are at true positions. Lines and trains are drawn as symbols whose size follows
zoom: up close the cars are true length, and at city scale they are enlarged and parallel services
touch like the bands on the printed map. Same-trunk services (A/C/E, B/D/F/M…) are offset side by side, and the
"Layer height" slider can also stack them vertically.
