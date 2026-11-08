import type { NextRequest } from "next/server";
import devicesFixture from "@/data/devices.json";
import { getCase } from "@/lib/caseStore";
import { parseRefId, resolveEvidence } from "@/lib/documentIndex";
import { errorEnvelope, okEnvelope } from "@/lib/envelope";

// R3 N-R2-05: 機種確定は自己申告（verified=false）のまま下流へ伝える。下流で verified に昇格させない。
function confirmationProvenance(c: { device_confirmation: { source: string } | null }) {
  return { verified: false as const, source: c.device_confirmation?.source ?? null };
}

const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/v1/cases/:id/evidence/:refId Evidence 解決（refId = <doc_id>~<version>~<section_id>）
// 索引外・版不一致・節不在・機種不一致は 422 で REJECT し、文書内容を一切返さない（E-01〜E-03）。
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/v1/cases/[id]/evidence/[refId]">) {
  const { id, refId } = await ctx.params;
  const c = await getCase(id);
  if (!c) return Response.json(errorEnvelope(["case_not_found"], {}, id), { status: 404, headers: NO_STORE });

  let decoded: string;
  try {
    decoded = decodeURIComponent(refId);
  } catch {
    return Response.json(errorEnvelope(["invalid:refId"], {}, id), { status: 422, headers: NO_STORE });
  }
  const ref = parseRefId(decoded);
  if (!ref) return Response.json(errorEnvelope(["invalid:refId"], {}, id), { status: 422, headers: NO_STORE });

  // 機種適合は確定済み装置の機種で検査する。未確定ケースでは機種適合を保証できないため解決しない。
  if (c.device_confirmation_status !== "confirmed" || !c.device_id) {
    return Response.json(errorEnvelope(["device_not_confirmed"], {}, id), { status: 409, headers: NO_STORE });
  }
  const model = devicesFixture.devices.find((d) => d.device_id === c.device_id)?.model ?? null;
  if (model === null) return Response.json(errorEnvelope(["device_not_in_registry"], {}, id), { status: 409, headers: NO_STORE });

  const r = resolveEvidence(ref.doc_id, ref.version, ref.section_id, model);
  if (!r.ok) {
    return Response.json(errorEnvelope([`evidence_rejected:${r.code}`], { reject_code: r.code, detail: r.detail }, id), { status: 422, headers: NO_STORE });
  }
  return Response.json(okEnvelope({ ...r.evidence, device_confirmation: confirmationProvenance(c) }, id), { headers: NO_STORE });
}
