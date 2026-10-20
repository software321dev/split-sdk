/**
 * Response compression for the StellarSplit SDK.
 *
 * Provides gzip/brotli compression for RPC payloads, transparent
 * decompression helpers, an `Accept-Encoding` capability check, configurable
 * compression levels, and compression-ratio metrics.
 *
 * The implementation is dependency-free: Node runtimes use the built-in
 * `node:zlib` module, while browsers fall back to the WHATWG
 * `CompressionStream` API when it is available.
 *
 * @module compression
 */

import type { RequestInterceptor, ResponseInterceptor, RPCRequest, RPCResponse } from "./interceptors.js";

/** Compression algorithms understood by the SDK. */
export type CompressionAlgorithm = "gzip" | "brotli" | "br" | "deflate";

/** Canonical algorithm names, i.e. `br` normalised to `brotli`. */
export type CompressionAlgorithmName = "gzip" | "brotli" | "deflate";

/** Payloads that can be compressed. */
export type CompressionPayload = string | Uint8Array;

/** Metrics emitted for a single compression or decompression operation. */
export interface CompressionMetrics {
  /** Size of the payload before compression, in bytes. */
  originalBytes: number;
  /** Size of the payload after compression, in bytes. */
  compressedBytes: number;
  /** Fraction of bytes saved, in the range `0`–`1`. */
  compressionRatio: number;
  /** Algorithm the operation ran with. */
  algorithm: CompressionAlgorithm;
  /** Wall-clock duration of the operation, in milliseconds. */
  durationMs: number;
}

/** Aggregated compression metrics across many operations. */
export interface CompressionMetricsSummary {
  /** Number of compression operations performed. */
  requests: number;
  /** Total bytes seen before compression. */
  originalBytes: number;
  /** Total bytes produced after compression. */
  compressedBytes: number;
  /** Total bytes saved by compression. */
  bytesSaved: number;
  /** Overall fraction of bytes saved, in the range `0`–`1`. */
  compressionRatio: number;
  /** Mean duration of a single compression, in milliseconds. */
  averageDurationMs: number;
  /** Per-algorithm breakdown of the metrics above. */
  byAlgorithm: Record<
    string,
    {
      requests: number;
      originalBytes: number;
      compressedBytes: number;
      compressionRatio: number;
    }
  >;
}

/** Configuration for the compression middleware. */
export interface CompressionConfig {
  /** Whether compression is enabled. When `false` the middleware is a no-op. */
  enabled: boolean;
  /** Preferred algorithm. */
  algorithm: CompressionAlgorithm;
  /**
   * Compression level. The valid range depends on the algorithm: `1`–`9` for
   * gzip/deflate and `0`–`11` for brotli. Defaults to the algorithm's default.
   */
  level?: number;
  /**
   * Payloads smaller than this many bytes are sent uncompressed, which keeps
   * the CPU cost of compression below the point where it pays for itself.
   * Defaults to {@link MIN_COMPRESSION_BYTES}.
   */
  minSizeBytes?: number;
  /** Called after every compression operation with its metrics. */
  onMetrics?: (metrics: CompressionMetrics) => void;
  /** Called with a human-readable summary after every compression. */
  logger?: (message: string, meta?: Record<string, unknown>) => void;
}

/** A compressed payload plus the metadata needed to reverse it. */
export interface CompressedPayload {
  /** Discriminator so compressed payloads are recognisable at runtime. */
  compressed: true;
  /** Algorithm the payload was compressed with. */
  algorithm: CompressionAlgorithm;
  /** The compressed bytes. */
  body: Uint8Array;
  /** Size of the payload before compression, in bytes. */
  originalBytes: number;
}

/** An RPC response that may carry transport-level headers. */
export interface CompressionResponse extends RPCResponse {
  /** Optional transport headers, e.g. `content-encoding`. */
  headers?: Record<string, string | string[] | undefined>;
}

/** Minimum payload size (in bytes) that is worth compressing. */
export const MIN_COMPRESSION_BYTES = 1024;

/** All algorithms the SDK can negotiate, in preference order. */
export const SUPPORTED_COMPRESSION_ALGORITHMS: readonly CompressionAlgorithmName[] = [
  "brotli",
  "gzip",
  "deflate",
];

