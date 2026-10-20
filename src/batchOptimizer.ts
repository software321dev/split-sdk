/**
 * Batch operation optimization for the StellarSplit SDK.
 *
 * Builds on the existing batch machinery in `batchOperations.ts` and adds:
 *
 * - payment grouping by recipient, so several payments to the same recipient
 *   collapse into a single operation (fewer operations → lower fees),
 * - parallel execution of independent submissions with bounded concurrency,
 * - per-item retry with exponential backoff and jitter,
 * - a storage-key access optimizer that de-duplicates and memoises contract
 *   storage reads,
 * - batch-size recommendations, and timing / gas metrics.
 *
 * Batch execution never throws because of an individual item: the executor
 * always resolves with a per-item result so a partial failure degrades
 * gracefully.
 *
 * Issue #1133
 *
 * @module batchOptimizer
 */

import type { BatchOperation, PaymentBatchOp } from "./batchOperations.js";

/** Stellar protocol maximum operations per transaction. */
export const MAX_BATCH_SIZE = 100;

/** Default Stellar base fee, in stroops. */
export const DEFAULT_BASE_FEE_STROOPS = 100;

/** Default number of items submitted concurrently. */
export const DEFAULT_CONCURRENCY = 4;

/** Default number of retries per item, after the first attempt. */
export const DEFAULT_MAX_RETRIES = 2;

/** Default base delay of the retry backoff, in milliseconds. */
export const DEFAULT_RETRY_DELAY_MS = 100;

/** Default multiplier applied to the retry delay after each attempt. */
export const DEFAULT_BACKOFF_MULTIPLIER = 2;

/** Upper bound applied to the retry delay, in milliseconds. */
export const DEFAULT_MAX_RETRY_DELAY_MS = 5_000;

/**
 * A single payment inside a batch.
 *
 * The shape is intentionally close to {@link PaymentBatchOp} so existing
 * batch code can be reused, but the amount is a `bigint` to keep stroop
 * arithmetic exact.
 */
export interface BatchPaymentItem {
  /** Stable identifier of the item, echoed back in the execution result. */
  id: string;
  /** Recipient address. */
  destination: string;
  /** Amount to send, in the asset's base unit. */
  amount: bigint;
  /** Asset identifier, e.g. `"native"` or `"CODE:ISSUER"`. */
  asset?: string;
  /** Optional source account. */
  source?: string;
  /** Arbitrary payload forwarded to the submitter untouched. */
  payload?: unknown;
}

/** A group of items that share the same recipient and asset. */
export interface BatchGroup {
  /** Grouping key, derived from the recipient and asset. */
  key: string;
  /** Recipient address of the group. */
  destination: string;
  /** Asset of the group, when the items declared one. */
  asset?: string;
  /** Indices of the original items belonging to this group. */
  itemIndices: number[];
  /** Summed amount of every item in the group. */
  totalAmount: bigint;
}

/** Result of grouping a list of items by recipient. */
export interface GroupedBatch {
  /** The merged operations, one per group. */
  operations: BatchPaymentItem[];
  /** Metadata for every group. */
  groups: BatchGroup[];
  /** Number of items before grouping. */
  originalCount: number;
  /** Number of operations after grouping. */
  mergedCount: number;
  /** Number of operations removed by grouping. */
  operationsSaved: number;
  /** Fraction of operations removed, in the range `0`–`1`. */
  operationReductionRatio: number;
}

/** Outcome of a single item submission. */
export interface BatchItemResult {
  /** Identifier of the item. */
  id: string;
  /** Whether the item was submitted successfully. */
  success: boolean;
  /** Transaction hash, when the submission succeeded. */
  txHash?: string;
  /** The error that caused the failure, when the item failed. */
  error?: Error;
  /** Number of attempts made, including the first one. */
  attempts: number;
  /** Duration of the item's submission, in milliseconds. */
  durationMs: number;
}

