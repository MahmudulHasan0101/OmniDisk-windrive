import { extname } from "node:path";
import type { HydrationPolicy, OmniFile } from "./models.js";

/**
 * Deciding how a file is materialized when opened through the mount layer.
 *
 * The important case is executables. Windows does not read a .exe or .dll the
 * way it reads a document — it memory-maps the image and faults pages in on
 * demand, ~4KB at a time, in an order determined by code execution and so
 * effectively random. Against a streaming mount every page fault becomes a
 * synchronous provider round trip inside the kernel's fault path:
 *
 *   - thousands of faults during startup at ~100ms each = minutes to launch
 *   - page faults can't be cancelled cleanly, so the app is unkillable-hung
 *     rather than merely slow
 *   - a network drop mid-execution is an in-page I/O error: a hard crash
 *
 * So anything the OS will memory-map, or that does sustained random I/O over a
 * large file, is hydrated fully before a handle is granted.
 *
 * Extension-based dispatch is crude, and it is also what every production
 * cloud filesystem does, because the alternative — inferring from access
 * patterns after the fact — makes the FIRST launch of every executable the
 * pathological case.
 */

/** Memory-mapped images: demand paging makes streaming unusable. */
const EXECUTABLE_EXTS = new Set([
  ".exe", ".dll", ".sys", ".msi", ".com", ".scr", ".ocx", ".cpl",
  ".so", ".dylib", ".a", ".o",
  ".jar", ".apk", ".app", ".appimage", ".deb", ".rpm", ".pkg", ".dmg",
]);

/** Sustained scattered reads and writes over a large file. */
const DATABASE_EXTS = new Set([
  ".sqlite", ".sqlite3", ".db", ".db3", ".mdb", ".accdb",
  ".pst", ".ost", ".ldf", ".mdf", ".ndf", ".frm", ".ibd",
]);

/** Random access over the entire file for the whole session. */
const DISK_IMAGE_EXTS = new Set([
  ".vmdk", ".vhd", ".vhdx", ".qcow2", ".vdi", ".iso", ".img", ".dmg",
]);

/** Central directory sits at the end, then reads scatter backwards. */
const ARCHIVE_EXTS = new Set([
  ".zip", ".7z", ".rar", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".zst", ".cab",
]);

/** Sequential with occasional seeks — the ideal streaming case. */
const LINEAR_MEDIA_EXTS = new Set([
  ".mp4", ".mkv", ".mov", ".avi", ".wmv", ".flv", ".webm", ".m4v", ".mpg", ".mpeg",
  ".mp3", ".flac", ".wav", ".aac", ".ogg", ".m4a", ".opus", ".wma",
]);

export type HydrationReason =
  | "user-pinned"
  | "explicit-override"
  | "executable"
  | "database"
  | "disk-image"
  | "archive"
  | "linear-media"
  | "small-file"
  | "default";

export interface HydrationDecision {
  policy: HydrationPolicy;
  reason: HydrationReason;
  /** Human-readable justification, surfaced in the UI's file detail view. */
  explanation: string;
}

export interface HydrationInput {
  fileName: string;
  fileSize: number;
  /** Explicit per-file override from files.hydration_policy. */
  override?: HydrationPolicy;
  smallFileThresholdBytes: number;
}

/**
 * Resolution order, first match wins:
 *   1. user pin      -> always full, never evicted
 *   2. explicit override on the file
 *   3. extension class
 *   4. size threshold (small files hydrate; streaming buys nothing)
 *   5. default -> stream
 */
export function resolveHydrationPolicy(input: HydrationInput): HydrationDecision {
  const { fileName, fileSize, override, smallFileThresholdBytes } = input;

  if (override === "pinned") {
    return {
      policy: "pinned",
      reason: "user-pinned",
      explanation:
        "Pinned by you: kept fully downloaded and exempt from cache eviction.",
    };
  }
  if (override) {
    return {
      policy: override,
      reason: "explicit-override",
      explanation: `Overridden by you to "${override}".`,
    };
  }

  const ext = extname(fileName).toLowerCase();

  if (EXECUTABLE_EXTS.has(ext)) {
    return {
      policy: "full",
      reason: "executable",
      explanation:
        "Executables are memory-mapped and paged in a few KB at a time, so " +
        "they're downloaded fully before opening. Streaming one would hang " +
        "on every page fault.",
    };
  }
  if (DATABASE_EXTS.has(ext)) {
    return {
      policy: "full",
      reason: "database",
      explanation:
        "Database files do sustained scattered reads and writes, which is the " +
        "worst case for streaming — downloaded fully instead.",
    };
  }
  if (DISK_IMAGE_EXTS.has(ext)) {
    return {
      policy: "full",
      reason: "disk-image",
      explanation:
        "Disk images are accessed randomly across the whole file for the " +
        "duration of a session — downloaded fully instead.",
    };
  }
  if (ARCHIVE_EXTS.has(ext)) {
    return {
      policy: "full",
      reason: "archive",
      explanation:
        "Archives keep their index at the end of the file and then read " +
        "backwards, so they're downloaded fully rather than streamed.",
    };
  }

  if (LINEAR_MEDIA_EXTS.has(ext)) {
    // Streamed regardless of size: this is exactly what read-ahead is for,
    // and a 20GB video should not require 20GB of local disk to play.
    return {
      policy: "stream",
      reason: "linear-media",
      explanation:
        "Media plays fine while streaming — blocks are fetched just ahead of " +
        "playback, so it starts immediately without downloading the whole file.",
    };
  }

  if (fileSize <= smallFileThresholdBytes) {
    return {
      policy: "full",
      reason: "small-file",
      explanation:
        "Small enough that downloading it whole is faster and more compatible " +
        "than streaming it block by block.",
    };
  }

  return {
    policy: "stream",
    reason: "default",
    explanation:
      "Streamed on demand: only the parts actually read are fetched.",
  };
}

/** Convenience wrapper for a persisted file record. */
export function resolveForFile(
  file: Pick<OmniFile, "fileName" | "fileSize" | "hydrationPolicy">,
  smallFileThresholdBytes: number,
): HydrationDecision {
  return resolveHydrationPolicy({
    fileName: file.fileName,
    fileSize: file.fileSize,
    override: file.hydrationPolicy,
    smallFileThresholdBytes,
  });
}
