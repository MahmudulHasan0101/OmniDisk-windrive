import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  planAllocation,
  segmentsToFragments,
  storeFragments,
  retrieveFragmentsInOrder,
} from "../../server/core/fragment-router.js";
import { MockProviderAccount } from "../helpers/mock-provider-account.js";

/**
 * Proves storeFragments/retrieveFragmentsInOrder genuinely overlap network
 * calls in flight (real concurrency), not just "eventually correct" —
 * asserting on wall-clock time, not merely on the returned data.
 */
describe("fragment upload/download concurrency", () => {
  it("downloads all fragments in parallel, not one at a time", async () => {
    const DELAY_MS = 100;
    const FRAGMENT_COUNT = 4;

    const accounts = Array.from(
      { length: FRAGMENT_COUNT },
      (_, i) => new MockProviderAccount({ providerName: `p${i}`, freeSpace: 10, retrieveDelayMs: DELAY_MS }),
    );

    const totalBytes = FRAGMENT_COUNT * 10;
    const allocation = await planAllocation(accounts, totalBytes);
    expect(allocation.success).toBe(true);
    const fragments = segmentsToFragments("file-concurrency", allocation.segments);

    // Pre-populate each account with the bytes its fragment expects, so
    // retrieval below has something real to fetch.
    for (const fragment of fragments) {
      const account = accounts.find((a) => a.identity.providerName === fragment.providerName)!;
      await account.store(fragment, Buffer.alloc(fragment.byteEnd - fragment.byteStart, 1));
    }

    const chunks: Buffer[] = new Array(fragments.length);
    const start = Date.now();
    await retrieveFragmentsInOrder(
      fragments,
      (providerName) => accounts.find((a) => a.identity.providerName === providerName)!,
      (chunk, fragment) => {
        chunks[fragment.index] = chunk;
      },
      { concurrencyLimit: FRAGMENT_COUNT }, // enough slots for every fragment at once
    );
    const elapsedMs = Date.now() - start;

    // If these ran sequentially, this would take >= FRAGMENT_COUNT * DELAY_MS
    // (400ms). Running in parallel, it should take roughly one DELAY_MS
    // period. Generous upper bound to avoid CI flakiness while still
    // clearly distinguishing "parallel" from "sequential".
    expect(elapsedMs).toBeLessThan(DELAY_MS * (FRAGMENT_COUNT / 2));
    expect(chunks.every((c) => c && c.length > 0)).toBe(true);
  });

  it("uploads all fragments in parallel, not one at a time", async () => {
    const DELAY_MS = 100;
    const FRAGMENT_COUNT = 4;

    const accounts = Array.from(
      { length: FRAGMENT_COUNT },
      (_, i) => new MockProviderAccount({ providerName: `p${i}`, freeSpace: 10, storeDelayMs: DELAY_MS }),
    );

    const totalBytes = FRAGMENT_COUNT * 10;
    const allocation = await planAllocation(accounts, totalBytes);
    const fragments = segmentsToFragments("file-concurrency-2", allocation.segments);
    const sourceBuffer = Buffer.alloc(totalBytes, 2);

    const start = Date.now();
    const result = await storeFragments(
      allocation.segments,
      fragments,
      async (byteStart, byteEnd) => sourceBuffer.subarray(byteStart, byteEnd),
      { concurrencyLimit: FRAGMENT_COUNT, retryMaxAttempts: 1 },
    );
    const elapsedMs = Date.now() - start;

    expect(result.allStored).toBe(true);
    expect(elapsedMs).toBeLessThan(DELAY_MS * (FRAGMENT_COUNT / 2));
  });
});
