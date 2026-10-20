import { describe, expect, it, vi } from "vitest";
import {
  BatchOptimizer,
  DEFAULT_BASE_FEE_STROOPS,
  MAX_BATCH_SIZE,
  StorageKeyAccessOptimizer,
  estimateBatchFee,
  executeBatch,
  groupPaymentsByRecipient,
  mapWithConcurrency,
  paymentItemsFromOperations,
  paymentItemsToOperations,
  recommendBatchSize,
  type BatchPaymentItem,
} from "../src/batchOptimizer.js";
import type { BatchOperation } from "../src/batchOperations.js";

const ALICE = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const BOB = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function item(
  id: string,
  destination: string,
  amount: bigint,
  asset?: string
): BatchPaymentItem {
  return { id, destination, amount, asset };
}

describe("grouping payments by recipient", () => {
  it("merges payments that target the same recipient and asset", () => {
    const grouped = groupPaymentsByRecipient([
      item("a", ALICE, 100n),
      item("b", BOB, 50n),
      item("c", ALICE, 250n),
    ]);

    expect(grouped.originalCount).toBe(3);
    expect(grouped.mergedCount).toBe(2);
    expect(grouped.operationsSaved).toBe(1);
    expect(grouped.operations.map((op) => op.destination)).toEqual([ALICE, BOB]);
    expect(grouped.operations[0]!.amount).toBe(350n);
    expect(grouped.operations[1]!.amount).toBe(50n);
  });

  it("keeps the total amount identical to the original batch", () => {
    const items = [
      item("a", ALICE, 100n),
      item("b", BOB, 50n),
      item("c", ALICE, 250n),
      item("d", BOB, 25n),
    ];
    const grouped = groupPaymentsByRecipient(items);

    const originalTotal = items.reduce((sum, entry) => sum + entry.amount, 0n);
    const groupedTotal = grouped.operations.reduce((sum, op) => sum + op.amount, 0n);

    expect(groupedTotal).toBe(originalTotal);
  });

  it("does not merge different assets for the same recipient", () => {
    const grouped = groupPaymentsByRecipient([
      item("a", ALICE, 100n, "native"),
      item("b", ALICE, 100n, "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"),
    ]);

    expect(grouped.mergedCount).toBe(2);
  });

  it("reports the reduction ratio", () => {
    const grouped = groupPaymentsByRecipient([
      item("a", ALICE, 1n),
      item("b", ALICE, 1n),
      item("c", ALICE, 1n),
      item("d", ALICE, 1n),
    ]);

    expect(grouped.operationReductionRatio).toBeCloseTo(0.75, 5);
  });

  it("tracks the original item indices in every group", () => {
    const grouped = groupPaymentsByRecipient([
      item("a", ALICE, 1n),
      item("b", BOB, 1n),
      item("c", ALICE, 1n),
    ]);

    expect(grouped.groups[0]!.itemIndices).toEqual([0, 2]);
    expect(grouped.groups[1]!.itemIndices).toEqual([1]);
  });

  it("converts to and from the existing batch operation types", () => {
    const operations: BatchOperation[] = [
      { type: "payment", destination: ALICE, amount: "100" },
      { type: "manageData", name: "note", value: "hello" },
      { type: "payment", destination: ALICE, amount: "50" },
    ];

    const items = paymentItemsFromOperations(operations);
    expect(items).toHaveLength(2);
    expect(items[0]!.amount).toBe(100n);
    expect(items[1]!.amount).toBe(50n);

    const roundTripped = paymentItemsToOperations(items, ALICE);
    expect(roundTripped).toHaveLength(2);
    expect(roundTripped[0]).toMatchObject({
      type: "payment",
      destination: ALICE,
      amount: 100n,
      source: ALICE,
    });
  });
});

