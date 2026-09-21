import type {
  CodexAccountAutoUpdateParams,
  CodexAccountDeleteParams,
  CodexAccountListResult,
  CodexAccountMutationResult,
  CodexAccountRankEntry,
  CodexAccountRankingResult,
  CodexAccountRankStrategy,
  CodexAccountSummary,
  CodexAccountSwitchParams,
} from "@codexhost/shared-contracts";

import { codexAccountDisplayName } from "../renderer-codex-account-options.js";
import { formatRendererCreditsPercent } from "../renderer-usage-control.js";
import { creditsPeriodLabel } from "./accounts-usage.js";
import { codexAccountErrorText } from "./codex-account-messages.js";
import type { RendererSettingsMessages } from "./localization.js";
import {
  createHelpTooltip,
  createPreferenceGroup,
  createPreferenceItem,
  createPreferenceSwitch,
  preferenceId,
} from "./preference-ui.js";

export interface RendererCodexAccountManageClient {
  saveCurrentCodexAccount?(): Promise<CodexAccountMutationResult>;
  switchCodexAccount?(input: CodexAccountSwitchParams): Promise<CodexAccountMutationResult>;
  deleteCodexAccount?(input: CodexAccountDeleteParams): Promise<CodexAccountMutationResult>;
  recoverCodexAccounts?(): Promise<CodexAccountMutationResult>;
  updateCodexAccountAuto?(input: CodexAccountAutoUpdateParams): Promise<CodexAccountMutationResult>;
  inspectCodexAccountRanking?(input?: { refresh?: boolean }): Promise<CodexAccountRankingResult>;
}

export type CodexAccountManageSnapshot = Pick<
  CodexAccountListResult,
  "accounts" | "currentAccountId" | "phase" | "capabilities" | "pendingOperation" | "auto"
>;

/** What one managed Codex row adds to the read-only row. Null on read-only deployments. */
export interface CodexAccountRowManagement {
  readonly flags: readonly { text: string; title?: string; tone: "muted" | "warning" }[];
  readonly rank: { text: string; title: string; recommended: boolean } | null;
  readonly actions: readonly HTMLButtonElement[];
}

const RANK_STRATEGIES: readonly CodexAccountRankStrategy[] = [
  "best",
  "consume-first",
  "waste-first",
];

export function codexAccountRankText(
  entry: CodexAccountRankEntry,
  messages: RendererSettingsMessages,
): string {
  // Unknown headroom stays unknown: never a fabricated 0% or 100%.
  if (entry.headroomPercent === undefined || !entry.bindingPeriod) {
    return entry.eligible ? "" : messages.codexAccounts.rankNotEligible;
  }
  return messages.codexAccounts.rankHeadroom
    .replace("{period}", creditsPeriodLabel(entry.bindingPeriod, messages))
    .replace("{percent}", formatRendererCreditsPercent(entry.headroomPercent));
}