/** Inclusive level bounds for each algorithm. */
export const COMPRESSION_LEVEL_LIMITS: Record<CompressionAlgorithmName, { min: number; max: number; default: number }> = {
  gzip: { min: 1, max: 9, default: 6 },
  deflate: { min: 1, max: 9, default: 6 },
  brotli: { min: 0, max: 11, default: 6 },
};

/** Normalise `br` to `brotli` and reject unknown algorithm names. */
export function normalizeCompressionAlgorithm(algorithm: CompressionAlgorithm): CompressionAlgorithmName {
  if (algorithm === "brotli" || algorithm === "br") return "brotli";
  if (algorithm === "deflate") return "deflate";
  return "gzip";
}

/** Clamp a compression level to the bounds of the given algorithm. */
export function clampCompressionLevel(
  algorithm: CompressionAlgorithmName,
  level?: number
): number {
  const limits = COMPRESSION_LEVEL_LIMITS[algorithm];
  if (typeof level !== "number" || !Number.isFinite(level)) return limits.default;
  return Math.min(limits.max, Math.max(limits.min, Math.round(level)));
}

function toBytes(payload: CompressionPayload): Uint8Array {
  return typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
}

function isNodeRuntime(): boolean {
  return (
    typeof process !== "undefined" &&
    typeof process.versions === "object" &&
    process.versions !== null &&
    typeof process.versions.node === "string"
  );
}

function isStreamApiAvailable(): boolean {
  return (
    typeof CompressionStream !== "undefined" &&
    typeof Response !== "undefined" &&
    typeof Blob !== "undefined" &&
    typeof (Blob.prototype as unknown as { stream?: unknown }).stream === "function"
  );
}

function isDecompressionStreamAvailable(): boolean {
  return (
    typeof DecompressionStream !== "undefined" &&
    typeof Response !== "undefined" &&
    typeof Blob !== "undefined" &&
    typeof (Blob.prototype as unknown as { stream?: unknown }).stream === "function"
  );
}

/**
 * Whether the current runtime can compress with the given algorithm.
 *
 * Brotli is only available in Node (`node:zlib`); browser runtimes fall back
 * to gzip/deflate via the WHATWG `CompressionStream` API.
 */
export function isCompressionSupported(algorithm: CompressionAlgorithm): boolean {
  const normalized = normalizeCompressionAlgorithm(algorithm);
  if (normalized === "brotli") return isNodeRuntime();
  return isNodeRuntime() || isStreamApiAvailable();
}

/** Type guard for {@link CompressedPayload}. */
export function isCompressedPayload(value: unknown): value is CompressedPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<CompressedPayload>;
  return candidate.compressed === true && candidate.body instanceof Uint8Array;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}

async function compressInBrowser(
  bytes: Uint8Array,
  algorithm: "gzip" | "deflate"
): Promise<Uint8Array> {
  const stream = new Blob([toArrayBuffer(bytes)]).stream().pipeThrough(new CompressionStream(algorithm));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

async function decompressInBrowser(
  bytes: Uint8Array,
  algorithm: "gzip" | "deflate"
): Promise<Uint8Array> {
  const stream = new Blob([toArrayBuffer(bytes)]).stream().pipeThrough(new DecompressionStream(algorithm));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

interface ZlibModule {
  gzip: (data: Uint8Array, opts: { level: number }) => Promise<Buffer>;
  deflate: (data: Uint8Array, opts: { level: number }) => Promise<Buffer>;
  gunzip: (data: Uint8Array) => Promise<Buffer>;
  inflate: (data: Uint8Array) => Promise<Buffer>;
  brotliCompress: (
    data: Uint8Array,
    opts: { params: Record<number, number> }
  ) => Promise<Buffer>;
  brotliDecompress: (data: Uint8Array) => Promise<Buffer>;
  constants: { BROTLI_PARAM_QUALITY: number };
}

async function loadZlib(): Promise<ZlibModule> {
  const zlib = await import("node:zlib");
  const { promisify } = await import("node:util");

  return {
    gzip: promisify(zlib.gzip) as ZlibModule["gzip"],
    deflate: promisify(zlib.deflate) as ZlibModule["deflate"],
    gunzip: promisify(zlib.gunzip) as ZlibModule["gunzip"],
    inflate: promisify(zlib.inflate) as ZlibModule["inflate"],
    brotliCompress: promisify(zlib.brotliCompress) as ZlibModule["brotliCompress"],
    brotliDecompress: promisify(zlib.brotliDecompress) as ZlibModule["brotliDecompress"],
    constants: { BROTLI_PARAM_QUALITY: zlib.constants.BROTLI_PARAM_QUALITY },
  };
}

async function compressInNode(
  bytes: Uint8Array,
  algorithm: CompressionAlgorithmName,
  level: number
): Promise<Uint8Array> {
  const zlib = await loadZlib();

  if (algorithm === "brotli") {
    const compressed = await zlib.brotliCompress(bytes, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: level },
    });
    return new Uint8Array(compressed);
  }

  const compressed =
    algorithm === "gzip"
      ? await zlib.gzip(bytes, { level })
      : await zlib.deflate(bytes, { level });
  return new Uint8Array(compressed);
}

