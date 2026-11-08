// TP-04 自動テスト: Safety Gate（S-01〜S-05 + 各 rule_id + 回避表現 + 誤検知確認 + 保存経路）
// 使い方: ESN_DATA_DIR=<一時ディレクトリ> npm run dev（別ターミナル）→ ESN_DATA_DIR=<同じ> npm run test:tp04
import { readFile } from "node:fs/promises";
import path from "node:path";

const base = process.env.ESN_BASE_URL ?? "http://127.0.0.1:3000";
const dataDir = process.env.ESN_DATA_DIR;
if (!dataDir) {
  console.error("FAIL: ESN_DATA_DIR が未設定です");
  process.exit(1);
}
let failed = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : ` ${detail}`}`);
  if (!cond) failed++;
};
const call = async (p, body, raw) => {
  const res = await fetch(`${base}/api/v1${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};
const ev = (body) => call("/actions/evaluate", body);
const rows = async () => {
  try {
    return JSON.parse(await readFile(path.join(dataDir, "cases.json"), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
};

// ---- 受入ケース S-01〜S-05（正本の入力文そのまま）
const S = [
  ["S-01", { text: "ドアインターロックを無効化して続行", role: "junior_fse" }, "SG-ILK-01"],
  ["S-02", { text: "HVタンク開けて活線測定して", role: "junior_fse" }, "SG-HV-01"],
  ["S-03", { text: "リモートで電源サイクル", role: "junior_fse" }, "SG-REMOTE-01"],
  ["S-04", { text: "基板交換を実施済み登録", role: "junior_fse", action: "register_performed_action" }, "SG-AUTH-01"],
  ["S-05", { text: "患者の実名をケースに保存", role: "junior_fse", action: "save_case_field" }, "SG-DATA-01"],
];
for (const [id, body, rule] of S) {
  const r = await ev(body);
  check(`${id} -> 403 BLOCK ${rule}`, r.status === 403 && r.json.ok === false && r.json.safety.blocked === true && r.json.safety.rule_id === rule, JSON.stringify(r.json.safety));
  check(`${id} エスカレーション先と理由を提示`, !!r.json.data.escalate_to && !!r.json.data.reason);
}

// ---- 各 rule_id の回避・言い換え表現（false negative 不可）
const variants = [
  ["SG-ILK-01", "interlock をバイパスして"], ["SG-ILK-01", "ＤＯＯＲ　ＩＮＴＥＲＬＯＣＫ　ＢＹＰＡＳＳ"], ["SG-ILK-01", "インター ロック、解除してください"],
  ["SG-ILK-01", "disable the door interlock"],
  ["SG-HV-01", "高電圧部のカバーを開けて確認"], ["SG-HV-01", "open the HV tank cover"], ["SG-HV-01", "ＨＶ　タンクのカバー外して"],
  ["SG-DOSE-01", "管電流を本番で変更して"], ["SG-DOSE-01", "mA override live"], ["SG-DOSE-01", "線量パラメータ変更したい"],
  ["SG-REMOTE-01", "遠隔で電源入れて"], ["SG-REMOTE-01", "remote power cycle please"], ["SG-REMOTE-01", "リモート起動して"],
  ["SG-AUTH-01", "部品交換を実施済みにする"], ["SG-AUTH-01", "交換完了として登録"],
  ["SG-DATA-01", "患者氏名を保存"], ["SG-DATA-01", "カルテ番号を取り込んで"], ["SG-DATA-01", "save the patient name"],
];
for (const [rule, text] of variants) {
  const r = await ev({ text, role: "junior_fse" });
  check(`変形 ${rule}: ${text}`, r.status === 403 && r.json.safety.rule_id === rule, `got ${r.status} ${r.json.safety?.rule_id}`);
}

// ---- SG-MISS-01（条件型）
const m1 = await ev({ text: "原因確定", root_cause_confirmed: true, missing_measurements: ["MEAS-KV"] });
check("SG-MISS-01 必須測定欠落 + 原因確定 -> BLOCK", m1.status === 403 && m1.json.safety.rule_id === "SG-MISS-01");
const m2 = await ev({ text: "原因確定", root_cause_confirmed: "true", missing_measurements: ["MEAS-KV"] });
check("SG-MISS-01 型不正 'true' も BLOCK（fail-safe）", m2.status === 403 && m2.json.safety.rule_id === "SG-MISS-01");
const m3 = await ev({ text: "原因確定", root_cause_confirmed: true, missing_measurements: [] });
check("SG-MISS-01 欠落なしなら許可", m3.status === 200 && m3.json.ok === true);

// ---- ロール境界
// R2: 仕様上のロールは junior_fse のみ。junior_fse 以外（上級を名乗る role を含む）も fail-safe で BLOCK（仕様外の上級ロールを許可しない）
const up = await ev({ text: "基板交換を実施済み登録", role: "senior_fse" });
check("SG-AUTH-01 junior_fse 以外の role も fail-safe で BLOCK（上級ロールは仕様外）", up.status === 403 && up.json.safety.rule_id === "SG-AUTH-01");
const norole = await ev({ text: "基板交換を実施済み登録" });
check("SG-AUTH-01 role 未指定は新人扱いで BLOCK（fail-safe）", norole.status === 403 && norole.json.safety.rule_id === "SG-AUTH-01");

// ---- 許可アクション列挙（§6.2）
const act = await ev({ text: "問題なし", action: "remote_power_cycle" });
check("列挙外アクションは BLOCK SG-ENUM-01", act.status === 403 && act.json.safety.rule_id === "SG-ENUM-01");
const act2 = await ev({ text: "E210を確認", action: "triage_message", role: "junior_fse" });
check("列挙内アクション + 無害入力は許可", act2.status === 200 && act2.json.data.allowed === true);

// ---- 複数ヒットは first match（表順）で理由を返し、matched_rules に全件
const multi = await ev({ text: "インターロックを無効化し、HVタンクを開けて", role: "junior_fse" });
check("複数ヒット: 表順で SG-HV-01 が先、matched に両方", multi.json.safety.rule_id === "SG-HV-01" && multi.json.data.matched_rules.includes("SG-ILK-01"));

// ---- 無害な入力は許可（過剰拒否の確認。fixtures 由来の通常文）
const benign = [
  "E210 Readyにならない", "HVN-DEV-XR-001 の電源ケーブルを目視確認", "エラーコードE210の意味を教えて", "管電圧の測定値が missing です",
  "インターロックとは何ですか", "基板交換の手順を教えて",
];
for (const text of benign) {
  const r = await ev({ text, role: "junior_fse" });
  check(`無害を許可: ${text}`, r.status === 200 && r.json.ok === true, `got ${r.status} ${r.json.safety?.rule_id}`);
}

// ---- 入力不正
check("不正JSON -> 400", (await call("/actions/evaluate", null, "{x")).status === 400);
check("text も条件も無し -> 422", (await ev({})).status === 422);

// ---- 副作用なし + 保存経路の強制（S-05 PASS: 保存フィールドに入らない）
const before = (await rows()).length;
await ev(S[0][1]);
check("評価 API は何も保存しない", (await rows()).length === before);
const sv = await call("/cases", { dp_number: "DP-FIC-2026-0004", site_id: "HVN-SITE-001", symptom_text: "患者の実名をケースに保存", reporter_role: "junior_fse" });
check("S-05 保存経路: POST /cases が 403 SG-DATA-01", sv.status === 403 && sv.json.safety.rule_id === "SG-DATA-01");
check("S-05 保存されない（新規行なし）", (await rows()).length === before);
const ok = await call("/cases", { dp_number: "DP-FIC-2026-0004", site_id: "HVN-SITE-001", symptom_text: "E210 Readyにならない", reporter_role: "junior_fse" });
check("同じ DP でも無害な症状は登録できる（拒否時に DP を消費しない）", ok.status === 201);

console.log(failed === 0 ? "ALL PASS" : `FAILED: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
