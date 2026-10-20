/**
 * Lazy loading for on-chain invoices.
 *
 * An invoice fetched from the chain carries a large amount of data that most
 * consumers never look at: the full payment history, the status-transition
 * log, the recipient list and the prerequisite graph. Fetching and holding
 * all of it for every invoice in a list is what makes invoice screens slow to
 * start and expensive in memory.
 *
 * This module splits an invoice into
 *
 * - **eager properties** — the small scalar fields that are always present
 *   on the base record and are read synchronously, and
 * - **lazy properties** — the heavy collections that are only fetched when
 *   they are actually accessed.
 *
 * A lazy property is exposed as a {@link LazyValue}: a thenable that starts
 * the fetch on first access, memoises the resolved value, exposes a loading
 * state and converts failures into a typed {@link LazyPropertyLoadError}.
 *
 * @module invoice/lazyInvoice
 */

import { LazyPropertyLoadError } from "../errors.js";
import type {
  Invoice,
  Payment,
  Recipient,
  TransitionRecord,
} from "../types.js";

// ---------------------------------------------------------------------------
// Property classification
// ---------------------------------------------------------------------------

/** The heavy invoice properties that can be resolved on demand. */
export const LAZY_INVOICE_PROPERTIES = [
  "payments",
  "recipients",
  "statusHistory",
  "prerequisites",
  "penalty_tiers",
] as const;

/** A property that can be resolved on demand. */
export type LazyInvoiceProperty = (typeof LAZY_INVOICE_PROPERTIES)[number];

/**
 * The invoice properties that are always read from the base record.
 *
 * These are the fields a list view needs in order to render a row: they are
 * scalars or short arrays, so resolving them costs nothing extra.
 */
export const EAGER_INVOICE_PROPERTIES = [
  "id",
  "creator",
  "status",
  "token",
  "funded",
  "deadline",
  "createdAt",
  "recurring",
  "memo",
  "tags",
  "clonedFrom",
  "groupId",
  "parentInvoiceId",
  "lastModifiedLedger",
  "scheduledReleaseDate",
  "cloneDepth",
  "nft_gate",
  "forward_invoice_id",
  "penalty_deadline",
  "prerequisite_id",
  "allowed_callers",
  "accessPolicy",
  "split_rules",
  "auto_resolve_rules",
  "metadata",
] as const;

/** The type of each lazy property. */
export interface LazyInvoicePropertyMap {
  /** All payments recorded on-chain. */
  payments: Payment[];
  /** Ordered list of recipients with their owed amounts. */
  recipients: Recipient[];
  /** Ordered record of status transitions. */
  statusHistory: TransitionRecord[] | undefined;
  /** IDs of invoices that must be paid before this one. */
  prerequisites: string[] | undefined;
  /** Configured penalty tiers for late payments. */
  penalty_tiers: { days_late: number; penalty_bps: number }[] | undefined;
}

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

/** The state of a single lazily loaded property. */
export type LazyLoadingState = "idle" | "loading" | "loaded" | "error";

/** A snapshot of the loading state of a whole invoice. */
export interface LazyInvoiceState {
  /** The invoice identifier. */
  invoiceId: string;
  /** Overall state of the invoice. */
  state: "idle" | "loading" | "loaded" | "error";
  /** Properties that are currently being loaded. */
  loading: string[];
  /** Properties that have been resolved. */
  loaded: string[];
  /** Properties whose load failed. */
  failed: string[];
}

/** A listener notified whenever the loading state changes. */
export type LazyInvoiceStateListener = (state: LazyInvoiceState) => void;

/**
 * A promise-like handle to a value that is loaded on demand.
 *
 * The value is fetched at most once: the in-flight promise is memoised, and
 * a resolved value is cached for the lifetime of the handle. The handle is
 * awaitable, so `await invoice.payments` reads exactly like a normal
 * property access — the only difference is that it resolves later.
 */
export class LazyValue<T> implements PromiseLike<T> {
  /** The name of the property this value belongs to. */
  readonly property: string;

  private currentState: LazyLoadingState = "idle";
  private resolvedValue: T | undefined;
  private failure: Error | undefined;
  private pending: Promise<T> | undefined;
  private readonly loader: () => Promise<T>;
  private readonly notify: (() => void) | undefined;

