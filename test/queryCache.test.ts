import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_QUERY_TTL_MS,
  QUERY_TYPES,
  QueryResultCache,
  buildQueryKey,
  createInvalidationHook,
  getCachedComputedStats,
  getCachedInvoiceList,
  getCachedInvoiceQuery,
  getCachedInvoiceStats,
} from "../src/queryCache.js";
import type { Invoice, InvoiceStats } from "../src/types.js";
import type { InvoiceFilter, InvoicePage } from "../src/invoiceQuery.js";

const CREATOR = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const PAYER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function makeInvoice(id = "42"): Invoice {
  return {
    id,
    creator: CREATOR,
    recipients: [{ address: PAYER, amount: 1_000n }],
    token: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    deadline: 1_800_000_000,
    createdAt: 1_700_000_000,
    funded: 1_000n,
    status: "Pending",
    payments: [{ payer: PAYER, amount: 1_000n, timestamp: 1_700_000_100 }],
  };
}

function makePage(): InvoicePage {
  return { items: [makeInvoice()], total: 1 };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("query cache keys", () => {
  it("builds deterministic keys for structurally equal queries", () => {
    const a = buildQueryKey({ creator: CREATOR, status: ["Pending"], limit: 10 });
    const b = buildQueryKey({ limit: 10, status: ["Pending"], creator: CREATOR });

    expect(a).toBe(b);
  });

  it("encodes bigint values", () => {
    expect(buildQueryKey({ amount: 10n })).toBe(buildQueryKey({ amount: 10n }));
    expect(buildQueryKey({ amount: 10n })).not.toBe(buildQueryKey({ amount: 11n }));
  });

  it("distinguishes different queries", () => {
    expect(buildQueryKey({ limit: 10 })).not.toBe(buildQueryKey({ limit: 20 }));
  });
});

describe("query result caching", () => {
  it("serves a repeated query from the cache", async () => {
    const cache = new QueryResultCache();
    const loader = vi.fn(async () => makePage());

    const first = await cache.getOrLoad("invoiceList", "k1", loader);
    const second = await cache.getOrLoad("invoiceList", "k1", loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("does not cache across different query types", async () => {
    const cache = new QueryResultCache();
    const listLoader = vi.fn(async () => makePage());
    const queryLoader = vi.fn(async () => makePage());

    await cache.getOrLoad("invoiceList", "k1", listLoader);
    await cache.getOrLoad("invoiceQuery", "k1", queryLoader);

    expect(listLoader).toHaveBeenCalledTimes(1);
    expect(queryLoader).toHaveBeenCalledTimes(1);
  });

  it("shares a single load between concurrent identical queries", async () => {
    const cache = new QueryResultCache();
    let calls = 0;
    const loader = vi.fn(async () => {
      calls += 1;
      await Promise.resolve();
      return makePage();
    });

    await Promise.all([
      cache.getOrLoad("invoiceList", "k1", loader),
      cache.getOrLoad("invoiceList", "k1", loader),
      cache.getOrLoad("invoiceList", "k1", loader),
    ]);

    expect(calls).toBe(1);
  });

  it("does not cache undefined results", async () => {
    const cache = new QueryResultCache();
    const loader = vi.fn(async () => undefined);

    await cache.getOrLoad("invoiceList", "k1", loader);
    await cache.getOrLoad("invoiceList", "k1", loader);

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("falls back to loading every time when the cache is disabled", async () => {
    const cache = new QueryResultCache({ enabled: false });
    const loader = vi.fn(async () => makePage());

    await cache.getOrLoad("invoiceList", "k1", loader);
    await cache.getOrLoad("invoiceList", "k1", loader);

    expect(cache.enabled).toBe(false);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(cache.getStats().size).toBe(0);
  });
});

describe("per-query-type TTL", () => {
  it("uses the configured TTL for a query type", () => {
    const cache = new QueryResultCache({
      ttl: { invoiceList: 5_000, invoiceStats: 120_000 },
    });

    expect(cache.getTtl("invoiceList")).toBe(5_000);
    expect(cache.getTtl("invoiceStats")).toBe(120_000);
  });

  it("falls back to the default TTL for unknown types", () => {
    const cache = new QueryResultCache({ defaultTtlMs: 1_234 });
    expect(cache.getTtl("somethingElse")).toBe(1_234);
  });

  it("ships sensible default TTLs", () => {
    const cache = new QueryResultCache();
    expect(cache.getTtl(QUERY_TYPES.invoiceList)).toBe(
      DEFAULT_QUERY_TTL_MS[QUERY_TYPES.invoiceList]
    );
    expect(cache.getTtl(QUERY_TYPES.invoiceStats)).toBe(
      DEFAULT_QUERY_TTL_MS[QUERY_TYPES.invoiceStats]
    );
  });

  it("expires an entry once its TTL has elapsed", async () => {
    const cache = new QueryResultCache({ ttl: { invoiceList: 1_000 } });
    const loader = vi.fn(async () => makePage());

    await cache.getOrLoad("invoiceList", "k1", loader);
    vi.setSystemTime(new Date("2026-01-01T00:00:00.500Z"));
    await cache.getOrLoad("invoiceList", "k1", loader);
    expect(loader).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-01-01T00:00:02Z"));
    await cache.getOrLoad("invoiceList", "k1", loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("applies a different TTL per query type", async () => {
    const cache = new QueryResultCache({
      ttl: { invoiceList: 1_000, invoiceStats: 60_000 },
    });
    const listLoader = vi.fn(async () => makePage());
    const statsLoader = vi.fn(async () => ({ totalPayers: 1 }) as InvoiceStats);

    await cache.getOrLoad("invoiceList", "k1", listLoader);
    await cache.getOrLoad("invoiceStats", "k1", statsLoader);

    vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
    await cache.getOrLoad("invoiceList", "k1", listLoader);
    await cache.getOrLoad("invoiceStats", "k1", statsLoader);

    expect(listLoader).toHaveBeenCalledTimes(2);
    expect(statsLoader).toHaveBeenCalledTimes(1);
  });
});

describe("cache metrics", () => {
  it("counts hits and misses", async () => {
    const cache = new QueryResultCache();
    const loader = vi.fn(async () => makePage());

    await cache.getOrLoad("invoiceList", "k1", loader);
    await cache.getOrLoad("invoiceList", "k1", loader);
    await cache.getOrLoad("invoiceList", "k2", loader);

    const stats = cache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(2);
    expect(stats.size).toBe(2);
    expect(stats.keys).toHaveLength(2);
  });

  it("reports a hit rate above 50% for repeated common queries", async () => {
    const cache = new QueryResultCache();
    const loader = vi.fn(async () => makePage());

    for (let i = 0; i < 6; i += 1) {
      await cache.getOrLoad("invoiceList", "common", loader);
    }

    const stats = cache.getStats();
    expect(stats.hitRate).toBeGreaterThan(0.5);
    expect(stats.hitRate).toBeCloseTo(5 / 6, 5);
  });

  it("breaks the counters down per query type", async () => {
    const cache = new QueryResultCache();
    const listLoader = vi.fn(async () => makePage());
    const statsLoader = vi.fn(async () => ({ totalPayers: 1 }) as InvoiceStats);

    await cache.getOrLoad("invoiceList", "k1", listLoader);
    await cache.getOrLoad("invoiceList", "k1", listLoader);
    await cache.getOrLoad("invoiceStats", "k1", statsLoader);

    const stats = cache.getStats();
    expect(stats.byType.invoiceList?.hits).toBe(1);
    expect(stats.byType.invoiceList?.misses).toBe(1);
    expect(stats.byType.invoiceList?.hitRate).toBeCloseTo(0.5, 5);
    expect(stats.byType.invoiceList?.size).toBe(1);
    expect(stats.byType.invoiceStats?.misses).toBe(1);
    expect(stats.byType.invoiceStats?.hits).toBe(0);
  });

  it("resets the counters on request", async () => {
    const cache = new QueryResultCache();
    const loader = vi.fn(async () => makePage());

    await cache.getOrLoad("invoiceList", "k1", loader);
    await cache.getOrLoad("invoiceList", "k1", loader);
    expect(cache.getStats().hits).toBe(1);

    cache.resetStats();
    expect(cache.getStats().hits).toBe(0);
    expect(cache.getStats().misses).toBe(0);
  });

  it("shows the reduction in load", async () => {
    const cache = new QueryResultCache();
    const loader = vi.fn(async () => makePage());

    for (let i = 0; i < 10; i += 1) {
      await cache.getOrLoad("invoiceList", "k1", loader);
    }

    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.getStats().hits).toBe(9);
  });
});

describe("cache invalidation on data changes", () => {
  it("invalidates every entry of a query type", async () => {
    const cache = new QueryResultCache();
    const listLoader = vi.fn(async () => makePage());
    const statsLoader = vi.fn(async () => ({ totalPayers: 1 }) as InvoiceStats);

    await cache.getOrLoad("invoiceList", "k1", listLoader);
    await cache.getOrLoad("invoiceStats", "k1", statsLoader);

    cache.invalidate("invoiceList");

    await cache.getOrLoad("invoiceList", "k1", listLoader);
    await cache.getOrLoad("invoiceStats", "k1", statsLoader);

    expect(listLoader).toHaveBeenCalledTimes(2);
    expect(statsLoader).toHaveBeenCalledTimes(1);
  });

  it("invalidates several query types at once", async () => {
    const cache = new QueryResultCache();
    const loader = vi.fn(async () => makePage());

    await cache.getOrLoad("invoiceList", "k1", loader);
    await cache.getOrLoad("invoiceQuery", "k1", loader);

    cache.invalidate(["invoiceList", "invoiceQuery"]);

    await cache.getOrLoad("invoiceList", "k1", loader);
    await cache.getOrLoad("invoiceQuery", "k1", loader);

    expect(loader).toHaveBeenCalledTimes(4);
  });

  it("invalidates everything when no type is given", async () => {
    const cache = new QueryResultCache();
    const loader = vi.fn(async () => makePage());

    await cache.getOrLoad("invoiceList", "k1", loader);
    cache.invalidateAll();

    await cache.getOrLoad("invoiceList", "k1", loader);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(cache.getStats().size).toBe(1);
  });

  it("notifies data-change listeners", async () => {
    const cache = new QueryResultCache();
    const listener = vi.fn();
    const unsubscribe = cache.onDataChange(listener);

    cache.notifyDataChange(["invoiceList"]);
    expect(listener).toHaveBeenCalledWith(["invoiceList"]);

    unsubscribe();
    cache.notifyDataChange(["invoiceList"]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("invalidates the affected types when the data changes", async () => {
    const cache = new QueryResultCache();
    const loader = vi.fn(async () => makePage());

    await cache.getOrLoad("invoiceList", "k1", loader);

    const invalidate = createInvalidationHook(cache, ["invoiceList"]);
    invalidate();

    await cache.getOrLoad("invoiceList", "k1", loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe("cache warming", () => {
  it("warms a set of entries", async () => {
    const cache = new QueryResultCache();
    const loader = vi.fn(async () => makePage());

    const result = await cache.warmUp([
      { type: "invoiceList", key: "k1", load: loader },
      { type: "invoiceList", key: "k2", load: loader },
    ]);

    expect(result.warmed).toBe(2);
    expect(result.failed).toBe(0);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(cache.getStats().size).toBe(2);
  });

  it("skips entries that are already cached", async () => {
    const cache = new QueryResultCache();
    const loader = vi.fn(async () => makePage());

    await cache.getOrLoad("invoiceList", "k1", loader);
    const result = await cache.warmUp([
      { type: "invoiceList", key: "k1", load: loader },
    ]);

    expect(result.skipped).toBe(1);
    expect(result.warmed).toBe(0);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("reports failures without aborting the warm-up", async () => {
    const cache = new QueryResultCache();

    const result = await cache.warmUp([
      {
        type: "invoiceList",
        key: "bad",
        load: async () => {
          throw new Error("network down");
        },
      },
      { type: "invoiceList", key: "good", load: async () => makePage() },
    ]);

    expect(result.failed).toBe(1);
    expect(result.warmed).toBe(1);
    expect(result.errors[0]?.error.message).toBe("network down");
  });

  it("warms a set of keys for one query type", async () => {
    const cache = new QueryResultCache();
    const loader = vi.fn(async (key: string) => `value:${key}`);

    const result = await cache.warm("invoiceList", ["a", "b"], loader);

    expect(result.warmed).toBe(2);
    expect(cache.get("invoiceList", "a")).toBe("value:a");
    expect(cache.get("invoiceList", "b")).toBe("value:b");
  });
});

describe("cached invoice list queries", () => {
  it("caches an invoice list query", async () => {
    const cache = new QueryResultCache();
    const loader = vi.fn(async (): Promise<InvoicePage> => makePage());
    const filter: InvoiceFilter = { creator: CREATOR, status: ["Pending"], limit: 10 };

    const first = await getCachedInvoiceList(cache, filter, loader);
    const second = await getCachedInvoiceList(cache, filter, loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("treats different filters as different queries", async () => {
    const cache = new QueryResultCache();
    const loader = vi.fn(async (): Promise<InvoicePage> => makePage());

    await getCachedInvoiceList(cache, { creator: CREATOR, limit: 10 }, loader);
    await getCachedInvoiceList(cache, { creator: CREATOR, limit: 20 }, loader);

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("caches a filtered invoice query", async () => {
    const cache = new QueryResultCache();
    const loader = vi.fn(async (): Promise<InvoicePage> => makePage());
    const filter: InvoiceFilter = { creator: CREATOR, sort: "newest" };

    await getCachedInvoiceQuery(cache, filter, loader);
    await getCachedInvoiceQuery(cache, filter, loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.getStats().byType.invoiceQuery?.hits).toBe(1);
  });
});

describe("cached statistical computations", () => {
  it("caches an invoice statistics computation", async () => {
    const cache = new QueryResultCache();
    const loader = vi.fn(async () => ({ totalPayers: 1 }) as InvoiceStats);

    const first = await getCachedInvoiceStats(cache, "42", loader);
    const second = await getCachedInvoiceStats(cache, "42", loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("caches the statistics computed from an invoice", async () => {
    const cache = new QueryResultCache();
    const invoice = makeInvoice();

    const first = await getCachedComputedStats(cache, invoice);
    const second = await getCachedComputedStats(cache, invoice);

    expect(second).toBe(first);
    expect(second.totalPayers).toBe(1);
    expect(second.completionBps).toBe(10_000);
  });

  it("keeps statistics for different invoices apart", async () => {
    const cache = new QueryResultCache();
    const loader = vi.fn(async () => ({ totalPayers: 1 }) as InvoiceStats);

    await getCachedInvoiceStats(cache, "1", loader);
    await getCachedInvoiceStats(cache, "2", loader);

    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe("cache events", () => {
  it("emits hit and miss events", async () => {
    const cache = new QueryResultCache();
    const events: string[] = [];
    const unsubscribe = cache.on((event) => events.push(event.type));

    const loader = vi.fn(async () => makePage());
    await cache.getOrLoad("invoiceList", "k1", loader);
    await cache.getOrLoad("invoiceList", "k1", loader);

    expect(events).toContain("miss");
    expect(events).toContain("hit");

    unsubscribe();
  });
});
