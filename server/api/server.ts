import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import sensible from "@fastify/sensible";
import fastifyStatic from "@fastify/static";
import cron from "node-cron";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, BLOCK_CACHE_DIR } from "../db/client.js";
import { SettingsRepository, ProviderAccountRepository, ProviderAppConfigRepository } from "../db/repository.js";
import { AccountRegistry } from "../core/account-registry.js";
import { BlockCache } from "../core/block-cache.js";
import { PriorityManager } from "../core/priority-manager.js";
import { CredentialVault } from "../security/credential-vault.js";
import { buildAdapter } from "../providers/adapter-factory.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerStatsRoutes } from "./routes/stats.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerDavRoutes } from "./routes/dav.js";

export interface BuildAppOptions {
  /** Allow the app to bind beyond localhost. Defaults to false (spec section 9). */
  allowExternalNetwork?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: true });

  await app.register(sensible);
  await app.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024 * 1024 }, // 50GB ceiling; real limit is total free space
  });
  await app.register(cors, {
    origin: options.allowExternalNetwork
      ? true
      : ["http://localhost:5173", ...(process.env.OMNIDISK_PUBLIC_URL ? [process.env.OMNIDISK_PUBLIC_URL] : [])],
  });

  const db = getDb();
  const settings = new SettingsRepository(db).get();

  const registry = new AccountRegistry();
  const accountRepo = new ProviderAccountRepository(db);
  const appConfigRepo = new ProviderAppConfigRepository(db);

  // Persists every probe's fresh stats back to the DB row, so the dashboard
  // (which reads accountRepo.list(), not live adapters) reflects real
  // numbers instead of staying at whatever was there when the account was
  // first added (previously nothing wired this callback at all, so a
  // connected+probed account could still show "0 B / unknown" forever).
  const priorityManager = new PriorityManager(
    registry.all(),
    settings.prioritySortMode,
    async (account, stats) => {
      const existing = accountRepo.get(account.identity.providerName, account.identity.accountIndex);
      if (!existing) return;
      accountRepo.upsert({
        ...existing,
        totalSpace: stats.totalSpace,
        usedSpace: stats.usedSpace,
        avgLatencyMs: stats.avgLatencyMs,
        avgSpeedBps: stats.avgSpeedBps,
        priorityScore: stats.priorityScore,
        lastProbedAt: stats.lastProbedAt,
      });
      app.log.info(
        {
          account: `${account.identity.providerName}:${account.identity.accountIndex}`,
          totalBytes: stats.totalSpace,
          usedBytes: stats.usedSpace,
          freeBytes: stats.freeSpace,
        },
        "Provider space refreshed",
      );
    },
    // A failed probe used to vanish (or abort the whole refresh). Say which
    // account and which probe failed, with the provider's own message.
    (account, phase, err) => {
      app.log.warn(
        {
          err,
          account: `${account.identity.providerName}:${account.identity.accountIndex}`,
          phase,
        },
        `Provider ${phase} probe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    },
  );

  // Reconnect every saved account that has a concrete adapter (Phase 1+;
  // see providers/adapter-factory.ts). Accounts for providers without an
  // adapter yet, or with an incomplete/pending credential, are silently
  // skipped and stay "not connected" — same behavior as today, just now
  // some accounts actually come back online across restarts.
  const vault = new CredentialVault();
  for (const record of accountRepo.list()) {
    try {
      const adapter = await buildAdapter(record, vault, appConfigRepo);
      if (adapter) registry.register(adapter);
    } catch (err) {
      app.log.warn(
        { err, providerName: record.providerName, accountIndex: record.accountIndex },
        "Failed to reconnect saved provider account on startup",
      );
    }
  }
  priorityManager.setAccounts(registry.all());
  // Populate real total/used/free space immediately on boot rather than
  // waiting up to 30 minutes for the next scheduled refresh (below) or for
  // an upload to trigger the staleness check.
  await priorityManager.refreshAll().catch((err) => {
    app.log.warn({ err }, "Initial priority refresh failed");
  });

  // One block cache for every front door. It keeps an in-memory index of its
  // directory, so the REST file routes and the WebDAV mount must share this
  // instance rather than each building their own.
  const blockCache = new BlockCache({ dir: BLOCK_CACHE_DIR });

  registerProviderRoutes(app, { registry, priorityManager });
  registerFileRoutes(app, { registry, priorityManager, blockCache });
  // WebDAV mount endpoint (`net use O: http://localhost:4310/dav`) — Virtual Drive Spec §3.1.
  registerDavRoutes(app, { registry, priorityManager, blockCache });
  registerStatsRoutes(app);
  registerSettingsRoutes(app, { registry, priorityManager });

  // Periodic priority refresh, per spec section 7: default every 30 min.
  cron.schedule("*/30 * * * *", async () => {
    priorityManager.setAccounts(registry.all());
    try {
      await priorityManager.refreshAll();
    } catch (err) {
      app.log.error({ err }, "Scheduled priority refresh failed");
    }
  });

  // Single-port deployment mode (Colab, or any host where running a
  // separate Vite dev server + tunnel per port isn't practical): if the
  // web app has been built (`npm run build` in web/), serve its static
  // output directly from this same server instead of requiring a second
  // process. Local dev (Vite's own dev server on :5173, proxying /api here)
  // is completely unaffected — this only activates when web/dist exists.
  const webDistDir = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (existsSync(join(webDistDir, "index.html"))) {
    await app.register(fastifyStatic, { root: webDistDir });
    app.setNotFoundHandler((request, reply) => {
      // Real API 404s should stay JSON 404s, not fall back to index.html.
      // Same for anything under /dav and for any non-GET/HEAD request: the
      // SPA shell is only a valid answer to a browser navigating to a page,
      // and returning HTML with a 200 to e.g. a stray PROPFIND makes a
      // WebDAV client believe it found something.
      const url = request.raw.url ?? "";
      const isPageNavigation = request.method === "GET" || request.method === "HEAD";
      if (url.startsWith("/api/") || url === "/dav" || url.startsWith("/dav/") || !isPageNavigation) {
        return reply.code(404).send({ error: "Not found" });
      }
      // Anything else is a client-side route (react-router) — serve the
      // SPA shell and let the browser's router take it from there.
      return reply.sendFile("index.html");
    });
    app.log.info(`Serving built web app from ${webDistDir}`);
  }

  return { app, registry, priorityManager };
}
