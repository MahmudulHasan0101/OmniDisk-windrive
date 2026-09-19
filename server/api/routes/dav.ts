import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { getDb, TMP_UPLOADS_DIR } from "../../db/client.js";
import {
  FileRepository,
  FolderRepository,
  ProviderAccountRepository,
  SettingsRepository,
} from "../../db/repository.js";
import { readRange } from "../../core/block-router.js";
import { ingestStagedFile, purgeFile } from "../../core/ingest.js";
import type { BlockCache } from "../../core/block-cache.js";
import type { Folder, OmniFile, ProviderAccountRecord } from "../../core/models.js";
import type { AccountRegistry } from "../../core/account-registry.js";
import type { PriorityManager } from "../../core/priority-manager.js";
import { progressBus } from "../progress-bus.js";

/**
 * WebDAV front door for the virtual drive (Virtual Drive Spec §3.1, Phase 4).
 *
 *   net use O: http://localhost:4310/dav
 *
 * This is a thin protocol adapter. It owns no storage logic: reads go through
 * the same block router + cache as GET /api/files/:id/range, writes go through
 * the same ingest pipeline as POST /api/files/upload, and the directory tree
 * is the existing `folders`/`files` tables.
 *
 * Deliberately implemented for Windows' built-in client (the WebClient
 * service / "MiniRedir"), which is the pickiest one in common use:
 *   - `DAV: 1, 2` on OPTIONS — without class 2 Office treats the share as
 *     read-only, and the redirector is stricter about it than Finder/GVFS.
 *   - LOCK/UNLOCK exist only to satisfy that; locks are recorded, never
 *     enforced (OmniDisk is single-user, spec §2 non-goals).
 *   - PROPPATCH is acknowledged but not stored: Windows fires one after every
 *     PUT to set Win32 timestamps, and a failure there surfaces to the user
 *     as a copy error.
 *   - quota-available-bytes / quota-used-bytes are answered so Explorer shows
 *     real free space instead of an empty drive. Windows displays
 *     capacity = available + used, so the two are reported as one consistent
 *     pool: the summed quota of the connected accounts and what those accounts
 *     currently hold.
 *
 * NO AUTHENTICATION. Like the rest of the API this relies on the localhost
 * bind (server/index.ts). Windows also refuses Basic auth over plain HTTP by
 * default, so adding auth here later means moving to HTTPS first.
 */

// @fastify/cors reads `config.cors === false` at runtime as a per-route opt-out,
// but doesn't declare it in its typings.
declare module "fastify" {
  interface FastifyContextConfig {
    cors?: boolean;
  }
}

const PREFIX = "/dav";
const WEBDAV_METHODS: Record<string, boolean> = {
  PROPFIND: true,
  PROPPATCH: true,
  LOCK: true,
  MKCOL: false,
  MOVE: false,
  COPY: false,
  UNLOCK: false,
};
const ALLOWED_METHODS =
  "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MOVE, LOCK, UNLOCK";
const LOCK_TIMEOUT_SECONDS = 3600;
const MAX_XML_BODY_BYTES = 1024 * 1024;
/** Free-space figures are re-read from the providers at most this often. */
const SPACE_CACHE_MS = 60_000;
/** A provider that can't report its quota this fast falls back to the last saved figures. */
const SPACE_FETCH_TIMEOUT_MS = 8_000;

type FileSummary = Omit<OmniFile, "blocks">;

type DavNode =
  | { kind: "root" }
  | { kind: "folder"; folder: Folder }
  | { kind: "file"; file: FileSummary };

