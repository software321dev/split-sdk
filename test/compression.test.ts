import { describe, expect, it, vi } from "vitest";
import {
  COMPRESSION_LEVEL_LIMITS,
  CompressionManager,
  MIN_COMPRESSION_BYTES,
  SUPPORTED_COMPRESSION_ALGORITHMS,
  buildAcceptEncodingHeader,
  clampCompressionLevel,
  compressPayload,
  createCompressionMiddleware,
  createCompressionRequestInterceptor,
  createCompressionResponseInterceptor,
  decompressPayload,
  detectCompressionSupport,
  isCompressedPayload,
  isCompressionSupported,
  normalizeCompressionAlgorithm,
  transparentDecompress,
  type CompressionMetrics,
} from "../src/compression.js";

function buildLargePayload(repeats = 400): string {
  return JSON.stringify({
    invoices: Array.from({ length: repeats }, (_, i) => ({
      id: `inv_${i}`,
      creator: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
      token: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      status: "Pending",
      funded: 1_000_000n.toString(),
      memo: "StellarSplit invoice line item for the shared workshop rental",
      tags: ["workshop", "shared-cost"],
    })),
  });
}

describe("compression middleware", () => {
  it("compresses payloads smaller than the original and decompresses them", async () => {
    const original = "invoice-response:".repeat(200);
    const compressed = await compressPayload(original, "gzip");
    const decompressed = await decompressPayload(compressed);
    const decoded = new TextDecoder().decode(decompressed);

    expect(compressed.body.byteLength).toBeLessThan(new TextEncoder().encode(original).byteLength);
    expect(decoded).toBe(original);
  });

  it("leaves small request bodies unchanged and compresses bodies over 1KB when enabled", async () => {
    const interceptor = createCompressionRequestInterceptor({
      enabled: true,
      algorithm: "gzip",
    });
    const large = "x".repeat(2_048);

    const smallResult = await interceptor({ method: "test", params: ["small"] });
    const largeResult = await interceptor({ method: "test", params: [large] });

    expect(smallResult.params[0]).toBe("small");
    expect(largeResult.params[0]).toMatchObject({ compressed: true, algorithm: "gzip" });
  });
});

describe("compression algorithms", () => {
  it("normalises algorithm aliases", () => {
    expect(normalizeCompressionAlgorithm("br")).toBe("brotli");
    expect(normalizeCompressionAlgorithm("brotli")).toBe("brotli");
    expect(normalizeCompressionAlgorithm("gzip")).toBe("gzip");
    expect(normalizeCompressionAlgorithm("deflate")).toBe("deflate");
  });

  it("supports both gzip and brotli in this runtime", () => {
    expect(isCompressionSupported("gzip")).toBe(true);
    expect(isCompressionSupported("brotli")).toBe(true);
    expect(SUPPORTED_COMPRESSION_ALGORITHMS).toContain("gzip");
    expect(SUPPORTED_COMPRESSION_ALGORITHMS).toContain("brotli");
  });

  it("round-trips payloads through gzip and brotli", async () => {
    const original = buildLargePayload();

    for (const algorithm of ["gzip", "brotli"] as const) {
      const compressed = await compressPayload(original, algorithm);
      expect(compressed.algorithm).toBe(algorithm);
      expect(isCompressedPayload(compressed)).toBe(true);

      const restored = new TextDecoder().decode(await decompressPayload(compressed));
      expect(restored).toBe(original);
    }
  });

  it("compresses a large payload by more than 60%", async () => {
    const original = buildLargePayload();
    const originalBytes = new TextEncoder().encode(original).byteLength;

    for (const algorithm of ["gzip", "brotli"] as const) {
      const metrics: CompressionMetrics[] = [];
      const compressed = await compressPayload(original, algorithm, {
        onMetrics: (m) => metrics.push(m),
      });

      expect(metrics).toHaveLength(1);
      expect(compressed.body.byteLength).toBeLessThan(originalBytes * 0.4);
      expect(metrics[0]!.compressionRatio).toBeGreaterThan(0.6);
      expect(metrics[0]!.originalBytes).toBe(originalBytes);
      expect(metrics[0]!.compressedBytes).toBe(compressed.body.byteLength);
    }
  });

  it("honours the configured compression level", async () => {
    const original = buildLargePayload(200);

    const fast = await compressPayload(original, "gzip", { level: 1 });
    const tight = await compressPayload(original, "gzip", { level: 9 });

    expect(tight.body.byteLength).toBeLessThanOrEqual(fast.body.byteLength);
  });

  it("clamps out-of-range compression levels", () => {
    expect(clampCompressionLevel("gzip", 0)).toBe(COMPRESSION_LEVEL_LIMITS.gzip.min);
    expect(clampCompressionLevel("gzip", 99)).toBe(COMPRESSION_LEVEL_LIMITS.gzip.max);
    expect(clampCompressionLevel("brotli", 99)).toBe(COMPRESSION_LEVEL_LIMITS.brotli.max);
    expect(clampCompressionLevel("gzip", undefined)).toBe(COMPRESSION_LEVEL_LIMITS.gzip.default);
  });
});

