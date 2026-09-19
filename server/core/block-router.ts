import { createHash } from "node:crypto";
import type { ProviderAccountBase } from "./provider-account-base.js";
import type {
  BlockStatus,
  CompressionAlgo,
  FileBlock,
  ProviderAccountIdentity,
} from "./models.js";
import { compressBlock, decompress } from "./compression.js";

// ---------------------------------------------------------------------------
// Block planning
// ---------------------------------------------------------------------------

export interface BlockPlanEntry {
  blockIndex: number;
  logicalStart: number;
  logicalLength: number;
}

/**
 * Splits a logical byte length into fixed-size blocks. The final block is
 * short unless the file divides evenly.
 */
export function planBlocks(
  fileSize: number,
  logicalBlockSize: number,
): BlockPlanEntry[] {
  if (logicalBlockSize <= 0) {
    throw new Error(`logicalBlockSize must be positive, got ${logicalBlockSize}`);
  }

  // A zero-byte file still gets exactly one (empty) block, so that every file
  // has at least one row to carry its provider assignment and status. Without
  // this, an empty file would have no blocks and could never reach "complete".
  if (fileSize === 0) {
    return [{ blockIndex: 0, logicalStart: 0, logicalLength: 0 }];
  }

  const entries: BlockPlanEntry[] = [];
  for (let start = 0, i = 0; start < fileSize; start += logicalBlockSize, i++) {
    entries.push({
      blockIndex: i,
      logicalStart: start,
      logicalLength: Math.min(logicalBlockSize, fileSize - start),
    });
  }
  return entries;
}

/**
 * Picks a logical block size that no candidate account will reject.
 *
 * A block is stored as exactly one remote object, so no block may exceed the
 * smallest per-object cap among the accounts it could land on (Supabase
 * Storage's 50MB free-tier limit is the live example; GitHub's Contents API
 * caps at ~100MB). Compression only shrinks a block, so bounding the LOGICAL
 * size is the conservative check.
 *
 * This is where the old per-account fragment-splitting logic went. Deleting
 * that loop without adding this check would silently reintroduce the Supabase
 * rejection bug, with no error until an upload failed mid-transfer.
 */
export function resolveLogicalBlockSize(
  requestedSize: number,
  candidateAccounts: ProviderAccountBase[],
): number {
  const hardestCap = candidateAccounts
    .map((a) => a.maxSingleObjectBytes)
    .filter((c): c is number => typeof c === "number" && c > 0)
    .reduce((min, c) => Math.min(min, c), Number.POSITIVE_INFINITY);

  if (!Number.isFinite(hardestCap) || requestedSize <= hardestCap) {
    return requestedSize;
  }

  // Round down to a power of two at or below the cap: keeps block boundaries
  // aligned and the offset arithmetic cheap.
  let size = 1;
  while (size * 2 <= hardestCap) size *= 2;
  return size;
}

// ---------------------------------------------------------------------------
// Allocation (upload pipeline step 5: overflow-fill, block-granular)
// ---------------------------------------------------------------------------

export interface BlockAllocation {
  account: ProviderAccountBase;
  blockIndex: number;
  logicalStart: number;
  logicalLength: number;
  storedSize: number; // post-compression size, what actually consumes quota
  compressionUsed: CompressionAlgo;
}

export interface AllocationResult {
  allocations: BlockAllocation[];
  success: boolean;
  /** Stored bytes that could not be placed anywhere. Zero iff success. */
  unplacedBytes: number;
  /** Every account the planner considered, in the order it tried them. */
  accountsTried: ProviderAccountIdentity[];
}

/** A block that has been compressed and is ready to be placed. */
export interface PreparedBlock extends BlockPlanEntry {
  data: Buffer; // post-compression bytes to upload
  storedSize: number;
  compressionUsed: CompressionAlgo;
}

/**
 * Compresses every block of a buffer, deciding per-block whether compression
 * pays (see compressBlock).
 */
export async function prepareBlocks(
  source: Buffer,
  plan: BlockPlanEntry[],
  algo: CompressionAlgo,
): Promise<PreparedBlock[]> {
  const prepared: PreparedBlock[] = [];
  for (const entry of plan) {
    const raw = source.subarray(
      entry.logicalStart,
      entry.logicalStart + entry.logicalLength,
    );
    const { data, algoUsed } = await compressBlock(raw, algo);
    prepared.push({
      ...entry,
      data,
      storedSize: data.length,
      compressionUsed: algoUsed,
    });
  }
  return prepared;
}