/** Aggregated outcome of a batch execution. */
export interface BatchExecutionSummary {
  /** Per-item results, in the order the items were supplied. */
  results: BatchItemResult[];
  /** Number of items that succeeded. */
  succeeded: number;
  /** Number of items that failed. */
  failed: number;
  /** Wall-clock duration of the whole batch, in milliseconds. */
  durationMs: number;
  /** Sum of the individual item durations — the cost of running serially. */
  sequentialDurationMs: number;
  /**
   * Speedup versus running the items serially. `1` means no parallelism was
   * achieved, higher values mean the batch finished proportionally faster.
   */
  speedup: number;
  /** Number of retries performed across every item. */
  retries: number;
  /** Highest number of items that were in flight at the same time. */
  maxConcurrency: number;
}

/** Configuration for {@link executeBatch}. */
export interface BatchExecutionOptions {
  /** Number of items submitted concurrently. Defaults to {@link DEFAULT_CONCURRENCY}. */
  concurrency?: number;
  /** Retries per item after the first attempt. Defaults to {@link DEFAULT_MAX_RETRIES}. */
  maxRetries?: number;
  /** Base retry delay in milliseconds. Defaults to {@link DEFAULT_RETRY_DELAY_MS}. */
  retryDelayMs?: number;
  /** Multiplier applied to the delay after every attempt. Defaults to 2. */
  backoffMultiplier?: number;
  /** Upper bound for the retry delay. Defaults to {@link DEFAULT_MAX_RETRY_DELAY_MS}. */
  maxRetryDelayMs?: number;
  /** Add random jitter to the retry delay. Defaults to `true`. */
  jitter?: boolean;
  /** Decide whether an error is retryable. Defaults to retrying every error. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Delay implementation, injectable for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Progress callback invoked after every completed item. */
  onProgress?: (completed: number, total: number) => void;
}

/** A submission handler for a single item. */
export type BatchSubmitter<TItem extends BatchPaymentItem = BatchPaymentItem> = (
  item: TItem
) => Promise<{ txHash: string } | string | void>;

