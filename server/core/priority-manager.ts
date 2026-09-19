import type { ProviderAccountBase } from "./provider-account-base.js";
import type { PrioritySortMode, ProviderAccountStats } from "./models.js";

/** Callback invoked with fresh probe results so the caller can persist them. */
export type ProbeResultHandler = (
  account: ProviderAccountBase,
  stats: ProviderAccountStats,
) => void | Promise<void>;

/** Which of an account's three probes failed. */
export type ProbePhase = "latency" | "throughput" | "space";

/**
 * Callback invoked when one probe of one account fails, so the caller can log
 * the real provider error instead of it disappearing.
 */
export type ProbeErrorHandler = (
  account: ProviderAccountBase,
  phase: ProbePhase,
  err: unknown,
) => void;

export class PriorityManager {
  /** Last successful latency/throughput per account, reused if a later probe of that kind fails. */
  private lastKnown = new Map<string, { latencyMs: number; speedBps: number }>();

  constructor(
    private accounts: ProviderAccountBase[],
    private mode: PrioritySortMode = "speed",
    private onProbeResult?: ProbeResultHandler,
    private onProbeError?: ProbeErrorHandler,
  ) {}

  setMode(mode: PrioritySortMode): void {
    this.mode = mode;
  }

  getMode(): PrioritySortMode {
    return this.mode;
  }

  setAccounts(accounts: ProviderAccountBase[]): void {
    this.accounts = accounts;
  }

  /**
   * Probes every enabled account in parallel: pingLatency() +
   * measureThroughput() + getStats(). Persists results via onProbeResult
   * (caller writes to provider_accounts: total/used space, avg_latency_ms,
   * avg_speed_bps, last_probed_at). Recomputes priorityScore per the active
   * sort mode.
   *
   * The three probes are independent: a failed speed test (which is a real
   * upload to the provider) must not stop the account's total/used space from
   * being recorded, and one broken account must not stop the others from being
   * refreshed. Each failure is reported through onProbeError. If the space
   * probe itself fails nothing is persisted for that account, so the last good
   * figures stay in place rather than being overwritten with zeros.
   */
  async refreshAll(): Promise<void> {
    const enabledAccounts = this.accounts.filter((a) => a.enabled);

    await Promise.all(
      enabledAccounts.map(async (account) => {
        const [latency, throughput, space] = await Promise.allSettled([
          account.pingLatency(),
          account.measureThroughput(),
          account.getStats(), // totalSpace/usedSpace/freeSpace together, per-adapter
        ]);

        if (latency.status === "rejected") this.onProbeError?.(account, "latency", latency.reason);
        if (throughput.status === "rejected") {
          this.onProbeError?.(account, "throughput", throughput.reason);
        }
        if (space.status === "rejected") {
          this.onProbeError?.(account, "space", space.reason);
          return;
        }

        const key = `${account.identity.providerName}:${account.identity.accountIndex}`;
        const previous = this.lastKnown.get(key) ?? { latencyMs: 0, speedBps: 0 };
        const latencyMs = latency.status === "fulfilled" ? latency.value : previous.latencyMs;
        const speedBps = throughput.status === "fulfilled" ? throughput.value : previous.speedBps;
        this.lastKnown.set(key, { latencyMs, speedBps });

        const stats: ProviderAccountStats = {
          ...space.value,
          avgLatencyMs: latencyMs,
          avgSpeedBps: speedBps,
          lastProbedAt: new Date().toISOString(),
        };

        account.priorityScore = this.computeScore(stats);
        stats.priorityScore = account.priorityScore;

        await this.onProbeResult?.(account, stats);
      }),
    );
  }

  private computeScore(stats: ProviderAccountStats): number {
    switch (this.mode) {
      case "speed":
        return stats.avgSpeedBps;
      case "latency":
        return -stats.avgLatencyMs; // lower latency = higher score
      case "free_space":
        return stats.freeSpace;
      case "manual":
        return 0; // ignored; manual order used directly
    }
  }

  /**
   * Ranked, enabled accounts in priority order. In "manual" mode, sorts by
   * each account's `manualPriorityRank` ascending (unset ranks sort last,
   * in original array order, as a safe default).
   */
  getRankedAccounts(): ProviderAccountBase[] {
    const enabledAccounts = this.accounts.filter((a) => a.enabled);

    if (this.mode === "manual") {
      return [...enabledAccounts].sort((a, b) => {
        const rankA = a.manualPriorityRank ?? Number.POSITIVE_INFINITY;
        const rankB = b.manualPriorityRank ?? Number.POSITIVE_INFINITY;
        return rankA - rankB;
      });
    }

    return [...enabledAccounts].sort(
      (a, b) => b.priorityScore - a.priorityScore,
    );
  }
}
