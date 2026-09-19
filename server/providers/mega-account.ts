import { Storage } from "megajs";
import { ProviderAccountBase } from "../core/provider-account-base.js";
import type { FileBlock, ProviderAccountIdentity } from "../core/models.js";

export interface MegaAccountConfig {
  accountIndex: number;
  label?: string;
  email: string;
  password: string;
  /**
   * Overridable for testing only — real usage always gets the default,
   * which constructs a real megajs Storage/API pair. Lets tests inject a
   * lightweight fake EventEmitter instead of hitting the real network,
   * to verify the error-handling behavior documented on getStorage().
   */
  storageFactory?: (email: string, password: string) => InstanceType<typeof Storage>;
}

const defaultStorageFactory = (email: string, password: string): InstanceType<typeof Storage> =>
  new Storage({ email, password });

/**
 * First concrete Phase 1 adapter — see provider-setup-guide.md §6.
 * MEGA has no OAuth/app-registration step: the SDK derives a session
 * straight from email+password (its own crypto login scheme), so this
 * is the simplest provider to stand up end-to-end.
 *
 * Blocks are stored flat in a dedicated "OmniDisk_Fragments" folder
 * (name kept for backwards compatibility with already-stored data),
 * created lazily on first use, named by `remotePath` (which already
 * embeds fileUuid and block index — see FileBlock in models.ts).
 */
export class MegaAccount extends ProviderAccountBase {
  readonly identity: ProviderAccountIdentity;
  readonly baseUrl = "https://mega.nz";

  private readonly email: string;
  private readonly password: string;
  private readonly storageFactory: (email: string, password: string) => InstanceType<typeof Storage>;
  private storage: InstanceType<typeof Storage> | undefined;
  private readyPromise: Promise<InstanceType<typeof Storage>> | undefined;
  private static readonly FOLDER_NAME = "OmniDisk_Fragments";

  constructor(config: MegaAccountConfig) {
    super();
    this.identity = {
      providerName: "mega",
      accountIndex: config.accountIndex,
      label: config.label,
    };
    this.email = config.email;
    this.password = config.password;
    this.storageFactory = config.storageFactory ?? defaultStorageFactory;
  }

  /** Logs in once, lazily, and caches the ready `Storage` instance. */
  /**
   * megajs's Storage class spins up its own internal API instance for
   * background long-polling (server-push notifications) that runs for the
   * lifetime of the session, independent of any specific request this
   * class makes. Critically, Storage itself never attaches an 'error'
   * listener to that instance — per Node's EventEmitter semantics, an
   * unhandled 'error' event throws and crashes the entire process, not
   * just the one call in flight. A transient DNS hiccup or dropped
   * connection during that ambient polling (not any request our own code
   * made) would otherwise take down the whole OmniDisk server. This is a
   * known megajs gotcha — the library expects consumers to handle it.
   */
  private async getStorage(): Promise<InstanceType<typeof Storage>> {
    if (this.storage) return this.storage;
    if (!this.readyPromise) {
      const storage = this.storageFactory(this.email, this.password);
      // megajs's own .d.ts imports EventEmitter from a Deno CDN URL that
      // TypeScript can't resolve in a Node project, so `API`'s `.on()` type
      // is broken upstream even though it's a real node:events EventEmitter
      // at runtime — hence the cast rather than a type-level fix.
      (storage.api as unknown as NodeJS.EventEmitter).on("error", (err: unknown) => {
        console.error(
          `[MegaAccount ${this.identity.accountIndex}] background connection error ` +
            `(network hiccup, not a failed request): ${err instanceof Error ? err.message : String(err)}`,
        );
        // Session may now be in a bad state — drop it so the next call
        // re-logs in from scratch instead of silently reusing a broken one.
        this.storage = undefined;
        this.readyPromise = undefined;
      });
      this.readyPromise = storage.ready.then((readyStorage) => {
        this.storage = readyStorage;
        return readyStorage;
      });
    }
    return this.readyPromise;
  }