export function mountCodexAccountManagement(input: {
  document: Document;
  dialogRoot: HTMLElement;
  messages: RendererSettingsMessages;
  signal: AbortSignal;
  getClient: () => RendererCodexAccountManageClient | null;
  snapshot: () => CodexAccountManageSnapshot;
  /** Host list results go through the page's snapshot version gate; nothing is applied early. */
  applyResult: (result: CodexAccountListResult, kind: "save" | "switch" | "other") => void;
  render: () => void;
}): {
  readonly guide: HTMLElement;
  readonly saveCurrent: HTMLButtonElement;
  readonly status: HTMLElement;
  readonly autoGroup: HTMLElement;
  busy(): boolean;
  update(): void;
  row(account: CodexAccountSummary): CodexAccountRowManagement | null;
  refreshRanking(refresh?: boolean): void;
} {
  const { document, messages, signal } = input;
  const text = messages.codexAccounts;
  let mutation: {
    kind: "save" | "switch" | "delete" | "recover" | "auto";
    accountId?: string;
  } | null = null;
  let notice: { tone: "info" | "error"; text: string } | null = null;
  let ranking: CodexAccountRankingResult | null = null;
  let rankingGeneration = 0;
  let confirmDialog: HTMLDialogElement | undefined;

  const manageable = (): boolean => input.snapshot().capabilities?.manage === true;
  const busy = (): boolean => {
    const state = input.snapshot();
    return mutation !== null || state.phase === "changing" || state.pendingOperation !== undefined;
  };

  const refreshRanking = (refresh = false): void => {
    const inspect = input.getClient()?.inspectCodexAccountRanking;
    const state = input.snapshot();
    if (!inspect || !manageable() || state.accounts.length < 2) {
      rankingGeneration += 1;
      ranking = null;
      return;
    }
    const generation = ++rankingGeneration;
    void Promise.resolve()
      .then(() => inspect(refresh ? { refresh: true } : {}))
      .then(
        (result) => {
          if (signal.aborted || generation !== rankingGeneration) return;
          ranking = result;
          input.render();
        },
        () => {
          // Ranking is explanatory only; the list stays usable without it.
          if (generation === rankingGeneration) ranking = null;
        },
      );
  };

  const run = (
    next: NonNullable<typeof mutation>,
    operation: () => Promise<CodexAccountListResult> | undefined,
    success: (result: CodexAccountListResult) => string | null,
  ): void => {
    if (busy()) return;
    mutation = next;
    notice = null;
    input.render();
    void Promise.resolve()
      .then(() => {
        const pending = operation();
        if (!pending) throw new Error("Codex Account management is unavailable");
        return pending;
      })
      .then(
        (result) => {
          if (signal.aborted) return;
          mutation = null;
          const message = success(result);
          notice = message ? { tone: "info", text: message } : null;
          input.applyResult(
            result,
            next.kind === "switch" ? "switch" : next.kind === "save" ? "save" : "other",
          );
          refreshRanking();
          input.render();
        },
        (error: unknown) => {
          if (signal.aborted) return;
          mutation = null;
          notice = { tone: "error", text: codexAccountErrorText(error, text) };
          input.render();
        },
      );
  };

  const nameOf = (accountId: string | null, result: CodexAccountListResult): string | null => {
    const account = result.accounts.find((candidate) => candidate.accountId === accountId);
    return account ? codexAccountDisplayName(account).full : null;
  };

  const switchAccount = (account: CodexAccountSummary): void =>
    run(
      { kind: "switch", accountId: account.accountId },
      () => input.getClient()?.switchCodexAccount?.({ accountId: account.accountId }),
      // The confirmation names whichever Account the Host verified, not the one that was asked for.
      (result) => {
        const name = result.phase === "ready" ? nameOf(result.currentAccountId, result) : null;
        return name ? text.switched.replace("{name}", name) : null;
      },
    );

  const confirmDelete = (account: CodexAccountSummary): void => {
    if (busy() || confirmDialog || signal.aborted) return;
    const name = codexAccountDisplayName(account).full;
    const modal = document.createElement("dialog");
    confirmDialog = modal;
    modal.className = "settings-account-dialog settings-credential-dialog";
    modal.setAttribute("aria-label", text.deleteLabel.replace("{name}", name));
    const title = document.createElement("h2");
    title.textContent = text.deleteAction;
    const body = document.createElement("div");
    body.className = "settings-credential-dialog__body";
    const warning = document.createElement("p");
    warning.textContent = text.deleteConfirm.replace("{name}", name);
    body.append(warning);
    const controls = document.createElement("div");
    controls.className = "settings-credential-dialog__actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "settings-command-button settings-command-button--secondary";
    cancel.textContent = messages.credentialImports.cancel;
    cancel.addEventListener("click", () => modal.close());
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className =
      "settings-command-button settings-command-button--secondary settings-command-button--danger";
    confirm.textContent = text.deleteAction;
    confirm.addEventListener("click", () => {
      modal.close();
      run(
        { kind: "delete", accountId: account.accountId },
        () => input.getClient()?.deleteCodexAccount?.({ accountId: account.accountId }),
        () => null,
      );
    });
    controls.append(cancel, confirm);
    modal.append(title, body, controls);
    modal.addEventListener("close", () => {
      modal.remove();
      confirmDialog = undefined;
    });
    input.dialogRoot.append(modal);
    modal.showModal();
    cancel.focus();
  };
  signal.addEventListener("abort", () => confirmDialog?.remove(), { once: true });

  // Header: save the current native login, plus the short "how to add an account" guide.
  const guide = document.createElement("div");
  guide.className = "mt-1 flex items-center gap-1.5 text-xs leading-[18px] text-settings-muted";
  const guideLabel = document.createElement("span");
  guideLabel.textContent = text.guideTitle;
  guide.append(guideLabel, createHelpTooltip(document, text.guideLabel, text.guideLines));
  const save = document.createElement("button");
  save.type = "button";
  save.className = "settings-command-button";
  save.dataset.codexAccountAction = "save-current";
  save.addEventListener("click", () =>
    run(
      { kind: "save" },
      () => input.getClient()?.saveCurrentCodexAccount?.(),
      () => text.saved,
    ),
  );

  const status = document.createElement("p");
  status.className = "settings-account-status";
  status.setAttribute("role", "status");

  // Auto: a Host-side policy that only ever changes the Codex Account.
  const auto = createPreferenceGroup(document, text.autoSection);
  // The shared group drops its top margin as the first section; keep it clear of the table.
  const autoGroup = document.createElement("div");
  autoGroup.className = "mt-7";
  autoGroup.dataset.codexAccountAuto = "";
  autoGroup.append(auto.group);
  const enabledId = preferenceId("codex-account-auto");
  const toggle = createPreferenceItem(document, {
    title: text.autoTitle,
    description: text.autoDescription,
    controlId: enabledId,
    help: { label: text.autoHelpLabel, lines: text.autoHelp },
  });
  const enabled = createPreferenceSwitch(document, enabledId, toggle.description.id);
  toggle.item.append(enabled);
  const strategyId = preferenceId("codex-account-strategy");
  const strategy = createPreferenceItem(document, {
    title: text.strategyTitle,
    description: text.strategies.best.description,
    controlId: strategyId,
  });
  const strategySelect = document.createElement("select");
  strategySelect.id = strategyId;
  strategySelect.setAttribute("aria-describedby", strategy.description.id);
  strategySelect.className =
    "h-8 shrink-0 rounded-md border border-settings-border bg-settings-surface px-2 text-[13px] leading-5 text-settings-text outline-none focus-visible:border-settings-focus disabled:cursor-not-allowed disabled:opacity-50";
  for (const value of RANK_STRATEGIES) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text.strategies[value].label;
    strategySelect.append(option);
  }
  strategy.item.append(strategySelect);
  auto.card.append(toggle.item, strategy.item);
  const updateAuto = (params: CodexAccountAutoUpdateParams): void =>
    run(
      { kind: "auto" },
      () => input.getClient()?.updateCodexAccountAuto?.(params),
      () => null,
    );
  enabled.addEventListener("change", () => {
    const next = enabled.checked;
    // The Host's answer decides the displayed value; a refused change snaps back on render.
    updateAuto({ enabled: next });
    input.render();
  });
  strategySelect.addEventListener("change", () => {
    const next = RANK_STRATEGIES.find((value) => value === strategySelect.value);
    if (next) updateAuto({ strategy: next });
    input.render();
  });

  const update = (): void => {
    const state = input.snapshot();
    const capabilities = state.capabilities;
    const current = state.accounts.find(({ accountId }) => accountId === state.currentAccountId);
    const isBusy = busy();

    guide.hidden = !manageable();
    save.hidden = !(capabilities?.saveCurrent === true && current && current.saved !== true);
    save.disabled = isBusy;
    save.textContent = mutation?.kind === "save" ? text.saving : text.saveCurrent;

    status.replaceChildren();
    const recoveryRequired = capabilities?.reason === "recovery-required";
    const lines: string[] = [];
    if (mutation?.kind === "switch") lines.push(text.switching);
    else if (mutation?.kind === "delete") lines.push(text.deleting);
    else if (mutation?.kind === "recover") lines.push(text.recovering);
    else if (state.phase === "changing" || state.pendingOperation) lines.push(text.changing);
    if (notice) lines.push(notice.text);
    if (recoveryRequired) lines.push(text.recoveryRequired);
    else if (capabilities?.reason === "unsupported-storage") lines.push(text.unsupportedStorage);
    status.dataset.tone = notice?.tone === "error" || recoveryRequired ? "error" : "info";
    if (lines.length) {
      const message = document.createElement("span");
      message.textContent = lines.join(" ");
      status.append(message);
    }
    if (capabilities?.recover === true) {
      const recover = document.createElement("button");
      recover.type = "button";
      recover.className = "settings-command-button settings-command-button--secondary";
      recover.dataset.codexAccountAction = "recover";
      recover.textContent = mutation?.kind === "recover" ? text.recovering : text.recover;
      recover.disabled = isBusy;
      recover.addEventListener("click", () =>
        run(
          { kind: "recover" },
          () => input.getClient()?.recoverCodexAccounts?.(),
          () => null,
        ),
      );
      status.append(recover);
    }

    autoGroup.hidden = !(manageable() && state.auto !== undefined);
    if (state.auto) {
      enabled.checked = state.auto.enabled;
      strategySelect.value = state.auto.strategy;
      strategy.description.textContent = text.strategies[state.auto.strategy].description;
      enabled.disabled = isBusy;
      strategySelect.disabled = isBusy;
    }
  };

  const row = (account: CodexAccountSummary): CodexAccountRowManagement | null => {
    const state = input.snapshot();
    const capabilities = state.capabilities;
    if (!capabilities?.manage) return null;
    const isCurrent = account.accountId === state.currentAccountId;
    const name = codexAccountDisplayName(account).full;
    const flags: CodexAccountRowManagement["flags"][number][] = [];
    if (account.requiresLogin) {
      flags.push({
        text: text.requiresLoginBadge,
        title: text.requiresLoginHint,
        tone: "warning",
      });
    } else if (isCurrent && account.saved !== true) {
      flags.push({ text: text.unsavedBadge, tone: "muted" });
    }
    const actions: HTMLButtonElement[] = [];
    const isBusy = busy();
    if (account.saved === true && !isCurrent) {
      if (capabilities.switch) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "settings-account-action";
        button.dataset.accountFocus = `${account.accountId}:switch`;
        button.textContent =
          mutation?.kind === "switch" && mutation.accountId === account.accountId
            ? text.switching
            : text.switchAction;
        button.setAttribute("aria-label", text.switchLabel.replace("{name}", name));
        button.disabled = isBusy || account.requiresLogin === true;
        if (account.requiresLogin) button.title = text.requiresLoginHint;
        button.addEventListener("click", () => switchAccount(account));
        actions.push(button);
      }
      if (capabilities.delete) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "settings-account-action settings-account-delete";
        button.dataset.accountFocus = `${account.accountId}:delete`;
        button.textContent = text.deleteAction;
        button.setAttribute("aria-label", text.deleteLabel.replace("{name}", name));
        button.disabled = isBusy;
        button.addEventListener("click", () => confirmDelete(account));
        actions.push(button);
      }
    }
    const entry = ranking?.entries.find((candidate) => candidate.accountId === account.accountId);
    const rankText = entry ? codexAccountRankText(entry, messages) : "";
    const recommended =
      state.auto !== undefined && ranking?.recommendedAccountId === account.accountId;
    const rankLabel = [recommended ? text.rankRecommended : "", rankText]
      .filter(Boolean)
      .join(" · ");
    return {
      flags,
      rank:
        entry && rankLabel
          ? { text: rankLabel, title: entry.reasons.join("\n"), recommended }
          : null,
      actions,
    };
  };

  return {
    guide,
    saveCurrent: save,
    status,
    autoGroup,
    busy,
    update,
    row,
    refreshRanking,
  };
}
