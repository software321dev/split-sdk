import { describe, expect, it, vi } from "vitest";
import {
  EAGER_INVOICE_PROPERTIES,
  LAZY_INVOICE_PROPERTIES,
  LazyValue,
  createInvoicePropertyLoader,
  createLazyInvoice,
  createLazyInvoices,
  createLocalPropertyLoader,
  describeLazyInvoice,
  resolveLazyInvoice,
  toLazyPropertyError,
  type LazyInvoiceLoader,
  type LazyInvoiceRecord,
} from "../src/invoice/lazyInvoice.js";
import { LazyPropertyLoadError, isLazyPropertyLoadError } from "../src/errors.js";
import type { Invoice, Payment, Recipient, TransitionRecord } from "../src/types.js";

const CREATOR = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const PAYER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function makePayments(count: number): Payment[] {
  return Array.from({ length: count }, (_, i) => ({
    payer: PAYER,
    amount: BigInt(1000 + i),
    timestamp: 1_700_000_000 + i,
  }));
}

function makeRecipients(count: number): Recipient[] {
  return Array.from({ length: count }, (_, i) => ({
    address: PAYER,
    amount: BigInt(i + 1),
  }));
}

function makeBaseInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "42",
    creator: CREATOR,
    recipients: makeRecipients(2),
    token: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    deadline: 1_800_000_000,
    createdAt: 1_700_000_000,
    funded: 5_000n,
    status: "Pending",
    payments: makePayments(3),
    memo: "shared workshop",
    tags: ["workshop"],
    ...overrides,
  };
}

describe("lazy invoice property layout", () => {
  it("classifies the heavy properties as lazy", () => {
    expect(LAZY_INVOICE_PROPERTIES).toContain("payments");
    expect(LAZY_INVOICE_PROPERTIES).toContain("recipients");
    expect(LAZY_INVOICE_PROPERTIES).toContain("statusHistory");
    expect(LAZY_INVOICE_PROPERTIES).toContain("prerequisites");
  });

  it("classifies the list-view properties as eager", () => {
    expect(EAGER_INVOICE_PROPERTIES).toContain("id");
    expect(EAGER_INVOICE_PROPERTIES).toContain("status");
    expect(EAGER_INVOICE_PROPERTIES).toContain("funded");
    expect(EAGER_INVOICE_PROPERTIES).not.toContain("payments");
  });

  it("describes how an invoice is split", () => {
    const layout = describeLazyInvoice(makeBaseInvoice());

    expect(layout.invoiceId).toBe("42");
    expect(layout.lazy).toContain("payments");
    expect(layout.eager).toContain("id");
    expect(layout.eager).toContain("status");
    expect(layout.eager).not.toContain("payments");
  });
});

describe("eager property access", () => {
  it("reads eager properties synchronously without touching the loader", () => {
    const loader = vi.fn(async () => undefined);
    const invoice = createLazyInvoice(makeBaseInvoice(), loader as unknown as LazyInvoiceLoader);

    expect(invoice.id).toBe("42");
    expect(invoice.status).toBe("Pending");
    expect(invoice.funded).toBe(5_000n);
    expect(invoice.creator).toBe(CREATOR);
    expect(invoice.memo).toBe("shared workshop");
    expect(loader).not.toHaveBeenCalled();
  });

  it("does not delay eager property access", () => {
    const loader = vi.fn(async () => undefined);
    const invoice = createLazyInvoice(makeBaseInvoice(), loader as unknown as LazyInvoiceLoader);

    const start = Date.now();
    for (let i = 0; i < 10_000; i += 1) {
      void invoice.id;
      void invoice.status;
    }
    expect(Date.now() - start).toBeLessThan(500);
    expect(loader).not.toHaveBeenCalled();
  });
});

