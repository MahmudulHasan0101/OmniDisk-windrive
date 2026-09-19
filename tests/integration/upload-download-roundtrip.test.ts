import { describe, it, expect } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import {
  planBlocks,
  prepareBlocks,
  planAllocation,
  allocationsToBlocks,
  storeBlocks,
  retrieveBlocksInOrder,
  readRange,
  resolveLogicalBlockSize,
  verifyIntegrity,
} from "../../server/core/block-router.js";
import { PriorityManager } from "../../server/core/priority-manager.js";
import { AccountRegistry } from "../../server/core/account-registry.js";
import { MockProviderAccount } from "../helpers/mock-provider-account.js";

const BLOCK_SIZE = 64 * 1024;

describe("Integration: full upload -> block -> store -> retrieve -> download cycle", () => {
  it("reconstructs the original file byte-for-byte, split across 3 mock accounts", async () => {
    // A file too large for any single account's free space, so it must spill
    // across three — the scenario the whole project exists for.
    const original = randomBytes(300_000);
    const sha256Original = createHash("sha256").update(original).digest("hex");

    const registry = new AccountRegistry();
    const accounts = [
      new MockProviderAccount({ providerName: "drive", freeSpace: 120_000, speedBps: 5000 }),
      new MockProviderAccount({ providerName: "onedrive", freeSpace: 120_000, speedBps: 4000 }),
      new MockProviderAccount({ providerName: "dropbox", freeSpace: 120_000, speedBps: 3000 }),
    ];
    for (const account of accounts) registry.register(account);

    const priorityManager = new PriorityManager(registry.all(), "speed");
    await priorityManager.refreshAll();
    const ranked = priorityManager.getRankedAccounts();

    // --- Upload pipeline ---
    const blockSize = resolveLogicalBlockSize(BLOCK_SIZE, ranked);
    const plan = planBlocks(original.length, blockSize);
    const prepared = await prepareBlocks(original, plan, "gzip");

    const allocation = await planAllocation(ranked, prepared);
    expect(allocation.success).toBe(true);

    const fileUuid = "test-file-uuid";
    const blocks = allocationsToBlocks(fileUuid, allocation.allocations);
    // Blocks genuinely spread across more than one account.
    expect(new Set(blocks.map((b) => b.providerName)).size).toBeGreaterThanOrEqual(2);

    const byIndex = new Map(prepared.map((b) => [b.blockIndex, b.data]));
    const storeResult = await storeBlocks(
      allocation.allocations,
      blocks,
      async (i) => byIndex.get(i)!,
    );
    expect(storeResult.allStored).toBe(true);
    expect(storeResult.successfullyStoredSize).toBe(original.length);

    // --- Download pipeline ---
    const chunks: Buffer[] = new Array(blocks.length);
    await retrieveBlocksInOrder(
      storeResult.blocks,
      (providerName, accountIndex) => registry.resolve(providerName, accountIndex),
      (chunk, block) => {
        chunks[block.blockIndex] = chunk;
      },
    );

    const reassembled = Buffer.concat(chunks);
    expect(Buffer.compare(reassembled, original)).toBe(0);
    expect(verifyIntegrity(reassembled, sha256Original)).toBe(true);
  });

  it("serves a random byte range from the middle without fetching the whole file", async () => {
    // The capability the block redesign exists for: reaching an arbitrary
    // offset used to require downloading and decompressing from byte 0.
    const original = randomBytes(300_000);

    const registry = new AccountRegistry();
    const accounts = [
      new MockProviderAccount({ providerName: "drive", freeSpace: 150_000 }),
      new MockProviderAccount({ providerName: "box", freeSpace: 500_000 }),
    ];
    for (const account of accounts) registry.register(account);

    const plan = planBlocks(original.length, BLOCK_SIZE);
    const prepared = await prepareBlocks(original, plan, "gzip");
    const allocation = await planAllocation(registry.all(), prepared);
    const blocks = allocationsToBlocks("range-file", allocation.allocations);
    const byIndex = new Map(prepared.map((b) => [b.blockIndex, b.data]));
    await storeBlocks(allocation.allocations, blocks, async (i) => byIndex.get(i)!);

    accounts.forEach((a) => (a.retrieveCallCount = 0));

    const offset = 200_000;
    const length = 1000;
    const slice = await readRange(
      blocks,
      BLOCK_SIZE,
      original.length,
      offset,
      length,
      (p, i) => registry.resolve(p, i),
    );

    expect(Buffer.compare(slice, original.subarray(offset, offset + length))).toBe(0);

    // One block fetched, not all five.
    const fetches = accounts.reduce((sum, a) => sum + a.retrieveCallCount, 0);
    expect(fetches).toBe(1);
    expect(blocks.length).toBeGreaterThan(1);
  });

  it("marks a block failed and retryable on persistent store failure", async () => {
    const original = randomBytes(1000);

    const flaky = new MockProviderAccount({
      providerName: "flaky",
      freeSpace: 10_000,
      failFirstNStores: 5, // exceeds retryMaxAttempts of 3
    });
    const registry = new AccountRegistry();
    registry.register(flaky);

    const prepared = await prepareBlocks(original, planBlocks(1000, BLOCK_SIZE), "none");
    const allocation = await planAllocation([flaky], prepared);
    expect(allocation.success).toBe(true);

    const blocks = allocationsToBlocks("flaky-file", allocation.allocations);
    const byIndex = new Map(prepared.map((b) => [b.blockIndex, b.data]));
    const result = await storeBlocks(
      allocation.allocations,
      blocks,
      async (i) => byIndex.get(i)!,
      { retryMaxAttempts: 3 },
    );

    expect(result.allStored).toBe(false);
    expect(result.blocks[0]!.status).toBe("failed");
    expect(result.blocks[0]!.retryCount).toBe(3);
  });

  it("reports insufficient space and never calls store when accounts can't fit the file", async () => {
    const original = randomBytes(500_000);
    const tiny = new MockProviderAccount({ providerName: "tiny", freeSpace: 100 });

    const prepared = await prepareBlocks(
      original,
      planBlocks(original.length, BLOCK_SIZE),
      "none",
    );
    const allocation = await planAllocation([tiny], prepared);

    expect(allocation.success).toBe(false);
    expect(allocation.unplacedBytes).toBeGreaterThan(0);
    // Aborted before any network call — planning is a pure pass.
    expect(tiny.storeCallCount).toBe(0);
  });
});
