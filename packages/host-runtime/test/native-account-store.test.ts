import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { NativeAccountStore, newProfile } from "../src/account/native-account-store.js";
import { createAccountState, credential } from "./fixtures/codex-account-fixtures.js";
const states: Awaited<ReturnType<typeof createAccountState>>[] = [];
afterEach(async () => {
  await Promise.all(states.splice(0).map((s) => s.close()));
});
async function state() {
  const value = await createAccountState();
  states.push(value);
  return value;
}
describe("plain native account store", () => {
  it("collects exact bytes by identity, updates metadata and only bumps changed revisions", async () => {
    const { store } = await state();
    await store.install(credential("a"));
    await store.captureCurrent();
    const id = store.currentAccountId,
      revision = store.vault.revision;
    await store.captureCurrent();
    expect(store.vault.revision).toBe(revision);
    await store.install(credential("a", 2));
    await store.captureCurrent();
    expect(store.currentAccountId).toBe(id);
    expect(store.vault.accounts).toHaveLength(1);
    expect(store.vault.accounts[0]?.auth).toBe(credential("a", 2).serializeForNativeStore());
    if (process.platform !== "win32") {
      expect((await stat(store.directory)).mode & 0o777).toBe(0o700);
      for (const file of [
        path.join(store.directory, "vault.json"),
        path.join(store.home, "auth.json"),
      ])
        expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });
  it("does not rewrite unchanged v3 vaults and still deletes redundant leftovers", async () => {
    const { store } = await state();
    await store.save(credential("a"));
    const file = path.join(store.directory, "vault.json");
    const text = await readFile(file, "utf8");
    const timestamp = new Date("2000-01-01T00:00:00.000Z");
    await utimes(file, timestamp, timestamp);
    const before = await stat(file);
    const leftover = path.join(store.directory, "transaction.json");
    await writeFile(
      leftover,
      JSON.stringify({ nativeDocument: credential("a").serializeForNativeStore() }),
    );
    const reopened = new NativeAccountStore({ home: store.home });
    await reopened.open();
    await reopened.open();
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(file, "utf8")).toBe(text);
    await expect(stat(leftover)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each([1, 2])(
    "converts v%s native copies, null payloads and mismatched identities",
    async (version) => {
      const { store } = await state();
      const a = newProfile(credential("a")),
        b = newProfile(credential("b")),
        c = newProfile(credential("c"));
      const file = path.join(store.directory, "vault.json");
      await writeFile(
        file,
        JSON.stringify({
          version,
          revision: 5,
          accounts: [
            { ...a, payload: { nativeDocument: a.auth } },
            { ...b, payload: null },
            { ...c, payload: { nativeDocument: a.auth } },
          ],
        }),
      );
      const reopened = new NativeAccountStore({ home: store.home });
      await reopened.open();
      expect(reopened.vault.accounts.map((a) => a.auth)).toEqual([a.auth, null, null]);
      expect(JSON.parse(await readFile(file, "utf8")).version).toBe(3);
    },
  );
  it("imports leftover credential copies without overwriting saved grants, then deletes records", async () => {
    const { store } = await state();
    const a = newProfile(credential("a"));
    await store.save(credential("a", 2));
    await store.mutate((next) => {
      next.accounts.push({ ...newProfile(credential("b")), auth: null });
    });
    await writeFile(
      path.join(store.directory, "transaction.json"),
      JSON.stringify({
        nested: [
          { nativeDocument: a.auth },
          { nativeDocument: credential("b").serializeForNativeStore() },
        ],
      }),
    );
    const stage = path.join(store.directory, "login", "stage");
    await mkdir(stage, { recursive: true });
    await writeFile(path.join(stage, "auth.json"), credential("c").serializeForNativeStore());
    await writeFile(path.join(store.directory, "login.json"), "{}");
    const reopened = new NativeAccountStore({ home: store.home });
    await reopened.open();
    expect(reopened.vault.accounts.map((a) => a.auth)).toEqual([
      credential("a", 2).serializeForNativeStore(),
      credential("b").serializeForNativeStore(),
      credential("c").serializeForNativeStore(),
    ]);
    for (const name of ["transaction.json", "login.json", "login"])
      await expect(stat(path.join(store.directory, name))).rejects.toMatchObject({
        code: "ENOENT",
      });
  });
  it("never overwrites a corrupt vault or deletes its recovery copies", async () => {
    const { store } = await state();
    const file = path.join(store.directory, "vault.json");
    await writeFile(file, "corrupt");
    await writeFile(path.join(store.directory, "transaction.json"), "{}");
    await expect(new NativeAccountStore({ home: store.home }).open()).rejects.toMatchObject({
      code: "unsupported-storage",
    });
    expect(await readFile(file, "utf8")).toBe("corrupt");
    expect(await readFile(path.join(store.directory, "transaction.json"), "utf8")).toBe("{}");
  });
  it("rejects replacing current or changed inactive bytes", async () => {
    const { store } = await state();
    await store.install(credential("a"));
    await store.captureCurrent();
    const id = store.currentAccountId ?? "missing";
    await expect(store.replaceSaved(id, credential("a"), credential("a", 2))).rejects.toMatchObject(
      { code: "credential-conflict" },
    );
    const b = await store.save(credential("b", 2));
    await expect(store.replaceSaved(b, credential("b"), credential("b", 3))).rejects.toMatchObject({
      code: "credential-conflict",
    });
  });
});