  /** Finds (or creates) the dedicated OmniDisk folder, cached per session. */
  private async getBlocksFolder(): Promise<InstanceType<typeof Storage>["root"]> {
    const storage = await this.getStorage();
    const existing = storage.root.children?.find(
      (node) => node.name === MegaAccount.FOLDER_NAME && node.directory,
    );
    if (existing) return existing as unknown as InstanceType<typeof Storage>["root"];
    return new Promise((resolve, reject) => {
      storage.mkdir(MegaAccount.FOLDER_NAME, (err: Error | null, folder: unknown) => {
        if (err) reject(err);
        else resolve(folder as InstanceType<typeof Storage>["root"]);
      });
    });
  }

  private findBlockFile(
    folder: InstanceType<typeof Storage>["root"],
    remotePath: string,
  ) {
    return folder.children?.find((node) => node.name === remotePath);
  }

  async getStorableSpace(): Promise<number> {
    const storage = await this.getStorage();
    // megajs only populates spaceUsed/spaceTotal via an explicit
    // getAccountInfo() call (`a: "uq"` under the hood) — plain login does
    // NOT fetch quota, so reading these right after `ready` silently gives
    // 0/0. Always ask for fresh account info here.
    const info = await storage.getAccountInfo();
    const total = info.spaceTotal ?? 0;
    const used = info.spaceUsed ?? 0;
    return Math.max(0, total - used);
  }

  async getStats(): Promise<import("../core/models.js").ProviderAccountStats> {
    const storage = await this.getStorage();
    const info = await storage.getAccountInfo();
    const total = info.spaceTotal ?? 0;
    const used = info.spaceUsed ?? 0;
    return {
      totalSpace: total,
      usedSpace: used,
      freeSpace: Math.max(0, total - used),
      blockCount: 0, // filled from DB aggregate by the caller, not here
      avgLatencyMs: 0,
      avgSpeedBps: 0,
      lastProbedAt: new Date().toISOString(),
      priorityScore: this.priorityScore,
      enabled: this.enabled,
    };
  }

  async store(block: FileBlock, data: Buffer): Promise<FileBlock> {
    const folder = await this.getBlocksFolder();

    // Make this idempotent: if a file with this name already exists (e.g.
    // a prior attempt's upload actually completed on MEGA's side even
    // though our client treated it as failed — the "p" node-creation call
    // can succeed after our request already timed out), remove it first.
    // Otherwise a retry creates a second same-named file, and
    // findBlockFile()'s lookup could silently pick whichever one MEGA
    // happens to return first — which may not be the good copy. Google
    // Drive's adapter already does update-in-place for the same reason.
    const existing = this.findBlockFile(folder, block.remotePath);
    if (existing) await existing.delete();

    await new Promise<void>((resolve, reject) => {
      folder.upload(
        { name: block.remotePath, size: data.length },
        data,
        (err: Error | null) => (err ? reject(err) : resolve()),
      );
    });
    return block;
  }

  async retrieve(block: FileBlock): Promise<Buffer> {
    const folder = await this.getBlocksFolder();
    const file = this.findBlockFile(folder, block.remotePath);
    if (!file) throw new Error(`No block found at ${block.remotePath} in MEGA`);
    return file.downloadBuffer({});
  }

  async delete(block: FileBlock): Promise<void> {
    const folder = await this.getBlocksFolder();
    const file = this.findBlockFile(folder, block.remotePath);
    if (!file) return; // already gone — delete is idempotent
    await file.delete();
  }

  async pingLatency(): Promise<number> {
    const start = Date.now();
    await this.getStorage(); // cheap once session is warm; full login cost only on first call
    return Date.now() - start;
  }

  async measureThroughput(): Promise<number> {
    // Small 64KB sample upload/download, per spec §7 throughput probing.
    // MEGA's client-side encryption adds overhead vs raw network speed —
    // see provider-setup-guide.md §6 quirks — so this genuinely reflects
    // MEGA's effective speed, not just link speed.
    const sample = Buffer.alloc(64 * 1024, 1);
    const probeBlock: FileBlock = {
      blockId: `__probe_${this.identity.accountIndex}`,
      fileUuid: "__probe",
      providerName: "mega",
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
