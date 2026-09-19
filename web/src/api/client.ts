// Thin typed wrapper around the REST API in server/api/routes.
// Mirrors server/core/models.ts — keep the two in sync.

export type CompressionAlgo = "none" | "zstd" | "gzip" | "brotli";
export type BlockStatus = "pending" | "stored" | "failed" | "dirty";
export type FileStatus =
  | "pending"
  | "uploading"
  | "complete"
  | "partial"
  | "failed"
  | "deleted";
export type PrioritySortMode = "speed" | "latency" | "free_space" | "manual";
export type AuthType = "oauth2" | "api_key" | "basic";
export type ProviderFieldType = "text" | "password" | "url" | "select" | "number";

export interface FileBlock {
  blockId: string;
  fileUuid: string;
  blockIndex: number;
  logicalStart: number;
  logicalLength: number;
  storedSize: number;
  compressionUsed: CompressionAlgo;
  providerName: string;
  accountIndex: number;
  remotePath: string;
  checksum?: string;
  status: BlockStatus;
  retryCount: number;
  lastError?: string;
}

export type HydrationPolicy = "stream" | "full" | "pinned";

export interface HydrationDecision {
  policy: HydrationPolicy;
  reason: string;
  explanation: string;
}

export interface OmniFile {
  fileUuid: string;
  fileName: string;
  parentFolderId?: string;
  fileSize: number;
  storedSize?: number;
  logicalBlockSize: number;
  defaultCompression: CompressionAlgo;
  successfullyStoredSize: number;
  fileUploadDate: string;
  blocks?: FileBlock[];
  status: FileStatus;
  sha256Original?: string;
  hydrationPolicy?: HydrationPolicy;
  /** Present on the detail endpoint only; explains stream vs. full hydration. */
  hydration?: HydrationDecision;
}

export interface Folder {
  folderId: string;
  folderName: string;
  parentFolderId?: string;
  createdAt: string;
}

export interface ProviderFieldDef {
  key: string;
  label: string;
  type: ProviderFieldType;
  placeholder?: string;
  required: boolean;
  helpText?: string;
  options?: { value: string; label: string }[];
  default?: string | number;
  secret?: boolean;
}

export interface ProviderDefinition {
  providerName: string;
  displayName: string;
  logoUrl: string;
  authType: AuthType;
  freeTierLabel: string;
  liveQuotaSupported: boolean;
  maxSingleObjectBytes?: number;
  isBilledProvider: boolean;
  setupGuideAnchor: string;
  appLevelFields: ProviderFieldDef[];
  accountLevelFields: ProviderFieldDef[];
  requiresOAuthConnect: boolean;
}

export interface ProviderAccountRecord {
  providerName: string;
  accountIndex: number;
  label?: string;
  authType: AuthType;
  totalSpace?: number;
  usedSpace?: number;
  avgLatencyMs: number;
  avgSpeedBps: number;
  priorityScore: number;
  manualPriorityRank?: number;
  enabled: boolean;
  lastProbedAt?: string;
  isLiveQuota: boolean;
  isBilledProvider: boolean;
  configuredCapBytes?: number;
  maxSingleObjectBytes?: number;
  connected?: boolean;
}

export interface GlobalSettings {
  defaultCompression: CompressionAlgo;
  prioritySortMode: PrioritySortMode;
  defaultLogicalBlockSize: number;
  retryMaxAttempts: number;
  stalenessThresholdMs: number;
  smallFileThresholdBytes: number;
}

export interface CacheStats {
  entries: number;
  totalBytes: number;
  maxBytes: number;
}

