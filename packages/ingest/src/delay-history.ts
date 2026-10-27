import { gtfsOffsetToEpoch, type IsoDate } from '@openbus/core';
import type { Sql } from '@openbus/db';
import type { TripUpdate } from '@openbus/gtfs';

/** A stop is only sampled from this long before its scheduled time, so a delay that was predicted hours ahead never counts. */
export const DELAY_SAMPLE_LEAD_SECONDS = 15 * 60;
/** Reported delays beyond this are treated as bad data. */
const MAX_PLAUSIBLE_DELAY_SECONDS = 24 * 3600;
const RETENTION_DAYS = 400;

export interface DelayTripStop {
  sourceSequence: number;
  sourceStopId: string;
  stationId: string;
  arrOffset: number;
}

export interface DelayTrip {
  sourceTripId: string;
  sourceRouteId: string;
  agencyTimezone: string;
  stops: DelayTripStop[];
}

export interface DelayObservation {
  sourceTripId: string;
  serviceDate: IsoDate;
  sourceSequence: number;
  sourceRouteId: string;
  stationId: string;
  scheduledAt: Date;
  delaySeconds: number;
  observedAt: Date;
}

/**
 * Extracts delay samples from TripUpdates. `trips` is keyed by the source trip id and must only
 * contain trips that should be sampled (coach services); everything else is skipped.
 */
export function buildDelayObservations(
  updates: TripUpdate[],
  trips: Map<string, DelayTrip>,
  observedAtEpoch: number,
): DelayObservation[] {
  const out: DelayObservation[] = [];
  for (const u of updates) {
    const trip = trips.get(u.tripId);
    if (!trip || !u.serviceDate || u.canceled) continue;
    for (const s of u.stopTimeUpdates) {
      if (s.skipped) continue;
      const stop =
        s.stopSequence !== null
          ? trip.stops.find((x) => x.sourceSequence === s.stopSequence)
          : s.stopId !== null
            ? trip.stops.find((x) => x.sourceStopId === s.stopId)
            : undefined;
      if (!stop) continue;
      const scheduled = gtfsOffsetToEpoch(u.serviceDate as IsoDate, trip.agencyTimezone, stop.arrOffset);
      if (observedAtEpoch < scheduled - DELAY_SAMPLE_LEAD_SECONDS) continue;
      const delay = s.arrivalDelay ?? s.departureDelay ?? (s.arrivalTime !== null ? s.arrivalTime - scheduled : null);
      if (delay === null || Math.abs(delay) > MAX_PLAUSIBLE_DELAY_SECONDS) continue;
      out.push({
        sourceTripId: trip.sourceTripId,
        serviceDate: u.serviceDate as IsoDate,
        sourceSequence: stop.sourceSequence,
        sourceRouteId: trip.sourceRouteId,
        stationId: stop.stationId,
        scheduledAt: new Date(scheduled * 1000),
        delaySeconds: Math.round(delay),
        observedAt: new Date(observedAtEpoch * 1000),
      });
    }
  }
  return out;
}

/** Loads the scheduled stops of the coach trips named in `updates` (rail and other modes are not sampled). */
export async function loadDelayTrips(sql: Sql, scheduleId: string, updates: TripUpdate[]): Promise<Map<string, DelayTrip>> {
  const ids = [...new Set(updates.filter((u) => u.stopTimeUpdates.length > 0 && !u.canceled).map((u) => `${scheduleId}:${u.tripId}`))];
  const trips = new Map<string, DelayTrip>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await sql<
      { source_trip_id: string; source_route_id: string; agency_timezone: string; source_sequence: number; source_stop_id: string; station_id: string; arr_offset: number }[]
    >`
      SELECT t.source_trip_id, s.source_route_id, t.agency_timezone,
             st.source_sequence, st.source_stop_id, st.station_id, st.arr_offset
      FROM trip t
      JOIN service s ON s.id = t.service_id
      JOIN trip_stop_time st ON st.trip_id = t.id
      WHERE t.id = ANY(${ids.slice(i, i + 500)}) AND s.mode = 'bus'`;
    for (const r of rows) {
      let t = trips.get(r.source_trip_id);
      if (!t) {
        t = { sourceTripId: r.source_trip_id, sourceRouteId: r.source_route_id, agencyTimezone: r.agency_timezone, stops: [] };
        trips.set(r.source_trip_id, t);
      }
      t.stops.push({ sourceSequence: r.source_sequence, sourceStopId: r.source_stop_id, stationId: r.station_id, arrOffset: r.arr_offset });
    }
  }
  return trips;
}

/** Stores samples; the latest observation of a dated stop wins. Returns the number of rows written. */
export async function storeDelayObservations(sql: Sql, scheduleId: string, observations: DelayObservation[]): Promise<number> {
  // One upsert statement cannot touch the same key twice.
  const obs = [...new Map(observations.map((o) => [`${o.sourceTripId}|${o.serviceDate}|${o.sourceSequence}`, o])).values()];
  for (let i = 0; i < obs.length; i += 1000) {
    const rows = obs.slice(i, i + 1000).map((o) => ({
      source_id: scheduleId,
      source_trip_id: o.sourceTripId,
      service_date: o.serviceDate,
      source_sequence: o.sourceSequence,
      source_route_id: o.sourceRouteId,
      station_id: o.stationId,
      scheduled_at: o.scheduledAt,
      delay_seconds: o.delaySeconds,
      observed_at: o.observedAt,
    }));
    await sql`
      INSERT INTO delay_observation ${sql(rows)}
      ON CONFLICT (source_id, source_trip_id, service_date, source_sequence) DO UPDATE SET
        delay_seconds = EXCLUDED.delay_seconds, observed_at = EXCLUDED.observed_at
      WHERE EXCLUDED.observed_at >= delay_observation.observed_at`;
  }
  return obs.length;
}

/**
 * Recomputes p50/p90 per (source, route, station) from stops that are already in the past
 * (a stop's sample is final only once its scheduled time plus a margin has passed) and
 * prunes old samples.
 */
export async function refreshDelayStats(sql: Sql): Promise<{ groups: number }> {
  await sql`DELETE FROM delay_observation WHERE scheduled_at < now() - make_interval(days => ${RETENTION_DAYS})`;
  const rows = await sql`
    INSERT INTO delay_stat (source_id, source_route_id, station_id, samples, p50_seconds, p90_seconds, updated_at)
    SELECT source_id, source_route_id, station_id, count(*)::int,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY delay_seconds))::int,
           round(percentile_cont(0.9) WITHIN GROUP (ORDER BY delay_seconds))::int,
           now()
    FROM delay_observation
    WHERE scheduled_at < now() - interval '30 minutes'
    GROUP BY source_id, source_route_id, station_id
    ON CONFLICT (source_id, source_route_id, station_id) DO UPDATE SET
      samples = EXCLUDED.samples, p50_seconds = EXCLUDED.p50_seconds,
      p90_seconds = EXCLUDED.p90_seconds, updated_at = EXCLUDED.updated_at
    RETURNING 1`;
  return { groups: rows.length };
}
