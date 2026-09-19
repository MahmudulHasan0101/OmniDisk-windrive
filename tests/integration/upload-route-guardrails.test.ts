import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

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

function buildMultipartBody(fileName: string, content: string, boundary: string): string {
  return (
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    `Content-Type: text/plain\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--\r\n`
  );
}

describe("Upload route guardrails", () => {
  it("returns a clear 409 (not a generic space error) when zero accounts are connected", async () => {
    const boundary = "----omnidiskTestBoundary1";
    const res = await app.inject({
      method: "POST",
      url: "/api/files/upload",
      payload: buildMultipartBody("test.txt", "hello omnidisk", boundary),
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe("no_connected_accounts");
    expect(body.message).toMatch(/live connection/i);
  });

  it("GET /providers/accounts reports connected: false for a DB-only account with no live adapter", async () => {
    // github has no concrete adapter yet (see server/providers/adapter-factory.ts) —
    // mega and google_drive now do, so this guardrail case uses a provider
    // that's still saved-but-unconnected by design.
    await app.inject({
      method: "POST",
      url: "/api/providers/github/accounts",
      payload: {
        label: "GH store",
        personalAccessToken: "ghp_fake",
        owner: "someone",
        repo: "omnidisk-store",
        freeSpaceCapGB: 2,
      },
    });

    const list = await app.inject({ method: "GET", url: "/api/providers/accounts" });
    const github = list.json().find((a: any) => a.providerName === "github");
    expect(github.connected).toBe(false);
  });
});
