import { DateTime } from 'luxon';

/** ISO calendar date, e.g. "2026-11-01". Always interpreted in a specific IANA time zone. */
export type IsoDate = string;

const GTFS_TIME = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parses a GTFS time ("25:35:00") into seconds after the service day's reference
 * ("noon minus 12h"). Values above 24:00:00 are valid and denote the next calendar day.
 */
export function parseGtfsTime(value: string): number {
  const m = GTFS_TIME.exec(value.trim());
  if (!m) throw new Error(`Invalid GTFS time "${value}"`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export function formatGtfsTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Converts GTFS "YYYYMMDD" to ISO "YYYY-MM-DD". */
export function gtfsDateToIso(value: string): IsoDate {
  const v = value.trim();
  if (!/^\d{8}$/.test(v)) throw new Error(`Invalid GTFS date "${value}"`);
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}

export function assertIsoDate(value: string): IsoDate {
  if (!ISO_DATE.test(value)) throw new Error(`Invalid ISO date "${value}"`);
  return value;
}

/** Day of week for a calendar date, 0 = Monday … 6 = Sunday (GTFS calendar.txt column order). */
export function isoWeekdayIndex(date: IsoDate): number {
  const m = ISO_DATE.exec(date);
  if (!m) throw new Error(`Invalid ISO date "${date}"`);
  const js = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return (js + 6) % 7;
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const m = ISO_DATE.exec(date);
  if (!m) throw new Error(`Invalid ISO date "${date}"`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return d.toISOString().slice(0, 10);
}

/** Inclusive list of dates from `from` to `to`. */
export function dateRange(from: IsoDate, to: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function compareIsoDates(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Epoch seconds of the GTFS service-day reference point: noon minus 12 hours, local time.
 * This equals local midnight except on DST transition days, which is exactly how the GTFS
 * reference defines stop_times offsets.
 */
export function serviceDayReference(date: IsoDate, timeZone: string): number {
  const noon = DateTime.fromISO(`${assertIsoDate(date)}T12:00:00`, { zone: timeZone });
  if (!noon.isValid) throw new Error(`Invalid time zone "${timeZone}" or date "${date}"`);
  return Math.round(noon.toSeconds()) - 12 * 3600;
}

/** Absolute epoch seconds for a GTFS offset on a service day in a time zone. */
export function gtfsOffsetToEpoch(date: IsoDate, timeZone: string, offsetSeconds: number): number {
  return serviceDayReference(date, timeZone) + offsetSeconds;
}

/** Epoch seconds of a local wall-clock time, e.g. ("2026-11-01", "04:00", "Europe/Rome"). */
export function localTimeToEpoch(date: IsoDate, hhmm: string, timeZone: string): number {
  const dt = DateTime.fromISO(`${assertIsoDate(date)}T${hhmm}`, { zone: timeZone });
  if (!dt.isValid) throw new Error(`Invalid local time ${date} ${hhmm} ${timeZone}`);
  return Math.round(dt.toSeconds());
}

export function epochToLocalIso(epochSeconds: number, timeZone: string): string {
  return DateTime.fromSeconds(epochSeconds, { zone: timeZone }).toISO({
    suppressMilliseconds: true,
  })!;
}

export function epochToLocalDate(epochSeconds: number, timeZone: string): IsoDate {
  return DateTime.fromSeconds(epochSeconds, { zone: timeZone }).toISODate()!;
}

const offsetCache = new Map<string, number>();

/** UTC offset in seconds for a zone at an instant. Memoised per 15-minute bucket (hot path). */
export function utcOffsetSeconds(timeZone: string, epochSeconds: number): number {
  const key = `${timeZone}|${Math.floor(epochSeconds / 900)}`;
  let v = offsetCache.get(key);
  if (v === undefined) {
    v = DateTime.fromSeconds(epochSeconds, { zone: timeZone }).offset * 60;
    if (offsetCache.size > 200_000) offsetCache.clear();
    offsetCache.set(key, v);
  }
  return v;
}

/** Local seconds-of-day (0..86399) at an instant in a zone. */
export function localSecondsOfDay(timeZone: string, epochSeconds: number): number {
  const local = epochSeconds + utcOffsetSeconds(timeZone, epochSeconds);
  return ((local % 86400) + 86400) % 86400;
}

/**
 * Seconds of the interval [start, end) that fall into local night hours [nightStart, nightEnd)
 * (defaults 00:00–05:00) in the given zone.
 */
export function nightOverlapSeconds(
  timeZone: string,
  start: number,
  end: number,
  nightStartHour = 0,
  nightEndHour = 5,
): number {
  if (end <= start) return 0;
  let total = 0;
  // Step through in 15-minute slices; intervals are bounded by max transfer wait (hours).
  const step = 900;
  for (let t = start; t < end; t += step) {
    const sliceEnd = Math.min(end, t + step);
    const sod = localSecondsOfDay(timeZone, t);
    if (sod >= nightStartHour * 3600 && sod < nightEndHour * 3600) total += sliceEnd - t;
  }
  return total;
}

/** Number of calendar days between two instants' local dates (for "+1 day" indicators). */
export function localDayDifference(
  fromEpoch: number,
  fromZone: string,
  toEpoch: number,
  toZone: string,
): number {
  const a = epochToLocalDate(fromEpoch, fromZone);
  const b = epochToLocalDate(toEpoch, toZone);
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function isValidTimeZone(timeZone: string): boolean {
  return DateTime.local().setZone(timeZone).isValid;
}
