/**
 * Core data model shared across the router, priority manager, provider
 * adapters, and API layer. Mirrors the SQLite schema in db/schema.sql —
 * keep the two in sync when either changes.
 */

export type CompressionAlgo = "none" | "zstd" | "gzip" | "brotli";
export type BlockStatus = "pending" | "stored" | "failed" | "dirty";
/** @deprecated Alias kept so the block migration reader still compiles. */
export type FragmentStatus = BlockStatus;
export type FileStatus =
  | "pending"
  | "uploading"
  | "complete"
  | "partial"
  | "failed"
  | "deleted";
export type PrioritySortMode = "speed" | "latency" | "free_space" | "manual";
export type AuthType = "oauth2" | "api_key" | "basic";

/**
 * Default logical block size: 4MB of ORIGINAL (uncompressed) bytes.
 *
 * This is the addressing unit, not a transfer chunk size — do not conflate it
 * with the older `chunkSizeBytes` setting, which meant something different.
 * Smaller blocks give finer retry granularity and lower random-read latency at
 * the cost of more API calls and DB rows; larger blocks compress better but
 * waste more transfer on a small random read. 1MB-16MB is the sensible range.
 */
export const DEFAULT_LOGICAL_BLOCK_SIZE = 4 * 1024 * 1024;

/**
 * One fixed-size slice of the ORIGINAL (uncompressed) file, compressed
 * independently and stored as exactly one remote object on one account.
 *
 * The critical property is that a byte offset maps to a block with pure
 * arithmetic and no network access:
 *
 *     blockIndex    = Math.floor(offset / logicalBlockSize)
 *     offsetInBlock = offset % logicalBlockSize
 *
 * That is what makes random reads possible, and therefore a mounted drive.
 * The previous whole-stream design could not do this: byte offset N of the
 * original file had no computable position in the compressed stream, so
 * serving any range meant fetching and decompressing from byte 0.
 *
 * Replaces the old `FileFragment`. Same role, but keyed by logical position
 * in the original file rather than by byte ranges in a post-compression
 * stream, and carrying its own compression algorithm.
 */
export interface FileBlock {
  blockId: string; // `${fileUuid}_b${blockIndex}`
  fileUuid: string;
  blockIndex: number; // position in the ORIGINAL file, 0..n
  logicalStart: number; // blockIndex * logicalBlockSize
  logicalLength: number; // uncompressed length; full block size except possibly the last
  storedSize: number; // actual bytes uploaded after this block's compression
  /**
   * Per-block, not per-file. A block of already-compressed data (video, JPEG,
   * zip) is stored raw as "none" even when the file's default algorithm is
   * zstd — see compressBlock(). Whole-stream compression could not make that
   * choice selectively.
   */
  compressionUsed: CompressionAlgo;
  providerName: string; // e.g. "google_drive", "onedrive", "s3"
  accountIndex: number; // disambiguates multiple accounts of same provider
  remotePath: string; // `${fileUuid}/b${blockIndex}`
  checksum?: string; // sha256 of the STORED (post-compression) bytes
  status: BlockStatus;
  retryCount: number;
  lastError?: string;
}

/** @deprecated Alias kept during the block migration. New code uses FileBlock. */
export type FileFragment = FileBlock;

export interface OmniFile {
  fileUuid: string;
  fileName: string;
  fileSize: number; // original size, pre-compression — the size the OS sees
  storedSize?: number; // sum of every block's storedSize
  /**
   * Captured per-file at creation and immutable thereafter, so the offset->block
   * arithmetic above stays valid even if the global default changes later.
   */
  logicalBlockSize: number;
  /** The algorithm blocks were written with; individual blocks may still be "none". */
  defaultCompression: CompressionAlgo;
  successfullyStoredSize: number; // sum of logicalLength over blocks in "stored" status
  fileUploadDate: string; // ISO 8601
  blocks: FileBlock[]; // ordered by blockIndex
  status: FileStatus;
  sha256Original?: string; // checksum of the whole original file
  parentFolderId?: string; // virtual folder tree; undefined = drive root
  hydrationPolicy?: HydrationPolicy; // undefined = auto-resolve by extension/size
}

/**
 * How a file is materialized when opened through the mount layer.
 * - "stream": serve reads block-by-block from cache, never materialize whole.
 * - "full": fetch every block and materialize contiguously before granting a handle.
 * - "pinned": like "full", and exempt from cache eviction.
 *
 * Executables and other memory-mapped images MUST be "full": Windows pages a
 * .exe in ~4KB at a time in essentially random order, and each page fault
 * against a streaming mount is a synchronous network round trip inside the
 * kernel's fault path — minutes to launch, and an unkillable hang rather than
 * a graceful failure if the network drops.
 */
export type HydrationPolicy = "stream" | "full" | "pinned";

