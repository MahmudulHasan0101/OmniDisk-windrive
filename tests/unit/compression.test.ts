import { describe, it, expect } from "vitest";
import { compress, compressBlock, decompress } from "../../server/core/compression.js";
import type { CompressionAlgo } from "../../server/core/models.js";

const sample = Buffer.from(
  "OmniDisk fragments this text across many provider accounts. ".repeat(200),
  "utf-8",
);

describe("compression roundtrip", () => {
  it.each<CompressionAlgo>(["none", "gzip", "brotli"])(
    "compress -> decompress is byte-for-byte identity for %s",
    async (algo) => {
      const compressed = await compress(sample, algo);
      const decompressed = await decompress(compressed, algo);
      expect(Buffer.compare(decompressed, sample)).toBe(0);
    },
  );

  it("gzip and brotli actually shrink repetitive input", async () => {
    const gzipped = await compress(sample, "gzip");
    const brotlied = await compress(sample, "brotli");
    expect(gzipped.length).toBeLessThan(sample.length);
    expect(brotlied.length).toBeLessThan(sample.length);
  });

  // zstd depends on the optional native binding (@mongodb-js/zstd). Skipped
  // automatically in environments where it isn't installed/buildable,
  // rather than failing CI on unrelated platforms.
  it("compress -> decompress is byte-for-byte identity for zstd (if available)", async () => {
    try {
      const compressed = await compress(sample, "zstd");
      const decompressed = await decompress(compressed, "zstd");
      expect(Buffer.compare(decompressed, sample)).toBe(0);
    } catch (err) {
      expect((err as Error).message).toMatch(/zstd/i);
    }
  });
});

describe("compressBlock — per-block algorithm decision", () => {
  it("compresses a compressible block and reports the algorithm used", async () => {
    const repetitive = Buffer.alloc(8192, 65);
    const { data, algoUsed } = await compressBlock(repetitive, "gzip");
    expect(algoUsed).toBe("gzip");
    expect(data.length).toBeLessThan(repetitive.length);
  });

  it("falls back to raw storage for incompressible data", async () => {
    // Already-compressed content (video, JPEG, zip) typically grows under
    // compression. Storing it raw saves CPU on every future read and avoids
    // spending more quota than the original bytes would.
    const random = Buffer.from(
      Array.from({ length: 8192 }, () => Math.floor(Math.random() * 256)),
    );
    const { data, algoUsed } = await compressBlock(random, "gzip");
    expect(algoUsed).toBe("none");
    expect(data.length).toBe(random.length);
  });

  it("round-trips through the algorithm it actually chose, not the one requested", async () => {
    const random = Buffer.from(
      Array.from({ length: 4096 }, () => Math.floor(Math.random() * 256)),
    );
    const { data, algoUsed } = await compressBlock(random, "gzip");
    // Decompressing with the REQUESTED algo would fail here; using the
    // recorded one is why FileBlock carries its own compressionUsed.
    const out = await decompress(data, algoUsed);
    expect(Buffer.compare(out, random)).toBe(0);
  });

  it("passes through untouched when asked for none", async () => {
    const sample = Buffer.alloc(100, 1);
    const { data, algoUsed } = await compressBlock(sample, "none");
    expect(algoUsed).toBe("none");
    expect(data).toBe(sample);
  });
});
