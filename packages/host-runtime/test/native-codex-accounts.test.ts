import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { AccountReadFailure } from "../src/account/native-account-diagnostics.js";
import path from "node:path";
import { NativeCodexAccounts } from "../src/account/native-codex-accounts.js";
import { NativeAccountError } from "../src/account/native-account-store.js";
import { credential, createAccountState } from "./fixtures/codex-account-fixtures.js";
const states: Awaited<ReturnType<typeof createAccountState>>[] = [];
afterEach(async () => {
  await Promise.all(states.splice(0).map((s) => s.close()));
});
async function setup(saveCurrent = true) {
  const state = await createAccountState();
  states.push(state);
  await state.store.install(credential("a"));
  if (saveCurrent) await state.store.captureCurrent();
  const a = state.store.currentAccountId,
    b = await state.store.save(credential("b"));
  const accounts = new NativeCodexAccounts({
    ...state,
    readOfficialIdentity: async () => ({ accountId: "official-a", label: "a@example.com" }),
  });
  await accounts.initialize();
  state.runtime.events.length = 0;
  return { ...state, accounts, a, b };
}
describe("credential replacement", () => {
  it("refresh captures current credentials without holding a request lease", async () => {
    const { accounts, store, runtime } = await setup();
    const capture = Promise.withResolvers<undefined>();
    const started = Promise.withResolvers<undefined>();
    const captureCurrent = store.captureCurrent.bind(store);
    vi.spyOn(store, "captureCurrent").mockImplementationOnce(async () => {
      started.resolve(undefined);
      await capture.promise;
      return captureCurrent();
    });

    const refreshing = accounts.refresh();
    await started.promise;
    try {
      expect(runtime.gate.busy).toBe(false);
      const change = runtime.gate.beginStoppingChange();
      try {
        expect(() => change.assertIdle()).not.toThrow();
      } finally {
        change.finish("ready");
      }
    } finally {
      capture.resolve(undefined);
      await refreshing;
    }
    expect(runtime.gate.busy).toBe(false);
  });
  it("checks external processes before stopping, then captures, installs and verifies while admissions are closed", async () => {
    const { store, runtime, accounts, b } = await setup();
    vi.spyOn(store, "captureCurrent").mockImplementation(async () => {
      runtime.events.push("capture");
      return store.readCredentials();
    });
    const install = store.install.bind(store);
    vi.spyOn(store, "install").mockImplementation(async (target) => {
      runtime.events.push("write");
      await install(target);
    });
    runtime.onStop = async () => {
      expect(() => runtime.gate.admit()).toThrow("changing");
    };
    await accounts.switch(b);
    expect(runtime.events).toEqual([
      "capture",
      "check",
      "external",
      "stop",
      "capture",
      "write",
      "start",
      "verify",
      "capture",
    ]);
    expect(accounts.snapshot()).toMatchObject({ currentAccountId: b, phase: "ready" });
  });
  it("records switch and rollback verification failures without secret details", async () => {
    const { accounts, runtime, store, b } = await setup();
    runtime.onVerify = async () => {
      throw new AccountReadFailure(-42, "verify-account-null");
    };
    await expect(accounts.switch(b)).rejects.toMatchObject({ code: "authentication-failed" });
    const lines = (await readFile(path.join(store.directory, "diagnostics.log"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([
      {
        operation: "switch",
        step: "verify-account-null",
        code: -42,
        elapsedMs: expect.any(Number),
      },
      {
        operation: "switch",
        step: "rollback-verify-account-null",
        code: -42,
        elapsedMs: expect.any(Number),
      },
    ]);
    expect(accounts.snapshot().phase).toBe("unavailable");
  });
  it("records recover verification failures", async () => {
    const operation = "recover";
    const { accounts, runtime, store } = await setup();
    runtime.onVerify = async () => {
      throw new AccountReadFailure(undefined, "verify-identity-mismatch");
    };
    runtime.gate.unavailable();
    await expect(accounts.recover()).rejects.toThrow();
    const lines = await readFile(path.join(store.directory, "diagnostics.log"), "utf8");
    expect(JSON.parse(lines.split("\n")[0] ?? "null")).toMatchObject({
      operation,
      step: "verify-identity-mismatch",
    });
  });
  it("refuses to switch while a Turn is active and leaves the backend running", async () => {
    const { accounts, runtime, a, b } = await setup();
    let idle = false;
    accounts.bindIdleProbe(() => idle);
    await expect(accounts.switch(b)).rejects.toMatchObject({ code: "busy" });
    expect(runtime.events).not.toContain("stop");
    expect(accounts.snapshot()).toMatchObject({ phase: "ready", currentAccountId: a });
    expect(() => runtime.gate.admit()()).not.toThrow();
    idle = true;
    await accounts.switch(b);
    expect(accounts.snapshot().currentAccountId).toBe(b);
  });
  it("same identity does not stop", async () => {
    const { accounts, a, runtime } = await setup();
    await accounts.switch(a ?? "missing");
    expect(runtime.events).toEqual([]);
  });
  it("verification failure restores A and ready", async () => {
    const { accounts, runtime, store, b, a } = await setup();
    runtime.onVerify = async (identity) => {
      if (identity?.subject === "b") throw new Error("bad");
    };
    await expect(accounts.switch(b)).rejects.toMatchObject({ code: "switch-failed" });
    expect(accounts.snapshot()).toMatchObject({ phase: "ready", currentAccountId: a });
    expect((await store.readCredentials())?.serializeForNativeStore()).toBe(
      credential("a").serializeForNativeStore(),
    );
  });
  it("preserves final rotated source bytes and refreshed target grants on rollback", async () => {
    const { accounts, runtime, store, b, a } = await setup();
    runtime.onStop = async () => {
      // Native rotation while the backend exits; the rollback stop must not repeat it.
      runtime.onStop = undefined;
      await store.install(credential("a", 2));
    };
    runtime.onVerify = async (identity) => {
      if (identity?.subject === "b") {
        await store.install(credential("b", 2));
        throw new Error("verification failed");
      }
    };
    await expect(accounts.switch(b)).rejects.toMatchObject({ code: "switch-failed" });
    expect((await store.readCredentials())?.serializeForNativeStore()).toBe(
      credential("a", 2).serializeForNativeStore(),
    );
    expect(store.vault.accounts.find((account) => account.accountId === b)?.auth).toBe(
      credential("b", 2).serializeForNativeStore(),
    );
    expect(accounts.snapshot()).toMatchObject({ currentAccountId: a, phase: "ready" });
  });
  it("failed stop does not touch auth and ends unavailable", async () => {
    const { accounts, runtime, store, b } = await setup();
    runtime.onStop = async () => {
      throw new Error();
    };
    const install = vi.spyOn(store, "install");
    await expect(accounts.switch(b)).rejects.toMatchObject({ code: "switch-failed" });
    expect(install).not.toHaveBeenCalled();
    expect(accounts.snapshot().phase).toBe("unavailable");
  });
  it("refuses with unsafe-external-process before anything is stopped or written", async () => {
    const { accounts, runtime, store, b, a } = await setup();
    runtime.onExternalCheck = async () => {
      throw new NativeAccountError("unsafe-external-process");
    };
    const install = vi.spyOn(store, "install");
    await expect(accounts.switch(b)).rejects.toMatchObject({ code: "unsafe-external-process" });
    expect(runtime.events).not.toContain("stop");
    expect(install).not.toHaveBeenCalled();
    expect(accounts.snapshot()).toMatchObject({ phase: "ready", currentAccountId: a });
  });
  it.each([false, true])(
    "busy credential lease preserves rotated bytes (drains during restart=%s)",
    async (drains) => {
      const { accounts, runtime, store, b, a } = await setup();
      const rotated = credential("a", 2).serializeForNativeStore();
      runtime.onStop = async () => {
        await writeFile(path.join(store.home, "auth.json"), rotated);
      };
      const release = runtime.gate.admit("credential-write");
      if (drains)
        runtime.onVerify = async () => {
          release();
        };
      const install = vi.spyOn(store, "install");
      try {
        await expect(accounts.switch(b)).rejects.toMatchObject({ code: "busy" });
        expect((await store.readCredentials())?.serializeForNativeStore()).toBe(rotated);
        expect(install).not.toHaveBeenCalled();
        expect(accounts.snapshot()).toMatchObject({
          phase: drains ? "ready" : "unavailable",
          currentAccountId: a,
        });
      } finally {
        release();
      }
    },
  );
  it("rejects concurrent switch and native authentication", async () => {
    const { accounts, runtime, a, b } = await setup();
    const stopped = Promise.withResolvers<undefined>();
    runtime.onStop = () => stopped.promise;
    const first = accounts.switch(b);
    await vi.waitFor(() => expect(runtime.events).toContain("stop"));
    await expect(accounts.switch(b)).rejects.toMatchObject({ code: "changing" });
    stopped.resolve(undefined);
    await first;
    const release = runtime.gate.admit("native-auth");
    await expect(accounts.switch(a ?? "missing")).rejects.toMatchObject({ code: "busy" });
    release();
  });
  it("deletion is inactive-only and never touches native auth", async () => {
    const { accounts, runtime, store, a, b } = await setup();
    await expect(accounts.remove(a ?? "missing")).rejects.toMatchObject({
      code: "credential-conflict",
    });
    await accounts.remove(b);
    expect(runtime.events).toEqual([]);
    expect((await store.readCredentials())?.serializeForNativeStore()).toBe(
      credential("a").serializeForNativeStore(),
    );
  });
  it("recovers even after management initialization failed", async () => {
    const { accounts, runtime } = await setup();
    vi.spyOn(runtime, "checkCredentialStorage").mockRejectedValueOnce(new Error("unsupported"));
    await expect(accounts.initialize()).rejects.toThrow("unsupported");
    expect(accounts.snapshot().capabilities?.manage).toBe(false);
    runtime.gate.unavailable();
    await accounts.recover();
    expect(accounts.snapshot()).toMatchObject({ phase: "ready", capabilities: { manage: true } });
  });
});
describe("explicit save", () => {
  it("shows an unsaved native login as current without collecting its credential", async () => {
    const { accounts, store, b } = await setup(false);
    const listed = await accounts.refresh();
    expect(listed.currentAccountId).toBe("official-a");
    expect(listed.accounts).toEqual([
      { accountId: "official-a", label: "a@example.com" },
      expect.objectContaining({ accountId: b, saved: true }),
    ]);
    expect(store.vault.accounts.map((account) => account.accountId)).toEqual([b]);
  });
  it("saveCurrent adds the current login; passive refresh then keeps it fresh", async () => {
    const { accounts, store } = await setup(false);
    const saved = await accounts.saveCurrent();
    expect(accounts.snapshot()).toMatchObject({ currentAccountId: saved, phase: "ready" });
    await store.install(credential("a", 2));
    await accounts.refresh();
    expect(store.vault.accounts.find((account) => account.accountId === saved)?.auth).toBe(
      credential("a", 2).serializeForNativeStore(),
    );
  });
  it("switching away from an unsaved login saves it first so it is never lost", async () => {
    const { accounts, store, b } = await setup(false);
    await accounts.switch(b);
    expect(accounts.snapshot().currentAccountId).toBe(b);
    expect(
      store.vault.accounts.some(
        (account) => account.auth === credential("a").serializeForNativeStore(),
      ),
    ).toBe(true);
  });
  it("refuses saveCurrent when signed out", async () => {
    const { accounts, store } = await setup(false);
    await store.install(null);
    await expect(accounts.saveCurrent()).rejects.toMatchObject({ code: "requires-login" });
  });
});
