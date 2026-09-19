import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TMP_UPLOADS_DIR } from "../db/client.js";
import type {
  FileRepository,
  ProviderAccountRepository,
  SettingsRepository,
} from "../db/repository.js";
import {
  planBlocks,
  prepareBlocks,
  planAllocation,
  allocationsToBlocks,
  storeBlocks,
  resolveLogicalBlockSize,
} from "./block-router.js";
import type { BlockCache } from "./block-cache.js";
import type { AccountRegistry } from "./account-registry.js";
import type { PriorityManager } from "./priority-manager.js";
import type { CompressionAlgo, FileBlock, OmniFile } from "./models.js";

/**
 * The upload pipeline (steps 3+ of the flow: split -> compress per block ->
 * allocate -> store with retry -> record), pulled out of the REST route so
 * that every "front door" — the web UI's multipart upload AND the WebDAV
 * mount's PUT — runs the exact same code. Two copies of this would drift.
 *
 * The caller is responsible for steps 1-2: streaming the request body to
 * `stagedOriginalPath` and hashing it on the way.
 */

export interface IngestDeps {
  registry: AccountRegistry;
  priorityManager: PriorityManager;
  fileRepo: FileRepository;
  providerRepo: ProviderAccountRepository;
  settingsRepo: SettingsRepository;
  /** Called for every block status change; the REST route wires this to the SSE progress bus. */
  onBlockUpdate?: (fileUuid: string, block: FileBlock) => void;
  logWarn?: (context: object, message: string) => void;
}

export interface IngestInput {
  fileUuid: string;
  /** Path of the fully-written original bytes. Removed by ingest when it finishes. */
  stagedOriginalPath: string;
  fileName: string;
  parentFolderId?: string;
  sha256Original: string;
  /** Overrides the global default compression for this file. */
  compression?: CompressionAlgo;
}

export type IngestResult =
  | { ok: true; file: OmniFile }
  | {
      ok: false;
      reason: "insufficient_space";
      body: {
        error: string;
        unplacedBytes: number;
        accountsTried: unknown;
      };
    };

export async function ingestStagedFile(
  deps: IngestDeps,
  input: IngestInput,
): Promise<IngestResult> {
  const { fileRepo, providerRepo, settingsRepo, registry, priorityManager } = deps;
  const { fileUuid, stagedOriginalPath } = input;

  const settings = settingsRepo.get();
  const defaultCompression: CompressionAlgo = input.compression ?? settings.defaultCompression;
  const stagedBlocksPath = join(TMP_UPLOADS_DIR, `${fileUuid}.staged`);

  const originalBuffer = await readFile(stagedOriginalPath);
  const fileSize = originalBuffer.length;

  // Rank accounts BEFORE choosing a block size: the size depends on which
  // accounts could receive blocks.
  const liveAccounts = registry.all();
  const staleThreshold = Date.now() - settings.stalenessThresholdMs;
  const needsRefresh = liveAccounts.some((a) => {
    const record = providerRepo.get(a.identity.providerName, a.identity.accountIndex);
    if (!record?.lastProbedAt) return true;
    return new Date(record.lastProbedAt).getTime() < staleThreshold;
  });
  priorityManager.setAccounts(liveAccounts);
  if (needsRefresh) {
    // Best effort: stale stats only make ranking slightly worse. They must not
    // turn a perfectly storable file into a failed upload.
    await priorityManager.refreshAll().catch((err) => {
      deps.logWarn?.({ err, fileUuid }, "Pre-upload stats refresh failed; using stale stats");
    });
  }
  const rankedAccounts = priorityManager.getRankedAccounts();

  // A block is stored as one remote object, so it must fit under the
  // smallest per-object cap among accounts it could land on. This is where
  // the old per-account fragment-splitting logic went — see
  // resolveLogicalBlockSize for why dropping it entirely would have
  // silently reintroduced the Supabase 50MB rejection bug.
  const logicalBlockSize = resolveLogicalBlockSize(
    settings.defaultLogicalBlockSize,
    rankedAccounts,
  );

  // Split into blocks and compress each one independently.
  const plan = planBlocks(fileSize, logicalBlockSize);
  const prepared = await prepareBlocks(originalBuffer, plan, defaultCompression);
  const storedSizeTotal = prepared.reduce((sum, b) => sum + b.storedSize, 0);

  // Staged so a later retry can re-send an individual block.
  await writeFile(stagedBlocksPath, Buffer.concat(prepared.map((b) => b.data)));

  const baseRecord = {
    fileUuid,
    fileName: input.fileName,
    parentFolderId: input.parentFolderId,
    fileSize,
    storedSize: storedSizeTotal,
    logicalBlockSize,
    defaultCompression,
    fileUploadDate: new Date().toISOString(),
    sha256Original: input.sha256Original,
  };

  fileRepo.upsertFile({
    ...baseRecord,
    successfullyStoredSize: 0,
    status: "uploading",
  });

  // Overflow-fill allocation — abort before any network call if there
  // isn't enough total free space.
  const allocation = await planAllocation(rankedAccounts, prepared);
  if (!allocation.success) {
    fileRepo.upsertFile({
      ...baseRecord,
      successfullyStoredSize: 0,
      status: "failed",
    });
    await rm(stagedOriginalPath, { force: true });
    await rm(stagedBlocksPath, { force: true });
    return {
      ok: false,
      reason: "insufficient_space",
      body: {
        error: "Insufficient total free space across configured accounts",
        unplacedBytes: allocation.unplacedBytes,
        accountsTried: allocation.accountsTried,
      },
    };
  }

  const blocks = allocationsToBlocks(fileUuid, allocation.allocations);
  for (const block of blocks) fileRepo.upsertBlock(block);

  const byIndex = new Map(prepared.map((b) => [b.blockIndex, b.data]));

  // Concurrent store with retry, bounded concurrency.
  const result = await storeBlocks(
    allocation.allocations,
    blocks,
    async (blockIndex) => byIndex.get(blockIndex)!,
    {
      retryMaxAttempts: settings.retryMaxAttempts,
      onBlockUpdate: (block) => {
        fileRepo.upsertBlock(block);
        deps.onBlockUpdate?.(fileUuid, block);
      },
    },
  );

  fileRepo.upsertFile({
    ...baseRecord,
    successfullyStoredSize: result.successfullyStoredSize,
    status: result.allStored ? "complete" : "partial",
  });

  await rm(stagedOriginalPath, { force: true });
  if (result.allStored) {
    await rm(stagedBlocksPath, { force: true });
  }

  // Free/used space just changed on every account this upload touched —
  // refresh and persist real numbers now instead of leaving the dashboard
  // showing stale pre-upload figures.
  priorityManager.setAccounts(registry.all());
  await priorityManager.refreshAll().catch((err) => {
    deps.logWarn?.({ err, fileUuid }, "Post-upload stats refresh failed");
  });

  return { ok: true, file: fileRepo.getFile(fileUuid)! };
}

/**
 * Deletes a file completely: every block's remote object (best effort — an
 * unreachable provider must not make the file undeletable), its cached
 * blocks, and its metadata row.
 */
export async function purgeFile(
  deps: {
    registry: AccountRegistry;
    fileRepo: FileRepository;
    blockCache: BlockCache;
  },
  file: OmniFile,
): Promise<void> {
  await Promise.allSettled(
    file.blocks.map(async (block) => {
      const account = deps.registry.tryResolve(block.providerName, block.accountIndex);
      if (account) await account.delete(block);
    }),
  );

  await deps.blockCache.invalidateFile(file.fileUuid, file.blocks.length);
  deps.fileRepo.deleteFile(file.fileUuid);
}
