import type { JsonObject } from "@codexhost/protocol-core";
import type {
  OfficialClientSession,
  OfficialRuntimeOwner,
} from "../codex-runtime/official-runtime-owner.js";
import { OfficialAdmissionError } from "../codex-runtime/official-work-gate.js";
import { NativeAccountError } from "./native-account-store.js";
import {
  sameCodexCredentialIdentity,
  type CodexCredentialIdentity,
  type NativeCodexCredentials,
} from "./native-codex-credentials.js";
import type { NativeAccountRuntime } from "./native-account-runtime.js";
import {
  AccountReadFailure,
  AccountTransportFailure,
  rpcErrorCode,
} from "./native-account-diagnostics.js";
const object = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const initialization = {
  clientInfo: { name: "codexhost_account_management", version: "1" },
  capabilities: { experimentalApi: true },
};
type Owner = Pick<
  OfficialRuntimeOwner,
  "gate" | "start" | "stop" | "attachManagement" | "controlRequest"
>;
export class OfficialAccountRuntime implements NativeAccountRuntime {
  readonly #owner: Owner;
  readonly #control: OfficialClientSession;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #readCredentials: () => Promise<NativeCodexCredentials | null>;
  readonly #findExternal: () => Promise<readonly number[]>;
  constructor(input: {
    owner: Owner;
    /** Reuse an existing management connection instead of attaching another one. */
    control?: OfficialClientSession;
    environment: NodeJS.ProcessEnv;
    readCredentials(): Promise<NativeCodexCredentials | null>;
    /** PIDs of Codex processes CodexHost does not own that share this home. */
    findExternalProcesses(): Promise<readonly number[]>;
  }) {
    this.#owner = input.owner;
    this.#environment = input.environment;
    this.#readCredentials = input.readCredentials;
    this.#findExternal = input.findExternalProcesses;
    if (input.control) this.#control = input.control;
    else {
      this.#control = input.owner.attachManagement(async () => {});
      this.#control.configure(initialization);
    }
  }
  get gate() {
    return this.#owner.gate;
  }
  stop(): Promise<void> {
    return this.#owner.stop();
  }
  start(): Promise<void> {
    return this.#owner.start();
  }
  async assertNoExternalProcesses(): Promise<void> {
    if ((await this.#findExternal()).length > 0)
      throw new NativeAccountError("unsafe-external-process");
  }
  async checkCredentialStorage(): Promise<void> {
    const overrides = new Set([
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "CODEX_AUTH_TOKEN",
      "CODEX_ACCESS_TOKEN",
    ]);
    if (
      Object.entries(this.#environment).some(
        ([key, value]) => overrides.has(key.toUpperCase()) && !!value,
      )
    )
      throw new NativeAccountError("unsupported-storage");
    const response = await this.#read("config/read", { includeLayers: true });
    if (!object(response.config) || response.config.cli_auth_credentials_store !== "file")
      throw new NativeAccountError("unsupported-storage");
  }
  async verify(identity: CodexCredentialIdentity | null): Promise<void> {
    const deadline = performance.now() + 10_000;
    let last: Error = new AccountReadFailure(undefined, "verify-read");
    while (performance.now() < deadline) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Bound the whole observation, including an RPC that never answers. Late
        // read-only results cannot complete verification or start another poll.
        const failure = await Promise.race([
          this.#observe(identity),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(last), Math.max(0, deadline - performance.now()));
          }),
        ]);
        if (!failure) return;
        last = failure;
      } catch (error) {
        last =
          error instanceof OfficialAdmissionError || error instanceof AccountReadFailure
            ? error
            : new AccountReadFailure(rpcErrorCode(error), "verify-read");
      } finally {
        clearTimeout(timer);
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(200, remaining)));
    }
    throw last;
  }
  async #observe(
    identity: CodexCredentialIdentity | null,
  ): Promise<AccountReadFailure | undefined> {
    let response: JsonObject;
    try {
      response = await this.#read("account/read", { refreshToken: false });
    } catch (error) {
      if (error instanceof OfficialAdmissionError) throw error;
      return new AccountReadFailure(rpcErrorCode(error), "verify-read");
    }
    if (response.account === null && identity !== null)
      return new AccountReadFailure(undefined, "verify-account-null");
    if (
      identity === null
        ? response.account !== null
        : !object(response.account) || response.account.type !== "chatgpt"
    )
      return new AccountReadFailure(undefined, "verify-account-type");
    const current = await this.#readCredentials();
    if (
      identity === null
        ? current !== null
        : !current || !sameCodexCredentialIdentity(current.identity, identity)
    )
      return new AccountReadFailure(undefined, "verify-identity-mismatch");
  }
  async #read(method: string, params: JsonObject): Promise<JsonObject> {
    let response: JsonObject;
    try {
      await this.#control.initialize(initialization);
      response = await this.#owner.controlRequest(method, params);
    } catch (error) {
      throw new AccountTransportFailure(rpcErrorCode(error));
    }
    if (response.error || !object(response.result))
      throw new AccountReadFailure(rpcErrorCode(response.error));
    return response.result;
  }
}
