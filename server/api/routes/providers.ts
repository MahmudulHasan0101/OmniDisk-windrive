import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb } from "../../db/client.js";
import { ProviderAccountRepository, ProviderAppConfigRepository } from "../../db/repository.js";
import { PROVIDER_REGISTRY, getProviderDefinition } from "../../core/provider-registry.js";
import { CredentialVault } from "../../security/credential-vault.js";
import type { ProviderFieldDef } from "../../core/models.js";
import type { AccountRegistry } from "../../core/account-registry.js";
import type { PriorityManager } from "../../core/priority-manager.js";
import { buildAdapter } from "../../providers/adapter-factory.js";
import { GoogleDriveAccount } from "../../providers/google-drive-account.js";

// The dashboard SPA's origin (see web/vite.config.ts) — the OAuth callback
// below redirects the browser back here once the exchange is done, since
// Google redirects to this API server directly, not into the SPA. In
// single-port deployments (see server.ts's static-serving mode, used by
// the Colab script) the SPA and API share one origin, so OMNIDISK_PUBLIC_URL
// covers both — set it once and both this and GoogleDriveAccount's
// REDIRECT_URI pick it up.
const WEB_ORIGIN = process.env.OMNIDISK_PUBLIC_URL ?? "http://localhost:5173";

// In-memory CSRF state for the Google Drive OAuth handoff: maps the random
// `state` value handed to Google back to which pending account row it's
// for. Local single-process server, so a Map is sufficient — no need for
// this to survive a restart, since an in-flight consent flow wouldn't
// either. Entries are one-shot (deleted on use) and swept on age so a
// never-completed flow doesn't accumulate.
const pendingOAuthStates = new Map<string, { accountIndex: number; createdAt: number }>();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes to complete consent

const fieldPayloadSchema = z.record(z.union([z.string(), z.number(), z.boolean()]));

const patchAccountSchema = z.object({
  label: z.string().optional(),
  enabled: z.boolean().optional(),
  manualPriorityRank: z.number().int().optional(),
});

const refreshPrioritySchema = z.object({
  mode: z.enum(["speed", "latency", "free_space", "manual"]).optional(),
});

/** Server-side defense in depth — the UI already enforces this from the same field defs. */
function findMissingRequiredFields(
  defs: ProviderFieldDef[],
  payload: Record<string, unknown>,
): string[] {
  return defs
    .filter((f) => f.required)
    .filter((f) => payload[f.key] === undefined || payload[f.key] === "")
    .map((f) => f.key);
}

/**
 * Fills in each field's registry-defined default for anything the caller
 * left out or sent empty. Belt-and-suspenders alongside the frontend's own
 * pre-fill (AddProviderModal) — protects a direct API call, and a field
 * like OneDrive's Tenant ID (default "common") from ever silently ending
 * up unset just because nobody happened to touch that input.
 */
function applyFieldDefaults(
  defs: ProviderFieldDef[],
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const withDefaults = { ...payload };
  for (const field of defs) {
    if (field.default !== undefined && (withDefaults[field.key] === undefined || withDefaults[field.key] === "")) {
      withDefaults[field.key] = field.default;
    }
  }
  return withDefaults;
}

/** Any `*CapGB` field in the submitted payload becomes the account's configuredCapBytes. */
function extractConfiguredCapBytes(payload: Record<string, unknown>): number | undefined {
  const capKey = Object.keys(payload).find((k) => k.endsWith("CapGB"));
  if (!capKey) return undefined;
  const gb = Number(payload[capKey]);
  return Number.isFinite(gb) ? gb * 1024 ** 3 : undefined;
}

