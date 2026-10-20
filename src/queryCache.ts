/**
 * Query result caching for the StellarSplit SDK.
 *
 * Wraps the existing {@link SimpleCache} from `src/cache.ts` with a
 * query-oriented API: a configurable TTL per query type, hit/miss metrics,
 * invalidation hooks for when the underlying data changes, and cache-warming
 * helpers.
 *
 * The two heaviest read paths in the SDK are cached out of the box:
 * invoice **list** queries and invoice **statistics** computations.
 *
 * Issue #1135
 *
 * @module queryCache
 */

import {
  SimpleCache,
  type CacheEvent,
  type CacheEventListener,
  type DebugModeOptions,
} from "./cache.js";
import { computeInvoiceStats } from "./invoiceStats.js";
import type { InvoiceFilter, InvoicePage } from "./invoiceQuery.js";
import type { Invoice, InvoiceStats } from "./types.js";

// ---------------------------------------------------------------------------
// Query types
// ---------------------------------------------------------------------------

/** The query types the SDK knows about. */
export const QUERY_TYPES = {
  /** A page of invoices returned by a list query. */
  invoiceList: "invoiceList",
  /** A single invoice. */
  invoice: "invoice",
  /** A filtered / sorted / paginated invoice query. */
  invoiceQuery: "invoiceQuery",
  /** A computed invoice statistics object. */
  invoiceStats: "invoiceStats",
  /** A derived analytics figure. */
  analytics: "analytics",
} as const;

/** One of the built-in query types. */
export type KnownQueryType = (typeof QUERY_TYPES)[keyof typeof QUERY_TYPES];

/** The default TTL, in milliseconds, of every query type. */
export const DEFAULT_QUERY_TTL_MS: Readonly<Record<string, number>> = Object.freeze({
  invoiceList: 30_000,
  invoice: 15_000,
  invoiceQuery: 30_000,
  invoiceStats: 60_000,
  analytics: 300_000,
  default: 30_000,
});

/** The default maximum number of cached query results. */
export const DEFAULT_MAX_ENTRIES = 1_000;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration for {@link QueryResultCache}. */
export interface QueryCacheConfig {
  /** Enable the cache. Defaults to `true`. */
  enabled?: boolean;
  /**
   * TTL in milliseconds, per query type. Any type that is not listed falls
   * back to `defaultTtlMs`.
   */
  ttl?: Record<string, number>;
  /** TTL used for query types without an explicit entry. Defaults to 30 000 ms. */
  defaultTtlMs?: number;
  /** Maximum number of cached results. Defaults to {@link DEFAULT_MAX_ENTRIES}. */
  maxEntries?: number;
  /** Debug-mode configuration for the underlying cache. */
  debug?: boolean | DebugModeOptions;
}

/** Hit/miss counters for a single query type. */
export interface QueryTypeStats {
  /** Number of cache hits. */
  hits: number;
  /** Number of cache misses. */
  misses: number;
  /** Hits divided by the total number of lookups, `0`–`1`. */
  hitRate: number;
  /** Number of cached entries for this type. */
  size: number;
}

/** Aggregated cache statistics. */
export interface QueryCacheStats {
  /** Number of cache hits. */
  hits: number;
  /** Number of cache misses. */
  misses: number;
  /** Hits divided by the total number of lookups, `0`–`1`. */
  hitRate: number;
  /** Number of cached entries. */
  size: number;
  /** Maximum number of cached entries. */
  maxEntries: number;
  /** Number of entries evicted because the cache was full. */
  evictions: number;
  /** Bytes saved by the cache's optional value compression. */
  bytesSaved: number;
  /** The cached keys. */
  keys: string[];
  /** Per-query-type breakdown. */
  byType: Record<string, QueryTypeStats>;
}

/** A single entry to warm into the cache. */
export interface QueryCacheWarmEntry {
  /** The query type the entry belongs to. */
  type: string;
  /** The query key, exactly as it would be passed to `getOrLoad`. */
  key: string;
  /** Loads the value to cache. */
  load: () => Promise<unknown>;
}