  /**
   * @param property - The property name, used in error messages.
   * @param loader - Loads the value. Called at most once.
   * @param notify - Invoked whenever the state of this value changes.
   */
  constructor(property: string, loader: () => Promise<T>, notify?: () => void) {
    this.property = property;
    this.loader = loader;
    this.notify = notify;
  }

  /** The current loading state. */
  get state(): LazyLoadingState {
    return this.currentState;
  }

  /** The resolved value, or `undefined` until the value has loaded. */
  get value(): T | undefined {
    return this.currentState === "loaded" ? this.resolvedValue : undefined;
  }

  /** The failure, when the load failed. */
  get error(): Error | undefined {
    return this.failure;
  }

  /** Whether the value is currently being loaded. */
  get isLoading(): boolean {
    return this.currentState === "loading";
  }

  /** Whether the value has been resolved. */
  get isLoaded(): boolean {
    return this.currentState === "loaded";
  }

  /** Whether the load failed. */
  get isFailed(): boolean {
    return this.currentState === "error";
  }

  /**
   * Start (or join) the load and resolve with the value.
   *
   * Repeated calls return the same promise: the value is never fetched
   * twice. A failure rejects with a {@link LazyPropertyLoadError}.
   */
  load(): Promise<T> {
    if (!this.pending) {
      this.setState("loading");
      this.pending = this.loader()
        .then((value) => {
          this.resolvedValue = value;
          this.failure = undefined;
          this.setState("loaded");
          return value;
        })
        .catch((error: unknown) => {
          this.failure = toLazyPropertyError(error, this.property);
          this.setState("error");
          throw this.failure;
        });
      // Attach a no-op handler so a load that nobody awaits never surfaces
      // as an unhandled rejection.
      void this.pending.catch(() => undefined);
    }
    return this.pending;
  }

  /** Makes the handle awaitable: `await invoice.payments`. */
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.load().then(onfulfilled, onrejected);
  }

  private setState(state: LazyLoadingState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.notify?.();
  }
}

/**
 * Convert an arbitrary failure into a typed {@link LazyPropertyLoadError}.
 *
 * @param error - The original failure.
 * @param property - The property that failed to load.
 */
