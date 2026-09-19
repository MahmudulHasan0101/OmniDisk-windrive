import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type OmniFile, type CompressionAlgo, type FileStatus } from "../api/client.js";
import BlockMap from "../components/BlockMap.js";
import { formatBytes, formatRelativeDate } from "../lib/format.js";

const STATUS_STYLES: Record<FileStatus, string> = {
  complete: "text-signal-stored",
  partial: "text-signal-warn",
  failed: "text-signal-fail",
  uploading: "text-signal-active",
  pending: "text-ink-secondary",
  deleted: "text-ink-faint",
};

const FILTERS: { value: FileStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "complete", label: "Complete" },
  { value: "partial", label: "Partial" },
  { value: "failed", label: "Failed" },
  { value: "uploading", label: "Uploading" },
];

export default function FileExplorer() {
  const [files, setFiles] = useState<OmniFile[]>([]);
  const [filter, setFilter] = useState<FileStatus | "all">("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<OmniFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadCompression, setUploadCompression] = useState<CompressionAlgo | "">("");
  const [dragOver, setDragOver] = useState(false);
  const [hasConnectedAccount, setHasConnectedAccount] = useState<boolean | null>(null); // null = still checking
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadFiles = useCallback(async () => {
    setError(null);
    try {
      const list = await api.files.list(filter === "all" ? undefined : filter);
      setFiles(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load files");
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  useEffect(() => {
    api.providers
      .listAccounts()
      .then((accounts) => setHasConnectedAccount(accounts.some((a) => a.connected && a.enabled)))
      .catch(() => setHasConnectedAccount(null));
  }, []);

  useEffect(() => {
    if (!expanded) {
      setExpandedDetail(null);
      return;
    }
    api.files.get(expanded).then(setExpandedDetail).catch(() => setExpandedDetail(null));
  }, [expanded]);

  async function handleUpload(fileList: FileList | null): Promise<void> {
    if (!fileList || fileList.length === 0) return;
    if (hasConnectedAccount === false) {
      setError(
        "No provider accounts have a live connection yet — add one from the Dashboard before uploading.",
      );
      return;
    }
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(fileList)) {
        await api.files.upload(file, uploadCompression || undefined);
      }
      await loadFiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleDelete(fileUuid: string): Promise<void> {
    try {
      await api.files.remove(fileUuid);
      setFiles((prev) => prev.filter((f) => f.fileUuid !== fileUuid));
      if (expanded === fileUuid) setExpanded(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  async function handleRetry(fileUuid: string): Promise<void> {
    try {
      const updated = await api.files.retry(fileUuid);
      setFiles((prev) => prev.map((f) => (f.fileUuid === fileUuid ? updated : f)));
      if (expanded === fileUuid) setExpandedDetail(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Retry failed");
    }
  }

  return (
    <div className="px-8 py-6 max-w-6xl">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl">File Explorer</h1>
          <p className="text-sm text-ink-secondary mt-1">
            Every file OmniDisk has split into blocks, wherever they live.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={uploadCompression}
            onChange={(e) => setUploadCompression(e.target.value as CompressionAlgo | "")}
            className="text-sm bg-base-panel border border-base-border rounded-md px-2 py-1.5 text-ink-primary"
            title="Compression override for this upload"
          >
            <option value="">Default compression</option>
            <option value="zstd">Zstd</option>
            <option value="gzip">Gzip</option>
            <option value="brotli">Brotli</option>
            <option value="none">None</option>
          </select>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || hasConnectedAccount === false}
            title={hasConnectedAccount === false ? "No provider accounts are connected yet" : undefined}
            className="text-sm rounded-md bg-signal-active px-3 py-1.5 text-white hover:brightness-110 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {uploading ? "Uploading…" : "Upload file"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(e) => handleUpload(e.target.files)}
          />
        </div>
      </header>

      {hasConnectedAccount === false && (
        <div className="mb-4 rounded-md border border-signal-warn/40 bg-signal-warn/10 px-4 py-2.5 text-sm text-signal-warn">
          No provider accounts have a live connection yet, so uploads have nowhere to go.{" "}
          <Link to="/" className="underline">
            Add a provider from the Dashboard
          </Link>
          .
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-md border border-signal-fail/40 bg-signal-fail/10 px-4 py-2.5 text-sm text-signal-fail">
          {error}
        </div>
      )}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (hasConnectedAccount !== false) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (hasConnectedAccount === false) {
            setError("No provider accounts have a live connection yet — add one from the Dashboard first.");
            return;
          }
          handleUpload(e.dataTransfer.files);
        }}
        className={`rounded-lg border border-dashed px-6 py-6 text-center mb-6 transition-colors ${
          hasConnectedAccount === false
            ? "border-base-border opacity-50 cursor-not-allowed"
            : dragOver
              ? "border-signal-active bg-signal-active/5"
              : "border-base-border"
        }`}
      >
        <p className="text-sm text-ink-secondary">Drag and drop a file here, or use the button above.</p>
      </div>

      <div className="flex items-center gap-1 mb-3">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`text-xs rounded-md px-2.5 py-1 transition-colors ${
              filter === f.value
                ? "bg-base-panelRaised text-ink-primary"
                : "text-ink-secondary hover:text-ink-primary"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {!loading && files.length === 0 ? (
        <div className="rounded-lg border border-dashed border-base-border px-6 py-10 text-center">
          <p className="text-sm text-ink-secondary">No files here yet.</p>
          <p className="text-xs text-ink-faint mt-1">Upload one above to see it split into blocks and routed.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-base-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-base-panel">
              <tr className="text-left text-xs text-ink-faint">
                <th className="font-normal px-4 py-2">Name</th>
                <th className="font-normal px-4 py-2">Size</th>
                <th className="font-normal px-4 py-2">Compression</th>
                <th className="font-normal px-4 py-2">Uploaded</th>
                <th className="font-normal px-4 py-2">Status</th>
                <th className="font-normal px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <FileRow
                  key={file.fileUuid}
                  file={file}
                  isExpanded={expanded === file.fileUuid}
                  expandedDetail={expanded === file.fileUuid ? expandedDetail : null}
                  onToggleExpand={() => setExpanded(expanded === file.fileUuid ? null : file.fileUuid)}
                  onDelete={() => handleDelete(file.fileUuid)}
                  onRetry={() => handleRetry(file.fileUuid)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FileRow({
  file,
  isExpanded,
  expandedDetail,
  onToggleExpand,
  onDelete,
  onRetry,
}: {
  file: OmniFile;
  isExpanded: boolean;
  expandedDetail: OmniFile | null;
  onToggleExpand: () => void;
  onDelete: () => void;
  onRetry: () => void;
}) {
  return (
    <>
      <tr className="border-t border-base-border hover:bg-base-panel/60 transition-colors">
        <td className="px-4 py-2.5">
          <button onClick={onToggleExpand} className="text-left text-ink-primary hover:underline">
            {file.fileName}
          </button>
        </td>
        <td className="px-4 py-2.5 font-mono text-xs text-ink-secondary">{formatBytes(file.fileSize)}</td>
        <td className="px-4 py-2.5 text-xs text-ink-secondary font-mono">{file.defaultCompression}</td>
        <td className="px-4 py-2.5 text-xs text-ink-secondary">{formatRelativeDate(file.fileUploadDate)}</td>
        <td className={`px-4 py-2.5 text-xs ${STATUS_STYLES[file.status]}`}>{file.status}</td>
        <td className="px-4 py-2.5 text-right whitespace-nowrap">
          {file.status === "complete" && (
            <a
              href={api.files.downloadUrl(file.fileUuid)}
              className="text-xs text-signal-active hover:underline mr-3"
            >
              Download
            </a>
          )}
          {(file.status === "partial" || file.status === "failed") && (
            <button onClick={onRetry} className="text-xs text-signal-warn hover:underline mr-3">
              Retry
            </button>
          )}
          <button onClick={onDelete} className="text-xs text-signal-fail hover:underline">
            Delete
          </button>
        </td>
      </tr>
      {isExpanded && (
        <tr className="border-t border-base-border bg-base-panel/40">
          <td colSpan={6} className="p-0">
            {expandedDetail?.hydration && (
              <p className="text-xs text-ink-faint px-3 pt-3">
                {/* Explains how this file would open on a mounted drive — see
                    HydrationPolicy in hydration-policy.ts. Streamed files never
                    need a full local download; full/pinned files do. */}
                <span className="text-ink-secondary font-medium">
                  {expandedDetail.hydration.policy === "stream" ? "Streams" : "Downloads fully"}
                </span>{" "}
                when opened on a mounted drive — {expandedDetail.hydration.explanation}
              </p>
            )}
            <BlockMap blocks={expandedDetail?.blocks ?? []} />
          </td>
        </tr>
      )}
    </>
  );
}
