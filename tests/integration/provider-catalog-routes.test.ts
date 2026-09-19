import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

// Redirect AppData (and therefore the SQLite DB + credentials.enc) to an
// isolated temp directory before db/client.ts is ever imported, so these
// tests never touch the real user AppData folder.
const tempDataDir = mkdtempSync(join(tmpdir(), "omnidisk-test-"));
process.env.XDG_DATA_HOME = tempDataDir;

let app: FastifyInstance;

beforeAll(async () => {
  const { buildApp } = await import("../../server/api/server.js");
  ({ app } = await buildApp());
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(tempDataDir, { recursive: true, force: true });
});

describe("Provider catalog routes", () => {
  it("GET /api/providers/catalog returns all 15 provider definitions", async () => {
    const res = await app.inject({ method: "GET", url: "/api/providers/catalog" });
    expect(res.statusCode).toBe(200);
    const catalog = res.json();
    expect(catalog).toHaveLength(15);
    const googleDrive = catalog.find((p: any) => p.providerName === "google_drive");
    expect(googleDrive.requiresOAuthConnect).toBe(true);
    expect(googleDrive.appLevelFields).toHaveLength(2);
  });

  it("app-config: reports not configured, rejects incomplete submission, then saves", async () => {
    const before = await app.inject({
      method: "GET",
      url: "/api/providers/catalog/google_drive/app-config",
    });
    expect(before.json()).toEqual({ configured: false });

    const incomplete = await app.inject({
      method: "POST",
      url: "/api/providers/catalog/google_drive/app-config",
      payload: { clientId: "abc" }, // missing required clientSecret
    });
    expect(incomplete.statusCode).toBe(422);
    expect(incomplete.json().fields).toContain("clientSecret");

    const saved = await app.inject({
      method: "POST",
      url: "/api/providers/catalog/google_drive/app-config",
      payload: { clientId: "abc", clientSecret: "shh" },
    });
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toEqual({ saved: true });

    const after = await app.inject({
      method: "GET",
      url: "/api/providers/catalog/google_drive/app-config",
    });
    expect(after.json()).toEqual({ configured: true });
  });

  it("blocks OAuth connect until the app-level config is saved for that provider", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/providers/onedrive/connect", // onedrive app-config was never saved
      payload: { label: "Work OneDrive" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("connects a Google Drive account once app-config exists, incrementing accountIndex", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/providers/google_drive/connect",
      payload: { label: "Drive – Personal" },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ providerName: "google_drive", accountIndex: 0 });

    const second = await app.inject({
      method: "POST",
      url: "/api/providers/google_drive/connect",
      payload: { label: "Drive – Work" },
    });
    expect(second.json()).toMatchObject({ providerName: "google_drive", accountIndex: 1 });

    const list = await app.inject({ method: "GET", url: "/api/providers/accounts" });
    const driveAccounts = list.json().filter((a: any) => a.providerName === "google_drive");
    expect(driveAccounts).toHaveLength(2);
    expect(driveAccounts.every((a: any) => a.enabled)).toBe(true); // not a billed provider
  });

  it("registers a non-OAuth (basic) MEGA account directly via /accounts", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/providers/mega/accounts",
      payload: { label: "MEGA main", email: "me@example.com", password: "hunter2" },
    });
    expect(res.statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: "/api/providers/accounts" });
    const mega = list.json().find((a: any) => a.providerName === "mega");
    expect(mega.enabled).toBe(true);
    expect(mega.isLiveQuota).toBe(true);
    // MEGA has a concrete adapter (see server/providers/mega-account.ts) —
    // it's registered into AccountRegistry immediately, even though the
    // credentials themselves aren't verified with a live call until first use.
    expect(mega.connected).toBe(true);
  });

  it("rejects using /accounts for an OAuth provider and /connect for a non-OAuth one", async () => {
    const wrongWay1 = await app.inject({
      method: "POST",
      url: "/api/providers/google_drive/accounts",
      payload: {},
    });
    expect(wrongWay1.statusCode).toBe(400);

    const wrongWay2 = await app.inject({
      method: "POST",
      url: "/api/providers/mega/connect",
      payload: {},
    });
    expect(wrongWay2.statusCode).toBe(400);
  });

  it("billed-provider guardrail: new S3 accounts default to enabled=false and record the spending cap", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/providers/s3/accounts",
      payload: {
        label: "S3 backup",
        accessKeyId: "AKIA...",
        secretAccessKey: "shh",
        region: "us-east-1",
        bucket: "omnidisk-fragments",
        spendingCapGB: 5,
      },
    });
    expect(res.statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: "/api/providers/accounts" });
    const s3 = list.json().find((a: any) => a.providerName === "s3");
    expect(s3.enabled).toBe(false);
    expect(s3.isBilledProvider).toBe(true);
    expect(s3.configuredCapBytes).toBe(5 * 1024 ** 3);

    // PATCH turns it on, per the guardrail's escape hatch.
    const patched = await app.inject({
      method: "PATCH",
      url: "/api/providers/accounts/s3/0",
      payload: { enabled: true },
    });
    expect(patched.json().enabled).toBe(true);
  });

  it("deletes an account with no referencing blocks", async () => {
    const del = await app.inject({ method: "DELETE", url: "/api/providers/accounts/mega/0" });
    expect(del.statusCode).toBe(204);

    const list = await app.inject({ method: "GET", url: "/api/providers/accounts" });
    expect(list.json().find((a: any) => a.providerName === "mega")).toBeUndefined();
  });
});
