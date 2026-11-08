import { okEnvelope } from "@/lib/envelope";

// 生存確認。LLM・DB・外部システムに依存しない（TP-00 Done: /api/v1/health が 200）
export async function GET() {
  const body = okEnvelope({
    status: "ok",
    service: "engineer-support-navi",
    phase: "TP-00",
    llm: "not_required",
    time: new Date().toISOString(),
  });
  return Response.json(body, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
