import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb } from "../../db/client.js";
import { SettingsRepository, ProviderAccountRepository, ProviderAppConfigRepository } from "../../db/repository.js";
import { CredentialVault } from "../../security/credential-vault.js";
import type { AccountRegistry } from "../../core/account-registry.js";
import type { PriorityManager } from "../../core/priority-manager.js";

const patchSettingsSchema = z.object({
  defaultCompression: z.enum(["none", "zstd", "gzip", "brotli"]).optional(),
  prioritySortMode: z.enum(["speed", "latency", "free_space", "manual"]).optional(),
  // Bounded to 1MB-64MB: below 1MB per-request overhead on cloud providers
  // dominates; above 64MB a small random read wastes most of what it fetches,
  // and some providers' per-object caps come into play.
  defaultLogicalBlockSize: z
    .number()
    .int()
    .min(1024 * 1024)
    .max(64 * 1024 * 1024)
    .optional(),
  smallFileThresholdBytes: z.number().int().min(0).optional(),
  retryMaxAttempts: z.number().int().min(0).optional(),
});

export function registerSettingsRoutes(
  app: FastifyInstance,
  deps: { registry: AccountRegistry; priorityManager: PriorityManager },
): void {
  const repo = new SettingsRepository(getDb());

  // GET /settings — current config.json-equivalent contents
  app.get("/api/settings", async () => {
    return repo.get();
  });

  // PATCH /settings — update global settings
  app.patch("/api/settings", async (request) => {
    const patch = patchSettingsSchema.parse(request.body);
    return repo.update(patch);
  });

  // GET /settings/vault-status — powers the Settings page credential vault
  // status line (spec section 11.3). Not in the base REST table in section
  // 10, added here because the UI spec explicitly requires it.
  app.get("/api/settings/vault-status", async () => {
    const vault = new CredentialVault();
    const backend = await vault.getBackend();
    return { backend };
  });

  // DELETE /settings/reset-all — factory reset. Wipes OmniDisk's own local
  // state: every file/fragment record, every connected provider account
  // and its stored credential, every OAuth app config, and settings back
  // to defaults. Deliberately does NOT touch anything already stored on
  // your connected providers (MEGA/Drive/Supabase/etc) — those files stay
  // exactly where they are; this only forgets that OmniDisk ever put them
  // there. The frontend confirms this distinction to the user before
  // calling it (see Settings.tsx) — this route trusts the caller and does
  // not ask for confirmation itself.
  app.delete("/api/settings/reset-all", async () => {
    const db = getDb();
    const vault = new CredentialVault();
    const accountRepo = new ProviderAccountRepository(db);
    const appConfigRepo = new ProviderAppConfigRepository(db);

    // Gather every credential reference before the rows that name them are
    // deleted — needed so keychain-backed entries (which live outside this
    // database entirely) get cleaned up too, not just the DB rows.
    const credentialRefs = [
      ...accountRepo.list().map((a) => a.credentialRef),
      ...appConfigRepo.list().map((c) => c.credentialRef),
    ];
    await Promise.all(credentialRefs.map((ref) => vault.deleteCredential(ref)));

    db.exec(`
      DELETE FROM files;
      DELETE FROM folders;
      DELETE FROM block_content_index;
      DELETE FROM file_fragments;
      DELETE FROM provider_accounts;
      DELETE FROM provider_app_configs;
      DELETE FROM settings;
    `);
    // file_blocks cascades from files via its ON DELETE CASCADE foreign key.
    // file_fragments (the pre-block legacy table) has no such cascade, so it
    // is cleared explicitly — otherwise a reset would leave orphaned rows
    // that make the migrator think there's still work to do.

    deps.registry.clear();
    deps.priorityManager.setAccounts([]);

    return { reset: true };
  });
}
