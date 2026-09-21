import type { OfficialWorkGate } from "../codex-runtime/official-work-gate.js";
import type { CodexCredentialIdentity } from "./native-codex-credentials.js";
export interface NativeAccountRuntime {
  readonly gate: OfficialWorkGate;
  checkCredentialStorage(): Promise<void>;
  stop(): Promise<void>;
  /** Reject when another Codex process shares this home. Never terminates anything. */
  assertNoExternalProcesses(): Promise<void>;
  start(): Promise<void>;
  verify(identity: CodexCredentialIdentity | null): Promise<void>;
}