/** Configuration for the storage-key access optimizer. */
export interface StorageKeyOptimizerOptions {
  /** Time-to-live of a memoised storage value, in milliseconds. Defaults to 30 000. */
  ttlMs?: number;
  /** Maximum number of memoised keys. Defaults to 1000. */
  maxEntries?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

/** Statistics for the storage-key access optimizer. */
export interface StorageKeyStats {
  /** Reads served from the memo. */
  hits: number;
  /** Reads that had to reach the resolver. */
  misses: number;
  /** Duplicate keys collapsed before hitting the resolver. */
  deduplicated: number;
  /** Number of batched reads performed. */
  batches: number;
  /** Number of keys currently memoised. */
  size: number;
}

/** A batch-size recommendation. */
export interface BatchSizeRecommendation {
  /** Recommended number of operations per transaction. */
  size: number;
  /** Number of transactions required for the requested operation count. */
  transactionCount: number;
  /** Estimated total fee in stroops for the recommended split. */
  estimatedFeeStroops: string;
  /** Estimated total fee in stroops when every operation is sent alone. */
  naiveFeeStroops: string;
  /** Fraction of fee saved versus sending every operation alone, `0`–`1`. */
  feeReductionRatio: number;
  /** Human readable explanation of the recommendation. */
  reason: string;
}

/** Options for {@link recommendBatchSize}. */
export interface BatchSizeRecommendationOptions {
  /** Base fee per operation, in stroops. Defaults to {@link DEFAULT_BASE_FEE_STROOPS}. */
  baseFeeStroops?: number;
  /** Maximum operations per transaction. Defaults to {@link MAX_BATCH_SIZE}. */
  maxBatchSize?: number;
  /**
   * Number of operations above which the recommendation is capped at
   * `maxBatchSize`. Defaults to `maxBatchSize`.
   */
  targetOperations?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Group payments by recipient, merging the amounts of every payment that
 * targets the same recipient and asset.
 *
 * Merging is exact: the summed amount of a group always equals the sum of
 * its members, so the grouped batch moves the same value as the original.
 *
 * @param items - The payments to group.
 * @returns The merged operations and per-group metadata.
 */
export function groupPaymentsByRecipient(items: readonly BatchPaymentItem[]): GroupedBatch {
  const groups = new Map<string, BatchGroup>();
  const operationIndexByKey = new Map<string, number>();
  const operations: BatchPaymentItem[] = [];

  items.forEach((item, index) => {
    const asset = item.asset ?? "native";
    const key = `${item.destination}|${asset}`;
    const existing = groups.get(key);

    if (existing) {
      existing.itemIndices.push(index);
      existing.totalAmount += item.amount;
      const operation = operations[operationIndexByKey.get(key)!]!;
      operation.amount += item.amount;
      return;
    }

    const group: BatchGroup = {
      key,
      destination: item.destination,
      asset: item.asset,
      itemIndices: [index],
      totalAmount: item.amount,
    };
    groups.set(key, group);
    operationIndexByKey.set(key, operations.length);
    operations.push({
      id: `group_${operations.length}`,
      destination: item.destination,
      amount: item.amount,
      asset: item.asset,
      source: item.source,
      payload: item,
    });
  });

  const originalCount = items.length;
  const mergedCount = operations.length;
  const operationsSaved = originalCount - mergedCount;

  return {
    operations,
    groups: [...groups.values()],
    originalCount,
    mergedCount,
    operationsSaved,
    operationReductionRatio: originalCount > 0 ? operationsSaved / originalCount : 0,
  };
}

/**
 * Convert SDK batch operations into optimizer payment items.
 *
 * Non-payment operations are ignored, so a mixed batch can still be grouped
 * by recipient for the payments it contains.
 *
 * @param operations - The batch operations to convert.
 */
export function paymentItemsFromOperations(
  operations: readonly BatchOperation[]
): BatchPaymentItem[] {
  const items: BatchPaymentItem[] = [];
  operations.forEach((operation, index) => {
    if (operation.type !== "payment") return;
    const payment = operation as PaymentBatchOp;
    items.push({
      id: `op_${index}`,
      destination: payment.destination,
      amount: BigInt(payment.amount),
      asset: typeof payment.asset === "string" ? payment.asset : undefined,
      source: payment.source,
      payload: operation,
    });
  });
  return items;
}

/**
 * Convert optimizer payment items back into SDK payment batch operations.
 *
 * @param items - The items to convert.
 * @param source - Optional source account applied to every operation.
 */
export function paymentItemsToOperations(
  items: readonly BatchPaymentItem[],
  source?: string
): PaymentBatchOp[] {
  return items.map((item) => ({
    type: "payment",
    destination: item.destination,
    amount: item.amount,
    asset: item.asset,
    source: item.source ?? source,
  }));
}

/**
 * Estimate the total fee, in stroops, of sending `operationCount`
 * operations in transactions of at most `batchSize` operations.
 *
 * Stellar charges `baseFee * (1 + operationCount)` per transaction, so
 * grouping operations into fewer, larger transactions removes the per
 * transaction overhead.
 *
 * @param operationCount - Number of operations to send.
 * @param batchSize - Maximum operations per transaction.
 * @param baseFeeStroops - Base fee per operation, in stroops.
 */
export function estimateBatchFee(
  operationCount: number,
  batchSize: number = MAX_BATCH_SIZE,
  baseFeeStroops: number = DEFAULT_BASE_FEE_STROOPS
): bigint {
  if (operationCount <= 0) return 0n;
  const size = Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(batchSize)));
  const base = BigInt(baseFeeStroops);

  let remaining = operationCount;
  let total = 0n;
  while (remaining > 0) {
    const operations = Math.min(size, remaining);
    total += base * BigInt(operations + 1);
    remaining -= operations;
  }

