import type { NextRequest } from "next/server";
import { confirmDevice, getCase } from "@/lib/caseStore";
import { validateConfirm } from "@/lib/deviceSearch";
import { errorEnvelope, okEnvelope } from "@/lib/envelope";
import { MAX_BODY_BYTES, readJsonLimited } from "@/lib/http";
import { blockedResponse, internalErrorResponse } from "@/lib/rejection";
import { evaluateAsync } from "@/lib/safetyGate";

const NO_STORE = { "Cache-Control": "no-store" };

// POST /api/v1/cases/:id/device-confirm Human による装置確定（直近の候補からの明示選択のみ）
// R5: 確定を永続化した後に読込みが失敗しても、確定は保存済みなので成功応答（stored）を返す（H3 Draft 第 6.2 節）。
export async function POST(request: NextRequest, ctx: RouteContext<"/api/v1/cases/[id]/device-confirm">) {
  const { id } = await ctx.params;
  const parsed = await readJsonLimited(request, MAX_BODY_BYTES.device, id, "not_stored");
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  let committed = false;
  try {
    // 保存前ゲート（N-01）: 受信本文の全文字列（未知フィールド含む）に個人情報・機密情報が無いこと。
    // 型・サイズの fail-closed（SG-INPUT-01）は only に関わらず常に適用される。
    const bodyText = JSON.stringify(body);
    const gate = await evaluateAsync({ text: bodyText }, { only: ["SG-DATA-01"] });
    if (gate.blocked && gate.rule_id) {
      return await blockedResponse({ route: "POST /api/v1/cases/:id/device-confirm", gate, inputLength: typeof bodyText === "string" ? bodyText.length : 0, caseId: id, storeState: "not_stored" });
    }

    const v = validateConfirm(body);
    if (!v.ok) {
      const errors = [...v.missing.map((f) => `missing:${f}`), ...v.invalid.map((f) => `invalid:${f}`)];
      return Response.json(errorEnvelope(errors, { missing_fields: v.missing, invalid_fields: v.invalid }, id, "not_stored"), {
        status: 422,
        headers: NO_STORE,
      });
    }

    const out = await confirmDevice(id, v.device_id, v.confirmed_by_role);

    if (!out.found) {
      return Response.json(errorEnvelope(["case_not_found"], {}, id, "not_stored"), { status: 404, headers: NO_STORE });
    }
    committed = out.wrote;
    const r = out.result;
    if (r.kind === "already_confirmed") {
      return Response.json(errorEnvelope(["device_already_confirmed"], { device_id: r.device_id }, id, "not_stored"), { status: 409, headers: NO_STORE });
    }
    if (r.kind === "not_a_candidate") {
      // 候補にない装置（未検索・施設外・推測入力）は確定できない
      return Response.json(errorEnvelope(["device_not_in_candidates"], { candidate_ids: r.candidate_ids }, id, "not_stored"), {
        status: 409,
        headers: NO_STORE,
      });
    }
    // updated_at は保存時に付くので、保存後の行を読み直して返す。読直しに失敗しても、確定は永続化済みなので確定結果のレコードで成功応答する。
    let saved = r.record;
    try {
      saved = (await getCase(id)) ?? r.record;
    } catch {
      /* 永続化後の読込み失敗: 確定結果のレコードを返す */
    }
    return Response.json(okEnvelope(saved, id, "stored"), { headers: NO_STORE });
  } catch (e) {
    return internalErrorResponse(e, committed, id);
  }
}
