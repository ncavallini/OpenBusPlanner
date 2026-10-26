import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { estimateWalk, haversineMeters, localTimeToEpoch } from '@openbus/core';
import { searchJourneys, Timetable, type Journey, type RouterRequest } from '@openbus/router';
import { gtfsToTimetableInput, loadGtfsFeed, type GtfsFeed } from '../src/index';

const FIXTURE = join(__dirname, '../../../data/fixtures/synthetic-zurich-bolzano');
const zrh = (d: string, t: string) => localTimeToEpoch(d, t, 'Europe/Zurich');
const rome = (d: string, t: string) => localTimeToEpoch(d, t, 'Europe/Rome');

let feed: GtfsFeed;
const tables = new Map<string, Timetable>();
function timetable(from: string, to: string): Timetable {
  const key = `${from}/${to}`;
  if (!tables.has(key)) {
    tables.set(key, new Timetable(gtfsToTimetableInput(feed, { from, to, sourceId: 'fx', synthetic: true })));
  }
  return tables.get(key)!;
}

const trips = (j: Journey) => j.legs.map((l) => l.trip.tripId).join(' + ');
const summary = (js: Journey[]) =>
  js
    .map((j) => ({ trips: trips(j), dep: j.departure, arr: j.arrival, transfers: j.transfers, pareto: j.paretoOptimal }))
    .sort((a, b) => a.dep - b.dep);

function request(o: Partial<RouterRequest>): RouterRequest {
  return {
    originStopIds: ['ZRH-SQ'],
    destinationStopIds: ['BZO-BUS'],
    mode: 'arrive',
    windowStart: rome('2026-11-08', '04:00'),
    windowEnd: rome('2026-11-08', '08:00'),
    earliestDeparture: zrh('2026-11-07', '12:00'),
    maxTransfers: 3,
    minTransferSeconds: 600,
    maxTransferWaitSeconds: 8 * 3600,
    maxDurationSeconds: 30 * 3600,
    maxWalkMeters: 1500,
    riskPreference: 'balanced',
    alternatives: true,
    ...o,
  };
}

beforeAll(async () => {
  feed = await loadGtfsFeed({ path: FIXTURE });
});

