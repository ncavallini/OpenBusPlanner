import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Repository root (…/packages/ingest/src -> repo). Overridable for containers. */
export const REPO_ROOT = process.env.OPENBUS_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const OperatorOverride = z.object({
  website: z.string().url().optional(),
  /** Only set when the operator documents a URL format; placeholders {from} {to} {date}. */
  bookingUrlTemplate: z.string().optional(),
  bookingLinkKind: z.enum(['departure_specific', 'route_search', 'operator_homepage', 'none']).optional(),
});

export const SourceDefinitionSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  kind: z.enum(['gtfs-schedule', 'gtfs-realtime', 'manual-json', 'netex', 'operator-api', 'commercial-feed', 'web-extraction']),
  adapter: z.enum(['gtfs-file', 'gtfs-url', 'manual-json', 'gtfs-rt-url', 'netex', 'unavailable']),
  /** implemented: code exists and works against the documented format; fixture_only: only synthetic stand-in; not_implemented. */
  adapterStatus: z.enum(['implemented', 'fixture_only', 'not_implemented']),
  synthetic: z.boolean(),
  enabledByDefault: z.boolean(),
  priority: z.number().int().default(0),
  config: z
    .object({
      path: z.string().optional(),
      url: z.string().url().optional(),
      scheduleSourceId: z.string().optional(),
      fixture: z.string().optional(),
      horizon: z.object({ from: z.string(), to: z.string() }).optional(),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .default({}),
  license: z.string().nullable(),
  licenseUrl: z.string().nullable(),
  attribution: z.string().nullable(),
  homepage: z.string().nullable(),
  refreshHours: z.number().int().nullable(),
  researchId: z.string().nullable().default(null),
  operators: z.record(z.string(), OperatorOverride).optional(),
  notes: z.string().default(''),
});
export type SourceDefinition = z.infer<typeof SourceDefinitionSchema> & {
  enabled: boolean;
  research?: Record<string, unknown> | null;
};

const RegistrySchema = z.object({ version: z.literal(1), sources: z.array(SourceDefinitionSchema) });

export function resolveRepoPath(p: string): string {
  return isAbsolute(p) ? p : join(REPO_ROOT, p);
}

/**
 * Reads data/source-registry.json and joins each entry with its research record
 * (data/research/sources.research.json). ENABLED_SOURCES (comma list, or "default") selects
 * which sources are active; synthetic fixtures can be switched off with DISABLE_FIXTURES=1.
 */
export function loadRegistry(opts: { enabled?: string | undefined } = {}): SourceDefinition[] {
  const raw = JSON.parse(readFileSync(resolveRepoPath('data/source-registry.json'), 'utf8'));
  const reg = RegistrySchema.parse(raw);
  const researchPath = resolveRepoPath('data/research/sources.research.json');
  const research = existsSync(researchPath)
    ? new Map((JSON.parse(readFileSync(researchPath, 'utf8')) as Array<{ id: string }>).map((r) => [r.id, r]))
    : new Map<string, { id: string }>();
  const enabledSpec = opts.enabled ?? process.env.ENABLED_SOURCES ?? 'default';
  const explicit = new Set(enabledSpec.split(',').map((s) => s.trim()).filter(Boolean));
  const noFixtures = process.env.DISABLE_FIXTURES === '1';
  return reg.sources.map((s) => {
    let enabled = explicit.has('all') || explicit.has(s.id) || (explicit.has('default') && s.enabledByDefault);
    if (noFixtures && s.synthetic) enabled = false;
    if (s.adapterStatus === 'not_implemented') enabled = false;
    return {
      ...s,
      enabled,
      research: s.researchId ? ((research.get(s.researchId) as Record<string, unknown> | undefined) ?? null) : null,
    };
  });
}
