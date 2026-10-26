import { describe, expect, it } from 'vitest';
import type { SourceInfo } from '@openbus/db';
import { freshness } from '../src/search-service';

const src = (o: Partial<SourceInfo>): SourceInfo => ({
  id: 's', name: 's', synthetic: false, enabled: true, license: null, attribution: null, priority: 0,
  refreshHours: 24, homepage: null, lastSuccess: null, lastStatus: null, lastMessage: null, ...o,
});
const imported = (hoursAgo: number) => ({ finishedAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), feedVersion: null, validFrom: null, validTo: null });

describe('data freshness', () => {
  it('classifies by age relative to the refresh interval', () => {
    expect(freshness(src({ lastSuccess: imported(10) }))).toBe('fresh');
    expect(freshness(src({ lastSuccess: imported(100) }))).toBe('aging');
    expect(freshness(src({ lastSuccess: imported(24 * 30) }))).toBe('stale');
    expect(freshness(src({ lastSuccess: null }))).toBe('unknown');
    expect(freshness(src({ synthetic: true, lastSuccess: imported(1) }))).toBe('unknown');
  });
});
