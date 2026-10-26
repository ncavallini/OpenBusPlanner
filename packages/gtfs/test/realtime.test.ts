import { describe, expect, it } from 'vitest';
import type { RouterTrip } from '@openbus/router';
import { applyTripUpdates, decodeTripUpdates, encodeTripUpdates } from '../src/realtime';

const trip = (id: string, date = '2026-11-07'): RouterTrip => ({
  id: `${id}@${date}`,
  tripId: id,
  serviceDate: date,
  operatorId: 'op',
  routeId: 'r',
  mode: 'bus',
  sourceId: 's',
  synthetic: true,
  stops: ['A', 'B', 'C'],
  arrivals: [1000, 2000, 3000],
  departures: [1000, 2100, 3000],
});

describe('GTFS Realtime TripUpdates', () => {
  it('round-trips through protobuf and propagates delays downstream', () => {
    const buf = encodeTripUpdates(
      [
        { tripId: 'T1', startDate: '20261107', stops: [{ stopSequence: 2, arrivalDelay: 300 }] },
        { tripId: 'T2', canceled: true, stops: [] },
      ],
      1_800_000_000,
    );
    const { feedTimestamp, updates } = decodeTripUpdates(buf);
    expect(feedTimestamp).toBe(1_800_000_000);
    expect(updates).toHaveLength(2);
    const res = applyTripUpdates([trip('T1'), trip('T2'), trip('T3')], updates, (_t, u) => (u.stopSequence ?? 0) - 1);
    expect(res.canceled).toBe(1);
    expect(res.applied).toBe(1);
    const t1 = res.trips.find((t) => t.tripId === 'T1')!;
    expect(t1.arrivals).toEqual([1000, 2300, 3300]);
    expect(t1.departures).toEqual([1000, 2400, 3300]);
    expect(res.trips.find((t) => t.tripId === 'T3')!.arrivals).toEqual([1000, 2000, 3000]);
  });

  it('only applies updates to the matching service date', () => {
    const buf = encodeTripUpdates([{ tripId: 'T1', startDate: '20261108', stops: [{ stopSequence: 1, departureDelay: 60 }] }], 1);
    const { updates } = decodeTripUpdates(buf);
    const res = applyTripUpdates([trip('T1', '2026-11-07')], updates, (_t, u) => (u.stopSequence ?? 0) - 1);
    expect(res.applied).toBe(0);
  });
});
