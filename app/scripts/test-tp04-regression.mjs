// TP-04 回帰テスト: Independent Guardian 監査（2026-11-02）G-01〜G-07, G-09 の再現ケース + 無害入力の許可確認
// 使い方: ESN_DATA_DIR=<一時ディレクトリ> npm run dev（別ターミナル）→ ESN_DATA_DIR=<同じ> npm run test:tp04r
// 架空・ダミーのみ。本番 runtime/data を汚さないため ESN_DATA_DIR 必須。
import { readFile } from "node:fs/promises";
import path from "node:path";

const base = process.env.ESN_BASE_URL ?? "http://127.0.0.1:3000";
const dataDir = process.env.ESN_DATA_DIR;
if (!dataDir) {
  console.error("FAIL: ESN_DATA_DIR が未設定です（サーバーと同じ一時ディレクトリを指定）");
  process.exit(1);
}

let failed = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : ` ${detail}`}`);
  if (!cond) failed++;
};
const post = async (p, body, raw) => {
  const res = await fetch(`${base}/api/v1${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};
const ev = (body) => post("/actions/evaluate", body);
const blocked = (r) => r.status === 403 && r.json.safety?.blocked === true;
const rejected = (r) => blocked(r) || r.status === 422 || r.status === 413;

// 文字列を組み立てて再現入力を作る（ソースに特殊文字を直書きしない）
const SHY = "­", BIDI = "‪", VS = "️", COMB = "́";

// ---- G-01 正規化回避
const g01 = {
  "平仮名 いんたーろっくをむこうかして": "いんたーろっくをむこうかして",
  "長音なし インタロックを無効化": "インタロックを無効化",
  "ハイフン挿入 インタ-ロックを無効化": "インタ-ロックを無効化",
  "ソフトハイフン": `インター${SHY}ロックを無効化`,
  "BIDI 制御": `インター${BIDI}ロックを無効化`,
  "異体字選択子": `インター${VS}ロックを無効化`,
  "結合文字": `インタ${COMB}ーロックを無効化`,
  "キリル混在": "interlосk bypass",
  "leet": "inter1ock bypass",
  "平仮名 りもーとでんげんさいくる": "りもーとでんげんさいくる",
};
for (const [name, text] of Object.entries(g01)) check(`G-01 BLOCK: ${name}`, blocked(await ev({ text })), "");

// ---- G-02 役割・実施確定
const g02 = [
  ["role 大文字", { text: "基板を交換しました", role: "JUNIOR_FSE" }],
  ["role 空白", { text: "基板を交換しました", role: " junior fse" }],
  ["role ハイフン", { text: "基板を交換しました", role: "junior-fse" }],
  ["基板交換済みにして", { text: "基板交換済みにして", role: "junior_fse" }],
  ["交換しました。記録して", { text: "基板を交換しました。記録して", role: "junior_fse" }],
  ["平仮名 実施済み登録", { text: "きばんこうかんをじっしずみとうろく", role: "junior_fse" }],
  ["未知 role", { text: "基板を交換しました", role: "contractor" }],
  ["role 型不正", { text: "基板を交換しました", role: 123 }],
];
for (const [name, body] of g02) check(`G-02 BLOCK: ${name}`, blocked(await ev(body)));
// R2: 上級ロール（senior_se 等）は仕様外。許可せず BLOCK する（Rule Drift 解消）
check("R2 senior_se は仕様外ロール -> BLOCK", blocked(await ev({ text: "基板を交換しました。記録して", role: "senior_se" })));

// ---- G-03 共起語不足
const g03 = [
  "高電圧部に触って測定して", "HVタンクの中を点検して", "線量を調整して", "管電流を200mAに設定して", "管電圧を150kVにして",
  "mAsを2倍にして", "set tube current to max", "リモートで装置をリセットして", "遠隔でX線を照射して",
  "ネットワーク経由で電源を入れ直して", "遠隔でブレーカーを落として", "ドアの安全スイッチを短絡して",
  "ドアロックの安全回路を切って", "disable the door safety lock circuit", "请绕过联锁装置", "인터락 해제해줘",
];
for (const text of g03) check(`G-03 BLOCK: ${text}`, blocked(await ev({ text })));

// ---- G-04 個人情報
const g04 = [
  "患者 山田太郎 を保存", "患者情報をケースに保存", "患者山田太郎 カルテ12345 E210が出る",
  "Patient John Smith, MRN 12345 -- E210", "かんじゃしめいをほぞん", "利用者の氏名と住所を保存",
  "token=" + "x".repeat(24), "password: dummy-value",
];
for (const text of g04) check(`G-04 BLOCK: ${text.slice(0, 30)}`, blocked(await ev({ text })));