describe("parallel batch execution", () => {
  it("runs independent submissions concurrently", async () => {
    let inFlight = 0;
    let peak = 0;

    const submit = async (entry: BatchPaymentItem): Promise<{ txHash: string }> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inFlight -= 1;
      return { txHash: `tx_${entry.id}` };
    };

    const items = Array.from({ length: 8 }, (_, i) => item(`i${i}`, ALICE, 1n));
    const summary = await executeBatch(items, submit, { concurrency: 4 });

    expect(summary.succeeded).toBe(8);
    expect(summary.failed).toBe(0);
    expect(peak).toBe(4);
    expect(summary.maxConcurrency).toBe(4);
  });

  it("is faster than running the same items serially", async () => {
    const delay = 30;
    const items = Array.from({ length: 6 }, (_, i) => item(`i${i}`, ALICE, 1n));

    const submit = async (entry: BatchPaymentItem): Promise<{ txHash: string }> => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return { txHash: `tx_${entry.id}` };
    };

    const parallel = await executeBatch(items, submit, { concurrency: 6, jitter: false });

    const serial = await executeBatch(items, submit, { concurrency: 1, jitter: false });

    expect(parallel.durationMs).toBeLessThan(serial.durationMs);
    expect(parallel.sequentialDurationMs).toBeGreaterThan(parallel.durationMs);
    expect(parallel.speedup).toBeGreaterThan(1);
    expect(serial.speedup).toBeLessThan(parallel.speedup);
  });

  it("never exceeds the configured concurrency", async () => {
    let inFlight = 0;
    let peak = 0;

    const submit = async (entry: BatchPaymentItem): Promise<{ txHash: string }> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return { txHash: entry.id };
    };

    await executeBatch(
      Array.from({ length: 12 }, (_, i) => item(`i${i}`, ALICE, 1n)),
      submit,
      { concurrency: 3 }
    );

    expect(peak).toBeLessThanOrEqual(3);
  });

  it("preserves the input order in the results", async () => {
    const items = Array.from({ length: 6 }, (_, i) => item(`i${i}`, ALICE, 1n));
    const submit = async (entry: BatchPaymentItem): Promise<{ txHash: string }> => {
      await new Promise((resolve) => setTimeout(resolve, (6 - Number(entry.id.slice(1))) * 3));
      return { txHash: entry.id };
    };

    const summary = await executeBatch(items, submit, { concurrency: 6 });
    expect(summary.results.map((r) => r.id)).toEqual(["i0", "i1", "i2", "i3", "i4", "i5"]);
  });

  it("reports progress as items complete", async () => {
    const onProgress = vi.fn();
    const items = Array.from({ length: 4 }, (_, i) => item(`i${i}`, ALICE, 1n));

    await executeBatch(items, async (entry) => ({ txHash: entry.id }), {
      concurrency: 2,
      onProgress,
    });

    expect(onProgress).toHaveBeenCalledTimes(4);
    expect(onProgress.mock.calls[onProgress.mock.calls.length - 1]).toEqual([4, 4]);
  });
});

