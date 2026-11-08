// 呼び出しの記録(要求 ID・応答 ID・トークン数・時刻)。キーやプロンプト全文は残さない。
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { CallMeta } from "./types";
export async function logCall(caseId: string, outcome: string, meta: CallMeta, extra: Record<string, string | number> = {}) {
  try {
    const dir = process.env.ESN_DATA_DIR && process.env.ESN_DATA_DIR.length > 0 ? process.env.ESN_DATA_DIR : path.join(process.cwd(), "..", "runtime", "data");
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, "proposal_calls.jsonl"), JSON.stringify({ at: new Date().toISOString(), case_id: caseId, outcome, ...meta, ...extra }) + "\n");
  } catch { /* 記録の失敗で、処理は止めない */ }
}
