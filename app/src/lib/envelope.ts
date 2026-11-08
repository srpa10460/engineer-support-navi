// 共通レスポンスエンベロープ（preparation/03_ARCHITECTURE.md §3 Common Response Envelope）
import type { StoreState } from "@/lib/caseStore";
import type { CauseDetail } from "@/lib/safetyGate";
import { publicCause, safeReason, userMessage } from "@/lib/userMessages";

export type Safety = { blocked: boolean; rule_id: string | null };

// R5: store_state は保存系ルート（POST /cases、device-search、device-confirm）の応答だけに付く（追加項目。data は変更しない）。
export type Envelope<T> = {
  ok: boolean;
  case_id: string | null;
  safety: Safety;
  data: T;
  errors: string[];
  store_state?: StoreState;
};

export function okEnvelope<T>(data: T, caseId: string | null = null, storeState?: StoreState): Envelope<T> {
  return {
    ok: true,
    case_id: caseId,
    safety: { blocked: false, rule_id: null },
    data,
    errors: [],
    ...(storeState ? { store_state: storeState } : {}),
  };
}

// エラー用エンベロープ（検証失敗・重複・未検出）。safety.blocked は安全ゲートの拒否（具体ルールおよび判定不能・過負荷の fail-closed）専用なので false のまま。
export function errorEnvelope(errors: string[], data: unknown = {}, caseId: string | null = null, storeState?: StoreState): Envelope<unknown> {
  return {
    ok: false,
    case_id: caseId,
    safety: { blocked: false, rule_id: null },
    data,
    errors,
    ...(storeState ? { store_state: storeState } : {}),
  };
}

// 安全ゲート拒否（§3: HTTP 403 / ok=false / safety.blocked=true）。
// R5: safety.blocked=true は、具体的な安全ルールによる拒否と、判定不能・過負荷による fail-closed の両方を表す。両者の区別は data.cause による（C-3）。
// data.cause は利用者向けの 4 分類。内部の 6 分類（cause_detail）は監査記録にのみ残す。判定不能・過負荷の reason は固定文にする（上限値などを出さない）。
export function blockedEnvelope(
  ruleId: string,
  detail: { escalate_to: string | null; reason: string | null; matched_rules: string[]; cause_detail?: CauseDetail },
  caseId: string | null = null,
  storeState?: StoreState,
): Envelope<unknown> {
  const cause = publicCause(detail.cause_detail);
  return {
    ok: false,
    case_id: caseId,
    safety: { blocked: true, rule_id: ruleId },
    data: {
      blocked: true,
      rule_id: ruleId,
      escalate_to: detail.escalate_to,
      reason: safeReason(detail.cause_detail, detail.reason),
      matched_rules: detail.matched_rules,
      cause,
      user_message: userMessage(cause, storeState !== undefined),
    },
    errors: [`blocked:${ruleId}`],
    ...(storeState ? { store_state: storeState } : {}),
  };
}