  return total;
}

/**
 * Recommend how many operations to put into a single transaction.
 *
 * Stellar charges a base fee per operation *and* per transaction envelope, so
 * the cheapest split is the one with the fewest, largest transactions — capped
 * by the protocol limit of {@link MAX_BATCH_SIZE} operations.
 *
 * @param operationCount - Number of operations that need to be sent.
 * @param options - Fee and limit overrides.
 */
export function recommendBatchSize(
  operationCount: number,
  options: BatchSizeRecommendationOptions = {}
): BatchSizeRecommendation {
  const baseFee = options.baseFeeStroops ?? DEFAULT_BASE_FEE_STROOPS;
  const maxBatchSize = Math.max(1, Math.min(MAX_BATCH_SIZE, options.maxBatchSize ?? MAX_BATCH_SIZE));
  const target = Math.max(1, options.targetOperations ?? maxBatchSize);

  const count = Math.max(0, Math.floor(operationCount));
  const size = count <= target ? Math.max(1, count) : maxBatchSize;
  const transactionCount = count === 0 ? 0 : Math.ceil(count / size);

  const estimatedFee = estimateBatchFee(count, size, baseFee);
  const naiveFee = estimateBatchFee(count, 1, baseFee);
  const feeReductionRatio = naiveFee > 0n ? Number((naiveFee - estimatedFee) * 10_000n / naiveFee) / 10_000 : 0;
  return {
    size,
    transactionCount,
    estimatedFeeStroops: estimatedFee.toString(),
    naiveFeeStroops: naiveFee.toString(),
    feeReductionRatio,
    reason:
      count === 0
        ? "No operations to send."
        : `Sending ${count} operations in ${transactionCount} transaction(s) of up to ${size} operations ` +
          `costs an estimated ${estimatedFee} stroops versus ${naiveFee} stroops when every operation is sent alone.`,
  };
}

/** Result of a bounded-concurrency run. */
export interface ConcurrentRunResult<T> {
  /** The task results, in the order the tasks were supplied. */
  results: T[];
  /** Highest number of tasks that were in flight at the same time. */
  peakConcurrency: number;
}

/**
 * Run `tasks` with a bounded number of them in flight at any time.
 *
 * The returned results preserve the input order.
 *
 * @param tasks - The tasks to run.
 * @param limit - Maximum number of tasks in flight.
 */
export async function mapWithConcurrency<T>(
  tasks: readonly (() => Promise<T>)[],
  limit: number
): Promise<ConcurrentRunResult<T>> {
  const results = new Array<T>(tasks.length);
  const effectiveLimit = Math.max(1, Math.min(tasks.length || 1, Math.floor(limit)));
  let cursor = 0;
  let inFlight = 0;
  let peak = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= tasks.length) return;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        results[index] = await tasks[index]!();
      } finally {
        inFlight -= 1;
      }
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < effectiveLimit; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return { results, peakConcurrency: peak };
}

/**
 * Execute a batch of independent submissions concurrently.
 *
 * Individual failures never reject the returned promise: every item produces
 * a {@link BatchItemResult}, so a partially failed batch can be inspected and
 * retried by the caller.
 *
 * @param items - The items to submit.
 * @param submit - The submission handler.
 * @param options - Concurrency and retry configuration.
 */