export interface Folder {
  folderId: string;
  folderName: string;
  parentFolderId?: string;
  createdAt: string;
}

export interface ProviderAccountIdentity {
  providerName: string;
  accountIndex: number;
  label?: string; // user-facing nickname, e.g. "Drive – Work"
}

export interface ProviderAccountStats {
  totalSpace: number;
  usedSpace: number;
  freeSpace: number;
  blockCount: number;
  avgLatencyMs: number;
  avgSpeedBps: number;
  lastProbedAt: string;
  priorityScore: number;
  enabled: boolean;
}

export interface ProviderAccountRecord extends ProviderAccountIdentity {
  baseUrl?: string;
  authType: AuthType;
  credentialRef: string; // key into credentials.enc / keytar entry name
  totalSpace?: number;
  usedSpace?: number;
  avgLatencyMs: number;
  avgSpeedBps: number;
  priorityScore: number;
  manualPriorityRank?: number; // used only when sort mode = manual
  enabled: boolean;
  lastProbedAt?: string;
  // --- catalog metadata, mirrored from ProviderDefinition at creation time ---
  isLiveQuota: boolean; // false => freeSpace derives from configuredCapBytes - usedSpace
  isBilledProvider: boolean; // true for S3/Azure/GCS; new accounts default enabled=false
  configuredCapBytes?: number; // user-set ceiling, used when isLiveQuota is false
  maxSingleObjectBytes?: number; // e.g. Box 250MB, GitHub 90MB; undefined = no cap
  // --- runtime-only, not persisted: is there a live adapter for this account
  // in this process's AccountRegistry right now? Populated by the API layer,
  // not the repository — a DB row can exist (registered) without ever having
  // a live adapter (connected) until a Phase 1+ provider adapter exists.
  connected?: boolean;
}

// ---------------------------------------------------------------------------
// Provider registry / catalog — drives the data-driven "Add a provider" UI.
// See companion doc OmniDisk_Provider_Registry_UI_Spec.md for the full spec.
// ---------------------------------------------------------------------------

export type ProviderFieldType = "text" | "password" | "url" | "select" | "number";

export interface ProviderFieldDef {
  key: string; // maps to a key in the credential payload sent to the API
  label: string;
  type: ProviderFieldType;
  placeholder?: string;
  required: boolean;
  helpText?: string; // short inline hint, links back to the setup guide section
  options?: { value: string; label: string }[]; // for type: "select"
  default?: string | number;
  secret?: boolean; // true = mask input, store only in credential vault, never echo back to UI
}

export interface ProviderDefinition {
  providerName: string; // stable id, e.g. "google_drive"
  displayName: string;
  logoUrl: string;
  authType: AuthType;

  // --- capacity/behavior metadata, drives router + UI badges ---
  freeTierLabel: string; // "15 GB", "~10 GB", "Billed (no free tier)"
  liveQuotaSupported: boolean; // can getStorableSpace() be queried live?
  maxSingleObjectBytes?: number; // e.g. Box 250_000_000, GitHub 100_000_000
  isBilledProvider: boolean; // true for S3/Azure/GCS -> excluded from default priority list, opt-in only
  setupGuideAnchor: string; // deep link into the setup guide doc

  // --- form schema ---
  appLevelFields: ProviderFieldDef[]; // empty array for non-OAuth providers
  accountLevelFields: ProviderFieldDef[]; // for OAuth providers this may be just [{ key: "label", ... }]
  requiresOAuthConnect: boolean; // if true, show a "Connect with <Provider>" button after account-level fields
}

export interface ProviderAppConfigRecord {
  providerName: string;
  credentialRef: string;
  createdAt: string;
}

export interface GlobalSettings {
  defaultCompression: CompressionAlgo;
  prioritySortMode: PrioritySortMode;
  /**
   * The addressing unit for new files (see DEFAULT_LOGICAL_BLOCK_SIZE).
   *
   * This REPLACES the old `chunkSizeBytes` setting, which meant a transfer
   * chunk size rather than an addressing unit. The two are not
   * interchangeable, so the old `chunk_size_bytes` row is deliberately left
   * in place rather than reused — the block migrator reads it to identify
   * pre-block files.
   */
  defaultLogicalBlockSize: number;
  retryMaxAttempts: number; // default 3
  stalenessThresholdMs: number; // default 10 min, triggers auto-refresh before upload
  /** Below this size, the mount layer always hydrates fully rather than streaming. */
  smallFileThresholdBytes: number;
}

export const DEFAULT_SETTINGS: GlobalSettings = {
  defaultCompression: "zstd",
  prioritySortMode: "speed",
  defaultLogicalBlockSize: DEFAULT_LOGICAL_BLOCK_SIZE,
  retryMaxAttempts: 3,
  stalenessThresholdMs: 10 * 60 * 1000,
  smallFileThresholdBytes: 64 * 1024 * 1024,
};
