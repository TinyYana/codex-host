import type { CodexAccountListResult, CodexAccountSummary } from "@codexhost/shared-contracts";
import type { RendererModelClient } from "./renderer-model-client.js";

export function resolveCurrentCodexAccountId(
  accounts: readonly CodexAccountSummary[],
  currentAccountId: string | null,
): string | null {
  return accounts.some((account) => account.accountId === currentAccountId)
    ? currentAccountId
    : null;
}

/** A changed instanceId is a fresh Host epoch and may restart revision numbering. */
export function shouldApplyCodexAccountSnapshot(
  current: Pick<CodexAccountListResult, "instanceId" | "revision"> | null,
  next: Pick<CodexAccountListResult, "instanceId" | "revision">,
): boolean {
  if (!current) return true;
  if (next.instanceId !== undefined && next.instanceId !== current.instanceId) return true;
  if (current.instanceId !== undefined && next.instanceId === undefined) return false;
  return next.revision >= current.revision;
}

/** One Host-wide current Account snapshot; no Composer or draft override. */
export class RendererCodexAccountState {
  accounts: readonly CodexAccountSummary[] = [];
  currentAccountId: string | null = null;
  phase: CodexAccountListResult["phase"] = "unavailable";
  revision = 0;
  instanceId: string | undefined;
  /** Absent on read-only deployments: no management surface may be shown then. */
  capabilities: CodexAccountListResult["capabilities"];
  pendingOperation: CodexAccountListResult["pendingOperation"];
  auto: CodexAccountListResult["auto"];
  #hasSnapshot = false;
  #request: Promise<void> | null = null;
  readonly #unsubscribe: (() => void) | undefined;

  readonly #changed: () => void;

  constructor(
    readonly client: RendererModelClient,
    changed: () => void = () => undefined,
  ) {
    this.#changed = changed;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = client.subscribeCodexAccounts?.((state) => {
        this.apply(state);
      });
    } catch {
      // Hosts without Account notifications remain usable through refresh polling.
    }
    this.#unsubscribe = unsubscribe;
  }

  get readyAccountId(): string | null {
    return resolveCurrentCodexAccountId(
      this.accounts,
      this.phase === "ready" ? this.currentAccountId : null,
    );
  }

  refresh(): Promise<void> {
    if (this.#request) return this.#request;
    this.#request = Promise.resolve()
      .then(() => this.client.listCodexAccounts())
      .then((result) => {
        this.#apply(result);
      })
      .catch(() => {
        // Keep only this Host's last known data on transient failures. A Host
        // without the Account API starts empty and keeps the plain Codex option.
      })
      .finally(() => {
        this.#request = null;
      });
    return this.#request;
  }

  /** The Host is replacing the native credential: new Turns would be refused as busy. */
  get switching(): boolean {
    return this.phase === "changing";
  }

  /** True while the Host reports an Account change; identity and quota may be about to move. */
  get changing(): boolean {
    return this.phase === "changing" || this.pendingOperation !== undefined;
  }

  /**
   * A Host list answer (notification or manage result) through the snapshot version gate. The
   * displayed identity only ever comes from here, never from the Account a request asked for.
   */
  apply(result: CodexAccountListResult): boolean {
    if (!this.#apply(result)) return false;
    this.#changed();
    return true;
  }

  dispose(): void {
    this.#unsubscribe?.();
  }

  #apply(result: CodexAccountListResult): boolean {
    if (
      !shouldApplyCodexAccountSnapshot(
        this.#hasSnapshot ? { instanceId: this.instanceId, revision: this.revision } : null,
        result,
      )
    ) {
      return false;
    }
    this.#hasSnapshot = true;
    this.accounts = result.accounts;
    this.currentAccountId = result.currentAccountId;
    this.phase = result.phase;
    this.revision = result.revision;
    this.instanceId = result.instanceId;
    this.capabilities = result.capabilities;
    this.pendingOperation = result.pendingOperation;
    this.auto = result.auto;
    return true;
  }
}
