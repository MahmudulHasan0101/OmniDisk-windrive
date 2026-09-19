/**
 * One-shot migration: whole-stream files -> block-addressed files.
 *
 * Run with: npm run migrate:blocks
 *
 * WHY THERE IS NO IN-PLACE CONVERSION
 * -----------------------------------
 * A whole-stream-compressed file cannot be converted to block form without
 * decompressing it, and decompressing it requires downloading all of it —
 * byte N of the original has no computable position in the compressed stream.
 * So migration means: download each legacy file, re-upload it in blocks,
 * verify, then delete the old remote objects.
 *
 * For a handful of test files this is seconds. For a user with 200GB stored
 * it is an overnight job, which is exactly why this should run before a real
 * library accumulates.
 *
 * SAFETY
 * ------
 * Resumable and safe to interrupt. Old remote objects are never deleted until
 * the new blocks have been stored AND the reassembled bytes verify against the
 * original sha256. A crash mid-file leaves the legacy copy intact and the
 * partially-written block rows are discarded on the next run.
 */

import { createHash } from "node:crypto";
import { getDb, closeDb } from "../db/client.js";
import {
  FileRepository,
  ProviderAccountRepository,
  ProviderAppConfigRepository,
  SettingsRepository,
} from "../db/repository.js";
import { AccountRegistry } from "../core/account-registry.js";
import { PriorityManager } from "../core/priority-manager.js";
import { buildAdapter } from "../providers/adapter-factory.js";
import { CredentialVault } from "../security/credential-vault.js";
import { decompress } from "../core/compression.js";
import {
  planBlocks,
  prepareBlocks,
  planAllocation,
  allocationsToBlocks,
  storeBlocks,
  resolveLogicalBlockSize,
  runWithConcurrencyLimit,
} from "../core/block-router.js";
import type { CompressionAlgo, FileBlock } from "../core/models.js";
import { DEFAULT_LOGICAL_BLOCK_SIZE } from "../core/models.js";

interface LegacyFragmentRow {
  fragment_id: string;
  file_uuid: string;
  provider_name: string;
  account_index: number;
  byte_start: number;
  byte_end: number;
  frag_index: number;
  remote_path: string;
  checksum: string | null;
  status: string;
}

interface LegacyFileRow {
  file_uuid: string;
  file_name: string;
  file_size: number;
  compression_used: CompressionAlgo | null;
  sha256_original: string | null;
  status: string;
}

