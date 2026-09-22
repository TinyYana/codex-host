import { hostThreadIdSchema, type HostThreadId } from "@codexhost/shared-contracts";

/** A failed Turn as reported by `turn/completed`. No error text: the UI never shows raw errors. */
export interface CodexTurnFailure {
  readonly threadId: HostThreadId;
  /**
   * The official error classified this failure as a usage limit. This repository has no fixture
   * of that payload, so the flag is only a hint: it never enables a retry by itself.
   */
  readonly usageLimit: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUsageLimitInfo(info: unknown): boolean {
  const name = typeof info === "string" ? info : isRecord(info) ? Object.keys(info)[0] : undefined;
  return name === "usageLimitExceeded" || name === "usage_limit_exceeded";
}

/** Null for anything other than a well-formed `turn/completed` whose Turn failed. */
export function codexTurnFailureFromNotification(notification: unknown): CodexTurnFailure | null {
  if (!isRecord(notification) || notification.method !== "turn/completed") return null;
  const params = notification.params;
  if (!isRecord(params) || !isRecord(params.turn) || params.turn.status !== "failed") return null;
  const threadId = hostThreadIdSchema.safeParse(params.threadId);
  if (!threadId.success) return null;
  const error = params.turn.error;
  return {
    threadId: threadId.data,
    usageLimit: isRecord(error) && isUsageLimitInfo(error.codexErrorInfo),
  };
}
