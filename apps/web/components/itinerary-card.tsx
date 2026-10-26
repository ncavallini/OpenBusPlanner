'use client';

import { AlertTriangle, ChevronDown, ExternalLink, Footprints, FlaskConical, Moon, Ticket, Train, Bus } from 'lucide-react';
import type { Itinerary } from '@/lib/api';
import { day, dayOffset, distance, duration, money, time } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Badge, Button } from './ui/primitives';

const QUALITY: Record<string, { label: string; tone: 'ok' | 'warn' | 'risk' }> = {
  comfortable: { label: 'Comfortable', tone: 'ok' },
  reasonable: { label: 'Reasonable', tone: 'warn' },
  risky: { label: 'Risky', tone: 'risk' },
};

export function PriceLabel({ it }: { it: Itinerary }) {
  if (it.price.status === 'complete') {
    return (
      <span className="text-right">
        <span className="block font-semibold tabular">{it.price.totals.map((t) => money(t.amount, t.currency)).join(' + ')}</span>
        <span className="block text-xs text-muted">{it.price.kind === 'live' ? 'live price' : 'indicative price'}</span>
      </span>
    );
  }
  if (it.price.status === 'partial')
    return (
      <span className="text-right text-xs text-muted">
        Price known for {it.price.knownLegs} of {it.price.totalLegs} legs
      </span>
    );
  return <span className="text-right text-xs text-muted">Price unknown</span>;
}

export function ItineraryCard({
  it,
  expanded,
  onToggle,
  selected,
  onSelect,
  compared,
  onCompare,
}: {
  it: Itinerary;
  expanded: boolean;
  onToggle: () => void;
  selected: boolean;
  onSelect: () => void;
  compared: boolean;
  onCompare: () => void;
}) {
  const first = it.legs[0]!;
  const last = it.legs[it.legs.length - 1]!;
  const offset = dayOffset(it.departure, it.arrival);
  return (
    <article
      data-testid="itinerary"
      aria-label={`${time(it.departure)} to ${time(it.arrival)}, ${it.transfers} transfers`}
      className={cn('rounded-[var(--radius-card)] border bg-surface shadow-sm transition-shadow', selected ? 'border-brand-500 ring-1 ring-brand-500' : 'border-line')}
    >
      <div className="grid cursor-pointer grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 p-4 md:flex md:flex-wrap md:gap-x-6" onClick={onSelect}>
        <div className="min-w-[10rem]">
          <div className="text-lg font-semibold tabular">
            {time(it.departure)} – {time(it.arrival)}
            {offset > 0 && (
              <sup className="ml-0.5 text-xs font-semibold text-brand-700" title={`Arrives ${day(it.arrival)}`}>
                +{offset}
              </sup>
            )}
          </div>
          <div className="text-xs text-muted">
            {day(it.departure)} · {first.from.cityName ?? first.from.name} → {last.to.cityName ?? last.to.name}
          </div>
        </div>
        <div className="min-w-[6rem]">
          <div className="text-sm font-medium tabular">{duration(it.durationSeconds)}</div>
          <div className="text-xs text-muted">
            {it.transfers === 0 ? 'Direct' : `${it.transfers} transfer${it.transfers > 1 ? 's' : ''}`}
            {it.connections.length > 0 && ` · ${it.connections.map((c) => c.fromStop.cityName ?? c.fromStop.name).join(', ')}`}
          </div>
        </div>
        <div className="col-span-2 min-w-0 md:flex-1">
          <div className="truncate text-sm">{it.operators.map((o) => o.name).join(' + ')}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {it.synthetic && (
              <Badge tone="synthetic" data-testid="synthetic-badge">
                <FlaskConical className="h-3 w-3" aria-hidden /> Test data
              </Badge>
            )}
            {it.worstConnection && <Badge tone={QUALITY[it.worstConnection]!.tone}>{QUALITY[it.worstConnection]!.label} connection</Badge>}
            {it.separateTickets && (
              <Badge tone="info">
                <Ticket className="h-3 w-3" aria-hidden /> {it.legs.length} tickets
              </Badge>
            )}
            {!it.paretoOptimal && <Badge tone="neutral">Alternative via other cities</Badge>}
            {it.walkingMeters > 0 && (
              <Badge tone="neutral">
                <Footprints className="h-3 w-3" aria-hidden /> {distance(it.walkingMeters)}
              </Badge>
            )}
            {it.overnightWaitSeconds >= 3600 && (
              <Badge tone="neutral">
                <Moon className="h-3 w-3" aria-hidden /> Night wait {duration(it.overnightWaitSeconds)}
              </Badge>
            )}
          </div>
        </div>
        <PriceLabel it={it} />
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <label className="inline-flex items-center gap-1 text-xs text-muted">
            <input type="checkbox" checked={compared} onChange={onCompare} aria-label="Add to comparison" /> Compare
          </label>
          <Button variant="ghost" size="icon" aria-expanded={expanded} aria-label={expanded ? 'Hide details' : 'Show details'} onClick={onToggle} data-testid="toggle-details">
            <ChevronDown className={cn('h-5 w-5 transition-transform', expanded && 'rotate-180')} />
          </Button>
        </div>
      </div>
      {expanded && <ItineraryTimeline it={it} />}
    </article>
  );
}

