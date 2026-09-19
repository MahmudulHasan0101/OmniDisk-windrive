import { describe, it, expect, beforeEach } from "vitest";
import {
  planBlocks,
  prepareBlocks,
  planAllocation,
  allocationsToBlocks,
  storeBlocks,
  readRange,
  retrieveBlocksInOrder,
} from "../../server/core/block-router.js";
import { MockProviderAccount } from "../helpers/mock-provider-account.js";
import type { FileBlock } from "../../server/core/models.js";

const BLOCK_SIZE = 1024;
const FILE_SIZE = BLOCK_SIZE * 4 + 300; // 5 blocks, last one short

/** Deterministic, compressible-but-varied content so slices are checkable. */
function makeContent(size: number): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = i % 251;
  return buf;
}

describe("readRange — random access", () => {
  let content: Buffer;
  let blocks: FileBlock[];
  let accounts: MockProviderAccount[];

  const resolve = (providerName: string, accountIndex: number) => {
    const found = accounts.find(
      (a) =>
        a.identity.providerName === providerName &&
        a.identity.accountIndex === accountIndex,
    );
    if (!found) throw new Error(`No account ${providerName}:${accountIndex}`);
    return found;
  };

  beforeEach(async () => {
    content = makeContent(FILE_SIZE);
    accounts = [
      new MockProviderAccount({ providerName: "drive", freeSpace: 2048 }),
      new MockProviderAccount({ providerName: "box", freeSpace: 1_000_000 }),
    ];

    const plan = planBlocks(FILE_SIZE, BLOCK_SIZE);
    const prepared = await prepareBlocks(content, plan, "gzip");
    const allocation = await planAllocation(accounts, prepared);
    blocks = allocationsToBlocks("file-1", allocation.allocations);

    const byIndex = new Map(prepared.map((b) => [b.blockIndex, b.data]));
    await storeBlocks(allocation.allocations, blocks, async (i) => byIndex.get(i)!);
  });

  it("reads a range that sits entirely inside one block", async () => {
    const out = await readRange(blocks, BLOCK_SIZE, FILE_SIZE, 100, 50, resolve);
    expect(out).toEqual(content.subarray(100, 150));
  });

  it("reads a range starting mid-block and spanning into the next", async () => {
    const out = await readRange(blocks, BLOCK_SIZE, FILE_SIZE, 900, 300, resolve);
    expect(out).toEqual(content.subarray(900, 1200));
  });

  it("reads a range spanning many blocks", async () => {
    const out = await readRange(blocks, BLOCK_SIZE, FILE_SIZE, 500, 3000, resolve);
    expect(out).toEqual(content.subarray(500, 3500));
  });

  it("reads the first byte and the last byte", async () => {
    const first = await readRange(blocks, BLOCK_SIZE, FILE_SIZE, 0, 1, resolve);
    expect(first).toEqual(content.subarray(0, 1));

    const last = await readRange(blocks, BLOCK_SIZE, FILE_SIZE, FILE_SIZE - 1, 1, resolve);
    expect(last).toEqual(content.subarray(FILE_SIZE - 1));
  });

  it("reads the short final block correctly", async () => {
    const out = await readRange(blocks, BLOCK_SIZE, FILE_SIZE, 4096, 300, resolve);
    expect(out).toEqual(content.subarray(4096, 4396));
    expect(out).toHaveLength(300);
  });

  it("clamps a read that runs past EOF instead of erroring", async () => {
    const out = await readRange(blocks, BLOCK_SIZE, FILE_SIZE, FILE_SIZE - 100, 5000, resolve);
    expect(out).toHaveLength(100);
    expect(out).toEqual(content.subarray(FILE_SIZE - 100));
  });

  it("returns empty for a read at or past EOF", async () => {
    const out = await readRange(blocks, BLOCK_SIZE, FILE_SIZE, FILE_SIZE, 10, resolve);
    expect(out).toHaveLength(0);
  });

  it("fetches ONLY the blocks the range needs", async () => {
    // The whole point of block addressing: a small read at a large offset
    // must not pull the entire file. Under the old whole-stream design this
    // would have required every fragment.
    accounts.forEach((a) => (a.retrieveCallCount = 0));
    await readRange(blocks, BLOCK_SIZE, FILE_SIZE, 2100, 50, resolve);

    const totalFetches = accounts.reduce((sum, a) => sum + a.retrieveCallCount, 0);
    expect(totalFetches).toBe(1);
  });

  it("uses the cache on a repeat read and skips the network entirely", async () => {
    const cache = new Map<string, Buffer>();
    const opts = {
      getCached: async (b: FileBlock) => cache.get(b.blockId) ?? null,
      putCached: async (b: FileBlock, d: Buffer) => void cache.set(b.blockId, d),
    };

    await readRange(blocks, BLOCK_SIZE, FILE_SIZE, 0, 100, resolve, opts);
    accounts.forEach((a) => (a.retrieveCallCount = 0));

    const out = await readRange(blocks, BLOCK_SIZE, FILE_SIZE, 10, 50, resolve, opts);
    expect(out).toEqual(content.subarray(10, 60));
    expect(accounts.reduce((sum, a) => sum + a.retrieveCallCount, 0)).toBe(0);
  });

  it("refuses to read a range covering a failed block rather than serving garbage", async () => {
    const broken = blocks.map((b) =>
      b.blockIndex === 1 ? { ...b, status: "failed" as const } : b,
    );
    await expect(
      readRange(broken, BLOCK_SIZE, FILE_SIZE, 1000, 200, resolve),
    ).rejects.toThrow(/not stored/i);
  });
});

describe("retrieveBlocksInOrder — full download", () => {
  it("reassembles the original bytes across mixed compression and accounts", async () => {
    const content = makeContent(FILE_SIZE);
    const accounts = [
      new MockProviderAccount({ providerName: "drive", freeSpace: 2048 }),
      new MockProviderAccount({ providerName: "box", freeSpace: 1_000_000 }),
    ];
    const resolve = (providerName: string, accountIndex: number) =>
      accounts.find(
        (a) =>
          a.identity.providerName === providerName &&
          a.identity.accountIndex === accountIndex,
      )!;

    const plan = planBlocks(FILE_SIZE, BLOCK_SIZE);
    const prepared = await prepareBlocks(content, plan, "gzip");
    const allocation = await planAllocation(accounts, prepared);
    const blocks = allocationsToBlocks("file-1", allocation.allocations);
    const byIndex = new Map(prepared.map((b) => [b.blockIndex, b.data]));
    await storeBlocks(allocation.allocations, blocks, async (i) => byIndex.get(i)!);

    // Blocks genuinely landed on more than one account.
    expect(new Set(blocks.map((b) => b.providerName)).size).toBeGreaterThan(1);

    const chunks: Buffer[] = new Array(blocks.length);
    await retrieveBlocksInOrder(blocks, resolve, (chunk, block) => {
      chunks[block.blockIndex] = chunk;
    });

    expect(Buffer.concat(chunks)).toEqual(content);
  });
});
