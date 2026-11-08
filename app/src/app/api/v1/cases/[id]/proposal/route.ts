import type { NextRequest } from "next/server";
import devicesFixture from "@/data/devices.json";
import { getCase } from "@/lib/caseStore";
import { searchDocuments } from "@/lib/documentIndex";
import { errorEnvelope, okEnvelope } from "@/lib/envelope";
import { MAX_BODY_BYTES, readTextLimited } from "@/lib/http";
import { blockedResponse } from "@/lib/rejection";
import { evaluateAsync } from "@/lib/safetyGate";
import { callClaude, checkCallLimit, countCall, modelName } from "@/proposal/claude";
import { fixtureText } from "@/proposal/fixtures";
import { logCall } from "@/proposal/log";
import { SYSTEM_PROMPT, userPrompt } from "@/proposal/prompt";
import type { CallMeta, EvRef, SafetyCheck } from "@/proposal/types";
import { candidatesWithoutEvidence, decisionMatches, extractJson, medicalMatches, normalizeDraft, proseText, ungroundedRefs } from "@/proposal/validate";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_CHECK_CHARS = 6000;

// POST /api/v1/cases/:id/proposal  提案の下書き(Claude)。TP-05 の限定解除(提案の下書きだけ)。既存のルート・lib は変更しない。
//   mode "draft": 実データから下書きを作る。mode "check": エンジニアが直した文章を、同じ決定的なチェックに通す(Claude は呼ばない)。
export async function POST(request: NextRequest, ctx: RouteContext<"/api/v1/cases/[id]/proposal">) {
  const { id } = await ctx.params;
  const t = await readTextLimited(request, 20000, id);
  if (!t.ok) return t.response;
  let body: Record<string, unknown> = {};
  try { if (t.text.trim().length > 0) { const b = JSON.parse(t.text); if (b && typeof b === "object" && !Array.isArray(b)) body = b as Record<string, unknown>; } } catch { return Response.json(errorEnvelope(["invalid_json"], {}, id), { status: 400, headers: NO_STORE }); }

  if (body.mode === "check") {
    const text = typeof body.text === "string" ? body.text : "";
    if (text.length === 0 || text.length > MAX_CHECK_CHARS) return Response.json(errorEnvelope(["invalid:text"], { invalid_fields: ["text"] }, id), { status: 422, headers: NO_STORE });
    const med = medicalMatches(text);
    if (med.length > 0) return Response.json(errorEnvelope(["blocked:medical_content"], { checks: { passed: false, medical: med } }, id), { status: 403, headers: NO_STORE });
    const dec = decisionMatches(text);
    if (dec.length > 0) return Response.json(errorEnvelope(["blocked:decision_content"], { checks: { passed: false, decision: dec } }, id), { status: 403, headers: NO_STORE });
    const d = await evaluateAsync({ text });
    if (d.blocked && d.rule_id) return blockedResponse({ route: "POST /api/v1/cases/:id/proposal(check)", gate: d, inputLength: text.length });
    return Response.json(okEnvelope({ checks: { passed: true, medical: [] } }, id), { headers: NO_STORE });
  }

  const c = await getCase(id);
  if (!c) return Response.json(errorEnvelope(["case_not_found"], {}, id), { status: 404, headers: NO_STORE });
  if (c.device_confirmation_status !== "confirmed" || !c.device_id) return Response.json(errorEnvelope(["device_not_confirmed"], {}, id), { status: 409, headers: NO_STORE });
  const device = devicesFixture.devices.find((d) => d.device_id === c.device_id);
  if (!device) return Response.json(errorEnvelope(["device_not_in_registry"], {}, id), { status: 409, headers: NO_STORE });
  const hits = searchDocuments({ model: device.model, error_code: c.error_code, query: null });
  if (hits.length === 0) return Response.json(errorEnvelope(["no_evidence"], {}, id), { status: 409, headers: NO_STORE });
  const allowed: EvRef[] = hits.map((h) => ({ doc_id: h.doc_id, version: h.version, section_id: h.section_id }));
  const safety: SafetyCheck[] = Array.isArray(body.safety_checks)
    ? (body.safety_checks as unknown[]).slice(0, 10).filter((s): s is { allowed: boolean; rule_id: string | null } => !!s && typeof s === "object" && typeof (s as { allowed?: unknown }).allowed === "boolean").map((s) => ({ allowed: s.allowed, rule_id: typeof s.rule_id === "string" ? s.rule_id.slice(0, 20) : null }))
    : [];

  const limit = checkCallLimit(id);
  if (limit !== "ok") return Response.json(errorEnvelope([`rate_limited:${limit}`], {}, id), { status: 429, headers: NO_STORE });
  countCall(id);

  const fixture = process.env.ESN_PROPOSAL_FIXTURE;
  let raw: string; let meta: CallMeta;
  if (fixture && fixture.length > 0 && fixture !== "fail") {
    const ft = fixtureText(fixture, allowed);
    meta = { source: "fixture", model: null, request_id: null, response_id: null, input_tokens: null, output_tokens: null, ms: 0 };
    if (ft === null) return Response.json(errorEnvelope(["fixture_unknown"], {}, id), { status: 500, headers: NO_STORE });
    raw = ft;
  } else if (fixture === "fail") {
    meta = { source: "fixture", model: null, request_id: null, response_id: null, input_tokens: null, output_tokens: null, ms: 0 };
    await logCall(id, "fixture_fail", meta);
    return Response.json(errorEnvelope(["claude_call_failed:fixture_fail"], { meta }, id), { status: 502, headers: NO_STORE });
  } else {
    const r = await callClaude(SYSTEM_PROMPT, userPrompt({ dp: c.dp_number, symptom: c.symptom_text, error_code: c.error_code, site: c.site_id, device: { device_id: device.device_id, model: device.model, room: device.room, install_year: device.install_year }, evidence: hits.map((h) => ({ doc_id: h.doc_id, version: h.version, section_id: h.section_id, title: h.title, excerpt: h.excerpt })), safety }));
    meta = r.meta;
    if (!r.ok) { await logCall(id, `failed:${r.reason}`, meta); return Response.json(errorEnvelope([`claude_call_failed:${r.reason}`], { meta }, id), { status: 502, headers: NO_STORE }); }
    raw = r.text;
  }
  const parsed = normalizeDraft(extractJson(raw));
  if (!parsed.ok) { await logCall(id, `invalid_output:${parsed.error}`, meta, { raw_length: raw.length, raw_head: raw.slice(0, 300), raw_tail: raw.slice(-200) }); return Response.json(errorEnvelope([`invalid_model_output:${parsed.error}`], { meta }, id), { status: 502, headers: NO_STORE }); }
  const draft = parsed.draft; const prose = proseText(draft);
  const med = medicalMatches(prose);
  if (med.length > 0) { await logCall(id, "blocked:medical", meta); return Response.json(errorEnvelope(["blocked:medical_content"], { checks: { medical: med }, meta }, id), { status: 403, headers: NO_STORE }); }
  const dec = decisionMatches(prose);
  if (dec.length > 0) { await logCall(id, "blocked:decision", meta); return Response.json(errorEnvelope(["blocked:decision_content"], { checks: { decision: dec }, meta }, id), { status: 403, headers: NO_STORE }); }
  const gate = await evaluateAsync({ text: prose });
  if (gate.blocked && gate.rule_id) { await logCall(id, `blocked:${gate.rule_id}`, meta, { prose: prose.slice(0, 2500) }); return blockedResponse({ route: "POST /api/v1/cases/:id/proposal", gate, inputLength: prose.length }); }
  const bad = ungroundedRefs(draft, allowed); const noEv = candidatesWithoutEvidence(draft);
  await logCall(id, bad.length || noEv.length ? "draft_ungrounded" : "draft_ok", meta);
  return Response.json(okEnvelope({ draft, checks: { ungrounded: bad, candidates_without_evidence: noEv, safety: { blocked: false }, medical: [] }, evidence: allowed, model: meta.source === "claude" ? modelName() : null, meta }, id), { headers: NO_STORE });
}
