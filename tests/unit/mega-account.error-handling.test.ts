import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { MegaAccount } from "../../server/providers/mega-account.js";

/**
 * Regression test for a real crash: megajs's Storage class creates its own
 * internal API EventEmitter for background long-polling and never attaches
 * an 'error' listener to it itself. An unhandled 'error' event throws and
 * kills the whole Node process (Node EventEmitter semantics) — a transient
 * network hiccup during that ambient polling (unrelated to any request our
 * code made) used to take down the entire OmniDisk server.
 *
 * Builds a minimal fake standing in for what MegaAccount actually touches
 * on a megajs Storage instance, rather than hitting the real network.
 */
function makeFakeStorage() {
  const api = new EventEmitter();
  let resolveReady!: (storage: unknown) => void;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  const storage: any = {
    api,
    ready,
    root: { children: [] },
  };
  resolveReady(storage);
  return storage;
}

describe("MegaAccount background API error handling", () => {
  it("does not crash the process when the underlying API emits 'error'", async () => {
    const fakeStorage = makeFakeStorage();
    const factory = vi.fn(() => fakeStorage);

    const account = new MegaAccount({
      accountIndex: 0,
      email: "test@example.com",
      password: "irrelevant",
      storageFactory: factory,
    });

    // Establish the session (drives getStorage() to attach the listener).
    await account.pingLatency().catch(() => {});

    // This is exactly the failure mode from the bug report: megajs's
    // internal API instance emitting 'error' from its background
    // long-polling loop, independent of any specific call. Node throws
    // synchronously (crashing the process) if there's no listener — this
    // line itself is the assertion: if MegaAccount didn't attach one,
    // this test process would crash rather than fail normally.
    expect(() => {
      fakeStorage.api.emit("error", new Error("getaddrinfo ENOTFOUND g.api.mega.co.nz"));
    }).not.toThrow();
  });

  it("drops the cached session on a background error so the next call re-authenticates", async () => {
    const fakeStorage1 = makeFakeStorage();
    const fakeStorage2 = makeFakeStorage();
    const factory = vi.fn().mockReturnValueOnce(fakeStorage1).mockReturnValueOnce(fakeStorage2);

    const account = new MegaAccount({
      accountIndex: 0,
      email: "test@example.com",
      password: "irrelevant",
      storageFactory: factory,
    });

    await account.pingLatency().catch(() => {});
    expect(factory).toHaveBeenCalledTimes(1);

    fakeStorage1.api.emit("error", new Error("simulated network hiccup"));

    await account.pingLatency().catch(() => {});
    expect(factory).toHaveBeenCalledTimes(2); // re-logged in, didn't keep reusing the broken session
  });
});
