import { describe, expect, it } from 'vitest';
import {
  classifyTransfer,
  epochToLocalIso,
  gtfsOffsetToEpoch,
  isoWeekdayIndex,
  localDayDifference,
  matchCity,
  nameSimilarity,
  nightOverlapSeconds,
  normalizeName,
  parseGtfsTime,
  searchGazetteer,
  serviceDayReference,
  TransferQuality,
  type TransferPolicy,
} from '../src/index';

describe('GTFS time semantics', () => {
  it('parses times beyond 24:00', () => {
    expect(parseGtfsTime('25:35:00')).toBe(25 * 3600 + 35 * 60);
    expect(parseGtfsTime('7:05:09')).toBe(7 * 3600 + 5 * 60 + 9);
    expect(() => parseGtfsTime('7:65:00')).toThrow();
  });

  it('uses noon minus 12h as reference on DST spring-forward day', () => {
    // 2026-03-29: Europe/Zurich switches 02:00 CET -> 03:00 CEST.
    const ref = serviceDayReference('2026-03-29', 'Europe/Zurich');
    expect(new Date(ref * 1000).toISOString()).toBe('2026-03-28T22:00:00.000Z'); // 23:00 CET previous day
    expect(epochToLocalIso(gtfsOffsetToEpoch('2026-03-29', 'Europe/Zurich', parseGtfsTime('08:00:00')), 'Europe/Zurich')).toBe(
      '2026-03-29T08:00:00+02:00',
    );
  });

  it('handles the DST fall-back day and overnight trips across it', () => {
    // 2026-10-25: Europe/Rome switches 03:00 CEST -> 02:00 CET.
    const dep = gtfsOffsetToEpoch('2026-10-24', 'Europe/Rome', parseGtfsTime('22:00:00'));
    const arr = gtfsOffsetToEpoch('2026-10-24', 'Europe/Rome', parseGtfsTime('30:00:00'));
    expect(epochToLocalIso(dep, 'Europe/Rome')).toBe('2026-10-24T22:00:00+02:00');
    // 30:00 counts elapsed time from the 24th's reference, so after the fall-back it reads 05:00 local.
    expect(epochToLocalIso(arr, 'Europe/Rome')).toBe('2026-10-25T05:00:00+01:00');
    expect(arr - dep).toBe(8 * 3600);
    const sameDay = gtfsOffsetToEpoch('2026-10-25', 'Europe/Rome', parseGtfsTime('08:00:00'));
    expect(epochToLocalIso(sameDay, 'Europe/Rome')).toBe('2026-10-25T08:00:00+01:00');
  });

  it('computes weekdays and day differences across time zones', () => {
    expect(isoWeekdayIndex('2026-11-08')).toBe(6); // Sunday
    expect(isoWeekdayIndex('2026-11-02')).toBe(0); // Monday
    const dep = gtfsOffsetToEpoch('2026-11-07', 'Europe/Zurich', parseGtfsTime('22:00:00'));
    const arr = gtfsOffsetToEpoch('2026-11-07', 'Europe/Zurich', parseGtfsTime('26:30:00'));
    expect(localDayDifference(dep, 'Europe/Zurich', arr, 'Europe/Rome')).toBe(1);
    expect(localDayDifference(dep, 'Europe/London', dep, 'Europe/Zurich')).toBe(0);
  });

  it('measures night overlap', () => {
    const start = gtfsOffsetToEpoch('2026-11-07', 'Europe/Zurich', parseGtfsTime('23:00:00'));
    const end = gtfsOffsetToEpoch('2026-11-07', 'Europe/Zurich', parseGtfsTime('26:00:00'));
    expect(nightOverlapSeconds('Europe/Zurich', start, end)).toBe(2 * 3600);
  });
});

describe('name normalisation and gazetteer', () => {
  it('normalises spelling variants to the same key', () => {
    expect(normalizeName('Zürich HB')).toBe(normalizeName('Zurich Hauptbahnhof'));
    expect(normalizeName('Bolzano/Bozen')).toBe('bolzano bozen');
    expect(nameSimilarity('Milano Lampugnano', 'Milan (Lampugnano)')).toBeGreaterThan(0.3);
  });

  it('resolves multilingual city aliases', () => {
    expect(searchGazetteer('Bozen')[0]?.id).toBe('it-bolzano');
    expect(searchGazetteer('Mailand')[0]?.id).toBe('it-milan');
    expect(searchGazetteer('zurich')[0]?.id).toBe('ch-zurich');
    expect(searchGazetteer('München')[0]?.id).toBe('de-munich');
  });

  it('assigns stops to cities by proximity, not by name alone', () => {
    expect(matchCity(47.3784, 8.5328, 'Zürich, Sihlquai')?.id).toBe('ch-zurich');
    expect(matchCity(45.4893, 9.1236, 'Milano Lampugnano')?.id).toBe('it-milan');
    // A stop named "Milano ..." 60 km away is not merged into Milan.
    expect(matchCity(45.95, 9.6, 'Milano Road Stop')).toBeUndefined();
  });
});

describe('transfer feasibility model', () => {
  const policy: TransferPolicy = { minTransferSeconds: 600, maxWaitSeconds: 8 * 3600, riskPreference: 'balanced' };
  const ctx = { walked: false, walkSeconds: 0, inboundInternational: false, atNight: false, stationMinTransferSeconds: 0 };
  it('classifies by slack with explainable thresholds', () => {
    expect(classifyTransfer(policy, { ...ctx, slackSeconds: 5 * 60 })).toBe(-1);
    expect(classifyTransfer(policy, { ...ctx, slackSeconds: 15 * 60 })).toBe(TransferQuality.Risky);
    expect(classifyTransfer(policy, { ...ctx, slackSeconds: 25 * 60 })).toBe(TransferQuality.Reasonable);
    expect(classifyTransfer(policy, { ...ctx, slackSeconds: 50 * 60 })).toBe(TransferQuality.Comfortable);
    expect(classifyTransfer(policy, { ...ctx, slackSeconds: 9 * 3600 })).toBe(-1);
  });
  it('is stricter for international arrivals, walks and cautious users', () => {
    expect(classifyTransfer(policy, { ...ctx, slackSeconds: 50 * 60, inboundInternational: true })).toBe(TransferQuality.Reasonable);
    expect(classifyTransfer(policy, { ...ctx, slackSeconds: 25 * 60, walked: true, walkSeconds: 600 })).toBe(TransferQuality.Risky);
    expect(classifyTransfer({ ...policy, riskPreference: 'cautious' }, { ...ctx, slackSeconds: 50 * 60 })).toBe(TransferQuality.Reasonable);
    expect(classifyTransfer({ ...policy, riskPreference: 'adventurous' }, { ...ctx, slackSeconds: 31 * 60 })).toBe(TransferQuality.Comfortable);
  });
  it('uses historical delay statistics when there are enough samples', () => {
    const delayStats = { p50Seconds: 20 * 60, p90Seconds: 70 * 60, samples: 50 };
    expect(classifyTransfer(policy, { ...ctx, slackSeconds: 50 * 60, delayStats })).toBe(TransferQuality.Reasonable);
    expect(classifyTransfer(policy, { ...ctx, slackSeconds: 25 * 60, delayStats })).toBe(TransferQuality.Risky);
    expect(classifyTransfer(policy, { ...ctx, slackSeconds: 25 * 60, delayStats: { ...delayStats, samples: 3 } })).toBe(TransferQuality.Reasonable);
  });
});
