import { describe, it, expect } from "vitest";
import {
  planBlocks,
  prepareBlocks,
  planAllocation,
  allocationsToBlocks,
  storeBlocks,
  retryFailedBlocks,
  retrieveBlocksInOrder,
} from "../../server/core/block-router.js";
import { MockProviderAccount } from "../helpers/mock-provider-account.js";

/**
 * Proves storeBlocks/retrieveBlocksInOrder genuinely overlap network calls in
 * flight (real concurrency), not just "eventually correct" — asserting on
 * wall-clock time, not merely on the returned data.
 */
describe("block upload/download concurrency", () => {
  it("downloads blocks in parallel, not one at a time", async () => {
    const DELAY_MS = 100;
    const BLOCK_COUNT = 4;
    const BLOCK_SIZE = 10;

    const accounts = Array.from(
      { length: BLOCK_COUNT },
      (_, i) =>
        new MockProviderAccount({
          providerName: `p${i}`,
          freeSpace: BLOCK_SIZE,
          retrieveDelayMs: DELAY_MS,
        }),
    );

    const content = Buffer.alloc(BLOCK_COUNT * BLOCK_SIZE, 7);
    const prepared = await prepareBlocks(
      content,
      planBlocks(content.length, BLOCK_SIZE),
      "none",
    );
    const allocation = await planAllocation(accounts, prepared);
    expect(allocation.success).toBe(true);

    const blocks = allocationsToBlocks("file-concurrency", allocation.allocations);
    const byIndex = new Map(prepared.map((b) => [b.blockIndex, b.data]));
    await storeBlocks(allocation.allocations, blocks, async (i) => byIndex.get(i)!);

    const resolve = (providerName: string) =>
      accounts.find((a) => a.identity.providerName === providerName)!;

    const chunks: Buffer[] = new Array(blocks.length);
    const start = Date.now();
    await retrieveBlocksInOrder(
      blocks,
      resolve,
      (chunk, block) => {
        chunks[block.blockIndex] = chunk;
      },
      { concurrencyLimit: BLOCK_COUNT },
    );
    const elapsedMs = Date.now() - start;

    // Sequential would be >= BLOCK_COUNT * DELAY_MS.
    expect(elapsedMs).toBeLessThan(BLOCK_COUNT * DELAY_MS * 0.8);
    expect(Buffer.concat(chunks)).toEqual(content);
  });

  it("retries a transient store failure and eventually succeeds", async () => {
    const account = new MockProviderAccount({
      providerName: "flaky",
      freeSpace: 1000,
      failFirstNStores: 2,
    });

    const content = Buffer.alloc(30, 3);
    const prepared = await prepareBlocks(content, planBlocks(30, 10), "none");
    const allocation = await planAllocation([account], prepared);
    const blocks = allocationsToBlocks("file-retry", allocation.allocations);
    const byIndex = new Map(prepared.map((b) => [b.blockIndex, b.data]));

    const result = await storeBlocks(
      allocation.allocations,
      blocks,
      async (i) => byIndex.get(i)!,
      { retryMaxAttempts: 3 },
    );

    expect(result.allStored).toBe(true);
    expect(result.successfullyStoredSize).toBe(30);
  });

  it("re-uploads ONLY the failed block, not the whole file", async () => {
    // The practical payoff of block addressing: one bad block no longer
    // jeopardizes the entire file, and retry is genuinely incremental.
    const good = new MockProviderAccount({ providerName: "good", freeSpace: 20 });
    const bad = new MockProviderAccount({
      providerName: "bad",
      freeSpace: 20,
      failFirstNStores: 99, // always fails on the first pass
    });

    const content = Buffer.alloc(40, 9);
    const prepared = await prepareBlocks(content, planBlocks(40, 10), "none");
    const allocation = await planAllocation([good, bad], prepared);
    const blocks = allocationsToBlocks("file-partial", allocation.allocations);
    const byIndex = new Map(prepared.map((b) => [b.blockIndex, b.data]));

    const first = await storeBlocks(
      allocation.allocations,
      blocks,
      async (i) => byIndex.get(i)!,
      { retryMaxAttempts: 1 },
    );
    expect(first.allStored).toBe(false);

    const failedCount = blocks.filter((b) => b.status === "failed").length;
    expect(failedCount).toBeGreaterThan(0);

    // Let the bad account start working, then retry just the failures.
    const resolve = (providerName: string) =>
      providerName === "good" ? good : bad;
    (bad as unknown as { failFirstNStores: number }).failFirstNStores = 0;

    good.storeCallCount = 0;
    bad.storeCallCount = 0;

    const retried = await retryFailedBlocks(
      blocks,
      resolve,
      async (i) => byIndex.get(i)!,
      { retryMaxAttempts: 3 },
    );

    // Only the previously-failed blocks were touched; the good account,
    // whose blocks already stored fine, saw no traffic at all.
    expect(good.storeCallCount).toBe(0);
    expect(bad.storeCallCount).toBe(failedCount);
    expect(retried.blocks.filter((b) => b.status === "failed")).toHaveLength(0);
  });
});
