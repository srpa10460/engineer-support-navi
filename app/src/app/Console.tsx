"use client";
// エンジニアサポートNavi: 既存の API を呼ぶ最小の操作画面(Mobile First。技術検証版・架空データ)。
// 応答は加工・捏造せず、そのまま日本語の見出しにして表示する。API と src/lib は変更しない。
import { useEffect, useMemo, useRef, useState } from "react";
import devicesData from "@/data/devices.json"; // 架空の装置台帳(機種の選択肢用。サーバー専用の処理は取り込まない)
import ProposalPanel, { type SafetyCheck } from "./ProposalPanel";

type Env = {
  ok: boolean;
  case_id: string | null;
  safety: { blocked: boolean; rule_id: string | null };
  data: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  errors: string[];
  store_state?: string;
};
type Res = { status: number; env: Env };
type Tone = "ok" | "warn" | "block";

// 入力例(審査員が初めて触るときの操作用。入力欄に入れるだけで、登録や評価は自動では行わない)
const EX_SYMPTOM = "E210 が表示され Ready にならない"; // 資料の節がある E210(HeliosXR-A1 の資料)にそろえる
const EX_SAFE_ILK = "インターロックを無効化して照射を続けたい";
const EX_SAFE_PII = "患者の氏名と住所をこの案件に保存する";
const EX_SAFE_OK = "E210 の確認手順を教えてください"; // 許可される例(実際の判定で許可を確認済み。許可は、安全だという保証ではない)

const API = "/api/v1";
async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const r = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, env: (await r.json()) as Env };
}

const TABS = [
  { n: 1, label: "症状記録" },
  { n: 2, label: "装置特定" },
  { n: 3, label: "資料検索" },
  { n: 4, label: "安全確認" },
  { n: 5, label: "提案" },
];
const FIELD_JA: Record<string, string> = { symptom_text: "症状", dp_number: "受付番号", site_id: "設置先", reporter_role: "登録者", error_code: "エラー番号" };
const ICON: Record<Tone, string> = { ok: "✓", block: "✕", warn: "!" };
const apiLine = (r: Res, tail?: string) => `実際のAPI応答：HTTP ${r.status}${tail ? ` ／ ${tail}` : ""}`;

function Highlight({ text }: { text: string }) {
  return (
    <>
      {text.split(/(E\d{3})/).map((p, i) => (/^E\d{3}$/.test(p) ? <span key={i} className="errcode">{p}</span> : <span key={i}>{p}</span>))}
    </>
  );
}

function Verdict({ tone, title, sub, small }: { tone: Tone; title: string; sub?: string[]; small?: string }) {
  return (
    <div className={`res ins ${tone}`} data-testid="verdict" data-tone={tone}>
      <div className="ic">{ICON[tone]}</div>
      <div>
        <b>{title}</b>
        {sub?.filter(Boolean).map((s, i) => (
          <div className="sub" key={i}>{s}</div>
        ))}
        {small && <small>{small}</small>}
      </div>
    </div>
  );
}

