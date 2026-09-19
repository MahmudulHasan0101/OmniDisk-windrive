import type { FileFragment } from "../api/client.js";
import { formatBytes } from "../lib/format.js";

const STATUS_COLOR: Record<FileFragment["status"], string> = {
  stored: "text-signal-stored",
  pending: "text-signal-warn",
  failed: "text-signal-fail",
};

export default function FragmentMap({ fragments }: { fragments: FileFragment[] }) {
  if (fragments.length === 0) {
    return <p className="text-sm text-ink-faint px-3 py-3">No fragments recorded yet.</p>;
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-ink-faint">
          <th className="font-normal px-3 py-1.5">Provider account</th>
          <th className="font-normal px-3 py-1.5">Byte range</th>
          <th className="font-normal px-3 py-1.5">Size</th>
          <th className="font-normal px-3 py-1.5">Status</th>
          <th className="font-normal px-3 py-1.5">Retries</th>
        </tr>
      </thead>
      <tbody>
        {[...fragments]
          .sort((a, b) => a.index - b.index)
          .map((f) => (
            <tr key={f.fragmentId} className="border-t border-base-border">
              <td className="px-3 py-2 font-mono text-xs text-ink-primary">
                {f.providerName}
                {f.accountIndex > 0 ? ` (${f.accountIndex})` : ""}
              </td>
              <td className="px-3 py-2 font-mono text-xs text-ink-secondary">
                {f.byteStart.toLocaleString()}&ndash;{f.byteEnd.toLocaleString()}
              </td>
              <td className="px-3 py-2 font-mono text-xs text-ink-secondary">
                {formatBytes(f.byteEnd - f.byteStart)}
              </td>
              <td className={`px-3 py-2 text-xs ${STATUS_COLOR[f.status]}`}>{f.status}</td>
              <td className="px-3 py-2 text-xs text-ink-secondary">{f.retryCount}</td>
            </tr>
          ))}
      </tbody>
    </table>
  );
}
