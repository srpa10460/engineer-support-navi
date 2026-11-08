import { errorEnvelope, okEnvelope } from "@/lib/envelope";
import { MAX_BODY_BYTES, readJsonLimited } from "@/lib/http";
import { blockedResponse } from "@/lib/rejection";
import { evaluateAsync, type GateInput } from "@/lib/safetyGate";

const NO_STORE = { "Cache-Control": "no-store" };

// POST /api/v1/actions/evaluate Safety Gate 単体評価（副作用なし。何も保存・実行しない）
export async function POST(request: Request) {
  // 本文はストリーム読み込みでバイト上限を強制（N-05・fail-closed）
  const parsed = await readJsonLimited(request, MAX_BODY_BYTES.evaluate);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const input: GateInput = body && typeof body === "object" && !Array.isArray(body) ? (body as GateInput) : {};
  // text は文字列のみ（配列・数値・オブジェクトは判定不能として 422。G-06・fail-closed）
  if (input.text !== undefined && typeof input.text !== "string") {
    return Response.json(errorEnvelope(["invalid:text"], { invalid_fields: ["text"] }), { status: 422, headers: NO_STORE });
  }
  if (typeof input.text !== "string" && input.root_cause_confirmed === undefined) {
    return Response.json(errorEnvelope(["missing:text"], { missing_fields: ["text"] }), { status: 422, headers: NO_STORE });
  }

  const d = await evaluateAsync(input);
  if (d.blocked && d.rule_id) {
    return blockedResponse({ route: "POST /api/v1/actions/evaluate", gate: d, inputLength: typeof input.text === "string" ? input.text.length : 0 });
  }
  return Response.json(okEnvelope({ allowed: true }), { headers: NO_STORE });
}