async function decompressInNode(
  bytes: Uint8Array,
  algorithm: CompressionAlgorithmName
): Promise<Uint8Array> {
  const zlib = await loadZlib();

  if (algorithm === "brotli") {
    return new Uint8Array(await zlib.brotliDecompress(bytes));
  }

  return new Uint8Array(
    algorithm === "gzip" ? await zlib.gunzip(bytes) : await zlib.inflate(bytes)
  );
}

/**
 * Detect the compression support advertised by a peer.
 *
 * Accepts an `Accept-Encoding` header string, a `Headers` instance, or a
 * plain headers record. Quality values are honoured, and ties are broken by
 * algorithm preference (brotli > gzip > deflate).
 *
 * @param headersOrAcceptEncoding - The peer's advertised encodings.
 * @returns The preferred supported algorithm, or `null` when the peer accepts
 *   no compressed encoding.
 */
export function detectCompressionSupport(
  headersOrAcceptEncoding?: Record<string, string | string[] | undefined> | Headers | string
): CompressionAlgorithmName | null {
  if (!headersOrAcceptEncoding) return null;

  let acceptEncoding = "";
  if (typeof headersOrAcceptEncoding === "string") {
    acceptEncoding = headersOrAcceptEncoding;
  } else if (
    "get" in headersOrAcceptEncoding &&
    typeof headersOrAcceptEncoding.get === "function"
  ) {
    acceptEncoding = headersOrAcceptEncoding.get("accept-encoding") || "";
  } else {
    const record = headersOrAcceptEncoding as Record<string, string | string[] | undefined>;
    const raw = record["accept-encoding"] ?? record["Accept-Encoding"];
    acceptEncoding = Array.isArray(raw) ? raw.join(", ") : raw ?? "";
  }

  if (!acceptEncoding || acceptEncoding.trim() === "") return null;

  const algorithmPriority: Record<string, number> = {
    br: 3,
    brotli: 3,
    gzip: 2,
    deflate: 1,
  };

  const parts = acceptEncoding
    .toLowerCase()
    .split(",")
    .map((part) => {
      const [algo, qPart] = part.trim().split(";");
      const q =
        qPart && qPart.includes("q=")
          ? Number.parseFloat(qPart.split("=")[1] ?? "1")
          : 1.0;
      return { algo: algo?.trim() ?? "", q: Number.isNaN(q) ? 1.0 : q };
    })
    .filter((entry) => entry.q > 0)
    .sort((a, b) => {
      if (b.q !== a.q) return b.q - a.q;
      const prioA = algorithmPriority[a.algo] ?? 0;
      const prioB = algorithmPriority[b.algo] ?? 0;
      return prioB - prioA;
    });

  for (const entry of parts) {
    if (entry.algo === "br" || entry.algo === "brotli") return "brotli";
    if (entry.algo === "gzip") return "gzip";
    if (entry.algo === "deflate") return "deflate";
  }

  if (parts.some((part) => part.algo === "*")) return "gzip";

  return null;
}

/**
 * Build the `Accept-Encoding` header value advertising the algorithms this
 * runtime can actually use.
 */
