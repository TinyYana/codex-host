import { describe, expect, it } from "vitest";
import type { AccountCreditsSnapshot } from "@codexhost/shared-contracts";
import {
  quotaWindows,
  rankAccountCandidates,
  type QuotaCandidate,
} from "../src/account/quota-ranker.js";

const NOW = Date.parse("2026-09-21T12:00:00Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function credits(fiveHourUsed: number, weeklyUsed: number, weeklyResetIn = 5 * 24 * HOUR) {
  return {
    usedPercent: fiveHourUsed,
    periodType: "five_hour",
    resetsAt: iso(NOW + 2 * HOUR),
    productUsage: [
      { product: "7-day window", usagePercent: weeklyUsed, resetsAt: iso(NOW + weeklyResetIn) },
    ],
  } satisfies AccountCreditsSnapshot;
}

function candidate(id: string, value: Partial<QuotaCandidate> = {}): QuotaCandidate {
  return {
    id,
    current: false,
    credentialUsable: true,
    credits: credits(10, 10),
    observedAtMs: NOW - 60_000,
    ...value,
  };
}

describe("quotaWindows", () => {
  it("keeps model-scoped limits separate from account-wide windows and never sums them", () => {
    const windows = quotaWindows({
      ...credits(20, 40),
      productUsage: [
        { product: "7-day window", usagePercent: 40 },
        { product: "GPT-5.3-Codex-Spark", usagePercent: 95 },
      ],
    });
    expect(windows.map(({ scope, period, usedPercent }) => [scope, period, usedPercent])).toEqual([
      ["account", "five_hour", 20],
      ["account", "seven_day", 40],
      ["GPT-5.3-Codex-Spark", "unknown", 95],
    ]);
  });
});

describe("rankAccountCandidates", () => {
  it("derives the binding window as the least-headroom account-wide window", () => {
    const { entries } = rankAccountCandidates([candidate("a", { credits: credits(20, 85) })], {
      nowMs: NOW,
    });
    expect(entries[0]).toMatchObject({
      eligible: true,
      headroomPercent: 15,
      binding: { period: "seven_day" },
    });
  });

  it("ignores a model-scoped limit for account selection by default", () => {
    const scoped = {
      ...credits(10, 10),
      productUsage: [
        { product: "7-day window", usagePercent: 10 },
        { product: "Spark", usagePercent: 100 },
      ],
    };
    const { entries } = rankAccountCandidates([candidate("a", { credits: scoped })], {
      nowMs: NOW,
    });
    expect(entries[0]).toMatchObject({ eligible: true, headroomPercent: 90 });
  });

  it("never treats unknown quota as unused: unknown and stale candidates are quarantined", () => {
    const { recommendedId, entries } = rankAccountCandidates(
      [
        candidate("unknown", { credits: null, observedAtMs: null }),
        candidate("stale", { observedAtMs: NOW - 60 * 60_000 }),
        candidate("known", { credits: credits(60, 60) }),
      ],
      { nowMs: NOW },
    );
    expect(recommendedId).toBe("known");
    const byId = Object.fromEntries(entries.map((entry) => [entry.id, entry]));
    expect(byId.unknown).toMatchObject({ eligible: false, quarantine: "quota-unknown" });
    expect(byId.stale).toMatchObject({ eligible: false, quarantine: "quota-stale" });
  });

  it("quarantines an unusable credential even with the best quota, and says why", () => {
    const { recommendedId, entries } = rankAccountCandidates(
      [
        candidate("broken", { credentialUsable: false, credits: credits(0, 0) }),
        candidate("ok", { credits: credits(50, 50) }),
      ],
      { nowMs: NOW },
    );
    expect(recommendedId).toBe("ok");
    const broken = entries.find((entry) => entry.id === "broken");
    expect(broken).toMatchObject({ eligible: false, quarantine: "credential-unusable" });
    expect(broken?.reasons.join(" ")).toMatch(/re-login/u);
  });

  it("returns no recommendation when every candidate is exhausted or unknown", () => {
    const { recommendedId } = rankAccountCandidates(
      [
        candidate("a", { current: true, credits: credits(100, 50) }),
        candidate("b", { credits: null, observedAtMs: null }),
      ],
      { nowMs: NOW },
    );
    expect(recommendedId).toBeNull();
  });

  it("does not ping-pong between accounts with similar headroom", () => {
    const a = candidate("a", { current: true, credits: credits(50, 50) });
    const b = candidate("b", { credits: credits(45, 45) });
    expect(rankAccountCandidates([a, b], { nowMs: NOW }).recommendedId).toBe("a");
    // After a hypothetical switch the same data must not send it straight back.
    const swapped = [
      { ...a, current: false },
      { ...b, current: true },
    ];
    expect(rankAccountCandidates(swapped, { nowMs: NOW }).recommendedId).toBe("b");
  });

  it("switches once a challenger clears the hysteresis margin", () => {
    const result = rankAccountCandidates(
      [
        candidate("a", { current: true, credits: credits(80, 80) }),
        candidate("b", { credits: credits(10, 10) }),
      ],
      { nowMs: NOW },
    );
    expect(result.recommendedId).toBe("b");
  });

  it("holds the current account during the cooldown unless it hit the wall", () => {
    const b = candidate("b", { credits: credits(10, 10) });
    const lastSwitchAtMs = NOW - 60_000;
    expect(
      rankAccountCandidates([candidate("a", { current: true, credits: credits(80, 80) }), b], {
        nowMs: NOW,
        lastSwitchAtMs,
      }).recommendedId,
    ).toBe("a");
    expect(
      rankAccountCandidates([candidate("a", { current: true, credits: credits(100, 80) }), b], {
        nowMs: NOW,
        lastSwitchAtMs,
      }).recommendedId,
    ).toBe("b");
  });

  it("treats a window whose reset already passed as refilled", () => {
    const refilled = { ...credits(100, 20), resetsAt: iso(NOW - 60_000) };
    const { entries } = rankAccountCandidates([candidate("a", { credits: refilled })], {
      nowMs: NOW,
    });
    expect(entries[0]).toMatchObject({ eligible: true, headroomPercent: 80 });
  });

  it("derives waste risk and lets waste-first spend quota that is about to expire", () => {
    const expiring = candidate("expiring", { credits: credits(10, 30, 6 * HOUR) });
    const fresh = candidate("fresh", { credits: credits(5, 5, 6.5 * 24 * HOUR) });
    const wasteFirst = rankAccountCandidates([expiring, fresh], {
      nowMs: NOW,
      strategy: "waste-first",
    });
    expect(wasteFirst.recommendedId).toBe("expiring");
    const entry = wasteFirst.entries.find(({ id }) => id === "expiring");
    expect(entry?.wasteRisk).toBeGreaterThan(0.6);
    expect(entry?.resetDeadlineMs).toBe(NOW + 6 * HOUR);
  });

  it("consume-first concentrates usage on the most consumed eligible account", () => {
    const result = rankAccountCandidates(
      [candidate("used", { credits: credits(70, 70) }), candidate("fresh")],
      { nowMs: NOW, strategy: "consume-first" },
    );
    expect(result.recommendedId).toBe("used");
  });

  it("best balances headroom with expiring quota", () => {
    // Slightly less headroom, but most of its weekly quota expires in hours.
    const expiring = candidate("expiring", { credits: credits(30, 30, 3 * HOUR) });
    const roomy = candidate("roomy", { credits: credits(20, 20, 6.5 * 24 * HOUR) });
    expect(rankAccountCandidates([expiring, roomy], { nowMs: NOW }).recommendedId).toBe("expiring");
  });
});