export function ItineraryTimeline({ it }: { it: Itinerary }) {
  const start = it.departure;
  return (
    <div className="border-t border-line px-4 pt-3 pb-4" data-testid="itinerary-details">
      {it.warnings.some((w) => w.code === 'synthetic_data') && (
        <p className="mb-3 rounded-md bg-violet-50 p-2 text-sm text-violet-900">
          <FlaskConical className="mr-1 inline h-4 w-4" aria-hidden />
          Synthetic test fixture: these departures are invented and do not exist.
        </p>
      )}
      <ol className="relative space-y-0">
        {it.legs.map((leg, i) => {
          const conn = it.connections[i];
          const off = (tp: typeof leg.departure) => dayOffset(start, tp);
          const Icon = leg.mode === 'rail' ? Train : Bus;
          return (
            <li key={`${leg.tripId}-${i}`}>
              <div className="grid grid-cols-[4.5rem_1.5rem_1fr] gap-x-2">
                <div className="text-right text-sm font-semibold tabular">
                  {time(leg.departure)}
                  {off(leg.departure) > 0 && <sup className="text-[10px] text-brand-700">+{off(leg.departure)}</sup>}
                  <div className="text-[11px] font-normal text-muted">{day(leg.departure)}</div>
                </div>
                <div className="flex flex-col items-center">
                  <span className="mt-1 h-3 w-3 rounded-full border-2 border-brand-600 bg-surface" />
                  <span className="w-0.5 flex-1 bg-brand-500" />
                </div>
                <div className="pb-1 text-sm font-medium">
                  {leg.from.name}
                  <span className="ml-1 text-xs font-normal text-muted">{leg.from.countryCode}</span>
                </div>
                <div />
                <div className="flex justify-center">
                  <span className="w-0.5 bg-brand-500" />
                </div>
                <div className="my-1 rounded-lg bg-canvas p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Icon className="h-4 w-4 text-brand-700" aria-hidden />
                    <span className="font-medium">{leg.operator.name}</span>
                    {leg.routeName && <span className="text-muted">{leg.routeName}</span>}
                    {leg.headsign && <span className="text-muted">→ {leg.headsign}</span>}
                    <span className="text-muted">· {duration(leg.durationSeconds)}</span>
                    {leg.crossesBorder && <Badge tone="neutral">Crosses border</Badge>}
                  </div>
                  {leg.intermediateStops.length > 0 && (
                    <details className="mt-1 text-xs text-muted">
                      <summary className="cursor-pointer">{leg.intermediateStops.length} intermediate stops</summary>
                      <ul className="mt-1 space-y-0.5">
                        {leg.intermediateStops.map((s) => (
                          <li key={s.stationId}>
                            {s.arrival ? time(s.arrival) : ''} {s.name}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                    <span>
                      {leg.price.status === 'known'
                        ? `${money(leg.price.amount!, leg.price.currency!)} (${leg.price.kind})`
                        : 'Price unknown'}
                    </span>
                    <span className="text-muted">Seat availability not verified</span>
                    {leg.booking.url ? (
                      <a className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline" href={leg.booking.url} target="_blank" rel="noopener noreferrer nofollow">
                        {leg.booking.label} <ExternalLink className="h-3 w-3" aria-hidden />
                      </a>
                    ) : (
                      <span className="text-muted">{leg.booking.label}</span>
                    )}
                  </div>
                  <div className="mt-1 text-[11px] text-muted" data-testid="provenance">
                    Source: {leg.provenance.sourceName}
                    {leg.provenance.synthetic ? ' (synthetic)' : ''}
                    {leg.provenance.importedAt && ` · imported ${new Date(leg.provenance.importedAt).toLocaleDateString('en-GB')}`}
                    {leg.provenance.freshness !== 'unknown' && ` · ${leg.provenance.freshness}`}
                    {leg.provenance.realtimeApplied && ' · realtime applied'}
                    {leg.provenance.alsoFoundIn.length > 0 && ` · also in ${leg.provenance.alsoFoundIn.join(', ')}`}
                    {leg.provenance.license && ` · ${leg.provenance.license}`}
                  </div>
                </div>
                <div className="text-right text-sm font-semibold tabular">
                  {time(leg.arrival)}
                  {off(leg.arrival) > 0 && <sup className="text-[10px] text-brand-700">+{off(leg.arrival)}</sup>}
                  <div className="text-[11px] font-normal text-muted">{day(leg.arrival)}</div>
                </div>
                <div className="flex flex-col items-center">
                  <span className="h-1 w-0.5 bg-brand-500" />
                  <span className="h-3 w-3 rounded-full border-2 border-brand-600 bg-surface" />
                </div>
                <div className="text-sm font-medium">
                  {leg.to.name}
                  <span className="ml-1 text-xs font-normal text-muted">{leg.to.countryCode}</span>
                </div>
              </div>
              {conn && (
                <div className="my-2 ml-[6.5rem] rounded-lg border border-dashed border-line p-2 text-sm" data-testid="connection">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={QUALITY[conn.quality]!.tone}>{QUALITY[conn.quality]!.label}</Badge>
                    <span>
                      Transfer: {duration(conn.waitSeconds)}
                      {conn.walk && (
                        <>
                          {' '}
                          incl. <Footprints className="inline h-3 w-3" aria-hidden /> {distance(conn.walk.meters)} walk ({duration(conn.walk.seconds)},{' '}
                          {conn.walk.method === 'estimated' ? 'estimated' : 'routed'}) to {conn.toStop.name}
                        </>
                      )}
                    </span>
                  </div>
                  <ul className="mt-1 list-disc pl-5 text-xs text-muted">
                    {conn.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {it.warnings.filter((w) => w.code !== 'synthetic_data').length > 0 && (
        <ul className="mt-3 space-y-1 text-sm" aria-label="Warnings">
          {it.warnings
            .filter((w) => w.code !== 'synthetic_data')
            .map((w) => (
              <li key={w.code} className={cn('flex gap-2', w.code === 'separate_tickets' || w.code === 'risky_connection' ? 'text-amber-900' : 'text-muted')} data-testid={`warning-${w.code}`}>
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" aria-hidden /> {w.message}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
