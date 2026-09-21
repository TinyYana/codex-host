import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import {
  NativeAccountDiagnostics,
  type AccountDiagnosticStep,
} from "./native-account-diagnostics.js";
import type {
  AccountCreditsSnapshot,
  CodexAccountListResult,
  CodexAccountSummary,
  CodexAccountUsageResult,
} from "@codexhost/shared-contracts";
import {
  OfficialAdmissionError,
  type OfficialChangeLease,
} from "../codex-runtime/official-work-gate.js";
import type { CodexAccountControl } from "./codex-account-control.js";
import type { NativeAccountRuntime } from "./native-account-runtime.js";
import {
  NativeAccountError,
  type NativeAccountStore,
  type NativeAccountVault,
} from "./native-account-store.js";
import { NativeAccountQuotas } from "./native-account-quotas.js";
import {
  sameCodexCredentialIdentity,
  type NativeCodexCredentials,
} from "./native-codex-credentials.js";
type Operation = NonNullable<CodexAccountListResult["pendingOperation"]>;
/** Collection and credential replacement; native Codex remains the authentication authority. */
export class NativeCodexAccounts implements CodexAccountControl {
  readonly #store: NativeAccountStore;
  readonly #runtime: NativeAccountRuntime;
  readonly #quotas: NativeAccountQuotas;
  readonly #diagnostics: NativeAccountDiagnostics;
  readonly #instanceId = randomUUID();
  readonly #readOfficialIdentity: (() => Promise<CodexAccountSummary | null>) | undefined;
  /** Official `account/read` identity; displays a native login that is not saved. */
  #isIdle: (() => boolean) | undefined;
  #official: CodexAccountSummary | null = null;
  #officialRevision = 0;
  #vault: NativeAccountVault = { version: 3, revision: 0, accounts: [] };
  /** undefined: management dormant (no vault, nothing attempted); false: unsupported storage. */
  #available: boolean | undefined;
  #initializing: Promise<void> | undefined;
  #pending: Operation | undefined;
  constructor(input: {
    store: NativeAccountStore;
    runtime: NativeAccountRuntime;
    fetch?: typeof fetch;
    diagnosticOutput?: Pick<Writable, "write">;
    readOfficialIdentity?(): Promise<CodexAccountSummary | null>;
  }) {
    this.#readOfficialIdentity = input.readOfficialIdentity;
    this.#store = input.store;
    this.#runtime = input.runtime;
    this.#diagnostics = new NativeAccountDiagnostics(
      input.store.directory,
      input.diagnosticOutput ?? process.stderr,
    );
    this.#quotas = new NativeAccountQuotas({
      directory: input.store.directory,
      credentials: input.store,
      ...(input.fetch ? { fetch: input.fetch } : {}),
      admitCredentialRefresh: (accountId) => {
        const release = this.#runtime.gate.admit("credential-write");
        if (accountId === this.currentAccountId()) {
          release();
          throw new NativeAccountError("credential-conflict");
        }
        return release;
      },
    });
  }
  snapshot(): CodexAccountListResult {
    if (this.#store.ready) this.#vault = this.#store.vault;
    const phase = this.#runtime.gate.phase,
      manage = this.#available !== false;
    const idle = manage && !this.#pending && phase === "ready";
    const pendingOperation = this.#pending;
    return {
      version: 2,
      instanceId: this.#instanceId,
      currentAccountId: this.currentAccountId(),
      phase,
      revision:
        this.#runtime.gate.revision +
        this.#vault.revision +
        this.#store.observationRevision +
        this.#officialRevision,
      ...(pendingOperation ? { pendingOperation } : {}),
      capabilities: {
        manage,
        switch: idle && this.#available === true,
        saveCurrent: idle,
        delete: idle && this.#available === true,
        recover: !this.#pending && phase === "unavailable",
        ...(!manage
          ? { reason: "unsupported-storage" as const }
          : phase === "unavailable"
            ? { reason: "recovery-required" as const }
            : {}),
      },
      accounts: [
        ...(this.#store.currentAccountId === null && this.#official ? [this.#official] : []),
        ...this.#vault.accounts.map(({ accountId, label, email, planType, auth }) => ({
          accountId,
          label,
          ...(email ? { email } : {}),
          ...(planType ? { planType } : {}),
          saved: true,
          ...(auth === null || !this.#quotas.credentialUsable(accountId)
            ? { requiresLogin: true }
            : {}),
        })),
      ],
    };
  }
  /** A saved Account matched by native credentials, else the unsaved official identity. */
  currentAccountId(): string | null {
    return this.#store.currentAccountId ?? this.#official?.accountId ?? null;
  }
  async #observeOfficialIdentity(): Promise<void> {
    if (!this.#readOfficialIdentity) return;
    const official = await this.#readOfficialIdentity();
    if (JSON.stringify(official) !== JSON.stringify(this.#official)) this.#officialRevision++;
    this.#official = official;
  }
  initialize(): Promise<void> {
    return (this.#initializing ??= (async () => {
      this.#available = false;
      await this.#store.open();
      await this.#runtime.checkCredentialStorage();
      await this.#store.captureCurrent("update-saved");
      this.#available = true;
      await this.#quotas
        .initialize(new Set(this.#store.vault.accounts.map((a) => a.accountId)))
        .catch(() => undefined);
    })().finally(() => {
      this.#initializing = undefined;
    }));
  }
  async refresh(): Promise<CodexAccountListResult> {
    await this.#initializing?.catch(() => undefined);
    if (this.#available === true) {
      if (!this.#pending && this.#runtime.gate.phase === "ready")
        await this.#store.captureCurrent("update-saved");
    } else if (this.#available === false || (await this.#store.hasVault().catch(() => false)))
      await this.initialize().catch(() => undefined);
    // Like the read-only projection, a failed identity read rejects but keeps the last snapshot.
    if (!this.#pending) await this.#observeOfficialIdentity();
    return this.snapshot();
  }
  async #requireManagement(): Promise<void> {
    await this.#initializing?.catch(() => undefined);
    if (this.#pending) throw new OfficialAdmissionError("changing");
    if (this.#available !== true) await this.initialize().catch(() => undefined);
    if (this.#available !== true) throw new NativeAccountError("unsupported-storage");
  }
  #begin(kind: Operation["kind"], recovery = false, collection = false): OfficialChangeLease {
    if (this.#pending) throw new OfficialAdmissionError("changing");
    this.#pending = { operationId: randomUUID(), kind };
    try {
      return recovery
        ? this.#runtime.gate.beginChange(true)
        : collection
          ? this.#runtime.gate.beginCollectionChange()
          : this.#runtime.gate.beginStoppingChange();
    } catch (error) {
      this.#pending = undefined;
      throw error;
    }
  }
  #finish(change: OfficialChangeLease, ready: boolean): boolean {
    this.#pending = undefined;
    try {
      if (ready && this.#runtime.gate.phase === "unavailable") {
        change.finish("unavailable");
        this.#runtime.gate.beginChange(true).finish("ready");
      } else change.finish(ready ? "ready" : "unavailable");
    } catch {
      change.finish("unavailable");
      this.#runtime.gate.unavailable();
    }
    return this.#runtime.gate.phase === "ready";
  }
  bindIdleProbe(isIdle: () => boolean): void {
    this.#isIdle = isIdle;
  }
  async switch(accountId: string): Promise<void> {
    const kind = "switch";
    const step = <T>(name: AccountDiagnosticStep, action: () => T | Promise<T>) =>
      this.#diagnostics.step(kind, name, action);
    await step("storage-check", () => this.#requireManagement());
    const change = await step("assert-idle", () => this.#begin(kind));
    // New work is already refused; a Turn that is still running must never be stopped.
    if (this.#isIdle && !this.#isIdle()) {
      this.#finish(change, true);
      throw new OfficialAdmissionError("busy");
    }
    let source: NativeCodexCredentials | null = null,
      stopping = false,
      stopped = false,
      installed = false;
    try {
      source = await step("capture", () => this.#store.captureCurrent());
      const account = await step("install", () => {
        const found = this.#store.vault.accounts.find((a) => a.accountId === accountId);
        if (found === undefined) throw new NativeAccountError("unknown-account");
        return found;
      });
      if (source && sameCodexCredentialIdentity(source.identity, account.identity)) {
        this.#finish(change, true);
        return;
      }
      const target = await step("install", () => this.#store.credential(account));
      await step("storage-check", () => this.#runtime.checkCredentialStorage());
      // Refuse before anything is stopped: an unrelated Codex process is never terminated.
      await step("external-check", () => this.#runtime.assertNoExternalProcesses());
      stopping = true;
      await step("stop", () => this.#runtime.stop());
      stopped = true;
      await step("assert-idle", () => change.assertIdle());
      source = await step("capture", () => this.#store.captureCurrent());
      installed = true;
      await step("install", () => this.#store.install(target));
      await step("start", () => this.#runtime.start());
      await step("verify-read", () => this.#runtime.verify(target.identity));
      await step("capture", () => this.#store.captureCurrent()).catch(() => undefined);
      await step("assert-idle", () => {
        if (!this.#finish(change, true)) throw new NativeAccountError("switch-failed");
      });
    } catch (error) {
      let ready = !stopping && this.#runtime.gate.phase !== "unavailable";
      if (stopped) {
        try {
          if (installed) {
            await step("rollback-stop", () => this.#runtime.stop());
            await step("rollback-capture", () => this.#store.captureCurrent()).catch(
              () => undefined,
            );
            await step("rollback-install", () => this.#store.install(source));
          } else {
            // No Host write occurred: preserve any grant rotated during backend exit.
            source = await step("rollback-capture", () => this.#store.readCredentials());
          }
          await step("rollback-start", () => this.#runtime.start());
          await step("rollback-verify-read", () => this.#runtime.verify(source?.identity ?? null));
          ready = true;
        } catch {
          ready = false;
        }
      }
      this.#finish(change, ready);
      if (error instanceof NativeAccountError || error instanceof OfficialAdmissionError)
        throw error;
      throw new NativeAccountError("switch-failed");
    }
  }
  async recover(): Promise<void> {
    await this.#initializing?.catch(() => undefined);
    const step = <T>(name: AccountDiagnosticStep, action: () => T | Promise<T>) =>
      this.#diagnostics.step("recover", name, action);
    const change = await step("assert-idle", () => this.#begin("recovery", true));
    try {
      await step("stop", () => this.#runtime.stop());
      await step("start", () => this.#runtime.start());
      const current = await step("capture", () => this.#store.readCredentials());
      await step("verify-read", () => this.#runtime.verify(current?.identity ?? null));
      if (this.#store.ready) await step("capture", () => this.#store.captureCurrent());
      await step("assert-idle", () => {
        if (!this.#finish(change, true)) throw new Error();
      });
    } catch {
      this.#finish(change, false);
      throw new NativeAccountError("recovery-required");
    }
    if (!this.#available)
      await step("storage-check", () => this.initialize()).catch(() => undefined);
  }
  /** Explicit save of the current native login; the only way a new identity enters the vault. */
  async saveCurrent(): Promise<string> {
    await this.#requireManagement();
    const change = this.#begin("save", false, true);
    try {
      await this.#runtime.checkCredentialStorage();
      if (!(await this.#store.captureCurrent("save-new")))
        throw new NativeAccountError("requires-login");
      const accountId = this.#store.currentAccountId;
      if (!accountId) throw new NativeAccountError("credential-conflict");
      return accountId;
    } finally {
      this.#finish(change, this.#runtime.gate.phase !== "unavailable");
    }
  }
  async remove(accountId: string): Promise<void> {
    await this.#requireManagement();
    const change = this.#begin("switch", false, true);
    try {
      await this.#store.readCredentials();
      await this.#store.mutate((next) => {
        if (this.#store.currentAccountId === accountId)
          throw new NativeAccountError("credential-conflict");
        if (!next.accounts.some((a) => a.accountId === accountId))
          throw new NativeAccountError("unknown-account");
        next.accounts = next.accounts.filter((a) => a.accountId !== accountId);
      });
      await this.#quotas.remove(accountId);
    } finally {
      this.#finish(change, this.#runtime.gate.phase !== "unavailable");
    }
  }
  async inspectInactiveUsage(accountId: string, refresh = false): Promise<CodexAccountUsageResult> {
    await this.refresh();
    const account = this.#store.vault.accounts.find((a) => a.accountId === accountId);
    if (!account || this.currentAccountId() === accountId)
      throw new NativeAccountError("unknown-account");
    return this.#quotas.inspect(account, refresh);
  }
  async recordUsage(
    accountId: string,
    credits: AccountCreditsSnapshot,
  ): Promise<CodexAccountUsageResult> {
    await this.#initializing?.catch(() => undefined);
    // The persisted quota cache is keyed by saved Accounts; an unsaved login has no entry.
    if (!this.#store.ready || !this.#store.vault.accounts.some((a) => a.accountId === accountId))
      return {
        accountId,
        usage: null,
        accountCredits: credits,
        freshness: "live",
        observedAt: new Date().toISOString(),
      };
    return this.#quotas.record(accountId, credits);
  }
  credentialUsable(accountId: string): boolean {
    const account = this.#store.ready
      ? this.#store.vault.accounts.find((a) => a.accountId === accountId)
      : undefined;
    return !!account && account.auth !== null && this.#quotas.credentialUsable(accountId);
  }
  cachedUsage(accountId: string): CodexAccountUsageResult | null {
    return this.#quotas.get(accountId);
  }
  async close(): Promise<void> {
    await this.#initializing?.catch(() => undefined);
    await this.#store.close();
  }
}