interface LockRecord {
  path: string;
  owner: string;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const ciEqual = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Splits a URL pathname under /dav into decoded name segments. Returns null
 * for anything outside the namespace or containing traversal / separators,
 * so a crafted path can never mean anything but "a name in the tree".
 */
export function splitDavPath(pathname: string): string[] | null {
  if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return null;
  const segments: string[] = [];
  for (const raw of pathname.slice(PREFIX.length).split("/")) {
    if (raw === "") continue;
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (segment === "." || segment === ".." || /[\\/\0]/.test(segment)) return null;
    segments.push(segment);
  }
  return segments;
}

function hrefFor(segments: string[], isCollection: boolean): string {
  if (segments.length === 0) return `${PREFIX}/`;
  const path = `${PREFIX}/${segments.map(encodeURIComponent).join("/")}`;
  return isCollection ? `${path}/` : path;
}

/** Rejects if `promise` hasn't settled in `ms`; never leaves an unhandled rejection or a live timer behind. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** Providers word "your storage is full" differently; MEGA reports it as error -17. */
const QUOTA_ERROR_PATTERN = /over ?quota|error -17\b|insufficient|storage (is )?full|not enough (space|storage)/i;

/** One human-readable line saying why an upload's blocks didn't all land, using the providers' own messages. */
export function describeUploadFailure(file: OmniFile): string {
  const failed = file.blocks.filter((b) => b.status !== "stored");
  const reasons = [...new Set(failed.map((b) => b.lastError).filter((m): m is string => !!m))];
  const summary = `${failed.length} of ${file.blocks.length} block(s) could not be stored`;
  return reasons.length > 0 ? `${summary}: ${reasons.join("; ")}` : summary;
}

/** Pathname of the request URL without the query string. */
const pathOf = (request: FastifyRequest): string => (request.raw.url ?? "").split("?")[0] ?? "";

/** Last path segment; callers have already rejected the empty (root) case. */
const lastOf = (segments: string[]): string => segments.at(-1) ?? "";

/** Parses a single-range `Range:` header. null = ignore (serve whole file). */
export function parseByteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null; // multi-range or malformed: fall back to a full 200
  const first = match[1] ?? "";
  const last = match[2] ?? "";
  if (first === "" && last === "") return null;

