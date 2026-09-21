import {
  hostThreadIdSchema,
  type CodexAccountListResult,
  type CodexAccountRankingResult,
} from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import { RendererCodexAccountState } from "../src/renderer-codex-account-state.js";
import {
  classifyCodexQuotaWall,
  RendererCodexAccountSwitch,
} from "../src/renderer-codex-account-switch.js";
import type { CodexTurnFailure } from "../src/renderer-codex-turn-failure.js";
import type { RendererModelClient } from "../src/renderer-model-client.js";

const threadId = hostThreadIdSchema.parse("thread-1");
const work = { accountId: "work", label: "Work", email: "work@example.com", saved: true };
const home = { accountId: "home", label: "Home", email: "home@example.com", saved: true };
const capabilities = { manage: true, saveCurrent: true, switch: true, delete: true };

const list = (
  currentAccountId: string,
  revision: number,
  extra: Partial<CodexAccountListResult> = {},
): CodexAccountListResult => ({
  version: 2,
  currentAccountId,
  phase: "ready",
  revision,
  instanceId: "host-a",
  capabilities,
  accounts: [work, home],
  ...extra,
});

const ranking = (input: {
  workHeadroom?: number;
  workEligible?: boolean;
  homeEligible?: boolean;
}): CodexAccountRankingResult => ({
  strategy: "best",
  recommendedAccountId: input.homeEligible === false ? null : "home",
  entries: [
    {
      accountId: "home",
      eligible: input.homeEligible ?? true,
      bindingPeriod: "seven_day",
      headroomPercent: 80,
      reasons: ["80% headroom on the binding seven_day window"],
    },
    {
      accountId: "work",
      eligible: input.workEligible ?? false,
      bindingPeriod: "five_hour",
      ...(input.workHeadroom === undefined ? {} : { headroomPercent: input.workHeadroom }),
      reasons: ["five_hour window has 0% headroom left"],
    },
  ],
});

async function fixture(
  client: Partial<RendererModelClient>,
  initial: CodexAccountListResult = list("work", 1),
) {
  let failureListener: ((failure: CodexTurnFailure) => void) | undefined;
  const fullClient = {
    listCodexAccounts: vi.fn(async () => initial),
    subscribeCodexTurnFailures: (listener: (failure: CodexTurnFailure) => void) => {
      failureListener = listener;
      return () => undefined;
    },
    ...client,
  } as unknown as RendererModelClient;
  const accounts = new RendererCodexAccountState(fullClient);
  await accounts.refresh();
  const changed = vi.fn();
  const restoreInput = vi.fn(() => true);
  const onFailure = vi.fn();
  const control = new RendererCodexAccountSwitch(accounts, { changed, restoreInput }, onFailure);
  return { accounts, control, changed, restoreInput, onFailure, fail: () => failureListener };
}

describe("Quota-wall classification", () => {
  const state = { currentAccountId: "work", accounts: [work, home] };

  it("offers a retry only for a failed Turn on an exhausted binding window", () => {
    expect(
      classifyCodexQuotaWall({ usageLimit: false }, ranking({ workHeadroom: 0 }), state),
    ).toEqual({ retry: true, targetAccountId: "home" });
  });

  it("offers a manual switch, never a retry, when only the error hints at a usage limit", () => {
    expect(
      classifyCodexQuotaWall({ usageLimit: true }, ranking({ workHeadroom: 40 }), state),
    ).toEqual({ retry: false, targetAccountId: "home" });
    // Unknown headroom is not an exhausted window.
    expect(classifyCodexQuotaWall({ usageLimit: true }, ranking({}), state)).toEqual({
      retry: false,
      targetAccountId: "home",
    });
  });

  it("offers nothing without a wall signal or without a usable alternative", () => {
    expect(
      classifyCodexQuotaWall({ usageLimit: false }, ranking({ workHeadroom: 40 }), state),
    ).toBeNull();
    expect(
      classifyCodexQuotaWall(
        { usageLimit: true },
        ranking({ workHeadroom: 0, homeEligible: false }),
        state,
      ),
    ).toBeNull();
    expect(
      classifyCodexQuotaWall({ usageLimit: true }, ranking({ workHeadroom: 0 }), {
        currentAccountId: "work",
        accounts: [work, { ...home, requiresLogin: true }],
      }),
    ).toBeNull();
  });
});

