import { describe, expect, it } from 'vitest';
import { searchJourneys } from '../src/search';
import { at, bruteForce, defaultRequest, NetBuilder, paretoVectors, rng, vectorKey } from './helpers';

const D = '2026-11-07'; // Saturday

function line(b: NetBuilder) {
  return b
    .stop('A', { lat: 47.37, lon: 8.54, cityId: 'cityA' })
    .stop('B', { lat: 46.5, lon: 9.0, cityId: 'cityB' })
    .stop('B2', { lat: 46.504, lon: 9.004, cityId: 'cityB' })
    .stop('C', { lat: 45.46, lon: 9.19, cityId: 'cityC', countryCode: 'IT', timezone: 'Europe/Rome' })
    .stop('D', { lat: 46.5, lon: 11.35, cityId: 'cityD', countryCode: 'IT', timezone: 'Europe/Rome' });
}

describe('McRAPTOR basics', () => {
  it('finds a direct trip in depart and arrive mode', () => {
    const tt = line(new NetBuilder(D)).trip('T1', 'opA', [['A', '20:00'], ['D', '+1 05:00']]).build();
    const dep = searchJourneys(tt, defaultRequest({ originStopIds: ['A'], destinationStopIds: ['D'], windowStart: at(D, '12:00'), windowEnd: at(D, '23:59') }));
    expect(dep.journeys).toHaveLength(1);
    expect(dep.journeys[0]!.transfers).toBe(0);
    expect(dep.journeys[0]!.departure).toBe(at(D, '20:00'));
    expect(dep.journeys[0]!.arrival).toBe(at(D, '+1 05:00'));

    const arr = searchJourneys(tt, defaultRequest({ mode: 'arrive', originStopIds: ['A'], destinationStopIds: ['D'], windowStart: at(D, '+1 04:00'), windowEnd: at(D, '+1 08:00') }));
    expect(arr.journeys.map((j) => j.signature)).toEqual(dep.journeys.map((j) => j.signature));
  });

  it('combines two unrelated operators and respects minimum transfer time', () => {
    const tt = line(new NetBuilder(D))
      .trip('X1', 'opA', [['A', '18:00'], ['C', '22:00']])
      .trip('Y1', 'opB', [['C', '22:05'], ['D', '+1 01:00']]) // 5 min: below the 10 min minimum
      .trip('Y2', 'opB', [['C', '22:15'], ['D', '+1 01:30']]) // 15 min: risky
      .trip('Y3', 'opB', [['C', '23:00'], ['D', '+1 02:00']]) // 60 min: comfortable
      .build();
    const res = searchJourneys(tt, defaultRequest({ originStopIds: ['A'], destinationStopIds: ['D'], windowStart: at(D, '12:00'), windowEnd: at(D, '23:59') }));
    const trips = res.journeys.map((j) => j.legs.map((l) => l.trip.tripId).join('+')).sort();
    expect(trips).toEqual(['X1+Y2', 'X1+Y3']);
    const risky = res.journeys.find((j) => j.legs[1]!.trip.tripId === 'Y2')!;
    expect(risky.worstQuality).toBe(2);
    expect(risky.connections[0]!.slackSeconds).toBe(15 * 60);
    const comfy = res.journeys.find((j) => j.legs[1]!.trip.tripId === 'Y3')!;
    expect(comfy.worstQuality).toBe(0);
    expect(new Set(comfy.legs.map((l) => l.trip.operatorId))).toEqual(new Set(['opA', 'opB']));

    const noRisk = searchJourneys(tt, defaultRequest({ originStopIds: ['A'], destinationStopIds: ['D'], windowStart: at(D, '12:00'), windowEnd: at(D, '23:59'), excludeRiskyTransfers: true }));
    expect(noRisk.journeys.map((j) => j.legs[1]!.trip.tripId)).toEqual(['Y3']);
  });

  it('rejects a missed connection', () => {
    const tt = line(new NetBuilder(D))
      .trip('X1', 'opA', [['A', '18:00'], ['C', '22:30']])
      .trip('Y1', 'opB', [['C', '22:00'], ['D', '+1 01:00']])
      .build();
    const res = searchJourneys(tt, defaultRequest({ originStopIds: ['A'], destinationStopIds: ['D'], windowStart: at(D, '12:00'), windowEnd: at(D, '23:59') }));
    expect(res.journeys).toHaveLength(0);
  });

  it('enforces the maximum number of transfers', () => {
    const tt = line(new NetBuilder(D))
      .trip('L1', 'op1', [['A', '08:00'], ['B', '10:00']])
      .trip('L2', 'op2', [['B', '11:00'], ['C', '13:00']])
      .trip('L3', 'op3', [['C', '14:00'], ['D', '17:00']])
      .build();
    const q = { originStopIds: ['A'], destinationStopIds: ['D'], windowStart: at(D, '06:00'), windowEnd: at(D, '12:00') };
    expect(searchJourneys(tt, defaultRequest({ ...q, maxTransfers: 2 })).journeys).toHaveLength(1);
    expect(searchJourneys(tt, defaultRequest({ ...q, maxTransfers: 1 })).journeys).toHaveLength(0);
  });

  it('uses walking transfers between distinct nearby stops', () => {
    const tt = line(new NetBuilder(D))
      .trip('X1', 'opA', [['A', '08:00'], ['B', '10:00']])
      .trip('Y1', 'opB', [['B2', '11:00'], ['D', '14:00']])
      .walk('B', 'B2', 600, 650)
      .build();
    const res = searchJourneys(tt, defaultRequest({ originStopIds: ['A'], destinationStopIds: ['D'], windowStart: at(D, '06:00'), windowEnd: at(D, '12:00') }));
    expect(res.journeys).toHaveLength(1);
    const c = res.journeys[0]!.connections[0]!;
    expect(c.walk).toMatchObject({ fromStopId: 'B', toStopId: 'B2', distanceMeters: 650 });
    expect(c.slackSeconds).toBe(3600 - 600);
    const tooFar = searchJourneys(tt, defaultRequest({ originStopIds: ['A'], destinationStopIds: ['D'], windowStart: at(D, '06:00'), windowEnd: at(D, '12:00'), maxWalkMeters: 500 }));
    expect(tooFar.journeys).toHaveLength(0);
  });

  it('keeps Pareto-incomparable journeys and drops dominated ones', () => {
    const tt = line(new NetBuilder(D))
      .trip('Direct', 'opA', [['A', '07:00'], ['D', '15:00']]) // slow, no transfer
      .trip('F1', 'opB', [['A', '08:00'], ['C', '10:00']])
      .trip('F2', 'opC', [['C', '11:00'], ['D', '13:00']]) // faster with 1 transfer
      .trip('Slow', 'opD', [['A', '06:00'], ['D', '16:00']]) // dominated by Direct
      .build();
    const res = searchJourneys(tt, defaultRequest({ originStopIds: ['A'], destinationStopIds: ['D'], windowStart: at(D, '05:00'), windowEnd: at(D, '12:00') }));
    const sigs = res.journeys.map((j) => j.legs.map((l) => l.trip.tripId).join('+')).sort();
    expect(sigs).toEqual(['Direct', 'F1+F2']);
  });

  it('respects pickup / drop-off restrictions', () => {
    const tt = line(new NetBuilder(D))
      .trip('T', 'opA', [['A', '08:00'], ['B', '10:00'], ['D', '14:00']], { dropoff: [true, false, true], pickup: [true, false, false] })
      .trip('U', 'opB', [['B', '11:00'], ['D', '12:00']])
      .build();
    const res = searchJourneys(tt, defaultRequest({ originStopIds: ['A'], destinationStopIds: ['D'], windowStart: at(D, '06:00'), windowEnd: at(D, '12:00') }));
    // Cannot alight at B, so the faster combination T+U is impossible.
    expect(res.journeys.map((j) => j.legs.map((l) => l.trip.tripId).join('+'))).toEqual(['T']);
  });

  it('honours operator include/exclude filters and modes', () => {
    const tt = line(new NetBuilder(D))
      .trip('Bus', 'opA', [['A', '09:30'], ['D', '14:00']])
      .trip('Train', 'rail1', [['A', '09:00'], ['D', '12:00']], { mode: 'rail' })
      .build();
    const q = { originStopIds: ['A'], destinationStopIds: ['D'], windowStart: at(D, '06:00'), windowEnd: at(D, '12:00') };
    expect(searchJourneys(tt, defaultRequest(q)).journeys.map((j) => j.legs[0]!.trip.tripId)).toEqual(['Bus']);
    expect(searchJourneys(tt, defaultRequest({ ...q, modes: ['bus', 'rail'] })).journeys.map((j) => j.legs[0]!.trip.tripId).sort()).toEqual(['Bus', 'Train']);
    expect(searchJourneys(tt, defaultRequest({ ...q, excludeOperators: ['opA'] })).journeys).toHaveLength(0);
    expect(searchJourneys(tt, defaultRequest({ ...q, modes: ['bus', 'rail'], includeOperators: ['rail1'] })).journeys).toHaveLength(1);
  });

  it('enforces the maximum transfer wait', () => {
    const tt = line(new NetBuilder(D))
      .trip('X1', 'opA', [['A', '06:00'], ['C', '08:00']])
      .trip('Y1', 'opB', [['C', '18:00'], ['D', '20:00']])
      .build();
    const q = { originStopIds: ['A'], destinationStopIds: ['D'], windowStart: at(D, '05:00'), windowEnd: at(D, '12:00') };
    expect(searchJourneys(tt, defaultRequest({ ...q, maxTransferWaitSeconds: 8 * 3600 })).journeys).toHaveLength(0);
    expect(searchJourneys(tt, defaultRequest({ ...q, maxTransferWaitSeconds: 11 * 3600 })).journeys).toHaveLength(1);
  });

  it('prices journeys only when every leg fare is known and prefers cheaper alternatives', () => {
    const tt = line(new NetBuilder(D))
      .trip('Exp', 'opA', [['A', '08:00'], ['D', '12:00']], { fares: [{ fromIndex: 0, toIndex: 1, amount: 80, currency: 'EUR', kind: 'indicative' }] })
      .trip('Cheap', 'opB', [['A', '07:30'], ['D', '12:30']], { fares: [{ fromIndex: 0, toIndex: 1, amount: 20, currency: 'EUR', kind: 'indicative' }] })
      .trip('Unknown', 'opC', [['A', '07:00'], ['D', '13:00']])
      .build();
    const res = searchJourneys(tt, defaultRequest({ originStopIds: ['A'], destinationStopIds: ['D'], windowStart: at(D, '06:00'), windowEnd: at(D, '12:00') }));
    const byTrip = Object.fromEntries(res.journeys.map((j) => [j.legs[0]!.trip.tripId, j.priceEur]));
    expect(byTrip.Exp).toBe(80);
    expect(byTrip.Cheap).toBe(20); // slower but cheaper: Pareto-optimal
    // Unknown price is incomparable with known prices, so it is kept as well.
    expect(Number.isNaN(byTrip.Unknown!)).toBe(true);
    const budget = searchJourneys(tt, defaultRequest({ originStopIds: ['A'], destinationStopIds: ['D'], windowStart: at(D, '06:00'), windowEnd: at(D, '12:00'), maxBudgetEur: 50 }));
    expect(budget.journeys.map((j) => j.legs[0]!.trip.tripId).sort()).toEqual(['Cheap', 'Unknown']);
  });

  it('deduplicates equivalent trips imported from two sources', () => {
    const b = line(new NetBuilder(D));
    b.trip('T1', 'opA', [['A', '08:00'], ['D', '12:00']], { sourceId: 's1' });
    b.trip('T1-copy', 'opA', [['A', '08:00'], ['D', '12:00']], { sourceId: 's2' });
    const tt = b.build();
    expect(tt.stats.droppedDuplicateTrips).toBe(1);
    expect(tt.tripAlsoIn[0]).toEqual(['s2']);
    const res = searchJourneys(tt, defaultRequest({ originStopIds: ['A'], destinationStopIds: ['D'], windowStart: at(D, '06:00'), windowEnd: at(D, '12:00') }));
    expect(res.journeys).toHaveLength(1);
  });

  it('drops trips with invalid (time-travelling) stop times', () => {
    const b = line(new NetBuilder(D));
    b.trip('Bad', 'opA', [['A', '10:00'], ['D', '09:00']]);
    expect(b.build().stats.droppedInvalidTrips).toBe(1);
  });

  it('finds alternatives through other transfer cities', () => {
    const tt = line(new NetBuilder(D))
      .trip('ViaC1', 'opA', [['A', '08:00'], ['C', '10:00']])
      .trip('ViaC2', 'opB', [['C', '11:00'], ['D', '13:00']])
      .trip('ViaB1', 'opC', [['A', '08:00'], ['B', '10:00']])
      .trip('ViaB2', 'opD', [['B', '11:00'], ['D', '13:30']]) // dominated by the Milan route
      .build();
    const q = defaultRequest({ originStopIds: ['A'], destinationStopIds: ['D'], windowStart: at(D, '06:00'), windowEnd: at(D, '12:00') });
    expect(searchJourneys(tt, q).journeys).toHaveLength(1);
    const alt = searchJourneys(tt, { ...q, alternatives: true });
    expect(alt.journeys).toHaveLength(2);
    const viaB = alt.journeys.find((j) => j.legs[0]!.trip.tripId === 'ViaB1')!;
    expect(viaB.paretoOptimal).toBe(false);
    expect(viaB.alternativeTo).toEqual(['city:cityC']);
  });
});

