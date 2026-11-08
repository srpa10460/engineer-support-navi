// R5 利用者向けの固定メッセージと原因分類の対応（PATCH-5.3 第 7.3、7.4 節。文言は暫定案で、Human の最終確認が必要）。
// 原則: 分割・短縮・言い換えでの再送を勧めない。上限値と検知方式を示さない。入力内容を応答に含めない。
import type { CauseDetail } from "@/lib/safetyGate";

// 応答に出す利用者向けの 4 分類（内部の 6 分類は監査記録にのみ残す）
export type PublicCause = "rule_hit" | "undecidable" | "overload" | "invalid_request";

export function publicCause(c: CauseDetail | undefined): PublicCause {
  switch (c) {
    case "invalid_action":
      return "invalid_request";
    case "undecidable_size":
    case "undecidable_decode":
    case "undecidable_truncation":
      return "undecidable";
    case "overload":
      return "overload";
    default:
      return "rule_hit";
  }
}

// 判定不能・過負荷の応答では、内部診断文（上限値・段数など）を出さず固定文にする
export const SAFE_REASON_UNDECIDABLE = "自動では安全に判定できないため拒否しました（fail-closed）。";
export const SAFE_REASON_OVERLOAD = "処理が混み合っているため受け付けられませんでした。";

export function safeReason(c: CauseDetail | undefined, original: string | null): string | null {
  const p = publicCause(c);
  if (p === "undecidable") return SAFE_REASON_UNDECIDABLE;
  if (p === "overload") return SAFE_REASON_OVERLOAD;
  return original;
}

export function userMessage(cause: PublicCause, storeRoute: boolean): string {
  switch (cause) {
    case "rule_hit":
      return storeRoute
        ? "この操作は安全上の理由で停止しました。内容は保存されていません。上級SEまたは担当者に相談してください。"
        : "この操作は安全上の理由で停止しました。上級SEまたは担当者に相談してください。";
    case "undecidable":
      return storeRoute
        ? "入力内容を自動では安全に判定できなかったため、保存・実行していません。内容を変えたり分けたりして送り直すことはせず、上級SEまたは担当者に相談してください。"
        : "入力内容を自動では安全に判定できなかったため、実行していません。内容を変えたり分けたりして送り直すことはせず、上級SEまたは担当者に相談してください。";
    case "overload":
      return "ただいま処理が混み合っています。しばらく時間をおいてから、同じ内容でもう一度お試しください。";
    case "invalid_request":
      return "リクエストの形式が正しくありません。画面または連携先の設定を確認してください。";
  }
}

export const MESSAGE_STORE_UNKNOWN = "保存されたかどうかを確認できませんでした。自動での再送はせず、案件一覧で保存の有無を確認してください。";
export const MESSAGE_STORE_FAILED = "内部エラーのため保存されていません。しばらく時間をおいてからもう一度お試しください。";
export const MESSAGE_STORED_BUT_FAILED = "保存されましたが、応答の生成中にエラーが発生しました。案件一覧で内容を確認してください。";