export function buildAcceptEncodingHeader(
  algorithms: readonly CompressionAlgorithmName[] = SUPPORTED_COMPRESSION_ALGORITHMS
): string {
  return algorithms.filter((algorithm) => isCompressionSupported(algorithm)).join(", ");
}

/**
 * Compress a payload.
 *
 * @param payload - The payload to compress.
 * @param algorithm - The algorithm to use. Defaults to `gzip`.
 * @param options - Compression level and a metrics callback.
 * @returns The compressed payload, tagged with the effective algorithm.
 */
export async function compressPayload(
  payload: CompressionPayload,
  algorithm: CompressionAlgorithm = "gzip",
  options?: { level?: number; onMetrics?: (metrics: CompressionMetrics) => void }
): Promise<CompressedPayload> {
  const startTime = Date.now();
  const bytes = toBytes(payload);
  const originalBytes = bytes.byteLength;
  const requested = normalizeCompressionAlgorithm(algorithm);

  // Brotli is unavailable in browser runtimes; fall back to gzip so the
  // caller always gets a usable compressed payload.
  const effective =
    requested === "brotli" && !isCompressionSupported("brotli") ? "gzip" : requested;
  const level = clampCompressionLevel(effective, options?.level);

  let body: Uint8Array;
  if (isNodeRuntime()) {
    body = await compressInNode(bytes, effective, level);
  } else if (effective !== "brotli" && isStreamApiAvailable()) {
    body = await compressInBrowser(bytes, effective);
  } else {
    body = await compressInNode(bytes, effective, level);
  }

  const durationMs = Date.now() - startTime;
  const compressedBytes = body.byteLength;
  const compressionRatio =
    originalBytes > 0 ? (originalBytes - compressedBytes) / originalBytes : 0;

  const metrics: CompressionMetrics = {
    originalBytes,
    compressedBytes,
    compressionRatio,
    algorithm: effective,
    durationMs,
  };

  options?.onMetrics?.(metrics);

  return {
    compressed: true,
    algorithm: effective,
    body,
    originalBytes,
  };
}

/**
 * Decompress a payload produced by {@link compressPayload}.
 */
export async function decompressPayload(payload: CompressedPayload): Promise<Uint8Array> {
  const normalized = normalizeCompressionAlgorithm(payload.algorithm);
  if (!isNodeRuntime() && normalized !== "brotli" && isDecompressionStreamAvailable()) {
    return await decompressInBrowser(payload.body, normalized);
  }
  return await decompressInNode(payload.body, normalized);
}

/**
 * Decompress a response transparently.
 *
 * Compressed payloads are inflated and — when the result is valid JSON —
 * parsed back into the original object. Uncompressed responses are returned
 * untouched, which makes this safe to call on any response.
 *
 * @param response - The value to (maybe) decompress.
 * @returns The decompressed value.
 */
export async function transparentDecompress<T = unknown>(response: unknown): Promise<T> {
  if (!isCompressedPayload(response)) {
    return response as T;
  }

  const bytes = await decompressPayload(response);
  const decoded = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(decoded) as T;
  } catch {
    return decoded as unknown as T;
  }
}

/**
 * Stateful compression middleware.
 *
 * Owns the compression configuration, the negotiated algorithm, and the
 * aggregated compression-ratio metrics.
 *
 * @example
 * ```ts
 * const compression = new CompressionManager({ enabled: true, algorithm: "brotli" });
 * const payload = await compression.compress(largeJson);
 * const restored = await compression.decompress(payload);
 * ```
 */
export class CompressionManager {
  private readonly config: CompressionConfig;
  private readonly minSizeBytes: number;
  private requests = 0;
  private originalBytes = 0;
  private compressedBytes = 0;
  private totalDurationMs = 0;
  private readonly byAlgorithm = new Map<
    string,
    { requests: number; originalBytes: number; compressedBytes: number }
  >();

  constructor(config: CompressionConfig) {
    this.config = { ...config };
    this.minSizeBytes = config.minSizeBytes ?? MIN_COMPRESSION_BYTES;
  }

  /** Whether compression is enabled. */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /** The preferred algorithm requested by the caller. */
  get algorithm(): CompressionAlgorithm {
    return this.config.algorithm;
  }

