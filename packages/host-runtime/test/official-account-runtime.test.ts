import { afterEach, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import { OfficialAccountRuntime } from "../src/account/official-account-runtime.js";
import { OfficialWorkGate } from "../src/codex-runtime/official-work-gate.js";
import { credential } from "./fixtures/codex-account-fixtures.js";
import type { NativeCodexCredentials } from "../src/account/native-codex-credentials.js";

afterEach(() => vi.useRealTimers());
function setup(
  read: () => Promise<JsonObject>,
  current: NativeCodexCredentials | null = credential("b"),
) {
  const initialize = vi.fn(async () => ({}));
  const controlRequest = vi.fn(read);
  const runtime = new OfficialAccountRuntime({
    owner: {
      gate: new OfficialWorkGate(),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      attachManagement: () => ({
        configure: vi.fn(),
        initialize,
        request: vi.fn(),
        send: vi.fn(),
        close: vi.fn(),
      }),
      controlRequest,
    },
    environment: {},
    readCredentials: async () => current,
    stopExternalProcesses: async () => {},
  });
  return { runtime, controlRequest };
}
it("waits through initial null accounts without forcing token rotation", async () => {
  vi.useFakeTimers();
  let reads = 0;
  const { runtime, controlRequest } = setup(async () => ({
    result: { account: ++reads < 3 ? null : { type: "chatgpt" } },
  }));
  const verified = runtime.verify(credential("b").identity).then(
    () => null,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(400);
  expect(await verified).toBeNull();
  expect(controlRequest).toHaveBeenCalledTimes(3);
  for (const call of controlRequest.mock.calls)
    expect(call).toEqual(["account/read", { refreshToken: false }]);
});
it.each([
  [null, "verify-account-null"],
  [{ type: "apiKey" }, "verify-account-type"],
  [{ type: "chatgpt" }, "verify-identity-mismatch"],
])("bounds persistent account failure: %j", async (account, step) => {
  vi.useFakeTimers();
  const { runtime } = setup(async () => ({ result: { account } }), credential("a"));
  const result = runtime.verify(credential("b").identity).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(9_999);
  const settled = vi.fn();
  void result.then(settled);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toMatchObject({ code: "authentication-failed", step });
});
it("retries native error responses and retains only the last numeric code", async () => {
  vi.useFakeTimers();
  let calls = 0;
  const { runtime } = setup(async () =>
    ++calls === 1
      ? { result: { account: null } }
      : { error: { code: -123, message: "secret-token email@example.com /secret/path" } },
  );
  const result = runtime.verify(credential("b").identity).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await result).toMatchObject({
    code: "authentication-failed",
    step: "verify-read",
    rpcCode: -123,
  });
  expect(JSON.stringify(await result)).not.toContain("secret");
});
it("succeeds after transient RPC errors", async () => {
  vi.useFakeTimers();
  let calls = 0;
  const { runtime } = setup(async () =>
    ++calls < 3 ? { error: { code: -123 } } : { result: { account: { type: "chatgpt" } } },
  );
  const result = runtime.verify(credential("b").identity);
  await vi.advanceTimersByTimeAsync(400);
  await expect(result).resolves.toBeUndefined();
});
it("bounds a hung management request", async () => {
  vi.useFakeTimers();
  const { runtime, controlRequest } = setup(() => new Promise(() => {}));
  const result = runtime.verify(credential("b").identity).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await result).toMatchObject({ code: "authentication-failed", step: "verify-read" });
  expect(controlRequest).toHaveBeenCalledOnce();
});
it("accepts signed-out readiness only when the file is also absent", async () => {
  const { runtime } = setup(async () => ({ result: { account: null } }), null);
  await expect(runtime.verify(null)).resolves.toBeUndefined();
});
it("keeps storage checks and rejects native config errors", async () => {
  const { runtime, controlRequest } = setup(async () => ({
    error: { code: -42, message: "secret" },
  }));
  await expect(runtime.checkCredentialStorage()).rejects.toMatchObject({
    code: "authentication-failed",
    rpcCode: -42,
  });
  expect(controlRequest).toHaveBeenCalledWith("config/read", { includeLayers: true });
});
