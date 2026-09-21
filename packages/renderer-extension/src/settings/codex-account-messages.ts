import type { CodexAccountRankStrategy } from "@codexhost/shared-contracts";

/** Codex Account management copy, shared by Settings and the Composer credits popover. */
export const codexAccountEnglish = {
  unsavedBadge: "Not saved",
  requiresLoginBadge: "Sign-in needed",
  requiresLoginHint:
    "The saved sign-in no longer works. Sign in to this account in Codex Desktop, then save it again.",
  saveCurrent: "Save current account",
  saving: "Saving…",
  saved: "Current account saved.",
  switchAction: "Switch",
  switchLabel: "Switch to {name}",
  switching: "Switching account…",
  switched: "Switched to {name}.",
  deleteAction: "Remove",
  deleteLabel: "Remove saved account {name}",
  deleteConfirm:
    "Remove the saved account {name}? Only the copy kept by CodexHost is removed; the native sign-in stays as it is.",
  deleting: "Removing…",
  recover: "Repair",
  recovering: "Repairing…",
  recoveryRequired:
    "An account switch did not finish cleanly. Repair restores a verified sign-in before anything else can change.",
  changing: "An account change is in progress…",
  unsupportedStorage:
    "This sign-in uses an API key or the system keyring, so accounts cannot be saved or switched here.",
  guideTitle: "Add another account",
  guideLabel: "How to add another Codex account",
  guideLines: [
    "Sign in to the other account with the official Codex Desktop sign-in.",
    "Return to this page and choose Save current account.",
    "Saved accounts can then be switched here or next to the Composer without signing in again.",
  ],
  autoSection: "Codex account selection",
  autoTitle: "Switch automatically",
  autoDescription: "Between Turns, move to the saved account whose quota fits best.",
  autoHelpLabel: "About automatic account switching",
  autoHelp: [
    "Auto only changes the Codex account. Agent, Model and reasoning settings stay as they are.",
    "A switch only happens between Turns, never while one is running.",
    "Accounts with unknown quota or a sign-in problem are never picked automatically.",
  ],
  strategyTitle: "Strategy",
  strategies: {
    best: {
      label: "Balanced",
      description: "Avoid running into a limit while not letting quota expire unused.",
    },
    "consume-first": {
      label: "Use up first",
      description: "Finish the account with the least quota left before moving on.",
    },
    "waste-first": {
      label: "Expiring first",
      description: "Spend quota that would otherwise expire at the next reset.",
    },
  } satisfies Record<CodexAccountRankStrategy, { label: string; description: string }>,
  rankRecommended: "Recommended",
  rankHeadroom: "{period} · {percent} left",
  rankNotEligible: "Not picked automatically",
  composerTitle: "Codex account",
  composerTightest: "Tightest limit: {detail}",
  composerNoOthers: "No other saved accounts. Save more in Settings → Accounts.",
  composerAuto: "Auto",
  quotaWall: "This account's quota is used up.",
  quotaWallUncertain:
    "The Turn failed, possibly because of a usage limit. You can switch accounts manually.",
  switchAndRetry: "Switch to {name} and retry",
  retryRestored:
    "Switched to {name}. Your last message is back in the input box; review it and send when ready.",
  retryPending: "Switched to {name}. Nothing was sent again.",
  retryRestore: "Put my last message back",
  dismiss: "Dismiss",
  failed: "The account operation could not be completed.",
  errors: {
    busy: "A Turn is running. Wait for it to finish, then try again.",
    changing: "Another account change is in progress.",
    unavailable: "Codex account management is unavailable right now.",
    "unknown-account": "This saved account no longer exists. Refresh the list.",
    "requires-login":
      "The saved sign-in no longer works. Sign in to this account in Codex Desktop, then save it again.",
    "unsupported-storage":
      "This sign-in uses an API key or the system keyring, so accounts cannot be saved or switched here.",
    "credential-conflict":
      "The native sign-in changed during the operation. Refresh and try again.",
    "authentication-failed": "The account could not be verified. Sign in again in Codex Desktop.",
    "switch-failed": "The switch failed and the previous account was restored.",
    "unsafe-external-process":
      "Another Codex process is using the same Codex home. Close it, then try again.",
    "recovery-required": "An earlier switch did not finish cleanly. Use Repair first.",
  },
};
export type CodexAccountMessages = typeof codexAccountEnglish;

