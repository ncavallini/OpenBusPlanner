'use client';

import { Building2, MapPin } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { searchPlaces, type Place } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface PlaceValue {
  id: string;
  name: string;
}

/** WAI-ARIA combobox (list autocomplete) over /places/search. */
export function PlaceAutocomplete({
  label,
  value,
  onChange,
  placeholder,
  testId,
}: {
  label: string;
  value: PlaceValue | null;
  onChange: (v: PlaceValue | null) => void;
  placeholder: string;
  testId: string;
}) {
  const id = useId();
  const [text, setText] = useState(value?.name ?? '');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Place[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const typed = useRef(false);

  useEffect(() => {
    setText(value?.name ?? '');
  }, [value?.id, value?.name]);

  useEffect(() => {
    if (!typed.current) return;
    const q = text.trim();
    if (q.length < 2) {
      setItems([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await searchPlaces(q, ctrl.signal);
        setItems(r);
        setActive(0);
        setOpen(true);
      } catch {
        /* aborted or network: keep previous suggestions */
      } finally {
        setLoading(false);
      }
    }, 150);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [text]);

  const choose = (p: Place) => {
    typed.current = false;
    onChange({ id: p.id, name: p.name });
    setText(p.name);
    setOpen(false);
  };

  return (
    <div className="relative">
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted">
        {label}
      </label>
      <input
        id={id}
        data-testid={testId}
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={open && items[active] ? `${id}-opt-${active}` : undefined}
        autoComplete="off"
        className="h-12 w-full rounded-lg border border-line bg-surface px-3 text-base text-ink placeholder:text-muted focus:border-brand-500 focus:outline-none"
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          typed.current = true;
          setText(e.target.value);
          if (value) onChange(null);
        }}
        onFocus={() => items.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, items.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter' && items[active]) {
            e.preventDefault();
            choose(items[active]!);
          } else if (e.key === 'Escape') setOpen(false);
        }}
      />
      {loading && <span className="absolute top-9 right-3 text-xs text-muted">…</span>}
      {open && items.length > 0 && (
        <ul
          id={`${id}-list`}
          role="listbox"
          className="absolute z-30 mt-1 max-h-80 w-full overflow-auto rounded-lg border border-line bg-surface py-1 shadow-lg"
        >
          {items.map((p, i) => (
            <li
              key={p.id}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(p);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn('flex cursor-pointer items-start gap-3 px-3 py-2', i === active && 'bg-brand-50')}
            >
              {p.kind === 'city' ? <Building2 className="mt-0.5 h-4 w-4 text-brand-600" aria-hidden /> : <MapPin className="mt-0.5 h-4 w-4 text-muted" aria-hidden />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {p.name}
                  {p.countryCode && <span className="ml-1 text-xs text-muted">{p.countryCode}</span>}
                </span>
                <span className="block truncate text-xs text-muted">
                  {p.kind === 'city'
                    ? p.stationCount > 0
                      ? `City · all ${p.stationCount} station${p.stationCount === 1 ? '' : 's'}`
                      : 'City · no timetable data yet'
                    : `Station${p.cityName ? ` in ${p.cityName}` : ''}`}
                  {p.matchedAlias && p.matchedAlias !== p.name ? ` · “${p.matchedAlias}”` : ''}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
