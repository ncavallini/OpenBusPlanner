/**
 * Integration tests: PostgreSQL/PostGIS + real fixture imports + HTTP API.
 * Requires the compose database (pnpm services:up). Uses a dedicated `openbus_test` database.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JourneySearchResponse } from '@openbus/core/api';
import { createSql, databaseUrl, type Sql } from '@openbus/db';
import { loadRegistry, seed, syncSchedule } from '@openbus/ingest';
import { loadConfig } from '../src/config';
import { noCache } from '../src/result-cache';
import { buildServer } from '../src/server';

const ADMIN_URL = databaseUrl();
const TEST_URL = ADMIN_URL.replace(/\/[^/]+$/, '/openbus_test');
let sql: Sql;
let app: FastifyInstance;

const SCENARIO = {
  origin: 'city:ch-zurich',
  destination: 'city:it-bolzano',
  mode: 'arrive',
  date: '2026-11-08',
  timeWindow: { from: '04:00', to: '08:00' },
  departureNotBefore: { date: '2026-11-07', time: '12:00' },
  maxTransfers: 3,
  dataScope: 'synthetic',
};

async function search(body: Record<string, unknown>): Promise<JourneySearchResponse> {
  const res = await app.inject({ method: 'POST', url: '/api/journeys/search', payload: body });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

const trips = (r: JourneySearchResponse) =>
  r.itineraries
    .map((i) => `${i.departure.local}>${i.arrival.local} ${i.legs.map((l) => l.tripId).join('+')}`)
    .sort();

beforeAll(async () => {
  const admin = createSql(ADMIN_URL, { max: 1 });
  await admin.unsafe('DROP DATABASE IF EXISTS openbus_test WITH (FORCE)');
  await admin.unsafe('CREATE DATABASE openbus_test');
  await admin.end();
  sql = createSql(TEST_URL, { max: 5 });
  const res = await seed(sql, { enabled: 'fixture-zrh-bzo,fixture-aggregator-copy,fixture-manual-lugano-como' });
  expect(res).toEqual({
    'fixture-zrh-bzo': 'success',
    'fixture-aggregator-copy': 'success',
    'fixture-manual-lugano-como': 'success',
  });
  // A provider outage: a registered, enabled source whose download fails.
  const base = loadRegistry({ enabled: 'all' }).find((s) => s.id === 'gtfs-de-fv')!;
  const outage = await syncSchedule(sql, {
    ...base,
    id: 'test-outage',
    name: 'Test outage source',
    enabled: true,
    config: { url: 'http://127.0.0.1:9/unreachable.zip' },
  });
  expect(outage.status).toBe('failed');
  app = await buildServer({ sql, config: { ...loadConfig({}), logLevel: 'silent', rateLimitPerMinute: 100_000, dataVersionTtlMs: 0 }, cache: noCache });
});

afterAll(async () => {
  await app?.close();
  await sql?.end();
});

describe('ingestion and entity resolution', () => {
  it('maps aggregator aliases onto the same physical stations', async () => {
    const rows = await sql<{ fixture: string; agg: string; method: string }[]>`
      SELECT a.source_stop_id AS fixture, b.source_stop_id AS agg, b.match_method AS method
      FROM source_stop a JOIN source_stop b ON a.station_id = b.station_id
      WHERE a.source_id = 'fixture-zrh-bzo' AND b.source_id = 'fixture-aggregator-copy' ORDER BY a.source_stop_id`;
    expect(rows.map((r) => [r.fixture, r.agg, r.method])).toEqual([
      ['BZO-BUS', 'agg:bozen', 'proximity'],
      ['CHUR', 'agg:chur', 'proximity'],
      ['ZRH-SQ', 'agg:zurich', 'proximity'],
    ]);
  });

  it('keeps distinct stations of the same city apart and links nearby stops by walking', async () => {
    const st = await sql<{ source_stop_id: string; station_id: string; city_id: string }[]>`
      SELECT ss.source_stop_id, ss.station_id, s.city_id FROM source_stop ss JOIN station s ON s.id = ss.station_id
      WHERE ss.source_id = 'fixture-zrh-bzo' AND ss.source_stop_id IN ('MIL-LAM', 'MIL-SDO', 'INN-HBF', 'INN-SIL')`;
    const by = Object.fromEntries(st.map((r) => [r.source_stop_id, r]));
    expect(by['MIL-LAM']!.station_id).not.toBe(by['MIL-SDO']!.station_id);
    expect(by['MIL-LAM']!.city_id).toBe('it-milan');
    expect(by['MIL-SDO']!.city_id).toBe('it-milan');
    const edges = await sql<{ from_station: string; to_station: string; method: string }[]>`
      SELECT from_station, to_station, method FROM transfer_edge
      WHERE from_station = ANY(${st.map((r) => r.station_id)}) AND to_station = ANY(${st.map((r) => r.station_id)})`;
    const has = (a: string, b: string) => edges.some((e) => e.from_station === by[a]!.station_id && e.to_station === by[b]!.station_id);
    expect(has('INN-HBF', 'INN-SIL')).toBe(true);
    expect(has('MIL-LAM', 'MIL-SDO')).toBe(false);
  });

  it('skips unchanged re-imports and keeps station ids stable when forced', async () => {
    const def = { ...loadRegistry({ enabled: 'all' }).find((s) => s.id === 'fixture-zrh-bzo')!, enabled: true };
    const before = await sql`SELECT source_stop_id, station_id FROM source_stop WHERE source_id = 'fixture-zrh-bzo' ORDER BY 1`;
    expect((await syncSchedule(sql, def)).status).toBe('skipped_unchanged');
    const forced = await syncSchedule(sql, def, { force: true });
    expect(forced.status).toBe('success');
    expect(forced.stats.stationsMatchedExisting).toBe(10);
    expect(forced.stats.stationsCreated).toBe(0);
    const after = await sql`SELECT source_stop_id, station_id FROM source_stop WHERE source_id = 'fixture-zrh-bzo' ORDER BY 1`;
    expect(after).toEqual(before);
  });
});

describe('places API', () => {
  it('resolves multilingual city aliases and station aliases from feeds', async () => {
    const q = async (text: string) => (await app.inject({ url: `/api/places/search?q=${encodeURIComponent(text)}` })).json().places;
    expect((await q('Bozen'))[0]).toMatchObject({ id: 'city:it-bolzano', kind: 'city', stationCount: 1 });
    expect((await q('Zurigo'))[0]).toMatchObject({ id: 'city:ch-zurich' });
    expect((await q('Mailand'))[0]).toMatchObject({ id: 'city:it-milan', stationCount: 2 });
    const station = (await q('Bozen Busbahnhof')).find((p: { kind: string }) => p.kind === 'station');
    expect(station).toMatchObject({ name: 'Bolzano/Bozen Autostazione', matchedAlias: 'Bozen Busbahnhof' });
  });
});

describe('journey search API', () => {
  it('returns exactly the expected Zurich → Bolzano itineraries, deduplicated across sources', async () => {
    const r = await search(SCENARIO);
    expect(r.outcome).toBe('results');
    expect(trips(r)).toEqual([
      '2026-11-07T15:00:00+01:00>2026-11-08T04:10:00+01:00 D_ZRH_MUC_1500+E_MUC_INN_2030+F_INN_BZO_0130',
      '2026-11-07T17:00:00+01:00>2026-11-08T04:45:00+01:00 H_ZRH_VRN_1700+C_MIL_BZO_0030',
      '2026-11-07T19:00:00+01:00>2026-11-08T04:45:00+01:00 B_ZRH_MIL_1900+C_MIL_BZO_0030',
      '2026-11-07T23:30:00+01:00>2026-11-08T05:30:00+01:00 A_DIRECT_N',
    ]);
    const direct = r.itineraries.find((i) => i.transfers === 0)!;
    expect(direct.legs[0]!.provenance.alsoFoundIn).toEqual(['SYNTHETIC FIXTURE: aggregator re-publication of one fixture trip']);
    expect(direct.arrivalDayOffset).toBe(1);
    expect(direct.legs[0]!.intermediateStops.map((s) => s.name)).toEqual(['Chur Postautostation']);
  });

  it('labels synthetic data, separate tickets, prices and booking links honestly', async () => {
    const r = await search(SCENARIO);
    const viaMilan = r.itineraries.find((i) => i.legs[0]!.tripId === 'B_ZRH_MIL_1900')!;
    expect(viaMilan.synthetic).toBe(true);
    expect(viaMilan.separateTickets).toBe(true);
    expect(viaMilan.operators.map((o) => o.name).sort()).toEqual(['Fixture Bus Bravo (synthetic)', 'Fixture Lines Charlie (synthetic)']);
    expect(viaMilan.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['synthetic_data', 'separate_tickets', 'availability_not_verified', 'cross_border', 'night_transfer']),
    );
    expect(viaMilan.price).toMatchObject({ status: 'complete', kind: 'indicative', knownLegs: 2, totalLegs: 2 });
    expect(viaMilan.price.totals).toEqual([
      { amount: 35, currency: 'CHF' },
      { amount: 24.9, currency: 'EUR' },
    ]);
    expect(viaMilan.legs.every((l) => l.booking.kind === 'none' && l.availability === 'not_verified')).toBe(true);
    expect(viaMilan.connections[0]).toMatchObject({ quality: 'comfortable', slackSeconds: 6300, separateTickets: true });
    const direct = r.itineraries.find((i) => i.transfers === 0)!;
    expect(direct.price.status).toBe('unknown');
    expect(direct.warnings.map((w) => w.code)).toContain('price_unknown');
  });

  it('builds the coverage statement from execution metadata, including an outage', async () => {
    const r = await search({ ...SCENARIO, dataScope: 'all' });
    const c = r.coverage;
    const status = Object.fromEntries(c.sources.map((s) => [s.id, s.status]));
    expect(status).toEqual({
      'fixture-zrh-bzo': 'used',
      'fixture-aggregator-copy': 'used',
      'fixture-manual-lugano-como': 'no_service_in_window',
      'test-outage': 'unavailable',
    });
    expect(c.sourcesConsulted).toBe(3);
    expect(c.sourcesWithServiceInWindow).toBe(2);
    expect(c.message).toBe(
      'Results based on 3 available timetable sources, 2 with services in this period, 2 of them synthetic test data. Some operators may not be represented. 1 source is currently unavailable. Prices are not queried live and seat availability is not verified.',
    );
    expect(c.livePricesQueried).toBe(false);
    expect(c.availabilityVerified).toBe(false);
  });

  it('distinguishes the empty outcomes', async () => {
    expect((await search({ ...SCENARIO, timeWindow: { from: '10:00', to: '11:00' }, departureNotBefore: { date: '2026-11-08', time: '06:00' } })).outcome).toBe(
      'no_journey_in_available_data',
    );
    expect((await search({ ...SCENARIO, date: '2030-01-06', departureNotBefore: { date: '2030-01-05', time: '12:00' } })).outcome).toBe(
      'no_timetable_data_for_dates',
    );
    expect((await search({ ...SCENARIO, destination: 'city:es-madrid' })).outcome).toBe('place_not_served');
  });

  it('works for the manually maintained JSON source', async () => {
    const r = await search({
      origin: 'city:ch-lugano',
      destination: 'city:it-como',
      mode: 'depart',
      date: '2026-11-09',
      dataScope: 'synthetic',
    });
    expect(r.itineraries.map((i) => `${i.departure.local} ${i.price.totals[0]?.amount} ${i.price.totals[0]?.currency}`).sort()).toEqual([
      '2026-11-09T07:05:00+01:00 9.8 CHF',
      '2026-11-09T18:05:00+01:00 9.8 CHF',
    ]);
  });

  it('applies realtime delays to dated trips', async () => {
    const [trip] = await sql<{ id: string }[]>`SELECT id FROM trip WHERE source_trip_id = 'C_MIL_BZO_0030'`;
    await sql`INSERT INTO realtime_update (source_id, trip_id, service_date, stop_updates, observed_at)
              VALUES ('fixture-zrh-bzo', ${trip!.id}, '2026-11-08',
                      ${sql.json([{ stopSequence: 1, stopId: null, arrivalDelay: null, departureDelay: 2400, arrivalTime: null, departureTime: null, skipped: false }])}, now())`;
    try {
      // The delayed C now arrives 05:25, exactly like B + G; exclude G's operator to observe C.
      const ops = (await app.inject({ url: '/api/operators' })).json().operators as Array<{ id: string; name: string }>;
      const golf = ops.find((o) => o.name === 'Fixture Golf Coaches (synthetic)')!.id;
      const r = await search({ ...SCENARIO, alternatives: false, excludeOperators: [golf] });
      const viaMilan = r.itineraries.find((i) => i.legs[1]?.tripId === 'C_MIL_BZO_0030' && i.legs[0]!.tripId === 'B_ZRH_MIL_1900')!;
      expect(viaMilan.legs[1]!.departure.local).toBe('2026-11-08T01:10:00+01:00');
      expect(viaMilan.arrival.local).toBe('2026-11-08T05:25:00+01:00');
      expect(viaMilan.legs[1]!.provenance.realtimeApplied).toBe(true);
    } finally {
      await sql`DELETE FROM realtime_update`;
    }
  });

  it('serves itineraries by id and validates input', async () => {
    const r = await search(SCENARIO);
    const one = await app.inject({ url: `/api/journeys/${r.itineraries[0]!.id}` });
    expect(one.statusCode).toBe(200);
    expect(one.json().itinerary.id).toBe(r.itineraries[0]!.id);
    expect((await app.inject({ url: '/api/journeys/itn_doesnotexist' })).statusCode).toBe(404);

    const bad = await app.inject({ method: 'POST', url: '/api/journeys/search', payload: { ...SCENARIO, date: '08.11.2026' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_request');
    const unknown = await app.inject({ method: 'POST', url: '/api/journeys/search', payload: { ...SCENARIO, origin: 'city:nowhere' } });
    expect(unknown.statusCode).toBe(404);
    const same = await app.inject({ method: 'POST', url: '/api/journeys/search', payload: { ...SCENARIO, destination: 'city:ch-zurich' } });
    expect(same.statusCode).toBe(400);
  });
});

describe('catalogue API', () => {
  it('unifies operators across sources', async () => {
    const ops = (await app.inject({ url: '/api/operators' })).json().operators as Array<{ name: string; sources: string[]; synthetic: boolean }>;
    const alpha = ops.find((o) => o.name === 'Fixture Coach Alpha (synthetic)')!;
    expect(alpha.sources.sort()).toEqual(['fixture-aggregator-copy', 'fixture-zrh-bzo']);
    expect(alpha.synthetic).toBe(true);
  });

  it('separates adapter status from verified live status', async () => {
    const sources = (await app.inject({ url: '/api/v1/data-sources/status' })).json().sources as Array<{ id: string; liveStatus: string; adapterStatus: string; counts: { trips: number } }>;
    const by = Object.fromEntries(sources.map((s) => [s.id, s]));
    expect(by['fixture-zrh-bzo']).toMatchObject({ liveStatus: 'not_applicable', counts: { trips: 12 } });
    expect(by['test-outage']).toMatchObject({ liveStatus: 'failing', adapterStatus: 'implemented', counts: { trips: 0 } });
    expect(by['flixbus-eu-gtfs']).toMatchObject({ liveStatus: 'never_run', adapterStatus: 'implemented' });
    expect(by['swiss-netex']).toMatchObject({ adapterStatus: 'not_implemented' });
  });

  it('hides synthetic data entirely when fixtures are disabled (public deployment)', async () => {
    const pub = await buildServer({ sql, config: { ...loadConfig({ DISABLE_FIXTURES: '1' }), logLevel: 'silent', rateLimitPerMinute: 100_000, dataVersionTtlMs: 0 }, cache: noCache });
    try {
      const res = (await pub.inject({ method: 'POST', url: '/api/journeys/search', payload: SCENARIO })).json() as JourneySearchResponse;
      expect(res.itineraries).toEqual([]);
      const ops = (await pub.inject({ url: '/api/operators' })).json().operators as Array<{ synthetic: boolean }>;
      expect(ops.some((o) => o.synthetic)).toBe(false);
      const sources = (await pub.inject({ url: '/api/v1/data-sources/status' })).json().sources as Array<{ id: string; synthetic: boolean }>;
      expect(sources.some((s) => s.synthetic)).toBe(false);
      expect(sources.map((s) => s.id)).toContain('flixbus-eu-gtfs');
    } finally {
      await pub.close();
    }
  });

  it('exposes OpenAPI documentation', async () => {
    const res = await app.inject({ url: '/api/docs/json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.info.version).toBe('v1');
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/api/v1/places/search', '/api/v1/journeys/search', '/api/v1/journeys/{id}', '/api/v1/operators', '/api/v1/data-sources/status']),
    );
  });
});