export async function executeBatch(
  items: readonly BatchPaymentItem[],
  submit: BatchSubmitter,
  options: BatchExecutionOptions = {}
): Promise<BatchExecutionSummary> {
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const backoffMultiplier = Math.max(1, options.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER);
  const maxRetryDelayMs = Math.max(0, options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS);
  const jitter = options.jitter ?? true;
  const shouldRetry = options.shouldRetry ?? (() => true);
  const sleep = options.sleep ?? defaultSleep;

  const startTime = Date.now();
  let completed = 0;
  let retries = 0;

  const runItem = async (item: BatchPaymentItem): Promise<BatchItemResult> => {
    const itemStart = Date.now();
    let attempts = 0;
    let lastError: Error | undefined;

    for (;;) {
      attempts += 1;
      try {
        const outcome = await submit(item);
        const txHash = typeof outcome === "string" ? outcome : outcome?.txHash;
        return {
          id: item.id,
          success: true,
          txHash,
          attempts,
          durationMs: Date.now() - itemStart,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempts > maxRetries || !shouldRetry(error, attempts)) {
          break;
        }
        retries += 1;
        const backoff = Math.min(maxRetryDelayMs, retryDelayMs * backoffMultiplier ** (attempts - 1));
        const delay = jitter ? backoff * (0.5 + Math.random() * 0.5) : backoff;
        await sleep(delay);
      }
    }

    return {
      id: item.id,
      success: false,
      error: lastError ?? new Error("Unknown batch failure"),
      attempts,
      durationMs: Date.now() - itemStart,
    };
  };

  const tasks = items.map((item) => () =>
    runItem(item).then((result) => {
      completed += 1;
      options.onProgress?.(completed, items.length);
      return result;
    })
  );

  const { results, peakConcurrency } = await mapWithConcurrency(tasks, concurrency);
  const durationMs = Date.now() - startTime;
  const sequentialDurationMs = results.reduce((sum, result) => sum + result.durationMs, 0);

  return {
    results,
    succeeded: results.filter((result) => result.success).length,
    failed: results.filter((result) => !result.success).length,
    durationMs,
    sequentialDurationMs,
    speedup: durationMs > 0 ? sequentialDurationMs / durationMs : 1,
    retries,
    maxConcurrency: peakConcurrency,
  };
}

/**
 * Optimises contract storage reads by de-duplicating and memoising keys.
 *
 * Batch operations frequently need the same storage entries several times
 * (for example the same invoice read once per payment). The optimizer
 * collapses duplicate keys inside a batch and memoises resolved values for a
 * configurable TTL, so repeated reads never reach the network.
 */
export class StorageKeyAccessOptimizer {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly values = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private hits = 0;
  private misses = 0;
  private deduplicated = 0;
  private batches = 0;

