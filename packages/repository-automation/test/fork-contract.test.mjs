import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (file) => readFile(path.join(root, file), "utf8");

/**
 * Capabilities TinyYana/codex-host_TinyYanaFork keeps on top of upstream. An upstream merge
 * must not drop their code, their Host wiring, or the tests that exercise
 * them: Vitest discovers tests by glob, so a deleted test file would otherwise
 * shrink coverage silently. Behavior itself is covered by the listed tests.
 */
const FORK_CAPABILITIES = [
  {
    name: "Codex managed accounts",
    wiring: [
      {
        file: "packages/host-runtime/src/app-server-host.ts",
        includes: ["CodexAccountRequests", "CodexAccountAutoSwitch"],
      },
      {
        file: "packages/host-runtime/src/codex-account-requests.ts",
        includes: ['"codexhost/account/list"', '"codexhost/account/save-current"'],
      },
      {
        file: "packages/renderer-extension/src/settings/accounts-page.ts",
        includes: ["codex-account-manage"],
      },
    ],
    sources: [
      "packages/host-runtime/src/account/native-codex-accounts.ts",
      "packages/host-runtime/src/account/native-account-store.ts",
      "packages/host-runtime/src/account/native-account-quotas.ts",
      "packages/host-runtime/src/account/quota-ranker.ts",
      "packages/host-runtime/src/account/account-auto-switch.ts",
      "packages/renderer-extension/src/renderer-codex-account-switch.ts",
      "packages/renderer-extension/src/settings/codex-account-manage.ts",
    ],
    tests: [
      "packages/host-runtime/test/native-codex-accounts.test.ts",
      "packages/host-runtime/test/native-account-store.test.ts",
      "packages/host-runtime/test/native-account-quotas.test.ts",
      "packages/host-runtime/test/native-account-switch.integration.test.ts",
      "packages/host-runtime/test/quota-ranker.test.ts",
      "packages/host-runtime/test/account-auto-switch.test.ts",
      "packages/host-runtime/test/codex-account-requests.test.ts",
      "packages/renderer-extension/test/renderer-codex-account-switch.test.ts",
    ],
  },
  {
    name: "Claude Code Goal bridge",
    wiring: [
      {
        file: "packages/host-runtime/src/app-server-host.ts",
        includes: [
          '"thread/goal/set"',
          '"thread/settings/update"',
          "goalCommandObjective",
          "#beginRejectedGoalTurn",
        ],
      },
      {
        file: "packages/harness-adapter/src/text-session.ts",
        includes: ["HarnessGoalCapability", '"session.goal.changed"'],
      },
      {
        file: "packages/adapters/claude-code/src/claude-code-adapter.ts",
        includes: ["readonly goal: HarnessGoalCapability"],
      },
    ],
    sources: [
      "packages/host-runtime/src/external-thread-goal.ts",
      "packages/adapters/claude-code/src/claude-goal.ts",
      "docs/harnesses/claude-code/claude-code-goal.md",
    ],
    tests: [
      "packages/host-runtime/test/app-server-host.goal.test.ts",
      "packages/host-runtime/test/external-thread-goal.test.ts",
      "packages/adapters/claude-code/test/claude-goal.test.ts",
    ],
  },
  {
    name: "Fork-only release source",
    wiring: [
      {
        file: "packages/update-manager/src/github-release.ts",
        includes: ['"TinyYana/codex-host_TinyYanaFork"'],
      },
    ],
    sources: ["CREDITS.md", "third-party/opencodex.LICENSE"],
    tests: ["packages/update-manager/test/github-release.test.ts"],
  },
];

async function exists(file) {
  try {
    await access(path.join(root, file));
    return true;
  } catch {
    return false;
  }
}

describe("fork contract", () => {
  it.each(FORK_CAPABILITIES)("keeps $name code and tests", async (capability) => {
    const missing = [];
    for (const file of [...capability.sources, ...capability.tests]) {
      if (!(await exists(file))) missing.push(file);
    }
    expect(missing).toEqual([]);
  });

  it.each(FORK_CAPABILITIES)("keeps $name wired into its owners", async (capability) => {
    const missing = [];
    for (const { file, includes } of capability.wiring) {
      const source = (await exists(file)) ? await read(file) : "";
      for (const text of includes) if (!source.includes(text)) missing.push(`${file}: ${text}`);
    }
    expect(missing).toEqual([]);
  });

  it("syncs upstream by verified merges and ships them as fork Releases", async () => {
    const workflow = await read(".github/workflows/upstream-sync.yml");
    expect(workflow).toContain("git merge --no-ff");
    expect(workflow).not.toMatch(/git rebase|--force|push -f|reset --hard/u);
    // Quiet when upstream is merged and the version released; verified before main moves.
    expect(workflow).toContain("git merge-base --is-ancestor upstream/main HEAD");
    const contract = workflow.indexOf("fork-contract.test.mjs");
    const check = workflow.indexOf("run: npm run check");
    const push = workflow.indexOf("git push origin HEAD:refs/heads/main");
    expect(contract).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(contract);
    expect(push).toBeGreaterThan(check);
    // Conflicts needing judgment fail loudly with evidence instead of pushing a broken tree.
    expect(workflow).toContain("name: upstream-sync-conflict");
    expect(workflow).toContain("-f skip_npm=true");
    expect(workflow).not.toMatch(/secrets\./u);
    await expect(read(".github/workflows/ci.yml")).resolves.toContain("workflow_dispatch:");
  });

  it("offers only fork builds as updates", async () => {
    const source = await read("packages/update-manager/src/github-release.ts");
    expect(source).toContain(
      'export const CODEXHOST_RELEASE_REPOSITORIES = ["TinyYana/codex-host_TinyYanaFork"] as const;',
    );
  });
});