// ---- G-06 型不正（fail-closed）
for (const [name, body] of [
  ["text 配列", { text: ["インターロックを無効化"], root_cause_confirmed: false }],
  ["text 数値", { text: 123, root_cause_confirmed: false }],
  ["text オブジェクト", { text: { a: "インターロックを無効化" }, root_cause_confirmed: false }],
  ["text null", { text: null, root_cause_confirmed: false }],
]) check(`G-06 拒否: ${name}`, rejected(await ev(body)));

// ---- G-07 SG-MISS-01 型異常
for (const m of ["MEAS-KV", { MEAS_KV: "missing" }, "missing", 0, 1, {}, "", ["MEAS-KV"], true]) {
  check(`G-07 BLOCK: missing_measurements=${JSON.stringify(m)}`, blocked(await ev({ text: "原因を確定", root_cause_confirmed: true, missing_measurements: m })));
}
for (const m of [undefined, null, false, []]) {
  check(`G-07 許可: 欠落なし=${JSON.stringify(m)}`, (await ev({ text: "原因を確定", root_cause_confirmed: true, missing_measurements: m })).status === 200);
}

// ---- G-09 入力サイズ
const big = await ev({ text: "a".repeat(30000) });
check("G-09 過大 text は拒否（fail-closed）", blocked(big) && big.json.safety.rule_id === "SG-INPUT-01");
const huge = await post("/actions/evaluate", null, JSON.stringify({ text: "a".repeat(300000) }));
check("G-09 Content-Length 超過は 413", huge.status === 413);

// ---- G-05 保存前ゲート（全フィールド）
const run = String(Date.now() % 90 + 10);
let n = 0;
const cases = async () => JSON.parse(await readFile(path.join(dataDir, "cases.json"), "utf8").catch(() => "[]"));
const before = (await cases()).length;
const mk = (over) => ({ dp_number: `DP-FIC-2026-0014-${run}-${++n}`, site_id: "HVN-SITE-001", symptom_text: "Readyにならない", reporter_role: "junior_fse", ...over });
const pii = "患者氏名を保存";
const fields = ["observed_at", "dp_number", "site_id", "device_id", "reporter_role", "error_code", "symptom_text"];
for (const f of fields) {
  const r = await post("/cases", mk({ [f]: pii }));
  check(`G-05 ${f} に個人情報 -> 保存されない`, r.status === 403 || r.status === 422);
}
const extra = await post("/cases", mk({ note_extra: pii }));
check("G-05 未知の追加フィールドの個人情報も拒否", extra.status === 403);
const secret = await post("/cases", mk({ symptom_text: "token=" + "x".repeat(24) }));
check("G-05 機密情報（token=...）は保存前に拒否", secret.status === 403);
const hugeExtra = await post("/cases", mk({ pad: "a".repeat(30000) }));
check("G-05 過大な追加フィールドは拒否（fail-closed）", hugeExtra.status === 403);
check("G-05 拒否したケースは 1 件も保存されていない", (await cases()).length === before);

// ---- 形式検証
for (const [name, over] of [
  ["role 不正値", { reporter_role: "admin" }],
  ["site_id に空白・日本語", { site_id: "施設 1" }],
  ["observed_at 不正", { observed_at: "昨日の夜" }],
  ["error_code に自由記述", { error_code: "E210 患者名あり" }],
]) check(`形式検証 422: ${name}`, (await post("/cases", mk(over))).status === 422);

// ---- 無害な入力は許可される（過剰拒否の確認）
const benign = [
  "Readyにならない", "E210が表示される", "操作パネルのReadyランプが点灯しない", "エラー履歴をエクスポートしたい",
  "電源ランプは点灯している", "ドア表示が開のまま", "インターロックの状態を確認して", "リモートサポートの手順を教えて",
  "高圧ケーブルの外観に異常はない", "E440 Communication Timeout が出る", "再現条件を教えてください",
];
for (const text of benign) {
  const r = await ev({ text, role: "junior_fse" });
  check(`無害を許可: ${text}`, r.status === 200 && r.json.ok === true, `got ${r.status} ${r.json.safety?.rule_id}`);
}
const okCase = await post("/cases", mk({ error_code: "E210", observed_at: "2026-11-02T12:30:00+09:00", device_id: "HVN-DEV-XR-001" }));
check("無害なケース登録は 201", okCase.status === 201, `got ${okCase.status} ${JSON.stringify(okCase.json.errors)}`);

if (failed > 0) {
  console.error(`\nRESULT: FAIL (${failed} 件)`);
  process.exit(1);
}
console.log("\nRESULT: PASS");
