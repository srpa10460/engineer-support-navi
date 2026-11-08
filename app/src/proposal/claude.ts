// Anthropic Messages API の呼び出し(サーバー側のみ)。キーは実行時にキーチェーンから読み、ログ・画面・ファイルに出さない。
// 外部通信先は api.anthropic.com だけ。max_tokens と呼び出し回数に上限を設ける。
import { execFileSync } from "node:child_process";
import type { CallMeta } from "./types";

const URL_MESSAGES = "https://api.anthropic.com/v1/messages";
export const MAX_TOKENS = 3500, TIMEOUT_MS = 60000, MAX_CALLS_PER_PROCESS = 40, MAX_CALLS_PER_CASE = 6;
let callsTotal = 0; const perCase = new Map<string, number>();
export function checkCallLimit(caseId: string): "ok" | "process_limit" | "case_limit" {
  if (callsTotal >= MAX_CALLS_PER_PROCESS) return "process_limit";
  if ((perCase.get(caseId) ?? 0) >= MAX_CALLS_PER_CASE) return "case_limit";
  return "ok";
}
export function countCall(caseId: string) { callsTotal += 1; perCase.set(caseId, (perCase.get(caseId) ?? 0) + 1); }
function readKey(): string | null {
  try { return execFileSync("security", ["find-generic-password", "-s", "anthropic-esn", "-w"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null; } catch { return null; }
}
export const modelName = () => (process.env.ESN_CLAUDE_MODEL && process.env.ESN_CLAUDE_MODEL.length > 0 ? process.env.ESN_CLAUDE_MODEL : "claude-sonnet-5-5");
export type ClaudeResult = { ok: true; text: string; meta: CallMeta } | { ok: false; reason: string; meta: CallMeta };
export async function callClaude(system: string, user: string): Promise<ClaudeResult> {
  const t0 = Date.now(); const model = modelName();
  const base: CallMeta = { source: "claude", model, request_id: null, response_id: null, input_tokens: null, output_tokens: null, ms: 0 };
  const key = readKey();
  if (!key) return { ok: false, reason: "no_api_key", meta: { ...base, ms: Date.now() - t0 } };
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(URL_MESSAGES, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model, max_tokens: MAX_TOKENS, system, messages: [{ role: "user", content: user }] }), signal: ac.signal });
    const requestId = res.headers.get("request-id");
    if (!res.ok) { await res.text().catch(() => ""); return { ok: false, reason: `http_${res.status}`, meta: { ...base, request_id: requestId, ms: Date.now() - t0 } }; }
    const j = (await res.json()) as { id?: string; stop_reason?: string; content?: Array<{ type?: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
    const text = (j.content ?? []).filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("");
    const meta: CallMeta = { ...base, request_id: requestId, response_id: j.id ?? null, input_tokens: j.usage?.input_tokens ?? null, output_tokens: j.usage?.output_tokens ?? null, ms: Date.now() - t0 };
    if (!text) return { ok: false, reason: "empty_response", meta };
    if (j.stop_reason === "max_tokens") return { ok: false, reason: "truncated_output", meta };
    return { ok: true, text, meta };
  } catch (e) {
    return { ok: false, reason: e instanceof Error && e.name === "AbortError" ? "timeout" : "network_error", meta: { ...base, ms: Date.now() - t0 } };
  } finally { clearTimeout(timer); }
}
