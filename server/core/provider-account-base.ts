import type {
  FileBlock,
  ProviderAccountIdentity,
  ProviderAccountStats,
} from "./models.js";

/**
 * Contract every provider account must fulfill. No concrete provider is
 * implemented at the skeleton stage — concrete classes (GoogleDriveAccount,
 * OneDriveAccount, S3CompatibleAccount for S3/R2/B2, etc.) extend this in
 * a later phase (see providers/, added incrementally). Adding a new
 * provider never touches the router, priority manager, or API layer.
 */
export abstract class ProviderAccountBase {
  abstract readonly identity: ProviderAccountIdentity;
  abstract readonly baseUrl: string;

  abstract getStorableSpace(): Promise<number>;
  abstract store(block: FileBlock, data: Buffer): Promise<FileBlock>;
  abstract retrieve(block: FileBlock): Promise<Buffer>;
  abstract delete(block: FileBlock): Promise<void>;
  abstract pingLatency(): Promise<number>; // ms, round trip to a lightweight endpoint
  abstract measureThroughput(): Promise<number>; // bytes/sec, small sample upload/download

  priorityScore = 0;
  enabled = true;
  manualPriorityRank?: number; // used only when PrioritySortMode = "manual"
  /**
   * Hard per-object size cap for this provider (e.g. Supabase Storage's
   * 50MB/file free-tier limit). Set by adapter-factory.ts from the
   * account's registry definition after construction.
   *
   * Under block-addressing this constrains BLOCK SIZE SELECTION rather than
   * triggering per-account splitting: resolveLogicalBlockSize() bounds a
   * file's logicalBlockSize by the smallest cap among candidate accounts, so
   * no block can ever exceed what a provider will accept. planAllocation
   * also refuses to place an oversized block as a backstop, in case an
   * account is added mid-upload.
   */
  maxSingleObjectBytes?: number;

  async getStats(): Promise<ProviderAccountStats> {
    const free = await this.getStorableSpace();
    return {
      totalSpace: 0, // filled from provider-reported quota where available
      usedSpace: 0,
      freeSpace: free,
      blockCount: 0, // filled from DB aggregate, not computed here
      avgLatencyMs: 0,
      avgSpeedBps: 0,
      lastProbedAt: new Date().toISOString(),
      priorityScore: this.priorityScore,
      enabled: this.enabled,
    };
  }
}
