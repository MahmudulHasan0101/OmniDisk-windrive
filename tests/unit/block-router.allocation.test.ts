import { describe, it, expect } from "vitest";
import {
  planBlocks,
  prepareBlocks,
  planAllocation,
  allocationsToBlocks,
  resolveLogicalBlockSize,
  type PreparedBlock,
} from "../../server/core/block-router.js";
import { MockProviderAccount } from "../helpers/mock-provider-account.js";

/** Builds prepared blocks of a fixed stored size without real compression. */
function fakeBlocks(count: number, storedSize: number, logicalSize = storedSize): PreparedBlock[] {
  return Array.from({ length: count }, (_, i) => ({
    blockIndex: i,
    logicalStart: i * logicalSize,
    logicalLength: logicalSize,
    data: Buffer.alloc(storedSize, i % 256),
    storedSize,
    compressionUsed: "none" as const,
  }));
}

describe("planBlocks", () => {
  it("splits a file into fixed-size blocks with a short final block", () => {
    const plan = planBlocks(250, 100);
    expect(plan).toHaveLength(3);
    expect(plan.map((b) => b.logicalLength)).toEqual([100, 100, 50]);
    expect(plan.map((b) => b.logicalStart)).toEqual([0, 100, 200]);
  });

  it("produces exactly one block when the file divides evenly", () => {
    expect(planBlocks(100, 100)).toHaveLength(1);
  });

  it("gives a zero-byte file one empty block so it can still reach 'complete'", () => {
    const plan = planBlocks(0, 100);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.logicalLength).toBe(0);
  });
});

describe("resolveLogicalBlockSize", () => {
  it("keeps the requested size when no account caps object size", () => {
    const accounts = [new MockProviderAccount({ providerName: "drive", freeSpace: 1000 })];
    expect(resolveLogicalBlockSize(4 * 1024 * 1024, accounts)).toBe(4 * 1024 * 1024);
  });

  it("shrinks below the smallest per-object cap among candidate accounts", () => {
    // This is the Supabase 50MB case: the old allocator split an oversized
    // allocation per-account, the block model prevents oversized blocks
    // existing in the first place.
    const capped = new MockProviderAccount({ providerName: "supabase", freeSpace: 1e9 });
    capped.maxSingleObjectBytes = 50 * 1000 * 1000;
    const uncapped = new MockProviderAccount({ providerName: "drive", freeSpace: 1e9 });

    const size = resolveLogicalBlockSize(64 * 1024 * 1024, [capped, uncapped]);
    expect(size).toBeLessThanOrEqual(50 * 1000 * 1000);
    // Power of two, so block boundaries stay aligned.
    expect(Math.log2(size) % 1).toBe(0);
  });
});