  constructor(options: StorageKeyOptimizerOptions = {}) {
    this.ttlMs = Math.max(0, options.ttlMs ?? 30_000);
    this.maxEntries = Math.max(1, options.maxEntries ?? 1000);
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Build a stable storage key for an entity.
   *
   * @param namespace - The contract namespace, e.g. `"invoice"`.
   * @param id - The entity identifier.
   */
  static key(namespace: string, id: string): string {
    return `${namespace}:${id}`;
  }

  /**
   * Read a single storage entry, serving it from the memo when possible.
   *
   * @param key - The storage key.
   * @param resolver - Reads the value from the network.
   */
  async read<T>(key: string, resolver: (key: string) => Promise<T>): Promise<T> {
    const cached = this.values.get(key);
    if (cached && cached.expiresAt > this.now()) {
      this.hits += 1;
      return cached.value as T;
    }
    if (cached) {
      this.values.delete(key);
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      this.deduplicated += 1;
      return (await pending) as T;
    }

    this.misses += 1;
    const promise = resolver(key);
    this.inFlight.set(key, promise);
    try {
      const value = await promise;
      this.set(key, value);
      return value;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Read many storage entries at once.
   *
   * Duplicate keys are collapsed into a single resolver call, and keys that
   * are already memoised are not passed to the resolver at all.
   *
   * @param keys - The storage keys to read.
   * @param resolver - Reads the missing values. Receives the de-duplicated
   *   list of keys that are not already cached.
   */
  async readMany<T>(
    keys: readonly string[],
    resolver: (keys: string[]) => Promise<Map<string, T> | T[]>
  ): Promise<Map<string, T>> {
    this.batches += 1;
    const result = new Map<string, T>();
    const missing: string[] = [];
    const seen = new Set<string>();

    for (const key of keys) {
      if (seen.has(key)) {
        this.deduplicated += 1;
        continue;
      }
      seen.add(key);

      const cached = this.values.get(key);
      if (cached && cached.expiresAt > this.now()) {
        this.hits += 1;
        result.set(key, cached.value as T);
        continue;
      }
      if (cached) {
        this.values.delete(key);
      }
      this.misses += 1;
      missing.push(key);
    }

    if (missing.length > 0) {
      const resolved = await resolver(missing);
      if (resolved instanceof Map) {
        for (const [key, value] of resolved) {
          this.set(key, value);
          result.set(key, value as T);
        }
      } else {
        missing.forEach((key, index) => {
          const value = resolved[index];
          if (value !== undefined) {
            this.set(key, value);
            result.set(key, value as T);
          }
        });
      }
    }

    return result;
  }

  /** Statistics for the optimizer. */
  getStats(): StorageKeyStats {
    return {
      hits: this.hits,
      misses: this.misses,
      deduplicated: this.deduplicated,
      batches: this.batches,
      size: this.values.size,
    };
  }

  /**
   * Invalidate a memoised value.
   *
   * @param key - The key to drop. When omitted the whole memo is cleared.
   */
  invalidate(key?: string): void {
    if (key === undefined) {
      this.values.clear();
      return;
    }
    this.values.delete(key);
  }

  /** Remove every memoised value. */
  clear(): void {
    this.values.clear();
  }

  private set(key: string, value: unknown): void {
    if (this.maxEntries > 0 && this.values.size >= this.maxEntries && !this.values.has(key)) {
      const oldest = this.values.keys().next().value;
      if (oldest !== undefined) this.values.delete(oldest);
    }
    this.values.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }
}

/** Metrics describing how a batch was optimized. */
export interface BatchOptimizationMetrics {
  /** Number of items processed. */
  itemCount: number;
  /** Number of operations after grouping. */
  operationCount: number;
  /** Operations removed by grouping. */
  operationsSaved: number;
  /** Fraction of operations removed, `0`–`1`. */
  operationReductionRatio: number;
  /** Estimated fee before grouping, in stroops. */
  estimatedFeeBeforeStroops: string;
  /** Estimated fee after grouping, in stroops. */
  estimatedFeeAfterStroops: string;
  /** Fraction of fee saved by grouping, `0`–`1`. */
  feeReductionRatio: number;
  /** Wall-clock duration of the last execution, in milliseconds. */
  lastExecutionMs: number;
  /** Speedup of the last execution versus running serially. */
  lastSpeedup: number;
  /** Number of retries performed in the last execution. */
  lastRetries: number;
}

/** Configuration for {@link BatchOptimizer}. */
export interface BatchOptimizerOptions {
  /** Number of items submitted concurrently. Defaults to {@link DEFAULT_CONCURRENCY}. */
  concurrency?: number;
  /** Retries per item after the first attempt. Defaults to {@link DEFAULT_MAX_RETRIES}. */
  maxRetries?: number;
  /** Base retry delay in milliseconds. Defaults to {@link DEFAULT_RETRY_DELAY_MS}. */
  retryDelayMs?: number;
  /** Multiplier applied to the retry delay after every attempt. Defaults to 2. */
  backoffMultiplier?: number;
  /** Upper bound for the retry delay. Defaults to {@link DEFAULT_MAX_RETRY_DELAY_MS}. */
  maxRetryDelayMs?: number;
  /** Add random jitter to the retry delay. Defaults to `true`. */
  jitter?: boolean;
  /** Base fee per operation, in stroops. Defaults to {@link DEFAULT_BASE_FEE_STROOPS}. */
  baseFeeStroops?: number;
  /** Maximum operations per transaction. Defaults to {@link MAX_BATCH_SIZE}. */
  maxBatchSize?: number;
  /** Storage-key optimizer configuration. */
  storage?: StorageKeyOptimizerOptions;
}

/**
 * High-level entry point combining grouping, parallel execution, retry and
 * the storage-key optimizer.
 *
 * @example
 * ```ts
 * const optimizer = new BatchOptimizer({ concurrency: 4 });
 * const grouped = optimizer.group(items);
 * const summary = await optimizer.execute(items, submit);
 * const metrics = optimizer.getMetrics();
 * ```
 */
export class BatchOptimizer {
  private readonly options: BatchOptimizerOptions;
  private readonly storage: StorageKeyAccessOptimizer;
  private lastSummary?: BatchExecutionSummary;
  private lastGrouped?: GroupedBatch;

  constructor(options: BatchOptimizerOptions = {}) {
    this.options = { ...options };
    this.storage = new StorageKeyAccessOptimizer(options.storage);
  }

  /** The storage-key access optimizer used by this batch optimizer. */
  get storageKeys(): StorageKeyAccessOptimizer {
    return this.storage;
  }

  /**
   * Group payments by recipient.
   *
   * @param items - The payments to group.
   */
  group(items: readonly BatchPaymentItem[]): GroupedBatch {
    const grouped = groupPaymentsByRecipient(items);
    this.lastGrouped = grouped;
    return grouped;
  }

  /**
   * Execute a batch of independent submissions concurrently.
   *
   * @param items - The items to submit.
   * @param submit - The submission handler.
   * @param overrides - Per-execution option overrides.
   */
  async execute(
    items: readonly BatchPaymentItem[],
    submit: BatchSubmitter,
    overrides: BatchExecutionOptions = {}
  ): Promise<BatchExecutionSummary> {
    const summary = await executeBatch(items, submit, {
      concurrency: this.options.concurrency,
      maxRetries: this.options.maxRetries,
      retryDelayMs: this.options.retryDelayMs,
      backoffMultiplier: this.options.backoffMultiplier,
      maxRetryDelayMs: this.options.maxRetryDelayMs,
      jitter: this.options.jitter,
      ...overrides,
    });
    this.lastSummary = summary;
    return summary;
  }

  /**
   * Recommend a batch size for the given number of operations.
   *
   * @param operationCount - Number of operations to send.
   */
  recommend(operationCount: number): BatchSizeRecommendation {
    return recommendBatchSize(operationCount, {
      baseFeeStroops: this.options.baseFeeStroops,
      maxBatchSize: this.options.maxBatchSize,
    });
  }

  /** Metrics describing the last grouping and execution. */
  getMetrics(): BatchOptimizationMetrics {
    const grouped = this.lastGrouped;
    const summary = this.lastSummary;
    const baseFee = this.options.baseFeeStroops ?? DEFAULT_BASE_FEE_STROOPS;

    const itemCount = grouped?.originalCount ?? summary?.results.length ?? 0;
    const operationCount = grouped?.mergedCount ?? itemCount;
    const batchSize = this.options.maxBatchSize ?? MAX_BATCH_SIZE;
    const feeBefore = estimateBatchFee(itemCount, batchSize, baseFee);
    const feeAfter = estimateBatchFee(operationCount, batchSize, baseFee);

    return {
      itemCount,
      operationCount,
      operationsSaved: grouped?.operationsSaved ?? 0,
      operationReductionRatio: grouped?.operationReductionRatio ?? 0,
      estimatedFeeBeforeStroops: feeBefore.toString(),
      estimatedFeeAfterStroops: feeAfter.toString(),
      feeReductionRatio: feeBefore > 0n ? Number((feeBefore - feeAfter) * 10_000n / feeBefore) / 10_000 : 0,
      lastExecutionMs: summary?.durationMs ?? 0,
      lastSpeedup: summary?.speedup ?? 1,
      lastRetries: summary?.retries ?? 0,
    };
  }
}