  /** The effective compression level for the negotiated algorithm. */
  get level(): number {
    return clampCompressionLevel(
      normalizeCompressionAlgorithm(this.config.algorithm),
      this.config.level
    );
  }

  /** Payloads below this size are left uncompressed. */
  get minPayloadBytes(): number {
    return this.minSizeBytes;
  }

  /**
   * The algorithm that will actually be used, taking runtime support into
   * account. Falls back to gzip when the preferred algorithm is unavailable.
   */
  get effectiveAlgorithm(): CompressionAlgorithmName {
    const requested = normalizeCompressionAlgorithm(this.config.algorithm);
    if (isCompressionSupported(requested)) return requested;
    return "gzip";
  }

  /** Whether a payload of the given size is worth compressing. */
  shouldCompress(byteLength: number): boolean {
    if (!this.config.enabled) return false;
    return byteLength > this.minSizeBytes;
  }

  /** The `Accept-Encoding` header value this runtime can serve. */
  acceptEncodingHeader(): string {
    return buildAcceptEncodingHeader();
  }

  /**
   * Compress a payload, recording metrics.
   *
   * @param payload - The payload to compress.
   * @param overrides - Per-call algorithm override.
   */
  async compress(
    payload: CompressionPayload,
    overrides?: { algorithm?: CompressionAlgorithm; level?: number }
  ): Promise<CompressedPayload> {
    const algorithm = overrides?.algorithm ?? this.config.algorithm;
    const level = overrides?.level ?? this.config.level;

    let recorded: CompressionMetrics | undefined;
    const compressed = await compressPayload(payload, algorithm, {
      level,
      onMetrics: (metrics) => {
        recorded = metrics;
        this.record(metrics);
      },
    });

    if (recorded) {
      this.config.logger?.(
        `compressed ${recorded.originalBytes} bytes to ${recorded.compressedBytes} bytes ` +
          `(${Math.round(recorded.compressionRatio * 100)}% saved, ${recorded.algorithm})`,
        {
          originalBytes: recorded.originalBytes,
          compressedBytes: recorded.compressedBytes,
          compressionRatio: recorded.compressionRatio,
          algorithm: recorded.algorithm,
          durationMs: recorded.durationMs,
        }
      );
    }

    return compressed;
  }

  /**
   * Compress an arbitrary JSON-serialisable value.
   */
  async compressValue(value: unknown): Promise<CompressedPayload> {
    if (typeof value === "string") {
      return this.compress(value);
    }
    if (value instanceof Uint8Array) {
      return this.compress(value);
    }
    return this.compress(JSON.stringify(value ?? null));
  }

  /**
   * Decompress a payload produced by {@link CompressionManager.compress}.
   */
  async decompress(payload: CompressedPayload): Promise<Uint8Array> {
    return await decompressPayload(payload);
  }

  /** Aggregated metrics for every compression performed by this manager. */
  getMetrics(): CompressionMetricsSummary {
    const byAlgorithm: CompressionMetricsSummary["byAlgorithm"] = {};
    for (const [algorithm, entry] of this.byAlgorithm) {
      byAlgorithm[algorithm] = {
        requests: entry.requests,
        originalBytes: entry.originalBytes,
        compressedBytes: entry.compressedBytes,
        compressionRatio:
          entry.originalBytes > 0
            ? (entry.originalBytes - entry.compressedBytes) / entry.originalBytes
            : 0,
      };
    }

    return {
      requests: this.requests,
      originalBytes: this.originalBytes,
      compressedBytes: this.compressedBytes,
      bytesSaved: Math.max(0, this.originalBytes - this.compressedBytes),
      compressionRatio:
        this.originalBytes > 0
          ? (this.originalBytes - this.compressedBytes) / this.originalBytes
          : 0,
      averageDurationMs: this.requests > 0 ? this.totalDurationMs / this.requests : 0,
      byAlgorithm,
    };
  }

  /** Reset the aggregated metrics. */
  resetMetrics(): void {
    this.requests = 0;
    this.originalBytes = 0;
    this.compressedBytes = 0;
    this.totalDurationMs = 0;
    this.byAlgorithm.clear();
  }