export interface StatsPayload {
  totalSpace: number;
  totalUsed: number;
  totalFree: number;
  totalBlockCount: number;
  totalFiles: number;
  filesByStatus: Record<string, number>;
  perProvider: {
    providerName: string;
    accountIndex: number;
    label?: string;
    freeSpace: number;
    usedSpace: number;
    blockCount: number;
    enabled: boolean;
  }[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined;
  const isFormData = init?.body instanceof FormData;
  const res = await fetch(`/api${path}`, {
    // Only declare JSON when we're actually sending a JSON body — sending
    // this header with no body (e.g. plain POSTs like retry) makes Fastify
    // reject the request as malformed JSON before our route code ever runs,
    // which is why errors from those calls used to show up as a bare,
    // unhelpful "Bad Request".
    headers: hasBody && !isFormData ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Request to ${path} failed with ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  providers: {
    // -- catalog (provider types) --
    catalog: () => request<ProviderDefinition[]>("/providers/catalog"),
    getAppConfigStatus: (providerName: string) =>
      request<{ configured: boolean }>(`/providers/catalog/${providerName}/app-config`),
    saveAppConfig: (providerName: string, fields: Record<string, string | number | boolean>) =>
      request<{ saved: true }>(`/providers/catalog/${providerName}/app-config`, {
        method: "POST",
        body: JSON.stringify(fields),
      }),

    // -- account instances --
    listAccounts: () => request<ProviderAccountRecord[]>("/providers/accounts"),
    connect: (providerName: string, accountFields: Record<string, string | number | boolean>) =>
      request<{ providerName: string; accountIndex: number; label?: string; consentUrl?: string }>(
        `/providers/${providerName}/connect`,
        { method: "POST", body: JSON.stringify(accountFields) },
      ),
    createAccount: (providerName: string, accountFields: Record<string, string | number | boolean>) =>
      request<{ providerName: string; accountIndex: number; label?: string }>(
        `/providers/${providerName}/accounts`,
        { method: "POST", body: JSON.stringify(accountFields) },
      ),
    patchAccount: (providerName: string, accountIndex: number, patch: Partial<ProviderAccountRecord>) =>
      request<ProviderAccountRecord>(`/providers/accounts/${providerName}/${accountIndex}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    removeAccount: (providerName: string, accountIndex: number) =>
      request<void>(`/providers/accounts/${providerName}/${accountIndex}`, { method: "DELETE" }),
    refreshPriority: (mode?: PrioritySortMode) =>
      request<ProviderAccountRecord[]>("/providers/refresh-priority", {
        method: "POST",
        body: JSON.stringify({ mode }),
      }),
  },
  files: {
    list: (status?: FileStatus) =>
      request<OmniFile[]>(`/files${status ? `?status=${status}` : ""}`),
    get: (fileUuid: string) => request<OmniFile>(`/files/${fileUuid}`),
    remove: (fileUuid: string) => request<void>(`/files/${fileUuid}`, { method: "DELETE" }),
    retry: (fileUuid: string) => request<OmniFile>(`/files/${fileUuid}/retry`, { method: "POST" }),
    downloadUrl: (fileUuid: string) => `/api/files/${fileUuid}/download`,
    /**
     * Range-request URL. Because the endpoint honours HTTP `Range:`, this can
     * be dropped straight into a <video src> or <audio src> and the browser
     * will seek through it — fetching only the blocks it actually needs.
     */
    rangeUrl: (fileUuid: string) => `/api/files/${fileUuid}/range`,
    readRange: async (fileUuid: string, offset: number, length: number): Promise<Blob> => {
      const res = await fetch(`/api/files/${fileUuid}/range?offset=${offset}&length=${length}`);
      if (!res.ok) throw new Error(`Range read failed: ${res.status}`);
      return res.blob();
    },
    patch: (
      fileUuid: string,
      patch: {
        fileName?: string;
        parentFolderId?: string | null;
        hydrationPolicy?: HydrationPolicy | null;
      },
    ) =>
      request<OmniFile>(`/files/${fileUuid}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    upload: async (
      file: File,
      compression?: CompressionAlgo,
      folderId?: string,
    ): Promise<OmniFile> => {
      const form = new FormData();
      form.append("file", file);
      if (compression) form.append("compression", compression);
      if (folderId) form.append("folderId", folderId);
      return request<OmniFile>("/files/upload", { method: "POST", body: form });
    },
  },
  folders: {
    list: (parentId?: string) =>
      request<Folder[]>(`/folders${parentId ? `?parentId=${parentId}` : "?root=1"}`),
    create: (folderName: string, parentFolderId?: string) =>
      request<Folder>("/folders", {
        method: "POST",
        body: JSON.stringify({ folderName, parentFolderId }),
      }),
    patch: (folderId: string, patch: { folderName?: string; parentFolderId?: string | null }) =>
      request<Folder>(`/folders/${folderId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    remove: (folderId: string) => request<void>(`/folders/${folderId}`, { method: "DELETE" }),
  },
  cache: {
    stats: () => request<CacheStats>("/cache"),
    clear: () => request<void>("/cache", { method: "DELETE" }),
  },
  stats: {
    get: () => request<StatsPayload>("/stats"),
  },
  settings: {
    get: () => request<GlobalSettings>("/settings"),
    patch: (patch: Partial<GlobalSettings>) =>
      request<GlobalSettings>("/settings", { method: "PATCH", body: JSON.stringify(patch) }),
    vaultStatus: () => request<{ backend: "os_keychain" | "encrypted_file" }>("/settings/vault-status"),
    resetAll: () => request<{ reset: boolean }>("/settings/reset-all", { method: "DELETE" }),
  },
};
