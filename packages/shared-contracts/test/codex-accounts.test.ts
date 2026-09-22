import { describe, expect, it } from "vitest";

import {
  codexAccountListResultSchema,
  codexAccountRankingResultSchema,
  codexAccountUsageResultSchema,
} from "../src/index.js";

const baseSnapshot = {
  version: 2 as const,
  currentAccountId: "account-a",
  phase: "ready" as const,
  revision: 7,
  accounts: [{ accountId: "account-a", label: "Account A", email: "a@example.com" }],
};

describe("Codex Account browser contracts", () => {
  it("keeps a current-only snapshot and excludes credential locations", () => {
    expect(codexAccountListResultSchema.parse(baseSnapshot)).toEqual(baseSnapshot);
    expect(() =>
      codexAccountListResultSchema.parse({
        ...baseSnapshot,
        accounts: [{ ...baseSnapshot.accounts[0], codexHome: "/private/home" }],
      }),
    ).toThrow();
  });

  it("accepts managed Accounts while Host login stays outside the contract", () => {
    const managed = {
      ...baseSnapshot,
      phase: "changing" as const,
      pendingOperation: { operationId: "switch-1", kind: "switch" as const },
      capabilities: { manage: true, saveCurrent: false, switch: false, delete: false },
      auto: { enabled: true, strategy: "waste-first" as const },
      accounts: [
        { ...baseSnapshot.accounts[0], saved: true },
        { accountId: "account-b", label: "Account B", saved: true, requiresLogin: true },
      ],
    };
    expect(codexAccountListResultSchema.parse(managed)).toEqual(managed);
    // Host never owns login or logout: those capabilities and operations do not exist.
    expect(
      codexAccountListResultSchema.safeParse({
        ...baseSnapshot,
        capabilities: { manage: true, saveCurrent: true, switch: true, delete: true, login: true },
      }).success,
    ).toBe(false);
    expect(
      codexAccountListResultSchema.safeParse({
        ...baseSnapshot,
        pendingOperation: { operationId: "login-1", kind: "login" },
      }).success,
    ).toBe(false);
  });

  it("never carries credential material on an Account", () => {
    for (const secret of ["auth", "tokens", "accessToken", "refreshToken"])
      expect(
        codexAccountListResultSchema.safeParse({
          ...baseSnapshot,
          accounts: [{ ...baseSnapshot.accounts[0], [secret]: "synthetic" }],
        }).success,
      ).toBe(false);
  });

  it("ranking explains quota facts only", () => {
    expect(
      codexAccountRankingResultSchema.parse({
        strategy: "best",
        recommendedAccountId: null,
        entries: [{ accountId: "account-a", eligible: false, reasons: ["Quota is unknown"] }],
      }),
    ).toMatchObject({ recommendedAccountId: null });
    expect(
      codexAccountRankingResultSchema.safeParse({
        strategy: "best",
        recommendedAccountId: null,
        entries: [{ accountId: "account-a", eligible: true, reasons: [], modelQuality: 9 }],
      }).success,
    ).toBe(false);
  });

  it("requires quota freshness and observation time", () => {
    expect(
      codexAccountUsageResultSchema.parse({
        accountId: "account-a",
        usage: null,
        freshness: "cached",
        observedAt: "2026-09-11T00:00:00.000Z",
      }),
    ).toMatchObject({ freshness: "cached" });
  });
});