/**
 * Walks ranked accounts in order, assigning as many WHOLE blocks as each
 * account's free space can hold before spilling to the next.
 *
 * Blocks are indivisible units of allocation. This is the one behavioural
 * change versus the old byte-range allocator: an account is filled to the
 * largest whole number of blocks that fits, and any sub-block remainder of
 * its free space goes unused rather than being split across two accounts.
 * At a 4MB block size the waste is at most ~4MB per account, negligible
 * against multi-GB tiers, and in exchange every block is independently
 * addressable and independently retryable.
 *
 * Performs no network transfer — a pure planning pass, so an
 * insufficient-space situation is reported BEFORE anything is sent anywhere.
 */
export async function planAllocation(
  rankedAccounts: ProviderAccountBase[],
  blocks: PreparedBlock[],
): Promise<AllocationResult> {
  const allocations: BlockAllocation[] = [];
  const accountsTried: ProviderAccountIdentity[] = [];

  let cursor = 0; // index of the next block needing a home

  for (const account of rankedAccounts) {
    if (cursor >= blocks.length) break;

    let free = await account.getStorableSpace();
    accountsTried.push(account.identity);
    if (free <= 0) continue; // capacity-exhausted account: skip to the next

    // A block larger than this account's per-object cap can never be stored
    // here regardless of free space. resolveLogicalBlockSize() should have
    // prevented this, but an account added mid-upload could still trip it.
    const cap = account.maxSingleObjectBytes;

    while (cursor < blocks.length) {
      const block = blocks[cursor]!;
      if (block.storedSize > free) break; // not enough room for a whole block
      if (cap && cap > 0 && block.storedSize > cap) break; // too big for this provider

      allocations.push({
        account,
        blockIndex: block.blockIndex,
        logicalStart: block.logicalStart,
        logicalLength: block.logicalLength,
        storedSize: block.storedSize,
        compressionUsed: block.compressionUsed,
      });
      free -= block.storedSize;
      cursor++;
    }
  }

  const unplacedBytes = blocks
    .slice(cursor)
    .reduce((sum, b) => sum + b.storedSize, 0);

  return {
    allocations,
    success: cursor === blocks.length,
    unplacedBytes,
    accountsTried,
  };
}

