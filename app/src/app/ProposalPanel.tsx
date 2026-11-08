"use client";
// 「5 提案」タブ: 実データから、Claude が施設への説明と提案の下書きを作り、エンジニアが確かめ・直し・承認する。
// 下書きは API の応答を受けてから表示する。失敗はそのまま表示する(作り物の下書きは出さない)。承認は画面上の確定だけで、外部へは送信しない。
import { useState } from "react";

type EvRef = { doc_id: string; version: string; section_id: string };
type Item = { text: string; evidence: EvRef[] };
type Draft = { facility_summary: string; facts: Item[]; hypotheses: Item[]; unconfirmed: string[]; check_candidates: Item[]; recovery_outlook: string; interim_options: string[]; parts_preparation: string[]; facility_decides: string[]; engineer_decides: string[] };
type Meta = { source: string; request_id: string | null; response_id: string | null; input_tokens: number | null; output_tokens: number | null; ms: number };
type Env = { ok: boolean; safety: { blocked: boolean; rule_id: string | null }; data: Record<string, any>; errors: string[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
type Sec = { k: string; label: string; text: string; orig: string };
export type SafetyCheck = { allowed: boolean; rule_id: string | null };

const lines = (a: string[]) => a.join("\n");
const keyOf = (r: EvRef) => `${r.doc_id}|${r.version}|${r.section_id}`;
function toSections(d: Draft): Sec[] {
  const mk = (k: string, label: string, text: string): Sec => ({ k, label, text, orig: text });
  return [
    mk("summary", "施設への説明(現在の状況)", d.facility_summary),
    mk("facts", "事実(実データで確認できたこと)", lines(d.facts.map((x) => x.text))),
    mk("hyp", "推測(原因の候補)", lines(d.hypotheses.map((x) => x.text))),
    mk("unc", "未確認(現地で確かめること)", lines(d.unconfirmed)),
    mk("cand", "確認候補と根拠", lines(d.check_candidates.map((x) => x.text))),
    mk("rec", "復旧の見通しと、その間の代わりの手段(施設が選ぶ選択肢)", lines([d.recovery_outlook, ...d.interim_options])),
    mk("parts", "部品の手配の準備(候補)", lines(d.parts_preparation)),
    mk("fac", "施設が決めること", lines(d.facility_decides)),
    mk("eng", "エンジニアが判断すること", lines(d.engineer_decides)),
  ];
}

export default function ProposalPanel(props: { caseId: string | null; ready: boolean; safety: SafetyCheck[]; onJump: (ref: EvRef) => void; onStage: (s: "none" | "draft" | "approved") => void }) {
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<{ title: string; sub: string[]; tone: "warn" | "block" } | null>(null);
  const [secs, setSecs] = useState<Sec[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [bad, setBad] = useState<EvRef[]>([]);
  const [noEv, setNoEv] = useState<string[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [approved, setApproved] = useState(false);
  const [chk, setChk] = useState<{ ok: boolean; msg: string } | null>(null);

  async function make() {
    if (!props.caseId) return;
    setBusy(true); setFail(null); setChk(null); setApproved(false);
    try {
      const r = await fetch(`/api/v1/cases/${props.caseId}/proposal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "draft", safety_checks: props.safety }) });
      const env = (await r.json()) as Env;
      if (r.status === 200 && env.ok) {
        setDraft(env.data.draft as Draft); setSecs(toSections(env.data.draft as Draft));
        setBad(env.data.checks?.ungrounded ?? []); setNoEv(env.data.checks?.candidates_without_evidence ?? []); setMeta(env.data.meta as Meta);
        props.onStage("draft");
      } else {
        setSecs(null); setDraft(null); props.onStage("none");
        if (r.status === 403) setFail({ tone: "block", title: "安全チェックで止めたため、表示しません", sub: [env.safety?.rule_id ? `ルール ${env.safety.rule_id}` : "医療・安全に関する表現を検出しました", "下書きは、作り直してください。"] });
        else setFail({ tone: "warn", title: "提案の下書きを作れませんでした", sub: [`HTTP ${r.status}`, ...env.errors] });
        if (env.data?.meta) setMeta(env.data.meta as Meta);
      }
    } catch {
      setSecs(null); props.onStage("none"); setFail({ tone: "warn", title: "提案の下書きを作れませんでした", sub: ["通信に失敗しました"] });
    }
    setBusy(false);
  }
  function edit(k: string, text: string) { setSecs((s) => (s ? s.map((x) => (x.k === k ? { ...x, text } : x)) : s)); setApproved(false); setChk(null); props.onStage("draft"); }
  async function approve() {
    if (!secs || !props.caseId) return;
    const text = secs.map((s) => `${s.label}\n${s.text}`).join("\n\n");
    const r = await fetch(`/api/v1/cases/${props.caseId}/proposal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "check", text }) });
    const env = (await r.json()) as Env;
    if (r.status === 200 && env.ok) { setApproved(true); setChk({ ok: true, msg: "直した文章も、安全チェックを通りました" }); props.onStage("approved"); }
    else { setApproved(false); setChk({ ok: false, msg: `承認できません(HTTP ${r.status}): ${env.errors.join("、")}` }); }
  }
  const edited = !!secs && secs.some((s) => s.text !== s.orig);
  const blocked = bad.length > 0 || noEv.length > 0;
  const refsOf = (items: Item[]) => items.flatMap((i) => i.evidence);
  const uniq = (rs: EvRef[]) => rs.filter((r, i) => rs.findIndex((x) => keyOf(x) === keyOf(r)) === i);
  const badKeys = new Set(bad.map(keyOf));

  return (
    <>
      <div className="sec"><i />協働: AI が下書き、エンジニアが決める</div>
      {!props.ready && <div className="hint" data-testid="prop-need">先に、装置の確定と、資料の検索を行ってください。</div>}
      <div className="btnrow" style={{ gridTemplateColumns: "1fr" }}>
        <button className="btn bev def" data-testid="prop-make" disabled={!props.ready || busy} onClick={make}>{busy ? "Claude の応答を待っています…" : "下書きを作る"}</button>
      </div>
      {fail && (
        <div className={`res ins ${fail.tone}`} data-testid="prop-fail"><div className="ic">{fail.tone === "block" ? "✕" : "!"}</div><div><b>{fail.title}</b>{fail.sub.map((s, i) => (<div className="sub" key={i}>{s}</div>))}</div></div>
      )}
      {secs && draft && (
        <>
          <div className="pbar" data-testid="prop-badge">
            <span className={`pbadge ${approved ? "ok" : "ai"}`}>{approved ? "エンジニア承認済み" : "AI下書き(Claude)"}</span>
            {edited && !approved && <span className="pbadge edit" data-testid="prop-editing">修正中</span>}
            {meta?.source === "fixture" && <span className="pbadge fx" data-testid="prop-fixture">テスト用の固定応答(実際の Claude ではありません)</span>}
          </div>
          {blocked && (
            <div className="res ins warn" data-testid="prop-ungrounded"><div className="ic">!</div><div><b>根拠不明の項目があります</b><div className="sub">入力した資料にない根拠が使われています。承認できません。</div>{bad.map((r) => (<div className="sub mono" key={keyOf(r)}>{r.doc_id} v{r.version} {r.section_id}</div>))}{noEv.map((t, i) => (<div className="sub" key={i}>根拠のない確認候補: {t}</div>))}</div></div>
          )}
          {secs.map((s) => (
            <div key={s.k}>
              <span className="lab bev">{s.label}</span>{s.text !== s.orig && <span className="pbadge edit mark" data-testid={`prop-edited-${s.k}`}>✎ エンジニアが修正</span>}
              <textarea className={`field ins prop ${s.text !== s.orig ? "edited" : ""}`} data-testid={`prop-sec-${s.k}`} value={s.text} rows={2} ref={(el) => { if (el) { el.style.height = "auto"; el.style.height = el.scrollHeight + 2 + "px"; } }} onChange={(e) => edit(s.k, e.target.value)} />
              {s.text !== s.orig && <details className="orig"><summary data-testid={`prop-orig-sum-${s.k}`}>AI の原文を見る(Claude が作った文章)</summary><div className="origtext" data-testid={`prop-orig-${s.k}`}>{s.orig}</div></details>}
              {(s.k === "facts" || s.k === "hyp" || s.k === "cand") && (
                <div className="refs">
                  {uniq(refsOf(s.k === "facts" ? draft.facts : s.k === "hyp" ? draft.hypotheses : draft.check_candidates)).map((r) => (
                    <button key={keyOf(r)} className={`refchip ${badKeys.has(keyOf(r)) ? "bad" : ""}`} data-testid={`prop-ref-${r.section_id}`} onClick={() => props.onJump(r)}>{badKeys.has(keyOf(r)) ? "根拠不明 " : "根拠 "}{r.doc_id} v{r.version} {r.section_id}</button>
                  ))}
                </div>
              )}
            </div>
          ))}
          <div className="btnrow" style={{ gridTemplateColumns: "1fr" }}>
            <button className="btn bev def" data-testid="prop-approve" disabled={blocked || approved} onClick={approve}>{approved ? "承認済み" : "エンジニアが承認する"}</button>
          </div>
          {chk && <div className={`res ins ${chk.ok ? "ok" : "block"}`} data-testid="prop-check"><div className="ic">{chk.ok ? "✓" : "✕"}</div><div><b>{chk.ok ? "承認しました" : "承認できません"}</b><div className="sub">{chk.msg}</div></div></div>}
          {meta && <div className="note" data-testid="prop-meta"><i>i</i><span>使用トークン: 入力 {meta.input_tokens ?? "-"} ／ 出力 {meta.output_tokens ?? "-"} ・ 要求ID {meta.request_id ?? "-"}・{meta.ms} ms</span></div>}
          <div className="note"><i>i</i><span>承認は、画面上の確定だけです。お客様への送信は、行いません。決めるのは施設、判断するのはエンジニアです。</span></div>
        </>
      )}
    </>
  );
}
