import type { FileBlock } from "../api/client.js";
import { formatBytes } from "../lib/format.js";

const STATUS_COLOR: Record<FileBlock["status"], string> = {
  stored: "text-signal-stored",
  pending: "text-signal-warn",
  failed: "text-signal-fail",
  dirty: "text-signal-warn",
};

export default function BlockMap({ blocks }: { blocks: FileBlock[] }) {
  if (blocks.length === 0) {
    return <p className="text-sm text-ink-faint px-3 py-3">No blocks recorded yet.</p>;
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-ink-faint">
          <th className="font-normal px-3 py-1.5">#</th>
          <th className="font-normal px-3 py-1.5">Provider account</th>
          <th className="font-normal px-3 py-1.5">Logical range</th>
          <th className="font-normal px-3 py-1.5">Stored</th>
          <th className="font-normal px-3 py-1.5">Compression</th>
          <th className="font-normal px-3 py-1.5">Status</th>
          <th className="font-normal px-3 py-1.5">Retries</th>
        </tr>
      </thead>
      <tbody>
        {[...blocks]
          .sort((a, b) => a.blockIndex - b.blockIndex)
          .map((b) => {
            const saved = b.logicalLength - b.storedSize;
            return (
              <tr key={b.blockId} className="border-t border-base-border">
                <td className="px-3 py-2 font-mono text-xs text-ink-faint">{b.blockIndex}</td>
                <td className="px-3 py-2 font-mono text-xs text-ink-primary">
                  {b.providerName}
                  {b.accountIndex > 0 ? ` (${b.accountIndex})` : ""}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-ink-secondary">
                  {b.logicalStart.toLocaleString()}&ndash;
                  {(b.logicalStart + b.logicalLength).toLocaleString()}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-ink-secondary">
                  {formatBytes(b.storedSize)}
                  {saved > 0 && (
                    <span className="text-ink-faint"> (−{formatBytes(saved)})</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-ink-secondary">
                  {/* Per-block, not per-file: an incompressible block is stored
                      raw as "none" even when the file's default is zstd. */}
                  {b.compressionUsed}
                </td>
                <td className={`px-3 py-2 text-xs ${STATUS_COLOR[b.status]}`}>{b.status}</td>
                <td className="px-3 py-2 text-xs text-ink-secondary">{b.retryCount}</td>
              </tr>
            );
          })}
      </tbody>
    </table>
  );
}
