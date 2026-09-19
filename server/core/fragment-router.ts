import { createHash } from "node:crypto";
import type { ProviderAccountBase } from "./provider-account-base.js";
import type {
  FileFragment,
  FragmentStatus,
  ProviderAccountIdentity,
} from "./models.js";

// ---------------------------------------------------------------------------
// Allocation (upload pipeline, step 5: overflow-fill allocation)
// ---------------------------------------------------------------------------

export interface AllocationSegment {
  account: ProviderAccountBase;
  byteStart: number;
  byteEnd: number; // exclusive
  index: number;
}

export interface AllocationResult {
  segments: AllocationSegment[];
  success: boolean;
  /** Bytes that could not be placed anywhere. Zero iff success is true. */
  unplacedBytes: number;
  /** Every account the planner considered, in the order it tried them. */
  accountsTried: ProviderAccountIdentity[];
}

/**
 * Walks ranked accounts in order; for each, checks free space and assigns
 * min(freeSpace, remainingBytes) to that account as one segment. Continues
 * until remainingBytes === 0 or accounts are exhausted.
 *
 * Performs no network transfer — this is a pure planning pass so that an
 * insufficient-space situation can be reported to the UI (see
 * `AllocationResult.success`/`unplacedBytes`) **before** any fragment is
 * actually sent anywhere, per spec section 8 step 5.
 */
export async function planAllocation(
  rankedAccounts: ProviderAccountBase[],
  totalBytes: number,
): Promise<AllocationResult> {
  const segments: AllocationSegment[] = [];
  const accountsTried: ProviderAccountIdentity[] = [];
  let remaining = totalBytes;
  let cursor = 0;

  for (const account of rankedAccounts) {
    if (remaining <= 0) break;

    const free = await account.getStorableSpace();
    accountsTried.push(account.identity);

    if (free <= 0) continue; // capacity-exhausted account: skip to the next

    const assigned = Math.min(free, remaining);

    // Some providers hard-reject anything over a fixed per-object size
    // (e.g. Supabase Storage's 50MB/file free-tier cap) — split this
    // account's assigned bytes into multiple fragments no larger than
    // that, all still routed to the same account, instead of one
    // fragment the provider would simply refuse.
    const cap = account.maxSingleObjectBytes;
    if (cap && cap > 0 && assigned > cap) {
      let remainingForAccount = assigned;
      while (remainingForAccount > 0) {
        const chunkSize = Math.min(cap, remainingForAccount);
        segments.push({
          account,
          byteStart: cursor,
          byteEnd: cursor + chunkSize,
          index: segments.length,
        });
        cursor += chunkSize;
        remainingForAccount -= chunkSize;
      }
    } else {
      segments.push({
        account,
        byteStart: cursor,
        byteEnd: cursor + assigned,
        index: segments.length,
      });
      cursor += assigned;
    }

    remaining -= assigned;
  }

  return {
    segments,
    success: remaining === 0,
    unplacedBytes: remaining,
    accountsTried,
  };
}

