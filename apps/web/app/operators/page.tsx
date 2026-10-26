import { Badge, Card } from '@/components/ui/primitives';
import { getOperators, type Operator } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function OperatorsPage() {
  let operators: Operator[] = [];
  try {
    operators = await getOperators();
  } catch {
    /* rendered as empty list */
  }
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <h1 className="text-2xl font-semibold">Operators</h1>
      <p className="mt-1 text-sm text-muted">Companies whose services appear in the imported timetables, unified across sources by name.</p>
      <Card className="mt-6 divide-y divide-line">
        {operators.map((o) => (
          <div key={o.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
            <span className="min-w-[14rem] font-medium">{o.name}</span>
            {o.synthetic && <Badge tone="synthetic">synthetic</Badge>}
            {o.website && !o.synthetic && (
              <a className="text-brand-700 hover:underline" href={o.website} target="_blank" rel="noopener noreferrer nofollow">
                {new URL(o.website).hostname}
              </a>
            )}
            <span className="ml-auto text-xs text-muted">sources: {o.sources.join(', ')}</span>
          </div>
        ))}
        {operators.length === 0 && <p className="p-4 text-sm text-muted">No operators imported yet.</p>}
      </Card>
    </div>
  );
}
