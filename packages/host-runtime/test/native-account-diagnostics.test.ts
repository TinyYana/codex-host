import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  AccountReadFailure,
  NativeAccountDiagnostics,
} from "../src/account/native-account-diagnostics.js";

it("writes only safe fields to both sinks, repairs permissions and retains 200 lines", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "account-diagnostics-"));
  try {
    const file = path.join(directory, "diagnostics.log");
    await writeFile(file, "", { mode: 0o644 });
    const write = vi.fn<(line: string | Uint8Array) => boolean>().mockReturnValue(true);
    const diagnostics = new NativeAccountDiagnostics(directory, { write });
    const error = Object.assign(new Error("token email@example.com account-id /private/path"), {
      code: -123,
      tokens: "secret",
    });
    await Promise.all(
      Array.from({ length: 205 }, () =>
        diagnostics
          .step("switch", "install", () => {
            throw error;
          })
          .catch(() => undefined),
      ),
    );
    await diagnostics
      .step("recover", "rollback-verify-read", () => {
        throw new AccountReadFailure(-42, "verify-account-null");
      })
      .catch(() => undefined);
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(200);
    expect(lines).toEqual(write.mock.calls.slice(-200).map(([line]) => String(line).trim()));
    for (const line of lines) {
      expect(Object.keys(JSON.parse(line))).toEqual(["operation", "step", "code", "elapsedMs"]);
      expect(line).not.toMatch(/token|secret|email|account-id|private/);
    }
    expect(JSON.parse(lines.at(-1) ?? "null")).toMatchObject({
      operation: "recover",
      step: "rollback-verify-account-null",
      code: -42,
    });
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not replace operation failures when diagnostic output or persistence fails", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "account-diagnostics-"));
  try {
    const blocked = path.join(directory, "file");
    await writeFile(blocked, "");
    const diagnostics = new NativeAccountDiagnostics(blocked, {
      write: () => {
        throw new Error("sink");
      },
    });
    const error = new Error("original");
    await expect(
      diagnostics.step("recover", "start", () => {
        throw error;
      }),
    ).rejects.toBe(error);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
