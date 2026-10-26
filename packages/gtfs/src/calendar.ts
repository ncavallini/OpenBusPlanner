import { addDays, isoWeekdayIndex, type IsoDate } from '@openbus/core';
import type { GtfsCalendar, GtfsCalendarDate } from './feed';

/**
 * Expands calendar.txt + calendar_dates.txt into the set of active service dates per
 * service_id, restricted to [from, to]. Exceptions override the weekly pattern.
 */
export function expandServiceDates(
  calendars: GtfsCalendar[],
  calendarDates: GtfsCalendarDate[],
  from: IsoDate,
  to: IsoDate,
): Map<string, Set<IsoDate>> {
  const out = new Map<string, Set<IsoDate>>();
  const get = (id: string) => {
    let s = out.get(id);
    if (!s) out.set(id, (s = new Set()));
    return s;
  };
  for (const c of calendars) {
    const start = c.start > from ? c.start : from;
    const end = c.end < to ? c.end : to;
    const set = get(c.serviceId);
    for (let d = start; d <= end; d = addDays(d, 1)) {
      if (c.days[isoWeekdayIndex(d)]) set.add(d);
    }
  }
  for (const cd of calendarDates) {
    if (cd.date < from || cd.date > to) continue;
    const set = get(cd.serviceId);
    if (cd.added) set.add(cd.date);
    else set.delete(cd.date);
  }
  return out;
}

/** Validity range covered by a feed's calendars (null if it has none). */
export function calendarCoverage(
  calendars: GtfsCalendar[],
  calendarDates: GtfsCalendarDate[],
): { from: IsoDate; to: IsoDate } | null {
  let from: IsoDate | null = null;
  let to: IsoDate | null = null;
  const consider = (a: IsoDate, b: IsoDate) => {
    if (!from || a < from) from = a;
    if (!to || b > to) to = b;
  };
  for (const c of calendars) consider(c.start, c.end);
  for (const d of calendarDates) if (d.added) consider(d.date, d.date);
  return from && to ? { from, to } : null;
}

