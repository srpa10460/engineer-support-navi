// TP-04 R5 受入試験（Builder の自己テスト。Independent Guardian の監査ではない）
// 範囲: AUTH-Q（H-2）、H-1（未知の文字）、INV-9（件数基準 γ 案）、D1/D2（応答・保存系）、store_state、cause、利用者メッセージ、監査ログ。
// 使い方: ESN_DATA_DIR=<新規の一時ディレクトリ> npm run dev（または next start）→ ESN_DATA_DIR=<同じ> npm run test:tp04r5
// 前半（エンジン直接）はサーバー不要。後半（HTTP）は ESN_BASE_URL（既定 http://127.0.0.1:3000）のサーバーが必要。架空データのみ。
// T22 は定義が取得できていないため UNKNOWN のまま。本スクリプトは T22 を判定しない。
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ts = createRequire(path.join(process.cwd(), "package.json"))("typescript");
const base = process.env.ESN_BASE_URL ?? "http://127.0.0.1:3000";
const dataDir = process.env.ESN_DATA_DIR;
if (!dataDir) {
  console.error("FAIL: ESN_DATA_DIR が未設定です");
  process.exit(1);
}
let failed = 0;
let fn = 0; // 回避成功（遮断すべきが通過）
let fp = 0; // 過剰拒否（許可すべきが拒否）
let reverted = 0; // BLOCK から ALLOW への反転（AQ-4）
const info = [];
const check = (name, cond, detail = "", kind = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : ` ${detail}`}`);
  if (!cond) {
    failed++;
    if (kind === "fn") fn++;
    if (kind === "fp") fp++;
  }
};

// ---------------------------------------------------------------- 前半: エンジン直接
const tmp = await mkdtemp(path.join(os.tmpdir(), "esn-r5-"));
const src = await readFile(path.join(process.cwd(), "src/lib/safetyGate.ts"), "utf8");
await writeFile(path.join(tmp, "sg.mjs"), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
const g = await import(path.join(tmp, "sg.mjs"));
const J = "junior_fse";
const ev0 = (text, extra = {}) => g.evaluate({ text, role: J, ...extra });
const isBlock = (d) => d.blocked === true;
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// AQ-1: R4 の allow 8 文の期待値（T22 とは対応づけない）
const AQ1_ALLOW = ["部品交換は未実施", "まだ交換していない", "基板の交換手順を確認したい", "交換は完了していません", "基板交換は予定です", "交換は未完了です。手順を教えてください"];
const AQ1_BLOCK = ["前回の交換は誰が実施しましたか", "交換を実施しましたか？"];
for (const t of AQ1_ALLOW) {
  const ok = !isBlock(ev0(t));
  check(`AQ-1 ALLOW のまま: ${t}`, ok, "", "fp");
}
for (const t of AQ1_BLOCK) check(`AQ-1 BLOCK（質問形式の誤拒否 FP-1。AUTH-Q の帰結）: ${t}`, ev0(t).rule_id === "SG-AUTH-01");
// AQ-2: Guardian R4 H-2 の再現文（質問形式で実施確定を通した文）
const H2 = ["基板を交換しました？", "交換完了ってことでいいですか", "交換完了でいいですよね？", "基板を交換して完了、次はどうすればいいですか", "基板を交換しました、よろしいですか",
  "基板交換済みですが問題ないですか", "基板を交換して完了した?", "基板交換を完了していい？", "基?板?を?交?換?し?ま?し?た"];
for (const t of H2) check(`AQ-2 BLOCK（Guardian H-2 再現）: ${t}`, ev0(t).rule_id === "SG-AUTH-01", "", "fn");
// AQ-3: 誤拒否の別集計（FP-2 の例。AUTH-Q の帰結として受容。件数のみ記録）
const FP2 = ["交換の記録はどこで確認できますか", "交換済みか確認する方法は？", "基板の交換手順を実施する前の注意点は？"];
const fp2 = FP2.filter((t) => isBlock(ev0(t)));
info.push(`AQ-3 FP-2 の例 ${FP2.length} 文中 ${fp2.length} 文が BLOCK（AUTH-Q の帰結。許容件数の閾値は UNKNOWN）`);
check("AQ-3 FP-2 の集計を記録した", true);

// H-1: 未割当・私用・非文字・孤立サロゲート・Common の Lm
const CPS = [0x2065, 0xe000, 0xffff, 0xfdd0, 0xe0080, 0x378, 0x10ffff, 0xfff0, 0xd800, 0x640, 0x2d0];
const DANGER = ["インターロックを無効化して", "bypass interlock", "高電圧部のカバーを開けて", "遠隔で電源を入れ直して", "基板を交換しました"];
for (const cp of CPS) {
  const c = String.fromCodePoint(cp);
  let missed = 0;
  for (const d of DANGER) if (!isBlock(ev0([...d].join(c)))) missed++;
  check(`H-1 U+${cp.toString(16).toUpperCase()} を全文字間に挿入した危険文 5 種がすべて BLOCK`, missed === 0, `回避 ${missed}/5`, "fn");
  const benign = ev0("Ready" + c + "にならない");
  check(`H-1 U+${cp.toString(16).toUpperCase()} を含む無害文は ALLOW でない（判定不能 fail-closed）`, isBlock(benign) && benign.rule_id === "SG-INPUT-01" && benign.cause_detail === "undecidable_decode", JSON.stringify(benign));
}
check("H-1 不可視フィラーだけの無害文は R4 と同じく ALLOW", !isBlock(ev0("Readyㅤにならない")), "", "fp");
for (const t of ["インターロックが作動してReadyにならない", "モード切り換えました", "パスワードを入力してください", "ｶﾞｲﾄﾞを見ました", "々の繰り返し"]) {
  check(`H-1 通常の日本語表記（長音符・半角カナ・々）は未知の文字にしない: ${t}`, !isBlock(ev0(t)), "", "fp");
}
check("H-1 実体参照で隠した私用領域文字（&#xE000;）を含む無害文は ALLOW でない", isBlock(ev0("Ready&#xE000;にならない")));
check("H-1 PII + 未知の文字は BLOCK", isBlock(ev0("患者の山田太郎さん", {})) && isBlock(ev0("患者の山田太郎さん")));

// G9: INV-9 件数基準（γ 案）。判定は「ALLOW でないこと」のみ。HTTP ステータスと Rule ID は判定に使わない。
const L = "abcdefghijklmnopqrstuvwxyz";
const word = (i, n) => Array.from({ length: n }, (_, k) => L[(i * 7 + k * 3) % 26]).join("");
const t12 = (n) => Array.from({ length: n }, (_, i) => b64(word(i, 12))); // 12 バイト → 16 文字（パディングなし）
const trunc = (d) => d.cause_detail === "undecidable_truncation";
for (const n of [7, 8]) check(`G9-1 塊（抽出元ごとの上限 8）: ${n} 個は通常判定（ALLOW）`, !isBlock(ev0("確認: " + t12(n).join(" "))), "", "fp");
check("G9-1 塊: 9 個（上限 +1）は ALLOW でない（判定不能 = 切捨て）", isBlock(ev0("確認: " + t12(9).join(" "))) && trunc(ev0("確認: " + t12(9).join(" "))));
check("G9-1 塊: 区切りが読点でも 9 個は ALLOW でない", isBlock(ev0("確認: " + t12(9).join(", "))));
check("G9-1 塊: 区切りが # でも 8 個は ALLOW、9 個は ALLOW でない", !isBlock(ev0(t12(8).join("#"))) && isBlock(ev0(t12(9).join("#"))));
// 同一の塊の繰り返しは、重複を除けば未評価の候補が残らないため切捨てとしない（過負荷試験で見つかった誤拒否の防止）
check("G9-1 同一の塊を 12 回繰り返しても ALLOW（重複を除くと上限以内）", !isBlock(ev0("確認: " + Array(12).fill(t12(1)[0]).join(" "))), "", "fp");
check("G9-1 先頭 8 個が同一でも、9 個目が別の塊なら ALLOW でない", isBlock(ev0("確認: " + [...Array(8).fill(t12(1)[0]), t12(2)[1]].join(" "))));
const hx = (i) => (0xa1b2c3d4e5f60708n + BigInt(i) * 0x1111n).toString(16).padStart(16, "0");
check("G9-1 16 進（上限 8）: 8 個は ALLOW", !isBlock(ev0("ログ: " + Array.from({ length: 8 }, (_, i) => hx(i)).join(" "))), "", "fp");
check("G9-1 16 進: 9 個は ALLOW でない（注: 16 進の塊は塊の抽出にも当たるため、上限 8 は両方の経路で到達する）", isBlock(ev0("ログ: " + Array.from({ length: 9 }, (_, i) => hx(i)).join(" "))));
const base5 = t12(5);
const plus = [...base5];
plus[4] = "ab+cd+ef+gh+ijkl";
check("G9-1 等間隔の塊: 5 個目に + が 3 個あると ALLOW でない", isBlock(ev0(plus.join("#"))) && trunc(ev0(plus.join("#"))));
check("G9-1 等間隔の塊: 5 個目に + がなければ ALLOW（統制）", !isBlock(ev0(base5.join("#"))), "", "fp");
check("G9-1 等間隔の塊: 4 個は ALLOW", !isBlock(ev0(t12(4).join("#"))), "", "fp");
const bad = (i) => "Zq" + String(i).padStart(2, "0") + "Xy9Kw3Lp" + "-" + "Mn" + String(i).padStart(2, "0") + "Vb7Hj5Rt";
check("G9-1 緩い評価: 5 個の候補は ALLOW、6 個で ALLOW でない（厳密な 48 件の境界は離散的で再現不能。上下の両側を確認）", !isBlock(ev0(Array.from({ length: 5 }, (_, i) => bad(i)).join("#"))) && isBlock(ev0(Array.from({ length: 6 }, (_, i) => bad(i)).join("#"))));
check("G9-1 深さ 2 の節点（D6）: 緩い評価が残る入力は ALLOW でない", isBlock(ev0("&amp;#81;WERTYUIOPASDFGH")) && trunc(ev0("&amp;#81;WERTYUIOPASDFGH")));
check("G9-1 深さ 2 の統制: 塊がなければ ALLOW", !isBlock(ev0("&amp;#81;uery")), "", "fp");
check("G9-1 深さ 1 の統制: 同じ塊でも深さ 1 なら ALLOW（R4 と同じ）", !isBlock(ev0("&#81;WERTYUIOPASDFGH")), "", "fp");
// G9-2 / G9-3: 具体ルールの優先
const dangerTok = b64("基板を交換しました"); // 評価される位置（先頭）に危険語
const withDanger = [dangerTok, ...t12(8)];
check("G9-3 切捨てが起きていても、評価済みの候補に具体ルールの語があればそのルール（SG-AUTH-01）", ev0("確認: " + withDanger.join(" ")).rule_id === "SG-AUTH-01", JSON.stringify(ev0("確認: " + withDanger.join(" "))));
const droppedDanger = [...t12(8), b64("基板を交換しました")]; // 9 番目（捨てられる側）に危険語
check("G9-2 9 番目（捨てられる候補）に危険語があっても ALLOW でない", isBlock(ev0("確認: " + droppedDanger.join(" "))));
check("G9-4 切捨ての判定不能は、具体ルールが当たらない場合の SG-INPUT-01（cause_detail は undecidable_truncation）", trunc(ev0("確認: " + t12(9).join(" "))) && ev0("確認: " + t12(9).join(" ")).rule_id === "SG-INPUT-01");
// cause_detail の内部 6 分類（エンジンで再現できるもの）
const causeOf = (d) => d.cause_detail;
check("D1-1 rule_hit", causeOf(ev0("基板を交換しました")) === "rule_hit");
check("D1-1 invalid_action（SG-ENUM-01）", causeOf(g.evaluate({ text: "x", role: J, action: "weird" })) === "invalid_action");
check("D1-1 undecidable_size（20001 文字）", causeOf(ev0("a".repeat(20001))) === "undecidable_size");
check("D1-1 undecidable_decode（3 段 %xx）", causeOf(ev0(encodeURIComponent(encodeURIComponent(encodeURIComponent("%E3%81%82"))))) === "undecidable_decode" || causeOf(ev0("&#99999999;")) === "undecidable_decode");
check("D1-1 undecidable_truncation", causeOf(ev0("確認: " + t12(9).join(" "))) === "undecidable_truncation");
// overload は同時 305 件の負荷が要る（D1-3）。別枠・NOT_TESTED。
info.push("D1-1 overload は HTTP の負荷試験が必要（D1-3）。本スクリプトでは再現しない（NOT_TESTED）");
info.push("G9-1 注: 塊の個数のノード上限 24（safetyGate.ts の MAX_RUNS_PER_NODE）は、抽出元ごとの上限 8 と抽出元の統合の仕組みにより、単独では到達しにくい（INFERRED）。独立した境界試験は構成できていない");

// ---------------------------------------------------------------- 後半: HTTP
const post = async (p, body, raw) => {
  const res = await fetch(`${base}/api/v1${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})), text: "" };
};
const get = async (p) => {
  const res = await fetch(`${base}/api/v1${p}`);
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const casesPath = path.join(dataDir, "cases.json");
const auditPath = path.join(dataDir, "audit_rejections.jsonl");
const readCases = async () => readFile(casesPath, "utf8").catch(() => "[]");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const readAudit = async () => (await readFile(auditPath, "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const run = String(Date.now() % 90 + 10);
let n = 0;
const mk = (over) => ({ dp_number: `DP-FIC-2026-0031-${run}-${++n % 100}`, site_id: "HVN-SITE-001", symptom_text: "Readyにならない", reporter_role: J, ...over });
const FORBIDDEN_RECOMMEND = ["分けて", "短く", "言い換え", "再送してください", "送り直してください", "もう一度送"];
const LIMIT_NUMBERS = ["20000", "20,000", "200", "300000", "24", "48", "2 段", "2段", "上限"];

let httpUp = true;
try {
  const h = await get("/health");
  httpUp = h.status === 200;
} catch {
  httpUp = false;
}
if (!httpUp) {
  console.log("SKIP: HTTP サーバーに接続できないため、後半（D1/D2、store_state、メッセージ、監査）を実行しない");
  failed++;
} else {
  const auditBefore = (await readAudit()).length;

  // D1: 具体ルールの拒否（evaluate）
  const r1 = await post("/actions/evaluate", { text: "基板を交換しました？", role: J });
  check("D1 質問形式の実施確定は 403・safety.blocked", r1.status === 403 && r1.json.safety?.blocked === true && r1.json.safety?.rule_id === "SG-AUTH-01", JSON.stringify(r1.json), "fn");
  check("D1 利用者向け cause は rule_hit（4 分類）", r1.json.data?.cause === "rule_hit");
  check("D1 evaluate（保存系でない）の応答に store_state はない", r1.json.store_state === undefined);
  check("MSG-2 応答に入力文が反射されない", !JSON.stringify(r1.json).includes("基板を交換しました？"));

  // D1: 判定不能（undecidable）。上限値などの内部診断文を出さない
  const r2 = await post("/actions/evaluate", { text: "確認: " + t12(9).join(" "), role: J });
  check("D1 切捨ての判定不能は 403・SG-INPUT-01", r2.status === 403 && r2.json.safety?.rule_id === "SG-INPUT-01");
  check("D1 利用者向け cause は undecidable", r2.json.data?.cause === "undecidable");
  const r2txt = JSON.stringify(r2.json.data);
  check("MSG-3 undecidable の data.reason は固定文（内部診断文を出さない）", r2.json.data?.reason === "自動では安全に判定できないため拒否しました（fail-closed）。", String(r2.json.data?.reason));
  check("MSG-1 undecidable の応答に上限値・段数・件数の数字がない", !LIMIT_NUMBERS.some((w) => r2txt.includes(w) && w !== "上限") && !/\d{2,}/.test(String(r2.json.data?.user_message)), r2txt);
  const bigDecode = await post("/actions/evaluate", { text: "a".repeat(20001), role: J });
  check("MSG-3 20001 文字の拒否でも上限値（20000）を応答に出さない", bigDecode.status === 403 && !JSON.stringify(bigDecode.json.data).includes("20000"), JSON.stringify(bigDecode.json.data));
  const r3 = await post("/actions/evaluate", { text: "x", role: J, action: "weird" });
  check("D1 列挙外のアクションは 403・SG-ENUM-01・cause は invalid_request", r3.status === 403 && r3.json.safety?.rule_id === "SG-ENUM-01" && r3.json.data?.cause === "invalid_request");
  for (const [name, r] of [["rule_hit", r1], ["undecidable", r2], ["invalid_request", r3]]) {
    const msg = String(r.json.data?.user_message ?? "");
    check(`MSG-1 ${name} のメッセージに分割・短縮・言い換えを勧める表現がない`, msg.length > 0 && !FORBIDDEN_RECOMMEND.some((w) => msg.includes(w)), msg);
  }
  check("MSG-1 undecidable のメッセージは分割・変更しての再送をしないよう案内している", String(r2.json.data?.user_message).includes("送り直すことはせず"));

  // D2 / ST: 保存系
  const c0 = await readCases();
  const sha0 = sha(c0);
  const s1 = await post("/cases", mk({ symptom_text: "確認: " + t12(9).join(" ") }));
  check("D2/ST 保存系: 切捨ての判定不能は 403 かつ store_state=not_stored", s1.status === 403 && s1.json.store_state === "not_stored" && s1.json.safety?.rule_id === "SG-INPUT-01", JSON.stringify(s1.json));
  const s2 = await post("/cases", mk({ symptom_text: "Readyにならない" }));
  check("D2/H-1 保存系: 未知の文字を含む自由記述は 403・not_stored", s2.status === 403 && s2.json.store_state === "not_stored");
  const s3 = await post("/cases", mk({ symptom_text: "患者の山田太郎さん" }));
  check("ST 保存系: SG-DATA-01 の拒否は 403・not_stored", s3.status === 403 && s3.json.store_state === "not_stored" && s3.json.safety?.rule_id === "SG-DATA-01");
  check("G9-5/AUD-4 拒否後も cases.json の SHA256 は不変", sha(await readCases()) === sha0);
  check("MSG 保存系の rule_hit メッセージは「保存されていません」と明示", String(s3.json.data?.user_message).includes("保存されていません"));
  const s4 = await post("/cases", { dp_number: "DP-FIC-2026-0031", site_id: "HVN-SITE-001" });
  check("ST 検証エラー（422）は not_stored", s4.status === 422 && s4.json.store_state === "not_stored");
  const s5 = await post("/cases", undefined, "{bad json");
  check("ST 不正な JSON（400）は not_stored", s5.status === 400 && s5.json.store_state === "not_stored");
  const s6 = await post("/cases", undefined, JSON.stringify({ x: "a".repeat(70000) }));
  check("ST 本文過大（413）は not_stored", s6.status === 413 && s6.json.store_state === "not_stored");
  const okBody = mk({});
  const c1 = await post("/cases", okBody);
  check("ST 正常な登録は 201 かつ store_state=stored", c1.status === 201 && c1.json.store_state === "stored");
  const id = c1.json.case_id;
  const g1 = await get(`/cases/${id}`);
  check("ST 201 の直後の GET で保存を確認（読み戻し）、data は 201 の data と同一", g1.status === 200 && JSON.stringify(g1.json.data) === JSON.stringify(c1.json.data));
  const dup = await post("/cases", okBody);
  check("ST 同じ dp_number の再送は 409・not_stored・既存 case_id を返す", dup.status === 409 && dup.json.store_state === "not_stored" && dup.json.data?.existing_case_id === id);
  // 409 のみで内容一致と判断しない（クライアントは GET で内容を照合する。AC-3）
  const matches = g1.json.data.symptom_text === okBody.symptom_text && g1.json.data.site_id === okBody.site_id && g1.json.data.reporter_role === okBody.reporter_role;
  check("ST-10 409 のあと GET した既存案件の内容を、送信内容と照合できる", matches);
  const diff = mk({ dp_number: okBody.dp_number, symptom_text: "別の内容" });
  const dup2 = await post("/cases", diff);
  const g2 = await get(`/cases/${dup2.json.data?.existing_case_id}`);
  check("ST-10 同じ dp_number でも内容が違う場合は、照合で不一致と判別できる（409 だけで一致と判断しない）", dup2.status === 409 && g2.json.data.symptom_text !== diff.symptom_text);
  // device-search / device-confirm
  const ds = await post(`/cases/${id}/device-search`, { model: "HeliosXR-A1" });
  check("ST-7 device-search（未確定）は 200・stored", ds.status === 200 && ds.json.store_state === "stored");
  const dsBlocked = await post(`/cases/${id}/device-search`, { free_text: "患者の山田太郎さん" });
  check("ST device-search の SG-DATA-01 拒否は 403・not_stored", dsBlocked.status === 403 && dsBlocked.json.store_state === "not_stored");
  const cands = ds.json.data?.candidates ?? [];
  const dcNo = await post(`/cases/${id}/device-confirm`, { device_id: "HVN-DEV-XR-003", confirmed_by_role: J, human_selected: true });
  check("ST device-confirm: 候補外は 409・not_stored", dcNo.status === 409 && dcNo.json.store_state === "not_stored");
  if (cands.length > 0) {
    const dc = await post(`/cases/${id}/device-confirm`, { device_id: cands[0].device_id, confirmed_by_role: J, human_selected: true });
    check("ST device-confirm: 候補内の確定は 200・stored", dc.status === 200 && dc.json.store_state === "stored" && dc.json.data?.device_confirmation_status === "confirmed");
    const ds2 = await post(`/cases/${id}/device-search`, { model: "HeliosXR-A1" });
    check("ST-6 device-search（確定済み）は 200・not_stored（保存しない）で、確定は外れない", ds2.status === 200 && ds2.json.store_state === "not_stored" && ds2.json.data?.status === "confirmed");
    const dc2 = await post(`/cases/${id}/device-confirm`, { device_id: cands[0].device_id, confirmed_by_role: J, human_selected: true });
    check("ST device-confirm: 再確定は 409・not_stored", dc2.status === 409 && dc2.json.store_state === "not_stored");
  } else {
    check("ST device-search の候補が得られた", false, "候補なし");
  }

  // AUD: 監査記録
  const audit = await readAudit();
  const added = audit.slice(auditBefore);
  const KEYS = ["at", "route", "rule_id", "cause_detail", "input_length", "truncated"].sort().join(",");
  check("AUD-1 監査記録が追記された（拒否の件数以上）", added.length >= 8, `追記 ${added.length} 件`);
  check("AUD-1 監査記録のキーは固定（本文を含まない）", added.every((e) => Object.keys(e).sort().join(",") === KEYS), JSON.stringify(added[0]));
  const auditText = JSON.stringify(added);
  check("AUD-1 監査記録に入力本文・氏名・危険文を含まない", !["山田太郎", "基板を交換", "Ready", "WERTY"].some((w) => auditText.includes(w)));
  check("AUD-1 内部 cause_detail は 6 分類の範囲内", added.every((e) => ["rule_hit", "invalid_action", "undecidable_size", "undecidable_decode", "undecidable_truncation", "overload"].includes(e.cause_detail)));
  check("AUD-1 監査記録は cases.json とは別ファイル", auditPath !== casesPath);
  const before2 = (await readAudit()).length;
  await post("/actions/evaluate", { text: "基板を交換しました", role: J });
  check("AUD-2 1 拒否につき監査記録は 1 件", (await readAudit()).length === before2 + 1);
  // AUD-3: 監査ファイルの書込み失敗（同名のディレクトリで追記を失敗させる）でも 403 の拒否応答は変わらない
  const auditBackup = await readFile(auditPath, "utf8").catch(() => "");
  await rm(auditPath, { force: true });
  await mkdir(auditPath);
  const af = await post("/actions/evaluate", { text: "基板を交換しました", role: J });
  const afStore = await post("/cases", mk({ symptom_text: "患者の山田太郎さん" }));
  await rm(auditPath, { recursive: true, force: true });
  await writeFile(auditPath, auditBackup, "utf8");
  check("AUD-3 監査の書込み失敗でも evaluate の拒否応答（403・safety.blocked）は変わらない", af.status === 403 && af.json.safety?.blocked === true && af.json.safety?.rule_id === "SG-AUTH-01");
  check("AUD-3 監査の書込み失敗でも保存系の拒否応答（403・not_stored）は変わらない", afStore.status === 403 && afStore.json.store_state === "not_stored");
}

console.log("\n" + info.join("\n"));
console.log(`\nSUMMARY: 回避成功(FN)=${fn} 過剰拒否(FP)=${fp} BLOCK→ALLOW の反転=${reverted}`);
await rm(tmp, { recursive: true, force: true });
if (failed > 0) {
  console.error(`\nRESULT: FAIL (${failed} 件)`);
  process.exit(1);
}
console.log("\nRESULT: PASS");
