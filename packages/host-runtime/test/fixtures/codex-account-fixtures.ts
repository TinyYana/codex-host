import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NativeCodexCredentials,
  type CodexCredentialIdentity,
} from "../../src/account/native-codex-credentials.js";
import { NativeAccountStore } from "../../src/account/native-account-store.js";
import type { NativeAccountRuntime } from "../../src/account/native-account-runtime.js";
import { OfficialWorkGate } from "../../src/codex-runtime/official-work-gate.js";

export function credential(
  subject: string,
  generation = 1,
  expiresAtUnix = 2_000_000_000,
): NativeCodexCredentials {
  return NativeCodexCredentials.parse(
    syntheticNativeCredentials({ subject, generation, expiresAtUnix }),
  );
}
export class FakeAccountRuntime implements NativeAccountRuntime {
  readonly gate = new OfficialWorkGate();
  readonly events: string[] = [];
  onStop: (() => Promise<void>) | undefined;
  onVerify: ((identity: CodexCredentialIdentity | null) => Promise<void>) | undefined;
  onExternalCheck: (() => Promise<void>) | undefined;
  constructor() {
    this.gate.initialized();
  }
  async checkCredentialStorage(): Promise<void> {
    this.events.push("check");
  }
  async stop(): Promise<void> {
    this.events.push("stop");
    await this.onStop?.();
  }
  async assertNoExternalProcesses(): Promise<void> {
    this.events.push("external");
    await this.onExternalCheck?.();
  }
  async start(): Promise<void> {
    this.events.push("start");
  }
  async verify(identity: CodexCredentialIdentity | null): Promise<void> {
    this.events.push("verify");
    await this.onVerify?.(identity);
  }
}
export async function createAccountState() {
  const home = await mkdtemp(path.join(tmpdir(), "codex-account-test-"));
  const store = new NativeAccountStore({ home });
  await store.open();
  const runtime = new FakeAccountRuntime();
  return {
    home,
    store,
    runtime,
    close: async () => {
      await store.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

export function syntheticCodexIdentity(
  subject: string,
  workspaceId = "shared-team",
): CodexCredentialIdentity {
  return { issuer: "https://auth.openai.com", subject, workspaceId };
}

/** Deliberately unsigned fixture tokens. Never sent to a Provider. */
export function syntheticNativeCredentials(input: {
  subject: string;
  workspaceId?: string;
  email?: string;
  generation?: number;
  expiresAtUnix?: number;
}): string {
  const identity = syntheticCodexIdentity(input.subject, input.workspaceId);
  const generation = input.generation ?? 1;
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = (kind: string) =>
    [
      encode({ alg: "synthetic" }),
      encode({
        iss: identity.issuer,
        sub: identity.subject,
        email: input.email ?? `${input.subject}@example.com`,
        // Expired Access Tokens must still be available to native refresh, not discarded.
        exp: input.expiresAtUnix ?? 1,
        jti: `synthetic-${kind}-${generation}`,
        "https://api.openai.com/auth": {
          chatgpt_account_id: identity.workspaceId,
          chatgpt_plan_type: "team",
        },
      }),
      "synthetic_signature",
    ].join(".");
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: token("id"),
      access_token: token("access"),
      refresh_token: `synthetic-refresh-${input.subject}-${generation}`,
      account_id: identity.workspaceId,
      native_future_field: `preserved-${generation}`,
    },
    last_refresh: "2026-01-01T00:00:00.000Z",
    native_future_field: "preserved",
  });
}

export function syntheticLegacyAccounts(homeA: string, homeB: string) {
  return {
    formatVersion: 1,
    activeAccountId: "account-b",
    accounts: [
      { accountId: "default", codexHome: homeA, email: "a@example.com", label: "A" },
      { accountId: "account-b", codexHome: homeB, email: "b@example.com", label: "B" },
    ].map((a) => ({
      ...a,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
  };
}
