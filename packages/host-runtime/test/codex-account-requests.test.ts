import { describe, expect, it, vi } from "vitest";
import type { CodexAccountListResult, CodexAccountUsageResult } from "@codexhost/shared-contracts";
import type { CodexAccountControl } from "../src/account/codex-account-control.js";
import { NativeAccountError } from "../src/account/native-account-store.js";
import { OfficialAdmissionError } from "../src/codex-runtime/official-work-gate.js";
import { CodexAccountRequests, codexAccountRpcError } from "../src/codex-account-requests.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function list(currentAccountId: string): CodexAccountListResult {
  return {
    version: 2,
    currentAccountId,
    phase: "ready",
    revision: 1,
    capabilities: { manage: true, saveCurrent: true, switch: true, delete: true },
    accounts: [
      { accountId: A, label: "A", saved: true },
      { accountId: B, label: "B", saved: true },
    ],
  };
}

function usage(accountId: string): CodexAccountUsageResult {
  return {
    accountId,
    usage: null,
    accountCredits: { usedPercent: 40, periodType: "five_hour" },
    freshness: "live",
    observedAt: "2026-09-21T12:00:00.000Z",
  };
}

function setup(overrides: Partial<CodexAccountControl> = {}) {
  let current = A;
  const control: CodexAccountControl = {
    snapshot: () => list(current),
    refresh: async () => list(current),
    currentAccountId: () => current,
    saveCurrent: vi.fn(async () => A),
    switch: vi.fn(async (accountId: string) => {
      current = accountId;
    }),
    remove: vi.fn(async () => {}),
    recover: vi.fn(async () => {}),
    inspectInactiveUsage: vi.fn(async (accountId: string) => usage(accountId)),
    recordUsage: vi.fn(async (accountId: string) => usage(accountId)),
    ...overrides,
  };
  const currentUsage = vi.fn(async (accountId: string) => usage(accountId));
  return { control, currentUsage, requests: new CodexAccountRequests({ control, currentUsage }) };
}

describe("CodexAccountRequests", () => {
  it("reads current quota officially and saved quota from the inactive reader, side by side", async () => {
    const { requests, control, currentUsage } = setup();
    await requests.handle("codexhost/account/usage/inspect", { accountId: A });
    await requests.handle("codexhost/account/usage/inspect", { accountId: B, refresh: true });
    expect(currentUsage).toHaveBeenCalledExactlyOnceWith(A, false);
    expect(control.inspectInactiveUsage).toHaveBeenCalledExactlyOnceWith(B, true);
    expect(control.recordUsage).toHaveBeenCalledExactlyOnceWith(A, usage(A).accountCredits);
  });

  it("keeps unknown quota unknown instead of fabricating a percentage", async () => {
    const { requests } = setup({
      inspectInactiveUsage: async () => {
        throw Object.assign(new Error("quota"), { code: "unavailable" });
      },
    });
    expect(await requests.handle("codexhost/account/usage/inspect", { accountId: B })).toEqual({
      accountId: B,
      usage: null,
      freshness: "cached",
      observedAt: null,
    });
  });

  it("answers a switch with the verified post-switch list", async () => {
    const { requests } = setup();
    expect(await requests.handle("codexhost/account/switch", { accountId: B })).toMatchObject({
      currentAccountId: B,
    });
  });

  it("refuses management on a read-only deployment", async () => {
    const readOnly = new CodexAccountRequests({
      control: { snapshot: () => list(A), currentAccountId: () => A },
      currentUsage: async (accountId) => usage(accountId),
    });
    for (const method of ["save-current", "switch", "delete", "recover", "auto/update"])
      await expect(
        readOnly.handle(`codexhost/account/${method}`, { accountId: B }),
      ).rejects.toMatchObject({ code: "unknown-account" });
  });

  it("maps failures to a closed category and never forwards native error text", () => {
    expect(codexAccountRpcError(new NativeAccountError("unsafe-external-process"))).toEqual({
      code: -32086,
      message: "Codex Account operation failed",
      data: { code: "unsafe-external-process" },
    });
    expect(codexAccountRpcError(new OfficialAdmissionError("busy"))).toMatchObject({
      data: { code: "busy" },
    });
    const leaky = Object.assign(new Error("ENOENT /Users/someone/.codex/auth.json token=abc"), {
      code: "ENOENT",
    });
    expect(codexAccountRpcError(leaky)).toEqual({
      code: -32086,
      message: "Codex Account operation failed",
    });
  });
});
