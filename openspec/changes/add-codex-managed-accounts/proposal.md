# Add Codex managed accounts, unified quota ranking, and safe switching

## Why

Daily Codex use with more than one ChatGPT account currently requires leaving CodexHost: the Settings accounts page is read-only, and the only way to change identity is official logout/login. Users need to keep several Codex accounts usable, see every account's real quota windows side by side, and switch safely without corrupting native state. Earlier attempts existed (PR #117 per-account backend pool, PR #262 native global switching) and were removed by `remove-codex-multi-account`; this change supersedes that removal contract with a narrower, transaction-safe scope that reuses the surviving read-only account and quota infrastructure.

## What Changes

- **BREAKING (product contract)**: Supersedes `openspec/changes/remove-codex-multi-account`. Host again owns a Codex credential vault and a global account switch, with the narrower boundaries below. `openspec/changes/implement-codex-native-accounts` remains an unedited historical record.
- Add a Host-owned Codex account vault at `<CODEX_HOME>/.codexhost-native-accounts/` (v3 format, compatible with 0.8.x/0.9 leftovers). Credentials are opaque: full native `auth.json` text is stored verbatim, unknown fields preserved, never exposed to Renderer, logs, error text, or public contracts.
- Accounts are added by **explicit save of the current native login** after official Desktop login. No Host device-code login, no login app-server. Official Desktop `account/login/*` / `account/logout` stay on the official backend.
- Add a controlled switch transaction: capture current credential → assert idle (`changing` work-gate phase, bounded drain of in-flight official requests) → stop the owned backend with exit proof → atomically install the target credential → start the backend → verify identity via official `account/read` → only then update current/UI. Failure rolls back; rollback preserves a newer same-account credential generation. External Codex processes are never killed for a switch; when they make a switch unsafe the switch fails with an explicit busy/unsafe error.
- Unified quota on the existing `AccountCreditsSnapshot` / `inspectAccount()` architecture: current Codex account keeps official `account/rateLimits/read`; each saved account gets read-only usage via the ChatGPT usage endpoint with per-account single-flight token refresh. Unknown quota is presented as unknown, never as 0% used or safe; percentages from different plans are never summed.
- Add a Harness-neutral, pure **quota ranker** deriving binding window, headroom, reset deadline, credential health, and waste risk per candidate, with explainable strategies (`best` default, `consume-first`, `waste-first`), hysteresis + cooldown against ping-pong, and quarantine of unhealthy candidates with reasons.
- Renderer: Settings → Accounts manages Codex accounts (save current, list with per-account quota, switch, delete non-current) while other Harness rows stay read-only. The composer credits surface shows current Codex identity plus the binding quota window and offers manual switch. An **Auto** mode (default off) may switch only the Codex account at safe Turn boundaries — never Harness, Model, reasoning profile, or Provider. When an active Turn fails at a quota wall and another account has headroom, the UI offers an explicit Switch & Retry; the Host never silently replays a partially executed Turn.

## Capabilities

### New Capabilities

- `codex-managed-accounts`: Host-owned Codex account vault, explicit save, list, delete, and the transaction-safe global switch.
- `codex-account-quota-ranking`: multi-account quota observation on the shared snapshot contract, the quota ranker, Auto account selection, and Switch & Retry.

### Removed Capabilities

- `codex-multi-account-removal` (defined by `remove-codex-multi-account`, never archived to `openspec/specs/`): its SHALL NOTs on vault storage, auth replacement, and switch-time backend stop are replaced by the requirements of this change. Its boundaries on official Desktop authentication, reset credits display-only, and other-Harness read-only rows are re-affirmed here unchanged.

## Impact

- Host Runtime: new `account/` modules (vault store, credential identity, switch transaction, saved-account quotas, quota ranker, auto-switch policy); `OfficialWorkGate` regains a `changing` phase; the official runtime owner gains a restart path used only by the switch transaction.
- Shared contracts: `codex-accounts.ts` grows to N accounts with per-account credits/health and manage/switch capabilities; no credential material in any browser-safe type.
- Renderer: Settings accounts management actions, composer identity/binding-quota/switch surface, Auto mode control, Switch & Retry affordance. Other Harness `inspectAccount()` rows and existing quota rendering are unchanged.
- Docs and tests: feature docs under `docs/product/`, focused unit/integration tests for the switch transaction, quota projection, and ranker; e2e coverage for the settings page management flow.
