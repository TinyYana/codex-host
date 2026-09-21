# Tasks

## 1. Contracts

- [x] 1.1 Extend `shared-contracts/src/codex-accounts.ts`: N accounts, per-account `{current, saved, health, credits?}`, phase `changing`, manage capabilities, params/results for save-current, switch, delete, auto-mode read/update; no credential material.
- [x] 1.2 Renderer model client methods + snapshot version gate reuse.

## 2. Host account core

- [x] 2.1 Vault store (`account/native-account-store.ts`): v3 read/write, v1–v3 upgrade, 0700/0600, atomic replace, serialized mutations.
- [x] 2.2 Credential identity (`account/native-codex-credentials.ts`): auth.json parse, JWT claims (sub/workspace/email/plan), same-identity and newer-generation predicates; storage-support checks.
- [x] 2.3 `OfficialWorkGate`: `changing` phase + change lease; admission failures stay fixed-form.
- [x] 2.4 Owner/scope restart path for the switch transaction (stop with exit proof → start), generation retire reused for stale isolation.
- [x] 2.5 Switch transaction (`account/native-codex-accounts.ts`): idle assert (gate lease + Turn idle probe), capture/install/verify/rollback, newer-generation preservation, unsafe-external-process detection, fixed-form errors, current derivation.
- [x] 2.6 `app-server-host.ts` routing: manage RPCs, phase/notification plumbing, per-saved-account usage inspect.

## 3. Quota + ranker

- [x] 3.1 Saved-account usage (`account/native-account-quotas.ts`): usage endpoint projection to `AccountCreditsSnapshot`, per-account single-flight OAuth refresh, health states, cooldown + cache, no fabricated values.
- [x] 3.2 Quota ranker (`account/quota-ranker.ts`): pure derivation (binding window, headroom, reset deadline, health, waste risk), strategies best/consume-first/waste-first, hysteresis margin, cooldown, quarantine reasons.
- [x] 3.3 Auto-switch policy: host-side setting (default off), safe-boundary evaluation via active-work signals, transaction reuse.

## 4. Renderer

- [x] 4.1 Settings accounts: managed Codex rows (save current, switch, delete non-current) with per-account quota; other Harness rows untouched; capability-gated.
- [x] 4.2 Composer credits surface: current identity + binding window + manual switch; Auto toggle.
- [x] 4.3 Switch & Retry affordance on quota-wall Turn failure; explicit confirmation, no silent replay.

## 5. Tests

- [x] 5.1 Vault store: atomicity, permissions, unknown-field preservation, legacy upgrade.
- [x] 5.2 Switch transaction: success, busy refusal (active Turn, native auth), verify-failure rollback, rollback preserving newer generation, rollback failure → unavailable, stale/late response isolation, external-process unsafe error, concurrent switch requests.
- [x] 5.3 Quota: endpoint projection, unknown ≠ 0%, refresh failure → quarantine health.
- [x] 5.4 Ranker: strategies, hysteresis/ping-pong, cooldown, quarantine, waste risk.
- [x] 5.5 Renderer/e2e: settings management flow, identity gating, auto toggle.

## 6. Docs

- [x] 6.1 Rewrite `docs/product/codex-accounts.md` + switching design doc for the new contract; migration notes for leftover vaults; update `docs/index.md`.

## 7. Human acceptance (needs real accounts / real Desktop)

- [ ] 7.1 Save two real ChatGPT accounts, switch both ways, confirm Desktop identity and quota follow.
- [ ] 7.2 Confirm the official usage-limit `turn/completed` payload and the Switch & Retry offer on a real quota wall.
- [ ] 7.3 Confirm `-32086` `data.code` survives the Desktop request client; light-theme visual pass.
