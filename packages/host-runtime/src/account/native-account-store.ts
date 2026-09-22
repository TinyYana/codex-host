import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { codexAccountPlanTypeSchema } from "@codexhost/shared-contracts";
import {
  NativeCodexCredentials,
  codexCredentialIdentitySchema,
  sameCodexCredentialIdentity,
  type CodexCredentialIdentity,
} from "./native-codex-credentials.js";

export class NativeAccountError extends Error {
  constructor(
    readonly code:
      | "unknown-account"
      | "requires-login"
      | "unsupported-storage"
      | "credential-conflict"
      | "authentication-failed"
      | "switch-failed"
      | "unsafe-external-process"
      | "recovery-required",
  ) {
    super(`Codex Account ${code}`);
    this.name = "NativeAccountError";
  }
}
const accountSchema = z.object({
  accountId: z.string().uuid(),
  identity: codexCredentialIdentitySchema,
  label: z.string(),
  email: z.string().optional(),
  planType: codexAccountPlanTypeSchema.optional(),
  auth: z.string().nullable(),
});
export type NativeAccount = z.infer<typeof accountSchema>;
export interface NativeAccountVault {
  version: 3;
  revision: number;
  accounts: NativeAccount[];
}

export async function readOptionalFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
export async function writePrivateFile(file: string, text: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
function parseVault(text: string): NativeAccountVault {
  try {
    const root = z
      .object({
        version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        revision: z.number().int().nonnegative(),
        accounts: z.array(z.record(z.string(), z.unknown())),
      })
      .parse(JSON.parse(text));
    const accounts = root.accounts.map((entry) => {
      const payload = entry.payload;
      const auth =
        root.version === 3
          ? entry.auth
          : payload &&
              typeof payload === "object" &&
              "nativeDocument" in payload &&
              typeof payload.nativeDocument === "string"
            ? payload.nativeDocument
            : null;
      const account = accountSchema.parse({ ...entry, auth });
      if (account.auth) {
        try {
          if (
            !sameCodexCredentialIdentity(
              NativeCodexCredentials.parse(account.auth).identity,
              account.identity,
            )
          )
            account.auth = null;
        } catch {
          account.auth = null;
        }
      }
      return account;
    });
    if (
      new Set(accounts.map((a) => a.accountId)).size !== accounts.length ||
      new Set(accounts.map((a) => JSON.stringify(a.identity))).size !== accounts.length
    )
      throw new Error();
    return { version: 3, revision: root.revision, accounts };
  } catch {
    throw new NativeAccountError("unsupported-storage");
  }
}
export function newProfile(
  credential: NativeCodexCredentials,
  accountId: string = randomUUID(),
): NativeAccount {
  return {
    accountId,
    identity: { ...credential.identity },
    label: credential.email ?? `Codex ${accountId.slice(0, 8)}`,
    ...(credential.email ? { email: credential.email } : {}),
    ...(credential.planType ? { planType: credential.planType } : {}),
    auth: credential.serializeForNativeStore(),
  };
}
function upsert(
  vault: NativeAccountVault,
  credential: NativeCodexCredentials,
  fillOnly = false,
  accountId?: string,
  addNew = true,
): NativeAccount | null {
  const existing = vault.accounts.find((a) =>
    sameCodexCredentialIdentity(a.identity, credential.identity),
  );
  if (!existing) {
    // Passive observation refreshes saved Accounts only; new identities need an explicit save.
    if (!addNew) return null;
    const account = newProfile(credential, accountId);
    vault.accounts.push(account);
    return account;
  }
  if (!fillOnly || existing.auth === null) {
    existing.auth = credential.serializeForNativeStore();
    if (credential.email) existing.email = credential.email;
    if (credential.planType) existing.planType = credential.planType;
  }
  return existing;
}

/** Plain native credential copies; selection is observed, never persisted. */
export class NativeAccountStore {
  readonly home: string;
  readonly directory: string;
  #vault: NativeAccountVault = { version: 3, revision: 0, accounts: [] };
  #ready = false;
  #scanned = false;
  #identity: CodexCredentialIdentity | null = null;
  #observationRevision = 0;
  #mutations: Promise<void> = Promise.resolve();
  constructor(input: { home: string }) {
    this.home = path.resolve(input.home);
    this.directory = path.join(this.home, ".codexhost-native-accounts");
  }
  get ready(): boolean {
    return this.#ready;
  }
  get vault(): NativeAccountVault {
    if (!this.#ready) throw new NativeAccountError("unsupported-storage");
    return structuredClone(this.#vault);
  }
  get observationRevision(): number {
    return this.#observationRevision;
  }
  get currentAccountId(): string | null {
    const identity = this.#identity;
    return identity
      ? (this.#vault.accounts.find((a) => sameCodexCredentialIdentity(a.identity, identity))
          ?.accountId ?? null)
      : null;
  }
  #serialize<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.#mutations.then(action);
    this.#mutations = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
  /** True once a vault exists: the user opted into Account management at some point. */
  async hasVault(): Promise<boolean> {
    return (await readOptionalFile(path.join(this.directory, "vault.json"))) !== null;
  }
  open(): Promise<void> {
    return this.#serialize(async () => {
      await mkdir(this.home, { recursive: true, mode: 0o700 });
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      const text = await readOptionalFile(path.join(this.directory, "vault.json"));
      const vault =
        text === null ? { version: 3 as const, revision: 0, accounts: [] } : parseVault(text);
      const before = JSON.stringify(vault.accounts);
      const leftovers = [
        "transaction.json",
        "login.json",
        "login",
        ".codexhost-process.json",
        ".codexhost-process-exit.json",
        ".codexhost-writer.lock",
      ].map((name) => path.join(this.directory, name));
      if (!this.#scanned) {
        const collect = (value: unknown): void => {
          if (!value || typeof value !== "object") return;
          for (const [key, child] of Object.entries(value)) {
            if (key === "nativeDocument" && typeof child === "string") {
              try {
                upsert(vault, NativeCodexCredentials.parse(child), true);
              } catch {
                /* Not a readable native copy. */
              }
            } else collect(child);
          }
        };
        const scan = async (file: string): Promise<void> => {
          const entries = await readdir(file, { withFileTypes: true }).catch(() => null);
          if (entries) {
            for (const entry of entries)
              if (!entry.isSymbolicLink()) await scan(path.join(file, entry.name));
            return;
          }
          const bytes = await readOptionalFile(file);
          if (!bytes) return;
          try {
            if (path.basename(file) === "auth.json")
              upsert(vault, NativeCodexCredentials.parse(bytes), true);
            else collect(JSON.parse(bytes));
          } catch {
            /* Obsolete noncredential record. */
          }
        };
        for (const file of leftovers) await scan(file);
      }
      const accountsChanged = JSON.stringify(vault.accounts) !== before;
      if (accountsChanged) vault.revision++;
      if (text === null || JSON.parse(text).version !== 3 || accountsChanged)
        await writePrivateFile(path.join(this.directory, "vault.json"), JSON.stringify(vault));
      if (!this.#scanned) {
        for (const file of leftovers) await rm(file, { recursive: true, force: true });
        this.#scanned = true;
      }
      this.#vault = vault;
      this.#ready = true;
    });
  }
  async reload(): Promise<NativeAccountVault> {
    const text = await readOptionalFile(path.join(this.directory, "vault.json"));
    if (text === null) throw new NativeAccountError("unsupported-storage");
    this.#vault = parseVault(text);
    return this.vault;
  }
  mutate(update: (next: NativeAccountVault) => void | Promise<void>): Promise<void> {
    return this.#serialize(async () => {
      const before = await this.reload();
      const next = structuredClone(before);
      await update(next);
      if (JSON.stringify(before.accounts) === JSON.stringify(next.accounts)) return;
      next.revision = before.revision + 1;
      await writePrivateFile(path.join(this.directory, "vault.json"), JSON.stringify(next));
      this.#vault = next;
    });
  }
  async save(credential: NativeCodexCredentials, accountId?: string): Promise<string> {
    let saved = "";
    await this.mutate((next) => {
      saved = upsert(next, credential, false, accountId)?.accountId ?? "";
    });
    return saved;
  }
  /** "update-saved" never adds an identity the user has not explicitly saved or switched from. */
  async captureCurrent(
    mode: "save-new" | "update-saved" = "save-new",
  ): Promise<NativeCodexCredentials | null> {
    let current: NativeCodexCredentials | null = null;
    await this.#serialize(async () => {
      current = await this.readCredentials();
      const before = await this.reload();
      const next = structuredClone(before);
      if (current) upsert(next, current, false, undefined, mode === "save-new");
      if (JSON.stringify(before.accounts) !== JSON.stringify(next.accounts)) {
        next.revision++;
        await writePrivateFile(path.join(this.directory, "vault.json"), JSON.stringify(next));
        this.#vault = next;
      }
    });
    return current;
  }
  async readCredentials(home = this.home): Promise<NativeCodexCredentials | null> {
    const text = await readOptionalFile(path.join(home, "auth.json"));
    let credential: NativeCodexCredentials | null;
    try {
      credential = text === null ? null : NativeCodexCredentials.parse(text);
    } catch {
      throw new NativeAccountError("unsupported-storage");
    }
    if (
      home === this.home &&
      JSON.stringify(this.#identity) !== JSON.stringify(credential?.identity ?? null)
    ) {
      this.#identity = credential?.identity ?? null;
      this.#observationRevision++;
    }
    return credential;
  }
  credential(account: NativeAccount): NativeCodexCredentials {
    if (account.auth === null) throw new NativeAccountError("requires-login");
    return NativeCodexCredentials.parse(account.auth);
  }
  install(target: NativeCodexCredentials | null): Promise<void> {
    return this.#serialize(async () => {
      const file = path.join(this.home, "auth.json");
      if (target) await writePrivateFile(file, target.serializeForNativeStore());
      else await rm(file, { force: true });
      if ((await readOptionalFile(file)) !== (target?.serializeForNativeStore() ?? null))
        throw new NativeAccountError("credential-conflict");
      await this.readCredentials();
    });
  }
  async replaceSaved(
    accountId: string,
    expected: NativeCodexCredentials,
    target: NativeCodexCredentials,
  ): Promise<void> {
    await this.mutate(async (next) => {
      await this.readCredentials();
      const account = next.accounts.find((a) => a.accountId === accountId);
      if (
        this.currentAccountId === accountId ||
        !account ||
        account.auth !== expected.serializeForNativeStore() ||
        !sameCodexCredentialIdentity(account.identity, target.identity)
      )
        throw new NativeAccountError("credential-conflict");
      upsert(next, target);
    });
  }
  async close(): Promise<void> {
    await this.#mutations;
    this.#ready = false;
  }
}
