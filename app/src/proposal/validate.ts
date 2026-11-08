// 決定的なチェック: 出力の解析、根拠の照合、医療に関する表現の検出。LLM に依存しない。
import type { Draft, EvRef, Item } from "./types";

const MAX_ITEM = 6, MAX_TEXT = 500;
export function extractJson(text: string): unknown | null {
  const t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : t;
  const a = body.indexOf("{"), b = body.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(body.slice(a, b + 1)); } catch { return null; }
}
const str = (v: unknown): string => (typeof v === "string" ? v.trim().slice(0, MAX_TEXT) : "");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((s) => s.length > 0).slice(0, MAX_ITEM) : []);
function refs(v: unknown): EvRef[] {
  if (!Array.isArray(v)) return [];
  const out: EvRef[] = [];
  for (const r of v.slice(0, 4)) {
    if (r && typeof r === "object") {
      const o = r as Record<string, unknown>;
      const d = str(o.doc_id), ver = str(o.version), s = str(o.section_id);
      if (d && ver && s) out.push({ doc_id: d, version: ver, section_id: s });
    }
  }
  return out;
}
function items(v: unknown): Item[] {
  if (!Array.isArray(v)) return [];
  const out: Item[] = [];
  for (const x of v.slice(0, MAX_ITEM)) {
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      const text = str(o.text);
      if (text) out.push({ text, evidence: refs(o.evidence) });
    }
  }
  return out;
}
export function normalizeDraft(raw: unknown): { ok: true; draft: Draft } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "not_object" };
  const o = raw as Record<string, unknown>;
  const draft: Draft = {
    facility_summary: str(o.facility_summary),
    facts: items(o.facts),
    hypotheses: items(o.hypotheses),
    unconfirmed: strs(o.unconfirmed),
    check_candidates: items(o.check_candidates),
    recovery_outlook: str(o.recovery_outlook),
    interim_options: strs(o.interim_options),
    parts_preparation: strs(o.parts_preparation),
    facility_decides: strs(o.facility_decides),
    engineer_decides: strs(o.engineer_decides),
  };
  if (!draft.facility_summary || draft.check_candidates.length === 0) return { ok: false, error: "missing_required_sections" };
  return { ok: true, draft };
}
export const refKey = (r: EvRef) => `${r.doc_id}|${r.version}|${r.section_id}`;
export function allRefs(d: Draft): EvRef[] {
  const out: EvRef[] = [];
  for (const it of [...d.facts, ...d.hypotheses, ...d.check_candidates]) for (const r of it.evidence) out.push(r);
  return out;
}
// 入力に渡した根拠の一覧にない資料 ID・版・節は「根拠不明」
export function ungroundedRefs(d: Draft, allowed: EvRef[]): EvRef[] {
  const ok = new Set(allowed.map(refKey));
  const seen = new Set<string>(); const bad: EvRef[] = [];
  for (const r of allRefs(d)) { const k = refKey(r); if (!ok.has(k) && !seen.has(k)) { seen.add(k); bad.push(r); } }
  return bad;
}
// 確認候補には、根拠が 1 件以上あること(根拠のない確認候補は「根拠不明」と同じ扱い)
export function candidatesWithoutEvidence(d: Draft): string[] { return d.check_candidates.filter((c) => c.evidence.length === 0).map((c) => c.text); }
// 安全ゲートと医療表現のチェックの対象は、散文だけ(根拠の参照は別に照合する)
export function proseText(d: Draft): string {
  return [d.facility_summary, ...d.facts.map((x) => x.text), ...d.hypotheses.map((x) => x.text), ...d.unconfirmed, ...d.check_candidates.map((x) => x.text), d.recovery_outlook, ...d.interim_options, ...d.parts_preparation, ...d.facility_decides, ...d.engineer_decides].filter((s) => s).join("\n");
}
// 診断・治療・医療判断に触れる表現(装置の「自己診断」「故障診断」は対象外)
const MEDICAL = /(患者|医療|臨床)[^。\n]{0,8}(診断|治療|判断)|治療|投薬|処方|病名|病気|手術|容態/;
// 検査の実施可否、復旧時刻の確約、代替運用の可否を AI が決める表現(決めるのは施設・エンジニア)
const DECISION = /検査[^。\n]{0,12}(中止|延期|見送り|実施可|実施できます|実施して(よい|ください|構いません)|予定どおり)|(今日|明日|本日|午前|午後|\d{1,2}時|\d{1,2}日)[^。\n]{0,14}(までに|には|中に)[^。\n]{0,10}(復旧|完了|使用でき|使え|再開)|復旧[^。\n]{0,6}(時刻|時間)[^。\n]{0,8}(は|を)[^。\n]{0,10}(\d|午前|午後|確約します)|代替運用[^。\n]{0,10}(してよい|で問題ありません|で問題はありません|安全です)/;
export function decisionMatches(text: string): string[] { const m = text.match(new RegExp(DECISION.source, "g")); return m ? Array.from(new Set(m)).slice(0, 5) : []; }
export function medicalMatches(text: string): string[] { const m = text.match(new RegExp(MEDICAL.source, "g")); return m ? Array.from(new Set(m)).slice(0, 5) : []; }