/** Builds the DB-ready FileBlock records for a successful allocation. */
export function allocationsToBlocks(
  fileUuid: string,
  allocations: BlockAllocation[],
): FileBlock[] {
  return allocations.map((alloc) => {
    const { providerName, accountIndex } = alloc.account.identity;
    return {
      blockId: `${fileUuid}_b${alloc.blockIndex}`,
      fileUuid,
      blockIndex: alloc.blockIndex,
      logicalStart: alloc.logicalStart,
      logicalLength: alloc.logicalLength,
      storedSize: alloc.storedSize,
      compressionUsed: alloc.compressionUsed,
      providerName,
      accountIndex,
      // Keyed by block index alone: stable, collision-free, and independent of
      // which account the block happens to land on (so a future rebalance can
      // move a block between accounts without renaming the remote object).
      remotePath: `${fileUuid}/b${alloc.blockIndex}`,
      status: "pending" as BlockStatus,
      retryCount: 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Bounded concurrency helper (shared by store + retrieve)
// ---------------------------------------------------------------------------

/**
 * Runs `worker` over `items` with at most `limit` in flight at once.
 * Results are returned in the same order as `items`, regardless of
 * completion order.
 */
export async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    const i = nextIndex++;
    if (i >= items.length) return;
    results[i] = await worker(items[i]!, i);
    await runNext();
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    runNext(),
  );
  await Promise.all(workers);
  return results;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<R>(
  fn: () => Promise<R>,
  maxAttempts: number,
  onAttemptFailed?: (attempt: number, err: unknown) => void,
): Promise<R> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      onAttemptFailed?.(attempt, err);
      if (attempt < maxAttempts) {
        const backoffMs = 2 ** attempt * 250; // exponential backoff
        await sleep(backoffMs);
      }
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Upload pipeline, steps 6-9: concurrent store with retry
// ---------------------------------------------------------------------------

export interface StoreOptions {
  /** Simultaneous transfers, bounded to avoid saturating local bandwidth. */
  concurrencyLimit?: number; // default 4
  retryMaxAttempts?: number; // default 3
  onBlockUpdate?: (block: FileBlock) => void | Promise<void>;
}

export interface StoreRunResult {
  blocks: FileBlock[];
  allStored: boolean;
  /** Sum of LOGICAL length over stored blocks — progress against fileSize. */
  successfullyStoredSize: number;
}

/**
 * Stores each block to its assigned account, concurrently across accounts
 * (bounded), with per-block exponential-backoff retry. Calls `onBlockUpdate`
 * after every status change so the caller can persist it and push SSE progress.
 *
 * `readBlock` returns the POST-compression bytes for a block index.
 */
export async function storeBlocks(
  allocations: BlockAllocation[],
  blocks: FileBlock[],
  readBlock: (blockIndex: number) => Promise<Buffer>,
  options: StoreOptions = {},
): Promise<StoreRunResult> {
  const concurrencyLimit = options.concurrencyLimit ?? 4;
  const retryMaxAttempts = options.retryMaxAttempts ?? 3;
  const byIndex = new Map(blocks.map((b) => [b.blockIndex, b]));

  const updated = await runWithConcurrencyLimit(
    allocations,
    concurrencyLimit,
    async (alloc) => {
      const block = byIndex.get(alloc.blockIndex)!;
      const data = await readBlock(alloc.blockIndex);
      const checksum = createHash("sha256").update(data).digest("hex");

      try {
        await withRetry(
          async () => {
            await alloc.account.store(block, data);
          },
          retryMaxAttempts,
          (attempt, err) => {
            block.retryCount = attempt;
            block.lastError = err instanceof Error ? err.message : String(err);
          },
        );

        block.status = "stored";
        block.checksum = checksum;
      } catch (err) {
        block.status = "failed";
        block.lastError = err instanceof Error ? err.message : String(err);
      }

      await options.onBlockUpdate?.(block);
      return block;
    },
  );

  const allStored = updated.every((b) => b.status === "stored");
  const successfullyStoredSize = updated
    .filter((b) => b.status === "stored")
    .reduce((sum, b) => sum + b.logicalLength, 0);

  return { blocks: updated, allStored, successfullyStoredSize };
}

/**
 * Retries only the blocks currently in "failed" status.
 *
 * Under block-addressing this is genuinely incremental: one bad block no
 * longer jeopardizes the whole file, and only that block is re-sent.
 */
export async function retryFailedBlocks(
  blocks: FileBlock[],
  resolveAccount: (
    providerName: string,
    accountIndex: number,
  ) => ProviderAccountBase,
  readBlock: (blockIndex: number) => Promise<Buffer>,
  options: StoreOptions = {},
): Promise<StoreRunResult> {
  const failed = blocks.filter((b) => b.status === "failed");
  const allocations: BlockAllocation[] = failed.map((b) => ({
    account: resolveAccount(b.providerName, b.accountIndex),
    blockIndex: b.blockIndex,
    logicalStart: b.logicalStart,
    logicalLength: b.logicalLength,
    storedSize: b.storedSize,
    compressionUsed: b.compressionUsed,
  }));

  return storeBlocks(allocations, blocks, readBlock, options);
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

export type AccountResolver = (
  providerName: string,
  accountIndex: number,
) => ProviderAccountBase;

/**
 * Fetches one block, verifies it, and decompresses it using THAT BLOCK's own
 * algorithm (not the file's default — they differ whenever compressBlock
 * decided a block was incompressible).
 */
export async function fetchBlock(
  block: FileBlock,
  resolveAccount: AccountResolver,
): Promise<Buffer> {
  const account = resolveAccount(block.providerName, block.accountIndex);
  const stored = await account.retrieve(block);

  // Catch a corrupted/truncated block here, naming exactly which provider
  // account and block is bad, rather than letting a mangled buffer flow into
  // decompress() and surface as an opaque library error ("zstd: incomplete
  // frame") with no indication of where the real problem is.
  if (block.storedSize > 0 && stored.length !== block.storedSize) {
    throw new Error(
      `Block ${block.blockId} came back the wrong size from ` +
        `${block.providerName} (account ${block.accountIndex}): ` +
        `expected ${block.storedSize} bytes, got ${stored.length}. The remote ` +
        `copy is likely truncated or corrupted — try Retry, which re-uploads ` +
        `this block from the original staged data.`,
    );
  }

  if (block.checksum) {
    const actual = createHash("sha256").update(stored).digest("hex");
    if (actual !== block.checksum) {
      throw new Error(
        `Block ${block.blockId} failed checksum verification after ` +
          `downloading from ${block.providerName} (account ` +
          `${block.accountIndex}) — the stored copy doesn't match what was ` +
          `originally uploaded. Try Retry to re-upload this block.`,
      );
    }
  }

  const plain = await decompress(stored, block.compressionUsed);

  if (plain.length !== block.logicalLength) {
    throw new Error(
      `Block ${block.blockId} decompressed to ${plain.length} bytes but the ` +
        `metadata says ${block.logicalLength}. The stored copy or its ` +
        `metadata is inconsistent — re-upload this file.`,
    );
  }

  return plain;
}

export interface ReadRangeOptions {
  concurrencyLimit?: number; // default 4
  /** Optional cache hook; return null on a miss. */
  getCached?: (block: FileBlock) => Promise<Buffer | null>;
  putCached?: (block: FileBlock, data: Buffer) => Promise<void>;
}

/**
 * Reads an arbitrary byte range out of a block-addressed file.
 *
 * This is the function the whole block redesign exists for, and the one the
 * mount layer sits on. A 64KB read at offset 9.4GB touches exactly one block:
 *
 *     blockIndex = Math.floor(offset / logicalBlockSize)
 *
 * The old whole-stream design could not serve this at all without fetching and
 * decompressing the entire file first.
 *
 * `blocks` must be the file's blocks sorted by blockIndex.
 */
export async function readRange(
  blocks: FileBlock[],
  logicalBlockSize: number,
  fileSize: number,
  offset: number,
  length: number,
  resolveAccount: AccountResolver,
  options: ReadRangeOptions = {},
): Promise<Buffer> {
  if (offset < 0) throw new Error(`offset must be >= 0, got ${offset}`);
  if (length < 0) throw new Error(`length must be >= 0, got ${length}`);
  if (offset >= fileSize || length === 0) return Buffer.alloc(0);

  // Clamp to EOF: a reader asking for more than remains gets what remains,
  // which is what a real filesystem read does.
  const effectiveLength = Math.min(length, fileSize - offset);
  const endOffsetExclusive = offset + effectiveLength;

  const startBlock = Math.floor(offset / logicalBlockSize);
  const endBlock = Math.floor((endOffsetExclusive - 1) / logicalBlockSize);

  const needed = blocks.filter(
    (b) => b.blockIndex >= startBlock && b.blockIndex <= endBlock,
  );

  const missing = endBlock - startBlock + 1 - needed.length;
  if (missing > 0) {
    throw new Error(
      `Range ${offset}..${endOffsetExclusive} needs blocks ${startBlock}..${endBlock} ` +
        `but ${missing} of them are missing from this file's metadata.`,
    );
  }
  const notStored = needed.filter((b) => b.status !== "stored");
  if (notStored.length > 0) {
    throw new Error(
      `Cannot read this range: block(s) ${notStored
        .map((b) => b.blockIndex)
        .join(", ")} are not stored (status: ${notStored[0]!.status}). ` +
        `Retry the failed blocks first.`,
    );
  }

  const fetched = await runWithConcurrencyLimit(
    needed,
    options.concurrencyLimit ?? 4,
    async (block) => {
      const cached = await options.getCached?.(block);
      if (cached) return cached;
      const data = await fetchBlock(block, resolveAccount);
      await options.putCached?.(block, data);
      return data;
    },
  );

  const parts: Buffer[] = [];
  for (let i = 0; i < needed.length; i++) {
    const block = needed[i]!;
    const data = fetched[i]!;
    const blockStart = block.logicalStart;
    const blockEnd = blockStart + block.logicalLength;

    const sliceFrom = Math.max(0, offset - blockStart);
    const sliceTo = Math.min(block.logicalLength, endOffsetExclusive - blockStart);
    if (sliceTo > sliceFrom) parts.push(data.subarray(sliceFrom, sliceTo));

    void blockEnd;
  }

  return Buffer.concat(parts);
}

/**
 * Streams every block in order for a full-file download.
 *
 * Fetches with bounded concurrency but emits strictly in blockIndex order,
 * buffering any block that arrives before its turn. Each block is decompressed
 * individually, so bytes can be emitted before the whole file is retrieved —
 * something the whole-stream design could not do, since it needed the entire
 * compressed stream in hand before decompression could finish.
 */
export async function retrieveBlocksInOrder(
  blocks: FileBlock[], // must be sorted by blockIndex ascending
  resolveAccount: AccountResolver,
  onChunk: (chunk: Buffer, block: FileBlock) => void | Promise<void>,
  options: { concurrencyLimit?: number } = {},
): Promise<void> {
  const concurrencyLimit = options.concurrencyLimit ?? 4;
  const pending = new Map<number, Buffer>();
  let nextToEmit = 0;

  async function drain(): Promise<void> {
    while (pending.has(nextToEmit)) {
      const chunk = pending.get(nextToEmit)!;
      pending.delete(nextToEmit);
      await onChunk(chunk, blocks[nextToEmit]!);
      nextToEmit++;
    }
  }

  await runWithConcurrencyLimit(blocks, concurrencyLimit, async (block, i) => {
    const data = await fetchBlock(block, resolveAccount);
    pending.set(i, data);
    await drain();
  });
}

/** Verifies reassembled bytes against the recorded original checksum. */
export function verifyIntegrity(data: Buffer, sha256Original: string): boolean {
  const actual = createHash("sha256").update(data).digest("hex");
  return actual === sha256Original;
}
