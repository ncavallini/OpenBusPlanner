'use client';

import { AlertCircle, CloudOff, MapPinOff, SearchX } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SortKey } from '@openbus/core/api';
import { ApiRequestError, searchJourneys, type Itinerary, type JourneySearchRequest, type JourneySearchResponse } from '@/lib/api';
import { day, duration, nextWeekday, time } from '@/lib/format';
import { CoverageNotice } from './coverage-notice';
import { ItineraryCard, PriceLabel } from './itinerary-card';
import { SearchForm, type SearchState } from './search-form';
import { Badge, Card, Select } from './ui/primitives';

const JourneyMap = dynamic(() => import('./journey-map').then((m) => m.JourneyMap), { ssr: false });

function stateFromParams(p: URLSearchParams): SearchState {
  const sunday = nextWeekday(7);
  const mode = p.get('mode') === 'depart' ? 'depart' : p.get('mode') === 'arrive' ? 'arrive' : 'depart';
  const date = p.get('date') ?? sunday;
  return {
    from: p.get('from') ? { id: p.get('from')!, name: p.get('fromName') ?? p.get('from')! } : null,
    to: p.get('to') ? { id: p.get('to')!, name: p.get('toName') ?? p.get('to')! } : null,
    mode,
    date,
    windowFrom: p.get('wf') ?? '00:00',
    windowTo: p.get('wt') ?? '23:59',
    maxTransfers: Number(p.get('maxTransfers') ?? 3),
    notBeforeDate: p.get('nbd') ?? '',
    notBeforeTime: p.get('nbt') ?? '12:00',
    risk: (p.get('risk') as SearchState['risk']) ?? 'balanced',
    excludeRisky: p.get('noRisky') === '1',
    minTransfer: Number(p.get('minTransfer') ?? 10),
    scope: (['all', 'real', 'synthetic'] as const).find((x) => x === p.get('scope')),
  };
}

function paramsFromState(s: SearchState): string {
  const p = new URLSearchParams();
  if (s.from) {
    p.set('from', s.from.id);
    p.set('fromName', s.from.name);
  }
  if (s.to) {
    p.set('to', s.to.id);
    p.set('toName', s.to.name);
  }
  p.set('mode', s.mode);
  p.set('date', s.date);
  p.set('wf', s.windowFrom);
  p.set('wt', s.windowTo);
  p.set('maxTransfers', String(s.maxTransfers));
  if (s.mode === 'arrive' && s.notBeforeDate) {
    p.set('nbd', s.notBeforeDate);
    p.set('nbt', s.notBeforeTime);
  }
  if (s.risk !== 'balanced') p.set('risk', s.risk);
  if (s.excludeRisky) p.set('noRisky', '1');
  if (s.minTransfer !== 10) p.set('minTransfer', String(s.minTransfer));
  if (s.scope) p.set('scope', s.scope);
  return p.toString();
}

function toRequest(s: SearchState): JourneySearchRequest {
  return {
    origin: s.from!.id,
    destination: s.to!.id,
    mode: s.mode,
    date: s.date,
    timeWindow: { from: s.windowFrom, to: s.windowTo },
    ...(s.mode === 'arrive' && s.notBeforeDate ? { departureNotBefore: { date: s.notBeforeDate, time: s.notBeforeTime } } : {}),
    maxTransfers: s.maxTransfers,
    minTransferMinutes: s.minTransfer,
    transportModes: ['bus'],
    riskPreference: s.risk,
    excludeRiskyTransfers: s.excludeRisky,
    alternatives: true,
    ...(s.scope ? { dataScope: s.scope } : {}),
  };
}

const EMPTY: Record<string, { icon: typeof SearchX; title: string }> = {
  no_journey_in_available_data: { icon: SearchX, title: 'No journey found in the available data' },
  no_timetable_data_for_dates: { icon: AlertCircle, title: 'No timetable data for these dates' },
  sources_unavailable: { icon: CloudOff, title: 'Timetable sources temporarily unavailable' },
  place_not_served: { icon: MapPinOff, title: 'This place is not served by any imported timetable' },
};

