-- OmniDisk metadata schema. Lives at <AppData>/OmniDisk/omnidisk.db
-- Never stores file content or credentials in plaintext — see security/credential-vault.ts.

-- Virtual folder tree. Purely local metadata — folders never exist on any
-- provider, which is why rename/move is instant and transfers zero bytes.
-- Required by the mount layer: Explorer needs a directory tree to render.
CREATE TABLE IF NOT EXISTS folders (
  folder_id TEXT PRIMARY KEY,
  folder_name TEXT NOT NULL,
  parent_folder_id TEXT REFERENCES folders(folder_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_folder_id);

CREATE TABLE IF NOT EXISTS files (
  file_uuid TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  parent_folder_id TEXT REFERENCES folders(folder_id),  -- NULL = drive root
  file_size INTEGER NOT NULL,                 -- original size; what the OS reports
  stored_size INTEGER,                         -- sum of blocks' stored_size
  logical_block_size INTEGER NOT NULL DEFAULT 4194304, -- immutable once written
  default_compression TEXT NOT NULL DEFAULT 'none',
  successfully_stored_size INTEGER NOT NULL DEFAULT 0,
  file_upload_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  sha256_original TEXT,
  hydration_policy TEXT                        -- NULL = auto; else stream|full|pinned
);

-- One row per PROVIDER TYPE, only for OAuth2 providers (google_drive, onedrive,
-- dropbox, box, pcloud). Holds the developer-console "app" credentials
-- (client_id/secret) that are shared across every account instance of that
-- provider. Entered once via POST /providers/catalog/:providerName/app-config.
CREATE TABLE IF NOT EXISTS provider_app_configs (
  provider_name TEXT PRIMARY KEY,
  credential_ref TEXT NOT NULL,     -- key into credentials.enc / keytar entry name holding client_id+client_secret(+tenantId)
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_accounts (
  provider_name TEXT NOT NULL,
  account_index INTEGER NOT NULL,
  label TEXT,
  base_url TEXT,
  auth_type TEXT NOT NULL,          -- oauth2 | api_key | basic
  credential_ref TEXT NOT NULL,     -- key into credentials.enc / keytar entry name
  total_space INTEGER,
  used_space INTEGER,
  avg_latency_ms REAL DEFAULT 0,
  avg_speed_bps REAL DEFAULT 0,
  priority_score REAL DEFAULT 0,
  manual_priority_rank INTEGER,     -- used only when sort mode = manual
  enabled INTEGER NOT NULL DEFAULT 1,
  last_probed_at TEXT,
  is_live_quota INTEGER NOT NULL DEFAULT 1,      -- mirrors ProviderDefinition.liveQuotaSupported
  is_billed_provider INTEGER NOT NULL DEFAULT 0, -- mirrors ProviderDefinition.isBilledProvider; billed accounts default enabled=0
  configured_cap_bytes INTEGER,      -- user-set ceiling, used instead of a live probe when is_live_quota = 0
  max_single_object_bytes INTEGER,   -- e.g. Box 250_000_000, GitHub 90_000_000; null = no cap
  PRIMARY KEY (provider_name, account_index)
);
-- NOTE: rows where auth_type = 'oauth2' should have a matching provider_app_configs
-- row for the same provider_name; rows where auth_type = 'api_key' or 'basic' have
-- no app_configs counterpart by design. This relationship is enforced in
-- application code at account-creation time rather than as a SQL foreign key,
-- since it's conditional on auth_type.

CREATE TABLE IF NOT EXISTS file_blocks (
  block_id TEXT PRIMARY KEY,                   -- `${file_uuid}_b${block_index}`
  file_uuid TEXT NOT NULL REFERENCES files(file_uuid) ON DELETE CASCADE,
  block_index INTEGER NOT NULL,                -- position in the ORIGINAL file
  logical_start INTEGER NOT NULL,              -- block_index * logical_block_size
  logical_length INTEGER NOT NULL,             -- uncompressed length of this block
  stored_size INTEGER NOT NULL DEFAULT 0,      -- compressed length actually uploaded
  compression_used TEXT NOT NULL DEFAULT 'none', -- PER-BLOCK, not per-file
  provider_name TEXT NOT NULL,
  account_index INTEGER NOT NULL,
  remote_path TEXT NOT NULL,
  checksum TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  UNIQUE (file_uuid, block_index),
  FOREIGN KEY (provider_name, account_index) REFERENCES provider_accounts(provider_name, account_index)
);

CREATE INDEX IF NOT EXISTS idx_blocks_file ON file_blocks(file_uuid);
CREATE INDEX IF NOT EXISTS idx_blocks_account ON file_blocks(provider_name, account_index);
-- The lookup performed on every single read: given a file and a byte offset,
-- find the one block covering it. Keeps that a sub-millisecond local query.
CREATE INDEX IF NOT EXISTS idx_blocks_lookup ON file_blocks(file_uuid, block_index);

-- Content-addressed dedup (not yet read by anything). Recording checksums from
-- day one costs nothing and is what will make the write-to-temp-then-rename
-- save pattern cheap: a one-word edit to a 500MB document currently re-uploads
-- all 500MB, because the app writes a new file and deletes the old one.
CREATE TABLE IF NOT EXISTS block_content_index (
  checksum TEXT PRIMARY KEY,
  provider_name TEXT NOT NULL,
  account_index INTEGER NOT NULL,
  remote_path TEXT NOT NULL,
  stored_size INTEGER NOT NULL,
  refcount INTEGER NOT NULL DEFAULT 1
);

-- Legacy whole-stream table. Retained so the block migrator can read
-- pre-block files; dropped once it has drained. See migrate-blocks.ts.
CREATE TABLE IF NOT EXISTS file_fragments (
  fragment_id TEXT PRIMARY KEY,
  file_uuid TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  account_index INTEGER NOT NULL,
  byte_start INTEGER NOT NULL,
  byte_end INTEGER NOT NULL,
  frag_index INTEGER NOT NULL,
  remote_path TEXT NOT NULL,
  checksum TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- rows: default_compression, priority_sort_mode, chunk_size_bytes, retry_max_attempts, etc.
