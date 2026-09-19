import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, HTTPMethods } from "fastify";
import { MockProviderAccount } from "../helpers/mock-provider-account.js";
import type { AccountRegistry } from "../../server/core/account-registry.js";
import type { FileBlock, ProviderAccountStats } from "../../server/core/models.js";

const tempDataDir = mkdtempSync(join(tmpdir(), "omnidisk-dav-test-"));
process.env.OMNIDISK_DATA_DIR = tempDataDir;

/**
 * Reports real totals so the quota properties have something to sum, and can be
 * told to misbehave the way a real provider does (rejecting uploads, failing to
 * report its quota).
 */
class QuotaMockAccount extends MockProviderAccount {
  /** When set, every store() throws this message — e.g. MEGA's "Server returned error -3 while uploading". */
  rejectUploadsWith: string | null = null;
  failStats = false;

  override async store(block: FileBlock, data: Buffer): Promise<FileBlock> {
    if (this.rejectUploadsWith) throw new Error(this.rejectUploadsWith);
    return super.store(block, data);
  }

  override async getStats(): Promise<ProviderAccountStats> {
    if (this.failStats) throw new Error("quota lookup failed");
    return {
      ...(await super.getStats()),
      totalSpace: 10_000_000,
      usedSpace: 1_000_000,
    };
  }
}

let app: FastifyInstance;
let registry: AccountRegistry;
let mock: QuotaMockAccount;
let incompleteFileRows: () => number;

const storedObjectCount = () =>
  (mock as unknown as { storage: Map<string, Buffer> }).storage.size;

const dav = (method: HTTPMethods, url: string, extra: Record<string, unknown> = {}) =>
  app.inject({ method, url, ...extra });

const put = (url: string, payload: Buffer | string, headers: Record<string, string> = {}) =>
  dav("PUT", url, { payload, headers });

beforeAll(async () => {
  const { getDb } = await import("../../server/db/client.js");
  const { ProviderAccountRepository } = await import("../../server/db/repository.js");
  const { buildApp } = await import("../../server/api/server.js");

  ({ app, registry } = await buildApp());
  incompleteFileRows = () =>
    (getDb().prepare("SELECT COUNT(*) AS n FROM files WHERE status != 'complete'").get() as { n: number }).n;

  mock = new QuotaMockAccount({ providerName: "mock", freeSpace: 5_000_000_000 });
  registry.register(mock);

  // A persisted row for the live account, so the quota properties (which sum
  // persisted stats over live accounts) have data.
  new ProviderAccountRepository(getDb()).upsert({
    providerName: "mock",
    accountIndex: 0,
    authType: "api_key",
    credentialRef: "test",
    totalSpace: 10_000_000,
    usedSpace: 1_000_000,
    avgLatencyMs: 10,
    avgSpeedBps: 1000,
    priorityScore: 1,
    enabled: true,
    isLiveQuota: true,
    isBilledProvider: false,
  });

  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(tempDataDir, { recursive: true, force: true });
});

