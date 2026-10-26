import { DateTime } from 'luxon';
import type { TimePoint } from '@openbus/core/api';

/** Times are always shown in the stop's own time zone (as printed on the operator's timetable). */
export function time(tp: TimePoint): string {
  return DateTime.fromSeconds(tp.epoch, { zone: tp.timezone }).toFormat('HH:mm');
}

export function day(tp: TimePoint): string {
  return DateTime.fromSeconds(tp.epoch, { zone: tp.timezone }).toFormat('ccc d LLL');
}

export function dayTime(tp: TimePoint): string {
  return DateTime.fromSeconds(tp.epoch, { zone: tp.timezone }).toFormat("ccc d LLL', 'HH:mm");
}

export function zoneAbbrev(tp: TimePoint): string {
  return DateTime.fromSeconds(tp.epoch, { zone: tp.timezone }).toFormat('ZZZZ');
}

/** Calendar-day offset of b relative to a's local date (for "+1" markers). */
export function dayOffset(a: TimePoint, b: TimePoint): number {
  const da = DateTime.fromSeconds(a.epoch, { zone: a.timezone }).startOf('day');
  const db = DateTime.fromSeconds(b.epoch, { zone: b.timezone });
  const dbDay = DateTime.fromObject({ year: db.year, month: db.month, day: db.day }, { zone: a.timezone });
  return Math.round(dbDay.diff(da, 'days').days);
}

export function duration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')} min`;
}

export function distance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`;
}

export function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function relativeAge(iso: string | null): string {
  if (!iso) return 'never';
  return DateTime.fromISO(iso).toRelative() ?? iso;
}

/** Next date with the given ISO weekday (1 = Monday … 7 = Sunday), starting tomorrow. */
export function nextWeekday(weekday: number, from = DateTime.now()): string {
  let d = from.plus({ days: 1 });
  while (d.weekday !== weekday) d = d.plus({ days: 1 });
  return d.toISODate()!;
}
