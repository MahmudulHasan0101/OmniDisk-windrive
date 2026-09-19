import type Database from "better-sqlite3";
import type {
  OmniFile,
  FileBlock,
  Folder,
  HydrationPolicy,
  ProviderAccountRecord,
  ProviderAppConfigRecord,
  GlobalSettings,
} from "../core/models.js";
import { DEFAULT_SETTINGS } from "../core/models.js";

// ---------------------------------------------------------------------------
// Row <-> model mapping (snake_case columns <-> camelCase TS fields)
// ---------------------------------------------------------------------------

interface FileRow {
  file_uuid: string;
  file_name: string;
  parent_folder_id: string | null;
  file_size: number;
  stored_size: number | null;
  logical_block_size: number;
  default_compression: OmniFile["defaultCompression"];
  successfully_stored_size: number;
  file_upload_date: string;
  status: OmniFile["status"];
  sha256_original: string | null;
  hydration_policy: HydrationPolicy | null;
}

interface BlockRow {
  block_id: string;
  file_uuid: string;
  block_index: number;
  logical_start: number;
  logical_length: number;
  stored_size: number;
  compression_used: FileBlock["compressionUsed"];
  provider_name: string;
  account_index: number;
  remote_path: string;
  checksum: string | null;
  status: FileBlock["status"];
  retry_count: number;
  last_error: string | null;
}

interface FolderRow {
  folder_id: string;
  folder_name: string;
  parent_folder_id: string | null;
  created_at: string;
}

interface ProviderAccountRow {
  provider_name: string;
  account_index: number;
  label: string | null;
  base_url: string | null;
  auth_type: ProviderAccountRecord["authType"];
  credential_ref: string;
  total_space: number | null;
  used_space: number | null;
  avg_latency_ms: number;
  avg_speed_bps: number;
  priority_score: number;
  manual_priority_rank: number | null;
  enabled: number;
  last_probed_at: string | null;
  is_live_quota: number;
  is_billed_provider: number;
  configured_cap_bytes: number | null;
  max_single_object_bytes: number | null;
}

function blockRowToModel(row: BlockRow): FileBlock {
  return {
    blockId: row.block_id,
    fileUuid: row.file_uuid,
    blockIndex: row.block_index,
    logicalStart: row.logical_start,
    logicalLength: row.logical_length,
    storedSize: row.stored_size,
    compressionUsed: row.compression_used,
    providerName: row.provider_name,
    accountIndex: row.account_index,
    remotePath: row.remote_path,
    checksum: row.checksum ?? undefined,
    status: row.status,
    retryCount: row.retry_count,
    lastError: row.last_error ?? undefined,
  };
}

function fileRowToSummary(row: FileRow): Omit<OmniFile, "blocks"> {
  return {
    fileUuid: row.file_uuid,
    fileName: row.file_name,
    parentFolderId: row.parent_folder_id ?? undefined,
    fileSize: row.file_size,
    storedSize: row.stored_size ?? undefined,
    logicalBlockSize: row.logical_block_size,
    defaultCompression: row.default_compression,
    successfullyStoredSize: row.successfully_stored_size,
    fileUploadDate: row.file_upload_date,
    status: row.status,
    sha256Original: row.sha256_original ?? undefined,
    hydrationPolicy: row.hydration_policy ?? undefined,
  };
}

function folderRowToModel(row: FolderRow): Folder {
  return {
    folderId: row.folder_id,
    folderName: row.folder_name,
    parentFolderId: row.parent_folder_id ?? undefined,
    createdAt: row.created_at,
  };
}

