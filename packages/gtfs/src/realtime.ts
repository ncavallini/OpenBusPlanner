import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { gtfsDateToIso } from '@openbus/core';
import type { RouterTrip } from '@openbus/router';

const { transit_realtime } = GtfsRealtimeBindings;

export interface StopTimeUpdate {
  stopSequence: number | null;
  stopId: string | null;
  arrivalDelay: number | null;
  departureDelay: number | null;
  arrivalTime: number | null;
  departureTime: number | null;
  skipped: boolean;
}

export interface TripUpdate {
  tripId: string;
  serviceDate: string | null;
  canceled: boolean;
  stopTimeUpdates: StopTimeUpdate[];
  timestamp: number | null;
}

const toNum = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && v !== null && 'toNumber' in v) return (v as { toNumber(): number }).toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** protobufjs exposes defaults (0) for absent fields via the prototype; check presence explicitly. */
const field = (obj: object | null | undefined, key: string): number | null =>
  obj && Object.prototype.hasOwnProperty.call(obj, key) ? toNum((obj as Record<string, unknown>)[key]) : null;

/** Decodes a GTFS Realtime FeedMessage (protobuf) and extracts TripUpdates. */
export function decodeTripUpdates(buffer: Uint8Array): { feedTimestamp: number | null; updates: TripUpdate[] } {
  const msg = transit_realtime.FeedMessage.decode(buffer);
  const updates: TripUpdate[] = [];
  for (const e of msg.entity) {
    const tu = e.tripUpdate;
    if (!tu?.trip?.tripId) continue;
    updates.push({
      tripId: tu.trip.tripId,
      serviceDate: tu.trip.startDate ? gtfsDateToIso(tu.trip.startDate) : null,
      canceled: tu.trip.scheduleRelationship === transit_realtime.TripDescriptor.ScheduleRelationship.CANCELED,
      timestamp: field(tu, 'timestamp'),
      stopTimeUpdates: (tu.stopTimeUpdate ?? []).map((s) => ({
        stopSequence: field(s, 'stopSequence'),
        stopId: Object.prototype.hasOwnProperty.call(s, 'stopId') ? s.stopId ?? null : null,
        arrivalDelay: field(s.arrival, 'delay'),
        departureDelay: field(s.departure, 'delay'),
        arrivalTime: field(s.arrival, 'time'),
        departureTime: field(s.departure, 'time'),
        skipped:
          s.scheduleRelationship === transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED,
      })),
    });
  }
  return { feedTimestamp: field(msg.header, 'timestamp'), updates };
}

/**
 * Applies TripUpdates to dated trips. Delays propagate downstream until the next update
 * (GTFS-RT semantics). Cancelled trips are removed. Matching uses trip_id + service date;
 * `stopIndexOf` maps a stop_sequence or stop_id to the trip position.
 */
export function applyTripUpdates(
  trips: RouterTrip[],
  updates: TripUpdate[],
  stopIndexOf: (trip: RouterTrip, u: StopTimeUpdate) => number,
): { trips: RouterTrip[]; applied: number; canceled: number } {
  const byKey = new Map<string, TripUpdate>();
  for (const u of updates) byKey.set(`${u.tripId}@${u.serviceDate ?? '*'}`, u);
  let applied = 0;
  let canceled = 0;
  const out: RouterTrip[] = [];
  for (const t of trips) {
    const u = byKey.get(`${t.tripId}@${t.serviceDate}`) ?? byKey.get(`${t.tripId}@*`);
    if (!u) {
      out.push(t);
      continue;
    }
    if (u.canceled) {
      canceled++;
      continue;
    }
    const arrivals = [...t.arrivals];
    const departures = [...t.departures];
    const n = arrivals.length;
    const updatesAt = new Map<number, StopTimeUpdate>();
    for (const s of u.stopTimeUpdates) {
      const i = stopIndexOf(t, s);
      if (i >= 0 && i < n) updatesAt.set(i, s);
    }
    let delay = 0;
    let started = false;
    for (let i = 0; i < n; i++) {
      const s = updatesAt.get(i);
      if (s) {
        started = true;
        const arrDelay = s.arrivalTime !== null ? s.arrivalTime - t.arrivals[i]! : s.arrivalDelay ?? s.departureDelay ?? delay;
        const depDelay = s.departureTime !== null ? s.departureTime - t.departures[i]! : s.departureDelay ?? arrDelay;
        arrivals[i] = t.arrivals[i]! + arrDelay;
        departures[i] = Math.max(arrivals[i]!, t.departures[i]! + depDelay);
        delay = depDelay;
      } else if (started) {
        arrivals[i] = t.arrivals[i]! + delay;
        departures[i] = Math.max(arrivals[i]!, t.departures[i]! + delay);
      }
      if (i > 0 && arrivals[i]! < departures[i - 1]!) arrivals[i] = departures[i - 1]!;
      if (departures[i]! < arrivals[i]!) departures[i] = arrivals[i]!;
    }
    applied++;
    out.push({ ...t, arrivals, departures });
  }
  return { trips: out, applied, canceled };
}

/** Builds a FeedMessage (used by tests and the fixture realtime server). */
export function encodeTripUpdates(
  updates: Array<{ tripId: string; startDate?: string; canceled?: boolean; stops: Array<{ stopSequence: number; arrivalDelay?: number; departureDelay?: number }> }>,
  timestamp: number,
): Uint8Array {
  const message = transit_realtime.FeedMessage.create({
    header: { gtfsRealtimeVersion: '2.0', timestamp },
    entity: updates.map((u, i) => ({
      id: `e${i}`,
      tripUpdate: {
        trip: {
          tripId: u.tripId,
          ...(u.startDate ? { startDate: u.startDate } : {}),
          ...(u.canceled ? { scheduleRelationship: transit_realtime.TripDescriptor.ScheduleRelationship.CANCELED } : {}),
        },
        stopTimeUpdate: u.stops.map((s) => ({
          stopSequence: s.stopSequence,
          ...(s.arrivalDelay !== undefined ? { arrival: { delay: s.arrivalDelay } } : {}),
          ...(s.departureDelay !== undefined ? { departure: { delay: s.departureDelay } } : {}),
        })),
      },
    })),
  });
  return transit_realtime.FeedMessage.encode(message).finish();
}
