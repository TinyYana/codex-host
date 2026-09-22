import { z } from "zod";
import { accountCreditsSnapshotSchema, threadUsageSnapshotSchema } from "./thread-usage.js";

const accountIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._~-]+$/u);
const nonBlankTextSchema = z.string().trim().min(1);

export const codexAccountPlanTypeSchema = z.enum([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_prolite",
  "self_serve_business_usage_based",
  "business",
  "ent26",
  "enterprise_cbp_automation",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "edu_plus",
  "edu_pro",
  "unknown",
]);
export type CodexAccountPlanType = z.infer<typeof codexAccountPlanTypeSchema>;

export const codexAccountSchema = z
  .object({
    accountId: accountIdSchema,
    label: nonBlankTextSchema.max(256),
    email: z.string().email().max(320).optional(),
    planType: codexAccountPlanTypeSchema.optional(),
    /** True for a managed (saved) Account; absent for a current native login not yet saved. */
    saved: z.boolean().optional(),
    /** Saved Account whose credential is missing or was rejected; needs a native re-login. */
    requiresLogin: z.boolean().optional(),
  })
  .strict();
export type CodexAccountSummary = z.infer<typeof codexAccountSchema>;

export const codexAccountPhaseSchema = z.enum(["ready", "changing", "unavailable"]);
export type CodexAccountPhase = z.infer<typeof codexAccountPhaseSchema>;

export const codexAccountPendingOperationSchema = z
  .object({
    operationId: nonBlankTextSchema.max(1_024),
    kind: z.enum(["save", "switch", "recovery"]),
  })
  .strict();
export type CodexAccountPendingOperation = z.infer<typeof codexAccountPendingOperationSchema>;

/** Absent on read-only deployments; every flag reflects what is possible right now. */
export const codexAccountCapabilitiesSchema = z
  .object({
    manage: z.boolean(),
    saveCurrent: z.boolean(),
    switch: z.boolean(),
    delete: z.boolean(),
    recover: z.boolean().optional(),
    reason: z.enum(["unsupported-storage", "recovery-required"]).optional(),
  })
  .strict();
export type CodexAccountCapabilities = z.infer<typeof codexAccountCapabilitiesSchema>;

export const codexAccountRankStrategySchema = z.enum(["best", "consume-first", "waste-first"]);
export type CodexAccountRankStrategy = z.infer<typeof codexAccountRankStrategySchema>;

/** Auto may change only the Codex Account, never Harness, Model, or reasoning profile. */
export const codexAccountAutoModeSchema = z
  .object({ enabled: z.boolean(), strategy: codexAccountRankStrategySchema })
  .strict();
export type CodexAccountAutoMode = z.infer<typeof codexAccountAutoModeSchema>;

export const codexAccountListResultSchema = z
  .object({
    version: z.literal(2),
    currentAccountId: accountIdSchema.nullable(),
    phase: codexAccountPhaseSchema,
    revision: z.number().int().nonnegative(),
    instanceId: nonBlankTextSchema.max(1_024).optional(),
    pendingOperation: codexAccountPendingOperationSchema.optional(),
    capabilities: codexAccountCapabilitiesSchema.optional(),
    auto: codexAccountAutoModeSchema.optional(),
    accounts: z.array(codexAccountSchema).max(128),
  })
  .strict();
export type CodexAccountListResult = z.infer<typeof codexAccountListResultSchema>;

export const codexAccountChangedSchema = codexAccountListResultSchema;
export type CodexAccountChanged = z.infer<typeof codexAccountChangedSchema>;

export const codexAccountUsageParamsSchema = z
  .object({ accountId: accountIdSchema, refresh: z.boolean().optional() })
  .strict();
export type CodexAccountUsageParams = z.infer<typeof codexAccountUsageParamsSchema>;
export const codexAccountUsageResultSchema = z
  .object({
    accountId: accountIdSchema,
    usage: threadUsageSnapshotSchema.nullable(),
    accountCredits: accountCreditsSnapshotSchema.optional(),
    freshness: z.enum(["live", "cached"]),
    observedAt: z.string().datetime().nullable(),
  })
  .strict();
export type CodexAccountUsageResult = z.infer<typeof codexAccountUsageResultSchema>;

const codexAccountIdParamsSchema = z.object({ accountId: accountIdSchema }).strict();

export const codexAccountSwitchParamsSchema = codexAccountIdParamsSchema;
export type CodexAccountSwitchParams = z.infer<typeof codexAccountSwitchParamsSchema>;
export const codexAccountDeleteParamsSchema = codexAccountIdParamsSchema;
export type CodexAccountDeleteParams = z.infer<typeof codexAccountDeleteParamsSchema>;

/** Every manage request answers with the post-operation list; no credential material. */
export const codexAccountMutationResultSchema = codexAccountListResultSchema;
export type CodexAccountMutationResult = z.infer<typeof codexAccountMutationResultSchema>;

export const codexAccountAutoUpdateParamsSchema = codexAccountAutoModeSchema.partial().strict();
export type CodexAccountAutoUpdateParams = z.infer<typeof codexAccountAutoUpdateParamsSchema>;

/** Explainable quota ranking for one Account. Quota facts only; never a model-quality score. */
export const codexAccountRankEntrySchema = z
  .object({
    accountId: accountIdSchema,
    eligible: z.boolean(),
    bindingPeriod: z.enum(["weekly", "monthly", "five_hour", "seven_day", "unknown"]).optional(),
    headroomPercent: z.number().finite().min(0).max(100).optional(),
    resetsAt: z.string().min(1).optional(),
    reasons: z.array(nonBlankTextSchema.max(512)).max(16),
  })
  .strict();
export type CodexAccountRankEntry = z.infer<typeof codexAccountRankEntrySchema>;

export const codexAccountRankingResultSchema = z
  .object({
    strategy: codexAccountRankStrategySchema,
    recommendedAccountId: accountIdSchema.nullable(),
    entries: z.array(codexAccountRankEntrySchema).max(128),
  })
  .strict();
export type CodexAccountRankingResult = z.infer<typeof codexAccountRankingResultSchema>;
