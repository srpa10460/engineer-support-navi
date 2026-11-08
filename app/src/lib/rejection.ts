// R5 拒否・失敗の応答を組み立てる共通処理（監査記録の追記を含む）。
import { StoreWriteError, type StoreState } from "@/lib/caseStore";
import { recordRejection } from "@/lib/audit";
import { blockedEnvelope, errorEnvelope } from "@/lib/envelope";
import type { GateDecision } from "@/lib/safetyGate";
import { MESSAGE_STORE_FAILED, MESSAGE_STORE_UNKNOWN, MESSAGE_STORED_BUT_FAILED } from "@/lib/userMessages";

const NO_STORE = { "Cache-Control": "no-store" };

// 安全ゲートの拒否（403）。監査記録（本文なし）を 1 件追記する。追記の失敗は応答を変えない。
export async function blockedResponse(args: {
  route: string;
  gate: GateDecision;
  inputLength: number;
  caseId?: string | null;
  storeState?: StoreState;
}): Promise<Response> {
  const { gate } = args;
  const ruleId = gate.rule_id ?? "SG-INPUT-01";
  await recordRejection({
    route: args.route,
    rule_id: ruleId,
    cause_detail: gate.cause_detail ?? "rule_hit",
    input_length: args.inputLength,
    truncated: gate.truncated === true,
  });
  return Response.json(blockedEnvelope(ruleId, gate, args.caseId ?? null, args.storeState), { status: 403, headers: NO_STORE });
}

// 保存系ルートの想定外の失敗（500）。store_state を保存の有無の確実さに応じて区別する。
// committed=true は「store の呼び出しが書込みを完了して戻った後」の失敗。
export function storeStateOfFailure(e: unknown, committed: boolean): StoreState {
  if (committed) return "stored";
  if (e instanceof StoreWriteError) return e.phase === "before_commit" ? "not_stored" : "unknown";
  return "not_stored"; // store の書込み段階に到達する前の失敗（読込み・検証・不変条件・ルート内）
}

export function internalErrorResponse(e: unknown, committed: boolean, caseId: string | null = null): Response {
  const state = storeStateOfFailure(e, committed);
  const user_message = state === "unknown" ? MESSAGE_STORE_UNKNOWN : state === "stored" ? MESSAGE_STORED_BUT_FAILED : MESSAGE_STORE_FAILED;
  return Response.json(errorEnvelope(["internal_error"], { user_message }, caseId, state), { status: 500, headers: NO_STORE });
}