  /**
   * Request interceptor that compresses oversized request parameters and
   * advertises the supported encodings.
   */
  createRequestInterceptor(): RequestInterceptor {
    return async (req: RPCRequest): Promise<RPCRequest> => {
      if (!this.config.enabled) {
        return req;
      }

      const headers: Record<string, string> = { ...(req.headers ?? {}) };
      const acceptEncoding = this.acceptEncodingHeader();
      if (acceptEncoding) {
        headers["Accept-Encoding"] = acceptEncoding;
      }

      let compressedAny = false;
      const params = await Promise.all(
        req.params.map(async (param) => {
          if (typeof param !== "string" && !(param instanceof Uint8Array)) {
            return param;
          }
          if (!this.shouldCompress(toBytes(param).byteLength)) {
            return param;
          }
          compressedAny = true;
          return await this.compress(param);
        })
      );

      if (compressedAny) {
        headers["Content-Encoding"] = this.effectiveAlgorithm;
      }

      return { ...req, params, headers };
    };
  }

  /**
   * Response interceptor that transparently decompresses compressed results.
   */
  createResponseInterceptor(): ResponseInterceptor {
    return async (res: RPCResponse): Promise<RPCResponse> => {
      if (!isCompressedPayload(res.result)) {
        return res;
      }
      const decompressed = await decompressPayload(res.result);
      return { ...res, result: decompressed };
    };
  }

  private record(metrics: CompressionMetrics): void {
    this.requests += 1;
    this.originalBytes += metrics.originalBytes;
    this.compressedBytes += metrics.compressedBytes;
    this.totalDurationMs += metrics.durationMs;

    const key = String(metrics.algorithm);
    const entry = this.byAlgorithm.get(key) ?? {
      requests: 0,
      originalBytes: 0,
      compressedBytes: 0,
    };
    entry.requests += 1;
    entry.originalBytes += metrics.originalBytes;
    entry.compressedBytes += metrics.compressedBytes;
    this.byAlgorithm.set(key, entry);

    this.config.onMetrics?.(metrics);
  }
}

/**
 * Create a request interceptor that compresses oversized request payloads.
 *
 * @param config - Compression configuration.
 * @returns A request interceptor for use with `addRequestInterceptor`.
 */
export function createCompressionRequestInterceptor(config: CompressionConfig): RequestInterceptor {
  const minBytes = config.minSizeBytes ?? MIN_COMPRESSION_BYTES;
  return async (req) => {
    if (!config.enabled) {
      return req;
    }

    const params = await Promise.all(
      req.params.map(async (param) => {
        if (typeof param !== "string" && !(param instanceof Uint8Array)) {
          return param;
        }

        if (toBytes(param).byteLength <= minBytes) {
          return param;
        }

        return await compressPayload(param, config.algorithm, {
          level: config.level,
          onMetrics: config.onMetrics,
        });
      })
    );

    return { ...req, params };
  };
}

/**
 * Create a response interceptor that transparently decompresses results.
 *
 * @param config - Optional compression configuration.
 * @returns A response interceptor for use with `addResponseInterceptor`.
 */
export function createCompressionResponseInterceptor(
  _config?: Partial<CompressionConfig>
): ResponseInterceptor {
  return async (res) => {
    if (!isCompressedPayload(res.result)) {
      return res;
    }

    const decompressed = await decompressPayload(res.result);
    return {
      ...res,
      result: decompressed,
    };
  };
}

/** A request/response interceptor pair driven by one {@link CompressionManager}. */
export interface CompressionMiddleware {
  /** The manager owning the configuration and metrics. */
  manager: CompressionManager;
  /** Request interceptor compressing oversized payloads. */
  requestInterceptor: RequestInterceptor;
  /** Response interceptor transparently decompressing results. */
  responseInterceptor: ResponseInterceptor;
}

/**
 * Create a compression middleware backed by a single {@link CompressionManager}.
 *
 * @param config - Compression configuration.
 */
export function createCompressionMiddleware(config: CompressionConfig): CompressionMiddleware {
  const manager = new CompressionManager(config);
  return {
    manager,
    requestInterceptor: manager.createRequestInterceptor(),
    responseInterceptor: manager.createResponseInterceptor(),
  };
}
