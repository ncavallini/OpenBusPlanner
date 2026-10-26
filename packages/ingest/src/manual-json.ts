/**
 * Manual / operator-provided timetable format ("openbus-manual-timetable/v1").
 *
 * For operators that send spreadsheets or PDFs, or timetables kept by hand. Converted to the
 * same in-memory GTFS model as feeds, so all validation, entity resolution and routing are
 * shared. CSV can be transformed into this shape with any spreadsheet export.
 */
import { gtfsDateToIso, parseGtfsTime } from '@openbus/core';
import type { GtfsFeed, GtfsStopTime } from '@openbus/gtfs';
import { z } from 'zod';

const hhmm = z.string().regex(/^\d{1,2}:\d{2}(:\d{2})?$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const ManualTimetableSchema = z.object({
  format: z.literal('openbus-manual-timetable/v1'),
  synthetic: z.boolean(),
  publisher: z.string(),
  version: z.string().optional(),
  operators: z.array(z.object({ id: z.string(), name: z.string(), url: z.string().url().nullable().default(null), timezone: z.string() })).min(1),
  stops: z.array(z.object({ id: z.string(), name: z.string(), lat: z.number(), lon: z.number(), timezone: z.string().optional() })).min(2),
  services: z.array(
    z.object({
      id: z.string(),
      operator: z.string(),
      name: z.string(),
      mode: z.enum(['bus', 'rail']).default('bus'),
      calendar: z.object({
        /** Seven characters Monday..Sunday, e.g. "1111100". */
        days: z.string().regex(/^[01]{7}$/),
        from: isoDate,
        to: isoDate,
        except: z.array(isoDate).default([]),
        extra: z.array(isoDate).default([]),
      }),
      trips: z.array(
        z.object({
          id: z.string(),
          headsign: z.string().optional(),
          /** [stopId, arrival, departure?]; times may exceed 24:00 for overnight trips. */
          calls: z.array(z.tuple([z.string(), hhmm]).or(z.tuple([z.string(), hhmm, hhmm]))).min(2),
        }),
      ),
    }),
  ),
  fares: z
    .array(z.object({ service: z.string(), from: z.string(), to: z.string(), amount: z.number().positive(), currency: z.string().length(3) }))
    .default([]),
});
export type ManualTimetable = z.infer<typeof ManualTimetableSchema>;

const t = (v: string) => parseGtfsTime(v.length === 5 || v.length === 4 ? `${v}:00` : v);
const compact = (d: string) => d.replace(/-/g, '');

export function manualToGtfsFeed(input: unknown): GtfsFeed {
  const m = ManualTimetableSchema.parse(input);
  const stopIds = new Set(m.stops.map((s) => s.id));
  const opIds = new Set(m.operators.map((o) => o.id));
  const stopTimes = new Map<string, GtfsStopTime[]>();
  const trips: GtfsFeed['trips'] = [];
  const warnings: string[] = [];
  for (const s of m.services) {
    if (!opIds.has(s.operator)) throw new Error(`Service ${s.id} references unknown operator ${s.operator}`);
    for (const trip of s.trips) {
      const tripId = `${s.id}:${trip.id}`;
      const list: GtfsStopTime[] = trip.calls.map((c, i) => {
        if (!stopIds.has(c[0])) throw new Error(`Trip ${tripId} references unknown stop ${c[0]}`);
        const arrival = t(c[1]);
        const departure = c[2] ? t(c[2]) : arrival;
        return { stopId: c[0], sequence: i + 1, arrival, departure, pickup: i < trip.calls.length - 1, dropoff: i > 0 };
      });
      for (let i = 1; i < list.length; i++) {
        if (list[i]!.arrival < list[i - 1]!.departure) throw new Error(`Trip ${tripId}: times decrease at stop ${i + 1}`);
      }
      stopTimes.set(tripId, list);
      trips.push({ id: tripId, routeId: s.id, serviceId: `${s.id}:cal`, headsign: trip.headsign ?? null });
    }
  }
  const fareStops = new Set(m.fares.flatMap((f) => [f.from, f.to]));
  return {
    agencies: m.operators.map((o) => ({ id: o.id, name: o.name, url: o.url, timezone: o.timezone, lang: null })),
    stops: m.stops.map((s) => ({
      id: s.id,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      locationType: 0,
      parentStation: null,
      zoneId: fareStops.has(s.id) ? s.id : null,
      timezone: s.timezone ?? null,
      platformCode: null,
    })),
    routes: m.services.map((s) => ({ id: s.id, agencyId: s.operator, shortName: null, longName: s.name, type: s.mode === 'rail' ? 2 : 3, url: null })),
    trips,
    stopTimes,
    calendars: m.services.map((s) => ({
      serviceId: `${s.id}:cal`,
      days: [...s.calendar.days].map((c) => c === '1'),
      start: s.calendar.from,
      end: s.calendar.to,
    })),
    calendarDates: m.services.flatMap((s) => [
      ...s.calendar.except.map((d) => ({ serviceId: `${s.id}:cal`, date: gtfsDateToIso(compact(d)), added: false })),
      ...s.calendar.extra.map((d) => ({ serviceId: `${s.id}:cal`, date: gtfsDateToIso(compact(d)), added: true })),
    ]),
    transfers: [],
    fares: m.fares.map((f, i) => ({ id: `fare${i}`, price: f.amount, currency: f.currency.toUpperCase(), agencyId: null })),
    fareRules: m.fares.map((f, i) => ({ fareId: `fare${i}`, routeId: f.service, originZone: f.from, destinationZone: f.to })),
    feedInfo: { publisherName: m.publisher, publisherUrl: null, version: m.version ?? null, startDate: null, endDate: null },
    attributions: [],
    warnings,
    counts: { agencies: m.operators.length, stops: m.stops.length, routes: m.services.length, trips: trips.length, stopTimes: [...stopTimes.values()].reduce((a, l) => a + l.length, 0) },
  };
}
