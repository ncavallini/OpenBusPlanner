import { Redis } from 'ioredis';

/** Optional Redis-backed result cache. Every failure degrades to "no cache". */
export interface ResultCache {
  readonly available: boolean;
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  close(): Promise<void>;
}

export const noCache: ResultCache = {
  available: false,
  get: async () => null,
  set: async () => {},
  close: async () => {},
};

export function redisCache(url: string, log: (msg: string) => void = () => {}): ResultCache {
  const client = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 1, enableOfflineQueue: false });
  let warned = false;
  client.on('error', (e: Error) => {
    if (!warned) log(`redis unavailable, caching disabled: ${e.message}`);
    warned = true;
  });
  client.on('ready', () => {
    warned = false;
  });
  return {
    get available() {
      return client.status === 'ready';
    },
    async get<T>(key: string): Promise<T | null> {
      if (client.status !== 'ready') return null;
      try {
        const v = await client.get(key);
        return v ? (JSON.parse(v) as T) : null;
      } catch {
        return null;
      }
    },
    async set(key, value, ttl) {
      if (client.status !== 'ready') return;
      try {
        await client.set(key, JSON.stringify(value), 'EX', ttl);
      } catch {
        /* cache is best effort */
      }
    },
    async close() {
      client.disconnect();
    },
  };
}
