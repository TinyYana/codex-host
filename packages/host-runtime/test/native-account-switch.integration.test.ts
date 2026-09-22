import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonObjectSchema } from "@codexhost/shared-contracts";
import type { JsonObject } from "@codexhost/protocol-core";
import { NativeAccountStore } from "../src/account/native-account-store.js";
import type { OfficialAppServerExit } from "../src/official-app-server-connection.js";
import { createOwnedLoopbackBackend } from "../src/codex-runtime/owned-official-backends.js";
import { prepareLocalCodex, type PreparedLocalCodex } from "../src/native-account-host.js";
import { credential } from "./fixtures/codex-account-fixtures.js";

vi.mock("../src/codex-runtime/owned-official-backends.js", () => ({
  createOwnedLoopbackBackend: vi.fn(),
}));
// The developer machine may run a real Codex CLI; process detection has its own unit tests.
vi.mock("../src/account/external-codex-processes.js", () => ({
  findExternalCodexProcesses: vi.fn(async () => []),
}));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.clearAllMocks();
});

/** A synthetic official backend whose identity is whatever auth.json currently holds. */
function nativeBackends(home: string, options: { lieAbout?: string } = {}) {
  const generations: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
  vi.mocked(createOwnedLoopbackBackend).mockImplementation(() => {
    const exit = Promise.withResolvers<OfficialAppServerExit>();
    const connections: Array<() => void> = [];
    const connect = vi.fn(async () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const closed = Promise.withResolvers<OfficialAppServerExit>();
      let pending = "";
      stdin.on("data", (chunk: Buffer) => {
        pending += chunk.toString();
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const request = jsonObjectSchema.parse(JSON.parse(pending.slice(0, newline)));
          pending = pending.slice(newline + 1);
          if (request.method === "initialized") continue;
          void (async () => {
            let result: JsonObject = { userAgent: "synthetic" };
            if (request.method === "config/read")
              result = { config: { cli_auth_credentials_store: "file" } };
            if (request.method === "account/read") {
              const text = await readFile(path.join(home, "auth.json"), "utf8").catch(() => null);
              const email = text ? credential_email(text) : null;
              // `lieAbout` models a backend that came up but is not the installed identity.
              result = {
                account:
                  email === null || email === options.lieAbout
                    ? null
                    : { type: "chatgpt", email, planType: "team" },
                requiresOpenaiAuth: true,
              };
            }
            stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
          })();
        }
      });
      const close = () => {
        stdin.end();
        stdout.end();
        stderr.end();
        closed.resolve({ code: 0, signal: null });
      };
      connections.push(close);
      return { stdin, stdout, stderr, closed: closed.promise, close };
    });
    const stop = vi.fn(async () => {
      for (const close of connections) close();
      exit.resolve({ code: 0, signal: null });
    });
    generations.push({ stop });
    return { closed: exit.promise, start: vi.fn(async () => {}), connect, stop };
  });
  return generations;
}

function credential_email(authJson: string): string {
  const token = (JSON.parse(authJson) as { tokens: { id_token: string } }).tokens.id_token;
  const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as {
    email: string;
  };
  return claims.email;
}

async function startWithTwoAccounts(options: { lieAbout?: string } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-account-switch-"));
  const home = path.join(directory, "codex-home");
  await mkdir(home, { recursive: true });
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  // Two Accounts saved earlier; A is the native login.
  const seed = new NativeAccountStore({ home });
  await seed.open();
  await seed.install(credential("a"));
  await seed.captureCurrent();
  const b = await seed.save(credential("b"));
  const a = seed.currentAccountId;
  await seed.close();
  const canonicalHome = new NativeAccountStore({ home }).home;
  const generations = nativeBackends(canonicalHome, options);
  const local: PreparedLocalCodex = await prepareLocalCodex({
    stockCodexPath: "/synthetic/codex",
    arguments: ["app-server"],
    environment: { CODEX_HOME: home },
    diagnosticOutput: new PassThrough(),
  });
  cleanups.push(() => local.close());
  await local.accountControl.refresh?.();
  return { local, home, a, b, generations };
}

describe("local Codex Account switch through the real backend owner", () => {
  it("lists both saved Accounts, restarts the owned backend, and updates current only after verification", async () => {
    const { local, home, a, b, generations } = await startWithTwoAccounts();
    const control = local.accountControl;
    expect(control.snapshot()).toMatchObject({
      currentAccountId: a,
      phase: "ready",
      capabilities: { manage: true, switch: true },
    });
    expect(control.snapshot().accounts.map((account) => account.accountId)).toEqual([a, b]);
    const generation = local.officialRuntimeScope.owner.generation;

    const phases: string[] = [];
    const unsubscribe = local.officialRuntimeScope.gate.subscribe(() =>
      phases.push(`${control.snapshot().phase}:${control.snapshot().currentAccountId === b}`),
    );
    await control.switch?.(b);
    unsubscribe();

    expect(control.snapshot()).toMatchObject({ currentAccountId: b, phase: "ready" });
    expect(await readFile(path.join(home, "auth.json"), "utf8")).toBe(
      credential("b").serializeForNativeStore(),
    );
    expect(generations).toHaveLength(2);
    expect(generations[0]?.stop).toHaveBeenCalledOnce();
    expect(local.officialRuntimeScope.owner.generation).toBeGreaterThan(generation);
    // Observers saw "changing" first; "ready" was published only with the verified identity.
    expect(phases[0]).toBe("changing:false");
    expect(phases.at(-1)).toBe("ready:true");
  });

  it("rolls back when the restarted backend does not report the installed identity", async () => {
    const { local, home, a, b } = await startWithTwoAccounts({ lieAbout: "b@example.com" });
    const control = local.accountControl;
    await expect(control.switch?.(b)).rejects.toMatchObject({ code: "authentication-failed" });
    expect(control.snapshot()).toMatchObject({ currentAccountId: a, phase: "ready" });
    expect(await readFile(path.join(home, "auth.json"), "utf8")).toBe(
      credential("a").serializeForNativeStore(),
    );
  }, 30_000);

  it("leaves config.toml and session files untouched by a switch", async () => {
    const { local, home, b } = await startWithTwoAccounts();
    await writeFile(path.join(home, "config.toml"), 'model = "gpt-5"\n');
    await mkdir(path.join(home, "sessions"), { recursive: true });
    await writeFile(path.join(home, "sessions", "rollout.jsonl"), "{}\n");
    await local.accountControl.switch?.(b);
    expect(await readFile(path.join(home, "config.toml"), "utf8")).toBe('model = "gpt-5"\n');
    expect(await readFile(path.join(home, "sessions", "rollout.jsonl"), "utf8")).toBe("{}\n");
  });
});
