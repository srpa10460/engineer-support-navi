import type { NextRequest } from "next/server";
import { getCase } from "@/lib/caseStore";
import { errorEnvelope, okEnvelope } from "@/lib/envelope";

// GET /api/v1/cases/:id 再表示
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/v1/cases/[id]">) {
  const { id } = await ctx.params;
  const record = await getCase(id);
  if (!record) {
    return Response.json(errorEnvelope(["case_not_found"]), { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json(okEnvelope(record, record.case_id), { headers: { "Cache-Control": "no-store" } });
}
