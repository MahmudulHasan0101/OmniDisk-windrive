import { useEffect, useState, useCallback } from "react";
import { api, type ProviderAccountRecord, type StatsPayload, type PrioritySortMode, type CompressionAlgo } from "../api/client.js";
import ProviderCard from "../components/ProviderCard.js";
import PriorityList from "../components/PriorityList.js";
import { formatBytes, formatRelativeDate } from "../lib/format.js";
import AddProviderModal from "../components/AddProviderModal.js";

const SORT_MODES: { value: PrioritySortMode; label: string }[] = [
  { value: "speed", label: "Speed" },
  { value: "latency", label: "Latency" },
  { value: "free_space", label: "Free space" },
  { value: "manual", label: "Manual" },
];

const COMPRESSION_OPTIONS: { value: CompressionAlgo; label: string }[] = [
  { value: "zstd", label: "Zstd" },
  { value: "gzip", label: "Gzip" },
  { value: "brotli", label: "Brotli" },
  { value: "none", label: "None" },
];

export default function Home() {
  const [accounts, setAccounts] = useState<ProviderAccountRecord[]>([]);
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [sortMode, setSortMode] = useState<PrioritySortMode>("speed");
  const [compression, setCompression] = useState<CompressionAlgo>("zstd");
  const [lastRefreshed, setLastRefreshed] = useState<string | undefined>();
  const [refreshing, setRefreshing] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      const [accountList, statsPayload, settings] = await Promise.all([
        api.providers.listAccounts(),
        api.stats.get(),
        api.settings.get(),
      ]);
      setAccounts(accountList);
      setStats(statsPayload);
      setSortMode(settings.prioritySortMode);
      setCompression(settings.defaultCompression);
      const mostRecent = accountList
        .map((a) => a.lastProbedAt)
        .filter((d): d is string => Boolean(d))
        .sort()
        .at(-1);
      setLastRefreshed(mostRecent);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load dashboard data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();

    // Google Drive's OAuth callback lands back here via a server-side
    // redirect (see server/api/routes/providers.ts) since Google redirects
    // to this app's own server, not into the SPA directly.
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("googleDriveConnected");
    const oauthError = params.get("googleDriveError");
    if (connected || oauthError) {
      if (oauthError) setError(oauthError);
      window.history.replaceState({}, "", window.location.pathname);
      if (connected) loadAll();
    }
  }, [loadAll]);

  async function handleRefreshPriorities(): Promise<void> {
    setRefreshing(true);
    try {
      const updated = await api.providers.refreshPriority(sortMode);
      setAccounts(updated);
      setLastRefreshed(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  async function handleSortModeChange(mode: PrioritySortMode): Promise<void> {
    setSortMode(mode);
    await api.settings.patch({ prioritySortMode: mode });
  }

  async function handleCompressionChange(algo: CompressionAlgo): Promise<void> {
    setCompression(algo);
    await api.settings.patch({ defaultCompression: algo });
  }

  async function handleToggleEnabled(account: ProviderAccountRecord, enabled: boolean): Promise<void> {
    const updated = await api.providers.patchAccount(account.providerName, account.accountIndex, { enabled });
    setAccounts((prev) =>
      prev.map((a) =>
        a.providerName === updated.providerName && a.accountIndex === updated.accountIndex
          ? updated
          : a,
      ),
    );
  }

  async function handleManualReorder(reordered: ProviderAccountRecord[]): Promise<void> {
    setAccounts(reordered);
    await Promise.all(
      reordered.map((a, i) =>
        api.providers.patchAccount(a.providerName, a.accountIndex, { manualPriorityRank: i }),
      ),
    );
  }

  async function handleRemove(account: ProviderAccountRecord): Promise<void> {
    try {
      await api.providers.removeAccount(account.providerName, account.accountIndex);
      setAccounts((prev) =>
        prev.filter(
          (a) => !(a.providerName === account.providerName && a.accountIndex === account.accountIndex),
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove account");
    }
  }

  return (
    <div className="px-8 py-6 max-w-6xl">
      <header className="mb-6">
        <h1 className="font-display text-2xl">Dashboard</h1>
        <p className="text-sm text-ink-secondary mt-1">
          Your combined free space across every connected account.
        </p>
      </header>

      {error && (
        <div className="mb-4 rounded-md border border-signal-fail/40 bg-signal-fail/10 px-4 py-2.5 text-sm text-signal-fail">
          {error}
        </div>
      )}

      <SummaryBar stats={stats} loading={loading} />

      <section className="mt-8">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-baseline gap-2">
            <h2 className="font-display text-base">Your accounts</h2>
            {accounts.length > 0 && (
              <span className="text-xs text-ink-faint">
                {accounts.filter((a) => a.connected).length} of {accounts.length} connected
              </span>
            )}
          </div>
          <button
            onClick={() => setShowAddModal(true)}
            className="text-sm rounded-md bg-signal-active px-3 py-1.5 text-white hover:brightness-110 transition"
          >
            Add a provider
          </button>
        </div>

        {!loading && accounts.length === 0 ? (
          <EmptyProvidersState onAdd={() => setShowAddModal(true)} />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {accounts.map((account) => (
              <ProviderCard
                key={`${account.providerName}:${account.accountIndex}`}
                account={account}
                onToggleEnabled={(enabled) => handleToggleEnabled(account, enabled)}
                onRemove={() => handleRemove(account)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-base">Priority</h2>
            <button
              onClick={handleRefreshPriorities}
              disabled={refreshing}
              className="text-xs rounded-md border border-base-border px-2.5 py-1 text-ink-secondary hover:text-ink-primary hover:border-ink-faint transition disabled:opacity-50"
            >
              {refreshing ? "Refreshing…" : "Refresh priorities"}
            </button>
          </div>

          <div className="flex items-center gap-2 mb-3">
            <label className="text-xs text-ink-secondary" htmlFor="sort-mode">
              Sort mode
            </label>
            <select
              id="sort-mode"
              value={sortMode}
              onChange={(e) => handleSortModeChange(e.target.value as PrioritySortMode)}
              className="text-sm bg-base-panel border border-base-border rounded-md px-2 py-1 text-ink-primary"
            >
              {SORT_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <span className="text-xs text-ink-faint ml-auto">
              Last refreshed {formatRelativeDate(lastRefreshed)}
            </span>
          </div>

          {accounts.length === 0 ? (
            <p className="text-sm text-ink-faint">Add a provider account to set a priority order.</p>
          ) : (
            <PriorityList accounts={accounts} mode={sortMode} onReorder={handleManualReorder} />
          )}
        </div>

        <div>
          <h2 className="font-display text-base mb-3">Default compression</h2>
          <div className="flex flex-col gap-2">
            <select
              value={compression}
              onChange={(e) => handleCompressionChange(e.target.value as CompressionAlgo)}
              className="text-sm bg-base-panel border border-base-border rounded-md px-2 py-1.5 text-ink-primary w-40"
            >
              {COMPRESSION_OPTIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-ink-secondary max-w-sm">
              Applied to new uploads unless overridden per file in the upload dialog.
            </p>
          </div>
        </div>
      </section>

      {showAddModal && (
        <AddProviderModal
          onClose={() => setShowAddModal(false)}
          onAdded={async () => {
            setShowAddModal(false);
            await loadAll();
          }}
        />
      )}
    </div>
  );
}

function SummaryBar({ stats, loading }: { stats: StatsPayload | null; loading: boolean }) {
  const items = [
    { label: "Total space", value: stats ? formatBytes(stats.totalSpace) : "—" },
    { label: "Used", value: stats ? formatBytes(stats.totalUsed) : "—" },
    { label: "Free", value: stats ? formatBytes(stats.totalFree) : "—" },
    { label: "Blocks", value: stats ? stats.totalBlockCount.toLocaleString() : "—" },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {items.map((item) => (
        <div key={item.label} className="rounded-lg border border-base-border bg-base-panel px-4 py-3">
          <p className="text-xs text-ink-faint">{item.label}</p>
          <p className={`font-mono text-lg mt-1 ${loading ? "text-ink-faint" : "text-ink-primary"}`}>
            {item.value}
          </p>
        </div>
      ))}
    </div>
  );
}

function EmptyProvidersState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-base-border px-6 py-10 text-center">
      <p className="text-sm text-ink-secondary">No provider accounts connected yet.</p>
      <p className="text-xs text-ink-faint mt-1">
        Connect a Google Drive, OneDrive, S3-compatible, or other account to start routing files.
      </p>
      <button
        onClick={onAdd}
        className="mt-4 text-sm rounded-md bg-signal-active px-3 py-1.5 text-white hover:brightness-110 transition"
      >
        Add your first account
      </button>
    </div>
  );
}
