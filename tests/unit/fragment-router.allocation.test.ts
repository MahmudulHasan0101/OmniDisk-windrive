import { describe, it, expect } from "vitest";
import { planAllocation, segmentsToFragments } from "../../server/core/fragment-router.js";
import { MockProviderAccount } from "../helpers/mock-provider-account.js";

describe("planAllocation — overflow-fill allocation algorithm", () => {
  it("places everything on a single account when it has sufficient space", async () => {
    const accounts = [
      new MockProviderAccount({ providerName: "drive", freeSpace: 100 }),
      new MockProviderAccount({ providerName: "onedrive", freeSpace: 100 }),
    ];

    const result = await planAllocation(accounts, 40);

    expect(result.success).toBe(true);
    expect(result.unplacedBytes).toBe(0);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]!.account).toBe(accounts[0]);
    expect(result.segments[0]!.byteStart).toBe(0);
    expect(result.segments[0]!.byteEnd).toBe(40);
  });

  it("fills an account exactly with no spillover (exact fit)", async () => {
    const accounts = [
      new MockProviderAccount({ providerName: "drive", freeSpace: 50 }),
      new MockProviderAccount({ providerName: "onedrive", freeSpace: 50 }),
    ];

    const result = await planAllocation(accounts, 50);

    expect(result.success).toBe(true);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]!.byteEnd - result.segments[0]!.byteStart).toBe(50);
  });

  it("spills over across 3+ accounts in ranked order", async () => {
    const accounts = [
      new MockProviderAccount({ providerName: "drive", freeSpace: 30 }),
      new MockProviderAccount({ providerName: "onedrive", freeSpace: 20 }),
      new MockProviderAccount({ providerName: "dropbox", freeSpace: 40 }),
      new MockProviderAccount({ providerName: "box", freeSpace: 100 }),
    ];

    const result = await planAllocation(accounts, 70);

    expect(result.success).toBe(true);
    expect(result.unplacedBytes).toBe(0);
    // Should fill drive (30) + onedrive (20) + dropbox (20 of 40), stopping there.
    expect(result.segments).toHaveLength(3);
    expect(result.segments.map((s) => s.byteEnd - s.byteStart)).toEqual([30, 20, 20]);
    expect(result.segments.map((s) => s.account.identity.providerName)).toEqual([
      "drive",
      "onedrive",
      "dropbox",
    ]);
    // Byte ranges are contiguous and in order.
    expect(result.segments[0]!.byteStart).toBe(0);
    expect(result.segments[1]!.byteStart).toBe(30);
    expect(result.segments[2]!.byteStart).toBe(50);
    expect(result.segments[2]!.byteEnd).toBe(70);
    // box (100 free) was never even considered.
    expect(
      result.accountsTried.some((a) => a.providerName === "box"),
    ).toBe(false);
  });

  it("aborts before any store when total free space is insufficient", async () => {
    const accounts = [
      new MockProviderAccount({ providerName: "drive", freeSpace: 10 }),
      new MockProviderAccount({ providerName: "onedrive", freeSpace: 15 }),
    ];

    const result = await planAllocation(accounts, 100);

    expect(result.success).toBe(false);
    expect(result.unplacedBytes).toBe(100 - 10 - 15);
    expect(result.accountsTried).toHaveLength(2);
    // Every account was tried (its free space checked) but nothing was stored.
    for (const account of accounts) {
      expect(await account.getStorableSpace()).toBeGreaterThan(0);
    }
  });

  it("skips capacity-exhausted (zero free space) accounts", async () => {
    const accounts = [
      new MockProviderAccount({ providerName: "drive", freeSpace: 0 }),
      new MockProviderAccount({ providerName: "onedrive", freeSpace: 60 }),
    ];

    const result = await planAllocation(accounts, 40);

    expect(result.success).toBe(true);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]!.account.identity.providerName).toBe("onedrive");
  });

  it("splits one account's allocation across multiple fragments when it has a maxSingleObjectBytes cap", async () => {
    const capped = new MockProviderAccount({ providerName: "supabase", freeSpace: 120 });
    capped.maxSingleObjectBytes = 50; // e.g. Supabase Storage's 50MB/file free-tier limit
    const accounts = [capped];

    const result = await planAllocation(accounts, 120);

    expect(result.success).toBe(true);
    expect(result.unplacedBytes).toBe(0);
    // 120 bytes at a 50-byte cap -> 50 + 50 + 20, all on the same account.
    expect(result.segments).toHaveLength(3);
    expect(result.segments.map((s) => s.byteEnd - s.byteStart)).toEqual([50, 50, 20]);
    expect(result.segments.every((s) => s.account === capped)).toBe(true);
    // Byte ranges are still contiguous across the split.
    expect(result.segments.map((s) => s.byteStart)).toEqual([0, 50, 100]);
    expect(result.segments.map((s) => s.byteEnd)).toEqual([50, 100, 120]);

    // Fragments built from these segments must not collide on remotePath.
    const fragments = segmentsToFragments("file-xyz", result.segments);
    const remotePaths = new Set(fragments.map((f) => f.remotePath));
    expect(remotePaths.size).toBe(3);
  });

  it("respects maxSingleObjectBytes even when it doesn't evenly divide the account's assignment, then moves to the next account", async () => {
    const capped = new MockProviderAccount({ providerName: "supabase", freeSpace: 30 });
    capped.maxSingleObjectBytes = 50; // cap larger than what's actually free — no splitting needed
    const uncapped = new MockProviderAccount({ providerName: "drive", freeSpace: 100 });

    const result = await planAllocation([capped, uncapped], 40);

    expect(result.success).toBe(true);
    // supabase contributes one 30-byte fragment (cap never binds since free < cap),
    // drive fills the remaining 10.
    expect(result.segments).toHaveLength(2);
    expect(result.segments.map((s) => s.byteEnd - s.byteStart)).toEqual([30, 10]);
  });

  it("builds FileFragment records with the expected id/index/remotePath shape", async () => {
    const accounts = [
      new MockProviderAccount({ providerName: "drive", accountIndex: 2, freeSpace: 100 }),
    ];
    const result = await planAllocation(accounts, 10);
    const fragments = segmentsToFragments("file-abc", result.segments);

    expect(fragments).toHaveLength(1);
    expect(fragments[0]).toMatchObject({
      fragmentId: "file-abc_drive_2_0",
      fileUuid: "file-abc",
      providerName: "drive",
      accountIndex: 2,
      index: 0,
      remotePath: "file-abc/drive_2_0",
      status: "pending",
      retryCount: 0,
    });
  });
});
