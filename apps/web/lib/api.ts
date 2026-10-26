import type {
  DataSourceStatus,
  Itinerary,
  JourneySearchRequest,
  JourneySearchResponse,
  Operator,
  Place,
} from '@openbus/core/api';

export type { DataSourceStatus, Itinerary, JourneySearchRequest, JourneySearchResponse, Operator, Place };

/** Server components call the API directly; the browser goes through the Next rewrite. */
const base = () => (typeof window === 'undefined' ? (process.env.API_URL ?? 'http://127.0.0.1:4080') : '');

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base()}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const body = (await res.json().catch(() => null)) as (T & { error?: { code: string; message: string } }) | null;
  if (!res.ok || !body) {
    throw new ApiRequestError(body?.error?.message ?? `Request failed (${res.status})`, body?.error?.code ?? 'http_error', res.status);
  }
  return body;
}

export async function searchPlaces(q: string, signal?: AbortSignal): Promise<Place[]> {
  const r = await call<{ places: Place[] }>(`/api/v1/places/search?q=${encodeURIComponent(q)}&limit=8`, signal ? { signal } : {});
  return r.places;
}

export function searchJourneys(req: JourneySearchRequest, signal?: AbortSignal): Promise<JourneySearchResponse> {
  return call<JourneySearchResponse>('/api/v1/journeys/search', { method: 'POST', body: JSON.stringify(req), ...(signal ? { signal } : {}) });
}

export async function getItinerary(id: string): Promise<{ searchId: string; itinerary: Itinerary }> {
  return call(`/api/v1/journeys/${encodeURIComponent(id)}`, { cache: 'no-store' });
}

export async function getOperators(): Promise<Operator[]> {
  return (await call<{ operators: Operator[] }>('/api/v1/operators', { cache: 'no-store' })).operators;
}

export async function getSources(): Promise<DataSourceStatus[]> {
  return (await call<{ sources: DataSourceStatus[] }>('/api/v1/data-sources/status', { cache: 'no-store' })).sources;
}
