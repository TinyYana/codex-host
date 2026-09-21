import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  NativeAccountQuotas,
  parseWhamAccountCredits,
} from "../src/account/native-account-quotas.js";
import { createAccountState, credential } from "./fixtures/codex-account-fixtures.js";
const states: Awaited<ReturnType<typeof createAccountState>>[] = [];
afterEach(async () => {
  await Promise.all(states.splice(0).map((s) => s.close()));
});
async function setup() {
  const state = await createAccountState();
  states.push(state);
  return state;
}
describe("inactive account quotas", () => {
  it("parses bounded renderer quota fields", () => {
    expect(
      parseWhamAccountCredits({
        rate_limit: {
          primary_window: {
            used_percent: "37.5",
            limit_window_seconds: 18000,
            reset_at: 2_000_000_000,
          },
          secondary_window: { used_percent: 12, limit_window_seconds: 604800 },
        },
        rate_limit_reset_credits: { available_count: 2 },
        ignored_secret: "never-project",
      }),
    ).toMatchObject({
      usedPercent: 37.5,
      periodType: "five_hour",
      productUsage: [{ product: "7-day window", usagePercent: 12 }],
      resetCredits: { availableCount: 2 },
    });
  });
  it("marks a rejected refresh grant unusable and never fabricates quota for it", async () => {
    const { store } = await setup();
    await store.install(credential("a"));
    await store.captureCurrent();
    const b = await store.save(credential("b", 1, 1)); // access token already expired
    let rejectRefresh = true;
    const quotas = new NativeAccountQuotas({
      directory: store.directory,
      credentials: store,
      fetch: async (input) => {
        if (String(input).endsWith("/oauth/token")) {
          if (rejectRefresh) return new Response("{}", { status: 400 });
          const oauth = credential("b", 2).managedOAuthCredential();
          return Response.json({ access_token: oauth.accessToken });
        }
        return Response.json({
          rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18000 } },
        });
      },
    });
    const account = store.vault.accounts.find((entry) => entry.accountId === b);
    if (!account) throw new Error("Missing fixture Account");
    expect(quotas.credentialUsable(b)).toBe(true);
    await expect(quotas.inspect(account, true)).rejects.toMatchObject({ code: "unavailable" });
    expect(quotas.credentialUsable(b)).toBe(false);
    expect(quotas.get(b)).toBeNull();
    // A later successful read (for example after a native re-login) lifts the quarantine.
    rejectRefresh = false;
    await expect(quotas.inspect(account, true)).resolves.toMatchObject({
      accountCredits: { usedPercent: 20 },
    });
    expect(quotas.credentialUsable(b)).toBe(true);
  });
  it("refreshes only B's saved grant without overwriting C or permanent auth", async () => {
    const { store, runtime } = await setup();
    await store.install(credential("a"));
    await store.captureCurrent();
    const b = await store.save(credential("b", 1, 1)),
      c = await store.save(credential("c"));
    const started = Promise.withResolvers<undefined>(),
      resume = Promise.withResolvers<undefined>();
    const quotas = new NativeAccountQuotas({
      directory: store.directory,
      credentials: store,
      admitCredentialRefresh: () => runtime.gate.admit("credential-write"),
      fetch: async (input) => {
        if (String(input).endsWith("/oauth/token")) {
          started.resolve(undefined);
          await resume.promise;
          const oauth = credential("b", 2).managedOAuthCredential();
          return Response.json({
            access_token: oauth.accessToken,
            refresh_token: oauth.refreshToken,
          });
        }
        return Response.json({
          rate_limit: { primary_window: { used_percent: 23, limit_window_seconds: 18000 } },
        });
      },
    });
    const inspection = quotas.inspect(
      required(store.vault.accounts.find((a) => a.accountId === b)),
      true,
    );
    await started.promise;
    await store.mutate((next) => {
      required(next.accounts.find((a) => a.accountId === c)).label = "C changed";
    });
    resume.resolve(undefined);
    await expect(inspection).resolves.toMatchObject({ accountCredits: { usedPercent: 23 } });
    expect(store.vault.accounts.find((a) => a.accountId === c)?.label).toBe("C changed");
    expect(
      store
        .credential(required(store.vault.accounts.find((a) => a.accountId === b)))
        .managedOAuthCredential().refreshToken,
    ).toBe(credential("b", 2).managedOAuthCredential().refreshToken);
    expect((await store.readCredentials())?.serializeForNativeStore()).toBe(
      credential("a").serializeForNativeStore(),
    );
  });
  it("serializes cache patches and preserves other accounts on disk", async () => {
    const { store } = await setup();
    const a = await store.save(credential("a")),
      b = await store.save(credential("b"));
    const file = path.join(store.directory, "codex-quota-cache.json");
    const snapshot = {
      accountCredits: { usedPercent: 81, periodType: "weekly" },
      observedAt: new Date().toISOString(),
    };
    await writeFile(file, JSON.stringify({ version: 1, snapshots: { [b]: snapshot } }));
    const quotas = new NativeAccountQuotas({ directory: store.directory, credentials: store });
    await quotas.record(a, { usedPercent: 14, periodType: "five_hour" });
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.snapshots[b]).toEqual(snapshot);
    expect(saved.snapshots[a].accountCredits.usedPercent).toBe(14);
    await quotas.initialize(new Set([a, b]));
    expect(quotas.get(b)?.freshness).toBe("cached");
    await quotas.remove(a);
    expect(JSON.parse(await readFile(file, "utf8")).snapshots[a]).toBeUndefined();
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture");
  return value;
}