describe("compression capability detection", () => {
  it("detects compression support from Accept-Encoding headers correctly", () => {
    expect(detectCompressionSupport("gzip, deflate, br")).toBe("brotli");
    expect(detectCompressionSupport("gzip, deflate")).toBe("gzip");
    expect(detectCompressionSupport("deflate")).toBe("deflate");
    expect(detectCompressionSupport("identity")).toBeNull();
    expect(detectCompressionSupport(undefined)).toBeNull();
    expect(detectCompressionSupport("")).toBeNull();
  });

  it("respects q-values when selecting an algorithm", () => {
    expect(detectCompressionSupport("gzip;q=1.0, br;q=0.5")).toBe("gzip");
    expect(detectCompressionSupport("gzip;q=0.5, br;q=0.9")).toBe("brotli");
    expect(detectCompressionSupport("gzip;q=0, br;q=0")).toBeNull();
  });

  it("reads Accept-Encoding from Headers objects and header records", () => {
    const headers = new Headers();
    headers.set("accept-encoding", "gzip, deflate");
    expect(detectCompressionSupport(headers)).toBe("gzip");

    expect(detectCompressionSupport({ "accept-encoding": "br" })).toBe("brotli");
    expect(detectCompressionSupport({ "Accept-Encoding": "gzip" })).toBe("gzip");
    expect(detectCompressionSupport({ "accept-encoding": ["br", "gzip"] })).toBe("brotli");
  });

  it("treats a wildcard as gzip support", () => {
    expect(detectCompressionSupport("*")).toBe("gzip");
  });

  it("advertises the encodings this runtime supports", () => {
    const header = buildAcceptEncodingHeader();
    expect(header).toContain("gzip");
    expect(header).toContain("br");
    expect(detectCompressionSupport(header)).toBe("brotli");
  });
});

describe("transparent decompression", () => {
  it("decompresses JSON responses transparently", async () => {
    const original = {
      invoices: [
        { id: "1", amount: 100 },
        { id: "2", amount: 200 },
      ],
      total: 300,
    };
    const compressed = await compressPayload(JSON.stringify(original), "gzip");

    const result = await transparentDecompress<typeof original>(compressed);
    expect(result).toEqual(original);
  });

  it("returns uncompressed values unchanged", async () => {
    const original = { invoices: [] };
    expect(await transparentDecompress(original)).toEqual(original);
    expect(await transparentDecompress("plain string")).toBe("plain string");
    expect(await transparentDecompress(null)).toBeNull();
  });

  it("decompresses non-JSON payloads into text", async () => {
    const compressed = await compressPayload("not json at all", "gzip");
    expect(await transparentDecompress(compressed)).toBe("not json at all");
  });

  it("decompresses response interceptor results", async () => {
    const originalText = "hello world compressed test";
    const compressed = await compressPayload(originalText, "gzip");

    const interceptor = createCompressionResponseInterceptor();
    const res = await interceptor({ method: "test", result: compressed, durationMs: 1 });

    expect(res.result instanceof Uint8Array).toBe(true);
    expect(new TextDecoder().decode(res.result as Uint8Array)).toBe(originalText);
  });

  it("leaves uncompressed response interceptor results untouched", async () => {
    const interceptor = createCompressionResponseInterceptor();
    const res = await interceptor({ method: "test", result: { ok: true }, durationMs: 1 });
    expect(res.result).toEqual({ ok: true });
  });
});

