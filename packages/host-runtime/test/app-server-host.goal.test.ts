import { describe, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import {
  CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
  type ExternalHarnessId,
  type JsonObject,
} from "@codexhost/protocol-core";
import { harnessIdSchema } from "@codexhost/shared-contracts";

import {
  method,
  requestId,
  messageParams,
  turnEvent,
  writeRequest,
  createFixture,
  startPiThread,
  startPiTurn,
  stopFixture,
} from "./app-server-host-fixture.js";
describe("AppServerHost External Thread Goals", () => {
  const objective = "count.txt contains exactly the number 3";

  function goalAdapter(): FakeHarnessAdapter {
    const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    adapter.supportsGoal = true;
    return adapter;
  }

  function goalFixture(adapter: FakeHarnessAdapter) {
    return createFixture({
      externalAdapters: new Map([["pi", adapter]]) as ReadonlyMap<
        ExternalHarnessId,
        FakeHarnessAdapter
      >,
    });
  }

  function goalUpdates(fixture: ReturnType<typeof createFixture>, status: string): JsonObject[] {
    return fixture.collector.messages.filter(
      (message) =>
        method(message, "thread/goal/updated") &&
        (messageParams(message).goal as JsonObject).status === status,
    );
  }

  async function waitForGoalUpdate(
    fixture: ReturnType<typeof createFixture>,
    status: string,
    count = 1,
  ): Promise<JsonObject> {
    await vi.waitFor(() =>
      expect(goalUpdates(fixture, status).length).toBeGreaterThanOrEqual(count),
    );
    return goalUpdates(fixture, status)[count - 1] as JsonObject;
  }

  it("serves Codex Goal control from the Harness-owned Goal", async () => {
    const adapter = goalAdapter();
    const fixture = goalFixture(adapter);
    const threadId = await startPiThread(fixture);

    writeRequest(fixture.desktopInput, { id: 60, method: "thread/goal/get", params: { threadId } });
    await expect(fixture.collector.waitFor((message) => requestId(message, 60))).resolves.toEqual({
      id: 60,
      result: { goal: null },
    });

    writeRequest(fixture.desktopInput, {
      id: 61,
      method: "thread/goal/set",
      params: { threadId, objective, status: "active" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 61)),
    ).resolves.toMatchObject({
      result: {
        goal: { threadId, objective, status: "active", tokenBudget: null, tokensUsed: 0 },
      },
    });
    const activeUpdate = await waitForGoalUpdate(fixture, "active");
    const turnId = messageParams(activeUpdate).turnId as string;
    expect(typeof turnId).toBe("string");
    const started = await fixture.collector.waitFor((message) =>
      turnEvent(message, "turn/started", turnId),
    );
    // The Harness starts the Goal Turn itself; Desktop already rendered the objective.
    expect((messageParams(started).turn as JsonObject).items).toEqual([]);
    const session = adapter.sessions[0];
    if (!session) throw new Error("Fake Session was not opened");
    expect(session.goalCalls).toEqual(["read", "set"]);
    expect(session.activeGoal?.objective).toBe(objective);

    // Pausing while the Turn runs is Host-side only.
    writeRequest(fixture.desktopInput, {
      id: 62,
      method: "thread/goal/set",
      params: { threadId, status: "paused" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 62)),
    ).resolves.toMatchObject({ result: { goal: { status: "paused" } } });
    await waitForGoalUpdate(fixture, "paused");
    expect(session.goalCalls).toEqual(["read", "set"]);

    session.publishUsage({ totalTokens: 1_500 });
    session.appendText("count is 3");
    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));

    session.settleGoal("achieved", "count is 3");
    const complete = await waitForGoalUpdate(fixture, "complete");
    expect(messageParams(complete).goal).toMatchObject({ objective, tokensUsed: 1_500 });

    // Desktop clears an achieved Goal itself; the Harness already dropped it.
    writeRequest(fixture.desktopInput, {
      id: 63,
      method: "thread/goal/clear",
      params: { threadId },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 63))).resolves.toEqual({
      id: 63,
      result: { cleared: true },
    });
    await fixture.collector.waitFor((message) => method(message, "thread/goal/cleared"));
    expect(session.goalCalls).toEqual(["read", "set"]);
    writeRequest(fixture.desktopInput, { id: 64, method: "thread/goal/get", params: { threadId } });
    await expect(fixture.collector.waitFor((message) => requestId(message, 64))).resolves.toEqual({
      id: 64,
      result: { goal: null },
    });
    await stopFixture(fixture);
  });

  it("blocks a failed Goal Turn and resumes by re-registering the objective natively", async () => {
    const adapter = goalAdapter();
    const fixture = goalFixture(adapter);
    const threadId = await startPiThread(fixture);
    writeRequest(fixture.desktopInput, {
      id: 70,
      method: "thread/goal/set",
      params: { threadId, objective },
    });
    await fixture.collector.waitFor((message) => requestId(message, 70));
    const turnId = messageParams(await waitForGoalUpdate(fixture, "active")).turnId as string;
    const session = adapter.sessions[0];
    if (!session) throw new Error("Fake Session was not opened");
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));

    // Replacing the objective mid-Turn is refused; Desktop pauses and interrupts first.
    writeRequest(fixture.desktopInput, {
      id: 71,
      method: "thread/goal/set",
      params: { threadId, objective: "something else" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 71)),
    ).resolves.toMatchObject({ error: { code: -32072 } });

    session.failTurn({ code: "nativeFailure", message: "model unavailable", retryable: false });
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
    await waitForGoalUpdate(fixture, "blocked");

    writeRequest(fixture.desktopInput, {
      id: 72,
      method: "thread/goal/set",
      params: { threadId, status: "active" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 72)),
    ).resolves.toMatchObject({ result: { goal: { objective, status: "active" } } });
    expect(session.goalCalls).toEqual(["read", "set", "set"]);
    const resumed = await waitForGoalUpdate(fixture, "active", 2);
    expect(messageParams(resumed).turnId).not.toBe(turnId);

    // Clearing a live Goal goes through the Harness.
    session.succeedTurn();
    await fixture.collector.waitFor((message) =>
      turnEvent(message, "turn/completed", messageParams(resumed).turnId as string),
    );
    writeRequest(fixture.desktopInput, {
      id: 73,
      method: "thread/goal/clear",
      params: { threadId },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 73))).resolves.toEqual({
      id: 73,
      result: { cleared: true },
    });
    expect(session.goalCalls).toEqual(["read", "set", "set", "clear"]);
    await fixture.collector.waitFor((message) => method(message, "thread/goal/cleared"));
    await stopFixture(fixture);
  });

  it("hydrates a Goal the Harness restored and rejects invalid updates", async () => {
    const adapter = goalAdapter();
    const fixture = goalFixture(adapter);
    const threadId = await startPiThread(fixture);
    const session = adapter.sessions[0];
    if (!session) throw new Error("Fake Session was not opened");
    session.activeGoal = { objective, setAtMs: 1_000 };

    writeRequest(fixture.desktopInput, { id: 80, method: "thread/goal/get", params: { threadId } });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 80)),
    ).resolves.toMatchObject({ result: { goal: { objective, status: "paused", createdAt: 1 } } });
    writeRequest(fixture.desktopInput, {
      id: 81,
      method: "thread/goal/set",
      params: { threadId, status: "complete" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 81)),
    ).resolves.toMatchObject({ error: { code: -32602 } });
    writeRequest(fixture.desktopInput, {
      id: 82,
      method: "thread/goal/set",
      params: { threadId, objective: "   " },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 82)),
    ).resolves.toMatchObject({ error: { code: -32602 } });
    await stopFixture(fixture);
  });

  it("answers concurrent hydrating reads consistently", async () => {
    const adapter = goalAdapter();
    const fixture = goalFixture(adapter);
    const threadId = await startPiThread(fixture);
    const session = adapter.sessions[0];
    if (!session) throw new Error("Fake Session was not opened");
    session.activeGoal = { objective, setAtMs: 1_000 };

    writeRequest(fixture.desktopInput, { id: 85, method: "thread/goal/get", params: { threadId } });
    writeRequest(fixture.desktopInput, { id: 86, method: "thread/goal/get", params: { threadId } });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 85)),
    ).resolves.toMatchObject({ result: { goal: { objective, status: "paused" } } });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 86)),
    ).resolves.toMatchObject({ result: { goal: { objective, status: "paused" } } });

    // A later read never re-consults the Harness or clobbers the loaded state.
    writeRequest(fixture.desktopInput, { id: 87, method: "thread/goal/get", params: { threadId } });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 87)),
    ).resolves.toMatchObject({ result: { goal: { objective, status: "paused" } } });
    expect(session.goalCalls.filter((call) => call === "read").length).toBeLessThanOrEqual(2);
    await stopFixture(fixture);
  });

  it("acknowledges Desktop next-Turn settings so Goal setup reaches the Harness", async () => {
    const adapter = goalAdapter();
    const fixture = goalFixture(adapter);
    const threadId = await startPiThread(fixture);

    // Desktop sends this before every composer `thread/goal/set` and aborts
    // the Goal when it fails.
    writeRequest(fixture.desktopInput, {
      id: 100,
      method: "thread/settings/update",
      params: { threadId, model: "codexhost/pi-native", effort: "high", summary: "auto" },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 100))).resolves.toEqual({
      id: 100,
      result: {},
    });
    writeRequest(fixture.desktopInput, {
      id: 101,
      method: "thread/settings/update",
      params: { threadId, model: CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 101)),
    ).resolves.toMatchObject({ error: { code: -32602 } });
    expect(adapter.sessions[0]?.goalCalls ?? []).toEqual([]);
    await stopFixture(fixture);
  });

  it("starts a new Thread's Goal from Desktop's `/goal <objective>` first Turn", async () => {
    const adapter = goalAdapter();
    const fixture = goalFixture(adapter);
    const threadId = await startPiThread(fixture);

    writeRequest(fixture.desktopInput, {
      id: 110,
      method: "turn/start",
      params: { threadId, input: [{ type: "text", text: `/goal ${objective}` }] },
    });
    const response = await fixture.collector.waitFor((message) => requestId(message, 110));
    const turnId = ((response.result as JsonObject).turn as JsonObject).id;
    const active = await waitForGoalUpdate(fixture, "active");
    expect(messageParams(active)).toMatchObject({ turnId, goal: { objective } });
    const session = adapter.sessions[0];
    if (!session) throw new Error("Fake Session was not opened");
    expect(session.activeGoal?.objective).toBe(objective);

    // Desktop then sets the Goal it already started; that must not restart it.
    writeRequest(fixture.desktopInput, {
      id: 111,
      method: "thread/goal/set",
      params: { threadId, objective, status: "active" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 111)),
    ).resolves.toMatchObject({ result: { goal: { objective, status: "active" } } });
    expect(session.goalCalls.filter((call) => call === "set")).toHaveLength(1);
    session.succeedTurn();
    await fixture.collector.waitFor((message) =>
      turnEvent(message, "turn/completed", turnId as string),
    );
    await stopFixture(fixture);
  });

  it("shows a native Goal rejection as a failed Turn and keeps the Thread usable", async () => {
    const adapter = goalAdapter();
    const fixture = goalFixture(adapter);
    const threadId = await startPiThread(fixture);
    const session = adapter.sessions[0];
    if (!session) throw new Error("Fake Session was not opened");
    const reason = "/goal can't run while hooks are restricted (disableAllHooks is set).";

    session.rejectNextTurn({ code: "unsupported", message: reason, retryable: false });
    writeRequest(fixture.desktopInput, {
      id: 120,
      method: "thread/goal/set",
      params: { threadId, objective, status: "active" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 120)),
    ).resolves.toMatchObject({ error: { code: -32073, message: reason } });
    // Desktop only toasts "Failed to set goal"; the reason is shown in the Thread.
    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "turn/completed") &&
          (messageParams(message).turn as JsonObject).status === "failed",
      ),
    ).resolves.toMatchObject({ params: { threadId, turn: { error: { message: reason } } } });

    session.rejectNextTurn({ code: "unsupported", message: reason, retryable: false });
    writeRequest(fixture.desktopInput, {
      id: 121,
      method: "turn/start",
      params: { threadId, input: [{ type: "text", text: `/goal ${objective}` }] },
    });
    const response = await fixture.collector.waitFor((message) => requestId(message, 121));
    const rejectedTurnId = ((response.result as JsonObject).turn as JsonObject).id as string;
    await expect(
      fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", rejectedTurnId)),
    ).resolves.toMatchObject({
      params: { turn: { status: "failed", error: { message: reason } } },
    });

    writeRequest(fixture.desktopInput, {
      id: 122,
      method: "thread/goal/get",
      params: { threadId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 122)),
    ).resolves.toMatchObject({ result: { goal: null } });
    // Nothing is left running: an ordinary message still starts a Turn.
    const turnId = await startPiTurn(fixture, threadId, 123);
    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
    await stopFixture(fixture);
  });

  it("refuses Goal control for Harnesses without a native Goal", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    writeRequest(fixture.desktopInput, { id: 90, method: "thread/goal/get", params: { threadId } });
    await expect(fixture.collector.waitFor((message) => requestId(message, 90))).resolves.toEqual({
      id: 90,
      result: { goal: null },
    });
    writeRequest(fixture.desktopInput, {
      id: 91,
      method: "thread/goal/set",
      params: { threadId, objective },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 91)),
    ).resolves.toMatchObject({ error: { code: -32078 } });
    expect(fixture.adapter.sessions[0]?.goalCalls).toEqual([]);
    await stopFixture(fixture);
  });
});
