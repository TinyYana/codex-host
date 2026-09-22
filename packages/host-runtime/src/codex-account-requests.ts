import {
  codexAccountAutoUpdateParamsSchema,
  codexAccountDeleteParamsSchema,
  codexAccountListResultSchema,
  codexAccountRankingResultSchema,
  codexAccountSwitchParamsSchema,
  codexAccountUsageParamsSchema,
  codexAccountUsageResultSchema,
  jsonValueSchema,
  type CodexAccountListResult,
  type CodexAccountUsageResult,
  type JsonValue,
} from "@codexhost/shared-contracts";
import { z } from "zod";
import type { CodexAccountAutoSwitch } from "./account/account-auto-switch.js";
import type { CodexAccountControl } from "./account/codex-account-control.js";

const ACCOUNT_ERROR_CODES = new Set([
  "busy",
  "changing",
  "unavailable",
  "unknown-account",
  "requires-login",
  "unsupported-storage",
  "credential-conflict",
  "authentication-failed",
  "switch-failed",
  "unsafe-external-process",
  "recovery-required",
]);

/** Fixed text plus a closed category. Native, SDK, and filesystem errors never pass through. */
export function codexAccountRpcError(error: unknown): {
  code: number;
  message: string;
  data?: { code: string };
} {
  const category =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (typeof category === "string" && ACCOUNT_ERROR_CODES.has(category))
    return {
      code: -32086,
      message:
        category === "unknown-account" ? "Unknown Codex Account" : "Codex Account operation failed",
      data: { code: category },
    };
  return { code: -32086, message: "Codex Account operation failed" };
}

/** Only these methods are Host-owned; any other `codexhost/account/*` keeps the unowned path. */
export const CODEX_ACCOUNT_METHODS: ReadonlySet<string> = new Set([
  "codexhost/account/list",
  "codexhost/account/refresh",
  "codexhost/account/usage/inspect",
  "codexhost/account/save-current",
  "codexhost/account/switch",
  "codexhost/account/delete",
  "codexhost/account/recover",
  "codexhost/account/auto/update",
  "codexhost/account/ranking/inspect",
]);

function unknownAccount(): Error {
  return Object.assign(new Error("Unknown Codex Account"), { code: "unknown-account" });
}

const rankingParamsSchema = z.object({ refresh: z.boolean().optional() }).strict();

/** `codexhost/account/*` request semantics, kept out of the Desktop request router. */
export class CodexAccountRequests {
  constructor(
    private readonly input: {
      control: CodexAccountControl;
      auto?: CodexAccountAutoSwitch | undefined;
      /** Official rate limits of the current Account. */
      currentUsage(accountId: string, refresh: boolean): Promise<CodexAccountUsageResult>;
    },
  ) {}

  async list(): Promise<CodexAccountListResult> {
    const snapshot = (await this.input.control.refresh?.()) ?? this.input.control.snapshot();
    return this.#withAuto(snapshot);
  }

  /** Snapshot for change notifications; never triggers a native read. */
  snapshot(): CodexAccountListResult {
    return this.#withAuto(this.input.control.snapshot());
  }

  #withAuto(snapshot: CodexAccountListResult): CodexAccountListResult {
    return codexAccountListResultSchema.parse(
      this.input.auto && snapshot.capabilities
        ? { ...snapshot, auto: this.input.auto.mode() }
        : snapshot,
    );
  }

  async handle(method: string, params: unknown): Promise<JsonValue> {
    const { control, auto } = this.input;
    switch (method) {
      case "codexhost/account/list":
      case "codexhost/account/refresh":
        return jsonValueSchema.parse(await this.list());
      case "codexhost/account/usage/inspect": {
        const { accountId, refresh } = codexAccountUsageParamsSchema.parse(params);
        const usage =
          accountId === control.currentAccountId()
            ? await this.#currentUsage(accountId, refresh === true)
            : await this.#savedUsage(accountId, refresh === true);
        return jsonValueSchema.parse(codexAccountUsageResultSchema.parse(usage));
      }
      case "codexhost/account/save-current":
        if (!control.saveCurrent) throw unknownAccount();
        await control.saveCurrent();
        return jsonValueSchema.parse(await this.list());
      case "codexhost/account/switch": {
        const { accountId } = codexAccountSwitchParamsSchema.parse(params);
        if (!control.switch) throw unknownAccount();
        await control.switch(accountId);
        auto?.noteManualSwitch();
        return jsonValueSchema.parse(await this.list());
      }
      case "codexhost/account/delete": {
        const { accountId } = codexAccountDeleteParamsSchema.parse(params);
        if (!control.remove) throw unknownAccount();
        await control.remove(accountId);
        return jsonValueSchema.parse(await this.list());
      }
      case "codexhost/account/recover":
        if (!control.recover) throw unknownAccount();
        await control.recover();
        return jsonValueSchema.parse(await this.list());
      case "codexhost/account/auto/update":
        if (!auto || !control.switch) throw unknownAccount();
        await auto.update(codexAccountAutoUpdateParamsSchema.parse(params));
        return jsonValueSchema.parse(await this.list());
      case "codexhost/account/ranking/inspect": {
        if (!auto) throw unknownAccount();
        const { refresh } = rankingParamsSchema.parse(params ?? {});
        return jsonValueSchema.parse(
          codexAccountRankingResultSchema.parse(await auto.ranking(refresh === true)),
        );
      }
      default:
        throw unknownAccount();
    }
  }

  async #currentUsage(accountId: string, refresh: boolean): Promise<CodexAccountUsageResult> {
    const usage = await this.input.currentUsage(accountId, refresh);
    // Keep a last-known quota for this Account once the user switches away from it.
    if (usage.accountCredits && usage.freshness === "live")
      void this.input.control.recordUsage?.(accountId, usage.accountCredits).catch(() => undefined);
    return usage;
  }

  async #savedUsage(accountId: string, refresh: boolean): Promise<CodexAccountUsageResult> {
    const { control } = this.input;
    if (!control.inspectInactiveUsage) throw unknownAccount();
    try {
      return await control.inspectInactiveUsage(accountId, refresh);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error) {
        if (error.code === "unknown-account") throw unknownAccount();
      }
      // Unknown stays unknown: no fabricated percentages, only an explicit empty observation.
      return { accountId, usage: null, freshness: "cached", observedAt: null };
    }
  }
}
