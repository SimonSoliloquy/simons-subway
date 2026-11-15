#!/bin/sh
# Download the source datasets into raw/ (then run `npm run data`).
set -e
cd "$(dirname "$0")/.."
mkdir -p raw && cd raw
curl -fSL -o gtfs_subway.zip https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip
rm -rf gtfs && unzip -q -o gtfs_subway.zip -d gtfs
# supplemented feed: hourly, includes the next 7 days of service changes (used only for train matching)
curl -fSL -o gtfs_supplemented.zip https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip
rm -rf gtfs_supplemented && unzip -q -o gtfs_supplemented.zip -d gtfs_supplemented
curl -fSL -o stations_ada.json 'https://data.ny.gov/resource/39hk-dx4f.json?$limit=1000'
curl -fSL -o ene_equipments.json 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene_equipments.json'
curl -fSL -o boroughs.geojson 'https://data.cityofnewyork.us/api/geospatial/gthc-hcne?method=export&format=GeoJSON'
curl -fSL -o parks.geojson 'https://data.cityofnewyork.us/resource/enfh-gkve.geojson?$where=acres%3E25&$limit=3000'
curl -fSL -o airports.geojson 'https://data.cityofnewyork.us/resource/6dic-zdhf.geojson?$limit=50'
curl -fSL -o counties.zip https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_500k.zip
rm -rf counties && unzip -q -o counties.zip -d counties
[ -f mta-gtfs-rt-reference.pdf ] || curl -fSL -o mta-gtfs-rt-reference.pdf https://www.mta.info/document/134521
echo "raw data ready; build with: npm run data"
