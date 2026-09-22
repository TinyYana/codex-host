import type {
  CodexAccountListResult,
  CodexAccountRankEntry,
  CodexAccountRankingResult,
  CodexAccountSummary,
  HostThreadId,
} from "@codexhost/shared-contracts";

import { codexAccountDisplayName } from "./renderer-codex-account-options.js";
import type { RendererCodexAccountState } from "./renderer-codex-account-state.js";
import type { CodexTurnFailure } from "./renderer-codex-turn-failure.js";
import { creditsPeriodLabel } from "./renderer-credits-control.js";
import { formatRendererCreditsPercent } from "./renderer-usage-control.js";
import {
  codexAccountErrorCode,
  codexAccountMessages,
  type CodexAccountErrorCode,
} from "./settings/codex-account-messages.js";
import type { RendererSettingsLocale } from "./settings/localization.js";

/**
 * Mirrors the Host ranker's default wall: binding headroom at or below this is exhausted.
 * Only a confirmed wall offers a retry; anything less certain offers a manual switch at most.
 */
const QUOTA_WALL_HEADROOM_PERCENT = 3;
const RANKING_MIN_INTERVAL_MS = 15_000;

export interface RendererCodexAccountSwitchRow {
  readonly accountId: string;
  readonly name: string;
  readonly detail: string | null;
  readonly title: string;
  readonly recommended: boolean;
  readonly disabledReason: string | null;
}

export interface RendererCodexAccountSwitchOffer {
  /** Changes whenever a new offer should be announced once. */
  readonly key: string;
  readonly tone: "warning" | "info";
  readonly message: string;
  readonly pillLabel: string | null;
  readonly action: { readonly label: string; run(): void } | null;
  readonly dismissLabel: string;
  dismiss(): void;
}

/** Everything the Composer credits popover needs; plain data plus explicit user actions. */
export interface RendererCodexAccountSwitchView {
  readonly title: string;
  readonly current: { readonly name: string; readonly detail: string | null } | null;
  readonly others: readonly RendererCodexAccountSwitchRow[];
  readonly emptyHint: string | null;
  readonly switchLabel: string;
  readonly canSwitch: boolean;
  readonly busy: boolean;
  readonly status: { readonly tone: "info" | "error"; readonly text: string } | null;
  readonly auto: { readonly label: string; readonly enabled: boolean; toggle(): void } | null;
  readonly offer: RendererCodexAccountSwitchOffer | null;
  switchTo(accountId: string): void;
  opened(): void;
}

interface QuotaWallOffer {
  readonly id: number;
  /** True only for a confirmed wall: a failed Turn plus an exhausted binding window. */
  readonly retry: boolean;
  readonly targetAccountId: string;
  readonly input: string | null;
  phase: "offered" | "switched";
  switchedName: string | null;
  restored: boolean;
}

type Notice =
  | { readonly kind: "error"; readonly code: CodexAccountErrorCode | null }
  | { readonly kind: "switched"; readonly name: string };

export interface RendererCodexAccountSwitchHooks {
  changed(): void;
  /**
   * Puts text back into the Composer of a Thread without sending it. Returns false when that
   * Composer is gone or already holds a draft. Sending always stays with the user.
   */
  restoreInput(threadId: HostThreadId, text: string): boolean;
  /** Lets the owner keep the open Thread across the Desktop remount a switch can cause. */
  runSwitch?<T>(operation: () => Promise<T>): Promise<T>;
  now?(): number;
}

