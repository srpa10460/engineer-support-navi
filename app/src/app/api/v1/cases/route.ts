import { createCase, listCases, validateNewCase } from "@/lib/caseStore";
import { errorEnvelope, okEnvelope } from "@/lib/envelope";
import { MAX_BODY_BYTES, readJsonLimited } from "@/lib/http";
import { blockedResponse, internalErrorResponse } from "@/lib/rejection";
import { evaluateAsync } from "@/lib/safetyGate";

const NO_STORE = { "Cache-Control": "no-store" };
const ROUTE = "POST /api/v1/cases";

// POST /api/v1/cases 新規ケース（必須欠落は保存せず 422、重複DPは 409）
// R5: 応答に store_state（stored / not_stored / unknown）を付ける。拒否・検証エラーは not_stored（保存の前に止まるため確実）。
export async function POST(request: Request) {
  const parsed = await readJsonLimited(request, MAX_BODY_BYTES.cases, null, "not_stored");
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  let committed = false; // createCase が永続化を完了して戻った後は true
  try {
    const v = validateNewCase(body);
    if (!v.ok) {
      const errors = [...v.missing.map((f) => `missing:${f}`), ...v.invalid.map((f) => `invalid:${f}`)];
      return Response.json(errorEnvelope(errors, { missing_fields: v.missing, invalid_fields: v.invalid }, null, "not_stored"), {
        status: 422,
        headers: NO_STORE,
      });
    }

    // 保存経路の制御層: 患者・実個人データ・機密情報は保存前に拒否（SG-DATA-01 / S-05）
    // 検査対象は「自由記述」: symptom_text と、本文のうち識別子フィールド以外（未知の追加フィールドを含む）。G-05 / R3 N-R2-01
    // 識別子フィールド（dp_number / site_id / device_id / error_code / observed_at / reporter_role）は validateNewCase の厳格な形式検証を通ったものだけが
    // ここに来るため、自由記述用の個人情報形式検出（電話番号・氏名等）は機械的に適用しない（N-R2-08: 数字の識別子が電話番号に誤一致する問題の解消）。
    const IDENTIFIER_FIELDS = new Set(["dp_number", "site_id", "device_id", "error_code", "observed_at", "reporter_role"]);
    const freeTextBody = Object.fromEntries(Object.entries(body && typeof body === "object" ? body : {}).filter(([k]) => !IDENTIFIER_FIELDS.has(k)));
    const allFields = [v.value.symptom_text, JSON.stringify(freeTextBody)].join("\n");
    const gate = await evaluateAsync({ text: allFields, role: v.value.reporter_role }, { only: ["SG-DATA-01"] }); // 型・サイズ検査（SG-INPUT-01）と R5 の判定不能（切捨て・未知の文字）は only に関わらず常に適用される
    if (gate.blocked && gate.rule_id) {
      return await blockedResponse({ route: ROUTE, gate, inputLength: allFields.length, storeState: "not_stored" });
    }

    // 識別子欄（形式検証・台帳照合済み）には、秘密情報・メール・12/16 桁番号・姓名トークンだけを検査する（R4-04。自由記述用の検出は適用しない）
    const idText = [v.value.dp_number, v.value.site_id, v.value.device_id, v.value.error_code, v.value.observed_at, v.value.reporter_role].filter((x): x is string => typeof x === "string").join("\n");
    const idGate = await evaluateAsync({ text: idText, scope: "identifier" }, { only: ["SG-DATA-01"] });
    if (idGate.blocked && idGate.rule_id) {
      return await blockedResponse({ route: ROUTE, gate: idGate, inputLength: idText.length, storeState: "not_stored" });
    }

    const result = await createCase(v.value);
    if (result.kind === "duplicate") {
      return Response.json(
        errorEnvelope(["duplicate_dp_number"], { existing_case_id: result.existing_case_id }, result.existing_case_id, "not_stored"),
        { status: 409, headers: NO_STORE },
      );
    }
    committed = true;
    return Response.json(okEnvelope(result.record, result.record.case_id, "stored"), { status: 201, headers: NO_STORE });
  } catch (e) {
    return internalErrorResponse(e, committed);
  }
}

// GET /api/v1/cases 一覧
export async function GET() {
  const cases = await listCases();
  return Response.json(okEnvelope({ cases }), { headers: NO_STORE });
}
