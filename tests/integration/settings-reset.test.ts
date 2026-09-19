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

describe("DELETE /settings/reset-all", () => {
  it("wipes accounts, settings, and credentials, and the registry keeps working afterward", async () => {
    // 1. Get some non-default state on the board first.
    const addAccount = await app.inject({
      method: "POST",
      url: "/api/providers/mega/accounts",
      payload: { label: "Test MEGA", email: "reset-test@example.com", password: "hunter2" },
    });
    expect(addAccount.statusCode).toBe(201);

    const patchSettings = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { retryMaxAttempts: 9 },
    });
    expect(patchSettings.json().retryMaxAttempts).toBe(9);

    const beforeAccounts = await app.inject({ method: "GET", url: "/api/providers/accounts" });
    expect(beforeAccounts.json()).toHaveLength(1);

    // 2. Reset.
    const reset = await app.inject({ method: "DELETE", url: "/api/settings/reset-all" });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ reset: true });

    // 3. Everything local is gone / back to defaults.
    const afterAccounts = await app.inject({ method: "GET", url: "/api/providers/accounts" });
    expect(afterAccounts.json()).toHaveLength(0);

    const afterSettings = await app.inject({ method: "GET", url: "/api/settings" });
    expect(afterSettings.json().retryMaxAttempts).not.toBe(9); // back to whatever the default is

    const afterFiles = await app.inject({ method: "GET", url: "/api/files" });
    expect(afterFiles.json()).toHaveLength(0);

    // 4. The app isn't left in a broken state — adding a fresh account
    // afterward still works normally (registry wasn't permanently wedged).
    const addAgain = await app.inject({
      method: "POST",
      url: "/api/providers/mega/accounts",
      payload: { label: "Fresh MEGA", email: "fresh@example.com", password: "hunter3" },
    });
    expect(addAgain.statusCode).toBe(201);
    const finalAccounts = await app.inject({ method: "GET", url: "/api/providers/accounts" });
    expect(finalAccounts.json()).toHaveLength(1);
    expect(finalAccounts.json()[0].label).toBe("Fresh MEGA");
  });
});