/** Quota-wall classification; pure so the "never retry when uncertain" rule is testable. */
export function classifyCodexQuotaWall(
  failure: Pick<CodexTurnFailure, "usageLimit">,
  ranking: CodexAccountRankingResult,
  state: { currentAccountId: string | null; accounts: readonly CodexAccountSummary[] },
): { retry: boolean; targetAccountId: string } | null {
  const usable = new Set(
    state.accounts
      .filter((account) => account.saved === true && !account.requiresLogin)
      .map(({ accountId }) => accountId),
  );
  const alternatives = ranking.entries.filter(
    (entry) =>
      entry.eligible && entry.accountId !== state.currentAccountId && usable.has(entry.accountId),
  );
  const recommended = alternatives.find(
    ({ accountId }) => accountId === ranking.recommendedAccountId,
  );
  const target = recommended ?? alternatives[0];
  if (!target) return null;
  const current = ranking.entries.find(({ accountId }) => accountId === state.currentAccountId);
  const exhausted =
    current !== undefined &&
    !current.eligible &&
    current.headroomPercent !== undefined &&
    current.headroomPercent <= QUOTA_WALL_HEADROOM_PERCENT;
  if (exhausted) return { retry: true, targetAccountId: target.accountId };
  // A usage-limit hint without an exhausted window is uncertain: manual switch, never a retry.
  return failure.usageLimit ? { retry: false, targetAccountId: target.accountId } : null;
}

/** One per Host: manual Account switching and Switch & Retry next to the Composer. */
export class RendererCodexAccountSwitch {
  #operation: { accountId: string } | null = null;
  #autoUpdating = false;
  #notice: Notice | null = null;
  #ranking: CodexAccountRankingResult | null = null;
  #rankingRequest: Promise<void> | null = null;
  #rankingAt = Number.NEGATIVE_INFINITY;
  #offerSequence = 0;
  #disposed = false;
  readonly #offers = new Map<HostThreadId, QuotaWallOffer>();
  readonly #unsubscribe: (() => void) | undefined;