describe("retry logic for failed batches", () => {
  it("retries a failing item and succeeds on a later attempt", async () => {
    let attempts = 0;
    const submit = async (entry: BatchPaymentItem): Promise<{ txHash: string }> => {
      attempts += 1;
      if (attempts < 3) throw new Error("temporary network failure");
      return { txHash: "tx_ok" };
    };

    const summary = await executeBatch([item("a", ALICE, 1n)], submit, {
      maxRetries: 3,
      jitter: false,
      sleep: async () => {},
    });

    expect(attempts).toBe(3);
    expect(summary.succeeded).toBe(1);
    expect(summary.results[0]!.attempts).toBe(3);
    expect(summary.retries).toBe(2);
  });

  it("gives up after the configured number of retries", async () => {
    let attempts = 0;
    const submit = async (): Promise<{ txHash: string }> => {
      attempts += 1;
      throw new Error("permanent failure");
    };

    const summary = await executeBatch([item("a", ALICE, 1n)], submit, {
      maxRetries: 2,
      jitter: false,
      sleep: async () => {},
    });

    expect(attempts).toBe(3);
    expect(summary.failed).toBe(1);
    expect(summary.results[0]!.success).toBe(false);
    expect(summary.results[0]!.error?.message).toBe("permanent failure");
    expect(summary.results[0]!.attempts).toBe(3);
  });

  it("applies exponential backoff between attempts", async () => {
    const delays: number[] = [];
    const submit = async (): Promise<{ txHash: string }> => {
      throw new Error("boom");
    };

    await executeBatch([item("a", ALICE, 1n)], submit, {
      maxRetries: 3,
      retryDelayMs: 100,
      backoffMultiplier: 2,
      jitter: false,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    expect(delays).toEqual([100, 200, 400]);
  });

  it("honours a custom shouldRetry predicate", async () => {
    let attempts = 0;
    const submit = async (): Promise<{ txHash: string }> => {
      attempts += 1;
      throw new Error("fatal");
    };

    const summary = await executeBatch([item("a", ALICE, 1n)], submit, {
      maxRetries: 5,
      jitter: false,
      sleep: async () => {},
      shouldRetry: (error) => !(error instanceof Error && error.message.includes("fatal")),
    });

    expect(attempts).toBe(1);
    expect(summary.failed).toBe(1);
  });
});

describe("graceful degradation on partial failure", () => {
  it("returns per-item results instead of throwing", async () => {
    const submit = async (entry: BatchPaymentItem): Promise<{ txHash: string }> => {
      if (entry.id === "b") throw new Error("item b failed");
      return { txHash: `tx_${entry.id}` };
    };

    const summary = await executeBatch(
      [item("a", ALICE, 1n), item("b", BOB, 1n), item("c", ALICE, 1n)],
      submit,
      { maxRetries: 0 }
    );

    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.results.map((r) => r.success)).toEqual([true, false, true]);
    expect(summary.results[1]!.error?.message).toBe("item b failed");
  });

  it("does not reject when every item fails", async () => {
    const submit = async (): Promise<{ txHash: string }> => {
      throw new Error("network down");
    };

    const summary = await executeBatch(
      [item("a", ALICE, 1n), item("b", BOB, 1n)],
      submit,
      { maxRetries: 0 }
    );

    expect(summary.failed).toBe(2);
    expect(summary.succeeded).toBe(0);
    expect(summary.results.every((r) => r.error instanceof Error)).toBe(true);
  });
});

describe("storage key access optimization", () => {
  it("memoises resolved storage values", async () => {
    const optimizer = new StorageKeyAccessOptimizer();
    const resolver = vi.fn(async (key: string) => `value:${key}`);

    expect(await optimizer.read("invoice:1", resolver)).toBe("value:invoice:1");
    expect(await optimizer.read("invoice:1", resolver)).toBe("value:invoice:1");

    expect(resolver).toHaveBeenCalledTimes(1);
    const stats = optimizer.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
  });

  it("expires memoised values after the TTL", async () => {
    let now = 1_000;
    const optimizer = new StorageKeyAccessOptimizer({ ttlMs: 100, now: () => now });
    const resolver = vi.fn(async (key: string) => `value:${key}`);

    await optimizer.read("invoice:1", resolver);
    now += 50;
    await optimizer.read("invoice:1", resolver);
    expect(resolver).toHaveBeenCalledTimes(1);

    now += 200;
    await optimizer.read("invoice:1", resolver);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("de-duplicates duplicate keys inside a batch read", async () => {
    const optimizer = new StorageKeyAccessOptimizer();
    const resolver = vi.fn(async (keys: string[]) => new Map(keys.map((k) => [k, `value:${k}`])));

    const result = await optimizer.readMany(
      ["invoice:1", "invoice:2", "invoice:1", "invoice:2", "invoice:1"],
      resolver
    );

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver.mock.calls[0]![0]).toEqual(["invoice:1", "invoice:2"]);
    expect(result.size).toBe(2);
    expect(result.get("invoice:1")).toBe("value:invoice:1");
    expect(optimizer.getStats().deduplicated).toBe(3);
  });

  it("serves already cached keys without calling the resolver", async () => {
    const optimizer = new StorageKeyAccessOptimizer();
    const resolver = vi.fn(async (keys: string[]) => new Map(keys.map((k) => [k, `value:${k}`])));

    await optimizer.readMany(["invoice:1"], resolver);
    const second = await optimizer.readMany(["invoice:1", "invoice:2"], resolver);

    expect(resolver).toHaveBeenCalledTimes(2);
    expect(resolver.mock.calls[1]![0]).toEqual(["invoice:2"]);
    expect(second.get("invoice:1")).toBe("value:invoice:1");
  });

  it("supports array shaped resolver results", async () => {
    const optimizer = new StorageKeyAccessOptimizer();
    const result = await optimizer.readMany(["a", "b"], async (keys) =>
      keys.map((key) => `value:${key}`)
    );

    expect(result.get("a")).toBe("value:a");
    expect(result.get("b")).toBe("value:b");
  });

  it("invalidates a single key or the whole memo", async () => {
    const optimizer = new StorageKeyAccessOptimizer();
    const resolver = vi.fn(async (key: string) => `value:${key}`);

    await optimizer.read("a", resolver);
    await optimizer.read("b", resolver);
    optimizer.invalidate("a");
    await optimizer.read("a", resolver);
    expect(resolver).toHaveBeenCalledTimes(3);

    optimizer.clear();
    expect(optimizer.getStats().size).toBe(0);
  });

  it("builds stable storage keys", () => {
    expect(StorageKeyAccessOptimizer.key("invoice", "42")).toBe("invoice:42");
  });
});

describe("batch size recommendations", () => {
  it("recommends a single transaction for a small batch", () => {
    const recommendation = recommendBatchSize(10);

    expect(recommendation.size).toBe(10);
    expect(recommendation.transactionCount).toBe(1);
    // 100 stroops * (1 base + 10 operations)
    expect(recommendation.estimatedFeeStroops).toBe("1100");
    // One transaction per operation: 100 stroops * (1 base + 1 operation) * 10
    expect(recommendation.naiveFeeStroops).toBe("2000");
    expect(recommendation.feeReductionRatio).toBeCloseTo(0.45, 5);
    expect(recommendation.reason).toContain("transaction");
  });

  it("caps the recommendation at the protocol maximum", () => {
    const recommendation = recommendBatchSize(250);

    expect(recommendation.size).toBe(MAX_BATCH_SIZE);
    expect(recommendation.transactionCount).toBe(3);
    // 100 * 101 + 100 * 101 + 100 * 51
    expect(recommendation.estimatedFeeStroops).toBe("25300");
  });

  it("shows the fee saved versus one transaction per operation", () => {
    const recommendation = recommendBatchSize(50);

    expect(recommendation.naiveFeeStroops).toBe("10000");
    expect(recommendation.estimatedFeeStroops).toBe("5100");
    expect(recommendation.feeReductionRatio).toBeCloseTo(0.49, 5);
  });

  it("estimates fees for a given batch size", () => {
    expect(estimateBatchFee(0)).toBe(0n);
    expect(estimateBatchFee(100, 100)).toBe(BigInt(100 * 101));
    expect(estimateBatchFee(150, 100)).toBe(BigInt(100 * 101 + 100 * 51));
    expect(estimateBatchFee(10, 1)).toBe(BigInt(10 * 100 * 2));
  });
});

describe("BatchOptimizer", () => {
  it("groups, executes and reports metrics", async () => {
    const optimizer = new BatchOptimizer({ concurrency: 3, jitter: false, maxRetries: 0 });
    const items = [
      item("a", ALICE, 100n),
      item("b", BOB, 50n),
      item("c", ALICE, 25n),
    ];

    optimizer.group(items);
    const summary = await optimizer.execute(items, async (entry) => ({ txHash: entry.id }));
    const metrics = optimizer.getMetrics();

    expect(summary.succeeded).toBe(3);
    expect(metrics.itemCount).toBe(3);
    expect(metrics.operationCount).toBe(2);
    expect(metrics.operationsSaved).toBe(1);
    expect(metrics.operationReductionRatio).toBeCloseTo(1 / 3, 5);
    // 3 operations in one transaction: 100 * (1 + 3)
    expect(metrics.estimatedFeeBeforeStroops).toBe("400");
    // 2 grouped operations in one transaction: 100 * (1 + 2)
    expect(metrics.estimatedFeeAfterStroops).toBe("300");
    expect(metrics.feeReductionRatio).toBeCloseTo(0.25, 5);
    expect(metrics.lastExecutionMs).toBeGreaterThanOrEqual(0);
    expect(metrics.lastSpeedup).toBeGreaterThan(0);
  });

  it("reduces the estimated gas cost by grouping payments", () => {
    const optimizer = new BatchOptimizer();
    const items = Array.from({ length: 10 }, (_, i) => item(`i${i}`, ALICE, 1n));

    optimizer.group(items);
    const metrics = optimizer.getMetrics();

    expect(metrics.estimatedFeeBeforeStroops).toBe("1100");
    expect(metrics.estimatedFeeAfterStroops).toBe("200");
    expect(metrics.feeReductionRatio).toBeGreaterThan(0.2);
  });

  it("exposes the storage key optimizer", () => {
    const optimizer = new BatchOptimizer();
    expect(optimizer.storageKeys).toBeInstanceOf(StorageKeyAccessOptimizer);
  });

  it("recommends a batch size using the configured limits", () => {
    const optimizer = new BatchOptimizer({ maxBatchSize: 10 });
    const recommendation = optimizer.recommend(25);

    expect(recommendation.size).toBe(10);
    expect(recommendation.transactionCount).toBe(3);
  });
});

describe("mapWithConcurrency", () => {
  it("preserves ordering and reports the peak concurrency", async () => {
    const tasks = [30, 10, 20].map((delay, index) => async () => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return index;
    });

    const { results, peakConcurrency } = await mapWithConcurrency(tasks, 3);

    expect(results).toEqual([0, 1, 2]);
    expect(peakConcurrency).toBe(3);
  });

  it("handles an empty task list", async () => {
    const { results, peakConcurrency } = await mapWithConcurrency([], 4);
    expect(results).toEqual([]);
    expect(peakConcurrency).toBe(0);
  });
});