export function SearchPage() {
  const params = useSearchParams();
  const router = useRouter();
  const initial = useMemo(() => stateFromParams(new URLSearchParams(params.toString())), [params]);
  const [res, setRes] = useState<JourneySearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [compare, setCompare] = useState<string[]>([]);
  const [sort, setSort] = useState<SortKey>('departure');
  const [filters, setFilters] = useState({ maxTransfers: 9, hideRisky: false, paretoOnly: false, operator: '' });
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!initial.from || !initial.to) return;
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setBusy(true);
    setError(null);
    searchJourneys(toRequest(initial), c.signal)
      .then((r) => {
        setRes(r);
        setSelected(r.itineraries[0]?.id ?? null);
        setExpanded(null);
        setCompare([]);
      })
      .catch((e) => {
        if (c.signal.aborted) return;
        setError(e instanceof ApiRequestError ? e.message : 'The search service could not be reached.');
        setRes(null);
      })
      .finally(() => !c.signal.aborted && setBusy(false));
    return () => c.abort();
  }, [initial]);

  const operators = useMemo(() => [...new Set(res?.itineraries.flatMap((i) => i.operators.map((o) => o.name)) ?? [])].sort(), [res]);
  const shown = useMemo(() => {
    if (!res) return [];
    const list = res.itineraries.filter(
      (i) =>
        i.transfers <= filters.maxTransfers &&
        (!filters.hideRisky || i.worstConnection !== 'risky') &&
        (!filters.paretoOnly || i.paretoOptimal) &&
        (!filters.operator || i.operators.some((o) => o.name === filters.operator)),
    );
    const key: Record<SortKey, (a: Itinerary, b: Itinerary) => number> = {
      recommended: (a, b) => a.score - b.score,
      arrival: (a, b) => a.arrival.epoch - b.arrival.epoch,
      departure: (a, b) => a.departure.epoch - b.departure.epoch,
      duration: (a, b) => a.durationSeconds - b.durationSeconds,
      transfers: (a, b) => a.transfers - b.transfers || a.durationSeconds - b.durationSeconds,
      price: (a, b) => priceValue(a) - priceValue(b),
      reliability: (a, b) => qualityValue(a) - qualityValue(b) || a.durationSeconds - b.durationSeconds,
      walking: (a, b) => a.walkingMeters - b.walkingMeters,
    };
    return [...list].sort(key[sort]);
  }, [res, filters, sort]);
  const selectedIt = shown.find((i) => i.id === selected) ?? shown[0] ?? null;
  const compared = (res?.itineraries ?? []).filter((i) => compare.includes(i.id));

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <Card className="p-4 md:p-6">
        <h1 className="mb-1 text-xl font-semibold md:text-2xl">Find long-distance bus journeys across operators</h1>
        <p className="mb-4 text-sm text-muted">
          Combines departures from independent companies — including connections no single operator sells — and tells you exactly which data was searched.
        </p>
        <SearchForm key={params.toString()} initial={initial} busy={busy} onSubmit={(s) => router.push(`/?${paramsFromState(s)}`)} />
      </Card>

      {error && (
        <div role="alert" className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error}
        </div>
      )}
      {busy && (
        <p className="mt-6 text-sm text-muted" role="status">
          Searching dated departures across all sources…
        </p>
      )}

      {res && !busy && (
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <section aria-label="Results" className="space-y-3">
            <CoverageNotice res={res} />
            {res.itineraries.length === 0 ? (
              <EmptyState res={res} />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="font-medium" data-testid="result-count">
                    {shown.length} of {res.itineraries.length} itineraries
                  </span>
                  <label className="inline-flex items-center gap-1">
                    Sort
                    <Select aria-label="Sort results" data-testid="sort-select" className="h-9 w-40" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                      <option value="departure">Departure time</option>
                      <option value="recommended">Recommended</option>
                      <option value="arrival">Arrival time</option>
                      <option value="duration">Duration</option>
                      <option value="transfers">Fewest transfers</option>
                      <option value="reliability">Safest connections</option>
                      <option value="price">Price (known)</option>
                      <option value="walking">Least walking</option>
                    </Select>
                  </label>
                  <Select aria-label="Maximum transfers" className="h-9 w-36" value={filters.maxTransfers} onChange={(e) => setFilters((f) => ({ ...f, maxTransfers: Number(e.target.value) }))}>
                    <option value={9}>Any transfers</option>
                    <option value={0}>Direct</option>
                    <option value={1}>≤ 1 transfer</option>
                    <option value={2}>≤ 2 transfers</option>
                  </Select>
                  {operators.length > 1 && (
                    <Select aria-label="Operator" className="h-9 w-48" value={filters.operator} onChange={(e) => setFilters((f) => ({ ...f, operator: e.target.value }))}>
                      <option value="">All operators</option>
                      {operators.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </Select>
                  )}
                  <label className="inline-flex items-center gap-1">
                    <input type="checkbox" checked={filters.hideRisky} onChange={(e) => setFilters((f) => ({ ...f, hideRisky: e.target.checked }))} /> Hide risky
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <input type="checkbox" checked={filters.paretoOnly} onChange={(e) => setFilters((f) => ({ ...f, paretoOnly: e.target.checked }))} /> Best options only
                  </label>
                </div>
                {compared.length >= 2 && <CompareTable items={compared} onClear={() => setCompare([])} />}
                {shown.map((it) => (
                  <ItineraryCard
                    key={it.id}
                    it={it}
                    expanded={expanded === it.id}
                    onToggle={() => {
                      setExpanded((e) => (e === it.id ? null : it.id));
                      setSelected(it.id);
                    }}
                    selected={selectedIt?.id === it.id}
                    onSelect={() => setSelected(it.id)}
                    compared={compare.includes(it.id)}
                    onCompare={() => setCompare((c) => (c.includes(it.id) ? c.filter((x) => x !== it.id) : [...c, it.id].slice(-3)))}
                  />
                ))}
                {shown.length === 0 && <p className="text-sm text-muted">No itinerary matches the active filters.</p>}
              </>
            )}
          </section>
          <aside className="h-80 overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface lg:sticky lg:top-4 lg:h-[calc(100vh-2rem)]" aria-label="Map">
            <JourneyMap it={selectedIt} />
          </aside>
        </div>
      )}
    </div>
  );
}