describe('McRAPTOR vs exhaustive enumeration on random networks', () => {
  function randomNetwork(seed: number, withFares: boolean) {
    const r = rng(seed);
    const b = new NetBuilder(D);
    const n = 7;
    for (let i = 0; i < n; i++) {
      b.stop(`S${i}`, {
        lat: 45 + r() * 3,
        lon: 7 + r() * 5,
        cityId: `c${i}`,
        countryCode: r() < 0.5 ? 'CH' : 'IT',
        minTransferSeconds: r() < 0.3 ? 900 : 0,
      });
    }
    // A couple of walking links.
    b.walk('S1', 'S2', 420, 500);
    b.walk('S3', 'S4', 900, 1200);
    const nTrips = 14 + Math.floor(r() * 8);
    for (let k = 0; k < nTrips; k++) {
      const len = 2 + Math.floor(r() * 3);
      const stops: string[] = [];
      while (stops.length < len) {
        const s = `S${Math.floor(r() * n)}`;
        if (!stops.includes(s)) stops.push(s);
      }
      let t = 6 * 60 + Math.floor(r() * 14 * 60);
      const calls: Array<[string, string, string?]> = [];
      for (let i = 0; i < stops.length; i++) {
        const arr = t;
        const dep = i === 0 || i === stops.length - 1 ? t : t + Math.floor(r() * 3) * 5;
        calls.push([stops[i]!, fmt(arr), fmt(dep)]);
        t = dep + 30 + Math.floor(r() * 150);
      }
      const fares = withFares && r() < 0.6
        ? [{ fromIndex: 0, toIndex: stops.length - 1, amount: 10 + Math.floor(r() * 50), currency: 'EUR', kind: 'indicative' as const }]
        : undefined;
      b.trip(`T${k}`, `op${k % 4}`, calls, fares ? { fares } : {});
    }
    return b.build();
  }
  const fmt = (m: number) => {
    const day = Math.floor(m / 1440);
    const hh = String(Math.floor((m % 1440) / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    return day > 0 ? `+${day} ${hh}:${mm}` : `${hh}:${mm}`;
  };

  for (const withFares of [false, true]) {
    for (let seed = 1; seed <= 60; seed++) {
      it(`seed ${seed}${withFares ? ' with fares' : ''}: depart and arrive searches equal the exhaustive Pareto front`, () => {
        const tt = randomNetwork(seed * 7919 + (withFares ? 1 : 0), withFares);
        const r = rng(seed);
        for (let qn = 0; qn < 4; qn++) {
          const o = `S${Math.floor(r() * 7)}`;
          let d = `S${Math.floor(r() * 7)}`;
          if (d === o) d = `S${(Number(o.slice(1)) + 1) % 7}`;
          const ws = at(D, '05:00') + Math.floor(r() * 10) * 3600;
          const base = {
            originStopIds: [o],
            destinationStopIds: [d],
            maxTransferWaitSeconds: 24 * 3600,
            maxTransfers: 2 + Math.floor(r() * 2),
            riskPreference: (['cautious', 'balanced', 'adventurous'] as const)[Math.floor(r() * 3)]!,
            maxDurationSeconds: 20 * 3600,
          };
          for (const mode of ['depart', 'arrive'] as const) {
            const req = defaultRequest({ ...base, mode, windowStart: ws, windowEnd: ws + 6 * 3600 });
            const expected = paretoVectors(bruteForce(tt, req));
            const got = [...new Set(searchJourneys(tt, req).journeys.filter((j) => j.paretoOptimal).map((j) =>
              vectorKey({ dep: j.departure, arr: j.arrival, legs: j.legs.length, walk: j.walkMeters, quality: j.worstQuality ?? 0, price: j.priceEur }),
            ))].sort();
            expect(got, `${mode} ${o}->${d}`).toEqual(expected);
          }
        }
      });
    }
  }
});
