import { Database, Info } from 'lucide-react';
import type { JourneySearchResponse } from '@/lib/api';
import { Badge } from './ui/primitives';

const STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'risk' | 'neutral' | 'synthetic' }> = {
  used: { label: 'searched', tone: 'ok' },
  no_service_in_window: { label: 'no service in period', tone: 'neutral' },
  unavailable: { label: 'unavailable', tone: 'risk' },
  stale: { label: 'stale data', tone: 'warn' },
  excluded_by_scope: { label: 'excluded', tone: 'neutral' },
};

/** What was actually searched — built from search execution metadata, never hardcoded. */
export function CoverageNotice({ res }: { res: JourneySearchResponse }) {
  const c = res.coverage;
  return (
    <details className="rounded-lg border border-line bg-surface p-3 text-sm" data-testid="coverage">
      <summary className="flex cursor-pointer items-start gap-2">
        <Database className="mt-0.5 h-4 w-4 flex-none text-brand-700" aria-hidden />
        <span data-testid="coverage-message">{c.message}</span>
      </summary>
      <div className="mt-3 space-y-2">
        <ul className="space-y-1">
          {c.sources.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2">
              <Badge tone={STATUS[s.status]!.tone}>{STATUS[s.status]!.label}</Badge>
              {s.synthetic && <Badge tone="synthetic">synthetic</Badge>}
              <span>{s.name}</span>
              <span className="text-xs text-muted">
                {s.tripsInWindow} trips in period
                {s.validFrom && s.validTo && ` · valid ${s.validFrom} – ${s.validTo}`}
                {s.reason && ` · ${s.reason}`}
              </span>
            </li>
          ))}
        </ul>
        <p className="flex gap-2 text-xs text-muted">
          <Info className="h-4 w-4 flex-none" aria-hidden />
          {c.operatorsRepresented.length} operators represented: {c.operatorsRepresented.slice(0, 12).join(', ')}
          {c.operatorsRepresented.length > 12 ? '…' : ''}. Live prices queried: {c.livePricesQueried ? 'yes' : 'no'}. Seat availability verified:{' '}
          {c.availabilityVerified ? 'yes' : 'no'}.
        </p>
      </div>
    </details>
  );
}
