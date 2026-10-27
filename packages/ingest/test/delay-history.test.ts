import { describe, expect, it } from 'vitest';
import { gtfsOffsetToEpoch } from '@openbus/core';
import { decodeTripUpdates, encodeTripUpdates } from '@openbus/gtfs';
import { buildDelayObservations, DELAY_SAMPLE_LEAD_SECONDS, type DelayTrip } from '../src/delay-history';

const TZ = 'Europe/Rome';
const DATE = '2026-11-02';
const trip: DelayTrip = {
  sourceTripId: 'T1',
  sourceRouteId: 'R1',
  agencyTimezone: TZ,
  stops: [
    { sourceSequence: 1, sourceStopId: 'A', stationId: 'stn_a', arrOffset: 8 * 3600 },
    { sourceSequence: 2, sourceStopId: 'B', stationId: 'stn_b', arrOffset: 10 * 3600 },
    { sourceSequence: 3, sourceStopId: 'C', stationId: 'stn_c', arrOffset: 12 * 3600 },
  ],
};
const at = (offset: number) => gtfsOffsetToEpoch(DATE, TZ, offset);
const feed = (stops: Array<{ stopSequence: number; arrivalDelay?: number; departureDelay?: number }>, ts: number, extra: { canceled?: boolean } = {}) =>
  decodeTripUpdates(encodeTripUpdates([{ tripId: 'T1', startDate: '20261102', stops, ...extra }], ts)).updates;

describe('buildDelayObservations', () => {
  const trips = new Map([[trip.sourceTripId, trip]]);

  it('records arrival delay (falling back to departure delay) for stops that are about to be reached', () => {
    const now = at(12 * 3600);
    const obs = buildDelayObservations(
      feed([{ stopSequence: 2, arrivalDelay: 420 }, { stopSequence: 3, departureDelay: 600 }], now),
      trips,
      now,
    );
    expect(obs.map((o) => [o.sourceSequence, o.stationId, o.delaySeconds])).toEqual([
      [2, 'stn_b', 420],
      [3, 'stn_c', 600],
    ]);
    expect(obs[0]!.scheduledAt.getTime() / 1000).toBe(at(10 * 3600));
    expect(obs[0]!.sourceRouteId).toBe('R1');
  });

  it('ignores predictions made long before the stop, cancelled trips and unknown stops', () => {
    const early = at(10 * 3600) - DELAY_SAMPLE_LEAD_SECONDS - 60;
    expect(buildDelayObservations(feed([{ stopSequence: 2, arrivalDelay: 300 }], early), trips, early)).toEqual([]);
    const now = at(10 * 3600);
    expect(buildDelayObservations(feed([{ stopSequence: 2, arrivalDelay: 300 }], now, { canceled: true }), trips, now)).toEqual([]);
    expect(buildDelayObservations(feed([{ stopSequence: 99, arrivalDelay: 300 }], now), trips, now)).toEqual([]);
    expect(buildDelayObservations(feed([{ stopSequence: 2, arrivalDelay: 300 }], now), new Map(), now)).toEqual([]);
  });

  it('rejects implausible delays and keeps early arrivals as negative delays', () => {
    const now = at(12 * 3600);
    const obs = buildDelayObservations(feed([{ stopSequence: 1, arrivalDelay: 3 * 86400 }, { stopSequence: 2, arrivalDelay: -120 }], now), trips, now);
    expect(obs.map((o) => [o.sourceSequence, o.delaySeconds])).toEqual([[2, -120]]);
  });
});
