import { describe, expect, it } from 'vitest';
import { matchStop, StationIndex } from '../src/entity-resolution';
import { manualToGtfsFeed } from '../src/manual-json';
import { loadRegistry } from '../src/registry';

const station = (id: string, name: string, lat: number, lon: number, sources: string[] = ['a']) => ({ id, name, lat, lon, sources: new Set(sources) });

describe('station entity resolution', () => {
  const index = new StationIndex([
    station('zrh', 'Zürich Sihlquai Bus Terminal', 47.3784, 8.5328),
    station('lam', 'Milano Lampugnano', 45.4893, 9.1236),
    station('sdo', 'Milano San Donato', 45.4153, 9.2633),
  ]);

  it('merges the same place published under an alias by another source', () => {
    expect(matchStop(index, 'b', { sourceStopId: 'x', name: 'Zurich Sihlquai', lat: 47.37851, lon: 8.53295 })).toMatchObject({ stationId: 'zrh', method: 'proximity' });
  });

  it('merges a nearby stop with a similar name, but not a nearby stop with a different name', () => {
    expect(matchStop(index, 'b', { sourceStopId: 'x', name: 'Milan Lampugnano bus station', lat: 45.4905, lon: 9.1250 })).toMatchObject({
      stationId: 'lam',
      method: 'proximity_name',
    });
    expect(matchStop(index, 'b', { sourceStopId: 'x', name: 'Via Natta', lat: 45.4905, lon: 9.1250 }).method).toBe('new');
  });

  it('never merges by city name alone', () => {
    expect(matchStop(index, 'b', { sourceStopId: 'x', name: 'Milano Lampugnano', lat: 45.47, lon: 9.2 }).method).toBe('new');
  });

  it('never merges two distinct stops of the same source', () => {
    expect(matchStop(index, 'a', { sourceStopId: 'y', name: 'Zürich Sihlquai Bus Terminal', lat: 47.3784, lon: 8.5328 }).method).toBe('new');
  });
});

describe('manual timetable format', () => {
  const base = {
    format: 'openbus-manual-timetable/v1',
    synthetic: true,
    publisher: 'test',
    operators: [{ id: 'o', name: 'Op', url: null, timezone: 'Europe/Rome' }],
    stops: [
      { id: 'a', name: 'A', lat: 45, lon: 9 },
      { id: 'b', name: 'B', lat: 46, lon: 10 },
    ],
    services: [{ id: 's', operator: 'o', name: 'A-B', calendar: { days: '0000011', from: '2026-01-01', to: '2026-12-31', except: ['2026-11-08'] }, trips: [{ id: '1', calls: [['a', '23:30'], ['b', '25:10']] }] }],
    fares: [{ service: 's', from: 'a', to: 'b', amount: 12, currency: 'EUR' }],
  };

  it('converts to the GTFS model with overnight times, exceptions and fares', () => {
    const feed = manualToGtfsFeed(base);
    expect(feed.stopTimes.get('s:1')!.map((s) => [s.arrival, s.pickup, s.dropoff])).toEqual([
      [23.5 * 3600, true, false],
      [25 * 3600 + 600, false, true],
    ]);
    expect(feed.calendars[0]!.days).toEqual([false, false, false, false, false, true, true]);
    expect(feed.calendarDates).toEqual([{ serviceId: 's:cal', date: '2026-11-08', added: false }]);
    expect(feed.fareRules).toEqual([{ fareId: 'fare0', routeId: 's', originZone: 'a', destinationZone: 'b' }]);
  });

  it('rejects invalid timetables', () => {
    expect(() => manualToGtfsFeed({ ...base, services: [{ ...base.services[0]!, trips: [{ id: '1', calls: [['a', '10:00'], ['b', '09:00']] }] }] })).toThrow(/decrease/);
    expect(() => manualToGtfsFeed({ ...base, services: [{ ...base.services[0]!, operator: 'nope' }] })).toThrow(/unknown operator/);
    expect(() => manualToGtfsFeed({ ...base, format: 'other' })).toThrow();
  });
});

describe('source registry', () => {
  it('only enables implemented adapters and keeps synthetic flags', () => {
    const all = loadRegistry({ enabled: 'all' });
    expect(all.find((s) => s.id === 'swiss-netex')!.enabled).toBe(false);
    expect(all.filter((s) => s.adapter === 'unavailable').every((s) => s.synthetic)).toBe(true);
    const def = loadRegistry({ enabled: 'default' });
    expect(def.filter((s) => s.enabled).map((s) => s.id)).toEqual(['fixture-zrh-bzo', 'fixture-aggregator-copy', 'fixture-manual-lugano-como']);
  });
});
