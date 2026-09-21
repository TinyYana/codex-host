import type { AccountCreditsSnapshot } from "@codexhost/shared-contracts";

/**
 * Harness-neutral quota ranking. Pure: no I/O, no clock, no Codex types. It answers quota and
 * account questions only — never model quality. A future ModelRanker can reuse the candidate
 * summaries and narrow windows through `bindsSelection`.
 */
export type QuotaPeriod = AccountCreditsSnapshot["periodType"];
export type QuotaRankStrategy = "best" | "consume-first" | "waste-first";

/** Ranker-internal view of one limit. `AccountCreditsSnapshot` stays the only wire contract. */
export interface QuotaWindow {
  /** "account" for an account-wide window, otherwise the native product/model label. */
  scope: string;
  period: QuotaPeriod;
  usedPercent: number;
  resetsAtMs?: number;
}

export interface QuotaCandidate {
  id: string;
  current: boolean;
  /** False when the credential is missing or was rejected; such a candidate is never picked. */
  credentialUsable: boolean;
  /** Null means unknown. Unknown is never treated as unused or safe. */
  credits: AccountCreditsSnapshot | null;
  observedAtMs: number | null;
}

export type QuarantineReason = "credential-unusable" | "quota-unknown" | "quota-stale" | "exhausted";

export interface RankedCandidate {
  id: string;
  eligible: boolean;
  quarantine?: QuarantineReason;
  /** Least-headroom window that binds selection. */
  binding?: QuotaWindow;
  headroomPercent?: number;
  /** Reset of the longest binding-scope window: the deadline for headroom that would expire. */
  resetDeadlineMs?: number;
  /** 0..1 share of the long window's quota likely to expire unused. */
  wasteRisk?: number;
  score: number;
  reasons: string[];
}

export interface QuotaRankOptions {
  strategy?: QuotaRankStrategy;
  nowMs: number;
  /** Observations older than this are stale and cannot be auto-selected. */
  maxAgeMs?: number;
  /** Headroom at or below this is a quota wall. */
  wallHeadroomPercent?: number;
  /** Score advantage a challenger needs over an eligible current candidate. */
  hysteresisMargin?: number;
  cooldownMs?: number;
  lastSwitchAtMs?: number;
  /** Which windows bind selection. Default: account-wide only (model-scoped limits need a
   * ModelProfile this layer does not have). */
  bindsSelection?(window: QuotaWindow): boolean;
}

export interface QuotaRankResult {
  strategy: QuotaRankStrategy;
  recommendedId: string | null;
  entries: RankedCandidate[];
}

const PERIOD_MS: Partial<Record<QuotaPeriod, number>> = {
  five_hour: 5 * 3_600_000,
  seven_day: 7 * 86_400_000,
  weekly: 7 * 86_400_000,
  monthly: 30 * 86_400_000,
};

const GENERIC_PRODUCTS: Record<string, QuotaPeriod> = {
  "5-hour window": "five_hour",
  "7-day window": "seven_day",
  "weekly window": "weekly",
  "monthly window": "monthly",
};

function resetMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Flatten a snapshot into windows. Percentages are never merged or summed. */
export function quotaWindows(credits: AccountCreditsSnapshot): QuotaWindow[] {
  const at = resetMs(credits.resetsAt);
  const windows: QuotaWindow[] = [
    {
      scope: credits.label ?? "account",
      period: credits.periodType,
      usedPercent: credits.usedPercent,
      ...(at !== undefined ? { resetsAtMs: at } : {}),
    },
  ];
  for (const product of credits.productUsage ?? []) {
    const generic = GENERIC_PRODUCTS[product.product.toLowerCase()];
    const productReset = resetMs(product.resetsAt);
    windows.push({
      scope: generic ? "account" : product.product,
      period: generic ?? "unknown",
      usedPercent: product.usagePercent,
      ...(productReset !== undefined ? { resetsAtMs: productReset } : {}),
    });
  }
  return windows;
}

function headroom(window: QuotaWindow, nowMs: number): number {
  // A window whose reset has passed since observation has been refilled by the provider.
  if (window.resetsAtMs !== undefined && window.resetsAtMs <= nowMs) return 100;
  return Math.max(0, 100 - window.usedPercent);
}

