-- OpenBus Planner schema v1
-- Conventions: text ids are stable internal identifiers (see @openbus/core/ids).
-- Every timetable row belongs to a data_source, so provenance is never lost.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------- geography

CREATE TABLE country (
  code       char(2) PRIMARY KEY,
  name       text NOT NULL,
  timezone   text NOT NULL
);

CREATE TABLE city (
  id           text PRIMARY KEY,
  name         text NOT NULL,
  country_code char(2) REFERENCES country(code),
  geom         geography(Point, 4326) NOT NULL,
  timezone     text NOT NULL,
  size         text NOT NULL DEFAULT 'small',
  origin       text NOT NULL DEFAULT 'gazetteer' CHECK (origin IN ('gazetteer', 'derived'))
);
CREATE INDEX city_geom_idx ON city USING gist (geom);

-- Physical stops after entity resolution. Never merged by name alone.
CREATE TABLE station (
  id                   text PRIMARY KEY,
  name                 text NOT NULL,
  normalized_name      text NOT NULL,
  city_id              text REFERENCES city(id),
  country_code         char(2) REFERENCES country(code),
  lat                  double precision NOT NULL,
  lon                  double precision NOT NULL,
  geom                 geography(Point, 4326) NOT NULL,
  timezone             text NOT NULL,
  kind                 text NOT NULL DEFAULT 'stop' CHECK (kind IN ('bus_station', 'rail_station', 'stop')),
  min_transfer_seconds integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX station_geom_idx ON station USING gist (geom);
CREATE INDEX station_city_idx ON station (city_id);
CREATE INDEX station_name_trgm_idx ON station USING gin (normalized_name gin_trgm_ops);

-- Platforms / bays / entrances belonging to a station, when feeds provide them.
CREATE TABLE stop_point (
  id            text PRIMARY KEY,
  station_id    text NOT NULL REFERENCES station(id) ON DELETE CASCADE,
  name          text NOT NULL,
  platform_code text,
  lat           double precision NOT NULL,
  lon           double precision NOT NULL
);
CREATE INDEX stop_point_station_idx ON stop_point (station_id);

-- Multilingual and operator-specific names for cities and stations.
CREATE TABLE place_alias (
  id          bigserial PRIMARY KEY,
  city_id     text REFERENCES city(id) ON DELETE CASCADE,
  station_id  text REFERENCES station(id) ON DELETE CASCADE,
  alias       text NOT NULL,
  normalized  text NOT NULL,
  origin      text NOT NULL,
  CHECK ((city_id IS NULL) <> (station_id IS NULL))
);
CREATE UNIQUE INDEX place_alias_city_uq ON place_alias (city_id, normalized) WHERE city_id IS NOT NULL;
CREATE UNIQUE INDEX place_alias_station_uq ON place_alias (station_id, normalized) WHERE station_id IS NOT NULL;
CREATE INDEX place_alias_trgm_idx ON place_alias USING gin (normalized gin_trgm_ops);

-- ---------------------------------------------------------------- sources

CREATE TABLE data_source (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  kind          text NOT NULL,          -- gtfs-schedule, gtfs-realtime, manual-json, netex, ...
  adapter       text NOT NULL,          -- adapter implementation id
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  synthetic     boolean NOT NULL DEFAULT false,
  enabled       boolean NOT NULL DEFAULT true,
  priority      integer NOT NULL DEFAULT 0,
  license       text,
  license_url   text,
  attribution   text,
  homepage      text,
  refresh_hours integer,
  registry      jsonb,                  -- research record from data/source-registry.json
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE import_run (
  id            bigserial PRIMARY KEY,
  source_id     text NOT NULL REFERENCES data_source(id) ON DELETE CASCADE,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text NOT NULL CHECK (status IN ('running', 'success', 'skipped_unchanged', 'failed')),
  content_hash  text,
  feed_version  text,
  valid_from    date,
  valid_to      date,
  stats         jsonb,
  warnings      jsonb,
  message       text
);
CREATE INDEX import_run_source_idx ON import_run (source_id, started_at DESC);

CREATE TABLE source_health (
  id          bigserial PRIMARY KEY,
  source_id   text NOT NULL REFERENCES data_source(id) ON DELETE CASCADE,
  checked_at  timestamptz NOT NULL DEFAULT now(),
  ok          boolean NOT NULL,
  latency_ms  integer,
  message     text
);
CREATE INDEX source_health_idx ON source_health (source_id, checked_at DESC);

-- Mapping of feed stop ids to stations (entity resolution result, kept across re-imports).
CREATE TABLE source_stop (
  source_id        text NOT NULL REFERENCES data_source(id) ON DELETE CASCADE,
  source_stop_id   text NOT NULL,
  station_id       text NOT NULL REFERENCES station(id),
  stop_point_id    text REFERENCES stop_point(id) ON DELETE SET NULL,
  name             text NOT NULL,
  lat              double precision NOT NULL,
  lon              double precision NOT NULL,
  zone_id          text,
  match_method     text NOT NULL,      -- existing_mapping | code | proximity_name | proximity | new
  match_confidence real NOT NULL,
  PRIMARY KEY (source_id, source_stop_id)
);
CREATE INDEX source_stop_station_idx ON source_stop (station_id);

-- ---------------------------------------------------------------- operators & services

CREATE TABLE operator (
  id                 text PRIMARY KEY,
  name               text NOT NULL,
  normalized_name    text NOT NULL UNIQUE,
  website            text,
  country_code       char(2),
  synthetic          boolean NOT NULL DEFAULT false,
  -- Booking: template with {from},{to},{date} placeholders only if an operator documents one.
  booking_url_template text,
  booking_link_kind  text NOT NULL DEFAULT 'operator_homepage'
    CHECK (booking_link_kind IN ('departure_specific', 'route_search', 'operator_homepage', 'none'))
);

CREATE TABLE source_operator (
  source_id        text NOT NULL REFERENCES data_source(id) ON DELETE CASCADE,
  source_agency_id text NOT NULL,
  operator_id      text NOT NULL REFERENCES operator(id),
  PRIMARY KEY (source_id, source_agency_id)
);

CREATE TABLE service (
  id               text PRIMARY KEY,
  source_id        text NOT NULL REFERENCES data_source(id) ON DELETE CASCADE,
  operator_id      text NOT NULL REFERENCES operator(id),
  source_route_id  text NOT NULL,
  short_name       text,
  long_name        text,
  route_type       integer NOT NULL,
  mode             text NOT NULL CHECK (mode IN ('bus', 'rail', 'other')),
  url              text
);
CREATE INDEX service_source_idx ON service (source_id);

CREATE TABLE service_calendar (
  id          text PRIMARY KEY,
  source_id   text NOT NULL REFERENCES data_source(id) ON DELETE CASCADE,
  source_service_id text NOT NULL,
  weekdays    smallint NOT NULL DEFAULT 0,  -- bit 0 = Monday ... bit 6 = Sunday
  start_date  date,
  end_date    date
);

CREATE TABLE calendar_exception (
  calendar_id text NOT NULL REFERENCES service_calendar(id) ON DELETE CASCADE,
  date        date NOT NULL,
  added       boolean NOT NULL,
  PRIMARY KEY (calendar_id, date)
);

-- Materialised operating dates (calendar + exceptions), for fast window loading.
CREATE TABLE calendar_active_date (
  calendar_id text NOT NULL REFERENCES service_calendar(id) ON DELETE CASCADE,
  date        date NOT NULL,
  PRIMARY KEY (date, calendar_id)
);

CREATE TABLE trip (
  id              text PRIMARY KEY,
  source_id       text NOT NULL REFERENCES data_source(id) ON DELETE CASCADE,
  service_id      text NOT NULL REFERENCES service(id) ON DELETE CASCADE,
  calendar_id     text NOT NULL REFERENCES service_calendar(id) ON DELETE CASCADE,
  source_trip_id  text NOT NULL,
  headsign        text,
  agency_timezone text NOT NULL,
  booking_url     text,
  stop_count      integer NOT NULL,
  max_offset      integer NOT NULL
);
CREATE INDEX trip_calendar_idx ON trip (calendar_id);
CREATE INDEX trip_source_idx ON trip (source_id);

-- Offsets in seconds from the GTFS service-day reference (noon - 12h, agency time zone).
CREATE TABLE trip_stop_time (
  trip_id         text NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
  seq             integer NOT NULL,      -- 0-based position
  source_sequence integer NOT NULL,
  station_id      text NOT NULL REFERENCES station(id),
  source_stop_id  text NOT NULL,
  arr_offset      integer NOT NULL,
  dep_offset      integer NOT NULL,
  pickup          boolean NOT NULL DEFAULT true,
  dropoff         boolean NOT NULL DEFAULT true,
  PRIMARY KEY (trip_id, seq)
);
CREATE INDEX trip_stop_time_station_idx ON trip_stop_time (station_id);

-- ---------------------------------------------------------------- fares

CREATE TABLE fare_product (
  source_id  text NOT NULL REFERENCES data_source(id) ON DELETE CASCADE,
  fare_id    text NOT NULL,
  price      numeric(12, 2) NOT NULL,
  currency   char(3) NOT NULL,
  PRIMARY KEY (source_id, fare_id)
);

CREATE TABLE fare_rule (
  source_id        text NOT NULL REFERENCES data_source(id) ON DELETE CASCADE,
  fare_id          text NOT NULL,
  source_route_id  text,
  origin_zone      text,
  destination_zone text
);
CREATE INDEX fare_rule_source_idx ON fare_rule (source_id);

-- Explicit price observations (manual entries or a licensed live API), per dated leg.
CREATE TABLE price_observation (
  id            bigserial PRIMARY KEY,
  source_id     text NOT NULL REFERENCES data_source(id) ON DELETE CASCADE,
  trip_id       text NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
  service_date  date NOT NULL,
  from_station  text NOT NULL REFERENCES station(id),
  to_station    text NOT NULL REFERENCES station(id),
  amount        numeric(12, 2) NOT NULL,
  currency      char(3) NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('indicative', 'live')),
  observed_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- transfers & realtime

CREATE TABLE transfer_edge (
  from_station   text NOT NULL REFERENCES station(id) ON DELETE CASCADE,
  to_station     text NOT NULL REFERENCES station(id) ON DELETE CASCADE,
  distance_m     integer NOT NULL,
  duration_s     integer NOT NULL,
  method         text NOT NULL CHECK (method IN ('estimated', 'pedestrian_router', 'feed')),
  computed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_station, to_station)
);

CREATE TABLE realtime_update (
  source_id       text NOT NULL REFERENCES data_source(id) ON DELETE CASCADE,
  trip_id         text NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
  service_date    date NOT NULL,
  canceled        boolean NOT NULL DEFAULT false,
  stop_updates    jsonb NOT NULL DEFAULT '[]'::jsonb,
  observed_at     timestamptz NOT NULL,
  PRIMARY KEY (trip_id, service_date)
);

CREATE TABLE delay_stat (
  service_id  text NOT NULL REFERENCES service(id) ON DELETE CASCADE,
  station_id  text NOT NULL REFERENCES station(id) ON DELETE CASCADE,
  samples     integer NOT NULL,
  p50_seconds integer NOT NULL,
  p90_seconds integer NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (service_id, station_id)
);

-- ---------------------------------------------------------------- search transparency

CREATE TABLE search_log (
  id            text PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  request       jsonb NOT NULL,
  outcome       text NOT NULL,
  result_count  integer NOT NULL,
  duration_ms   integer NOT NULL,
  coverage      jsonb NOT NULL
);

CREATE TABLE itinerary_snapshot (
  id          text PRIMARY KEY,
  search_id   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  payload     jsonb NOT NULL
);
CREATE INDEX itinerary_snapshot_created_idx ON itinerary_snapshot (created_at);