export function registerProviderRoutes(
  app: FastifyInstance,
  deps: { registry: AccountRegistry; priorityManager: PriorityManager },
): void {
  const accountRepo = new ProviderAccountRepository(getDb());
  const appConfigRepo = new ProviderAppConfigRepository(getDb());
  const vault = new CredentialVault();

  // GET /providers/catalog — the 15 provider type definitions, powers "Add a provider"
  app.get("/api/providers/catalog", async () => {
    return PROVIDER_REGISTRY;
  });

  // GET /providers/catalog/:providerName/app-config — has this OAuth provider's
  // app-level credential already been saved? Lets the UI skip straight to
  // "Connect" for a 2nd+ account of the same provider type.
  app.get<{ Params: { providerName: string } }>(
    "/api/providers/catalog/:providerName/app-config",
    async (request, reply) => {
      const def = getProviderDefinition(request.params.providerName);
      if (!def) return reply.code(404).send({ error: "Unknown provider type" });
      return { configured: appConfigRepo.exists(def.providerName) };
    },
  );

  // POST /providers/catalog/:providerName/app-config — save app-level fields
  // (client_id/client_secret/...) once per provider type. OAuth providers only.
  app.post<{ Params: { providerName: string } }>(
    "/api/providers/catalog/:providerName/app-config",
    async (request, reply) => {
      const def = getProviderDefinition(request.params.providerName);
      if (!def) return reply.code(404).send({ error: "Unknown provider type" });
      if (def.appLevelFields.length === 0) {
        return reply.code(400).send({
          error: `${def.displayName} has no app-level configuration — connect an account directly.`,
        });
      }

      const payload = applyFieldDefaults(def.appLevelFields, fieldPayloadSchema.parse(request.body));
      const missing = findMissingRequiredFields(def.appLevelFields, payload);
      if (missing.length > 0) {
        return reply.code(422).send({ error: "Missing required fields", fields: missing });
      }

      const credentialRef = `${def.providerName}_app`;
      await vault.setCredential(credentialRef, JSON.stringify(payload));
      appConfigRepo.upsert(def.providerName, credentialRef);

      return reply.code(201).send({ saved: true });
    },
  );

  // GET /providers/accounts — every configured account instance + cached stats
  app.get("/api/providers/accounts", async () => {
    return accountRepo.list().map((account) => ({
      ...account,
      connected: deps.registry.tryResolve(account.providerName, account.accountIndex) !== null,
    }));
  });

  // POST /providers/:providerName/connect — OAuth providers: run the consent
  // flow against the saved app-config, create a new account instance on success.
  //
  // NOTE: no concrete provider adapters exist yet (Phase 1+, see README), so
  // there's no real browser/OAuth SDK to hand off to here. This creates the
  // account row and reserves its accountIndex/credentialRef exactly as the
  // real flow will, with a placeholder in place of a refresh token — wiring
  // in `open(consentUrl)` + a local callback listener per provider adapter
  // is the only change needed once that adapter exists.
  app.post<{ Params: { providerName: string } }>(
    "/api/providers/:providerName/connect",
    async (request, reply) => {
      const def = getProviderDefinition(request.params.providerName);
      if (!def) return reply.code(404).send({ error: "Unknown provider type" });
      if (!def.requiresOAuthConnect) {
        return reply.code(400).send({
          error: `${def.displayName} doesn't use OAuth — use POST /api/providers/${def.providerName}/accounts instead.`,
        });
      }
      if (!appConfigRepo.exists(def.providerName)) {
        return reply.code(409).send({
          error: `Save ${def.displayName}'s app-level credentials first (POST /api/providers/catalog/${def.providerName}/app-config).`,
        });
      }

      const payload = applyFieldDefaults(def.accountLevelFields, fieldPayloadSchema.parse(request.body ?? {}));
      const missing = findMissingRequiredFields(def.accountLevelFields, payload);
      if (missing.length > 0) {
        return reply.code(422).send({ error: "Missing required fields", fields: missing });
      }

      const existing = accountRepo.list().filter((a) => a.providerName === def.providerName);
      const accountIndex = existing.length;
      const credentialRef = `${def.providerName}_${accountIndex}_refresh_token`;

      // google_drive now has a concrete adapter: return the real consent
      // URL instead of writing a placeholder, so the caller (AddProviderModal)
      // can open it in a browser. The account row + credential slot are
      // reserved here exactly as before; the refresh token lands via
      // POST /api/providers/google_drive/oauth-callback once consent completes.
      if (def.providerName === "google_drive") {
        const rawAppCredential = await vault.getCredential(appConfigRepo.get(def.providerName)!.credentialRef);
        const googleApp = JSON.parse(rawAppCredential!) as { clientId: string; clientSecret: string };
        await vault.setCredential(credentialRef, JSON.stringify({ status: "pending_oauth_connect" }));
        accountRepo.upsert({
          providerName: def.providerName,
          accountIndex,
          label: typeof payload.label === "string" ? payload.label : undefined,
          authType: def.authType,
          credentialRef,
          avgLatencyMs: 0,
          avgSpeedBps: 0,
          priorityScore: 0,
          enabled: !def.isBilledProvider,
          isLiveQuota: def.liveQuotaSupported,
          isBilledProvider: def.isBilledProvider,
          maxSingleObjectBytes: def.maxSingleObjectBytes,
        });

        // Sweep stale entries so a browser tab someone never finished
        // doesn't leak forever, then mint a fresh CSRF state for this one.
        const now = Date.now();
        for (const [key, entry] of pendingOAuthStates) {
          if (now - entry.createdAt > OAUTH_STATE_TTL_MS) pendingOAuthStates.delete(key);
        }
        const state = randomBytes(24).toString("hex");
        pendingOAuthStates.set(state, { accountIndex, createdAt: now });

        reply.code(201);
        return {
          providerName: def.providerName,
          accountIndex,
          label: payload.label,
          consentUrl: GoogleDriveAccount.buildConsentUrl(googleApp, state),
        };
      }

      // Placeholder for the real OAuth callback's refresh token, for any
      // OAuth provider that still has no concrete adapter (Phase 2+).
      await vault.setCredential(credentialRef, JSON.stringify({ status: "pending_oauth_connect" }));

      accountRepo.upsert({
        providerName: def.providerName,
        accountIndex,
        label: typeof payload.label === "string" ? payload.label : undefined,
        authType: def.authType,
        credentialRef,
        avgLatencyMs: 0,
        avgSpeedBps: 0,
        priorityScore: 0,
        enabled: !def.isBilledProvider,
        isLiveQuota: def.liveQuotaSupported,
        isBilledProvider: def.isBilledProvider,
        maxSingleObjectBytes: def.maxSingleObjectBytes,
      });

      reply.code(201);
      return { providerName: def.providerName, accountIndex, label: payload.label };
    },
  );

  // GET /providers/google_drive/oauth-callback — this is REDIRECT_URI:
  // Google's consent screen sends the browser here directly (not the SPA),
  // with `code`+`state` on success or `error` if the user declined. This
  // exchanges the code for a refresh token, registers a live adapter, then
  // redirects the browser on to the dashboard so the user ends up back in
  // the app instead of looking at a bare JSON response.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/api/providers/google_drive/oauth-callback",
    async (request, reply) => {
      const { code, state, error } = request.query;

      if (error) {
        return reply.redirect(
          `${WEB_ORIGIN}/?googleDriveError=${encodeURIComponent(
            error === "access_denied" ? "You declined the Google Drive permission request." : error,
          )}`,
        );
      }
      if (!code || !state) {
        return reply.redirect(`${WEB_ORIGIN}/?googleDriveError=${encodeURIComponent("Malformed callback from Google.")}`);
      }

      const pending = pendingOAuthStates.get(state);
      pendingOAuthStates.delete(state); // one-shot regardless of outcome
      if (!pending || Date.now() - pending.createdAt > OAUTH_STATE_TTL_MS) {
        return reply.redirect(
          `${WEB_ORIGIN}/?googleDriveError=${encodeURIComponent(
            "This connection link expired or was already used — try adding the account again.",
          )}`,
        );
      }

      const record = accountRepo.get("google_drive", pending.accountIndex);
      if (!record) {
        return reply.redirect(`${WEB_ORIGIN}/?googleDriveError=${encodeURIComponent("Account record not found.")}`);
      }

      try {
        const appConfig = appConfigRepo.get("google_drive");
        if (!appConfig) throw new Error("Google Drive app config missing");
        const rawAppCredential = await vault.getCredential(appConfig.credentialRef);
        const googleApp = JSON.parse(rawAppCredential!) as { clientId: string; clientSecret: string };

        const { refreshToken } = await GoogleDriveAccount.exchangeCodeForTokens(googleApp, code);
        await vault.setCredential(record.credentialRef, JSON.stringify({ refreshToken }));

        const adapter = await buildAdapter(record, vault, appConfigRepo);
        if (adapter) {
          deps.registry.register(adapter);
          deps.priorityManager.setAccounts(deps.registry.all());
          await deps.priorityManager.refreshAll().catch((err) => {
            app.log.warn({ err }, "Initial stats probe failed for newly connected account");
          });
        }

        return reply.redirect(`${WEB_ORIGIN}/?googleDriveConnected=1`);
      } catch (err) {
        app.log.error({ err }, "Google Drive OAuth callback failed");
        return reply.redirect(
          `${WEB_ORIGIN}/?googleDriveError=${encodeURIComponent(
            err instanceof Error ? err.message : "Failed to complete Google Drive connection.",
          )}`,
        );
      }
    },
  );

  // POST /providers/:providerName/accounts — API-key/basic providers: take the
  // filled accountLevelFields directly and register the new account instance.
  app.post<{ Params: { providerName: string } }>(
    "/api/providers/:providerName/accounts",
    async (request, reply) => {
      const def = getProviderDefinition(request.params.providerName);
      if (!def) return reply.code(404).send({ error: "Unknown provider type" });
      if (def.requiresOAuthConnect) {
        return reply.code(400).send({
          error: `${def.displayName} uses OAuth — use POST /api/providers/${def.providerName}/connect instead.`,
        });
      }

      const payload = applyFieldDefaults(def.accountLevelFields, fieldPayloadSchema.parse(request.body));
      const missing = findMissingRequiredFields(def.accountLevelFields, payload);
      if (missing.length > 0) {
        return reply.code(422).send({ error: "Missing required fields", fields: missing });
      }

      const existing = accountRepo.list().filter((a) => a.providerName === def.providerName);
      const accountIndex = existing.length;
      const credentialRef = `${def.providerName}_${accountIndex}`;

      await vault.setCredential(credentialRef, JSON.stringify(payload));

      const record = {
        providerName: def.providerName,
        accountIndex,
        label: typeof payload.label === "string" ? payload.label : undefined,
        authType: def.authType,
        credentialRef,
        avgLatencyMs: 0,
        avgSpeedBps: 0,
        priorityScore: 0,
        enabled: !def.isBilledProvider, // billed-provider guardrail: opt-in only
        isLiveQuota: def.liveQuotaSupported,
        isBilledProvider: def.isBilledProvider,
        maxSingleObjectBytes: def.maxSingleObjectBytes,
        configuredCapBytes: extractConfiguredCapBytes(payload),
      };
      accountRepo.upsert(record);

      // Where a concrete adapter exists (MEGA today — see adapter-factory.ts),
      // register it immediately instead of leaving the account "saved but
      // not connected" until the next server restart. Credentials aren't
      // validated with a live call here (that still requires the caller to
      // trigger an actual probe/upload) — a bad password surfaces on first
      // real use, same as the OAuth path's unvalidated refresh token.
      try {
        const adapter = await buildAdapter(record, vault, appConfigRepo);
        if (adapter) {
          deps.registry.register(adapter);
          deps.priorityManager.setAccounts(deps.registry.all());
          await deps.priorityManager.refreshAll().catch((err) => {
            app.log.warn({ err }, "Initial stats probe failed for newly added account");
          });
        }
      } catch (err) {
        app.log.warn({ err, providerName: def.providerName, accountIndex }, "Adapter construction failed");
      }

      reply.code(201);
      return { providerName: def.providerName, accountIndex, label: payload.label };
    },
  );

  // PATCH /providers/accounts/:providerName/:accountIndex
  app.patch<{ Params: { providerName: string; accountIndex: string } }>(
    "/api/providers/accounts/:providerName/:accountIndex",
    async (request, reply) => {
      const { providerName } = request.params;
      const accountIndex = Number(request.params.accountIndex);
      const patch = patchAccountSchema.parse(request.body);

      const existing = accountRepo.get(providerName, accountIndex);
      if (!existing) return reply.code(404).send({ error: "Account not found" });

      const updated = { ...existing, ...patch };
      accountRepo.upsert(updated);

      const liveAccount = deps.registry.tryResolve(providerName, accountIndex);
      if (liveAccount) {
        if (patch.enabled !== undefined) liveAccount.enabled = patch.enabled;
        if (patch.manualPriorityRank !== undefined) {
          liveAccount.manualPriorityRank = patch.manualPriorityRank;
        }
      }

      return { ...updated, connected: liveAccount !== null };
    },
  );

  // DELETE /providers/accounts/:providerName/:accountIndex
  app.delete<{ Params: { providerName: string; accountIndex: string } }>(
    "/api/providers/accounts/:providerName/:accountIndex",
    async (request, reply) => {
      const { providerName } = request.params;
      const accountIndex = Number(request.params.accountIndex);

      if (accountRepo.hasBlocks(providerName, accountIndex)) {
        return reply.code(409).send({
          error:
            "Account still has blocks referencing it. Force-delete with " +
            "block reassignment isn't available yet — free the account " +
            "by deleting or migrating the affected files first.",
        });
      }

      const record = accountRepo.get(providerName, accountIndex);
      accountRepo.delete(providerName, accountIndex);
      deps.registry.unregister(providerName, accountIndex);
      if (record) await vault.deleteCredential(record.credentialRef).catch(() => {});

      return reply.code(204).send();
    },
  );

  // POST /providers/refresh-priority
  app.post("/api/providers/refresh-priority", async (request) => {
    const body = refreshPrioritySchema.parse(request.body ?? {});
    if (body.mode) deps.priorityManager.setMode(body.mode);

    deps.priorityManager.setAccounts(deps.registry.all());
    await deps.priorityManager.refreshAll();

    return accountRepo.list().map((account) => ({
      ...account,
      connected: deps.registry.tryResolve(account.providerName, account.accountIndex) !== null,
    }));
  });
}