describe("WebDAV: the handshake Windows performs first (the `net use` failure)", () => {
  it("answers OPTIONS /dav with DAV class 1+2 instead of CORS's 400", async () => {
    const res = await dav("OPTIONS", "/dav");
    expect(res.statusCode).toBe(200);
    expect(res.headers.dav).toBe("1, 2");
    expect(res.headers["ms-author-via"]).toBe("DAV");
    expect(res.headers.allow).toContain("PROPFIND");
  });

  it("answers OPTIONS on the server root too (Windows probes it)", async () => {
    const res = await dav("OPTIONS", "/");
    expect(res.statusCode).toBe(200);
    expect(res.headers.dav).toBe("1, 2");
  });

  it("answers OPTIONS on a deep path", async () => {
    const res = await dav("OPTIONS", "/dav/some/deep/path.txt");
    expect(res.statusCode).toBe(200);
    expect(res.headers.dav).toBe("1, 2");
  });

  it("PROPFIND Depth:0 on an empty root returns a 207 collection", async () => {
    const res = await dav("PROPFIND", "/dav", { headers: { depth: "0" } });
    expect(res.statusCode).toBe(207);
    expect(res.headers["content-type"]).toContain("xml");
    expect(res.body).toContain("<D:collection/>");
    expect(res.body).toContain("<D:href>/dav/</D:href>");
  });

  it("reports real free space through the quota properties", async () => {
    const res = await dav("PROPFIND", "/dav/", {
      headers: { depth: "0", "content-type": "text/xml" },
      payload:
        '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop>' +
        "<D:quota-available-bytes/><D:quota-used-bytes/></D:prop></D:propfind>",
    });
    expect(res.statusCode).toBe(207);
    expect(res.body).toContain("<D:quota-available-bytes>9000000</D:quota-available-bytes>");
    expect(res.body).toContain("<D:quota-used-bytes>1000000</D:quota-used-bytes>");
  });

  it("does not disturb CORS for the web UI's /api routes", async () => {
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/stats",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "GET" },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("http://localhost:5173");

    // Non-preflight OPTIONS on /api is still rejected exactly as before.
    const plain = await app.inject({ method: "OPTIONS", url: "/api/stats" });
    expect(plain.statusCode).toBe(400);
  });

  it("returns 404 (not the SPA shell / HTML) for unknown methods on unknown paths", async () => {
    const res = await dav("PROPFIND", "/nope");
    expect(res.statusCode).toBe(404);
    const missing = await dav("PROPFIND", "/dav/does-not-exist");
    expect(missing.statusCode).toBe(404);
  });
});