  constructor(
    readonly accounts: RendererCodexAccountState,
    readonly hooks: RendererCodexAccountSwitchHooks,
    turnFailure: (failure: CodexTurnFailure) => void,
  ) {
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = accounts.client.subscribeCodexTurnFailures?.(turnFailure);
    } catch {
      // Without Turn notifications only manual switching is offered.
    }
    this.#unsubscribe = unsubscribe;
  }

  dispose(): void {
    this.#disposed = true;
    this.#offers.clear();
    this.#unsubscribe?.();
  }

  get switching(): boolean {
    return this.#operation !== null;
  }

  /** A new user submission in a Thread supersedes any offer made for its previous failure. */
  noteSubmission(threadId: HostThreadId | null): void {
    if (threadId && this.#offers.delete(threadId)) this.hooks.changed();
  }

  /**
   * Called for a failed Turn of a Codex Thread. `input` is what the user submitted for it, if
   * known. Nothing here switches or sends: it can only put an offer in front of the user.
   */
  async considerTurnFailure(failure: CodexTurnFailure, input: string | null): Promise<void> {
    if (!this.accounts.capabilities?.switch || this.accounts.changing || this.switching) return;
    const inspect = this.accounts.client.inspectCodexAccountRanking;
    if (!inspect) return;
    const currentAccountId = this.accounts.readyAccountId;
    let ranking: CodexAccountRankingResult;
    try {
      ranking = await inspect({ refresh: true });
    } catch {
      return;
    }
    if (this.#disposed || this.accounts.readyAccountId !== currentAccountId) return;
    this.#ranking = ranking;
    this.#rankingAt = this.#now();
    const wall = classifyCodexQuotaWall(failure, ranking, {
      currentAccountId,
      accounts: this.accounts.accounts,
    });
    if (!wall) return;
    this.#offers.set(failure.threadId, {
      id: ++this.#offerSequence,
      retry: wall.retry,
      targetAccountId: wall.targetAccountId,
      input: wall.retry ? input : null,
      phase: "offered",
      switchedName: null,
      restored: false,
    });
    this.hooks.changed();
  }

  view(
    threadId: HostThreadId | null,
    locale: RendererSettingsLocale,
  ): RendererCodexAccountSwitchView | null {
    const capabilities = this.accounts.capabilities;
    if (!capabilities?.manage) return null;
    const text = codexAccountMessages(locale);
    const currentId = this.accounts.readyAccountId;
    const current = this.accounts.accounts.find(({ accountId }) => accountId === currentId);
    const busy = this.switching || this.#autoUpdating || this.accounts.changing;
    const detailFor = (entry: CodexAccountRankEntry | undefined): string | null =>
      entry?.bindingPeriod && entry.headroomPercent !== undefined
        ? text.rankHeadroom
            .replace("{period}", creditsPeriodLabel(entry.bindingPeriod, locale))
            .replace("{percent}", formatRendererCreditsPercent(entry.headroomPercent))
        : null;
    const entryFor = (accountId: string): CodexAccountRankEntry | undefined =>
      this.#ranking?.entries.find((entry) => entry.accountId === accountId);
    const others = this.accounts.accounts
      .filter((account) => account.saved === true && account.accountId !== currentId)
      .map((account): RendererCodexAccountSwitchRow => {
        const entry = entryFor(account.accountId);
        return {
          accountId: account.accountId,
          name: codexAccountDisplayName(account).full,
          detail: account.requiresLogin ? text.requiresLoginBadge : detailFor(entry),
          title: account.requiresLogin ? text.requiresLoginHint : (entry?.reasons.join("\n") ?? ""),
          recommended: this.#ranking?.recommendedAccountId === account.accountId,
          disabledReason: account.requiresLogin ? text.requiresLoginHint : null,
        };
      });
    const currentDetail = current ? detailFor(entryFor(current.accountId)) : null;
    const status: RendererCodexAccountSwitchView["status"] = this.switching
      ? { tone: "info", text: text.switching }
      : this.accounts.changing
        ? { tone: "info", text: text.changing }
        : this.#notice?.kind === "error"
          ? {
              tone: "error",
              text: this.#notice.code ? text.errors[this.#notice.code] : text.failed,
            }
          : this.#notice?.kind === "switched"
            ? { tone: "info", text: text.switched.replace("{name}", this.#notice.name) }
            : capabilities.reason === "recovery-required"
              ? { tone: "error", text: text.errors["recovery-required"] }
              : null;
    const autoMode = this.accounts.auto;
    return {
      title: text.composerTitle,
      current: current
        ? {
            name: codexAccountDisplayName(current).full,
            detail: currentDetail ? text.composerTightest.replace("{detail}", currentDetail) : null,
          }
        : null,
      others,
      emptyHint: others.length === 0 ? text.composerNoOthers : null,
      switchLabel: text.switchAction,
      canSwitch: capabilities.switch,
      busy,
      status,
      auto:
        autoMode && this.accounts.client.updateCodexAccountAuto
          ? {
              label: text.composerAuto,
              enabled: autoMode.enabled,
              toggle: () => void this.#toggleAuto(!autoMode.enabled),
            }
          : null,
      offer: threadId ? this.#offerView(threadId, text) : null,
      switchTo: (accountId) => void this.switchTo(accountId, null),
      opened: () => this.#refreshRanking(),
    };
  }

  /** Runs the Host switch. The shown identity changes only through the Host's verified list. */
  async switchTo(accountId: string, retryThreadId: HostThreadId | null): Promise<void> {
    const switchAccount = this.accounts.client.switchCodexAccount;
    const target = this.accounts.accounts.find((account) => account.accountId === accountId);
    if (
      !switchAccount ||
      !this.accounts.capabilities?.switch ||
      !target ||
      target.requiresLogin ||
      this.switching ||
      this.accounts.changing ||
      accountId === this.accounts.readyAccountId
    ) {
      return;
    }
    const send = (): Promise<CodexAccountListResult> => switchAccount({ accountId });
    this.#operation = { accountId };
    this.#notice = null;
    this.hooks.changed();
    try {
      const result = await (this.hooks.runSwitch ? this.hooks.runSwitch(send) : send());
      if (this.#disposed) return;
      this.#operation = null;
      this.accounts.apply(result);
      const verified = result.accounts.find(
        (account) => result.phase === "ready" && account.accountId === result.currentAccountId,
      );
      const name = verified ? codexAccountDisplayName(verified).full : null;
      this.#notice = name ? { kind: "switched", name } : null;
      this.#rankingAt = Number.NEGATIVE_INFINITY;
      const offer = retryThreadId ? this.#offers.get(retryThreadId) : undefined;
      if (retryThreadId && offer) {
        if (verified?.accountId === accountId) {
          offer.phase = "switched";
          offer.switchedName = name;
          this.#restore(retryThreadId, offer);
        } else {
          this.#offers.delete(retryThreadId);
        }
      }
    } catch (error) {
      if (this.#disposed) return;
      this.#operation = null;
      this.#notice = { kind: "error", code: codexAccountErrorCode(error) };
    }
    this.hooks.changed();
  }

  #now(): number {
    return this.hooks.now?.() ?? Date.now();
  }

  #restore(threadId: HostThreadId, offer: QuotaWallOffer): void {
    if (offer.restored || offer.input === null) return;
    // Only fills the input box. Sending stays a separate, explicit user action.
    offer.restored = this.hooks.restoreInput(threadId, offer.input);
  }

  #offerView(
    threadId: HostThreadId,
    text: ReturnType<typeof codexAccountMessages>,
  ): RendererCodexAccountSwitchOffer | null {
    const offer = this.#offers.get(threadId);
    if (!offer) return null;
    const dismiss = (): void => {
      if (this.#offers.delete(threadId)) this.hooks.changed();
    };
    if (offer.phase === "switched") {
      const name = offer.switchedName ?? "";
      if (offer.restored || offer.input === null) {
        return {
          key: `${offer.id}:done`,
          tone: "info",
          message: (offer.restored ? text.retryRestored : text.retryPending).replace(
            "{name}",
            name,
          ),
          pillLabel: null,
          action: null,
          dismissLabel: text.dismiss,
          dismiss,
        };
      }
      return {
        key: `${offer.id}:restore`,
        tone: "info",
        message: text.retryPending.replace("{name}", name),
        pillLabel: text.retryRestore,
        action: {
          label: text.retryRestore,
          run: () => {
            this.#restore(threadId, offer);
            this.hooks.changed();
          },
        },
        dismissLabel: text.dismiss,
        dismiss,
      };
    }
    const target = this.accounts.accounts.find(
      (account) => account.accountId === offer.targetAccountId,
    );
    if (!target || target.requiresLogin || target.accountId === this.accounts.readyAccountId) {
      return null;
    }
    const name = codexAccountDisplayName(target).full;
    return {
      key: `${offer.id}:offer`,
      tone: "warning",
      message: offer.retry ? text.quotaWall : text.quotaWallUncertain,
      pillLabel: text.switchAction,
      action: {
        // "Retry" is only promised when there is a message to hand back to the user.
        label: (offer.input !== null ? text.switchAndRetry : text.switchLabel).replace(
          "{name}",
          name,
        ),
        run: () => void this.switchTo(offer.targetAccountId, offer.retry ? threadId : null),
      },
      dismissLabel: text.dismiss,
      dismiss,
    };
  }

  #refreshRanking(): void {
    const inspect = this.accounts.client.inspectCodexAccountRanking;
    if (
      !inspect ||
      this.#rankingRequest ||
      !this.accounts.capabilities?.manage ||
      this.accounts.accounts.length < 2 ||
      this.#now() - this.#rankingAt < RANKING_MIN_INTERVAL_MS
    ) {
      return;
    }
    this.#rankingRequest = Promise.resolve()
      .then(() => inspect({}))
      .then(
        (ranking) => {
          if (this.#disposed) return;
          this.#ranking = ranking;
          this.#rankingAt = this.#now();
          this.hooks.changed();
        },
        () => undefined,
      )
      .finally(() => {
        this.#rankingRequest = null;
      });
  }

  async #toggleAuto(enabled: boolean): Promise<void> {
    const update = this.accounts.client.updateCodexAccountAuto;
    if (!update || this.#autoUpdating || this.switching || this.accounts.changing) return;
    this.#autoUpdating = true;
    this.#notice = null;
    this.hooks.changed();
    try {
      const result = await update({ enabled });
      if (this.#disposed) return;
      this.accounts.apply(result);
    } catch (error) {
      if (this.#disposed) return;
      this.#notice = { kind: "error", code: codexAccountErrorCode(error) };
    } finally {
      this.#autoUpdating = false;
    }
    this.hooks.changed();
  }
}
