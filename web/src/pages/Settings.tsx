import { useEffect, useState } from "react";
import { api, type GlobalSettings, type CompressionAlgo, type PrioritySortMode } from "../api/client.js";
import { formatBytes } from "../lib/format.js";

// 1-16MB, matching the server-side validation in settings.ts. Below 1MB
// per-request overhead on cloud providers dominates; the API rejects
// anything above 64MB, but keeping the UI's own ceiling tighter (16MB)
// nudges toward values that stay well under every provider's per-object cap.
const BLOCK_SIZE_OPTIONS = [1, 2, 4, 8, 16].map((mb) => mb * 1024 * 1024);

export default function Settings() {
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const [vaultBackend, setVaultBackend] = useState<"os_keychain" | "encrypted_file" | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    api.settings.get().then(setSettings).catch((err) => setError(err.message));
    api.settings
      .vaultStatus()
      .then((r) => setVaultBackend(r.backend))
      .catch(() => setVaultBackend(null));
  }, []);

  async function updateSetting<K extends keyof GlobalSettings>(
    key: K,
    value: GlobalSettings[K],
  ): Promise<void> {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.settings.patch({ [key]: value });
      setSettings(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save setting");
    } finally {
      setSaving(false);
    }
  }

  async function handleResetAll(): Promise<void> {
    setResetting(true);
    setError(null);
    try {
      await api.settings.resetAll();
      // Simplest way to guarantee every page's state (accounts, files,
      // priorities, everything) reflects the wipe correctly — a full
      // reload rather than trying to manually reset state scattered
      // across components.
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear storage");
      setResetting(false);
      setConfirmingReset(false);
    }
  }

  if (!settings) {
    return (
      <div className="px-8 py-6 max-w-2xl">
        <h1 className="font-display text-2xl mb-6">Settings</h1>
        {error ? (
          <p className="text-sm text-signal-fail">{error}</p>
        ) : (
          <p className="text-sm text-ink-faint">Loading…</p>
        )}
      </div>
    );
  }

  return (
    <div className="px-8 py-6 max-w-2xl">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="font-display text-2xl">Settings</h1>
        {saving && <span className="text-xs text-ink-faint">Saving…</span>}
      </header>

      {error && (
        <div className="mb-4 rounded-md border border-signal-fail/40 bg-signal-fail/10 px-4 py-2.5 text-sm text-signal-fail">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-6">
        <SettingRow
          label="Default compression"
          description="Applied to new uploads unless overridden per file."
        >
          <select
            value={settings.defaultCompression}
            onChange={(e) => updateSetting("defaultCompression", e.target.value as CompressionAlgo)}
            className="text-sm bg-base-panel border border-base-border rounded-md px-2 py-1.5 text-ink-primary w-40"
          >
            <option value="zstd">Zstd</option>
            <option value="gzip">Gzip</option>
            <option value="brotli">Brotli</option>
            <option value="none">None</option>
          </select>
        </SettingRow>

        <SettingRow
          label="Priority sort mode"
          description="How provider accounts are ranked when routing new files."
        >
          <select
            value={settings.prioritySortMode}
            onChange={(e) => updateSetting("prioritySortMode", e.target.value as PrioritySortMode)}
            className="text-sm bg-base-panel border border-base-border rounded-md px-2 py-1.5 text-ink-primary w-40"
          >
            <option value="speed">Speed</option>
            <option value="latency">Latency</option>
            <option value="free_space">Free space</option>
            <option value="manual">Manual</option>
          </select>
        </SettingRow>

        <SettingRow
          label="Block size"
          description="The addressing unit new files are split into. Captured per-file at upload time, so changing this only affects files uploaded after the change — existing files keep the block size they were created with. Smaller blocks retry and randomly-read faster; larger blocks compress a little better."
        >
          <select
            value={settings.defaultLogicalBlockSize}
            onChange={(e) => updateSetting("defaultLogicalBlockSize", Number(e.target.value))}
            className="text-sm bg-base-panel border border-base-border rounded-md px-2 py-1.5 text-ink-primary w-40"
          >
            {BLOCK_SIZE_OPTIONS.map((bytes) => (
              <option key={bytes} value={bytes}>
                {formatBytes(bytes)}
              </option>
            ))}
          </select>
        </SettingRow>

        <SettingRow
          label="Small file threshold"
          description="Files at or below this size always fully download rather than streaming — at this size streaming buys nothing, and full download is strictly more compatible with every app."
        >
          <select
            value={settings.smallFileThresholdBytes}
            onChange={(e) => updateSetting("smallFileThresholdBytes", Number(e.target.value))}
            className="text-sm bg-base-panel border border-base-border rounded-md px-2 py-1.5 text-ink-primary w-40"
          >
            {[16, 32, 64, 128, 256].map((mb) => (
              <option key={mb} value={mb * 1024 * 1024}>
                {formatBytes(mb * 1024 * 1024)}
              </option>
            ))}
          </select>
        </SettingRow>

        <SettingRow
          label="Max retry attempts"
          description="How many times a failed block upload is retried before the file is marked partial."
        >
          <input
            type="number"
            min={0}
            max={10}
            value={settings.retryMaxAttempts}
            onChange={(e) => updateSetting("retryMaxAttempts", Number(e.target.value))}
            className="text-sm bg-base-panel border border-base-border rounded-md px-2 py-1.5 text-ink-primary w-20"
          />
        </SettingRow>

        <SettingRow
          label="Credential vault"
          description="Where provider account credentials are stored on this machine."
        >
          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${
                vaultBackend === "os_keychain" ? "bg-signal-stored" : "bg-signal-warn"
              }`}
            />
            <span className="text-sm text-ink-primary">
              {vaultBackend === "os_keychain"
                ? "OS keychain"
                : vaultBackend === "encrypted_file"
                  ? "Encrypted file (OS keychain unavailable)"
                  : "Unknown"}
            </span>
          </div>
        </SettingRow>
      </div>

      <div className="mt-10">
        <h2 className="text-sm font-medium text-signal-fail mb-3">Danger zone</h2>
        <div className="rounded-md border border-signal-fail/40 bg-signal-fail/5 px-4 py-4">
          <div className="flex items-start justify-between gap-6">
            <div className="max-w-sm">
              <p className="text-sm text-ink-primary">Clear all storage</p>
              <p className="text-xs text-ink-faint mt-0.5">
                Erases OmniDisk's local database and credential vault: every file record,
                every connected provider account, and all settings on this device. Files
                already stored on your connected providers (MEGA, Google Drive, Supabase,
                etc.) are <span className="font-medium">not</span> deleted — this only makes
                OmniDisk forget it ever put them there. This cannot be undone.
              </p>
            </div>
            <div className="shrink-0">
              {!confirmingReset ? (
                <button
                  onClick={() => setConfirmingReset(true)}
                  className="text-sm border border-signal-fail/50 text-signal-fail rounded-md px-3 py-1.5 hover:bg-signal-fail/10"
                >
                  Clear all storage
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setConfirmingReset(false)}
                    disabled={resetting}
                    className="text-sm border border-base-border rounded-md px-3 py-1.5 text-ink-primary hover:bg-base-panel disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleResetAll}
                    disabled={resetting}
                    className="text-sm bg-signal-fail text-white rounded-md px-3 py-1.5 hover:opacity-90 disabled:opacity-50"
                  >
                    {resetting ? "Clearing…" : "Yes, clear everything"}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-base-border pb-5">
      <div className="max-w-sm">
        <p className="text-sm text-ink-primary">{label}</p>
        <p className="text-xs text-ink-faint mt-0.5">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