describe('synthetic Zurich → Bolzano scenario (spec §11)', () => {
  it('loads the fixture feed and groups stops into cities', () => {
    const tt = timetable('2026-11-07', '2026-11-08');
    expect(tt.stop('ZRH-SQ')!.cityId).toBe('ch-zurich');
    expect(tt.stop('MIL-LAM')!.cityId).toBe('it-milan');
    expect(tt.stop('MIL-SDO')!.cityId).toBe('it-milan');
    expect(tt.stop('BZO-BUS')!.cityId).toBe('it-bolzano');
    expect(tt.stop('INN-SIL')!.cityId).toBe('at-innsbruck');
    expect(tt.stop('MIL-LAM')!.minTransferSeconds).toBe(600);
  });

  it('arrival search returns exactly the expected itineraries', () => {
    const res = searchJourneys(timetable('2026-11-07', '2026-11-08'), request({}));
    expect(summary(res.journeys)).toEqual([
      { trips: 'D_ZRH_MUC_1500 + E_MUC_INN_2030 + F_INN_BZO_0130', dep: zrh('2026-11-07', '15:00'), arr: rome('2026-11-08', '04:10'), transfers: 2, pareto: true },
      { trips: 'H_ZRH_VRN_1700 + C_MIL_BZO_0030', dep: zrh('2026-11-07', '17:00'), arr: rome('2026-11-08', '04:45'), transfers: 1, pareto: false },
      { trips: 'B_ZRH_MIL_1900 + C_MIL_BZO_0030', dep: zrh('2026-11-07', '19:00'), arr: rome('2026-11-08', '04:45'), transfers: 1, pareto: true },
      { trips: 'A_DIRECT_N', dep: zrh('2026-11-07', '23:30'), arr: rome('2026-11-08', '05:30'), transfers: 0, pareto: true },
    ]);
  });

  it('labels transfers, walking and the alternative corridor', () => {
    const res = searchJourneys(timetable('2026-11-07', '2026-11-08'), request({}));
    const viaMilan = res.journeys.find((j) => trips(j) === 'B_ZRH_MIL_1900 + C_MIL_BZO_0030')!;
    expect(viaMilan.connections).toHaveLength(1);
    expect(viaMilan.connections[0]).toMatchObject({ atStopId: 'MIL-LAM', slackSeconds: 105 * 60, quality: 0, walk: null });
    expect(new Set(viaMilan.legs.map((l) => l.trip.operatorId))).toEqual(new Set(['fx:opB', 'fx:opC']));
    expect(viaMilan.legs.map((l) => l.price && `${l.price.amount} ${l.price.currency}`)).toEqual(['35 CHF', '24.9 EUR']);

    const viaInnsbruck = res.journeys.find((j) => j.transfers === 2)!;
    const walk = viaInnsbruck.connections[1]!.walk!;
    const expected = estimateWalk(haversineMeters({ lat: 47.2633, lon: 11.4008 }, { lat: 47.2655, lon: 11.4045 }));
    expect(walk).toMatchObject({ fromStopId: 'INN-HBF', toStopId: 'INN-SIL', distanceMeters: expected.distanceMeters, durationSeconds: expected.durationSeconds });
    expect(viaInnsbruck.connections[1]!.slackSeconds).toBe(3 * 3600 - expected.durationSeconds);
    expect(viaInnsbruck.connections.map((c) => c.quality)).toEqual([0, 0]);
    expect(viaInnsbruck.overnightWaitSeconds).toBe(90 * 60); // 00:00–01:30 in Innsbruck

    const alt = res.journeys.find((j) => !j.paretoOptimal)!;
    expect(alt.alternativeTo.sort()).toEqual(['city:at-innsbruck', 'city:de-munich', 'city:it-milan']);
    expect(alt.legs[1]!.trip.stops[alt.legs[1]!.boardIndex]).toBe('VRN');
  });

  it('never uses the missed or too-short connections, the other Milan station, or Sunday-less services', () => {
    const res = searchJourneys(timetable('2026-11-07', '2026-11-08'), request({}));
    const used = res.journeys.flatMap((j) => j.legs.map((l) => l.trip.tripId));
    expect(used).not.toContain('B_ZRH_MIL_2055'); // arrives 00:40: misses 00:30, 00:45 is too short
    expect(used).not.toContain('D_ZRH_SDO_1800'); // Milano San Donato is 12 km from Lampugnano
    expect(used).not.toContain('A_EARLY_NOTSUN'); // Mon–Sat only
    expect(used).not.toContain('G_MIL_BZO_0045'); // only reachable via dominated combinations
  });

  it('a too-short connection becomes feasible only when the user lowers the minimum transfer time', () => {
    const res = searchJourneys(
      timetable('2026-11-07', '2026-11-08'),
      request({ minTransferSeconds: 0, alternatives: false, riskPreference: 'adventurous' }),
    );
    // MIL-LAM has a station minimum of 10 minutes, so 00:40 -> 00:45 stays infeasible.
    expect(res.journeys.flatMap((j) => j.legs.map((l) => l.trip.tripId))).not.toContain('B_ZRH_MIL_2055');
  });

  it('departure search over the same window returns the same Pareto set', () => {
    const arrive = searchJourneys(timetable('2026-11-07', '2026-11-08'), request({ alternatives: false }));
    const depart = searchJourneys(
      timetable('2026-11-07', '2026-11-08'),
      request({
        mode: 'depart',
        windowStart: zrh('2026-11-07', '12:00'),
        windowEnd: zrh('2026-11-07', '23:59'),
        earliestDeparture: undefined,
        latestArrival: rome('2026-11-08', '08:00'),
        alternatives: false,
      }),
    );
    expect(summary(depart.journeys)).toEqual(summary(arrive.journeys));
  });

  it('includes the Mon–Sat service for a Saturday arrival', () => {
    const res = searchJourneys(
      timetable('2026-11-06', '2026-11-07'),
      request({
        windowStart: rome('2026-11-07', '04:00'),
        windowEnd: rome('2026-11-07', '08:00'),
        earliestDeparture: zrh('2026-11-06', '12:00'),
        alternatives: false,
      }),
    );
    const early = res.journeys.find((j) => trips(j) === 'A_EARLY_NOTSUN')!;
    expect(early.departure).toBe(zrh('2026-11-07', '00:30'));
    expect(early.arrival).toBe(rome('2026-11-07', '06:00'));
  });

  it('applies calendar exceptions (removed and added dates)', () => {
    const xmas = searchJourneys(
      timetable('2026-12-24', '2026-12-25'),
      request({ windowStart: rome('2026-12-25', '04:00'), windowEnd: rome('2026-12-25', '08:00'), earliestDeparture: zrh('2026-12-24', '12:00') }),
    );
    expect(xmas.journeys.map(trips)).not.toContain('A_DIRECT_N');
    expect(xmas.journeys.length).toBeGreaterThan(0);

    const nye = (date: string) =>
      searchJourneys(
        timetable(date, date),
        request({
          mode: 'depart',
          originStopIds: ['MIL-LAM'],
          windowStart: rome(date, '18:00'),
          windowEnd: rome(date, '21:00'),
          earliestDeparture: undefined,
          alternatives: false,
        }),
      ).journeys.map(trips);
    expect(nye('2026-12-31')).toEqual(['X_NYE_SPECIAL']);
    expect(nye('2026-12-30')).toEqual([]);
  });

  it('honours the transfer limit', () => {
    const res = searchJourneys(timetable('2026-11-07', '2026-11-08'), request({ maxTransfers: 1, alternatives: false }));
    expect(res.journeys.every((j) => j.transfers <= 1)).toBe(true);
    expect(res.journeys.map(trips).sort()).toEqual(['A_DIRECT_N', 'B_ZRH_MIL_1900 + C_MIL_BZO_0030']);
  });
});

describe('GTFS feed loading', () => {
  it('drops duplicate trips and stop_times with warnings', async () => {
    const dup = await loadGtfsFeed({ path: join(__dirname, '../../../data/fixtures/synthetic-aggregator-duplicate') });
    expect(dup.trips).toHaveLength(1);
    expect(dup.stopTimes.get('agg-trip-1')).toHaveLength(3);
    expect(dup.warnings).toEqual(
      expect.arrayContaining([
        'Duplicate trip_id agg-trip-1 ignored',
        'Duplicate stop_sequence 2 in trip agg-trip-1 ignored',
      ]),
    );
  });

  it('reads feed_info and fares', () => {
    expect(feed.feedInfo?.publisherName).toContain('SYNTHETIC TEST FIXTURE');
    expect(feed.fares.map((f) => f.id).sort()).toEqual(['F_B_ZRH_MIL', 'F_C_MIL_BZO', 'F_C_MIL_VRN', 'F_C_VRN_BZO']);
  });
});