function providerRowToModel(row: ProviderAccountRow): ProviderAccountRecord {
  return {
    providerName: row.provider_name,
    accountIndex: row.account_index,
    label: row.label ?? undefined,
    baseUrl: row.base_url ?? undefined,
    authType: row.auth_type,
    credentialRef: row.credential_ref,
    totalSpace: row.total_space ?? undefined,
    usedSpace: row.used_space ?? undefined,
    avgLatencyMs: row.avg_latency_ms,
    avgSpeedBps: row.avg_speed_bps,
    priorityScore: row.priority_score,
    manualPriorityRank: row.manual_priority_rank ?? undefined,
    enabled: row.enabled === 1,
    lastProbedAt: row.last_probed_at ?? undefined,
    isLiveQuota: row.is_live_quota === 1,
    isBilledProvider: row.is_billed_provider === 1,
    configuredCapBytes: row.configured_cap_bytes ?? undefined,
    maxSingleObjectBytes: row.max_single_object_bytes ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Files + blocks + folders
// ---------------------------------------------------------------------------

export class FileRepository {
  constructor(private db: Database.Database) {}

  upsertFile(file: Omit<OmniFile, "blocks">): void {
    this.db
      .prepare(
        `INSERT INTO files (file_uuid, file_name, parent_folder_id, file_size, stored_size,
           logical_block_size, default_compression, successfully_stored_size,
           file_upload_date, status, sha256_original, hydration_policy)
         VALUES (@fileUuid, @fileName, @parentFolderId, @fileSize, @storedSize,
           @logicalBlockSize, @defaultCompression, @successfullyStoredSize,
           @fileUploadDate, @status, @sha256Original, @hydrationPolicy)
         ON CONFLICT(file_uuid) DO UPDATE SET
           file_name = excluded.file_name,
           parent_folder_id = excluded.parent_folder_id,
           stored_size = excluded.stored_size,
           default_compression = excluded.default_compression,
           successfully_stored_size = excluded.successfully_stored_size,
           status = excluded.status,
           sha256_original = excluded.sha256_original,
           hydration_policy = excluded.hydration_policy`,
      )
      .run({
        fileUuid: file.fileUuid,
        fileName: file.fileName,
        parentFolderId: file.parentFolderId ?? null,
        fileSize: file.fileSize,
        storedSize: file.storedSize ?? null,
        logicalBlockSize: file.logicalBlockSize,
        defaultCompression: file.defaultCompression,
        successfullyStoredSize: file.successfullyStoredSize,
        fileUploadDate: file.fileUploadDate,
        status: file.status,
        sha256Original: file.sha256Original ?? null,
        hydrationPolicy: file.hydrationPolicy ?? null,
      });
  }

  upsertBlock(block: FileBlock): void {
    this.db
      .prepare(
        `INSERT INTO file_blocks (block_id, file_uuid, block_index, logical_start,
           logical_length, stored_size, compression_used, provider_name, account_index,
           remote_path, checksum, status, retry_count, last_error)
         VALUES (@blockId, @fileUuid, @blockIndex, @logicalStart,
           @logicalLength, @storedSize, @compressionUsed, @providerName, @accountIndex,
           @remotePath, @checksum, @status, @retryCount, @lastError)
         ON CONFLICT(block_id) DO UPDATE SET
           provider_name = excluded.provider_name,
           account_index = excluded.account_index,
           stored_size = excluded.stored_size,
           compression_used = excluded.compression_used,
           remote_path = excluded.remote_path,
           checksum = excluded.checksum,
           status = excluded.status,
           retry_count = excluded.retry_count,
           last_error = excluded.last_error`,
      )
      .run({
        blockId: block.blockId,
        fileUuid: block.fileUuid,
        blockIndex: block.blockIndex,
        logicalStart: block.logicalStart,
        logicalLength: block.logicalLength,
        storedSize: block.storedSize,
        compressionUsed: block.compressionUsed,
        providerName: block.providerName,
        accountIndex: block.accountIndex,
        remotePath: block.remotePath,
        checksum: block.checksum ?? null,
        status: block.status,
        retryCount: block.retryCount,
        lastError: block.lastError ?? null,
      });
  }

  getFile(fileUuid: string): OmniFile | null {
    const row = this.db
      .prepare("SELECT * FROM files WHERE file_uuid = ?")
      .get(fileUuid) as FileRow | undefined;
    if (!row) return null;

    const blockRows = this.db
      .prepare(
        "SELECT * FROM file_blocks WHERE file_uuid = ? ORDER BY block_index ASC",
      )
      .all(fileUuid) as BlockRow[];

    return { ...fileRowToSummary(row), blocks: blockRows.map(blockRowToModel) };
  }

  /**
   * Loads only the blocks covering a byte range — the query the mount layer
   * runs on every read. Loading all of a 20GB file's 5,000 block rows to serve
   * a 64KB read would defeat the point of block addressing.
   */
  getBlockRange(
    fileUuid: string,
    startBlockIndex: number,
    endBlockIndex: number,
  ): FileBlock[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM file_blocks
         WHERE file_uuid = ? AND block_index BETWEEN ? AND ?
         ORDER BY block_index ASC`,
      )
      .all(fileUuid, startBlockIndex, endBlockIndex) as BlockRow[];
    return rows.map(blockRowToModel);
  }

  listFiles(
    status?: OmniFile["status"],
    parentFolderId?: string | null,
  ): Omit<OmniFile, "blocks">[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (status) {
      clauses.push("status = ?");
      params.push(status);
    }
    if (parentFolderId !== undefined) {
      if (parentFolderId === null) {
        clauses.push("parent_folder_id IS NULL");
      } else {
        clauses.push("parent_folder_id = ?");
        params.push(parentFolderId);
      }
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM files ${where} ORDER BY file_upload_date DESC`)
      .all(...params) as FileRow[];
    return rows.map(fileRowToSummary);
  }

  deleteFile(fileUuid: string): void {
    // ON DELETE CASCADE removes file_blocks rows too.
    this.db.prepare("DELETE FROM files WHERE file_uuid = ?").run(fileUuid);
  }

  setHydrationPolicy(fileUuid: string, policy: HydrationPolicy | null): void {
    this.db
      .prepare("UPDATE files SET hydration_policy = ? WHERE file_uuid = ?")
      .run(policy, fileUuid);
  }
}

// ---------------------------------------------------------------------------
// Virtual folders (local-only metadata; never written to any provider)
// ---------------------------------------------------------------------------

export class FolderRepository {
  constructor(private db: Database.Database) {}

  create(folder: Folder): void {
    this.db
      .prepare(
        `INSERT INTO folders (folder_id, folder_name, parent_folder_id, created_at)
         VALUES (@folderId, @folderName, @parentFolderId, @createdAt)`,
      )
      .run({
        folderId: folder.folderId,
        folderName: folder.folderName,
        parentFolderId: folder.parentFolderId ?? null,
        createdAt: folder.createdAt,
      });
  }

  get(folderId: string): Folder | null {
    const row = this.db
      .prepare("SELECT * FROM folders WHERE folder_id = ?")
      .get(folderId) as FolderRow | undefined;
    return row ? folderRowToModel(row) : null;
  }

  listChildren(parentFolderId?: string | null): Folder[] {
    const rows =
      parentFolderId == null
        ? (this.db
            .prepare(
              "SELECT * FROM folders WHERE parent_folder_id IS NULL ORDER BY folder_name",
            )
            .all() as FolderRow[])
        : (this.db
            .prepare(
              "SELECT * FROM folders WHERE parent_folder_id = ? ORDER BY folder_name",
            )
            .all(parentFolderId) as FolderRow[]);
    return rows.map(folderRowToModel);
  }

  /** Rename or move. Both are metadata-only and transfer zero bytes. */
  update(
    folderId: string,
    changes: { folderName?: string; parentFolderId?: string | null },
  ): void {
    const current = this.get(folderId);
    if (!current) throw new Error(`No folder ${folderId}`);
    this.db
      .prepare(
        "UPDATE folders SET folder_name = ?, parent_folder_id = ? WHERE folder_id = ?",
      )
      .run(
        changes.folderName ?? current.folderName,
        changes.parentFolderId === undefined
          ? (current.parentFolderId ?? null)
          : changes.parentFolderId,
        folderId,
      );
  }

  /** True if the folder still holds files or subfolders. */
  hasContents(folderId: string): boolean {
    const files = this.db
      .prepare("SELECT COUNT(*) AS n FROM files WHERE parent_folder_id = ?")
      .get(folderId) as { n: number };
    const folders = this.db
      .prepare("SELECT COUNT(*) AS n FROM folders WHERE parent_folder_id = ?")
      .get(folderId) as { n: number };
    return files.n > 0 || folders.n > 0;
  }

  delete(folderId: string): void {
    this.db.prepare("DELETE FROM folders WHERE folder_id = ?").run(folderId);
  }
}

// ---------------------------------------------------------------------------
// Provider accounts
// ---------------------------------------------------------------------------

export class ProviderAccountRepository {
  constructor(private db: Database.Database) {}

  upsert(account: ProviderAccountRecord): void {
    this.db
      .prepare(
        `INSERT INTO provider_accounts (provider_name, account_index, label, base_url,
           auth_type, credential_ref, total_space, used_space, avg_latency_ms, avg_speed_bps,
           priority_score, manual_priority_rank, enabled, last_probed_at,
           is_live_quota, is_billed_provider, configured_cap_bytes, max_single_object_bytes)
         VALUES (@providerName, @accountIndex, @label, @baseUrl, @authType, @credentialRef,
           @totalSpace, @usedSpace, @avgLatencyMs, @avgSpeedBps, @priorityScore,
           @manualPriorityRank, @enabled, @lastProbedAt,
           @isLiveQuota, @isBilledProvider, @configuredCapBytes, @maxSingleObjectBytes)
         ON CONFLICT(provider_name, account_index) DO UPDATE SET
           label = excluded.label,
           total_space = excluded.total_space,
           used_space = excluded.used_space,
           avg_latency_ms = excluded.avg_latency_ms,
           avg_speed_bps = excluded.avg_speed_bps,
           priority_score = excluded.priority_score,
           manual_priority_rank = excluded.manual_priority_rank,
           enabled = excluded.enabled,
           last_probed_at = excluded.last_probed_at,
           configured_cap_bytes = excluded.configured_cap_bytes`,
      )
      .run({
        providerName: account.providerName,
        accountIndex: account.accountIndex,
        label: account.label ?? null,
        baseUrl: account.baseUrl ?? null,
        authType: account.authType,
        credentialRef: account.credentialRef,
        totalSpace: account.totalSpace ?? null,
        usedSpace: account.usedSpace ?? null,
        avgLatencyMs: account.avgLatencyMs,
        avgSpeedBps: account.avgSpeedBps,
        priorityScore: account.priorityScore,
        manualPriorityRank: account.manualPriorityRank ?? null,
        enabled: account.enabled ? 1 : 0,
        lastProbedAt: account.lastProbedAt ?? null,
        isLiveQuota: account.isLiveQuota ? 1 : 0,
        isBilledProvider: account.isBilledProvider ? 1 : 0,
        configuredCapBytes: account.configuredCapBytes ?? null,
        maxSingleObjectBytes: account.maxSingleObjectBytes ?? null,
      });
  }

  list(): ProviderAccountRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM provider_accounts ORDER BY priority_score DESC")
      .all() as ProviderAccountRow[];
    return rows.map(providerRowToModel);
  }

  get(providerName: string, accountIndex: number): ProviderAccountRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM provider_accounts WHERE provider_name = ? AND account_index = ?",
      )
      .get(providerName, accountIndex) as ProviderAccountRow | undefined;
    return row ? providerRowToModel(row) : null;
  }

  /** Blocked at the API layer unless the account has no referencing blocks. */
  hasBlocks(providerName: string, accountIndex: number): boolean {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM file_blocks WHERE provider_name = ? AND account_index = ?",
      )
      .get(providerName, accountIndex) as { n: number };
    return row.n > 0;
  }

  /** Per-account block count for the dashboard cards. */
  blockCount(providerName: string, accountIndex: number): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM file_blocks WHERE provider_name = ? AND account_index = ?",
      )
      .get(providerName, accountIndex) as { n: number };
    return row.n;
  }

  delete(providerName: string, accountIndex: number): void {
    this.db
      .prepare(
        "DELETE FROM provider_accounts WHERE provider_name = ? AND account_index = ?",
      )
      .run(providerName, accountIndex);
  }
}

