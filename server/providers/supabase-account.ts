import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ProviderAccountBase } from "../core/provider-account-base.js";
import type { FileBlock, ProviderAccountIdentity, ProviderAccountStats } from "../core/models.js";

export interface SupabaseAccountConfig {
  accountIndex: number;
  label?: string;
  projectUrl: string;
  serviceRoleKey: string;
  /** User-configured ceiling — Supabase has no per-bucket quota API, so
   * OmniDisk tracks usage itself against this cap (see provider-setup-guide.md). */
  capBytes: number;
}

const BUCKET_NAME = "omnidisk-fragments";
const LIST_PAGE_SIZE = 1000;

/**
 * Supabase Storage adapter — see provider-setup-guide.md §16.
 *
 * Two things make this different from every other adapter so far:
 * 1. No live quota API: the free tier's 1GB limit is project-wide (across
 *    Storage + Database + everything else), and there's no endpoint the
 *    storage/service-role keys can call to ask "how much is left". So
 *    getStorableSpace() is computed as `capBytes - (bytes OmniDisk has
 *    used in its own dedicated bucket)`, not a real provider-reported
 *    number — hence `liveQuotaSupported: false` in the registry entry.
 * 2. Hard 50MB-per-file cap on the free tier: `maxSingleObjectBytes` is
 *    set on the registry definition. Under block-addressing the router
 *    (resolveLogicalBlockSize in block-router.ts) bounds a file's block
 *    size by this cap so no block can exceed it — this adapter doesn't
 *    need to know about that, it just stores whatever block
 *    it's given.
 */
export class SupabaseAccount extends ProviderAccountBase {
  readonly identity: ProviderAccountIdentity;
  readonly baseUrl: string;

  private readonly client: SupabaseClient;
  private readonly capBytes: number;
  private bucketReady: Promise<void> | undefined;

  constructor(config: SupabaseAccountConfig) {
    super();
    this.identity = {
      providerName: "supabase",
      accountIndex: config.accountIndex,
      label: config.label,
    };
    this.baseUrl = config.projectUrl;
    this.capBytes = config.capBytes;
    this.client = createClient(config.projectUrl, config.serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false }, // server-side service-role usage, per Supabase's own admin-API guidance
    });
  }

  /** Creates the dedicated bucket on first use, if it doesn't already exist. */
  private async ensureBucket(): Promise<void> {
    if (!this.bucketReady) {
      this.bucketReady = (async () => {
        const { error: getError } = await this.client.storage.getBucket(BUCKET_NAME);
        if (!getError) return; // already exists
        const { error: createError } = await this.client.storage.createBucket(BUCKET_NAME, {
          public: false,
        });
        // A concurrent probe/upload racing to create the same bucket is fine
        // to ignore; any other failure should surface.
        if (createError && !/already exists/i.test(createError.message)) {
          throw createError;
        }
      })();
    }
    return this.bucketReady;
  }

  /** Sums the size of every object currently in our dedicated bucket, paginating as needed. */
  private async usedBytes(): Promise<number> {
    await this.ensureBucket();
    let total = 0;
    let offset = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { data, error } = await this.client.storage
        .from(BUCKET_NAME)
        .list(undefined, { limit: LIST_PAGE_SIZE, offset });
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const entry of data) {
        total += entry.metadata?.size ?? 0;
      }
      if (data.length < LIST_PAGE_SIZE) break;
      offset += LIST_PAGE_SIZE;
    }
    return total;
  }

  async getStorableSpace(): Promise<number> {
    const used = await this.usedBytes();
    return Math.max(0, this.capBytes - used);
  }

  async getStats(): Promise<ProviderAccountStats> {
    const used = await this.usedBytes();
    return {
      totalSpace: this.capBytes,
      usedSpace: used,
      freeSpace: Math.max(0, this.capBytes - used),
      blockCount: 0,
      avgLatencyMs: 0,
      avgSpeedBps: 0,
      lastProbedAt: new Date().toISOString(),
      priorityScore: this.priorityScore,
      enabled: this.enabled,
    };
  }

  async store(block: FileBlock, data: Buffer): Promise<FileBlock> {
    await this.ensureBucket();
    const { error } = await this.client.storage.from(BUCKET_NAME).upload(block.remotePath, data, {
      contentType: "application/octet-stream",
      upsert: true, // makes retries/re-stores idempotent — overwrite rather than error-on-exists
    });
    if (error) throw error;
    return block;
  }

  async retrieve(block: FileBlock): Promise<Buffer> {
    await this.ensureBucket();
    const { data, error } = await this.client.storage.from(BUCKET_NAME).download(block.remotePath);
    if (error) throw error;
    if (!data) throw new Error(`No block found at ${block.remotePath} in Supabase Storage`);
    return Buffer.from(await data.arrayBuffer());
  }

  async delete(block: FileBlock): Promise<void> {
    await this.ensureBucket();
    const { error } = await this.client.storage.from(BUCKET_NAME).remove([block.remotePath]);
    // Idempotent — a "not found" style error on delete isn't a real failure.
    if (error && !/not.?found/i.test(error.message)) throw error;
  }

  async pingLatency(): Promise<number> {
    const start = Date.now();
    await this.ensureBucket();
    await this.client.storage.getBucket(BUCKET_NAME);
    return Date.now() - start;
  }

  async measureThroughput(): Promise<number> {
    const sample = Buffer.alloc(64 * 1024, 1);
    const probeBlock: FileBlock = {
      blockId: `__probe_${this.identity.accountIndex}`,
      fileUuid: "__probe",
      providerName: "supabase",
      accountIndex: this.identity.accountIndex,
      blockIndex: 0,
      logicalStart: 0,
      logicalLength: sample.length,
      storedSize: sample.length,
      compressionUsed: "none",
      remotePath: `__omnidisk_probe_${Date.now()}`,
      status: "pending",
      retryCount: 0,
    };
    const start = Date.now();
    await this.store(probeBlock, sample);
    const elapsedMs = Date.now() - start;
    await this.delete(probeBlock).catch(() => {});
    return elapsedMs > 0 ? Math.round((sample.length / elapsedMs) * 1000) : sample.length;
  }
}
