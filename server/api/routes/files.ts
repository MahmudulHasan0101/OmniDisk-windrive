import type { FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { z } from "zod";
import { getDb, TMP_UPLOADS_DIR, BLOCK_CACHE_DIR } from "../../db/client.js";
import {
  FileRepository,
  FolderRepository,
  ProviderAccountRepository,
  SettingsRepository,
} from "../../db/repository.js";
import {
  retryFailedBlocks,
  retrieveBlocksInOrder,
  readRange,
  verifyIntegrity,
} from "../../core/block-router.js";
import { ingestStagedFile, purgeFile } from "../../core/ingest.js";
import { BlockCache } from "../../core/block-cache.js";
import { resolveForFile } from "../../core/hydration-policy.js";
import type { CompressionAlgo, OmniFile } from "../../core/models.js";
import type { AccountRegistry } from "../../core/account-registry.js";
import type { PriorityManager } from "../../core/priority-manager.js";
import { progressBus } from "../progress-bus.js";

const compressionOverrideSchema = z.enum(["none", "zstd", "gzip", "brotli"]).optional();

const rangeQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  length: z.coerce.number().int().min(0).optional(),
});

export function registerFileRoutes(
  app: FastifyInstance,
  deps: {
    registry: AccountRegistry;
    priorityManager: PriorityManager;
    /**
     * BlockCache keeps an in-memory index of its directory, so two instances
     * pointed at the same folder would drift apart (double-counted bytes,
     * missed evictions). buildApp creates ONE and shares it with the WebDAV
     * routes; the fallback only exists for callers that register these
     * routes standalone.
     */
    blockCache?: BlockCache;
  },
): void {
  const db = getDb();
  const fileRepo = new FileRepository(db);
  const folderRepo = new FolderRepository(db);
  const providerRepo = new ProviderAccountRepository(db);
  const settingsRepo = new SettingsRepository(db);
  const blockCache = deps.blockCache ?? new BlockCache({ dir: BLOCK_CACHE_DIR });

  const resolveAccount = (providerName: string, accountIndex: number) =>
    deps.registry.resolve(providerName, accountIndex);

  // GET /files — list all files with progress/status (blocks omitted)
  app.get<{
    Querystring: { status?: OmniFile["status"]; folderId?: string; root?: string };
  }>("/api/files", async (request) => {
    const { status, folderId, root } = request.query;
    // `root=1` means "top level only"; absent folderId means "everything".
    const parent = root === "1" ? null : folderId;
    return fileRepo.listFiles(status, parent);
  });

  // GET /files/:fileUuid — file detail incl. full block map
  app.get<{ Params: { fileUuid: string } }>(
    "/api/files/:fileUuid",
    async (request, reply) => {
      const file = fileRepo.getFile(request.params.fileUuid);
      if (!file) return reply.code(404).send({ error: "File not found" });

      const settings = settingsRepo.get();
      return {
        ...file,
        // Surfaced so the UI can explain why a given file will or won't be
        // streamed once a drive is mounted, rather than it being invisible.
        hydration: resolveForFile(file, settings.smallFileThresholdBytes),
      };
    },
  );

  // GET /files/:fileUuid/progress — SSE stream of per-block status updates
  app.get<{ Params: { fileUuid: string } }>(
    "/api/files/:fileUuid/progress",
    async (request, reply) => {
      const { fileUuid } = request.params;

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const unsubscribe = progressBus.subscribe(fileUuid, (block) => {
        reply.raw.write(`data: ${JSON.stringify(block)}\n\n`);
      });

      request.raw.on("close", unsubscribe);
    },
  );

  // POST /files/upload — stage, split into blocks, compress per block, route
  app.post("/api/files/upload", async (request, reply) => {
    // Fail fast with a clear reason before touching the multipart body at
    // all: if nothing has a live connection, there's nowhere to route this
    // file regardless of its size. This is distinct from a genuine
    // insufficient-space case (checked later via planAllocation) — accounts
    // can exist in the database without ever having a live adapter
    // connected (see AccountRegistry), which deserves its own message
    // rather than looking like a capacity problem.
    const anyLiveEnabledAccount = deps.registry.all().some((a) => a.enabled);
    if (!anyLiveEnabledAccount) {
      return reply.code(409).send({
        error: "no_connected_accounts",
        message:
          "No provider accounts have a live connection right now. Accounts you've " +
          "added are recorded, but each one needs a working provider adapter " +
          "or to be enabled before files can be routed to it.",
      });
    }

    const multipartFile = await request.file();
    if (!multipartFile) {
      return reply.code(400).send({ error: "No file provided in multipart form" });
    }

    const compressionOverride = compressionOverrideSchema.parse(
      (multipartFile.fields.compression as { value?: string } | undefined)?.value,
    );
    const folderIdField = (
      multipartFile.fields.folderId as { value?: string } | undefined
    )?.value;
    const parentFolderId = folderIdField || undefined;

    const fileUuid = randomUUID();
    const originalStagePath = join(TMP_UPLOADS_DIR, `${fileUuid}.original`);

    // Step 1-2: stream to disk while hashing the original bytes.
    const hash = createHash("sha256");
    multipartFile.file.on("data", (chunk: Buffer) => hash.update(chunk));
    await pipeline(multipartFile.file, createWriteStream(originalStagePath));
    const sha256Original = hash.digest("hex");

    // Steps 3+: split, compress, allocate, store — shared with WebDAV PUT.
    const result = await ingestStagedFile(
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
        stagedOriginalPath: originalStagePath,
        fileName: multipartFile.filename,
        parentFolderId,
        sha256Original,
        compression: compressionOverride,
      },
    );

    if (!result.ok) return reply.code(422).send(result.body);
    return result.file;
  });

  // POST /files/:fileUuid/retry — retry only the failed blocks
  app.post<{ Params: { fileUuid: string } }>(
    "/api/files/:fileUuid/retry",
    async (request, reply) => {
      const { fileUuid } = request.params;
      const file = fileRepo.getFile(fileUuid);
      if (!file) return reply.code(404).send({ error: "File not found" });

      const stagedPath = join(TMP_UPLOADS_DIR, `${fileUuid}.staged`);
      let staged: Buffer;
      try {
        staged = await readFile(stagedPath);
      } catch {
        return reply.code(409).send({
          error:
            "Staged data for this upload is no longer available (the file " +
            "already completed and its temp stage was cleared). Re-upload instead.",
        });
      }

      // Offsets into the staged buffer are cumulative STORED size, which is
      // not the same as logicalStart — blocks compress to different sizes.
      const offsets = new Map<number, { start: number; end: number }>();
      let cursor = 0;
      for (const block of [...file.blocks].sort((a, b) => a.blockIndex - b.blockIndex)) {
        offsets.set(block.blockIndex, {
          start: cursor,
          end: cursor + block.storedSize,
        });
        cursor += block.storedSize;
      }

      const settings = settingsRepo.get();
      const result = await retryFailedBlocks(
        file.blocks,
        resolveAccount,
        async (blockIndex) => {
          const range = offsets.get(blockIndex)!;
          return staged.subarray(range.start, range.end);
        },
        {
          retryMaxAttempts: settings.retryMaxAttempts,
          onBlockUpdate: (block) => {
            fileRepo.upsertBlock(block);
            progressBus.publish({ fileUuid, block });
          },
        },
      );

      const merged = file.blocks.map(
        (b) => result.blocks.find((r) => r.blockId === b.blockId) ?? b,
      );
      const allStored = merged.every((b) => b.status === "stored");
      const storedSize = merged
        .filter((b) => b.status === "stored")
        .reduce((sum, b) => sum + b.logicalLength, 0);

      fileRepo.upsertFile({
        ...file,
        successfullyStoredSize: storedSize,
        status: allStored ? "complete" : "partial",
      });
      if (allStored) await rm(stagedPath, { force: true });

      deps.priorityManager.setAccounts(deps.registry.all());
      await deps.priorityManager.refreshAll().catch((err) => {
        app.log.warn({ err, fileUuid }, "Post-retry stats refresh failed");
      });

      return fileRepo.getFile(fileUuid);
    },
  );

  /**
   * GET /files/:fileUuid/range?offset=&length= — arbitrary byte range.
   *
   * This is the HTTP surface of the block model's whole reason for existing:
   * a 64KB read at offset 9.4GB fetches exactly one block, where the old
   * whole-stream design would have had to download and decompress the entire
   * file to reach that offset.
   *
   * Also honours the HTTP `Range:` header, so a browser <video> can stream a
   * stored file straight from here — the quickest way to prove the
   * random-access path works before any mount layer exists.
   */
  app.get<{
    Params: { fileUuid: string };
    Querystring: { offset?: string; length?: string };
  }>("/api/files/:fileUuid/range", async (request, reply) => {
    const file = fileRepo.getFile(request.params.fileUuid);
    if (!file) return reply.code(404).send({ error: "File not found" });

    let offset: number;
    let length: number;
    let isHttpRange = false;

    const rangeHeader = request.headers.range;
    const parsed =
      typeof rangeHeader === "string" ? rangeHeader.match(/^bytes=(\d*)-(\d*)$/) : null;
    if (parsed) {
      isHttpRange = true;
      const startRaw = parsed[1];
      const endRaw = parsed[2];
      if (startRaw) {
        offset = Number(startRaw);
        length = endRaw ? Number(endRaw) - offset + 1 : file.fileSize - offset;
      } else {
        // Suffix form "bytes=-500": the last N bytes.
        const suffix = Number(endRaw || 0);
        offset = Math.max(0, file.fileSize - suffix);
        length = file.fileSize - offset;
      }
    } else {
      const q = rangeQuerySchema.parse(request.query);
      offset = q.offset;
      // Default to 1MB rather than the whole file: this endpoint exists for
      // ranged reads, and an unbounded default would quietly turn it into a
      // full download.
      length = q.length ?? Math.min(file.fileSize - q.offset, 1024 * 1024);
    }

    if (file.fileSize > 0 && offset >= file.fileSize) {
      return reply
        .code(416)
        .header("Content-Range", `bytes */${file.fileSize}`)
        .send({ error: "Range not satisfiable" });
    }

    // Load only the blocks this range needs. Pulling all 5,000 block rows of a
    // 20GB file to serve a 64KB read would defeat the point of addressing.
    const startBlock = Math.floor(offset / file.logicalBlockSize);
    const lastByte = Math.max(offset, Math.min(offset + length, file.fileSize) - 1);
    const endBlock = Math.floor(lastByte / file.logicalBlockSize);
    const blocks = fileRepo.getBlockRange(file.fileUuid, startBlock, endBlock);

    let data: Buffer;
    try {
      data = await readRange(
        blocks,
        file.logicalBlockSize,
        file.fileSize,
        offset,
        length,
        resolveAccount,
        {
          getCached: (block) => blockCache.get(block),
          putCached: (block, buf) => blockCache.put(block, buf),
        },
      );
    } catch (err) {
      return reply.code(502).send({
        error: "range_read_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    if (isHttpRange) {
      reply
        .code(206)
        .header(
          "Content-Range",
          `bytes ${offset}-${offset + Math.max(0, data.length - 1)}/${file.fileSize}`,
        );
    }
    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Type", "application/octet-stream");
    reply.header("Content-Length", String(data.length));
    return reply.send(data);
  });

  // GET /files/:fileUuid/download — reassemble and download
  app.get<{ Params: { fileUuid: string } }>(
    "/api/files/:fileUuid/download",
    async (request, reply) => {
      const { fileUuid } = request.params;
      const file = fileRepo.getFile(fileUuid);
      if (!file) return reply.code(404).send({ error: "File not found" });
      if (file.status !== "complete") {
        return reply.code(409).send({
          error: `File is not complete (status: ${file.status}); cannot reassemble.`,
        });
      }

      const chunks: Buffer[] = new Array(file.blocks.length);
      try {
        // Each block decompresses individually with its own algorithm, so
        // bytes are emitted as they arrive — the whole-stream design needed
        // the entire compressed file in hand before it could decompress.
        await retrieveBlocksInOrder(file.blocks, resolveAccount, (chunk, block) => {
          chunks[block.blockIndex] = chunk;
        });
      } catch (err) {
        return reply.code(502).send({
          error: "block_retrieval_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }

      const originalBuffer = Buffer.concat(chunks);

      if (file.sha256Original && !verifyIntegrity(originalBuffer, file.sha256Original)) {
        return reply.code(422).send({
          error: "integrity-failed",
          message: "Reassembled file does not match the recorded checksum.",
        });
      }

      reply.header("Content-Disposition", `attachment; filename="${file.fileName}"`);
      reply.header("Content-Type", "application/octet-stream");
      reply.header("Accept-Ranges", "bytes");
      return reply.send(originalBuffer);
    },
  );

  // PATCH /files/:fileUuid — rename, move, or set hydration policy.
  // All three are metadata-only and transfer zero bytes.
  app.patch<{
    Params: { fileUuid: string };
    Body: {
      fileName?: string;
      parentFolderId?: string | null;
      hydrationPolicy?: "stream" | "full" | "pinned" | null;
    };
  }>("/api/files/:fileUuid", async (request, reply) => {
    const file = fileRepo.getFile(request.params.fileUuid);
    if (!file) return reply.code(404).send({ error: "File not found" });

    const { fileName, parentFolderId, hydrationPolicy } = request.body ?? {};

    if (hydrationPolicy !== undefined) {
      fileRepo.setHydrationPolicy(file.fileUuid, hydrationPolicy);
    }
    if (fileName !== undefined || parentFolderId !== undefined) {
      fileRepo.upsertFile({
        ...file,
        fileName: fileName ?? file.fileName,
        parentFolderId:
          parentFolderId === undefined
            ? file.parentFolderId
            : (parentFolderId ?? undefined),
      });
    }

    return fileRepo.getFile(file.fileUuid);
  });

  // DELETE /files/:fileUuid — delete file + every block's remote object
  app.delete<{ Params: { fileUuid: string } }>(
    "/api/files/:fileUuid",
    async (request, reply) => {
      const { fileUuid } = request.params;
      const file = fileRepo.getFile(fileUuid);
      if (!file) return reply.code(404).send({ error: "File not found" });

      await purgeFile({ registry: deps.registry, fileRepo, blockCache }, file);
      return reply.code(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // Virtual folders — local metadata only, never written to any provider,
  // which is why creating/renaming/moving one is instant and free.
  // -------------------------------------------------------------------------

  app.get<{ Querystring: { parentId?: string; root?: string } }>(
    "/api/folders",
    async (request) => {
      const { parentId, root } = request.query;
      return folderRepo.listChildren(root === "1" ? null : parentId);
    },
  );

  app.post<{ Body: { folderName: string; parentFolderId?: string } }>(
    "/api/folders",
    async (request, reply) => {
      const { folderName, parentFolderId } = request.body ?? {};
      if (!folderName?.trim()) {
        return reply.code(400).send({ error: "folderName is required" });
      }
      if (parentFolderId && !folderRepo.get(parentFolderId)) {
        return reply.code(404).send({ error: "Parent folder not found" });
      }

      const folder = {
        folderId: randomUUID(),
        folderName: folderName.trim(),
        parentFolderId,
        createdAt: new Date().toISOString(),
      };
      folderRepo.create(folder);
      return reply.code(201).send(folder);
    },
  );

  app.patch<{
    Params: { folderId: string };
    Body: { folderName?: string; parentFolderId?: string | null };
  }>("/api/folders/:folderId", async (request, reply) => {
    const { folderId } = request.params;
    if (!folderRepo.get(folderId)) {
      return reply.code(404).send({ error: "Folder not found" });
    }
    // Reparenting a folder into its own subtree creates a cycle that makes
    // the tree unwalkable — and the mount layer walks it on every directory
    // listing, so this would hang Explorer rather than just look wrong.
    const target = request.body?.parentFolderId;
    if (target) {
      let cursor: string | undefined = target;
      while (cursor) {
        if (cursor === folderId) {
          return reply
            .code(409)
            .send({ error: "Cannot move a folder inside itself" });
        }
        cursor = folderRepo.get(cursor)?.parentFolderId;
      }
    }
    folderRepo.update(folderId, request.body ?? {});
    return folderRepo.get(folderId);
  });

  app.delete<{ Params: { folderId: string } }>(
    "/api/folders/:folderId",
    async (request, reply) => {
      const { folderId } = request.params;
      if (!folderRepo.get(folderId)) {
        return reply.code(404).send({ error: "Folder not found" });
      }
      if (folderRepo.hasContents(folderId)) {
        return reply.code(409).send({
          error: "folder_not_empty",
          message:
            "This folder still holds files or subfolders. Move or delete them first.",
        });
      }
      folderRepo.delete(folderId);
      return reply.code(204).send();
    },
  );

  // GET /cache — block cache status, for the Settings page
  app.get("/api/cache", async () => blockCache.stats());

  app.delete("/api/cache", async (_request, reply) => {
    await blockCache.clear();
    return reply.code(204).send();
  });
}
