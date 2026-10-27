'use client';

import { ArrowLeftRight, Search, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { Button, Input, Label, SegmentedControl, Select } from '@/components/ui/primitives';
import { PlaceAutocomplete, type PlaceValue } from './place-autocomplete';

export interface SearchState {
  from: PlaceValue | null;
  to: PlaceValue | null;
  mode: 'depart' | 'arrive';
  date: string;
  windowFrom: string;
  windowTo: string;
  maxTransfers: number;
  notBeforeDate: string;
  notBeforeTime: string;
  risk: 'cautious' | 'balanced' | 'adventurous';
  excludeRisky: boolean;
  minTransfer: number;
  /** Optional data scope (all / real / synthetic), mainly for testing and demos. */
  scope?: 'all' | 'real' | 'synthetic' | undefined;
}

const WINDOWS: Array<{ label: string; from: string; to: string }> = [
  { label: 'Any time', from: '00:00', to: '23:59' },
  { label: 'Early morning (04–08)', from: '04:00', to: '08:00' },
  { label: 'Morning (06–12)', from: '06:00', to: '12:00' },
  { label: 'Afternoon (12–18)', from: '12:00', to: '18:00' },
  { label: 'Evening (18–24)', from: '18:00', to: '23:59' },
  { label: 'Night (20–06)', from: '20:00', to: '06:00' },
];

export function SearchForm({ initial, onSubmit, busy }: { initial: SearchState; onSubmit: (s: SearchState) => void; busy: boolean }) {
  const [s, setS] = useState<SearchState>(initial);
  const [advanced, setAdvanced] = useState(false);
  const set = <K extends keyof SearchState>(k: K, v: SearchState[K]) => setS((x) => ({ ...x, [k]: v }));
  const preset = WINDOWS.find((w) => w.from === s.windowFrom && w.to === s.windowTo);

  return (
    <form
      aria-label="Journey search"
      onSubmit={(e) => {
        e.preventDefault();
        if (s.from && s.to) onSubmit(s);
      }}
      className="space-y-4"
    >
      <div className="grid gap-3 md:grid-cols-[1fr_auto_1fr]">
        <PlaceAutocomplete label="From" testId="origin-input" value={s.from} onChange={(v) => set('from', v)} placeholder="City or station, e.g. Zurich" />
        <div className="flex items-end justify-center">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Swap origin and destination"
            onClick={() => setS((x) => ({ ...x, from: x.to, to: x.from }))}
          >
            <ArrowLeftRight className="h-4 w-4" />
          </Button>
        </div>
        <PlaceAutocomplete label="To" testId="destination-input" value={s.to} onChange={(v) => set('to', v)} placeholder="City or station, e.g. Bolzano" />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <span className="mb-1 block text-xs font-medium text-muted">Search by</span>
          <SegmentedControl
            label="Search by departure or arrival"
            value={s.mode}
            onChange={(v) => set('mode', v)}
            options={[
              { value: 'depart', label: 'Departure' },
              { value: 'arrive', label: 'Arrival' },
            ]}
          />
        </div>
        <div className="w-40">
          <Label htmlFor="date">{s.mode === 'arrive' ? 'Arrival date' : 'Departure date'}</Label>
          <Input id="date" data-testid="date-input" type="date" value={s.date} onChange={(e) => set('date', e.target.value)} required />
        </div>
        <div className="w-56">
          <Label htmlFor="window">{s.mode === 'arrive' ? 'Arrive between' : 'Depart between'}</Label>
          <Select
            id="window"
            data-testid="window-select"
            value={preset ? `${preset.from}-${preset.to}` : 'custom'}
            onChange={(e) => {
              const [f, t] = e.target.value.split('-');
              if (f && t) setS((x) => ({ ...x, windowFrom: f, windowTo: t }));
            }}
          >
            {WINDOWS.map((w) => (
              <option key={w.label} value={`${w.from}-${w.to}`}>
                {w.label}
              </option>
            ))}
            {!preset && <option value="custom">{`${s.windowFrom}–${s.windowTo}`}</option>}
          </Select>
        </div>
        <div className="flex gap-2">
          <div className="w-24">
            <Label htmlFor="wfrom">From</Label>
            <Input id="wfrom" type="time" value={s.windowFrom} onChange={(e) => set('windowFrom', e.target.value)} />
          </div>
          <div className="w-24">
            <Label htmlFor="wto">To</Label>
            <Input id="wto" type="time" value={s.windowTo} onChange={(e) => set('windowTo', e.target.value)} />
          </div>
        </div>
        <div className="w-36">
          <Label htmlFor="maxTransfers">Max. transfers</Label>
          <Select id="maxTransfers" value={s.maxTransfers} onChange={(e) => set('maxTransfers', Number(e.target.value))}>
            {[0, 1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? 'Direct only' : `Up to ${n}`}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" size="lg" data-testid="search-button" disabled={!s.from || !s.to || busy} className="ml-auto">
          <Search className="h-4 w-4" aria-hidden />
          {busy ? 'Searching…' : 'Search'}
        </Button>
      </div>

      <button type="button" className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
        <SlidersHorizontal className="h-4 w-4" aria-hidden /> {advanced ? 'Hide options' : 'More options'}
      </button>
      {advanced && (
        <div className="grid gap-3 rounded-lg border border-line bg-canvas p-3 sm:grid-cols-2 lg:grid-cols-4">
          {s.mode === 'arrive' && (
            <div>
              <Label htmlFor="nbd">Depart no earlier than</Label>
              <div className="flex gap-2">
                <Input id="nbd" type="date" value={s.notBeforeDate} onChange={(e) => set('notBeforeDate', e.target.value)} />
                <Input aria-label="Earliest departure time" type="time" value={s.notBeforeTime} onChange={(e) => set('notBeforeTime', e.target.value)} className="w-28" />
              </div>
            </div>
          )}
          <div>
            <Label htmlFor="minTransfer">Minimum transfer time</Label>
            <Select id="minTransfer" value={s.minTransfer} onChange={(e) => set('minTransfer', Number(e.target.value))}>
              {[5, 10, 15, 20, 30, 45, 60].map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="risk">Connection risk tolerance</Label>
            <Select id="risk" value={s.risk} onChange={(e) => set('risk', e.target.value as SearchState['risk'])}>
              <option value="cautious">Cautious (bigger buffers)</option>
              <option value="balanced">Balanced</option>
              <option value="adventurous">Adventurous</option>
            </Select>
          </div>
          <div className="flex flex-col justify-end gap-2 text-sm">
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={s.excludeRisky} onChange={(e) => set('excludeRisky', e.target.checked)} /> Hide risky connections
            </label>
          </div>
        </div>
      )}
    </form>
  );
}
