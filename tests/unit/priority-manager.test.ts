import { describe, it, expect } from "vitest";
import { PriorityManager } from "../../server/core/priority-manager.js";
import { MockProviderAccount } from "../helpers/mock-provider-account.js";

describe("PriorityManager", () => {
  it("ranks by throughput in speed mode (fastest first)", async () => {
    const slow = new MockProviderAccount({ providerName: "slow", freeSpace: 100, speedBps: 1_000 });
    const fast = new MockProviderAccount({ providerName: "fast", freeSpace: 100, speedBps: 9_000 });

    const manager = new PriorityManager([slow, fast], "speed");
    await manager.refreshAll();

    const ranked = manager.getRankedAccounts();
    expect(ranked.map((a) => a.identity.providerName)).toEqual(["fast", "slow"]);
  });

  it("ranks by latency in latency mode (lowest first)", async () => {
    const laggy = new MockProviderAccount({ providerName: "laggy", freeSpace: 100, latencyMs: 300 });
    const snappy = new MockProviderAccount({ providerName: "snappy", freeSpace: 100, latencyMs: 20 });

    const manager = new PriorityManager([laggy, snappy], "latency");
    await manager.refreshAll();

    const ranked = manager.getRankedAccounts();
    expect(ranked.map((a) => a.identity.providerName)).toEqual(["snappy", "laggy"]);
  });

  it("ranks by free space in free_space mode (most free first)", async () => {
    const small = new MockProviderAccount({ providerName: "small", freeSpace: 10 });
    const big = new MockProviderAccount({ providerName: "big", freeSpace: 1000 });

    const manager = new PriorityManager([small, big], "free_space");
    await manager.refreshAll();

    const ranked = manager.getRankedAccounts();
    expect(ranked.map((a) => a.identity.providerName)).toEqual(["big", "small"]);
  });

  it("honors manualPriorityRank in manual mode, ignoring probed stats", async () => {
    const a = new MockProviderAccount({ providerName: "a", freeSpace: 10, speedBps: 9_999 });
    const b = new MockProviderAccount({ providerName: "b", freeSpace: 10, speedBps: 1 });
    a.manualPriorityRank = 2;
    b.manualPriorityRank = 1;

    const manager = new PriorityManager([a, b], "manual");
    const ranked = manager.getRankedAccounts();
    expect(ranked.map((acc) => acc.identity.providerName)).toEqual(["b", "a"]);
  });

  it("excludes disabled accounts from ranking", async () => {
    const enabled = new MockProviderAccount({ providerName: "enabled", freeSpace: 10 });
    const disabled = new MockProviderAccount({ providerName: "disabled", freeSpace: 10 });
    disabled.enabled = false;

    const manager = new PriorityManager([enabled, disabled], "free_space");
    await manager.refreshAll();

    const ranked = manager.getRankedAccounts();
    expect(ranked.map((a) => a.identity.providerName)).toEqual(["enabled"]);
  });

  it("still records space when the speed probe fails, and one broken account doesn't stop the others", async () => {
    class SpeedProbeFails extends MockProviderAccount {
      override async measureThroughput(): Promise<number> {
        throw new Error("probe upload rejected");
      }
    }
    class QuotaLookupFails extends MockProviderAccount {
      override async getStats(): Promise<never> {
        throw new Error("login failed");
      }
    }
    const flaky = new SpeedProbeFails({ providerName: "flaky", freeSpace: 100 });
    const broken = new QuotaLookupFails({ providerName: "broken", freeSpace: 200 });
    const healthy = new MockProviderAccount({ providerName: "healthy", freeSpace: 300 });

    const persisted: string[] = [];
    const errors: string[] = [];
    const manager = new PriorityManager(
      [flaky, broken, healthy],
      "speed",
      (account, stats) => {
        persisted.push(`${account.identity.providerName}:${stats.freeSpace}`);
      },
      (account, phase) => {
        errors.push(`${account.identity.providerName}:${phase}`);
      },
    );

    await expect(manager.refreshAll()).resolves.toBeUndefined();

    // flaky's space is recorded despite its failed speed test; broken has no
    // space figure to record, so nothing (not a row of zeros) is written for it.
    expect(persisted.sort()).toEqual(["flaky:100", "healthy:300"]);
    expect(errors.sort()).toEqual(["broken:space", "flaky:throughput"]);
  });
});