describe("planAllocation — block-granular overflow fill", () => {
  it("places everything on the first account when it has room", async () => {
    const accounts = [
      new MockProviderAccount({ providerName: "drive", freeSpace: 100 }),
      new MockProviderAccount({ providerName: "onedrive", freeSpace: 100 }),
    ];

    const result = await planAllocation(accounts, fakeBlocks(4, 10));

    expect(result.success).toBe(true);
    expect(result.unplacedBytes).toBe(0);
    expect(result.allocations).toHaveLength(4);
    expect(result.allocations.every((a) => a.account === accounts[0])).toBe(true);
  });

  it("spills across accounts in ranked order once each is full", async () => {
    const accounts = [
      new MockProviderAccount({ providerName: "drive", freeSpace: 30 }),
      new MockProviderAccount({ providerName: "onedrive", freeSpace: 20 }),
      new MockProviderAccount({ providerName: "dropbox", freeSpace: 40 }),
      new MockProviderAccount({ providerName: "box", freeSpace: 100 }),
    ];

    // 7 blocks x 10 bytes = 70: drive takes 3, onedrive 2, dropbox 2.
    const result = await planAllocation(accounts, fakeBlocks(7, 10));

    expect(result.success).toBe(true);
    const names = result.allocations.map((a) => a.account.identity.providerName);
    expect(names).toEqual([
      "drive", "drive", "drive",
      "onedrive", "onedrive",
      "dropbox", "dropbox",
    ]);
    // Blocks stay in order and keep their original indices.
    expect(result.allocations.map((a) => a.blockIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // box was never needed, though it was the largest.
    expect(result.accountsTried.map((a) => a.providerName)).not.toContain("box");
  });

  it("leaves a sub-block remainder of free space unused rather than splitting a block", async () => {
    // 25 bytes free, 10-byte blocks: 2 blocks fit, the last 5 bytes are wasted.
    // That waste is the deliberate cost of making blocks indivisible.
    const small = new MockProviderAccount({ providerName: "drive", freeSpace: 25 });
    const big = new MockProviderAccount({ providerName: "box", freeSpace: 1000 });

    const result = await planAllocation([small, big], fakeBlocks(4, 10));

    expect(result.success).toBe(true);
    const onSmall = result.allocations.filter((a) => a.account === small);
    expect(onSmall).toHaveLength(2);
    expect(result.allocations.filter((a) => a.account === big)).toHaveLength(2);
  });

  it("aborts before any network call when total space is insufficient", async () => {
    const accounts = [
      new MockProviderAccount({ providerName: "drive", freeSpace: 20 }),
      new MockProviderAccount({ providerName: "onedrive", freeSpace: 10 }),
    ];

    const result = await planAllocation(accounts, fakeBlocks(5, 10));

    expect(result.success).toBe(false);
    expect(result.unplacedBytes).toBe(20); // 2 of 5 blocks unplaced
    expect(result.accountsTried).toHaveLength(2);
    // Nothing was stored — planning is a pure pass.
    expect(accounts.every((a) => a.storeCallCount === 0)).toBe(true);
  });

  it("skips a capacity-exhausted account entirely", async () => {
    const accounts = [
      new MockProviderAccount({ providerName: "full", freeSpace: 0 }),
      new MockProviderAccount({ providerName: "drive", freeSpace: 100 }),
    ];

    const result = await planAllocation(accounts, fakeBlocks(3, 10));

    expect(result.success).toBe(true);
    expect(
      result.allocations.every((a) => a.account.identity.providerName === "drive"),
    ).toBe(true);
  });

  it("refuses to place a block larger than an account's per-object cap", async () => {
    const capped = new MockProviderAccount({ providerName: "supabase", freeSpace: 1000 });
    capped.maxSingleObjectBytes = 5; // smaller than our 10-byte blocks
    const normal = new MockProviderAccount({ providerName: "drive", freeSpace: 1000 });

    const result = await planAllocation([capped, normal], fakeBlocks(2, 10));

    expect(result.success).toBe(true);
    expect(
      result.allocations.every((a) => a.account.identity.providerName === "drive"),
    ).toBe(true);
  });
});

describe("allocationsToBlocks", () => {
  it("builds stable, collision-free remote paths keyed by block index", async () => {
    const accounts = [new MockProviderAccount({ providerName: "drive", freeSpace: 1000 })];
    const result = await planAllocation(accounts, fakeBlocks(3, 10));
    const blocks = allocationsToBlocks("file-1", result.allocations);

    expect(blocks.map((b) => b.remotePath)).toEqual([
      "file-1/b0",
      "file-1/b1",
      "file-1/b2",
    ]);
    expect(new Set(blocks.map((b) => b.blockId)).size).toBe(3);
    expect(blocks.every((b) => b.status === "pending")).toBe(true);
  });
});

describe("prepareBlocks", () => {
  it("stores incompressible blocks raw rather than growing them", async () => {
    // Random bytes don't compress; compressBlock should fall back to "none".
    const random = Buffer.from(
      Array.from({ length: 4096 }, () => Math.floor(Math.random() * 256)),
    );
    const plan = planBlocks(random.length, 4096);
    const prepared = await prepareBlocks(random, plan, "gzip");

    expect(prepared[0]!.compressionUsed).toBe("none");
    expect(prepared[0]!.storedSize).toBe(random.length);
  });

  it("compresses a compressible block and records the algorithm used", async () => {
    const repetitive = Buffer.alloc(4096, 65);
    const plan = planBlocks(repetitive.length, 4096);
    const prepared = await prepareBlocks(repetitive, plan, "gzip");

    expect(prepared[0]!.compressionUsed).toBe("gzip");
    expect(prepared[0]!.storedSize).toBeLessThan(repetitive.length);
  });

  it("mixes per-block algorithms within one file", async () => {
    // First half compressible, second half not — the case whole-stream
    // compression could not handle selectively.
    const compressible = Buffer.alloc(4096, 65);
    const random = Buffer.from(
      Array.from({ length: 4096 }, () => Math.floor(Math.random() * 256)),
    );
    const file = Buffer.concat([compressible, random]);
    const prepared = await prepareBlocks(file, planBlocks(file.length, 4096), "gzip");

    expect(prepared.map((b) => b.compressionUsed)).toEqual(["gzip", "none"]);
  });
});
