import { LineChart, Line, ResponsiveContainer } from "recharts";
import type { ProviderAccountRecord } from "../api/client.js";
import { formatBytes, formatLatency, formatSpeed, formatRelativeDate } from "../lib/format.js";

interface ProviderCardProps {
  account: ProviderAccountRecord;
  probeHistory?: { t: number; speedBps: number }[];
  onToggleEnabled: (enabled: boolean) => void;
  onRemove: () => void;
}

const PROVIDER_LABELS: Record<string, string> = {
  google_drive: "Google Drive",
  onedrive: "OneDrive",
  dropbox: "Dropbox",
  box: "Box",
  pcloud: "pCloud",
  mega: "MEGA",
  github: "GitHub",
  gitlab: "GitLab",
  cloudflare_r2: "Cloudflare R2",
  backblaze_b2: "Backblaze B2",
  s3: "Amazon S3",
  azure_blob: "Azure Blob",
  gcs: "Google Cloud Storage",
  webdav: "WebDAV",
};

export default function ProviderCard({ account, probeHistory, onToggleEnabled, onRemove }: ProviderCardProps) {
  const connected = account.connected ?? false;
  const total = account.totalSpace ?? account.configuredCapBytes ?? 0;
  const used = account.usedSpace ?? 0;
  const usedPct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const displayName = account.label ?? PROVIDER_LABELS[account.providerName] ?? account.providerName;

  return (
    <div
      className={`relative rounded-lg border p-4 pl-5 transition-opacity ${
        connected ? "border-base-border bg-base-panel" : "border-dashed border-base-border bg-base-panel/60"
      } ${account.enabled ? "" : "opacity-50"}`}
    >
      <span
        className="absolute left-0 top-4 bottom-4 w-1 rounded-r"
        style={{ backgroundColor: !connected ? "#565D6B" : account.enabled ? "#5B8DEF" : "#565D6B" }}
        aria-hidden="true"
      />

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className="text-sm font-medium text-ink-primary truncate">{displayName}</p>
            {account.isBilledProvider && (
              <span className="text-[10px] leading-none rounded px-1 py-0.5 bg-signal-warn/15 text-signal-warn shrink-0">
                Billed
              </span>
            )}
          </div>
          <p className="text-xs text-ink-faint mt-0.5 font-mono">
            {account.providerName}
            {account.accountIndex > 0 ? ` · account ${account.accountIndex}` : ""}
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-ink-secondary cursor-pointer shrink-0">
          <input
            type="checkbox"
            checked={account.enabled}
            onChange={(e) => onToggleEnabled(e.target.checked)}
            className="accent-signal-active"
          />
          {account.enabled ? "Enabled" : "Disabled"}
        </label>
      </div>

      {!connected ? (
        <div className="mt-3 rounded-md border border-signal-warn/30 bg-signal-warn/10 px-2.5 py-2">
          <p className="text-xs text-signal-warn font-medium">Not connected</p>
          <p className="text-xs text-ink-secondary mt-0.5">
            This account is saved but has no live connection — its provider adapter isn't built yet,
            so no files can be routed here.
          </p>
        </div>
      ) : (
        <>
          <div className="mt-4">
            <div className="h-1.5 rounded-full bg-base-panelRaised overflow-hidden">
              <div className="h-full rounded-full bg-signal-active" style={{ width: `${usedPct}%` }} />
            </div>
            <div className="flex items-center justify-between mt-1.5">
              <p className="text-xs text-ink-secondary font-mono">
                {formatBytes(used)} used of {total > 0 ? formatBytes(total) : "unknown"}
              </p>
              <span className="text-[10px] text-ink-faint">
                {account.isLiveQuota ? "confirmed" : "estimated"}
              </span>
            </div>
          </div>

          <dl className="mt-4 grid grid-cols-3 gap-2 text-xs">
            <div>
              <dt className="text-ink-faint">Latency</dt>
              <dd className="font-mono text-ink-primary mt-0.5">{formatLatency(account.avgLatencyMs)}</dd>
            </div>
            <div>
              <dt className="text-ink-faint">Speed</dt>
              <dd className="font-mono text-ink-primary mt-0.5">{formatSpeed(account.avgSpeedBps)}</dd>
            </div>
            <div>
              <dt className="text-ink-faint">Probed</dt>
              <dd className="font-mono text-ink-primary mt-0.5">
                {formatRelativeDate(account.lastProbedAt)}
              </dd>
            </div>
          </dl>

          {probeHistory && probeHistory.length > 1 && (
            <div className="mt-3 h-8">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={probeHistory}>
                  <Line
                    type="monotone"
                    dataKey="speedBps"
                    stroke="#5B8DEF"
                    strokeWidth={1.5}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      )}

      <div className="mt-3 flex justify-end">
        <button onClick={onRemove} className="text-xs text-ink-faint hover:text-signal-fail transition-colors">
          Remove
        </button>
      </div>
    </div>
  );
}