describe("lazy property access", () => {
  it("resolves a lazy property on demand", async () => {
    const invoice = createLazyInvoice(
      makeBaseInvoice(),
      createLocalPropertyLoader(makeBaseInvoice())
    );

    const payments = await invoice.payments;
    expect(payments).toHaveLength(3);
    expect(payments[0]!.amount).toBe(1_000n);
  });

  it("does not load anything until a lazy property is touched", async () => {
    const loader = vi.fn(async () => []);
    const invoice = createLazyInvoice(makeBaseInvoice(), loader as unknown as LazyInvoiceLoader);

    expect(loader).not.toHaveBeenCalled();
    expect(invoice.loadingState.state).toBe("idle");
  });

  it("memoises the loaded value so the loader runs once", async () => {
    const loader = vi.fn(async (property: string) =>
      property === "payments" ? makePayments(2) : []
    );
    const invoice = createLazyInvoice(makeBaseInvoice(), loader as unknown as LazyInvoiceLoader);

    const first = await invoice.payments;
    const second = await invoice.payments;
    const third = await invoice.payments;

    expect(loader).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it("shares a single in-flight request between concurrent accesses", async () => {
    let calls = 0;
    const loader = vi.fn(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return makePayments(1);
    });
    const invoice = createLazyInvoice(makeBaseInvoice(), loader as unknown as LazyInvoiceLoader);

    const [a, b, c] = await Promise.all([
      invoice.payments,
      invoice.payments,
      invoice.payments,
    ]);

    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("keeps different properties independent", async () => {
    const loader = vi.fn(async (property: string) =>
      property === "payments" ? makePayments(4) : makeRecipients(9)
    );
    const invoice = createLazyInvoice(makeBaseInvoice(), loader as unknown as LazyInvoiceLoader);

    const payments = await invoice.payments;
    const recipients = await invoice.recipients;

    expect(payments).toHaveLength(4);
    expect(recipients).toHaveLength(9);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe("loading state indicators", () => {
  it("reports idle, loading and loaded states", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const invoice = createLazyInvoice(
      makeBaseInvoice(),
      async () => {
        await gate;
        return makePayments(1);
      }
    );

    expect(invoice.loadingState.state).toBe("idle");
    expect(invoice.isLoading).toBe(false);

    const pending = invoice.payments.load();
    expect(invoice.loadingState.state).toBe("loading");
    expect(invoice.isLoading).toBe(true);
    expect(invoice.loadingState.loading).toContain("payments");

    release?.();
    await pending;

    expect(invoice.loadingState.state).toBe("loaded");
    expect(invoice.isLoading).toBe(false);
    expect(invoice.loadingState.loaded).toContain("payments");
    expect(invoice.loadingState.failed).toHaveLength(0);
  });

  it("notifies subscribers when the state changes", async () => {
    const states: string[] = [];
    const invoice = createLazyInvoice(
      makeBaseInvoice(),
      async () => makePayments(1),
      { onLoadingStateChange: (state) => states.push(state.state) }
    );

    await invoice.payments;

    expect(states).toContain("loading");
    expect(states).toContain("loaded");
  });

  it("supports subscribing and unsubscribing", async () => {
    const listener = vi.fn();
    const invoice = createLazyInvoice(makeBaseInvoice(), async () => makePayments(1));

    const unsubscribe = invoice.onLoadingStateChange(listener);
    await invoice.payments;
    expect(listener).toHaveBeenCalled();

    unsubscribe();
    listener.mockClear();
    await invoice.recipients;
    expect(listener).not.toHaveBeenCalled();
  });

  it("lists the lazy properties it exposes", () => {
    const invoice = createLazyInvoice(makeBaseInvoice(), async () => []);
    expect(invoice.lazyProperties).toEqual([...LAZY_INVOICE_PROPERTIES]);
  });

  it("preloads a property without awaiting it", async () => {
    const loader = vi.fn(async () => makePayments(1));
    const invoice = createLazyInvoice(makeBaseInvoice(), loader as unknown as LazyInvoiceLoader);

    const pending = invoice.preload("payments");
    expect(loader).toHaveBeenCalledTimes(1);
    await pending;
    expect(invoice.loadingState.loaded).toContain("payments");
  });
});

describe("loading error handling", () => {
  it("surfaces a typed SDK error when the load fails", async () => {
    const invoice = createLazyInvoice(
      makeBaseInvoice(),
      async () => {
        throw new Error("rpc unavailable");
      }
    );

    await expect(invoice.payments).rejects.toBeInstanceOf(LazyPropertyLoadError);
    await expect(invoice.payments).rejects.toThrow(/rpc unavailable/);
  });

  it("records the failure on the lazy value", async () => {
    const invoice = createLazyInvoice(
      makeBaseInvoice(),
      async () => {
        throw new Error("boom");
      }
    );

    await expect(invoice.payments).rejects.toThrow(LazyPropertyLoadError);

    expect(invoice.payments.state).toBe("error");
    expect(invoice.payments.error).toBeInstanceOf(LazyPropertyLoadError);
    expect(invoice.payments.isFailed).toBe(true);
    expect(invoice.loadingState.state).toBe("error");
    expect(invoice.loadingState.failed).toContain("payments");
  });

  it("does not produce an unhandled rejection when nobody awaits the load", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const invoice = createLazyInvoice(
        makeBaseInvoice(),
        async () => {
          throw new Error("silent failure");
        }
      );

      void invoice.payments.load();
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toHaveLength(0);
  });

  it("keeps working after a failed load", async () => {
    let shouldFail = true;
    const invoice = createLazyInvoice(makeBaseInvoice(), async (property) => {
      if (shouldFail) throw new Error("transient");
      return property === "recipients" ? makeRecipients(2) : makePayments(1);
    });

    await expect(invoice.payments).rejects.toThrow(LazyPropertyLoadError);

    shouldFail = false;
    const recipients = await invoice.recipients;
    expect(recipients).toHaveLength(2);
  });

  it("converts arbitrary failures into a typed error", () => {
    const error = toLazyPropertyError(new Error("nope"), "payments");
    expect(error).toBeInstanceOf(LazyPropertyLoadError);
    expect(isLazyPropertyLoadError(error)).toBe(true);
    expect(error.property).toBe("payments");
    expect(error.cause).toBe("nope");
  });
});

describe("resolving a lazy invoice", () => {
  it("resolves every lazy property into a plain invoice", async () => {
    const invoice = createLazyInvoice(
      makeBaseInvoice(),
      createLocalPropertyLoader(makeBaseInvoice())
    );

    const resolved = await invoice.resolve();

    expect(resolved.id).toBe("42");
    expect(resolved.payments).toHaveLength(3);
    expect(resolved.recipients).toHaveLength(2);
    expect(resolved.status).toBe("Pending");
  });

  it("resolves a lazy invoice through the standalone helper", async () => {
    const invoice = createLazyInvoice(
      makeBaseInvoice(),
      createLocalPropertyLoader(makeBaseInvoice())
    );

    const resolved = await resolveLazyInvoice(invoice);
    expect(resolved.payments).toHaveLength(3);
  });

  it("keeps a failed property undefined in the resolved invoice", async () => {
    const invoice = createLazyInvoice(
      makeBaseInvoice(),
      async (property) => {
        if (property === "payments") throw new Error("nope");
        return [];
      }
    );

    const resolved = await invoice.resolve();
    expect(resolved.payments).toBeUndefined();
    expect(resolved.recipients).toEqual([]);
  });
});

describe("loaders", () => {
  it("builds a loader that fetches the invoice and extracts the property", async () => {
    const full = makeBaseInvoice({ statusHistory: [{ from: "Pending", to: "Released", at: 1 }] });
    const fetchInvoice = vi.fn(async () => full);
    const loader = createInvoicePropertyLoader(fetchInvoice);

    const invoice = createLazyInvoice(makeBaseInvoice(), loader);
    const history = await invoice.statusHistory;

    expect(fetchInvoice).toHaveBeenCalledWith("42");
    expect(history).toHaveLength(1);
  });

  it("serves properties from an already fetched invoice", async () => {
    const source = makeBaseInvoice();
    const loader = createLocalPropertyLoader(source);
    const invoice = createLazyInvoice(makeBaseInvoice(), loader);

    const recipients = await invoice.recipients;
    expect(recipients).toHaveLength(2);
  });
});

describe("memory behaviour for large invoice lists", () => {
  it("does not load any property for a large list until it is used", () => {
    const loader = vi.fn(async () => []);
    const invoices = Array.from({ length: 1_000 }, (_, i) =>
      createLazyInvoice(makeBaseInvoice({ id: String(i) }), loader as unknown as LazyInvoiceLoader)
    );

    expect(loader).not.toHaveBeenCalled();
    expect(invoices).toHaveLength(1_000);
    expect(invoices[999]!.id).toBe("999");
  });

  it("loads only the properties that are actually used", async () => {
    const loader = vi.fn(async (property: string) =>
      property === "payments" ? makePayments(2) : []
    );
    const invoices = createLazyInvoices(
      Array.from({ length: 50 }, (_, i) => makeBaseInvoice({ id: String(i) })),
      loader as unknown as LazyInvoiceLoader
    );

    await invoices[0]!.payments;

    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader.mock.calls[0]![0]).toBe("payments");
  });
});

describe("LazyValue", () => {
  it("exposes the state and the resolved value", async () => {
    const value = new LazyValue("payments", async () => makePayments(1));

    expect(value.state).toBe("idle");
    expect(value.value).toBeUndefined();
    expect(value.isLoaded).toBe(false);

    const resolved = await value.load();

    expect(resolved).toHaveLength(1);
    expect(value.state).toBe("loaded");
    expect(value.isLoaded).toBe(true);
    expect(value.value).toHaveLength(1);
    expect(value.property).toBe("payments");
  });

  it("loads at most once", async () => {
    const loader = vi.fn(async () => makePayments(1));
    const value = new LazyValue("payments", loader);

    await value.load();
    await value.load();

    expect(loader).toHaveBeenCalledTimes(1);
  });
});

describe("lazy invoice transparency", () => {
  it("behaves like a plain invoice for eager properties", () => {
    const invoice: LazyInvoiceRecord = createLazyInvoice(
      makeBaseInvoice(),
      async () => []
    );

    expect("id" in invoice).toBe(true);
    expect("payments" in invoice).toBe(true);
    expect(invoice.id).toBe("42");
  });

  it("does not look like a promise when awaited as a whole", async () => {
    const invoice = createLazyInvoice(makeBaseInvoice(), async () => []);
    expect((invoice as unknown as { then?: unknown }).then).toBeUndefined();
    await expect(Promise.resolve(invoice)).resolves.toBeDefined();
  });

  it("exposes loaded lazy properties as own enumerable properties", async () => {
    const invoice = createLazyInvoice(
      makeBaseInvoice(),
      createLocalPropertyLoader(makeBaseInvoice())
    );

    expect(Object.keys(invoice)).not.toContain("payments");
    await invoice.payments;
    expect(Object.keys(invoice)).toContain("payments");
  });
});

describe("status history typing", () => {
  it("resolves a status history array", async () => {
    const history: TransitionRecord[] = [
      { from: "Pending", to: "Released", at: 1_700_000_500 },
    ];
    const invoice = createLazyInvoice(
      makeBaseInvoice({ statusHistory: history }),
      createLocalPropertyLoader(makeBaseInvoice({ statusHistory: history }))
    );

    const resolved = await invoice.statusHistory;
    expect(resolved).toHaveLength(1);
    expect(resolved![0]!.to).toBe("Released");
  });
});