// ---------------------------------------------------------------------------
// Provider app-level configs (shared OAuth client_id/secret per provider type)
// ---------------------------------------------------------------------------

export class ProviderAppConfigRepository {
  constructor(private db: Database.Database) {}

  get(providerName: string): ProviderAppConfigRecord | null {
    const row = this.db
      .prepare("SELECT * FROM provider_app_configs WHERE provider_name = ?")
      .get(providerName) as
      | { provider_name: string; credential_ref: string; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      providerName: row.provider_name,
      credentialRef: row.credential_ref,
      createdAt: row.created_at,
    };
  }

  exists(providerName: string): boolean {
    return this.get(providerName) !== null;
  }

  /** All saved app-level configs — used by the "Clear all storage" reset to find every credential to wipe. */
  list(): ProviderAppConfigRecord[] {
    const rows = this.db.prepare("SELECT * FROM provider_app_configs").all() as {
      provider_name: string;
      credential_ref: string;
      created_at: string;
    }[];
    return rows.map((row) => ({
      providerName: row.provider_name,
      credentialRef: row.credential_ref,
      createdAt: row.created_at,
    }));
  }

  upsert(providerName: string, credentialRef: string): ProviderAppConfigRecord {
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO provider_app_configs (provider_name, credential_ref, created_at)
         VALUES (@providerName, @credentialRef, @createdAt)
         ON CONFLICT(provider_name) DO UPDATE SET credential_ref = excluded.credential_ref`,
      )
      .run({ providerName, credentialRef, createdAt });
    return { providerName, credentialRef, createdAt };
  }

  delete(providerName: string): void {
    this.db.prepare("DELETE FROM provider_app_configs WHERE provider_name = ?").run(providerName);
  }
}

// ---------------------------------------------------------------------------
// Settings (key/value, seeded with defaults)
// ---------------------------------------------------------------------------

export class SettingsRepository {
  constructor(private db: Database.Database) {}

  get(): GlobalSettings {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as {
      key: string;
      value: string;
    }[];
    const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));

    return {
      defaultCompression:
        (stored.default_compression as GlobalSettings["defaultCompression"]) ??
        DEFAULT_SETTINGS.defaultCompression,
      prioritySortMode:
        (stored.priority_sort_mode as GlobalSettings["prioritySortMode"]) ??
        DEFAULT_SETTINGS.prioritySortMode,
      // Deliberately NOT falling back to the old chunk_size_bytes row: that
      // setting meant a transfer chunk size, this one is the addressing unit.
      // Silently reusing an 8MB transfer chunk as a block size would work but
      // would quietly change the block geometry of every new file.
      defaultLogicalBlockSize: stored.default_logical_block_size
        ? Number(stored.default_logical_block_size)
        : DEFAULT_SETTINGS.defaultLogicalBlockSize,
      retryMaxAttempts: stored.retry_max_attempts
        ? Number(stored.retry_max_attempts)
        : DEFAULT_SETTINGS.retryMaxAttempts,
      stalenessThresholdMs: stored.staleness_threshold_ms
        ? Number(stored.staleness_threshold_ms)
        : DEFAULT_SETTINGS.stalenessThresholdMs,
      smallFileThresholdBytes: stored.small_file_threshold_bytes
        ? Number(stored.small_file_threshold_bytes)
        : DEFAULT_SETTINGS.smallFileThresholdBytes,
    };
  }

  update(partial: Partial<GlobalSettings>): GlobalSettings {
    const current = this.get();
    const next = { ...current, ...partial };

    const rows: [string, string][] = [
      ["default_compression", next.defaultCompression],
      ["priority_sort_mode", next.prioritySortMode],
      ["default_logical_block_size", String(next.defaultLogicalBlockSize)],
      ["retry_max_attempts", String(next.retryMaxAttempts)],
      ["staleness_threshold_ms", String(next.stalenessThresholdMs)],
      ["small_file_threshold_bytes", String(next.smallFileThresholdBytes)],
    ];

    const stmt = this.db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    const tx = this.db.transaction((entries: [string, string][]) => {
      for (const [key, value] of entries) stmt.run(key, value);
    });
    tx(rows);

    return next;
  }
}
