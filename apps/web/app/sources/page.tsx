import { Badge, Card } from '@/components/ui/primitives';
import { getSources, type DataSourceStatus } from '@/lib/api';
import { relativeAge } from '@/lib/format';

export const dynamic = 'force-dynamic';

const LIVE: Record<DataSourceStatus['liveStatus'], { label: string; tone: 'ok' | 'risk' | 'neutral' | 'synthetic' }> = {
  verified_working: { label: 'Verified working', tone: 'ok' },
  failing: { label: 'Failing', tone: 'risk' },
  never_run: { label: 'Not yet run', tone: 'neutral' },
  not_applicable: { label: 'Synthetic', tone: 'synthetic' },
};

const ADAPTER: Record<DataSourceStatus['adapterStatus'], string> = {
  implemented: 'Adapter implemented',
  fixture_only: 'Fixture stand-in only',
  not_implemented: 'Adapter not implemented',
};

export default async function SourcesPage() {
  let sources: DataSourceStatus[] = [];
  let error: string | null = null;
  try {
    sources = await getSources();
  } catch (e) {
    error = e instanceof Error ? e.message : 'API unreachable';
  }
  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <h1 className="text-2xl font-semibold">Data sources</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Every registered timetable source. An <em>implemented adapter</em> means the code handles the format; a source only counts as <em>verified working</em> after
        an actual successful import or health check. Synthetic sources are generated test fixtures and never real departures.
      </p>
      {error && (
        <p role="alert" className="mt-4 text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="mt-6 grid gap-3 md:grid-cols-2" data-testid="sources">
        {sources.map((s) => (
          <Card key={s.id} className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h2 className="font-medium">{s.name}</h2>
              <Badge tone={LIVE[s.liveStatus].tone}>{LIVE[s.liveStatus].label}</Badge>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              <Badge>{s.kind}</Badge>
              <Badge>{ADAPTER[s.adapterStatus]}</Badge>
              <Badge tone={s.enabled ? 'ok' : 'neutral'}>{s.enabled ? 'enabled' : 'disabled'}</Badge>
              {s.freshness !== 'unknown' && <Badge tone={s.freshness === 'fresh' ? 'ok' : 'warn'}>{s.freshness}</Badge>}
            </div>
            <dl className="mt-3 grid grid-cols-[8rem_1fr] gap-y-1 text-xs">
              <dt className="text-muted">Licence</dt>
              <dd>{s.license ?? 'unknown'}</dd>
              <dt className="text-muted">Last import</dt>
              <dd>
                {s.lastImport ? `${s.lastImport.status} · ${relativeAge(s.lastImport.finishedAt ?? s.lastImport.startedAt)}` : 'never'}
                {s.lastImport?.message && <span className="block text-muted">{s.lastImport.message}</span>}
              </dd>
              <dt className="text-muted">Validity</dt>
              <dd>{s.lastImport?.validFrom ? `${s.lastImport.validFrom} – ${s.lastImport.validTo}` : '—'}</dd>
              <dt className="text-muted">Content</dt>
              <dd>
                {s.counts.trips.toLocaleString('en-GB')} trips · {s.counts.stations.toLocaleString('en-GB')} stations · {s.counts.operators} operators
              </dd>
              <dt className="text-muted">Health</dt>
              <dd>{s.health ? `${s.health.ok ? 'OK' : 'failed'} · ${s.health.message ?? ''} · ${relativeAge(s.health.checkedAt)}` : 'not checked'}</dd>
            </dl>
          </Card>
        ))}
      </div>
    </div>
  );
}
