import { describe, expect, it } from "vitest";

import {
  externalThreadGoalFromHarness,
  goalCommandObjective,
  goalFailureIsProjected,
  parseThreadGoalSetParams,
  projectThreadGoal,
  settledGoalStatus,
  type ExternalThreadGoal,
} from "../src/external-thread-goal.js";

const objective = "count.txt contains exactly the number 3";

function hostGoal(setAtMs = 5_000) {
  return { objective, setAtMs };
}

function existingGoal(overrides: Partial<ExternalThreadGoal> = {}): ExternalThreadGoal {
  return {
    objective,
    status: "active",
    tokenBudget: 20_000,
    createdAtMs: 5_000,
    updatedAtMs: 6_000,
    tokensAtStart: 1_000,
    nativeCleared: false,
    ...overrides,
  };
}

describe("parseThreadGoalSetParams", () => {
  it("accepts the Desktop shapes and trims empty objectives to null", () => {
    expect(parseThreadGoalSetParams({ threadId: "t-1", objective, status: "active" })).toEqual({
      threadId: "t-1",
      objective,
      status: "active",
      tokenBudget: undefined,
    });
    expect(parseThreadGoalSetParams({ threadId: "t-1", status: "paused" })).toEqual({
      threadId: "t-1",
      objective: null,
      status: "paused",
      tokenBudget: undefined,
    });
    expect(parseThreadGoalSetParams({ threadId: "t-1", objective: "   " }).objective).toBeNull();
    expect(parseThreadGoalSetParams({ threadId: "t-1", tokenBudget: null }).tokenBudget).toBeNull();
  });

  it("rejects malformed params without inventing defaults", () => {
    expect(() => parseThreadGoalSetParams({})).toThrow(/threadId/u);
    expect(() => parseThreadGoalSetParams({ threadId: "t-1", objective: 3 })).toThrow(/objective/u);
    expect(() => parseThreadGoalSetParams({ threadId: "t-1", status: "sleeping" })).toThrow(
      /status/u,
    );
    expect(() => parseThreadGoalSetParams({ threadId: "t-1", tokenBudget: 0 })).toThrow(
      /tokenBudget/u,
    );
    expect(() => parseThreadGoalSetParams({ threadId: "t-1", tokenBudget: 1.5 })).toThrow(
      /tokenBudget/u,
    );
  });
});

describe("externalThreadGoalFromHarness", () => {
  it("starts a new Goal active with the current usage baseline", () => {
    expect(externalThreadGoalFromHarness(hostGoal(), null, { totalTokens: 1_500 }, 10_000)).toEqual(
      {
        objective,
        status: "active",
        tokenBudget: null,
        createdAtMs: 5_000,
        updatedAtMs: 10_000,
        tokensAtStart: 1_500,
        nativeCleared: false,
      },
    );
  });

  it("falls back to now when the Harness has no set time", () => {
    expect(externalThreadGoalFromHarness(hostGoal(0), null, null, 10_000).createdAtMs).toBe(10_000);
  });

  it("preserves Host-side budget, baseline, and paused status for the same objective", () => {
    const previous = existingGoal({ status: "paused" });
    expect(
      externalThreadGoalFromHarness(hostGoal(), previous, { totalTokens: 9_000 }, 11_000),
    ).toEqual({
      objective,
      status: "paused",
      tokenBudget: 20_000,
      createdAtMs: 5_000,
      updatedAtMs: 11_000,
      tokensAtStart: 1_000,
      nativeCleared: false,
    });
  });

  it("resets Host-side state when the objective changed", () => {
    const next = externalThreadGoalFromHarness(
      { objective: "another objective", setAtMs: 8_000 },
      existingGoal({ status: "paused" }),
      { totalTokens: 9_000 },
      11_000,
    );
    expect(next).toMatchObject({
      objective: "another objective",
      status: "active",
      tokenBudget: null,
      createdAtMs: 8_000,
      tokensAtStart: 9_000,
    });
  });
});

describe("settledGoalStatus", () => {
  it("maps Harness outcomes to Codex statuses", () => {
    expect(settledGoalStatus("achieved")).toBe("complete");
    expect(settledGoalStatus("unachievable")).toBe("blocked");
    expect(settledGoalStatus("error")).toBe("blocked");
    expect(settledGoalStatus("cleared")).toBeNull();
  });
});

describe("projectThreadGoal", () => {
  it("projects the Codex ThreadGoal shape with usage and time deltas", () => {
    expect(
      projectThreadGoal({
        threadId: "t-1",
        goal: existingGoal(),
        usage: { totalTokens: 2_500 },
        nowMs: 65_000,
      }),
    ).toEqual({
      threadId: "t-1",
      objective,
      status: "active",
      tokenBudget: 20_000,
      tokensUsed: 1_500,
      timeUsedSeconds: 60,
      createdAt: 5,
      updatedAt: 6,
    });
  });

  it("never reports negative usage and falls back to the baseline without telemetry", () => {
    const projected = projectThreadGoal({
      threadId: "t-1",
      goal: existingGoal({ tokensAtStart: 9_000 }),
      usage: { totalTokens: 2_500 },
      nowMs: 4_000,
    });
    expect(projected.tokensUsed).toBe(0);
    expect(projected.timeUsedSeconds).toBe(0);
    expect(
      projectThreadGoal({ threadId: "t-1", goal: existingGoal(), usage: null, nowMs: 65_000 })
        .tokensUsed,
    ).toBe(0);
  });
});

describe("Desktop Goal commands", () => {
  it("reads the objective only from Desktop's `/goal <objective>` first Turn", () => {
    expect(goalCommandObjective(`/goal ${objective}`)).toBe(objective);
    expect(goalCommandObjective(`  /goal   ${objective}\n`)).toBe(objective);
    expect(goalCommandObjective("/goal")).toBeNull();
    expect(goalCommandObjective("/goal   ")).toBeNull();
    expect(goalCommandObjective("/goals list")).toBeNull();
    expect(goalCommandObjective(`please /goal ${objective}`)).toBeNull();
  });

  it("projects native Goal failures but not busy or closed Sessions", () => {
    const error = (code: "unsupported" | "nativeFailure" | "sessionBusy" | "invalidState") => ({
      code,
      message: "x",
      retryable: false,
    });
    expect(goalFailureIsProjected(error("unsupported"))).toBe(true);
    expect(goalFailureIsProjected(error("nativeFailure"))).toBe(true);
    expect(goalFailureIsProjected(error("sessionBusy"))).toBe(false);
    expect(goalFailureIsProjected(error("invalidState"))).toBe(false);
  });
});
