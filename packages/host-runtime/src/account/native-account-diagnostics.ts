import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";
import { NativeAccountError } from "./native-account-store.js";
import { OfficialAdmissionError } from "../codex-runtime/official-work-gate.js";

export type VerificationStep =
  "verify-read" | "verify-account-null" | "verify-account-type" | "verify-identity-mismatch";
type Step =
  | "capture"
  | "storage-check"
  | "stop"
  | "external-check"
  | "assert-idle"
  | "install"
  | "start"
  | VerificationStep;
export type AccountDiagnosticStep = Step | `rollback-${Step}`;
export type AccountDiagnosticOperation = "switch" | "recover";

/** Only fixed categories and numeric RPC codes survive the native response boundary. */
export class AccountReadFailure extends NativeAccountError {
  constructor(
    readonly rpcCode?: number,
    readonly step?: VerificationStep,
  ) {
    super("authentication-failed");
  }
}
export class AccountTransportFailure extends OfficialAdmissionError {
  constructor(readonly rpcCode?: number) {
    super("unavailable");
  }
}
export function rpcErrorCode(error: unknown): number | undefined {
  if (error instanceof AccountReadFailure || error instanceof AccountTransportFailure)
    return error.rpcCode;
  if (typeof error !== "object" || error === null) return undefined;
  const code = "code" in error ? error.code : undefined;
  return typeof code === "number" && Number.isFinite(code) ? code : undefined;
}

/** Serialized, bounded, best-effort diagnostics; never retain raw failure objects. */
export class NativeAccountDiagnostics {
  #pending: Promise<void> = Promise.resolve();
  constructor(
    private readonly directory: string,
    private readonly output: Pick<Writable, "write">,
  ) {}

  async step<T>(
    operation: AccountDiagnosticOperation,
    step: AccountDiagnosticStep,
    action: () => T | Promise<T>,
  ): Promise<T> {
    const started = performance.now();
    try {
      return await action();
    } catch (error) {
      const category = error instanceof AccountReadFailure ? error.step : undefined;
      const failingStep = category
        ? step.startsWith("rollback-")
          ? `rollback-${category}`
          : category
        : step;
      const code = rpcErrorCode(error);
      const line =
        JSON.stringify({
          operation,
          step: failingStep,
          ...(code === undefined ? {} : { code }),
          elapsedMs: Math.round(performance.now() - started),
        }) + "\n";
      try {
        this.output.write(line);
      } catch {
        /* Diagnostics cannot change rollback. */
      }
      this.#pending = this.#pending.then(() => this.#append(line)).catch(() => undefined);
      await this.#pending;
      throw error;
    }
  }

  async #append(line: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = await open(
      path.join(this.directory, "diagnostics.log"),
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.chmod(0o600);
      const size = (await file.stat()).size;
      const tail = Buffer.alloc(Math.min(size, 64 * 1024));
      await file.read(tail, 0, tail.length, size - tail.length);
      const lines = tail.toString("utf8").split("\n");
      if (size > tail.length) lines.shift();
      const content = [...lines.filter(Boolean), line.trimEnd()].slice(-200).join("\n") + "\n";
      await file.write(content, 0, "utf8");
      await file.truncate(Buffer.byteLength(content));
    } finally {
      await file.close();
    }
  }
}
