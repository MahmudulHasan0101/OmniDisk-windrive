import Database from "better-sqlite3";
import envPaths from "env-paths";
import { mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * AppData layout, per spec section 4:
 *
 * <AppData>/OmniDisk/
 * ├── omnidisk.db
 * ├── credentials.enc
 * ├── config.json
 * ├── cache/tmp_uploads/
 * ├── cache/blocks/      (LRU cache of decompressed blocks)
 * ├── cache/writeback/   (dirty blocks awaiting flush, replayed after a crash)
 * └── logs/omnidisk.log
 *
 * Nothing related to file content or credentials is ever written outside
 * this folder.
 */
export const paths = envPaths("OmniDisk", { suffix: "" });

// Colab/portable deployments need this to point at a Google Drive path so
// data survives a VM restart — envPaths' OS-default location lives on the
// Colab VM's ephemeral local disk, which is wiped on every session.
export const APPDATA_DIR = process.env.OMNIDISK_DATA_DIR ?? paths.data;
export const DB_PATH = join(APPDATA_DIR, "omnidisk.db");
export const CREDENTIALS_PATH = join(APPDATA_DIR, "credentials.enc");
export const CONFIG_PATH = join(APPDATA_DIR, "config.json");
export const CACHE_DIR = join(APPDATA_DIR, "cache");
export const TMP_UPLOADS_DIR = join(CACHE_DIR, "tmp_uploads");
export const BLOCK_CACHE_DIR = join(CACHE_DIR, "blocks");
export const WRITEBACK_DIR = join(CACHE_DIR, "writeback");
export const LOGS_DIR = join(APPDATA_DIR, "logs");
export const LOG_FILE = join(LOGS_DIR, "omnidisk.log");

function ensureAppDataLayout(): void {
  mkdirSync(APPDATA_DIR, { recursive: true });
  mkdirSync(TMP_UPLOADS_DIR, { recursive: true });
  mkdirSync(BLOCK_CACHE_DIR, { recursive: true });
  mkdirSync(WRITEBACK_DIR, { recursive: true });
  mkdirSync(LOGS_DIR, { recursive: true });
}

/**
 * `CREATE TABLE IF NOT EXISTS` in schema.sql only covers brand-new tables —
 * it silently no-ops on a table that already exists with an older column
 * set, which is exactly what happens to a database created before a schema
 * addition (e.g. an existing install upgrading to the provider registry's
 * new provider_accounts columns). This adds any missing columns in place
 * rather than requiring a manual reset. A dedicated migrations/ folder
 * with numbered steps is the natural next evolution once schema changes
 * get more involved than "add a column with a default".
 */
function ensureColumns(
  db: Database.Database,
  table: string,
  columns: { name: string; ddl: string }[],
): void {
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  for (const { name, ddl } of columns) {
    if (!existing.has(name)) db.exec(ddl);
  }
}

function runColumnMigrations(db: Database.Database): void {
  ensureColumns(db, "provider_accounts", [
    { name: "is_live_quota", ddl: "ALTER TABLE provider_accounts ADD COLUMN is_live_quota INTEGER NOT NULL DEFAULT 1" },
    { name: "is_billed_provider", ddl: "ALTER TABLE provider_accounts ADD COLUMN is_billed_provider INTEGER NOT NULL DEFAULT 0" },
    { name: "configured_cap_bytes", ddl: "ALTER TABLE provider_accounts ADD COLUMN configured_cap_bytes INTEGER" },
    { name: "max_single_object_bytes", ddl: "ALTER TABLE provider_accounts ADD COLUMN max_single_object_bytes INTEGER" },
  ]);

  // Block-addressing migration. A database created before this change has a
  // `files` table with compressed_size/compression_used and no block columns.
  // Adding the new columns in place lets the app boot against an old database
  // so the block migrator (scripts/migrate-blocks.ts) can read the legacy rows
  // — the old columns are intentionally left alone rather than dropped.
  ensureColumns(db, "files", [
    { name: "parent_folder_id", ddl: "ALTER TABLE files ADD COLUMN parent_folder_id TEXT REFERENCES folders(folder_id)" },
    { name: "stored_size", ddl: "ALTER TABLE files ADD COLUMN stored_size INTEGER" },
    { name: "logical_block_size", ddl: "ALTER TABLE files ADD COLUMN logical_block_size INTEGER NOT NULL DEFAULT 4194304" },
    { name: "default_compression", ddl: "ALTER TABLE files ADD COLUMN default_compression TEXT NOT NULL DEFAULT 'none'" },
    { name: "hydration_policy", ddl: "ALTER TABLE files ADD COLUMN hydration_policy TEXT" },
  ]);

  // Carry the old per-file compression algorithm across to its new column name
  // so migrated rows still know how to decompress themselves.
  const fileColumns = new Set(
    (db.prepare("PRAGMA table_info(files)").all() as { name: string }[]).map((c) => c.name),
  );
  if (fileColumns.has("compression_used")) {
    db.exec(
      `UPDATE files SET default_compression = compression_used
       WHERE default_compression = 'none' AND compression_used IS NOT NULL`,
    );
  }
}

/**
 * Number of pre-block files still recorded in the legacy file_fragments table.
 *
 * Whole-stream-compressed files cannot be converted in place — reaching byte N
 * of the original requires decompressing from byte 0 — so migration means
 * re-downloading and re-uploading each one. The server surfaces this count so
 * the user is told to run `npm run migrate:blocks` rather than silently
 * finding those files unreadable.
 */
export function countLegacyFragmentFiles(db: Database.Database): number {
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='file_fragments'")
    .get();
  if (!tableExists) return 0;
  const row = db
    .prepare("SELECT COUNT(DISTINCT file_uuid) AS n FROM file_fragments")
    .get() as { n: number };
  return row.n;
}

let dbInstance: Database.Database | null = null;

/**
 * Returns a singleton, lazily-initialized SQLite connection with the
 * schema applied (idempotent — every statement in schema.sql is
 * CREATE ... IF NOT EXISTS) plus any pending column migrations.
 */
export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  ensureAppDataLayout();

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const schemaPath = join(__dirname, "schema.sql");
  const schema = readFileSync(schemaPath, "utf-8");
  db.exec(schema);
  runColumnMigrations(db);

  dbInstance = db;
  return db;
}

/** Test/dev helper: use an isolated in-memory database instead of AppData. */
export function createInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const schemaPath = join(__dirname, "schema.sql");
  const schema = readFileSync(schemaPath, "utf-8");
  db.exec(schema);
  runColumnMigrations(db);
  return db;
}

export function closeDb(): void {
  dbInstance?.close();
  dbInstance = null;
}