const priceValue = (i: Itinerary) => (i.price.status === 'complete' && i.price.totals.length === 1 ? i.price.totals[0]!.amount : Number.POSITIVE_INFINITY);
const qualityValue = (i: Itinerary) => (i.worstConnection === null ? 0 : ['comfortable', 'reasonable', 'risky'].indexOf(i.worstConnection));

function EmptyState({ res }: { res: JourneySearchResponse }) {
  const e = EMPTY[res.outcome] ?? EMPTY.no_journey_in_available_data!;
  const Icon = e.icon;
  return (
    <Card className="p-8 text-center" data-testid="empty-state">
      <Icon className="mx-auto mb-3 h-8 w-8 text-muted" aria-hidden />
      <h2 className="font-semibold">{e.title}</h2>
      <p className="mx-auto mt-1 max-w-lg text-sm text-muted">{res.outcomeMessage}</p>
      <p className="mx-auto mt-2 max-w-lg text-xs text-muted">
        This does not prove that no journey exists: operators that do not publish open timetable data are not represented.
      </p>
    </Card>
  );
}

function CompareTable({ items, onClear }: { items: Itinerary[]; onClear: () => void }) {
  const rows: Array<[string, (i: Itinerary) => React.ReactNode]> = [
    ['Departure', (i) => `${day(i.departure)} ${time(i.departure)}`],
    ['Arrival', (i) => `${day(i.arrival)} ${time(i.arrival)}`],
    ['Duration', (i) => duration(i.durationSeconds)],
    ['Transfers', (i) => `${i.transfers}${i.connections.length ? ` (${i.connections.map((c) => c.fromStop.cityName ?? c.fromStop.name).join(', ')})` : ''}`],
    ['Weakest connection', (i) => i.worstConnection ?? '—'],
    ['Operators', (i) => i.operators.map((o) => o.name).join(' + ')],
    ['Tickets', (i) => `${i.legs.length} separate`],
    ['Walking', (i) => (i.walkingMeters ? `${i.walkingMeters} m` : '—')],
    ['Night waiting', (i) => (i.overnightWaitSeconds ? duration(i.overnightWaitSeconds) : '—')],
    ['Price', (i) => <PriceLabel it={i} />],
  ];
  return (
    <Card className="overflow-x-auto p-3" data-testid="compare-table">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Comparison</h2>
        <button className="text-xs text-brand-700 hover:underline" onClick={onClear}>
          Clear
        </button>
      </div>
      <table className="w-full text-sm">
        <tbody>
          {rows.map(([label, f]) => (
            <tr key={label} className="border-t border-line">
              <th scope="row" className="py-1.5 pr-3 text-left text-xs font-medium whitespace-nowrap text-muted">
                {label}
              </th>
              {items.map((i) => (
                <td key={i.id} className="px-2 py-1.5 align-top">
                  {f(i)}
                  {label === 'Operators' && i.synthetic && (
                    <Badge tone="synthetic" className="ml-1">
                      test data
                    </Badge>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