/** Builds the DB-ready FileFragment records for a successful allocation. */
export function segmentsToFragments(
  fileUuid: string,
  segments: AllocationSegment[],
): FileFragment[] {
  return segments.map((seg) => {
    const { providerName, accountIndex } = seg.account.identity;
    return {
      fragmentId: `${fileUuid}_${providerName}_${accountIndex}_${seg.index}`,
      fileUuid,
      providerName,
      accountIndex,
      byteStart: seg.byteStart,
      byteEnd: seg.byteEnd,
      index: seg.index,
      // seg.index is included (not just providerName_accountIndex) because
      // a single account can now produce multiple fragments when
      // maxSingleObjectBytes splits its allocation — without this they'd
      // collide on the same remote name.
      remotePath: `${fileUuid}/${providerName}_${accountIndex}_${seg.index}`,
      status: "pending" as FragmentStatus,
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
  onFragmentUpdate?: (fragment: FileFragment) => void | Promise<void>;
}

export interface StoreRunResult {
  fragments: FileFragment[];
  allStored: boolean;
  successfullyStoredSize: number;
}

/**
 * Stores each planned segment to its account, concurrently across distinct
 * accounts (bounded), with per-fragment exponential-backoff retry. Calls
 * `onFragmentUpdate` after every status change so the caller can persist
 * it and push SSE progress.
 */
export async function storeFragments(
  segments: AllocationSegment[],
  fragments: FileFragment[],
  readRange: (byteStart: number, byteEnd: number) => Promise<Buffer>,
  options: StoreOptions = {},
): Promise<StoreRunResult> {
  const concurrencyLimit = options.concurrencyLimit ?? 4;
  const retryMaxAttempts = options.retryMaxAttempts ?? 3;

  const updated = await runWithConcurrencyLimit(
    segments,
    concurrencyLimit,
    async (segment) => {
      const fragment = fragments[segment.index]!;
      const data = await readRange(segment.byteStart, segment.byteEnd);
      const checksum = createHash("sha256").update(data).digest("hex");

      try {
        await withRetry(
          async () => {
            await segment.account.store(fragment, data);
          },
          retryMaxAttempts,
          (attempt, err) => {
            fragment.retryCount = attempt;
            fragment.lastError = err instanceof Error ? err.message : String(err);
          },
        );

        fragment.status = "stored";
        fragment.checksum = checksum;
      } catch (err) {
        fragment.status = "failed";
        fragment.lastError = err instanceof Error ? err.message : String(err);
      }

      await options.onFragmentUpdate?.(fragment);
      return fragment;
    },
  );

  const allStored = updated.every((f) => f.status === "stored");
  const successfullyStoredSize = updated
    .filter((f) => f.status === "stored")
    .reduce((sum, f) => sum + (f.byteEnd - f.byteStart), 0);

  return { fragments: updated, allStored, successfullyStoredSize };
}

/** Retries only the fragments currently in "failed" status. */
export async function retryFailedFragments(
  fragments: FileFragment[],
  resolveAccount: (
    providerName: string,
    accountIndex: number,
  ) => ProviderAccountBase,
  readRange: (byteStart: number, byteEnd: number) => Promise<Buffer>,
  options: StoreOptions = {},
): Promise<StoreRunResult> {
  const failed = fragments.filter((f) => f.status === "failed");
  const segments: AllocationSegment[] = failed.map((f) => ({
    account: resolveAccount(f.providerName, f.accountIndex),
    byteStart: f.byteStart,
    byteEnd: f.byteEnd,
    index: fragments.indexOf(f),
  }));

  return storeFragments(segments, fragments, readRange, options);
}

// ---------------------------------------------------------------------------
// Download pipeline, steps 1-6
// ---------------------------------------------------------------------------

export interface RetrieveOptions {
  concurrencyLimit?: number; // default 4
}

/**
 * Fetches fragments with bounded concurrency but writes them to the
 * output stream strictly in `index` order, buffering any fragment that
 * arrives before its turn. This keeps transfer parallel while preserving
 * the byte ordering required to reassemble the file.
 */
export async function retrieveFragmentsInOrder(
  fragments: FileFragment[], // must be sorted by index ascending
  resolveAccount: (
    providerName: string,
    accountIndex: number,
  ) => ProviderAccountBase,
  onChunk: (chunk: Buffer, fragment: FileFragment) => void | Promise<void>,
  options: RetrieveOptions = {},
): Promise<void> {
  const concurrencyLimit = options.concurrencyLimit ?? 4;
  const buffer = new Map<number, Buffer>();
  let nextToEmit = 0;

  async function drainBuffer(): Promise<void> {
    while (buffer.has(nextToEmit)) {
      const chunk = buffer.get(nextToEmit)!;
      buffer.delete(nextToEmit);
      await onChunk(chunk, fragments[nextToEmit]!);
      nextToEmit++;
    }
  }

  await runWithConcurrencyLimit(fragments, concurrencyLimit, async (fragment) => {
    const account = resolveAccount(fragment.providerName, fragment.accountIndex);
    const data = await account.retrieve(fragment);

    // Catch a corrupted/truncated fragment here, with a message that names
    // exactly which provider account and fragment is bad, rather than
    // letting a mangled buffer flow into decompress() and surface as an
    // opaque, unrelated-looking library error (e.g. "zstd: incomplete
    // frame") with no indication of where the actual problem is.
    const expectedBytes = fragment.byteEnd - fragment.byteStart;
    if (data.length !== expectedBytes) {
      throw new Error(
        `Fragment ${fragment.fragmentId} came back the wrong size from ` +
          `${fragment.providerName} (account ${fragment.accountIndex}): ` +
          `expected ${expectedBytes} bytes, got ${data.length}. The remote ` +
          `copy is likely truncated or corrupted — try Retry, which ` +
          `re-uploads this fragment from the original staged data.`,
      );
    }
    if (fragment.checksum) {
      const actualChecksum = createHash("sha256").update(data).digest("hex");
      if (actualChecksum !== fragment.checksum) {
        throw new Error(
          `Fragment ${fragment.fragmentId} failed checksum verification ` +
            `after downloading from ${fragment.providerName} (account ` +
            `${fragment.accountIndex}) — the stored copy doesn't match what ` +
            `was originally uploaded. Try Retry to re-upload this fragment.`,
        );
      }
    }

    buffer.set(fragment.index, data);
    await drainBuffer();
  });
}

/** Verifies reassembled bytes against the recorded original checksum. */
export function verifyIntegrity(data: Buffer, sha256Original: string): boolean {
  const actual = createHash("sha256").update(data).digest("hex");
  return actual === sha256Original;
}