function derive(candidate: QuotaCandidate, options: Required<Omit<QuotaRankOptions, "lastSwitchAtMs">>) {
  const entry: RankedCandidate = { id: candidate.id, eligible: false, score: -1, reasons: [] };
  const quarantine = (reason: QuarantineReason, text: string): RankedCandidate => {
    entry.quarantine = reason;
    entry.reasons.push(text);
    return entry;
  };
  const bindingWindows = candidate.credits
    ? quotaWindows(candidate.credits).filter(options.bindsSelection)
    : [];
  if (bindingWindows.length > 0) {
    const binding = bindingWindows.reduce((least, window) =>
      headroom(window, options.nowMs) < headroom(least, options.nowMs) ? window : least,
    );
    entry.binding = binding;
    entry.headroomPercent = headroom(binding, options.nowMs);
    const long = bindingWindows.reduce((longest, window) =>
      (PERIOD_MS[window.period] ?? 0) > (PERIOD_MS[longest.period] ?? 0) ? window : longest,
    );
    const length = PERIOD_MS[long.period];
    if (long.resetsAtMs !== undefined && long.resetsAtMs > options.nowMs) {
      entry.resetDeadlineMs = long.resetsAtMs;
      if (length !== undefined) {
        const elapsed = 1 - Math.min(1, (long.resetsAtMs - options.nowMs) / length);
        entry.wasteRisk = (headroom(long, options.nowMs) / 100) * elapsed;
      }
    }
  }
  if (!candidate.credentialUsable)
    return quarantine("credential-unusable", "Credential needs a native re-login");
  if (!entry.binding || candidate.observedAtMs === null)
    return quarantine("quota-unknown", "Quota is unknown; unknown is never treated as unused");
  if (options.nowMs - candidate.observedAtMs > options.maxAgeMs)
    return quarantine("quota-stale", "Quota observation is stale; refresh before auto-selecting");
  if (entry.headroomPercent! <= options.wallHeadroomPercent)
    return quarantine(
      "exhausted",
      `${entry.binding.period} window has ${entry.headroomPercent!.toFixed(0)}% headroom left`,
    );
  entry.eligible = true;
  const waste = entry.wasteRisk ?? 0;
  entry.score =
    options.strategy === "consume-first"
      ? 100 - entry.headroomPercent!
      : options.strategy === "waste-first"
        ? waste * 100
        : entry.headroomPercent! + waste * 50;
  entry.reasons.push(
    `${entry.headroomPercent!.toFixed(0)}% headroom on the binding ${entry.binding.period} window`,
  );
  if (waste >= 0.2)
    entry.reasons.push(`${(waste * 100).toFixed(0)}% of the long window would expire unused`);
  return entry;
}

/**
 * Rank candidates. The current candidate keeps the recommendation unless it is ineligible or a
 * challenger beats it by `hysteresisMargin` outside the switch cooldown, so two similar accounts
 * never ping-pong.
 */
export function rankAccountCandidates(
  candidates: readonly QuotaCandidate[],
  input: QuotaRankOptions,
): QuotaRankResult {
  const options = {
    strategy: input.strategy ?? "best",
    nowMs: input.nowMs,
    maxAgeMs: input.maxAgeMs ?? 15 * 60_000,
    wallHeadroomPercent: input.wallHeadroomPercent ?? 3,
    hysteresisMargin: input.hysteresisMargin ?? 10,
    cooldownMs: input.cooldownMs ?? 10 * 60_000,
    bindsSelection: input.bindsSelection ?? ((window: QuotaWindow) => window.scope === "account"),
  };
  const entries = candidates.map((candidate) => derive(candidate, options));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const current = candidates.find((candidate) => candidate.current);
  const currentEntry = current ? byId.get(current.id) : undefined;
  const best = entries
    .filter((entry) => entry.eligible)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))[0];
  let recommendedId = best?.id ?? null;
  if (currentEntry?.eligible && best && best.id !== currentEntry.id) {
    const cooling =
      input.lastSwitchAtMs !== undefined && input.nowMs - input.lastSwitchAtMs < options.cooldownMs;
    if (cooling) {
      recommendedId = currentEntry.id;
      currentEntry.reasons.push("Kept: within the switch cooldown");
    } else if (best.score - currentEntry.score < options.hysteresisMargin) {
      recommendedId = currentEntry.id;
      currentEntry.reasons.push("Kept: no challenger clears the hysteresis margin");
    }
  }
  // An ineligible current candidate skips hysteresis and cooldown: staying would hit the wall.
  return {
    strategy: options.strategy,
    recommendedId,
    entries: entries.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)),
  };
}
