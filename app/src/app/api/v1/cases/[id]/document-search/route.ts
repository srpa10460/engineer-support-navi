import type { NextRequest } from "next/server";
import devicesFixture from "@/data/devices.json";
import { getCase } from "@/lib/caseStore";
import { searchDocuments, validateSearch } from "@/lib/documentIndex";
import { errorEnvelope, okEnvelope } from "@/lib/envelope";
import { MAX_BODY_BYTES, readTextLimited } from "@/lib/http";

// R3 N-R2-05: 機種確定は自己申告（verified=false）のまま下流へ伝える。下流で verified に昇格させない。
function confirmationProvenance(c: { device_confirmation: { source: string } | null }) {
  return { verified: false as const, source: c.device_confirmation?.source ?? null };
}

const NO_STORE = { "Cache-Control": "no-store" };

// POST /api/v1/cases/:id/document-search 確定済み装置の機種で文書索引を検索（FR-P0-03）
// 機種は Human 確定済みの device_id からのみ決める（body の model は受け取らない = 機種詐称で他機種文書を引けない）。
export async function POST(request: NextRequest, ctx: RouteContext<"/api/v1/cases/[id]/document-search">) {
  const { id } = await ctx.params;
  const t = await readTextLimited(request, MAX_BODY_BYTES.documents, id);
  if (!t.ok) return t.response;
  let body: unknown = {};
  try {
    if (t.text.trim().length > 0) body = JSON.parse(t.text);
  } catch {
    return Response.json(errorEnvelope(["invalid_json"], {}, id), { status: 400, headers: NO_STORE });
  }
  const v = validateSearch(body);
  if (!v.ok) {
    return Response.json(errorEnvelope(v.invalid.map((f) => `invalid:${f}`), { invalid_fields: v.invalid }, id), { status: 422, headers: NO_STORE });
  }
  const c = await getCase(id);
  if (!c) return Response.json(errorEnvelope(["case_not_found"], {}, id), { status: 404, headers: NO_STORE });
  if (c.device_confirmation_status !== "confirmed" || !c.device_id) {
    return Response.json(errorEnvelope(["device_not_confirmed"], { hits: [] }, id), { status: 409, headers: NO_STORE });
  }
  const device = devicesFixture.devices.find((d) => d.device_id === c.device_id);
  if (!device) return Response.json(errorEnvelope(["device_not_in_registry"], { hits: [] }, id), { status: 409, headers: NO_STORE });

  const input = { model: device.model, error_code: v.input.error_code ?? c.error_code, query: v.input.query };
  const hits = searchDocuments(input);
  return Response.json(okEnvelope({ model: device.model, error_code: input.error_code, hits, device_confirmation: confirmationProvenance(c) }, id), { headers: NO_STORE });
}