describe("CompressionManager", () => {
  it("compresses and decompresses transparently", async () => {
    const manager = new CompressionManager({ enabled: true, algorithm: "brotli" });
    const original = buildLargePayload();

    const compressed = await manager.compress(original);
    expect(compressed.algorithm).toBe("brotli");

    const restored = new TextDecoder().decode(await manager.decompress(compressed));
    expect(restored).toBe(original);
  });

  it("compresses JSON values of any shape", async () => {
    const manager = new CompressionManager({ enabled: true, algorithm: "gzip" });
    const value = { invoices: [{ id: "1" }], nested: { deep: { deeper: [1, 2, 3] } } };

    const compressed = await manager.compressValue(value);
    expect(await transparentDecompress(compressed)).toEqual(value);
  });

  it("records compression ratio metrics", async () => {
    const onMetrics = vi.fn();
    const logger = vi.fn();
    const manager = new CompressionManager({
      enabled: true,
      algorithm: "gzip",
      onMetrics,
      logger,
    });

    const original = buildLargePayload();
    await manager.compress(original);
    await manager.compress(original);

    expect(onMetrics).toHaveBeenCalledTimes(2);

    const metrics = manager.getMetrics();
    expect(metrics.requests).toBe(2);
    expect(metrics.originalBytes).toBeGreaterThan(0);
    expect(metrics.compressedBytes).toBeGreaterThan(0);
    expect(metrics.bytesSaved).toBe(metrics.originalBytes - metrics.compressedBytes);
    expect(metrics.compressionRatio).toBeGreaterThan(0.6);
    expect(metrics.averageDurationMs).toBeGreaterThanOrEqual(0);
    expect(metrics.byAlgorithm.gzip?.requests).toBe(2);

    expect(logger).toHaveBeenCalledTimes(2);
    expect(String(logger.mock.calls[0]?.[0])).toMatch(/%/);

    manager.resetMetrics();
    expect(manager.getMetrics().requests).toBe(0);
  });

  it("skips compression for payloads below the minimum size", async () => {
    const onMetrics = vi.fn();
    const manager = new CompressionManager({
      enabled: true,
      algorithm: "gzip",
      minSizeBytes: 1024,
      onMetrics,
    });

    expect(manager.shouldCompress(MIN_COMPRESSION_BYTES)).toBe(false);
    expect(manager.shouldCompress(MIN_COMPRESSION_BYTES + 1)).toBe(true);
  });

  it("advertises supported encodings and compresses oversized request params", async () => {
    const manager = new CompressionManager({ enabled: true, algorithm: "gzip" });
    const interceptor = manager.createRequestInterceptor();

    const res = await interceptor({
      method: "test",
      params: ["small", "x".repeat(4096)],
    });

    expect(res.headers?.["Accept-Encoding"]).toContain("gzip");
    expect(res.headers?.["Content-Encoding"]).toBe("gzip");
    expect(res.params[0]).toBe("small");
    expect(isCompressedPayload(res.params[1])).toBe(true);
  });

  it("falls back to a pass-through when compression is disabled", async () => {
    const manager = new CompressionManager({ enabled: false, algorithm: "gzip" });
    const interceptor = manager.createRequestInterceptor();

    const res = await interceptor({ method: "test", params: ["x".repeat(4096)] });

    expect(res.params[0]).toBe("x".repeat(4096));
    expect(res.headers).toBeUndefined();
    expect(manager.shouldCompress(10_000)).toBe(false);
  });

  it("produces a middleware pair sharing one manager", async () => {
    const { manager, requestInterceptor, responseInterceptor } = createCompressionMiddleware({
      enabled: true,
      algorithm: "gzip",
    });

    const req = await requestInterceptor({ method: "test", params: ["y".repeat(4096)] });
    expect(isCompressedPayload(req.params[0])).toBe(true);

    const res = await responseInterceptor({
      method: "test",
      result: req.params[0],
      durationMs: 1,
    });
    expect(new TextDecoder().decode(res.result as Uint8Array)).toBe("y".repeat(4096));
    expect(manager.getMetrics().requests).toBe(1);
  });
});
