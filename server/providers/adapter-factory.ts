import type { ProviderAccountRecord } from "../core/models.js";
import type { CredentialVault } from "../security/credential-vault.js";
import type { ProviderAppConfigRepository } from "../db/repository.js";
import { ProviderAccountBase } from "../core/provider-account-base.js";
import { MegaAccount } from "./mega-account.js";
import { GoogleDriveAccount } from "./google-drive-account.js";
import { SupabaseAccount } from "./supabase-account.js";

/**
 * Builds a live `ProviderAccountBase` for a saved DB row, or returns null
 * for providers that don't have a concrete adapter yet (Phase 2+). This is
 * the one place that needs to change as new adapters land — routes.ts and
 * index.ts just call this and register() whatever comes back.
 */
export async function buildAdapter(
  record: ProviderAccountRecord,
  vault: CredentialVault,
  appConfigRepo: ProviderAppConfigRepository,
): Promise<ProviderAccountBase | null> {
  const adapter = await buildAdapterUncapped(record, vault, appConfigRepo);
  if (!adapter) return null;

  // Applied uniformly regardless of which case above built the adapter, so
  // a provider with a hard per-object limit (e.g. Supabase Storage's 50MB
  // free-tier cap) never needs to remember to set this itself — it's
  // exactly what's already recorded on the account row at creation time
  // (see providers.ts, which copies it from the registry definition).
  adapter.maxSingleObjectBytes = record.maxSingleObjectBytes;
  return adapter;
}

async function buildAdapterUncapped(
  record: ProviderAccountRecord,
  vault: CredentialVault,
  appConfigRepo: ProviderAppConfigRepository,
): Promise<ProviderAccountBase | null> {
  const rawCredential = await vault.getCredential(record.credentialRef);
  if (!rawCredential) return null;
  const credential = JSON.parse(rawCredential) as Record<string, unknown>;

  switch (record.providerName) {
    case "mega": {
      if (typeof credential.email !== "string" || typeof credential.password !== "string") {
        return null; // incomplete/placeholder credential
      }
      return new MegaAccount({
        accountIndex: record.accountIndex,
        label: record.label,
        email: credential.email,
        password: credential.password,
      });
    }

    case "google_drive": {
      if (credential.status === "pending_oauth_connect") return null; // consent never completed
      if (typeof credential.refreshToken !== "string") return null;

      const appConfig = appConfigRepo.get("google_drive");
      if (!appConfig) return null;
      const rawAppCredential = await vault.getCredential(appConfig.credentialRef);
      if (!rawAppCredential) return null;
      const app = JSON.parse(rawAppCredential) as { clientId: string; clientSecret: string };

      return new GoogleDriveAccount({
        accountIndex: record.accountIndex,
        label: record.label,
        app,
        refreshToken: credential.refreshToken,
        onTokenRefresh: (tokens) => {
          if (tokens.access_token) {
            // Access tokens are short-lived and not persisted — the SDK
            // re-derives them from the refresh token on every process
            // start, so there's nothing to write back here today. Hook
            // left in place for when short-lived-token caching is added.
          }
        },
      });
    }

    case "supabase": {
      if (
        typeof credential.projectUrl !== "string" ||
        typeof credential.serviceRoleKey !== "string"
      ) {
        return null; // incomplete/placeholder credential
      }
      return new SupabaseAccount({
        accountIndex: record.accountIndex,
        label: record.label,
        projectUrl: credential.projectUrl,
        serviceRoleKey: credential.serviceRoleKey,
        capBytes: record.configuredCapBytes ?? 1 * 1024 * 1024 * 1024, // 1GB free-tier default
      });
    }

    // Every other provider in the catalog still has no concrete adapter —
    // see README "What's next (Phase 1)". Falling through to null keeps
    // those accounts exactly as they are today: saved but not connected.
    default:
      return null;
  }
}