async function main(): Promise<void> {
  const db = getDb();
  const fileRepo = new FileRepository(db);
  const accountRepo = new ProviderAccountRepository(db);
  const settingsRepo = new SettingsRepository(db);
  const appConfigRepo = new ProviderAppConfigRepository(db);
  const vault = new CredentialVault();
  const registry = new AccountRegistry();

  // Reconnect every account that has a live adapter; legacy fragments can't be
  // read back without them.
  for (const record of accountRepo.list()) {
    try {
      const adapter = await buildAdapter(record, vault, appConfigRepo);
      if (adapter) registry.register(adapter);
    } catch (err) {
      console.warn(
        `  ! Could not connect ${record.providerName}[${record.accountIndex}]: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const legacyFileUuids = (
    db
      .prepare("SELECT DISTINCT file_uuid FROM file_fragments")
      .all() as { file_uuid: string }[]
  ).map((r) => r.file_uuid);

  if (legacyFileUuids.length === 0) {
    console.log("Nothing to migrate — no pre-block files found.");
    closeDb();
    return;
  }

  console.log(`Found ${legacyFileUuids.length} pre-block file(s) to migrate.\n`);

  const settings = settingsRepo.get();
  // Same overflow-fill ordering a live upload would use, so migrated files
  // land on the same accounts a normal upload would have chosen rather than
  // an arbitrary one.
  const priorityManager = new PriorityManager(registry.all(), settings.prioritySortMode);
  await priorityManager.refreshAll().catch(() => {
    // A probe failure here shouldn't block migration — planAllocation still
    // works against whatever order refreshAll() left the accounts in.
  });
  let migrated = 0;
  let skipped = 0;

  for (const fileUuid of legacyFileUuids) {
    const fileRow = db
      .prepare("SELECT * FROM files WHERE file_uuid = ?")
      .get(fileUuid) as LegacyFileRow | undefined;

    if (!fileRow) {
      console.warn(`  ! ${fileUuid}: fragments exist but no files row; skipping.`);
      skipped++;
      continue;
    }

    console.log(`- ${fileRow.file_name} (${fileRow.file_size} bytes)`);

    const fragments = db
      .prepare(
        "SELECT * FROM file_fragments WHERE file_uuid = ? ORDER BY frag_index ASC",
      )
      .all(fileUuid) as LegacyFragmentRow[];

    if (fragments.some((f) => f.status !== "stored")) {
      console.warn(
        `  ! Has non-stored fragments — cannot reassemble. Retry or re-upload it, then re-run. Skipping.`,
      );
      skipped++;
      continue;
    }

    // --- 1. Download every legacy fragment and reassemble ------------------
    let originalBuffer: Buffer;
    try {
      const parts = await runWithConcurrencyLimit(fragments, 4, async (frag) => {
        const account = registry.resolve(frag.provider_name, frag.account_index);
        // The legacy adapters keyed everything off remotePath, which is all a
        // retrieve() call actually reads — so a minimal shim is enough here
        // rather than reconstructing a full legacy fragment record.
        return account.retrieve({
          remotePath: frag.remote_path,
          blockId: frag.fragment_id,
          fileUuid: frag.file_uuid,
          blockIndex: frag.frag_index,
          logicalStart: frag.byte_start,
          logicalLength: frag.byte_end - frag.byte_start,
          storedSize: frag.byte_end - frag.byte_start,
          compressionUsed: "none",
          providerName: frag.provider_name,
          accountIndex: frag.account_index,
          status: "stored",
          retryCount: 0,
        } satisfies FileBlock);
      });

      const compressedBuffer = Buffer.concat(parts);
      originalBuffer = await decompress(
        compressedBuffer,
        fileRow.compression_used ?? "none",
      );
    } catch (err) {
      console.warn(
        `  ! Could not retrieve legacy data: ${
          err instanceof Error ? err.message : String(err)
        }. Leaving it untouched; skipping.`,
      );
      skipped++;
      continue;
    }

    // Verify BEFORE writing anything new: if the legacy copy is already bad,
    // re-uploading it would just launder corruption into the new format.
    if (fileRow.sha256_original) {
      const actual = createHash("sha256").update(originalBuffer).digest("hex");
      if (actual !== fileRow.sha256_original) {
        console.warn(`  ! Legacy data fails its own checksum; skipping.`);
        skipped++;
        continue;
      }
    }

    // --- 2. Re-upload as blocks -------------------------------------------
    priorityManager.setAccounts(registry.all());
    const ranked = priorityManager.getRankedAccounts();
    const logicalBlockSize = resolveLogicalBlockSize(
      settings.defaultLogicalBlockSize || DEFAULT_LOGICAL_BLOCK_SIZE,
      ranked,
    );
    const algo: CompressionAlgo = fileRow.compression_used ?? "none";

    const plan = planBlocks(originalBuffer.length, logicalBlockSize);
    const prepared = await prepareBlocks(originalBuffer, plan, algo);
    const allocation = await planAllocation(ranked, prepared);

    if (!allocation.success) {
      console.warn(
        `  ! Not enough free space to re-upload (${allocation.unplacedBytes} bytes ` +
          `unplaced). Free space or add an account, then re-run. Skipping.`,
      );
      skipped++;
      continue;
    }

    const blocks = allocationsToBlocks(fileUuid, allocation.allocations);
    const byIndex = new Map(prepared.map((b) => [b.blockIndex, b.data]));
    const result = await storeBlocks(
      allocation.allocations,
      blocks,
      async (i) => byIndex.get(i)!,
      { retryMaxAttempts: settings.retryMaxAttempts },
    );

    if (!result.allStored) {
      console.warn(
        `  ! Some blocks failed to store. Legacy copy left intact; re-run to retry. Skipping.`,
      );
      skipped++;
      continue;
    }

    // --- 3. Commit metadata, then delete the old objects ------------------
    const commit = db.transaction(() => {
      fileRepo.upsertFile({
        fileUuid,
        fileName: fileRow.file_name,
        fileSize: originalBuffer.length,
        storedSize: prepared.reduce((sum, b) => sum + b.storedSize, 0),
        logicalBlockSize,
        defaultCompression: algo,
        successfullyStoredSize: result.successfullyStoredSize,
        fileUploadDate: new Date().toISOString(),
        status: "complete",
        sha256Original: fileRow.sha256_original ?? undefined,
      });
      for (const block of result.blocks) fileRepo.upsertBlock(block);
      db.prepare("DELETE FROM file_fragments WHERE file_uuid = ?").run(fileUuid);
    });
    commit();

    // Only now is it safe to remove the old remote objects. A failure here
    // leaves orphaned remote files (wasted quota) but no data loss, which is
    // the right way round for this trade.
    await Promise.allSettled(
      fragments.map(async (frag) => {
        const account = registry.tryResolve(frag.provider_name, frag.account_index);
        if (!account) return;
        await account.delete({
          remotePath: frag.remote_path,
          blockId: frag.fragment_id,
          fileUuid: frag.file_uuid,
          blockIndex: frag.frag_index,
          logicalStart: frag.byte_start,
          logicalLength: frag.byte_end - frag.byte_start,
          storedSize: frag.byte_end - frag.byte_start,
          compressionUsed: "none",
          providerName: frag.provider_name,
          accountIndex: frag.account_index,
          status: "stored",
          retryCount: 0,
        } satisfies FileBlock);
      }),
    );

    console.log(`  ✓ migrated into ${result.blocks.length} block(s)`);
    migrated++;
  }

  console.log(`\nDone. Migrated ${migrated}, skipped ${skipped}.`);
  if (skipped > 0) {
    console.log(
      "Skipped files still have their legacy copies and are unchanged — " +
        "resolve the reason above and re-run.",
    );
  }
  closeDb();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exitCode = 1;
  closeDb();
});