export function toLazyPropertyError(error: unknown, property: string): LazyPropertyLoadError {
  if (error instanceof LazyPropertyLoadError) {
    return error;
  }
  const cause = error instanceof Error ? error.message : String(error);
  return new LazyPropertyLoadError(property, cause);
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Resolves a single lazy property of an invoice.
 *
 * @param property - The property to resolve.
 * @param invoice - The base invoice the property belongs to.
 */
export type LazyInvoiceLoader = (
  property: LazyInvoiceProperty,
  invoice: Invoice
) => Promise<unknown>;

/**
 * Build a loader that fetches the full invoice and extracts one property.
 *
 * @param fetchInvoice - Fetches the invoice by id.
 */
export function createInvoicePropertyLoader(
  fetchInvoice: (invoiceId: string) => Promise<Invoice>
): LazyInvoiceLoader {
  return async (property, invoice) => {
    const full = await fetchInvoice(invoice.id);
    return (full as unknown as Record<string, unknown>)[property];
  };
}

/**
 * Build a loader that serves properties from an already-fetched invoice.
 *
 * Useful when the caller already holds the full record and only wants the
 * lazy access pattern (and its state tracking) on top of it.
 *
 * @param invoice - The invoice holding the property values.
 */
export function createLocalPropertyLoader(invoice: Invoice): LazyInvoiceLoader {
  return async (property) =>
    (invoice as unknown as Record<string, unknown>)[property];
}

// ---------------------------------------------------------------------------
// The lazy invoice
// ---------------------------------------------------------------------------

/** Controls exposed by every lazy invoice. */
export interface LazyInvoiceControls {
  /** The invoice identifier. */
  readonly id: string;
  /** A snapshot of the current loading state. */
  readonly loadingState: LazyInvoiceState;
  /** Whether any property is currently loading. */
  readonly isLoading: boolean;
  /** The lazy properties this invoice exposes. */
  readonly lazyProperties: readonly string[];
  /** Subscribe to loading-state changes. Returns an unsubscribe function. */
  onLoadingStateChange(listener: LazyInvoiceStateListener): () => void;
  /** Load a single lazy property without awaiting it. */
  preload(property: LazyInvoiceProperty): Promise<unknown>;
  /** Load every lazy property and return a plain, fully-populated invoice. */
  resolve(): Promise<Invoice>;
}

/**
 * An invoice whose heavy properties are resolved on demand.
 *
 * Eager properties keep their normal, synchronous semantics. Lazy properties
 * are {@link LazyValue} handles: reading one never blocks, and awaiting one
 * resolves the underlying data.
 */
export type LazyInvoiceRecord = Omit<
  Invoice,
  keyof LazyInvoicePropertyMap
> & {
  [K in keyof LazyInvoicePropertyMap]: LazyValue<LazyInvoicePropertyMap[K]>;
} & LazyInvoiceControls;

/** Options for {@link createLazyInvoice}. */
export interface LazyInvoiceOptions {
  /**
   * The properties to resolve lazily. Defaults to
   * {@link LAZY_INVOICE_PROPERTIES}.
   */
  lazyProperties?: readonly LazyInvoiceProperty[];
  /** Called whenever the loading state changes. */
  onLoadingStateChange?: LazyInvoiceStateListener;
}

/** Describe how an invoice's properties are split between eager and lazy. */
export interface LazyInvoiceLayout {
  /** The invoice identifier. */
  invoiceId: string;
  /** Properties read straight from the base record. */
  eager: string[];
  /** Properties resolved on demand. */
  lazy: string[];
}

/**
 * Describe how the properties of an invoice are split.
 *
 * @param invoice - The base invoice.
 * @param lazyProperties - The lazy property names.
 */
export function describeLazyInvoice(
  invoice: Invoice,
  lazyProperties: readonly LazyInvoiceProperty[] = LAZY_INVOICE_PROPERTIES
): LazyInvoiceLayout {
  const lazy = new Set<string>(lazyProperties);
  const eager = Object.keys(invoice).filter((key) => !lazy.has(key));
  return { invoiceId: invoice.id, eager, lazy: [...lazy] };
}

interface LazyInvoiceInternal {
  invoice: Invoice;
  base: Record<string, unknown>;
  eagerKeys: string[];
  lazyKeys: string[];
  values: Map<string, LazyValue<unknown>>;
  listeners: Set<LazyInvoiceStateListener>;
}

function computeState(internal: LazyInvoiceInternal): LazyInvoiceState {
  const loading: string[] = [];
  const loaded: string[] = [];
  const failed: string[] = [];

  for (const key of internal.lazyKeys) {
    const value = internal.values.get(key);
    if (!value) continue;
    if (value.state === "loading") loading.push(key);
    else if (value.state === "loaded") loaded.push(key);
    else if (value.state === "error") failed.push(key);
  }

  const state: LazyInvoiceState["state"] =
    failed.length > 0
      ? "error"
      : loading.length > 0
        ? "loading"
        : loaded.length > 0
          ? "loaded"
          : "idle";

  return { invoiceId: internal.invoice.id, state, loading, loaded, failed };
}

/**
 * Create an invoice whose heavy properties are resolved on demand.
 *
 * @param invoice - The base invoice. Its heavy properties are removed from
 *   the eagerly readable surface and served through {@link LazyValue}
 *   handles instead.
 * @param loader - Resolves a single lazy property.
 * @param options - Lazy property selection and state listeners.
 *
 * @example
 * ```ts
 * const loader = createInvoicePropertyLoader((id) => client.getInvoice(id));
 * const invoice = createLazyInvoice(base, loader);
 *
 * console.log(invoice.id, invoice.status);        // synchronous
 * const payments = await invoice.payments;        // fetched on demand
 * console.log(invoice.loadingState.state);        // "loaded"
 * ```
 */
export function createLazyInvoice(
  invoice: Invoice,
  loader: LazyInvoiceLoader,
  options: LazyInvoiceOptions = {}
): LazyInvoiceRecord {
  const lazyKeys = [...(options.lazyProperties ?? LAZY_INVOICE_PROPERTIES)];
  const lazySet = new Set<string>(lazyKeys);

  const base: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(invoice)) {
    if (!lazySet.has(key)) base[key] = value;
  }

  const internal: LazyInvoiceInternal = {
    invoice,
    base,
    eagerKeys: Object.keys(base),
    lazyKeys,
    values: new Map(),
    listeners: new Set(),
  };

  if (options.onLoadingStateChange) {
    internal.listeners.add(options.onLoadingStateChange);
  }

  const notify = (): void => {
    const state = computeState(internal);
    for (const listener of internal.listeners) {
      listener(state);
    }
  };

  const getValue = (property: string): LazyValue<unknown> => {
    const existing = internal.values.get(property);
    if (existing) return existing;

    const value = new LazyValue<unknown>(
      property,
      async () => loader(property as LazyInvoiceProperty, invoice),
      notify
    );
    internal.values.set(property, value);
    return value;
  };

  const handler: ProxyHandler<Record<string, unknown>> = {
    get(target, property, receiver) {
      if (typeof property === "symbol") {
        return Reflect.get(target, property, receiver);
      }
      // Never make the invoice itself look like a thenable.
      if (property === "then") {
        return undefined;
      }
      if (property === "loadingState") {
        return computeState(internal);
      }
      if (property === "isLoading") {
        return computeState(internal).state === "loading";
      }
      if (property === "lazyProperties") {
        return [...internal.lazyKeys];
      }
      if (property === "onLoadingStateChange") {
        return (listener: LazyInvoiceStateListener): (() => void) => {
          internal.listeners.add(listener);
          return () => {
            internal.listeners.delete(listener);
          };
        };
      }
      if (property === "preload") {
        return (target: LazyInvoiceProperty): Promise<unknown> =>
          getValue(target).load();
      }
      if (property === "resolve") {
        return async (): Promise<Invoice> => {
          await Promise.all(
            internal.lazyKeys.map((key) => getValue(key).load().catch(() => undefined))
          );
          const resolved: Record<string, unknown> = { ...internal.base };
          for (const key of internal.lazyKeys) {
            const value = internal.values.get(key);
            resolved[key] = value?.state === "loaded" ? value.value : undefined;
          }
          return resolved as unknown as Invoice;
        };
      }
      if (lazySet.has(property)) {
        return getValue(property);
      }
      return Reflect.get(target, property, receiver);
    },

    has(target, property) {
      if (typeof property === "symbol") return Reflect.has(target, property);
      return lazySet.has(property) || Reflect.has(target, property);
    },

    ownKeys(target) {
      const keys = new Set<string>([...internal.eagerKeys]);
      for (const key of internal.lazyKeys) {
        if (internal.values.get(key)?.state === "loaded") keys.add(key);
      }
      return [...keys];
    },

    getOwnPropertyDescriptor(target, property) {
      if (typeof property === "symbol") {
        return Reflect.getOwnPropertyDescriptor(target, property);
      }
      if (lazySet.has(property)) {
        const value = internal.values.get(property);
        if (value?.state !== "loaded") return undefined;
        return {
          value: value.value,
          enumerable: true,
          configurable: true,
          writable: true,
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  };

  return new Proxy(base, handler) as unknown as LazyInvoiceRecord;
}

/**
 * Create a list of lazy invoices that share one loader.
 *
 * @param invoices - The base invoices.
 * @param loader - Resolves a single lazy property.
 * @param options - Lazy property selection and state listeners.
 */
export function createLazyInvoices(
  invoices: readonly Invoice[],
  loader: LazyInvoiceLoader,
  options: LazyInvoiceOptions = {}
): LazyInvoiceRecord[] {
  return invoices.map((invoice) => createLazyInvoice(invoice, loader, options));
}

/**
 * Load every lazy property of an invoice and return a plain invoice.
 *
 * @param invoice - The lazy invoice to resolve.
 */
export async function resolveLazyInvoice(invoice: LazyInvoiceRecord): Promise<Invoice> {
  return await invoice.resolve();
}