/** The outcome of a cache warm-up. */
export interface QueryWarmUpResult {
  /** Number of entries that were loaded and cached. */
  warmed: number;
  /** Number of entries that already had a cached value. */
  skipped: number;
  /** Number of entries whose load failed. */
  failed: number;
  /** The failures, keyed by cache key. */
  errors: { key: string; error: Error }[];
}

/** A listener notified whenever a cached entry changes. */
export type QueryCacheListener = (event: CacheEvent) => void;

/** A listener notified when the underlying data changes. */
export type QueryDataChangeListener = (types: readonly string[]) => void;

// ---------------------------------------------------------------------------
// Key building
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "bigint") return `"${value.toString()}n"`;
  if (typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/**
 * Build a deterministic cache key from an arbitrary query descriptor.
 *
 * Object keys are sorted and `bigint` values are encoded, so two
 * structurally equal queries always produce the same key.
 *
 * @param input - The query descriptor.
 */
export function buildQueryKey(input: unknown): string {
  return stableStringify(input);
}

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

/**
 * A TTL cache for query results.
 *
 * The cache is backed by the SDK's existing {@link SimpleCache}, extended with
 * per-query-type TTLs, per-type hit/miss counters, single-flight loading and
 * warm-up helpers.
 *
 * @example
 * ```ts
 * const cache = new QueryResultCache({ ttl: { invoiceList: 60_000 } });
 *
 * const page = await cache.getOrLoad("invoiceList", buildQueryKey(filter), () =>
 *   client.queryInvoices(filter),
 * );
 *
 * console.log(cache.getStats().hitRate);
 * ```
 */
export class QueryResultCache {
  private readonly cache: SimpleCache<unknown>;
  private readonly ttlByType: Map<string, number>;
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;
  private readonly cacheEnabled: boolean;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly perType = new Map<string, { hits: number; misses: number }>();
  private hits = 0;
  private misses = 0;
  private readonly listeners = new Set<QueryCacheListener>();
  private readonly dataChangeListeners = new Set<QueryDataChangeListener>();

  constructor(config: QueryCacheConfig = {}) {
    this.defaultTtlMs = config.defaultTtlMs ?? DEFAULT_QUERY_TTL_MS["default"] ?? 30_000;
    this.maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.cacheEnabled = config.enabled ?? true;

    const ttl: Record<string, number> = { ...DEFAULT_QUERY_TTL_MS };
    for (const [type, value] of Object.entries(config.ttl ?? {})) {
      ttl[type] = value;
    }
    ttl["default"] = this.defaultTtlMs;

    this.ttlByType = new Map(Object.entries(ttl));
    this.cache = new SimpleCache<unknown>({
      enabled: config.enabled ?? true,
      ttl,
      maxEntries: this.maxEntries,
      debug: config.debug,
    });

    this.cache.on((event) => {
      this.attribute(event);
      for (const listener of this.listeners) {
        listener(event);
      }
    });
  }

  /** Whether the cache is enabled. */
  get enabled(): boolean {
    return this.cacheEnabled;
  }

  /**
   * The TTL, in milliseconds, configured for a query type.
   *
   * @param type - The query type.
   */
  getTtl(type: string): number {
    return this.ttlByType.get(type) ?? this.defaultTtlMs;
  }

  /**
   * Build the cache key for a query.
   *
   * @param type - The query type.
   * @param key - The query key.
   */
  key(type: string, key: string): string {
    return `${type}:${key}`;
  }

  /**
   * Read a cached result.
   *
   * @param type - The query type.
   * @param key - The query key.
   */
  get<T>(type: string, key: string): T | undefined {
    return this.cache.get(this.key(type, key)) as T | undefined;
  }

  /**
   * Store a result.
   *
   * @param type - The query type.
   * @param key - The query key.
   * @param value - The value to cache.
   */
  set<T>(type: string, key: string, value: T): void {
    this.cache.set(this.key(type, key), value);
  }

  /**
   * Return a cached result, loading and caching it on a miss.
   *
   * Concurrent calls for the same key share a single load, so a burst of
   * identical queries only reaches the network once.
   *
   * @param type - The query type.
   * @param key - The query key.
   * @param loader - Loads the value on a miss.
   */
  async getOrLoad<T>(type: string, key: string, loader: () => Promise<T>): Promise<T> {
    const cacheKey = this.key(type, key);

    const cached = this.cache.get(cacheKey) as T | undefined;
    if (cached !== undefined) {
      return cached;
    }

    const pending = this.inFlight.get(cacheKey);
    if (pending) {
      return (await pending) as T;
    }

    const promise = loader()
      .then((value) => {
        if (value !== undefined) {
          this.cache.set(cacheKey, value);
        }
        return value;
      })
      .finally(() => {
        this.inFlight.delete(cacheKey);
      });

    this.inFlight.set(cacheKey, promise);
    return (await promise) as T;
  }

  /**
   * Invalidate cached results.
   *
   * @param types - The query types to invalidate. When omitted, every entry
   *   is dropped.
   */
  invalidate(types?: string | readonly string[]): void {
    if (types === undefined) {
      this.cache.invalidate();
      return;
    }
    const list = typeof types === "string" ? [types] : types;
    for (const type of list) {
      this.cache.invalidate(type);
    }
  }

  /** Drop every cached result. */
  invalidateAll(): void {
    this.cache.invalidate();
  }

  /**
   * Notify listeners that the underlying data changed and invalidate the
   * affected query types.
   *
   * @param types - The query types affected by the change.
   */
  notifyDataChange(types: readonly string[]): void {
    this.invalidate(types);
    for (const listener of this.dataChangeListeners) {
      listener(types);
    }
  }

  /**
   * Subscribe to data-change notifications.
   *
   * @param listener - Called with the affected query types.
   * @returns An unsubscribe function.
   */
  onDataChange(listener: QueryDataChangeListener): () => void {
    this.dataChangeListeners.add(listener);
    return () => {
      this.dataChangeListeners.delete(listener);
    };
  }

  /**
   * Subscribe to cache lifecycle events.
   *
   * @param listener - Called on every cache event.
   * @returns An unsubscribe function.
   */
  on(listener: QueryCacheListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The current cache statistics. */
  getStats(): QueryCacheStats {
    const stats = this.cache.getStats();
    const byType: Record<string, QueryTypeStats> = {};

    for (const [type, counters] of this.perType) {
      const total = counters.hits + counters.misses;
      byType[type] = {
        hits: counters.hits,
        misses: counters.misses,
        hitRate: total > 0 ? counters.hits / total : 0,
        size: stats.keys.filter((key) => key.split(":")[0] === type).length,
      };
    }

    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      size: stats.size,
      maxEntries: this.maxEntries,
      evictions: stats.evictions,
      bytesSaved: stats.bytesSaved,
      keys: stats.keys,
      byType,
    };
  }

  /** Reset the hit/miss counters. */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    for (const counters of this.perType.values()) {
      counters.hits = 0;
      counters.misses = 0;
    }
  }

  /**
   * Warm the cache with a set of entries.
   *
   * Entries that are already cached are skipped, and a failing entry never
   * aborts the warm-up.
   *
   * @param entries - The entries to warm.
   */
  async warmUp(entries: readonly QueryCacheWarmEntry[]): Promise<QueryWarmUpResult> {
    const result: QueryWarmUpResult = { warmed: 0, skipped: 0, failed: 0, errors: [] };

    await Promise.all(
      entries.map(async (entry) => {
        const cacheKey = this.key(entry.type, entry.key);
        if (this.cache.get(cacheKey) !== undefined) {
          result.skipped += 1;
          return;
        }
        try {
          const value = await entry.load();
          if (value !== undefined) {
            this.cache.set(cacheKey, value);
          }
          result.warmed += 1;
        } catch (error) {
          result.failed += 1;
          result.errors.push({
            key: cacheKey,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      })
    );

    return result;
  }

  /**
   * Warm the cache for a set of keys of one query type.
   *
   * @param type - The query type.
   * @param keys - The query keys to warm.
   * @param loader - Loads the value for a key.
   */
  async warm(
    type: string,
    keys: readonly string[],
    loader: (key: string) => Promise<unknown>
  ): Promise<QueryWarmUpResult> {
    return await this.warmUp(
      keys.map((key) => ({
        type,
        key,
        load: async () => await loader(key),
      }))
    );
  }

  private attribute(event: CacheEvent): void {
    if (event.type !== "hit" && event.type !== "miss") return;
    const key = event.key ?? "";
    const type = key.split(":")[0] ?? "";
    let counters = this.perType.get(type);
    if (!counters) {
      counters = { hits: 0, misses: 0 };
      this.perType.set(type, counters);
    }
    if (event.type === "hit") {
      counters.hits += 1;
      this.hits += 1;
    } else {
      counters.misses += 1;
      this.misses += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Typed helpers
// ---------------------------------------------------------------------------

/**
 * Run an invoice list query through the cache.
 *
 * @param cache - The query cache.
 * @param filter - The invoice filter, used to build the cache key.
 * @param loader - Runs the query on a cache miss.
 */
export async function getCachedInvoiceList(
  cache: QueryResultCache,
  filter: InvoiceFilter,
  loader: () => Promise<InvoicePage>
): Promise<InvoicePage> {
  return await cache.getOrLoad(
    QUERY_TYPES.invoiceList,
    buildQueryKey(filter),
    loader
  );
}

/**
 * Run an invoice query (filtered / sorted / paginated) through the cache.
 *
 * @param cache - The query cache.
 * @param filter - The invoice filter, used to build the cache key.
 * @param loader - Runs the query on a cache miss.
 */
export async function getCachedInvoiceQuery(
  cache: QueryResultCache,
  filter: InvoiceFilter,
  loader: () => Promise<InvoicePage>
): Promise<InvoicePage> {
  return await cache.getOrLoad(
    QUERY_TYPES.invoiceQuery,
    buildQueryKey(filter),
    loader
  );
}

/**
 * Run an invoice statistics computation through the cache.
 *
 * @param cache - The query cache.
 * @param invoiceId - The invoice the statistics belong to.
 * @param loader - Computes the statistics on a cache miss.
 */
export async function getCachedInvoiceStats(
  cache: QueryResultCache,
  invoiceId: string,
  loader: () => Promise<InvoiceStats>
): Promise<InvoiceStats> {
  return await cache.getOrLoad(
    QUERY_TYPES.invoiceStats,
    buildQueryKey(invoiceId),
    loader
  );
}

/**
 * Compute and cache the statistics of an invoice.
 *
 * @param cache - The query cache.
 * @param invoice - The invoice to analyse.
 */
export async function getCachedComputedStats(
  cache: QueryResultCache,
  invoice: Invoice
): Promise<InvoiceStats> {
  return await cache.getOrLoad(
    QUERY_TYPES.invoiceStats,
    buildQueryKey(invoice.id),
    async () => computeInvoiceStats(invoice)
  );
}

/**
 * Build a function that invalidates the cache entries affected by a data
 * change — for example after a payment is submitted.
 *
 * @param cache - The query cache.
 * @param types - The query types to invalidate.
 */
export function createInvalidationHook(
  cache: QueryResultCache,
  types: readonly string[] = [QUERY_TYPES.invoiceList, QUERY_TYPES.invoiceQuery, QUERY_TYPES.invoice]
): () => void {
  return () => {
    cache.notifyDataChange(types);
  };
}
