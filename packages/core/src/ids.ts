import { createHash, randomBytes } from 'node:crypto';

/**
 * Stable internal identifiers. Entities created by ingestion get random ids once and are
 * then reused through the source_stop / source mapping tables; deterministic ids are used
 * where a natural key exists (e.g. operator per source) so re-imports are idempotent.
 */
export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

export function stableId(prefix: string, ...parts: string[]): string {
  const h = createHash('sha256').update(parts.join('\u001f')).digest('base64url').slice(0, 14);
  return `${prefix}_${h}`;
}

export type PlaceRef = { kind: 'city'; id: string } | { kind: 'station'; id: string };

export function parsePlaceId(value: string): PlaceRef | null {
  const i = value.indexOf(':');
  if (i <= 0) return null;
  const kind = value.slice(0, i);
  const id = value.slice(i + 1);
  if (!id) return null;
  if (kind === 'city' || kind === 'station') return { kind, id };
  return null;
}

export function formatPlaceId(ref: PlaceRef): string {
  return `${ref.kind}:${ref.id}`;
}