export default function Console() {
  const [step, setStep] = useState(1);
  const [open, setOpen] = useState(false);
  const [caseId, setCaseId] = useState<string | null>(null);
  const [dp, setDp] = useState("DP-FIC-2026-0100-01");
  const [symptom, setSymptom] = useState("");
  const [site, setSite] = useState("HVN-SITE-001");
  const [regRes, setRegRes] = useState<Res | null>(null);
  const [regSite, setRegSite] = useState<string | null>(null); // 登録した案件の設置先(登録したときの値。STEP 1 で編集中の設置先とは別)
  const [model, setModel] = useState("");
  const [devRes, setDevRes] = useState<Res | null>(null);
  const [cands, setCands] = useState<Array<Record<string, any>>>([]); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [picked, setPicked] = useState<string | null>(null);
  const [confRes, setConfRes] = useState<Res | null>(null);
  const [docModel, setDocModel] = useState("");
  const [docRes, setDocRes] = useState<Res | null>(null);
  const [safeText, setSafeText] = useState("");
  const [safeRes, setSafeRes] = useState<Res | null>(null);
  const [kSymptom, setKSymptom] = useState<string | null>(null);
  const [kCase, setKCase] = useState<string | null>(null);
  const [kDevice, setKDevice] = useState<string | null>(null);
  const [kDoc, setKDoc] = useState<string | null>(null);
  const [kSafe, setKSafe] = useState<string | null>(null);
  const [lastKey, setLastKey] = useState<string | null>(null);
  const [kProp, setKProp] = useState<string | null>(null);
  const [safetyChecks, setSafetyChecks] = useState<SafetyCheck[]>([]);
  const [deviceConfirmed, setDeviceConfirmed] = useState(false);
  const [focusRef, setFocusRef] = useState<string | null>(null);
  const symRef = useRef<HTMLTextAreaElement>(null);
  const [showTop, setShowTop] = useState(false); // スクロールが 300px 以上のときだけ「▲ 上へ」を出す(表示だけ。工程の処理は変えない)
  useEffect(() => {
    const on = () => setShowTop(window.scrollY >= 300);
    on(); window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  function toTop() { window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); }

  async function doRegister() {
    const body: Record<string, string> = { dp_number: dp, site_id: site, reporter_role: "junior_fse" };
    if (symptom) body.symptom_text = symptom;
    const code = symptom.match(/E\d{3}/); // 症状に含まれるエラー番号を、エラー番号として送る
    if (code) body.error_code = code[0];
    const r = await call("POST", "/cases", body);
    setRegRes(r);
    if (r.status === 201 && r.env.ok) {
      setCaseId(r.env.case_id);
      setRegSite(site);
      setModel(""); setDevRes(null); setConfRes(null); setCands([]); setPicked(null); // 新しい案件を登録したら、前の案件の機種の選択と候補を消す
      // 新しい案件を登録したら、前の案件に属する状態(装置の確定、資料検索、安全確認、案件カルテの表示、相談文)も初期の状態に戻す。登録が失敗したときは、ここへ来ないので、今の案件の状態は消えない
      setDeviceConfirmed(false); setDocRes(null); setDocModel(""); setSafeRes(null); setSafeText(""); setSafetyChecks([]); setKDevice(null); setKDoc(null); setKSafe(null); setKProp(null); setFocusRef(null);
      setKSymptom(`${r.env.data.symptom_text}`);
      setKCase(`✓ 登録済み(${r.env.data.dp_number})`);
      setLastKey("case");
    }
  }
  async function doSearch() {
    if (!caseId) return;
    const r = await call("POST", `/cases/${caseId}/device-search`, model ? { model } : {});
    setDevRes(r);
    setConfRes(null);
    setCands(r.env.ok ? r.env.data.candidates ?? [] : []);
    setPicked(null);
    if (r.env.ok) { setKDevice(`候補 ${(r.env.data.candidates ?? []).length} 台(未確定)`); setLastKey("device"); }
  }
  async function doConfirm() {
    if (!caseId || !picked) return;
    const r = await call("POST", `/cases/${caseId}/device-confirm`, { device_id: picked, human_selected: true, confirmed_by_role: "junior_fse" });
    setConfRes(r);
    if (r.env.ok) {
      const c = cands.find((x) => x.device_id === picked);
      setKDevice(`✓ ${picked}(${c?.room ?? ""})確定`); setLastKey("device"); setDeviceConfirmed(true);
    }
  }
  async function doDocs() {
    if (!caseId) return;
    const r = await call("POST", `/cases/${caseId}/document-search`, docModel ? { model: docModel } : {});
    setDocRes(r);
    if (r.env.ok) {
      const h = r.env.data.hits ?? [];
      setKDoc(h.length ? `${h[0].doc_id} v${h[0].version} 節 ${h[0].section_id}(${h.length} 件)` : "該当なし"); setLastKey("doc");
    }
  }
  async function doSafe() {
    const r = await call("POST", "/actions/evaluate", { text: safeText, role: "junior_fse" });
    setSafeRes(r);
    if (r.env.ok || r.env.safety.blocked) { setKSafe(r.env.safety.blocked ? `拒否 ${r.env.safety.rule_id}` : "許可"); setLastKey("safe"); setSafetyChecks((a) => [...a, { allowed: !r.env.safety.blocked, rule_id: r.env.safety.rule_id }].slice(-10)); }
  }
  // 機種の選択肢: 登録済みの案件の設置先にある機種を、重複なく、台数つきで並べる
  const modelOptions = useMemo(() => {
    if (!regSite) return [] as Array<{ model: string; n: number }>;
    const m = new Map<string, number>();
    for (const d of devicesData.devices) if (d.site_id === regSite) m.set(d.model, (m.get(d.model) ?? 0) + 1);
    return [...m].map(([model, n]) => ({ model, n }));
  }, [regSite]);
  function onModelChange(v: string) { setModel(v); setDevRes(null); setConfRes(null); setCands([]); setPicked(null); } // 機種を変えたら、前の候補と選択を消す
  function doClear() { setSymptom(""); setRegRes(null); symRef.current?.focus(); }

  const regView = (() => {
    if (!regRes) return null;
    const { status, env } = regRes;
    const small = apiLine(regRes, env.store_state);
    if (status === 201 && env.ok) return <Verdict tone="ok" title="登録完了" sub={[`案件 ${env.data.dp_number}`]} small={small} />;
    if (status === 409) return <Verdict tone="warn" title="重複のため、登録しません" sub={["同じ受付番号の案件が、すでにあります", "上の受付番号を別の番号に変えて、もう一度登録してください。既存の案件は変わりません。"]} small={small} />;
    if (status === 422) return <Verdict tone="warn" title="入力不足のため、登録しません" sub={[`足りない項目: ${(env.data.missing_fields ?? []).map((f: string) => FIELD_JA[f] ?? f).join("、")}`]} small={small} />;
    if (status === 403) return <Verdict tone="block" title="安全上の理由で、拒否しました" sub={[env.data.user_message ?? "", `ルール ${env.safety.rule_id}`]} small={small} />;
    return <Verdict tone="warn" title="登録できませんでした" sub={env.errors} small={small} />;
  })();

  const devView = (() => {
    if (confRes) {
      const { status, env } = confRes;
      const small = apiLine(confRes, env.store_state);
      if (env.ok) return <Verdict tone="ok" title="装置を確定しました" sub={[`${env.data.device_id}(エンジニアが選んだ装置を、自己申告として記録)`]} small={small} />;
      if (status === 409) return <Verdict tone="warn" title="確定済みのため、再確定は拒否しました" sub={[`確定済みの装置: ${env.data.device_id}`]} small={small} />;
      return <Verdict tone="warn" title="確定できませんでした" sub={env.errors} small={small} />;
    }
    if (devRes && !devRes.env.ok) return <Verdict tone="warn" title="候補を検索できませんでした" sub={devRes.env.errors} small={apiLine(devRes)} />;
    if (devRes) return <Verdict tone="ok" title={`候補 ${cands.length} 台`} sub={[devRes.env.data.note ?? "エンジニアが 1 台を選んで確定します"]} small={apiLine(devRes, devRes.env.store_state)} />;
    return null;
  })();

  const docView = (() => {
    if (!docRes) return null;
    const { env } = docRes;
    if (!env.ok) return <Verdict tone="warn" title="資料を検索できませんでした" sub={env.errors} small={apiLine(docRes)} />;
    return <Verdict tone="ok" title={`根拠資料 ${(env.data.hits ?? []).length} 件`} sub={[`対象の機種: ${env.data.model}(確定した装置の機種に限定)`]} small={apiLine(docRes)} />;
  })();

  const safeView = (() => {
    if (!safeRes) return null;
    const { env } = safeRes;
    if (env.safety.blocked) return <Verdict tone="block" title="拒否しました" sub={[env.data.reason ?? "", `ルール ${env.safety.rule_id} ・ 相談先: ${env.data.escalate_to ?? "-"}`, env.data.user_message ?? ""]} small={apiLine(safeRes)} />;
    if (env.ok) return <Verdict tone="ok" title="許可しました" sub={["この相談文は、安全ゲートで止めません"]} small={apiLine(safeRes)} />;
    return <Verdict tone="warn" title="確認できませんでした" sub={env.errors} small={apiLine(safeRes)} />;
  })();

  const rows: Array<{ k: string; label: string; chip: string; v: string | null }> = [
    { k: "symptom", label: "症状", chip: "症状", v: kSymptom },
    { k: "case", label: "案件", chip: "案件", v: kCase },
    { k: "device", label: "装置", chip: "装置", v: kDevice },
    { k: "doc", label: "根拠資料", chip: "資料", v: kDoc },
    { k: "safe", label: "安全ゲート", chip: "安全", v: kSafe },
    { k: "prop", label: "提案", chip: "提案", v: kProp },
  ];
  const lastRow = lastKey === "case" ? "case" : lastKey;
  const table = (testid: string) => (
    <div className="table" data-testid={testid}>
      {rows.map((r) => (
        <div className={`trow ${r.v ? "" : "todo"} ${r.v && (lastRow === r.k || (lastKey === "case" && r.k === "symptom")) ? "new" : ""}`} key={r.k} data-testid={`ledger-${r.k}`}>
          <div className="tl">{r.label}</div>
          <div className="tv">{r.v ? (r.k === "symptom" ? <Highlight text={r.v} /> : r.v) : "これから(未確認)"}</div>
        </div>
      ))}
      <div className="note"><i>i</i><span>カルテは実際のAPI応答だけから更新されます。判断と確定は、エンジニアが行います。</span></div>
    </div>
  );

  return (
    <div className="win" data-testid="app">
      <header className="title">
        <button className="mb bev" aria-label="メニュー(デモでは未使用)" disabled><i /></button>
        <b>エンジニアサポートNavi<small>案件 {dp}</small></b>
      </header>
      <div className="badge ins" data-testid="demo-badge">技術検証版・架空データ</div>

      <nav className="tabs five" aria-label="工程">
        {TABS.map((s) => (
          <button className={`tab bev ${step === s.n ? "on" : ""}`} key={s.n} data-testid={`step-${s.n}`} onClick={() => setStep(s.n)}>
            <span className="n">{s.n}</span>
            <br />
            {s.label}
          </button>
        ))}
      </nav>

      <div className="grid">
        <main className="content bev" data-testid={`panel-${step}`}>
          <div className="strip ins sm-only" data-testid="karte-strip">
            <div className="h">
              <span>案件カルテ</span>
              <button data-testid="ledger-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "▲ 閉じる" : "▼ 開く"}</button>
            </div>
            <div className="dots six">
              {rows.map((r) => (
                <div className={`dot ${r.v ? (lastKey === r.k || (lastKey === "case" && r.k === "symptom") ? "new" : "ok") : ""}`} key={r.k} data-testid={`chip-${r.k}`}>
                  {r.chip}{r.v && (lastKey === r.k || (lastKey === "case" && r.k === "symptom")) ? "✓" : ""}
                </div>
              ))}
            </div>
            {open && table("ledger-list")}
          </div>

          {step === 1 && (
            <>
              <div className="sec"><i />案件を登録する</div>
              <div><span className="lab bev">受付番号</span><input className="field ins mono" data-testid="dp" value={dp} onChange={(e) => setDp(e.target.value)} /></div>
              <div>
                <span className="lab bev">症　状</span>
                <div className="symwrap">
                  <div className="mirror" aria-hidden="true"><Highlight text={symptom} />{"​"}</div>
                  <textarea ref={symRef} className="field ins" data-testid="symptom" value={symptom} onChange={(e) => setSymptom(e.target.value)} aria-label="症状" />
                </div>
              </div>
              <div><span className="lab bev">設置先</span>
                <select className="field ins mono" data-testid="site" value={site} onChange={(e) => setSite(e.target.value)}>
                  <option value="HVN-SITE-001">HVN-SITE-001(架空)</option>
                  <option value="HVN-SITE-002">HVN-SITE-002(架空)</option>
                </select>
              </div>
              <div><span className="lab bev">登録者</span><div className="field ins">新人サービスエンジニア</div></div>
              <div className="note guide" data-testid="ex-symptom-hint"><i>i</i><span>初めて操作するときは、症状の入力例を使えます。入力欄に入れるだけで、登録は「登録」を押したときに行います。</span></div>
              <div className="btnrow">
                <button className="btn bev" data-testid="ex-symptom" onClick={() => setSymptom(EX_SYMPTOM)}>症状の入力例を入れる</button>
              </div>
              <div className="btnrow">
                <button className="btn bev" data-testid="clear" onClick={doClear}>クリア</button>
                <button className="btn bev def" data-testid="register" onClick={doRegister}>登録</button>
              </div>
              {regView}
            </>
          )}
          {step === 2 && (
            <>
              <div className="sec"><i />候補から、エンジニアが 1 台を選ぶ</div>
              {!caseId && <div className="hint" data-testid="need-case">先に「1 症状記録」で案件を登録してください。</div>}
              <div><span className="lab bev">機　種</span>
                <select className="field ins mono" data-testid="model" value={model} disabled={!caseId} onChange={(e) => onModelChange(e.target.value)}>
                  <option value="">機種を選んでください</option>
                  {modelOptions.map((o) => <option key={o.model} value={o.model}>{o.model}({o.n} 台)</option>)}
                </select>
              </div>
              {caseId && regSite && <div className="note guide" data-testid="model-hint"><i>i</i><span>設置先 {regSite} にある機種から選びます。選んだ機種の装置が、候補に出ます。</span></div>}
              <button className="btn bev" data-testid="search" disabled={!caseId || !model} onClick={doSearch}>候補を検索</button>
              <div className="cands">
                {cands.map((c) => (
                  <button key={c.device_id} className={`cand bev ${picked === c.device_id ? "picked" : ""}`} data-testid={`cand-${c.device_id}`} onClick={() => setPicked(c.device_id)}>
                    <b>{c.device_id}</b>
                    <span>{c.model} ・ {c.room} ・ {c.install_year} 年設置</span>
                    <span className="mono">{c.serial}</span>
                  </button>
                ))}
              </div>
              <button className="btn bev def" data-testid="confirm" disabled={!caseId || !picked} onClick={doConfirm}>この装置で確定</button>
              {devView}
            </>
          )}
          {step === 3 && (
            <>
              <div className="sec"><i />確定した装置の資料を探す</div>
              {!caseId && <div className="hint" data-testid="need-case">先に「1 症状記録」で案件を登録してください。</div>}
              <div><span className="lab bev">機種の指定(任意)</span><input className="field ins mono" data-testid="docmodel" value={docModel} onChange={(e) => setDocModel(e.target.value)} placeholder="指定しても、確定した装置の機種に限定されます" /></div>
              <button className="btn bev def" data-testid="docsearch" disabled={!caseId} onClick={doDocs}>資料を検索</button>
              {docView}
              <div className="hits">
                {(docRes?.env.ok ? docRes.env.data.hits ?? [] : []).map((h: Record<string, string>) => (
                  <div className={`hit ins ${focusRef === `${h.doc_id}|${h.version}|${h.section_id}` ? "focus" : ""}`} key={h.evidence_id} data-testid="hit">
                    <div className="hid">{h.doc_id} ・ 版 {h.version} ・ 節 {h.section_id}</div>
                    <div className="htitle">{h.title}</div>
                  </div>
                ))}
              </div>
            </>
          )}
          <div style={{ display: step === 5 ? "contents" : "none" }}>
            <ProposalPanel key={caseId ?? "none"} caseId={caseId} ready={!!caseId && deviceConfirmed && !!docRes?.env.ok} safety={safetyChecks} onJump={(r) => { setFocusRef(`${r.doc_id}|${r.version}|${r.section_id}`); setStep(3); }} onStage={(st) => { setKProp(st === "approved" ? "✓ エンジニア承認済み" : st === "draft" ? "AI下書き(Claude)" : null); if (st !== "none") setLastKey("prop"); }} />
          </div>
          {step === 4 && (
            <>
              <div className="sec"><i />相談文が安全か、確認する</div>
              <div><span className="lab bev">相談文</span><textarea className="field ins" data-testid="safetext" style={{ height: 96 }} value={safeText} onChange={(e) => setSafeText(e.target.value)} /></div>
              <div className="note guide" data-testid="ex-safe-hint"><i>i</i><span>相談文の入力例です。押すと、今の入力を例に置き換えます。評価は「確認」を押したときに行います。</span></div>
              <div className="btnrow">
                <button className="btn bev" data-testid="ex-safe-ilk" onClick={() => setSafeText(EX_SAFE_ILK)}>例: 危険な依頼</button>
                <button className="btn bev" data-testid="ex-safe-pii" onClick={() => setSafeText(EX_SAFE_PII)}>例: 個人情報の保存依頼</button>
                <button className="btn bev" data-testid="ex-safe-ok" onClick={() => setSafeText(EX_SAFE_OK)}>例: 通常の相談</button>
              </div>
              <button className="btn bev def" data-testid="safecheck" disabled={!safeText} onClick={doSafe}>確認</button>
              {safeView}
              <div className="note"><i>i</i><span>分割された入力など、検出できないケースが残っています。安全ゲートは、すべての危険な入力を防ぐものではありません。</span></div>
            </>
          )}
        </main>

        <aside className="content bev pc-only" data-testid="ledger">
          <div className="sec"><i />案件カルテ</div>
          {table("ledger-table")}
        </aside>
      </div>

      <footer className="stbar">
        <span>準備完了</span>
        <span>接続先：localhost(技術検証)</span>
        <span className="w">診断・治療・医療判断は行いません</span>
      </footer>
      {showTop && <button type="button" className="totop bev" data-testid="to-top" aria-label="ページの先頭へ戻る" onClick={toTop}>▲ 上へ</button>}
    </div>
  );
}
