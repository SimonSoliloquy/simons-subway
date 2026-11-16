-- One row per ride on Simon's Subway. No accounts: the rider's page holds a random secret
-- (only its SHA-256 is stored) that lets it change the destination or end the ride. Rows are
-- kept, so a share link keeps working and shows the ride after it ends.
CREATE TABLE subway_rides (
  id          TEXT PRIMARY KEY,          -- short random id, the share link
  secret_hash TEXT NOT NULL,
  trip        TEXT NOT NULL,             -- GTFS-realtime trip id from the MTA feed
  route       TEXT NOT NULL,
  dir         TEXT,                      -- N | S
  terminal    TEXT,                      -- the trip's last stop (station id)
  start_station TEXT,                    -- where the train was when the ride began
  dest        TEXT,                      -- where the rider gets off (station id), optional
  status      TEXT NOT NULL DEFAULT 'active',  -- active | ended
  end_reason  TEXT,                      -- arrived | last_stop | got_off | stopped | left_feed | replaced | expired
  end_station TEXT,
  ip_hash     TEXT,
  created_at  INTEGER NOT NULL,          -- unix seconds
  updated_at  INTEGER NOT NULL,
  ended_at    INTEGER
);
CREATE INDEX subway_rides_ip ON subway_rides (ip_hash, created_at);
CREATE INDEX subway_rides_created ON subway_rides (created_at);
