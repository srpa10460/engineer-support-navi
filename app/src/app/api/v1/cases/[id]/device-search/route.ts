import type { NextRequest } from "next/server";
import { type DeviceConfirmationStatus, updateCase } from "@/lib/caseStore";
import { searchDevices, validateQuery } from "@/lib/deviceSearch";
import { errorEnvelope, okEnvelope } from "@/lib/envelope";
import { MAX_BODY_BYTES, readJsonLimited } from "@/lib/http";
import { blockedResponse, internalErrorResponse } from "@/lib/rejection";
import { evaluateAsync } from "@/lib/safetyGate";

const NO_STORE = { "Cache-Control": "no-store" };

// POST /api/v1/cases/:id/device-search 装置候補（自動確定しない）
// R5: store_state は候補を永続化した場合のみ stored。確定済みのケースは保存せず not_stored。
export async function POST(request: NextRequest, ctx: RouteContext<"/api/v1/cases/[id]/device-search">) {
  const { id } = await ctx.params;
  const parsed = await readJsonLimited(request, MAX_BODY_BYTES.device, id, "not_stored");
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  let committed = false;
  try {
    const v = validateQuery(body);
    if (!v.ok) {
      return Response.json(errorEnvelope(v.invalid.map((f) => `invalid:${f}`), { invalid_fields: v.invalid }, id, "not_stored"), {
        status: 422,
        headers: NO_STORE,
      });
    }

    // 自由記述に患者・実個人データが含まれる場合は保存前に拒否（SG-DATA-01）
    if (v.query.free_text) {
      const gate = await evaluateAsync({ text: v.query.free_text }, { only: ["SG-DATA-01"] });
      if (gate.blocked && gate.rule_id) {
        return await blockedResponse({ route: "POST /api/v1/cases/:id/device-search", gate, inputLength: v.query.free_text.length, caseId: id, storeState: "not_stored" });
      }
    }

    const out = await updateCase<Omit<ReturnType<typeof searchDevices>, "status"> & { status: DeviceConfirmationStatus; device_id: string | null }>(id, (c) => {
      const outcome = searchDevices(c, v.query);
      // 確定済みのケースは検索しても確定を外さない（候補の表示のみ）
      if (c.device_confirmation_status === "confirmed") {
        return { record: null, result: { ...outcome, status: c.device_confirmation_status, device_id: c.device_id } };
      }
      return {
        record: { ...c, device_candidates: outcome.candidates, device_confirmation_status: outcome.status },
        result: { ...outcome, device_id: c.device_id },
      };
    });
    if (!out.found) {
      return Response.json(errorEnvelope(["case_not_found"], {}, id, "not_stored"), { status: 404, headers: NO_STORE });
    }
    committed = out.wrote;
    return Response.json(okEnvelope(out.result, id, out.wrote ? "stored" : "not_stored"), { headers: NO_STORE });
  } catch (e) {
    return internalErrorResponse(e, committed, id);
  }
}
