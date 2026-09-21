import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";
import {
  codexAccountAutoModeSchema,
  type CodexAccountAutoMode,
  type CodexAccountAutoUpdateParams,
  type CodexAccountRankingResult,
  type CodexAccountUsageResult,
} from "@codexhost/shared-contracts";
import type { CodexAccountControl } from "./codex-account-control.js";
import { readOptionalFile, writePrivateFile } from "./native-account-store.js";
import { rankAccountCandidates, type QuotaCandidate } from "./quota-ranker.js";

const MODE_FILE = "auto-mode.json";
const MIN_EVALUATION_INTERVAL_MS = 60_000;

/**
 * Auto Account selection. It can only call the standard switch transaction, so by construction it
 * changes nothing but the Codex Account: Harness, Model, and reasoning profile are out of reach.
 */
export class CodexAccountAutoSwitch {
  #mode: CodexAccountAutoMode = { enabled: false, strategy: "best" };
  #evaluating = false;
  #lastEvaluationAtMs = 0;
  #lastSwitchAtMs: number | undefined;

  constructor(
    private readonly input: {
      directory: string;
      control: CodexAccountControl;
      /** Live quota of the current Account (official rate limits). Null when unknown. */
      currentUsage(accountId: string): Promise<CodexAccountUsageResult | null>;
      /** True only at a safe Turn boundary: no official or external work is active. */
      isIdle(): boolean;
      diagnosticOutput: Pick<Writable, "write">;
      now?(): number;
    },
  ) {}

  mode(): CodexAccountAutoMode {
    return { ...this.#mode };
  }

  async load(): Promise<void> {
    try {
      const text = await readOptionalFile(path.join(this.input.directory, MODE_FILE));
      if (text) this.#mode = codexAccountAutoModeSchema.parse(JSON.parse(text));
    } catch {
      /* An unreadable preference falls back to Manual. */
    }
  }

  async update(change: CodexAccountAutoUpdateParams): Promise<CodexAccountAutoMode> {
    this.#mode = codexAccountAutoModeSchema.parse({ ...this.#mode, ...change });
    await mkdir(this.input.directory, { recursive: true, mode: 0o700 });
    await writePrivateFile(path.join(this.input.directory, MODE_FILE), JSON.stringify(this.#mode));
    return this.mode();
  }

  async ranking(refresh = false): Promise<CodexAccountRankingResult> {
    const now = this.input.now?.() ?? Date.now();
    const snapshot = this.input.control.snapshot();
    const candidates: QuotaCandidate[] = await Promise.all(
      snapshot.accounts.map(async (account) => {
        const current = account.accountId === snapshot.currentAccountId;
        const usage = await (
          current
            ? this.input.currentUsage(account.accountId)
            : (this.input.control.inspectInactiveUsage?.(account.accountId, refresh) ??
              Promise.resolve(null))
        ).catch(() => this.input.control.cachedUsage?.(account.accountId) ?? null);
        return {
          id: account.accountId,
          current,
          credentialUsable: current || account.requiresLogin !== true,
          credits: usage?.accountCredits ?? null,
          observedAtMs: usage?.observedAt ? Date.parse(usage.observedAt) : null,
        };
      }),
    );
    const ranked = rankAccountCandidates(candidates, {
      strategy: this.#mode.strategy,
      nowMs: now,
      ...(this.#lastSwitchAtMs !== undefined ? { lastSwitchAtMs: this.#lastSwitchAtMs } : {}),
    });
    return {
      strategy: ranked.strategy,
      recommendedAccountId: ranked.recommendedId,
      entries: ranked.entries.map((entry) => ({
        accountId: entry.id,
        eligible: entry.eligible,
        ...(entry.binding ? { bindingPeriod: entry.binding.period } : {}),
        ...(entry.headroomPercent !== undefined ? { headroomPercent: entry.headroomPercent } : {}),
        ...(entry.resetDeadlineMs !== undefined
          ? { resetsAt: new Date(entry.resetDeadlineMs).toISOString() }
          : {}),
        reasons: entry.reasons,
      })),
    };
  }

  /** Call whenever active work may have drained. Never switches while a Turn is active. */
  async evaluate(): Promise<void> {
    const now = this.input.now?.() ?? Date.now();
    if (
      !this.#mode.enabled ||
      this.#evaluating ||
      now - this.#lastEvaluationAtMs < MIN_EVALUATION_INTERVAL_MS ||
      !this.input.isIdle() ||
      !this.input.control.switch ||
      this.input.control.snapshot().capabilities?.switch !== true
    )
      return;
    this.#evaluating = true;
    this.#lastEvaluationAtMs = now;
    try {
      const { recommendedAccountId } = await this.ranking();
      const current = this.input.control.currentAccountId();
      // Quota reads are asynchronous: a Turn may have started meanwhile.
      if (!recommendedAccountId || recommendedAccountId === current || !this.input.isIdle()) return;
      await this.input.control.switch(recommendedAccountId);
      this.#lastSwitchAtMs = this.input.now?.() ?? Date.now();
      this.input.diagnosticOutput.write("codexhost: auto-switched Codex Account\n");
    } catch {
      // Busy, unsafe, or failed switches keep the verified current Account; retry next boundary.
      this.input.diagnosticOutput.write("codexhost: auto Codex Account switch skipped\n");
    } finally {
      this.#evaluating = false;
    }
  }

  /** Manual switches also start the cooldown so Auto does not immediately undo them. */
  noteManualSwitch(): void {
    this.#lastSwitchAtMs = this.input.now?.() ?? Date.now();
  }
}
