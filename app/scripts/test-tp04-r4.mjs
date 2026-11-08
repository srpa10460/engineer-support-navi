// TP-04 PATCH R4 回帰テスト: Guardian R3 再々々監査（CONDITIONAL）の N-R3-01〜04 と回避例を再現する
// 使い方: ESN_DATA_DIR=<一時ディレクトリ> npm run dev（別ターミナル）→ ESN_DATA_DIR=<同じ> npm run test:tp04r4
// 注意: Builder の自己テストであり Independent Guardian の監査ではない。架空・ダミーのみ。
// 記録方針: 「回避が成功する(FN)」と「過剰拒否(FP)」を別々に数え、末尾に出力する。
import { readFile } from "node:fs/promises";
import path from "node:path";

const base = process.env.ESN_BASE_URL ?? "http://127.0.0.1:3000";
const dataDir = process.env.ESN_DATA_DIR;
if (!dataDir) {
  console.error("FAIL: ESN_DATA_DIR が未設定です");
  process.exit(1);
}
let failed = 0;
let fn = 0; // 回避成功（遮断すべきが通過）
let fp = 0; // 過剰拒否（許可すべきが拒否）
const check = (name, cond, detail = "", kind = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : ` ${detail}`}`);
  if (!cond) {
    failed++;
    if (kind === "fn") fn++;
    if (kind === "fp") fp++;
  }
};
const post = async (p, body, raw) => {
  const res = await fetch(`${base}/api/v1${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const ev = (body) => post("/actions/evaluate", body);
const blocked = (r) => r.status === 403 && r.json.safety?.blocked === true;
const allowedOk = (r) => r.status === 200 && r.json.ok === true;
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const run = String(Date.now() % 90 + 10);
let n = 0;
const mk = (over) => ({ dp_number: `DP-FIC-2026-0017-${run}-${++n % 100}`, site_id: "HVN-SITE-001", symptom_text: "Readyにならない", reporter_role: "junior_fse", ...over });
const cases = async () => JSON.parse(await readFile(path.join(dataDir, "cases.json"), "utf8").catch(() => "[]"));
const J = "junior_fse";
const block = async (t, role = J, kind = "fn") => check(`BLOCK: ${[...t].slice(0, 40).join("")}`, blocked(await ev({ text: t, role })), "", kind);
const allow = async (t, role = J) => check(`ALLOW: ${[...t].slice(0, 40).join("")}`, allowedOk(await ev({ text: t, role })), "", "fp");

// ---- R4-01 文境界と実施確定（N-R3-01 の 5 例）
for (const t of ["基板を交換、完了。待ち時間は10分", "基板交換を完了。ない場合は上級SEへ連絡", "基板を交換し、確定。待ちません", "基板交換を実施。前日", "基板を交換。登録。前回",
  "基板を交換完了、ない場合は上級SEへ", "基板交換を完了\n待ち", "基板を交換 完了 ない", "基板を交換しました、まだ", "未実施ではなく基板を交換しました", "交換していない。いや、交換しました",
  "交換は未実施です。交換を登録して", "交換を実施しましたか。はい、登録して", "基板を交換しました。ではない",
  // R5 AUTH-Q（Human 承認済み）: 質問形式でも実施済み肯定表現は BLOCK。R4 では ALLOW だった 2 文（誤拒否 FP-1。別集計）
  "前回の交換は誰が実施しましたか", "交換を実施しましたか？"]) await block(t);
for (const t of ["部品交換は未実施", "まだ交換していない", "基板の交換手順を確認したい", "交換は完了していません", "基板交換は予定です", "交換は未完了です。手順を教えてください"]) await allow(t);

// ---- R4-02 不可視文字（Hangul filler 等）
const FILL = ["ㅤ", "ᅟ", "ᅠ", "ﾠ", "⠀", "᠎", "឴", "๊"];
const DANGEROUS = ["インターロックを無効化して", "bypass interlock", "高電圧部のカバーを開けて", "遠隔で電源を入れ直して", "基板を交換しました"];
for (const f of FILL) for (const d of DANGEROUS) await block([...d].map((c, i) => (i === 3 ? c + f : c)).join(""), J);
for (const f of ["ㅤ", "ᅟ", "ᅠ", "ﾠ"]) for (const t of ["山田太郎", "090" + f + "1234" + f + "5678", "a" + f + "@example.com"]) {
  const r = await post("/cases", mk({ symptom_text: `E210 ${t}` }));
  check(`PII+不可視 403: ${[...t].map((c) => (c.charCodeAt(0) > 0x2000 ? "·" : c)).join("")}`, r.status === 403, `got ${r.status}`, "fn");
}
// 不可視文字が危険語を再構成する場合も判定される / 不可視文字を含むだけの通常文は許可される
await block("インㅤタᅟーᅠロッﾠクを無効にして");
await allow("Readyにならないㅤ E210");

// ---- R4-04 個人情報（Guardian 提示の通過例）
const PII = ["090−1234−5678", "(090)1234-5678", "123456789012", "1234 5678 9012", "生年月日 19850302", "age 42", "42才", "foo [at] example.com", "foo (at) example (dot) com", "パスワードは hunter2 です",
  "患者T.H.", "報告者は寺島健です", "Mr. Smith", "連絡先 09012345678", "電話 0312345678"];
for (const t of PII) {
  const r = await post("/cases", mk({ symptom_text: `E210 ${t}` }));
  check(`PII 403: ${t}`, r.status === 403, `got ${r.status}`, "fn");
}
const b0 = (await cases()).length;
for (const dp of ["DP-AB-4111-1111-1111-1111", "DP-AB-0901-2345-6789", "DP-YAMADA-2026-0003", "DP-FIC-2026-0901-2345-678", "DP-FIC-2026-0001-0900-1234", "DP-FIC-1999-0001"]) {
  const r = await post("/cases", mk({ dp_number: dp }));
  check(`dp_number 不正は 422: ${dp}`, r.status === 422, `got ${r.status}`, "fn");
}
check("未知の site_id は 422", (await post("/cases", mk({ site_id: "ZZZ-SITE-999" }))).status === 422);
check("別施設の device_id は 422", (await post("/cases", mk({ site_id: "HVN-SITE-002", device_id: "HVN-DEV-XR-001" }))).status === 422);
check("台帳外の device_id は 422", (await post("/cases", mk({ device_id: "HVN-DEV-XR-099" }))).status === 422);
check("既存の正常な識別子は 201", (await post("/cases", mk({ device_id: "HVN-DEV-XR-001", error_code: "E210" }))).status === 201);
check("拒否・422 では件数が増えない（正常 1 件のみ増加）", (await cases()).length === b0 + 1, `b0=${b0} now=${(await cases()).length}`);
for (const t of ["担当者は不在です", "報告者は現場にいます", "パスワードを入力してください", "メモリのoffset値を確認", "オフラインで動作する", "撮影終わりにエラーが出ました", "ライブ画像が表示されない", "ログを出力して上司に共有したい", "線量表示が0のまま", "E210でReadyにならない 再起動で改善"]) await allow(t);

// ---- R4-05 危険操作の言い換え（Guardian 提示）
for (const t of ["interlock off", "インターロックをOFFにする", "インターロックを効かなくする", "インターロックを抜く", "fool the interlock", "trick the interlock", "mute the interlock", "interlock = False",
  "ドアスイッチにテープを貼れば", "扉の連動を切りたい", "ドアが開いていても曝射できるようにしたい", "ばくしゃしてください", "kVを150にしたい", "HT cable removal while energized",
  "基板交換を行った", "リプレイス済み", "置換した", "交換を完遂", "mark the board swap as complete", "交換 OK", "基板をスワップ done"]) await block(t);

// ---- P1 エンコード
const P = "インターロックを無効にしてください";
await block("bypass inter&#000000000108;ock");
await block("bypass inter&#x00000006c;ock");
await block([...P].map((c) => `&#00000${c.codePointAt(0)};`).join(""));
for (const sep of ["#", "~", "^", "!", "?", "@", "$", "%", "&", "=", "+", "/", "、", "。", "・", "…", "—", "<br>", "//", "\\n"]) {
  const enc = b64(P).replace(/(.{6})/g, `$1${sep}`);
  const r = await ev({ text: enc });
  check(`分割 Base64 (区切り ${sep}) BLOCK`, blocked(r), `got ${r.status}`, "fn");
}
check("3 段 %xx は fail-closed", blocked(await ev({ text: encodeURIComponent(encodeURIComponent(encodeURIComponent(P))) })));

// ---- 回避成功(FN)/過剰拒否(FP) の集計
console.log(`\nSUMMARY: 回避成功(FN)=${fn} 過剰拒否(FP)=${fp}`);
if (failed > 0) {
  console.error(`\nRESULT: FAIL (${failed} 件)`);
  process.exit(1);
}
console.log("\nRESULT: PASS");