  let start: number;
  let end: number;
  if (first === "") {
    const suffix = Number(last);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(first);
    end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

async function readXmlBody(request: FastifyRequest): Promise<string> {
  const body = request.body as unknown;
  if (!body) return "";
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body) {
      total += (chunk as Buffer).length;
      // Keep draining past the limit so the connection stays usable, but stop keeping bytes.
      if (total <= MAX_XML_BODY_BYTES) chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  return "";
}

/** Discards an unread request body (raw stream) so the socket isn't left mid-request. */
function drain(request: FastifyRequest): void {
  const body = request.body as unknown;
  if (body instanceof Readable) body.resume();
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerDavRoutes(
  app: FastifyInstance,
  deps: {
    registry: AccountRegistry;
    priorityManager: PriorityManager;
    blockCache: BlockCache;
  },
): void {
  // Fastify doesn't route the WebDAV verbs unless told they exist; without
  // this every PROPFIND/MKCOL/etc. gets "Route not found" before reaching us.
  // `hasBody` marks the verbs whose requests carry an XML payload.
  for (const [method, hasBody] of Object.entries(WEBDAV_METHODS)) {
    app.addHttpMethod(method, { hasBody, overrideExisting: true });
  }

  const db = getDb();
  const fileRepo = new FileRepository(db);
  const folderRepo = new FolderRepository(db);
  const providerRepo = new ProviderAccountRepository(db);
  const settingsRepo = new SettingsRepository(db);
  const locks = new Map<string, LockRecord>();
  const startedAt = new Date().toISOString();

  const resolveAccount = (providerName: string, accountIndex: number) =>
    deps.registry.resolve(providerName, accountIndex);

  // -------------------------------------------------------------------------
  // Tree access
  // -------------------------------------------------------------------------

  /**
   * Children of a folder as the mount should see them. Only `complete` files
   * appear: an in-flight, failed, or partially-stored upload has no readable
   * bytes, and listing it would make Explorer show files that error on open.
   * If names collide (the schema doesn't forbid it) the newest wins, so a
   * listing never contains two entries with the same href.
   */
  function listChildren(parentId: string | null): { folders: Folder[]; files: FileSummary[] } {
    const folders = folderRepo.listChildren(parentId);
    const seen = new Set<string>();
    const files: FileSummary[] = [];
    for (const file of fileRepo.listFiles("complete", parentId)) {
      // listFiles is ordered newest-first, so first occurrence = newest.
      if (seen.has(file.fileName)) continue;
      seen.add(file.fileName);
      files.push(file);
    }
    return { folders, files };
  }

  /** Exact match first; case-insensitive second, because Windows treats names that way. */
  function findChild(parentId: string | null, name: string): DavNode | null {
    const { folders, files } = listChildren(parentId);
    const folder = folders.find((f) => f.folderName === name);
    if (folder) return { kind: "folder", folder };
    const file = files.find((f) => f.fileName === name);
    if (file) return { kind: "file", file };
    const ciFolder = folders.find((f) => ciEqual(f.folderName, name));
    if (ciFolder) return { kind: "folder", folder: ciFolder };
    const ciFile = files.find((f) => ciEqual(f.fileName, name));
    if (ciFile) return { kind: "file", file: ciFile };
    return null;
  }

  function resolve(segments: string[]): DavNode | null {
    if (segments.length === 0) return { kind: "root" };
    let parentId: string | null = null;
    for (let i = 0; i < segments.length; i++) {
      const node = findChild(parentId, segments[i] ?? "");
      if (!node) return null;
      if (i === segments.length - 1) return node;
      if (node.kind !== "folder") return null;
      parentId = node.folder.folderId;
    }
    return null;
  }

  /** Folder id that would contain `segments`' last element. null = root, undefined = doesn't exist. */
  function resolveParentId(segments: string[]): string | null | undefined {
    const parent = resolve(segments.slice(0, -1));
    if (!parent) return undefined;
    if (parent.kind === "root") return null;
    if (parent.kind === "folder") return parent.folder.folderId;
    return undefined;
  }

  const nodeId = (node: DavNode): string =>
    node.kind === "root" ? "root" : node.kind === "folder" ? node.folder.folderId : node.file.fileUuid;

  async function deleteFolderTree(folderId: string): Promise<void> {
    for (const child of folderRepo.listChildren(folderId)) {
      await deleteFolderTree(child.folderId);
    }
    // Every status, not just `complete`: a failed upload still owns rows (and
    // maybe remote blocks) that would otherwise block the folder delete.
    for (const summary of fileRepo.listFiles(undefined, folderId)) {
      const full = fileRepo.getFile(summary.fileUuid);
      if (full) {
        await purgeFile({ registry: deps.registry, fileRepo, blockCache: deps.blockCache }, full);
      }
    }
    folderRepo.delete(folderId);
  }

  async function deleteNode(node: DavNode): Promise<void> {
    if (node.kind === "folder") {
      await deleteFolderTree(node.folder.folderId);
    } else if (node.kind === "file") {
      const full = fileRepo.getFile(node.file.fileUuid);
      if (full) {
        await purgeFile({ registry: deps.registry, fileRepo, blockCache: deps.blockCache }, full);
      }
    }
  }

  /**
   * Removes everything a rejected upload left behind: remote blocks that did
   * land, the metadata rows, and the on-disk retry copy. The REST route keeps
   * a partial upload around because the dashboard can retry it; a WebDAV
   * client has no retry button, and a lingering half-file just wastes quota.
   */
  async function discardUpload(fileUuid: string): Promise<void> {
    const full = fileRepo.getFile(fileUuid);
    if (full) {
      try {
        await purgeFile({ registry: deps.registry, fileRepo, blockCache: deps.blockCache }, full);
      } catch (err) {
        app.log.warn({ err, fileUuid }, "Cleanup of a rejected upload was incomplete");
        fileRepo.deleteFile(fileUuid);
      }
    }
    await rm(join(TMP_UPLOADS_DIR, `${fileUuid}.staged`), { force: true });
  }

  // -------------------------------------------------------------------------
  // Free space
  // -------------------------------------------------------------------------

  interface AccountSpace {
    total: number;
    used: number;
    /** false = came from the last saved figures because the provider couldn't be asked. */
    live: boolean;
  }
  const spaceCache = new Map<string, { at: number; value: Promise<AccountSpace> }>();

  /**
   * An account's quota and usage. Asked of the provider itself (cached for a
   * minute), because the saved figures are only as fresh as the last
   * background probe and are missing entirely if that probe never succeeded.
   * Falls back to the saved figures if the provider can't answer in time.
   */
  function accountSpace(record: ProviderAccountRecord): Promise<AccountSpace> {
    const key = `${record.providerName}:${record.accountIndex}`;
    const cached = spaceCache.get(key);
    if (cached && Date.now() - cached.at < SPACE_CACHE_MS) return cached.value;

    const saved: AccountSpace = {
      total: record.totalSpace ?? 0,
      used: record.usedSpace ?? 0,
      live: false,
    };
    const adapter = deps.registry.tryResolve(record.providerName, record.accountIndex);

    const value = (async (): Promise<AccountSpace> => {
      if (!adapter) return saved;
      try {
        const stats = await withTimeout(adapter.getStats(), SPACE_FETCH_TIMEOUT_MS);
        if (stats.totalSpace > 0) {
          return { total: stats.totalSpace, used: stats.usedSpace, live: true };
        }
      } catch (err) {
        app.log.warn({ err, account: key }, "Could not read live quota; using last saved figures");
      }
      return saved;
    })();

    spaceCache.set(key, { at: Date.now(), value });
    // Never pin a fallback: the next request should try the provider again.
    void value.then((space) => {
      if (!space.live) spaceCache.delete(key);
    });
    return value;
  }

  /**
   * Windows shows a drive's capacity as quota-available-bytes +
   * quota-used-bytes. So these are two halves of ONE pool — total quota of the
   * connected accounts, and how much of it is taken (by OmniDisk blocks or by
   * anything else in those accounts) — so that available + used is exactly
   * the summed quota, e.g. 2 x 20 GB MEGA accounts = 40 GB. Reporting the
   * logical size of the stored files as "used" instead makes the capacity
   * wander with every upload and never match what the providers hold.
   */
  async function quotaFigures(): Promise<{ available: number; used: number }> {
    // Only accounts with a live adapter can actually receive blocks.
    const records = providerRepo
      .list()
      .filter((r) => r.enabled && deps.registry.tryResolve(r.providerName, r.accountIndex));
    const spaces = await Promise.all(records.map(accountSpace));

    let total = 0;
    let available = 0;
    for (const space of spaces) {
      // total <= 0 means "unknown or unbounded" (e.g. a Workspace Drive with no
      // cap): it can't be added to a finite capacity, so it's left out.
      if (space.total <= 0) continue;
      total += space.total;
      available += Math.max(0, space.total - space.used);
    }
    return { available, used: total - available };
  }

  // -------------------------------------------------------------------------
  // PROPFIND XML
  // -------------------------------------------------------------------------

  const SUPPORTED_LOCK_XML =
    "<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope>" +
    "<D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>";

  function responseXml(
    node: DavNode,
    segments: string[],
    includeQuota: boolean,
    quota: { available: number; used: number } | null,
  ): string {
    const isCollection = node.kind !== "file";
    const href = escapeXml(hrefFor(segments, isCollection));
    let props: string;

    if (node.kind === "file") {
      const f = node.file;
      const modified = new Date(f.fileUploadDate).toUTCString();
      props =
        `<D:displayname>${escapeXml(f.fileName)}</D:displayname>` +
        `<D:creationdate>${new Date(f.fileUploadDate).toISOString()}</D:creationdate>` +
        `<D:getlastmodified>${modified}</D:getlastmodified>` +
        `<D:resourcetype/>` +
        `<D:getcontentlength>${f.fileSize}</D:getcontentlength>` +
        `<D:getcontenttype>application/octet-stream</D:getcontenttype>` +
        `<D:getetag>"${f.sha256Original ?? f.fileUuid}"</D:getetag>` +
        SUPPORTED_LOCK_XML;
    } else {
      const name = node.kind === "folder" ? node.folder.folderName : "OmniDisk";
      const created = node.kind === "folder" ? node.folder.createdAt : startedAt;
      props =
        `<D:displayname>${escapeXml(name)}</D:displayname>` +
        `<D:creationdate>${new Date(created).toISOString()}</D:creationdate>` +
        `<D:getlastmodified>${new Date(created).toUTCString()}</D:getlastmodified>` +
        `<D:resourcetype><D:collection/></D:resourcetype>` +
        SUPPORTED_LOCK_XML;
      if (includeQuota && quota) {
        props +=
          `<D:quota-available-bytes>${quota.available}</D:quota-available-bytes>` +
          `<D:quota-used-bytes>${quota.used}</D:quota-used-bytes>`;
      }
    }

    return (
      `<D:response><D:href>${href}</D:href><D:propstat><D:prop>${props}</D:prop>` +
      `<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
    );
  }

  const multistatus = (inner: string, extraNs = ""): string =>
    `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:"${extraNs}>${inner}</D:multistatus>`;

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  const davHeaders = (reply: FastifyReply): FastifyReply =>
    reply.header("DAV", "1, 2").header("MS-Author-Via", "DAV");

  const options = async (_request: FastifyRequest, reply: FastifyReply) =>
    davHeaders(reply).header("Allow", ALLOWED_METHODS).header("Accept-Ranges", "bytes").code(200).send();

  const propfind = async (request: FastifyRequest, reply: FastifyReply) => {
    const segments = splitDavPath(pathOf(request));
    const xml = await readXmlBody(request);
    if (!segments) return reply.code(404).send();
    const node = resolve(segments);
    if (!node) return reply.code(404).send();

    // Depth: infinity is allowed to be refused (RFC 4918 §9.1); clamping to 1
    // is friendlier and no real client relies on a whole-tree walk here.
    const depth = request.headers.depth === "0" ? 0 : 1;
    const wantsQuota = /quota-(available|used)-bytes/i.test(xml);
    const quota = wantsQuota ? await quotaFigures() : null;

    let inner = responseXml(node, segments, wantsQuota, quota);
    if (depth === 1 && node.kind !== "file") {
      const parentId = node.kind === "root" ? null : node.folder.folderId;
      const { folders, files } = listChildren(parentId);
      for (const folder of folders) {
        inner += responseXml(
          { kind: "folder", folder },
          [...segments, folder.folderName],
          false,
          null,
        );
      }
      for (const file of files) {
        inner += responseXml({ kind: "file", file }, [...segments, file.fileName], false, null);
      }
    }

    return reply
      .code(207)
      .header("Content-Type", 'application/xml; charset="utf-8"')
      .send(multistatus(inner));
  };

  const proppatch = async (request: FastifyRequest, reply: FastifyReply) => {
    const segments = splitDavPath(pathOf(request));
    const xml = await readXmlBody(request);
    if (!segments || !resolve(segments)) return reply.code(404).send();

    // Acknowledge every requested property without storing it. Echo the
    // names back so the client's per-property status lookup finds them.
    const namespaces = [...xml.matchAll(/xmlns:([A-Za-z0-9_-]+)="([^"]*)"/g)]
      .map((m) => ` xmlns:${m[1] ?? ""}="${escapeXml(m[2] ?? "")}"`)
      .join("");
    const names = new Set<string>();
    for (const block of xml.matchAll(/<(?:[\w-]+:)?prop\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?prop>/g)) {
      for (const tag of (block[1] ?? "").matchAll(/<([A-Za-z0-9_-]+:[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+)(?=[\s/>])/g)) {
        if (tag[1]) names.add(tag[1]);
      }
    }
    const echoed = [...names].map((n) => `<${n}/>`).join("");
    const inner =
      `<D:response><D:href>${escapeXml(hrefFor(segments, resolve(segments)!.kind !== "file"))}</D:href>` +
      `<D:propstat><D:prop>${echoed}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;

    return reply
      .code(207)
      .header("Content-Type", 'application/xml; charset="utf-8"')
      .send(multistatus(inner, namespaces));
  };

  async function* streamFileRange(
    file: FileSummary,
    start: number,
    endInclusive: number,
  ): AsyncGenerator<Buffer> {
    // One block per iteration: each yield is a bounded allocation, and
    // sequential reads within a block are served from the cache after the
    // first fetch. A 20GB file therefore never sits in memory whole.
    let position = start;
    while (position <= endInclusive) {
      const blockIndex = Math.floor(position / file.logicalBlockSize);
      const chunkEndExclusive = Math.min(endInclusive + 1, (blockIndex + 1) * file.logicalBlockSize);
      const blocks = fileRepo.getBlockRange(file.fileUuid, blockIndex, blockIndex);
      yield await readRange(
        blocks,
        file.logicalBlockSize,
        file.fileSize,
        position,
        chunkEndExclusive - position,
        resolveAccount,
        {
          getCached: (block) => deps.blockCache.get(block),
          putCached: (block, data) => deps.blockCache.put(block, data),
        },
      );
      position = chunkEndExclusive;
    }
  }

  const get = (headOnly: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
    const segments = splitDavPath(pathOf(request));
    if (!segments) return reply.code(404).send();
    const node = resolve(segments);
    if (!node) return reply.code(404).send();

    if (node.kind !== "file") {
      // A browser pointed at the mount URL lands here; say what it is.
      return reply
        .code(200)
        .header("Content-Type", "text/plain; charset=utf-8")
        .send(
          headOnly
            ? undefined
            : "OmniDisk WebDAV endpoint. Mount it as a network drive rather than opening it in a browser.\n",
        );
    }

    const file = node.file;
    const range = parseByteRange(
      typeof request.headers.range === "string" ? request.headers.range : undefined,
      file.fileSize,
    );

    reply
      .header("Accept-Ranges", "bytes")
      .header("Content-Type", "application/octet-stream")
      .header("ETag", `"${file.sha256Original ?? file.fileUuid}"`)
      .header("Last-Modified", new Date(file.fileUploadDate).toUTCString());

    if (range === "unsatisfiable") {
      return reply.code(416).header("Content-Range", `bytes */${file.fileSize}`).send();
    }

    const start = range ? range.start : 0;
    const end = range ? range.end : file.fileSize - 1;
    const length = file.fileSize === 0 ? 0 : end - start + 1;

    if (range) {
      reply.code(206).header("Content-Range", `bytes ${start}-${end}/${file.fileSize}`);
    } else {
      reply.code(200);
    }
    reply.header("Content-Length", String(length));

    if (headOnly || length === 0) return reply.send();
    return reply.send(Readable.from(streamFileRange(file, start, end), { objectMode: false }));
  };

  const put = async (request: FastifyRequest, reply: FastifyReply) => {
    const segments = splitDavPath(pathOf(request));
    if (!segments) {
      drain(request);
      return reply.code(404).send();
    }
    if (segments.length === 0) {
      drain(request);
      return reply.code(405).send();
    }

    const parentId = resolveParentId(segments);
    if (parentId === undefined) {
      drain(request);
      return reply.code(409).send(); // intermediate collection missing
    }
    const name = lastOf(segments);
    const existing = findChild(parentId, name);
    if (existing?.kind === "folder") {
      drain(request);
      return reply.code(405).send();
    }

    // Same up-front check as the REST upload: nowhere to put bytes at all is
    // a different problem from "not enough space", and deserves its own answer.
    if (!deps.registry.all().some((a) => a.enabled)) {
      drain(request);
      return reply
        .code(507)
        .header("Content-Type", "text/plain; charset=utf-8")
        .send("No provider accounts have a live connection, so there is nowhere to store this file.");
    }

    const fileUuid = randomUUID();
    const stagedPath = join(TMP_UPLOADS_DIR, `${fileUuid}.original`);
    const body = request.body as unknown;

    try {
      const hash = createHash("sha256");
      if (body instanceof Readable) {
        body.on("data", (chunk: Buffer) => hash.update(chunk));
        await pipeline(body, createWriteStream(stagedPath));
      } else {
        // No body at all (Content-Length: 0): Explorer's "New text document" does this.
        const empty = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
        hash.update(empty);
        await pipeline(Readable.from([empty]), createWriteStream(stagedPath));
      }

      const fail = async (status: number, message: string) => {
        await discardUpload(fileUuid);
        return reply.code(status).header("Content-Type", "text/plain; charset=utf-8").send(message);
      };

      let result: Awaited<ReturnType<typeof ingestStagedFile>>;
      try {
        result = await ingestStagedFile(
          {
            registry: deps.registry,
            priorityManager: deps.priorityManager,
            fileRepo,
            providerRepo,
            settingsRepo,
            onBlockUpdate: (uuid, block) => progressBus.publish({ fileUuid: uuid, block }),
            logWarn: (context, message) => app.log.warn(context, message),
          },
          {
            fileUuid,
            stagedOriginalPath: stagedPath,
            fileName: name,
            parentFolderId: parentId ?? undefined,
            sha256Original: hash.digest("hex"),
          },
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        app.log.error({ err, path: pathOf(request) }, `WebDAV PUT failed while ingesting: ${reason}`);
        return fail(502, `Upload failed: ${reason}`);
      }

      if (!result.ok) {
        app.log.warn({ path: pathOf(request), unplacedBytes: result.body.unplacedBytes }, result.body.error);
        return fail(507, result.body.error);
      }

      // "ok" only means the blocks were planned and attempted. If any block was
      // rejected by its provider the file is not readable, and answering 201
      // makes the client believe a file exists that will 404 on the next
      // request — while the old version (if this was an overwrite) is still
      // untouched. Say so, with the provider's own words.
      if (result.file.status !== "complete") {
        const reason = describeUploadFailure(result.file);
        app.log.error(
          { path: pathOf(request), fileSize: result.file.fileSize, status: result.file.status },
          `WebDAV PUT rejected by provider — ${reason}`,
        );
        return fail(QUOTA_ERROR_PATTERN.test(reason) ? 507 : 502, `Upload failed: ${reason}`);
      }

      // Overwrite = upload the new version first, THEN drop the old one, so a
      // failed upload never costs the user the file they already had.
      if (existing?.kind === "file") {
        await deleteNode(existing);
      }
      return reply.code(existing ? 204 : 201).send();
    } finally {
      await rm(stagedPath, { force: true });
      // Ingest keeps this copy of an incomplete upload so the dashboard can
      // retry it. Nothing retries a WebDAV PUT, so don't leave it on disk.
      await rm(join(TMP_UPLOADS_DIR, `${fileUuid}.staged`), { force: true });
    }
  };

  const del = async (request: FastifyRequest, reply: FastifyReply) => {
    const segments = splitDavPath(pathOf(request));
    if (!segments) return reply.code(404).send();
    if (segments.length === 0) return reply.code(403).send();
    const node = resolve(segments);
    if (!node) return reply.code(404).send();
    await deleteNode(node);
    return reply.code(204).send();
  };

  const mkcol = async (request: FastifyRequest, reply: FastifyReply) => {
    const segments = splitDavPath(pathOf(request));
    if (!segments || segments.length === 0) return reply.code(405).send();
    const parentId = resolveParentId(segments);
    if (parentId === undefined) return reply.code(409).send();
    const name = lastOf(segments);
    if (findChild(parentId, name)) return reply.code(405).send();

    folderRepo.create({
      folderId: randomUUID(),
      folderName: name,
      parentFolderId: parentId ?? undefined,
      createdAt: new Date().toISOString(),
    });
    return reply.code(201).send();
  };

  const move = async (request: FastifyRequest, reply: FastifyReply) => {
    const srcSegments = splitDavPath(pathOf(request));
    if (!srcSegments) return reply.code(404).send();
    if (srcSegments.length === 0) return reply.code(403).send();
    const src = resolve(srcSegments);
    if (!src || src.kind === "root") return reply.code(404).send();

    const destHeader = request.headers.destination;
    if (typeof destHeader !== "string") return reply.code(400).send();
    let destPathname: string;
    try {
      destPathname = new URL(destHeader, "http://localhost").pathname;
    } catch {
      return reply.code(400).send();
    }
    const destSegments = splitDavPath(destPathname);
    if (!destSegments) return reply.code(502).send(); // destination outside this server's namespace
    if (destSegments.length === 0) return reply.code(403).send();

    const destParentId = resolveParentId(destSegments);
    if (destParentId === undefined) return reply.code(409).send();
    const newName = lastOf(destSegments);

    // Reparenting a folder into its own subtree would make the tree unwalkable.
    if (src.kind === "folder") {
      let cursor: string | null | undefined = destParentId;
      while (cursor) {
        if (cursor === src.folder.folderId) return reply.code(403).send();
        cursor = folderRepo.get(cursor)?.parentFolderId ?? null;
      }
    }

    const existing = resolve(destSegments);
    // Destination that resolves to the source itself is a rename in place —
    // including a case-only rename ("a.txt" -> "A.txt"), which Explorer does.
    const isSelf = existing !== null && nodeId(existing) === nodeId(src);
    if (existing && !isSelf) {
      if (String(request.headers.overwrite ?? "T").toUpperCase() === "F") {
        return reply.code(412).send();
      }
      await deleteNode(existing);
    }

    if (src.kind === "folder") {
      folderRepo.update(src.folder.folderId, { folderName: newName, parentFolderId: destParentId });
    } else {
      fileRepo.upsertFile({
        ...src.file,
        fileName: newName,
        parentFolderId: destParentId ?? undefined,
      });
    }
    return reply.code(existing && !isSelf ? 204 : 201).send();
  };

  const copy = async (_request: FastifyRequest, reply: FastifyReply) =>
    // A server-side copy would have to duplicate every block on the providers.
    // Windows Explorer copies client-side (GET + PUT) anyway, so this is a
    // clean "not supported" rather than a half-implementation.
    reply.code(501).header("Content-Type", "text/plain; charset=utf-8").send("COPY is not supported.");

  const lock = async (request: FastifyRequest, reply: FastifyReply) => {
    const segments = splitDavPath(pathOf(request));
    const xml = await readXmlBody(request);
    if (!segments) return reply.code(404).send();

    const ifHeader = typeof request.headers.if === "string" ? request.headers.if : "";
    const refreshToken = /opaquelocktoken:[0-9a-fA-F-]+/.exec(ifHeader)?.[0];
    const token = xml.trim() === "" && refreshToken ? refreshToken : `opaquelocktoken:${randomUUID()}`;

    const ownerInner = /<(?:[\w-]+:)?owner\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?owner>/i.exec(xml)?.[1] ?? "";
    // Text only: echoing raw request markup could reference namespace prefixes we never declared.
    const owner = ownerInner.replace(/<[^>]*>/g, "").trim();

    const requested = /Second-(\d+)/i.exec(String(request.headers.timeout ?? ""))?.[1];
    const seconds = requested ? Math.min(Number(requested), LOCK_TIMEOUT_SECONDS) : LOCK_TIMEOUT_SECONDS;

    locks.set(token, {
      path: hrefFor(segments, false),
      owner,
      expiresAt: Date.now() + seconds * 1000,
    });

    const body =
      `<?xml version="1.0" encoding="utf-8"?>\n<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>` +
      `<D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope>` +
      `<D:depth>0</D:depth><D:owner>${escapeXml(owner)}</D:owner>` +
      `<D:timeout>Second-${seconds}</D:timeout>` +
      `<D:locktoken><D:href>${token}</D:href></D:locktoken>` +
      `<D:lockroot><D:href>${escapeXml(hrefFor(segments, false))}</D:href></D:lockroot>` +
      `</D:activelock></D:lockdiscovery></D:prop>`;

    return reply
      .code(200)
      .header("Lock-Token", `<${token}>`)
      .header("Content-Type", 'application/xml; charset="utf-8"')
      .send(body);
  };

  const unlock = async (request: FastifyRequest, reply: FastifyReply) => {
    const raw = typeof request.headers["lock-token"] === "string" ? request.headers["lock-token"] : "";
    locks.delete(raw.replace(/^<|>$/g, ""));
    return reply.code(204).send();
  };

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  // `cors: false` is @fastify/cors's per-route opt-out. Without it the CORS
  // plugin answers EVERY OPTIONS request itself (400 "Invalid Preflight
  // Request" for anything that isn't a browser preflight) before our handler
  // runs — and OPTIONS is the very first thing Windows sends when mapping a
  // drive, so the mount would fail with "System error 67" no matter how
  // correct the rest of this file is. WebDAV clients aren't browsers; CORS
  // has no business here, and the /api routes are unaffected.
  const routeConfig = { cors: false };

  // Windows probes the server root as well as the mapped path.
  app.route({ method: "OPTIONS", url: "/", config: routeConfig, handler: options });

  app.register(
    async (dav) => {
      // The default parsers would reject or mangle DAV traffic: JSON bodies
      // (a .json file being PUT) would be parsed and size-limited, and
      // unknown content types (application/xml, octet-stream) would be 415'd.
      // Take the raw stream instead, scoped to this plugin so /api's
      // multipart + JSON handling is untouched.
      dav.removeAllContentTypeParsers();
      dav.addContentTypeParser("*", (_request, payload, done) => done(null, payload));

      const on = (method: HTTPMethods, handler: (req: FastifyRequest, rep: FastifyReply) => Promise<unknown>) => {
        for (const url of ["/", "/*"]) {
          dav.route({
            method,
            url,
            config: routeConfig,
            // Fastify would otherwise auto-derive a HEAD route from GET, which
            // would run the streaming handler; the explicit HEAD below only
            // reads metadata.
            ...(method === "GET" ? { exposeHeadRoute: false } : {}),
            handler,
          });
        }
      };

      on("OPTIONS", options);
      on("PROPFIND", propfind);
      on("PROPPATCH", proppatch);
      on("GET", get(false));
      on("HEAD", get(true));
      on("PUT", put);
      on("DELETE", del);
      on("MKCOL", mkcol);
      on("MOVE", move);
      on("COPY", copy);
      on("LOCK", lock);
      on("UNLOCK", unlock);
    },
    { prefix: PREFIX },
  );
}