describe("WebDAV: files", () => {
  const big = randomBytes(9 * 1024 * 1024); // 3 blocks at the 4MB default

  it("PUT creates (201) and GET returns the identical bytes across block boundaries", async () => {
    const created = await put("/dav/big.bin", big);
    expect(created.statusCode).toBe(201);

    const got = await dav("GET", "/dav/big.bin");
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-length"]).toBe(String(big.length));
    expect(got.headers["accept-ranges"]).toBe("bytes");
    expect(Buffer.compare(got.rawPayload, big)).toBe(0);
  });

  it("HEAD reports size without a body", async () => {
    const res = await dav("HEAD", "/dav/big.bin");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-length"]).toBe(String(big.length));
    expect(res.rawPayload.length).toBe(0);
  });

  it("serves a Range that straddles a block boundary (206)", async () => {
    const blockSize = 4 * 1024 * 1024;
    const start = blockSize - 500;
    const end = blockSize + 499;
    const res = await dav("GET", "/dav/big.bin", { headers: { range: `bytes=${start}-${end}` } });
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes ${start}-${end}/${big.length}`);
    expect(Buffer.compare(res.rawPayload, big.subarray(start, end + 1))).toBe(0);
  });

  it("supports open-ended and suffix ranges, and 416s past the end", async () => {
    const open = await dav("GET", "/dav/big.bin", { headers: { range: `bytes=${big.length - 10}-` } });
    expect(open.statusCode).toBe(206);
    expect(Buffer.compare(open.rawPayload, big.subarray(big.length - 10))).toBe(0);

    const suffix = await dav("GET", "/dav/big.bin", { headers: { range: "bytes=-7" } });
    expect(suffix.statusCode).toBe(206);
    expect(Buffer.compare(suffix.rawPayload, big.subarray(big.length - 7))).toBe(0);

    const past = await dav("GET", "/dav/big.bin", { headers: { range: `bytes=${big.length}-` } });
    expect(past.statusCode).toBe(416);
  });

  it("handles a zero-byte PUT (Explorer's 'New text document')", async () => {
    const created = await put("/dav/empty.txt", Buffer.alloc(0));
    expect(created.statusCode).toBe(201);

    const got = await dav("GET", "/dav/empty.txt");
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-length"]).toBe("0");
    expect(got.rawPayload.length).toBe(0);
  });

  it("stores JSON and XML bodies verbatim — the DAV parser must not interpret them", async () => {
    const invalidJson = Buffer.from("{ this is not json");
    const res = await put("/dav/data.json", invalidJson, { "content-type": "application/json" });
    expect(res.statusCode).toBe(201);
    const got = await dav("GET", "/dav/data.json");
    expect(got.rawPayload.toString()).toBe("{ this is not json");
  });

  it("lists files with correct lengths and percent-encoded hrefs for awkward names", async () => {
    const name = "My Report & Notes (v2) — über.txt";
    const content = Buffer.from("hello omnidisk");
    expect((await put(`/dav/${encodeURIComponent(name)}`, content)).statusCode).toBe(201);

    const res = await dav("PROPFIND", "/dav/", { headers: { depth: "1" } });
    expect(res.statusCode).toBe(207);
    expect(res.body).toContain(`<D:href>/dav/${encodeURIComponent(name)}</D:href>`);
    expect(res.body).toContain("&amp;"); // displayname is XML-escaped
    expect(res.body).toContain(`<D:getcontentlength>${content.length}</D:getcontentlength>`);
    expect(res.body).toContain(`<D:getcontentlength>${big.length}</D:getcontentlength>`);
  });

  it("overwrites in place (204), keeping one entry and freeing the old blocks", async () => {
    await put("/dav/over.txt", Buffer.from("version one"));
    const before = storedObjectCount();

    const res = await put("/dav/over.txt", Buffer.from("version two, longer"));
    expect(res.statusCode).toBe(204);
    expect(storedObjectCount()).toBe(before); // old block gone, new block in

    const got = await dav("GET", "/dav/over.txt");
    expect(got.rawPayload.toString()).toBe("version two, longer");

    const listing = await dav("PROPFIND", "/dav/", { headers: { depth: "1" } });
    expect(listing.body.match(/<D:href>\/dav\/over\.txt<\/D:href>/g)).toHaveLength(1);
  });

  it("matches names case-insensitively, as Windows expects", async () => {
    await put("/dav/CaseTest.TXT", Buffer.from("x"));
    const res = await dav("GET", "/dav/casetest.txt");
    expect(res.statusCode).toBe(200);
  });

  it("refuses to PUT over a folder (405) or into a missing folder (409)", async () => {
    await dav("MKCOL", "/dav/a-folder");
    expect((await put("/dav/a-folder", Buffer.from("x"))).statusCode).toBe(405);
    expect((await put("/dav/no/such/folder/file.txt", Buffer.from("x"))).statusCode).toBe(409);
  });

  it("returns 507 when no provider account is connected, and keeps the existing file", async () => {
    registry.clear();
    const res = await put("/dav/over.txt", Buffer.from("should not land"));
    expect(res.statusCode).toBe(507);
    registry.register(mock);

    const got = await dav("GET", "/dav/over.txt");
    expect(got.rawPayload.toString()).toBe("version two, longer");
  });

  it(
    "does not answer 201 when the provider rejects the upload; the old file survives and nothing is left behind",
    async () => {
      await put("/dav/keep.txt", Buffer.from("original"));
      const rowsBefore = incompleteFileRows();

      mock.rejectUploadsWith = "Server returned error -3 while uploading";
      const overwrite = await put("/dav/keep.txt", Buffer.from("replacement"));
      mock.rejectUploadsWith = null;

      expect(overwrite.statusCode).toBe(502);
      expect(overwrite.body).toContain("error -3"); // the provider's own words reach the client
      expect((await dav("GET", "/dav/keep.txt")).rawPayload.toString()).toBe("original");
      expect(incompleteFileRows()).toBe(rowsBefore); // no half-written row lingers
    },
    20_000,
  );

  it(
    "a brand-new file the provider rejects is not created, and a full account reports 507",
    async () => {
      mock.rejectUploadsWith = "Server returned error -17 while uploading"; // MEGA: over quota
      const res = await put("/dav/never-lands.txt", Buffer.from("x"));
      mock.rejectUploadsWith = null;

      expect(res.statusCode).toBe(507);
      expect((await dav("GET", "/dav/never-lands.txt")).statusCode).toBe(404);
      const listing = await dav("PROPFIND", "/dav/", { headers: { depth: "1" } });
      expect(listing.body).not.toContain("never-lands.txt");
    },
    20_000,
  );

  it("reports the same capacity however much is stored (available + used = summed quota)", async () => {
    const res = await dav("PROPFIND", "/dav/", {
      headers: { depth: "0", "content-type": "text/xml" },
      payload:
        '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop>' +
        "<D:quota-available-bytes/><D:quota-used-bytes/></D:prop></D:propfind>",
    });
    const available = Number(/<D:quota-available-bytes>(\d+)</.exec(res.body)?.[1]);
    const used = Number(/<D:quota-used-bytes>(\d+)</.exec(res.body)?.[1]);
    // Megabytes of files have been PUT by now; the capacity must not have moved.
    expect(available + used).toBe(10_000_000);
  });

  it("falls back to the last saved figures when the provider can't report its quota", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); // jump past the 60 s live-quota cache
    vi.setSystemTime(Date.now() + 120_000);
    mock.failStats = true;
    try {
      const res = await dav("PROPFIND", "/dav/", {
        headers: { depth: "0", "content-type": "text/xml" },
        payload:
          '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop>' +
          "<D:quota-available-bytes/><D:quota-used-bytes/></D:prop></D:propfind>",
      });
      expect(res.statusCode).toBe(207);
      expect(res.body).toContain("<D:quota-available-bytes>9000000</D:quota-available-bytes>");
      expect(res.body).toContain("<D:quota-used-bytes>1000000</D:quota-used-bytes>");
    } finally {
      mock.failStats = false;
      vi.useRealTimers();
    }
  });

  it("rejects path traversal", async () => {
    expect((await dav("GET", "/dav/%2e%2e/etc/passwd")).statusCode).toBe(404);
    expect((await put("/dav/a%2Fb.txt", Buffer.from("x"))).statusCode).toBe(404);
  });
});

describe("WebDAV: folders, move, delete", () => {
  it("MKCOL creates nested folders; duplicates 405; missing parent 409", async () => {
    expect((await dav("MKCOL", "/dav/docs")).statusCode).toBe(201);
    expect((await dav("MKCOL", "/dav/docs/2026")).statusCode).toBe(201);
    expect((await dav("MKCOL", "/dav/docs")).statusCode).toBe(405);
    expect((await dav("MKCOL", "/dav/nope/child")).statusCode).toBe(409);
  });

  it("files inside folders are listed under that folder only", async () => {
    await put("/dav/docs/2026/plan.txt", Buffer.from("plan"));
    const inFolder = await dav("PROPFIND", "/dav/docs/2026", { headers: { depth: "1" } });
    expect(inFolder.body).toContain("<D:href>/dav/docs/2026/plan.txt</D:href>");
    const root = await dav("PROPFIND", "/dav/", { headers: { depth: "1" } });
    expect(root.body).not.toContain("plan.txt");
    expect(root.body).toContain("<D:href>/dav/docs/</D:href>");
  });

  it("MOVE renames a file with zero data transfer", async () => {
    await put("/dav/old-name.txt", Buffer.from("payload"));
    const stored = storedObjectCount();
    const res = await dav("MOVE", "/dav/old-name.txt", {
      headers: { destination: "http://localhost:4310/dav/new-name.txt" },
    });
    expect(res.statusCode).toBe(201);
    expect(storedObjectCount()).toBe(stored);
    expect((await dav("GET", "/dav/old-name.txt")).statusCode).toBe(404);
    expect((await dav("GET", "/dav/new-name.txt")).rawPayload.toString()).toBe("payload");
  });

  it("MOVE into a folder, and case-only rename (what Explorer does for 'a.txt' -> 'A.txt')", async () => {
    await dav("MOVE", "/dav/new-name.txt", {
      headers: { destination: "/dav/docs/moved.txt" },
    });
    expect((await dav("GET", "/dav/docs/moved.txt")).statusCode).toBe(200);

    const rename = await dav("MOVE", "/dav/docs/moved.txt", {
      headers: { destination: "/dav/docs/MOVED.txt" },
    });
    expect(rename.statusCode).toBe(201);
    const listing = await dav("PROPFIND", "/dav/docs", { headers: { depth: "1" } });
    expect(listing.body).toContain("<D:displayname>MOVED.txt</D:displayname>");
  });

  it("MOVE honours Overwrite: F (412) and Overwrite: T (204)", async () => {
    await put("/dav/src.txt", Buffer.from("SRC"));
    await put("/dav/dst.txt", Buffer.from("DST"));
    const refused = await dav("MOVE", "/dav/src.txt", {
      headers: { destination: "/dav/dst.txt", overwrite: "F" },
    });
    expect(refused.statusCode).toBe(412);

    const allowed = await dav("MOVE", "/dav/src.txt", {
      headers: { destination: "/dav/dst.txt", overwrite: "T" },
    });
    expect(allowed.statusCode).toBe(204);
    expect((await dav("GET", "/dav/dst.txt")).rawPayload.toString()).toBe("SRC");
    expect((await dav("GET", "/dav/src.txt")).statusCode).toBe(404);
  });

  it("MOVE renames a folder and its children follow", async () => {
    await dav("MKCOL", "/dav/proj");
    await put("/dav/proj/readme.txt", Buffer.from("r"));
    const res = await dav("MOVE", "/dav/proj", { headers: { destination: "/dav/project" } });
    expect(res.statusCode).toBe(201);
    expect((await dav("GET", "/dav/project/readme.txt")).statusCode).toBe(200);
    expect((await dav("GET", "/dav/proj/readme.txt")).statusCode).toBe(404);
  });

  it("refuses to move a folder inside itself (would make the tree unwalkable)", async () => {
    await dav("MKCOL", "/dav/loop");
    await dav("MKCOL", "/dav/loop/inner");
    const res = await dav("MOVE", "/dav/loop", { headers: { destination: "/dav/loop/inner/loop" } });
    expect(res.statusCode).toBe(403);
  });

  it("MOVE rejects a destination outside the DAV namespace (502) and a missing one (400)", async () => {
    await put("/dav/x.txt", Buffer.from("x"));
    expect(
      (await dav("MOVE", "/dav/x.txt", { headers: { destination: "http://other/elsewhere.txt" } }))
        .statusCode,
    ).toBe(502);
    expect((await dav("MOVE", "/dav/x.txt")).statusCode).toBe(400);
  });

  it("DELETE on a file removes it from the provider, not just the database", async () => {
    await put("/dav/gone.txt", Buffer.from("bye"));
    const before = storedObjectCount();
    expect((await dav("DELETE", "/dav/gone.txt")).statusCode).toBe(204);
    expect(storedObjectCount()).toBe(before - 1);
    expect((await dav("GET", "/dav/gone.txt")).statusCode).toBe(404);
  });

  it("DELETE on a folder is recursive (RFC 4918) and frees every nested file", async () => {
    await dav("MKCOL", "/dav/tree");
    await dav("MKCOL", "/dav/tree/sub");
    await put("/dav/tree/a.txt", Buffer.from("a"));
    await put("/dav/tree/sub/b.txt", Buffer.from("b"));
    const before = storedObjectCount();

    expect((await dav("DELETE", "/dav/tree")).statusCode).toBe(204);
    expect(storedObjectCount()).toBe(before - 2);
    expect((await dav("PROPFIND", "/dav/tree", { headers: { depth: "0" } })).statusCode).toBe(404);
  });

  it("DELETE: 404 for missing, 403 for the root", async () => {
    expect((await dav("DELETE", "/dav/never-existed.txt")).statusCode).toBe(404);
    expect((await dav("DELETE", "/dav/")).statusCode).toBe(403);
  });

  it("COPY is an explicit 501 rather than a half-implementation", async () => {
    expect((await dav("COPY", "/dav/x.txt", { headers: { destination: "/dav/y.txt" } })).statusCode).toBe(501);
  });
});

describe("WebDAV: the extra calls Windows / Office make around every write", () => {
  it("LOCK returns a token and UNLOCK releases it", async () => {
    const locked = await dav("LOCK", "/dav/locked.docx", {
      headers: { "content-type": "text/xml", timeout: "Second-600" },
      payload:
        '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>' +
        "<D:locktype><D:write/></D:locktype><D:owner>tester</D:owner></D:lockinfo>",
    });
    expect(locked.statusCode).toBe(200);
    const token = /<(opaquelocktoken:[0-9a-f-]+)>/.exec(String(locked.headers["lock-token"]))?.[1];
    expect(token).toBeTruthy();
    expect(locked.body).toContain("Second-600");
    expect(locked.body).toContain("tester");

    const unlocked = await dav("UNLOCK", "/dav/locked.docx", {
      headers: { "lock-token": `<${token}>` },
    });
    expect(unlocked.statusCode).toBe(204);
  });

  it("PROPPATCH acknowledges Win32 timestamp properties (Windows sends this after every PUT)", async () => {
    await put("/dav/stamped.txt", Buffer.from("s"));
    const res = await dav("PROPPATCH", "/dav/stamped.txt", {
      headers: { "content-type": "text/xml" },
      payload:
        '<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:schemas-microsoft-com:">' +
        "<D:set><D:prop><Z:Win32LastModifiedTime>Fri, 18 Sep 2026 10:00:00 GMT</Z:Win32LastModifiedTime>" +
        "</D:prop></D:set></D:propertyupdate>",
    });
    expect(res.statusCode).toBe(207);
    expect(res.body).toContain("<Z:Win32LastModifiedTime/>");
    expect(res.body).toContain('xmlns:Z="urn:schemas-microsoft-com:"');
    expect(res.body).toContain("HTTP/1.1 200 OK");
  });
});

describe("Interoperability: REST upload and WebDAV see the same drive", () => {
  const boundary = "----omnidiskDavBoundary";
  const multipart = (fileName: string, content: string) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    `Content-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`;

  it("a file uploaded through the web UI's REST route appears in the mount and reads back", async () => {
    const upload = await app.inject({
      method: "POST",
      url: "/api/files/upload",
      payload: multipart("from-web-ui.txt", "uploaded via REST"),
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    });
    expect(upload.statusCode).toBe(200);

    const got = await dav("GET", "/dav/from-web-ui.txt");
    expect(got.statusCode).toBe(200);
    expect(got.rawPayload.toString()).toBe("uploaded via REST");
  });

  it("a file PUT through the mount downloads intact through the REST route", async () => {
    const payload = randomBytes(1_500_000);
    await put("/dav/from-explorer.bin", payload);

    const listing = await app.inject({ method: "GET", url: "/api/files" });
    const record = (listing.json() as { fileUuid: string; fileName: string }[]).find(
      (f) => f.fileName === "from-explorer.bin",
    );
    expect(record).toBeTruthy();

    const download = await app.inject({ method: "GET", url: `/api/files/${record!.fileUuid}/download` });
    expect(download.statusCode).toBe(200);
    expect(Buffer.compare(download.rawPayload, payload)).toBe(0);
  });

  it("REST DELETE and DAV DELETE agree (no orphaned provider objects either way)", async () => {
    await put("/dav/rest-deletes-me.txt", Buffer.from("x"));
    const before = storedObjectCount();
    const listing = await app.inject({ method: "GET", url: "/api/files" });
    const record = (listing.json() as { fileUuid: string; fileName: string }[]).find(
      (f) => f.fileName === "rest-deletes-me.txt",
    )!;
    const del = await app.inject({ method: "DELETE", url: `/api/files/${record.fileUuid}` });
    expect(del.statusCode).toBe(204);
    expect(storedObjectCount()).toBe(before - 1);
    expect((await dav("GET", "/dav/rest-deletes-me.txt")).statusCode).toBe(404);
  });
});
