import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { FileBlock } from "./models.js";

/**
 * On-disk LRU cache of DECOMPRESSED blocks.
 *
 * A mount is unusable without this: every cache miss is a network round trip
 * inside a blocking filesystem read, so the hit rate is what separates "feels
 * like a disk" from "feels broken". Caching decompressed bytes (rather than
 * the stored, compressed form) means a hit costs one local read and no CPU.
 *
 * Deliberately file-backed rather than in-memory: block payloads are megabytes
 * each, and the cache needs to survive a restart to be worth anything.
 */

export interface BlockCacheOptions {
  dir: string;
  /** Soft ceiling; eviction runs when the total exceeds it. Default 10GB. */
  maxBytes?: number;
}

interface CacheEntry {
  key: string;
  size: number;
  lastUsed: number;
  pinned: boolean;
}

function cacheKey(block: FileBlock): string {
  // Keyed by file + block index, not by remote path, so a block that gets
  // rebalanced to a different provider account keeps its cached copy.
  return `${block.fileUuid}_b${block.blockIndex}`;
}

export class BlockCache {
  private readonly dir: string;
  private readonly maxBytes: number;
  private index = new Map<string, CacheEntry>();
  private totalBytes = 0;
  private ready: Promise<void>;

  constructor(options: BlockCacheOptions) {
    this.dir = options.dir;
    this.maxBytes = options.maxBytes ?? 10 * 1024 * 1024 * 1024;
    this.ready = this.rebuildIndex();
  }

  /**
   * Rebuilds the in-memory index from whatever survived the last run. Cache
   * files are disposable, so any unreadable entry is simply dropped rather
   * than treated as an error.
   */
  private async rebuildIndex(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      try {
        const info = await stat(join(this.dir, name));
        if (!info.isFile()) continue;
        this.index.set(name, {
          key: name,
          size: info.size,
          lastUsed: info.mtimeMs,
          pinned: false,
        });
        this.totalBytes += info.size;
      } catch {
        // Unreadable entry: ignore it, it'll be re-fetched on demand.
      }
    }
  }

  private pathFor(key: string): string {
    // Hash the key so a long fileUuid + index can't produce an invalid or
    // over-length filename on any platform.
    const safe = createHash("sha256").update(key).digest("hex");
    return join(this.dir, safe);
  }

  async get(block: FileBlock): Promise<Buffer | null> {
    await this.ready;
    const key = cacheKey(block);
    const safe = createHash("sha256").update(key).digest("hex");
    const entry = this.index.get(safe);
    if (!entry) return null;

    try {
      const data = await readFile(this.pathFor(key));
      // A cached block whose length no longer matches its metadata is stale
      // (the file was rewritten). Drop it rather than serve wrong bytes.
      if (data.length !== block.logicalLength) {
        await this.evictKey(safe);
        return null;
      }
      entry.lastUsed = Date.now();
      return data;
    } catch {
      this.index.delete(safe);
      this.totalBytes -= entry.size;
      return null;
    }
  }

  async put(block: FileBlock, data: Buffer, pinned = false): Promise<void> {
    await this.ready;
    const key = cacheKey(block);
    const safe = createHash("sha256").update(key).digest("hex");

    try {
      await writeFile(this.pathFor(key), data);
    } catch {
      // A cache write failure must never fail the read that triggered it.
      return;
    }

    const previous = this.index.get(safe);
    if (previous) this.totalBytes -= previous.size;
    this.index.set(safe, {
      key: safe,
      size: data.length,
      lastUsed: Date.now(),
      pinned,
    });
    this.totalBytes += data.length;

    await this.evictIfNeeded();
  }

  /** Marks a file's cached blocks as pinned (never evicted). */
  pin(blocks: FileBlock[]): void {
    for (const block of blocks) {
      const safe = createHash("sha256")
        .update(cacheKey(block))
        .digest("hex");
      const entry = this.index.get(safe);
      if (entry) entry.pinned = true;
    }
  }

  private async evictKey(safe: string): Promise<void> {
    const entry = this.index.get(safe);
    if (!entry) return;
    await rm(join(this.dir, safe), { force: true });
    this.index.delete(safe);
    this.totalBytes -= entry.size;
  }

  private async evictIfNeeded(): Promise<void> {
    if (this.totalBytes <= this.maxBytes) return;

    const candidates = [...this.index.values()]
      .filter((e) => !e.pinned)
      .sort((a, b) => a.lastUsed - b.lastUsed);

    for (const entry of candidates) {
      if (this.totalBytes <= this.maxBytes) break;
      await this.evictKey(entry.key);
    }
  }

  /** Drops every cached block for one file (on delete or overwrite). */
  async invalidateFile(fileUuid: string, blockCount: number): Promise<void> {
    await this.ready;
    for (let i = 0; i < blockCount; i++) {
      const safe = createHash("sha256")
        .update(`${fileUuid}_b${i}`)
        .digest("hex");
      await this.evictKey(safe);
    }
  }

  async clear(): Promise<void> {
    await this.ready;
    for (const key of [...this.index.keys()]) await this.evictKey(key);
  }

  stats(): { entries: number; totalBytes: number; maxBytes: number } {
    return {
      entries: this.index.size,
      totalBytes: this.totalBytes,
      maxBytes: this.maxBytes,
    };
  }
}
