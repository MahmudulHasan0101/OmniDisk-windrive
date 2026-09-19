import { google, type drive_v3 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { Readable } from "node:stream";
import { ProviderAccountBase } from "../core/provider-account-base.js";
import type { FileBlock, ProviderAccountIdentity } from "../core/models.js";

export interface GoogleDriveAppConfig {
  clientId: string;
  clientSecret: string;
}

export interface GoogleDriveAccountConfig {
  accountIndex: number;
  label?: string;
  app: GoogleDriveAppConfig;
  refreshToken: string;
  /** Called whenever the SDK mints a fresh access token, so the caller can persist it if desired. */
  onTokenRefresh?: (tokens: { access_token?: string | null }) => void;
}

const API_ORIGIN = "http://127.0.0.1:4310"; // matches server/index.ts's default bind — see README "Running it"
// OMNIDISK_PUBLIC_URL overrides this for deployments where the server isn't
// reached at localhost — e.g. a Colab tunnel URL, where the browser doing
// the OAuth dance is on the user's own machine, not inside the Colab VM,
// so a loopback address would be unreachable for the redirect.
const REDIRECT_URI = `${process.env.OMNIDISK_PUBLIC_URL ?? API_ORIGIN}/api/providers/google_drive/oauth-callback`;
const FOLDER_NAME = "OmniDisk_Fragments";
const RESUMABLE_THRESHOLD_BYTES = 5 * 1024 * 1024; // per provider-setup-guide.md §1

/**
 * See provider-setup-guide.md §1 for the full OAuth setup steps and API
 * mapping this class implements. Scope is `drive.file` (least privilege —
 * only sees files this app created), per that guide's recommendation.
 */
export class GoogleDriveAccount extends ProviderAccountBase {
  readonly identity: ProviderAccountIdentity;
  readonly baseUrl = "https://www.googleapis.com/drive/v3";

  private readonly oauth2Client: OAuth2Client;
  private readonly drive: drive_v3.Drive;
  private folderId: string | undefined;

  constructor(config: GoogleDriveAccountConfig) {
    super();
    this.identity = {
      providerName: "google_drive",
      accountIndex: config.accountIndex,
      label: config.label,
    };

    this.oauth2Client = new OAuth2Client(
      config.app.clientId,
      config.app.clientSecret,
      REDIRECT_URI,
    );
    this.oauth2Client.setCredentials({ refresh_token: config.refreshToken });
    if (config.onTokenRefresh) {
      this.oauth2Client.on("tokens", config.onTokenRefresh);
    }

    this.drive = google.drive({ version: "v3", auth: this.oauth2Client });
  }

  /**
   * Builds the one-time consent URL for step "run the OAuth flow once" in
   * the setup guide. The caller (AddProviderModal, via the /connect route)
   * full-page-navigates the browser here. Google redirects back to
   * REDIRECT_URI — a route on this same server, since OmniDisk runs
   * locally and can just handle the callback itself — which exchanges the
   * code and then redirects the browser back to the dashboard.
   */
  static buildConsentUrl(app: GoogleDriveAppConfig, state: string): string {
    const client = new OAuth2Client(app.clientId, app.clientSecret, REDIRECT_URI);
    return client.generateAuthUrl({
      access_type: "offline", // required to get a refresh_token back
      prompt: "consent", // force a refresh_token even on repeat consent
      scope: ["https://www.googleapis.com/auth/drive.file"],
      state,
    });
  }

  static async exchangeCodeForTokens(
    app: GoogleDriveAppConfig,
    code: string,
  ): Promise<{ refreshToken: string }> {
    const client = new OAuth2Client(app.clientId, app.clientSecret, REDIRECT_URI);
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      throw new Error(
        "Google didn't return a refresh_token — make sure access_type=offline and " +
          "prompt=consent were set, and that this isn't a repeat consent for an " +
          "already-authorized app (revoke access in your Google Account first).",
      );
    }
    return { refreshToken: tokens.refresh_token };
  }

  /** Finds (or creates) the dedicated app folder, caching its id for the session. */
  private async getFolderId(): Promise<string> {
    if (this.folderId) return this.folderId;

    const existing = await this.drive.files.list({
      q: `name = '${FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id, name)",
      spaces: "drive",
    });
    const found = existing.data.files?.[0]?.id;
    if (found) {
      this.folderId = found;
      return found;
    }

    const created = await this.drive.files.create({
      requestBody: { name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" },
      fields: "id",
    });
    if (!created.data.id) throw new Error("Google Drive didn't return an id for the created folder");
    this.folderId = created.data.id;
    return this.folderId;
  }

  private async findBlockFileId(remotePath: string): Promise<string | undefined> {
    const folderId = await this.getFolderId();
    const res = await this.drive.files.list({
      q: `'${folderId}' in parents and name = '${remotePath}' and trashed = false`,
      fields: "files(id, name)",
      spaces: "drive",
    });
    return res.data.files?.[0]?.id ?? undefined;
  }

  async getStorableSpace(): Promise<number> {
    const res = await this.drive.about.get({ fields: "storageQuota" });
    const quota = res.data.storageQuota;
    // Missing `limit` = unlimited-quota Workspace account, per setup guide quirks.
    if (!quota?.limit) return Number.MAX_SAFE_INTEGER;
    const limit = Number(quota.limit);
    const usage = Number(quota.usage ?? 0);
    return Math.max(0, limit - usage);
  }

  async getStats(): Promise<import("../core/models.js").ProviderAccountStats> {
    const res = await this.drive.about.get({ fields: "storageQuota" });
    const quota = res.data.storageQuota;
    const hasLimit = !!quota?.limit;
    const total = hasLimit ? Number(quota!.limit) : 0; // 0 = unbounded/unknown, not zero capacity
    const used = Number(quota?.usage ?? 0);
    return {
      totalSpace: total,
      usedSpace: used,
      freeSpace: hasLimit ? Math.max(0, total - used) : Number.MAX_SAFE_INTEGER,
      blockCount: 0,
      avgLatencyMs: 0,
      avgSpeedBps: 0,
      lastProbedAt: new Date().toISOString(),
      priorityScore: this.priorityScore,
      enabled: this.enabled,
    };
  }

  async store(block: FileBlock, data: Buffer): Promise<FileBlock> {
    const folderId = await this.getFolderId();
    const media = { body: Readable.from(data) };
    // Resumable upload for anything over ~5MB — googleapis picks this
    // automatically based on body size/type, but we keep the threshold
    // documented here since it drives OmniDisk's chunk-size choice too.
    void RESUMABLE_THRESHOLD_BYTES;

    const existingId = await this.findBlockFileId(block.remotePath);
    if (existingId) {
      await this.drive.files.update({ fileId: existingId, media });
    } else {
      await this.drive.files.create({
        requestBody: { name: block.remotePath, parents: [folderId] },
        media,
        fields: "id",
      });
    }
    return block;
  }

  async retrieve(block: FileBlock): Promise<Buffer> {
    const fileId = await this.findBlockFileId(block.remotePath);
    if (!fileId) throw new Error(`No block found at ${block.remotePath} in Google Drive`);
    const res = await this.drive.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" },
    );
    return Buffer.from(res.data as ArrayBuffer);
  }

  async delete(block: FileBlock): Promise<void> {
    const fileId = await this.findBlockFileId(block.remotePath);
    if (!fileId) return; // already gone — delete is idempotent
    await this.drive.files.delete({ fileId });
  }

  async pingLatency(): Promise<number> {
    const start = Date.now();
    await this.drive.about.get({ fields: "user" });
    return Date.now() - start;
  }

  async measureThroughput(): Promise<number> {
    const sample = Buffer.alloc(64 * 1024, 1);
    const probeBlock: FileBlock = {
      blockId: `__probe_${this.identity.accountIndex}`,
      fileUuid: "__probe",
      providerName: "google_drive",
      accountIndex: this.identity.accountIndex,
      blockIndex: 0,
      logicalStart: 0,
      logicalLength: sample.length,
      storedSize: sample.length,
      compressionUsed: "none",
      remotePath: `__omnidisk_probe_${Date.now()}`,
      status: "pending",
      retryCount: 0,
    };
    const start = Date.now();
    await this.store(probeBlock, sample);
    const elapsedMs = Date.now() - start;
    await this.delete(probeBlock).catch(() => {});
    return elapsedMs > 0 ? Math.round((sample.length / elapsedMs) * 1000) : sample.length;
  }
}
