## ADDED Requirements

### Requirement: Quota SHALL reuse the shared snapshot contract across accounts

Per-account quota SHALL be expressed as `AccountCreditsSnapshot`. The current Codex account SHALL keep official `account/rateLimits/read`. Saved non-current accounts SHALL use the read-only ChatGPT usage endpoint with per-account single-flight token refresh; window durations map 300min→five_hour and 10080min→seven_day, and other reported windows SHALL be preserved as named product windows rather than dropped or merged. Other Harness `inspectAccount()` rows SHALL be unaffected. Unknown or failed quota SHALL be shown as unavailable with its last observation time; it SHALL NOT be rendered as 0% used, 100% remaining, or auto-safe. Percentages from different accounts or plans SHALL NOT be summed into a combined total.

#### Scenario: Both accounts' windows visible

- **WHEN** two accounts are saved and quota for both is readable
- **THEN** Settings SHALL show each account's five-hour and seven-day windows and reset times independently

#### Scenario: Unknown quota stays unknown

- **WHEN** a saved account's usage query fails or its token cannot be refreshed
- **THEN** the row SHALL show unavailable (with any stale observation labeled), never 0% used
- **AND** existing Claude Code, Antigravity, and Grok read-only rows SHALL render exactly as before

### Requirement: Account ranking SHALL be a pure, explainable, Harness-neutral layer

Ranking SHALL be a pure function over candidate summaries deriving per candidate: binding window (least-headroom generic window), headroom, reset deadline, credential health, and waste risk. It SHALL support named strategies — `best` (default; balances not hitting a quota wall against not stranding quota that expires at reset), `consume-first`, and `waste-first` — and SHALL return human-readable reasons for every ranking and exclusion. Candidates with unhealthy credentials or unknown binding data SHALL be quarantined with a reason and SHALL NOT be auto-selected. Ranking SHALL NOT score model quality or compare across Providers; it answers quota and account questions only.

#### Scenario: Unknown data disqualifies auto selection

- **WHEN** a candidate has no fresh binding window
- **THEN** it SHALL be quarantined with an unknown-quota reason and excluded from auto selection while remaining manually switchable

#### Scenario: Hysteresis prevents ping-pong

- **WHEN** two healthy accounts have headroom within the configured margin
- **THEN** the ranker SHALL keep preferring the current account
- **AND** an account switched away from within the cooldown SHALL NOT be auto-selected again

### Requirement: Auto mode SHALL switch only the Codex account at safe boundaries

Auto account selection SHALL be off by default. When enabled it SHALL run the standard switch transaction only when no official or external Turn is active, and SHALL change nothing but the Codex account: Harness, Model, reasoning effort/profile, and Provider selection SHALL be unchanged by construction. Auto mode SHALL never switch to a quarantined candidate and SHALL respect ranking cooldowns.

#### Scenario: No switch during an active Turn

- **WHEN** auto mode wants a different account while a Turn is running
- **THEN** no switch occurs until active work has drained to a Turn boundary

#### Scenario: Auto never changes execution profile

- **WHEN** an auto switch completes
- **THEN** the selected Agent/Harness, Model, and reasoning settings before and after are identical

### Requirement: Quota-wall failures SHALL offer explicit Switch & Retry

When an active Turn fails and the current account's binding window is exhausted while another candidate has headroom, the UI SHALL offer an explicit Switch & Retry action that runs the switch transaction and, on user confirmation, re-submits the original user input as a new Turn. Host SHALL NOT automatically replay a Turn that already executed tool operations, and SHALL NOT retry silently.

#### Scenario: Wall hit with an alternative available

- **WHEN** a Turn fails at a quota wall and a healthy alternative account exists
- **THEN** the user is offered Switch & Retry and nothing is replayed without confirmation

#### Scenario: No silent replay

- **WHEN** detection of the quota wall is uncertain
- **THEN** the UI MAY offer manual switch but SHALL NOT offer or perform automatic retry