describe("Composer Codex Account switching", () => {
  it("shows no management surface on a read-only deployment", async () => {
    const { control } = await fixture(
      { switchCodexAccount: vi.fn() },
      { ...list("work", 1), capabilities: undefined },
    );
    expect(control.view(threadId, "en")).toBeNull();
  });

  it("lists the current identity and other saved Accounts, gating sign-in problems", async () => {
    const { control } = await fixture(
      { switchCodexAccount: vi.fn() },
      list("work", 1, {
        accounts: [work, { ...home, requiresLogin: true }, { accountId: "new", label: "Unsaved" }],
      }),
    );
    const view = control.view(null, "zh-CN");
    expect(view?.current?.name).toBe("work@example.com");
    expect(view?.others.map(({ accountId }) => accountId)).toEqual(["home"]);
    expect(view?.others[0]?.disabledReason).toContain("重新登入");
    expect(view?.canSwitch).toBe(true);
    expect(view?.offer).toBeNull();
  });

  it("keeps the shown identity until the Host answers with a verified list", async () => {
    const switched = Promise.withResolvers<CodexAccountListResult>();
    const switchCodexAccount = vi.fn(() => switched.promise);
    const { accounts, control } = await fixture({ switchCodexAccount });
    control.view(null, "en")?.switchTo("home");
    await Promise.resolve();
    expect(switchCodexAccount).toHaveBeenCalledExactlyOnceWith({ accountId: "home" });
    expect(accounts.readyAccountId).toBe("work");
    const pending = control.view(null, "en");
    expect(pending?.busy).toBe(true);
    expect(pending?.current?.name).toBe("work@example.com");
    expect(pending?.status?.text).toBe("Switching account…");
    // A second request while one is in flight is ignored.
    pending?.switchTo("home");
    expect(switchCodexAccount).toHaveBeenCalledOnce();

    switched.resolve(list("home", 2));
    await vi.waitFor(() => expect(accounts.readyAccountId).toBe("home"));
    const done = control.view(null, "en");
    expect(done?.busy).toBe(false);
    expect(done?.status?.text).toBe("Switched to home@example.com.");
  });

  it("explains a busy refusal with fixed text and never shows the raw error", async () => {
    const switchCodexAccount = vi.fn(async () => {
      throw Object.assign(new Error("native: /Users/someone/.codex/auth.json"), {
        code: -32086,
        data: { code: "busy" },
      });
    });
    const { accounts, control } = await fixture({ switchCodexAccount });
    await control.switchTo("home", null);
    expect(accounts.readyAccountId).toBe("work");
    const status = control.view(null, "zh-CN")?.status;
    expect(status).toEqual({ tone: "error", text: "有 Turn 正在進行。請等它結束後再試。" });

    switchCodexAccount.mockRejectedValueOnce(new Error("socket hang up at auth.json"));
    await control.switchTo("home", null);
    expect(control.view(null, "en")?.status?.text).toBe(
      "The account operation could not be completed.",
    );
  });

  it("disables switching while the Host reports an Account change", async () => {
    const switchCodexAccount = vi.fn();
    const { control } = await fixture(
      { switchCodexAccount },
      list("work", 1, {
        phase: "changing",
        pendingOperation: { operationId: "op-1", kind: "switch" },
      }),
    );
    const view = control.view(null, "en");
    expect(view?.busy).toBe(true);
    expect(view?.status?.text).toBe("An account change is in progress…");
    await control.switchTo("home", null);
    expect(switchCodexAccount).not.toHaveBeenCalled();
  });

  it("Switch & Retry switches first and only hands the message back; it never sends", async () => {
    const switchCodexAccount = vi.fn(async () => list("home", 2));
    const inspectCodexAccountRanking = vi.fn(async () => ranking({ workHeadroom: 0 }));
    const { control, restoreInput } = await fixture({
      switchCodexAccount,
      inspectCodexAccountRanking,
    });
    await control.considerTurnFailure({ threadId, usageLimit: false }, "fix the build");
    expect(inspectCodexAccountRanking).toHaveBeenCalledWith({ refresh: true });
    // An offer alone changes nothing.
    expect(switchCodexAccount).not.toHaveBeenCalled();
    expect(restoreInput).not.toHaveBeenCalled();
    const offer = control.view(threadId, "en")?.offer;
    expect(offer?.message).toBe("This account's quota is used up.");
    expect(offer?.action?.label).toBe("Switch to home@example.com and retry");
    // The offer belongs to the failed Thread only.
    expect(control.view(hostThreadIdSchema.parse("other"), "en")?.offer).toBeNull();

    offer?.action?.run();
    await vi.waitFor(() => expect(restoreInput).toHaveBeenCalledOnce());
    expect(switchCodexAccount).toHaveBeenCalledExactlyOnceWith({ accountId: "home" });
    expect(restoreInput).toHaveBeenCalledWith(threadId, "fix the build");
    const done = control.view(threadId, "en")?.offer;
    expect(done?.action).toBeNull();
    expect(done?.message).toContain("review it and send when ready");
  });

  it("does not hand the message back when the Host did not verify the requested Account", async () => {
    const switchCodexAccount = vi.fn(async () => list("work", 2));
    const { control, restoreInput } = await fixture({
      switchCodexAccount,
      inspectCodexAccountRanking: async () => ranking({ workHeadroom: 0 }),
    });
    await control.considerTurnFailure({ threadId, usageLimit: true }, "fix the build");
    control.view(threadId, "en")?.offer?.action?.run();
    await vi.waitFor(() => expect(switchCodexAccount).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(control.view(threadId, "en")?.busy).toBe(false));
    expect(restoreInput).not.toHaveBeenCalled();
  });

  it("offers only a manual switch when the wall is uncertain, and drops the message", async () => {
    const switchCodexAccount = vi.fn(async () => list("home", 2));
    const { control, restoreInput } = await fixture({
      switchCodexAccount,
      inspectCodexAccountRanking: async () => ranking({ workHeadroom: 35 }),
    });
    await control.considerTurnFailure({ threadId, usageLimit: true }, "fix the build");
    const offer = control.view(threadId, "en")?.offer;
    expect(offer?.message).toContain("possibly because of a usage limit");
    expect(offer?.action?.label).toBe("Switch to home@example.com");
    offer?.action?.run();
    await vi.waitFor(() => expect(switchCodexAccount).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(control.view(threadId, "en")?.busy).toBe(false));
    expect(restoreInput).not.toHaveBeenCalled();
  });

  it("makes no offer for an ordinary failure, and a new submission clears a standing offer", async () => {
    const inspectCodexAccountRanking = vi.fn(async () => ranking({ workHeadroom: 35 }));
    const { control } = await fixture({ switchCodexAccount: vi.fn(), inspectCodexAccountRanking });
    await control.considerTurnFailure({ threadId, usageLimit: false }, "hello");
    expect(control.view(threadId, "en")?.offer).toBeNull();

    inspectCodexAccountRanking.mockResolvedValueOnce(ranking({ workHeadroom: 0 }));
    await control.considerTurnFailure({ threadId, usageLimit: false }, "hello");
    expect(control.view(threadId, "en")?.offer).not.toBeNull();
    control.noteSubmission(threadId);
    expect(control.view(threadId, "en")?.offer).toBeNull();
  });

  it("applies Auto changes only from the Host's answer", async () => {
    const updated = Promise.withResolvers<CodexAccountListResult>();
    const updateCodexAccountAuto = vi.fn(() => updated.promise);
    const { control } = await fixture(
      { updateCodexAccountAuto },
      list("work", 1, { auto: { enabled: false, strategy: "best" } }),
    );
    control.view(null, "en")?.auto?.toggle();
    expect(updateCodexAccountAuto).toHaveBeenCalledExactlyOnceWith({ enabled: true });
    expect(control.view(null, "en")?.auto?.enabled).toBe(false);
    updated.resolve(list("work", 2, { auto: { enabled: true, strategy: "best" } }));
    await vi.waitFor(() => expect(control.view(null, "en")?.auto?.enabled).toBe(true));
  });

  it("routes Turn-failure notifications to its owner", async () => {
    const { onFailure, fail } = await fixture({});
    fail()?.({ threadId, usageLimit: true });
    expect(onFailure).toHaveBeenCalledWith({ threadId, usageLimit: true });
  });
});
