-- Delay history collected from GTFS-RT TripUpdates (coach services only).
--
-- Keyed by source ids (route, trip, stop sequence), with no foreign keys to trip/service: a schedule
-- re-import deletes and recreates those rows, which must not erase the history. Stations persist
-- across imports, so they keep their FK.

CREATE TABLE delay_observation (
  source_id        text NOT NULL REFERENCES data_source(id) ON DELETE CASCADE,
  source_trip_id   text NOT NULL,
  service_date     date NOT NULL,
  source_sequence  integer NOT NULL,
  source_route_id  text NOT NULL,
  station_id       text NOT NULL REFERENCES station(id) ON DELETE CASCADE,
  scheduled_at     timestamptz NOT NULL,
  -- Last reported or predicted delay at the stop (arrival delay, else departure delay).
  delay_seconds    integer NOT NULL,
  observed_at      timestamptz NOT NULL,
  PRIMARY KEY (source_id, source_trip_id, service_date, source_sequence)
);
CREATE INDEX delay_observation_station_idx ON delay_observation (station_id);
CREATE INDEX delay_observation_scheduled_idx ON delay_observation (scheduled_at);

-- Never populated or read by any code so far; redefined so that it survives schedule re-imports.
DROP TABLE delay_stat;
CREATE TABLE delay_stat (
  source_id       text NOT NULL REFERENCES data_source(id) ON DELETE CASCADE,
  source_route_id text NOT NULL,
  station_id      text NOT NULL REFERENCES station(id) ON DELETE CASCADE,
  samples         integer NOT NULL,
  p50_seconds     integer NOT NULL,
  p90_seconds     integer NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, source_route_id, station_id)
);