export const codexAccountChinese: CodexAccountMessages = {
  unsavedBadge: "尚未保存",
  requiresLoginBadge: "需重新登入",
  requiresLoginHint: "已保存的登入已失效。請在 Codex Desktop 重新登入這個帳號，再回來保存一次。",
  saveCurrent: "保存目前帳號",
  saving: "正在保存…",
  saved: "已保存目前帳號。",
  switchAction: "切換",
  switchLabel: "切換到 {name}",
  switching: "正在切換帳號…",
  switched: "已切換到 {name}。",
  deleteAction: "刪除",
  deleteLabel: "刪除已保存的帳號 {name}",
  deleteConfirm: "要刪除已保存的帳號 {name} 嗎？只會移除 CodexHost 保存的副本，原生登入不受影響。",
  deleting: "正在刪除…",
  recover: "修復",
  recovering: "正在修復…",
  recoveryRequired: "上一次帳號切換沒有完整結束。請先修復，恢復到已驗證的登入後才能繼續操作。",
  changing: "帳號變更進行中…",
  unsupportedStorage: "目前的登入使用 API Key 或系統鑰匙圈，無法在這裡保存或切換帳號。",
  guideTitle: "新增其他帳號",
  guideLabel: "如何新增其他 Codex 帳號",
  guideLines: [
    "先用 Codex Desktop 的官方登入流程登入另一個帳號。",
    "回到這個頁面，按「保存目前帳號」。",
    "保存後就能在這裡或輸入框旁切換，不必重新登入。",
  ],
  autoSection: "Codex 帳號選擇",
  autoTitle: "自動切換",
  autoDescription: "在 Turn 之間，自動換到額度最合適的已保存帳號。",
  autoHelpLabel: "關於自動切換帳號",
  autoHelp: [
    "Auto 只會更換 Codex 帳號，不會改動 Agent、Model 或推理設定。",
    "只在 Turn 之間切換，Turn 進行中不會切換。",
    "額度未知或登入有問題的帳號不會被自動選中。",
  ],
  strategyTitle: "策略",
  strategies: {
    best: { label: "平衡", description: "避免撞上額度上限，同時不讓額度在重置時白白過期。" },
    "consume-first": { label: "先用完", description: "先把剩餘額度最少的帳號用完，再換下一個。" },
    "waste-first": { label: "快過期優先", description: "優先使用下次重置時會過期的額度。" },
  },
  rankRecommended: "建議",
  rankHeadroom: "{period} · 剩餘 {percent}",
  rankNotEligible: "不會被自動選中",
  composerTitle: "Codex 帳號",
  composerTightest: "最緊的限制：{detail}",
  composerNoOthers: "沒有其他已保存的帳號。可到「設定 → 帳號」保存更多帳號。",
  composerAuto: "Auto",
  quotaWall: "這個帳號的額度已用盡。",
  quotaWallUncertain: "這個 Turn 失敗了，可能是額度限制造成的。你可以手動切換帳號。",
  switchAndRetry: "切換到 {name} 並重試",
  retryRestored: "已切換到 {name}。剛才的訊息已放回輸入框，確認後再送出。",
  retryPending: "已切換到 {name}。沒有重新送出任何內容。",
  retryRestore: "把剛才的訊息放回輸入框",
  dismiss: "關閉提示",
  failed: "帳號操作無法完成。",
  errors: {
    busy: "有 Turn 正在進行。請等它結束後再試。",
    changing: "另一個帳號變更正在進行中。",
    unavailable: "Codex 帳號管理目前無法使用。",
    "unknown-account": "這個已保存的帳號已不存在，請重新整理清單。",
    "requires-login": "已保存的登入已失效。請在 Codex Desktop 重新登入這個帳號，再回來保存一次。",
    "unsupported-storage": "目前的登入使用 API Key 或系統鑰匙圈，無法在這裡保存或切換帳號。",
    "credential-conflict": "操作期間原生登入發生了變化，請重新整理後再試。",
    "authentication-failed": "無法驗證這個帳號。請在 Codex Desktop 重新登入。",
    "switch-failed": "切換失敗，已恢復成原本的帳號。",
    "unsafe-external-process": "偵測到其他 Codex 行程正在使用同一個 Codex home，請先關閉它再試。",
    "recovery-required": "先前的切換沒有完整結束，請先執行修復。",
  },
};

export function codexAccountMessages(locale: "en" | "zh-CN"): CodexAccountMessages {
  return locale === "zh-CN" ? codexAccountChinese : codexAccountEnglish;
}

/** Host account failures use RPC code -32086 with a fixed `data.code`. */
const CODEX_ACCOUNT_ERROR_RPC_CODE = -32086;

export type CodexAccountErrorCode = keyof CodexAccountMessages["errors"];

export function codexAccountErrorCode(error: unknown): CodexAccountErrorCode | null {
  if (typeof error !== "object" || error === null) return null;
  const record = error as { code?: unknown; data?: unknown };
  if (record.code !== CODEX_ACCOUNT_ERROR_RPC_CODE) return null;
  const data = record.data;
  if (typeof data !== "object" || data === null) return null;
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" && Object.hasOwn(codexAccountEnglish.errors, code)
    ? (code as CodexAccountErrorCode)
    : null;
}

/** Localized, fixed text only: the raw error object and its message are never shown. */
export function codexAccountErrorText(error: unknown, messages: CodexAccountMessages): string {
  const code = codexAccountErrorCode(error);
  return code ? messages.errors[code] : messages.failed;
}
