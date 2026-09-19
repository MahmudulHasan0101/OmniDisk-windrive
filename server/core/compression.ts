import { gzip, gunzip, brotliCompress, brotliDecompress } from "node:zlib";
import { promisify } from "node:util";
import type { CompressionAlgo } from "./models.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const brotliCompressAsync = promisify(brotliCompress);
const brotliDecompressAsync = promisify(brotliDecompress);

/**
 * @mongodb-js/zstd is a native binding and an optional dependency (see
 * server/package.json). It's loaded lazily so the rest of the server
 * works even on platforms where the native build is unavailable — in
 * that case, requesting "zstd" throws a clear, actionable error instead
 * of crashing at import time.
 */
async function loadZstd(): Promise<{
  compress: (input: Buffer, level?: number) => Promise<Buffer>;
  decompress: (input: Buffer) => Promise<Buffer>;
}> {
  try {
    const mod = await import("@mongodb-js/zstd");
    return mod;
  } catch (err) {
    throw new Error(
      "zstd compression requested but @mongodb-js/zstd native binding is not available " +
        "on this platform. Choose a different compression algorithm, or install the " +
        "package for a supported OS/arch. Original error: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

const ZSTD_DEFAULT_LEVEL = 3; // best speed/ratio tradeoff at low levels, per spec section 3

export async function compress(
  data: Buffer,
  algo: CompressionAlgo,
): Promise<Buffer> {
  switch (algo) {
    case "none":
      return data;
    case "gzip":
      return gzipAsync(data);
    case "brotli":
      return brotliCompressAsync(data);
    case "zstd": {
      const zstd = await loadZstd();
      return zstd.compress(data, ZSTD_DEFAULT_LEVEL);
    }
  }
}

export async function decompress(
  data: Buffer,
  algo: CompressionAlgo,
): Promise<Buffer> {
  switch (algo) {
    case "none":
      return data;
    case "gzip":
      return gunzipAsync(data);
    case "brotli":
      return brotliDecompressAsync(data);
    case "zstd": {
      const zstd = await loadZstd();
      return zstd.decompress(data);
    }
  }
}

/**
 * Compression ratio below which a block is stored raw instead. If compressing
 * saves less than 5%, the CPU cost on every future read isn't worth it — and
 * for already-compressed data (video, JPEG, zip) the output is often *larger*
 * than the input, so storing raw is strictly better.
 */
const INCOMPRESSIBLE_RATIO_THRESHOLD = 0.95;

/**
 * Compresses one block, falling back to raw storage when compression doesn't pay.
 *
 * This per-block decision is something whole-stream compression could not do
 * selectively: a single file with a compressible header and an incompressible
 * video payload now stores each part the cheaper way.
 *
 * Returns the algorithm ACTUALLY used, which the caller must persist on the
 * block — decompression reads that field, not the file's default.
 */
export async function compressBlock(
  data: Buffer,
  algo: CompressionAlgo,
): Promise<{ data: Buffer; algoUsed: CompressionAlgo }> {
  if (algo === "none") return { data, algoUsed: "none" };

  const out = await compress(data, algo);
  if (out.length >= data.length * INCOMPRESSIBLE_RATIO_THRESHOLD) {
    return { data, algoUsed: "none" };
  }
  return { data: out, algoUsed: algo };
}
