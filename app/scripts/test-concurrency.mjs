// TP-04 R5 並行処理の試験（Builder の自己テスト。Independent Guardian の監査ではない）。H3 Draft 第 8 章 CC-1 から CC-5。
// 単一プロセスの next start / next dev が対象。CC-6（複数プロセス）は未検証（NOT_TESTED）で、本スクリプトでは試験しない。
// 使い方: ESN_DATA_DIR=<新規の一時ディレクトリ> でサーバーを起動 → ESN_DATA_DIR=<同じ> npm run test:concurrency
// 架空データのみ。外部 API・実データは使わない。
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
const post = async (p, body) => {
  const res = await fetch(`${base}/api/v1${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const run = String(Date.now() % 90 + 10);
let seq = 0;
const dp = (series) => `DP-FIC-2026-${series}-${run}-${++seq % 100}`;
const mk = (series, over = {}) => ({ dp_number: dp(series), site_id: "HVN-SITE-001", symptom_text: "Readyにならない", reporter_role: "junior_fse", ...over });
const KEYS = ["case_id", "dp_number", "site_id", "reporter_role", "device_id", "device_confirmation_status", "device_candidates", "device_confirmation", "symptom_text", "error_code", "observed_at", "confirmed_facts", "hypotheses", "missing_info", "status", "claude_session_state", "created_at", "updated_at"].sort().join(",");
const rows = async () => JSON.parse(await readFile(path.join(dataDir, "cases.json"), "utf8"));
const wellFormed = (all) => Array.isArray(all) && all.every((c) => Object.keys(c).sort().join(",") === KEYS);
const mkCase = async (series) => (await post("/cases", mk(series))).json.case_id;

// CC-1: 異なる dp_number の POST /cases を並行して送る。別ケースへの device-search を混在させる（ルートをまたぐ直列化の確認）
const other = await mkCase("0041");
const N1 = 12;
const mixed = await Promise.all([
  ...Array.from({ length: N1 }, () => post("/cases", mk("0042"))),
  ...Array.from({ length: 6 }, () => post(`/cases/${other}/device-search`, { model: "HeliosXR-A1" })),
]);
const created = mixed.slice(0, N1);
check("CC-1 並行 POST /cases は全件 201・stored", created.every((r) => r.status === 201 && r.json.store_state === "stored"), JSON.stringify(created.map((r) => r.status)));
check("CC-1 並行 device-search は全件 200", mixed.slice(N1).every((r) => r.status === 200));
let all = await rows();
const ids = new Set(created.map((r) => r.json.case_id));
check("CC-1 保存された全件が cases.json に存在（取りこぼしなし）", [...ids].every((id) => all.some((c) => c.case_id === id)) && ids.size === N1);
check("CC-1 cases.json は壊れていない（キー集合が全件で正しい）", wellFormed(all));
check("CC-1 混在した device-search の結果（候補）が失われていない", all.find((c) => c.case_id === other)?.device_candidates.length > 0);

// CC-2: 同一ケースへの device-search を並行して送る
const c2 = await mkCase("0043");
const r2 = await Promise.all(Array.from({ length: 10 }, () => post(`/cases/${c2}/device-search`, { model: "HeliosXR-A1" })));
all = await rows();
const rec2 = all.find((c) => c.case_id === c2);
check("CC-2 全件 200", r2.every((r) => r.status === 200), JSON.stringify(r2.map((r) => r.status)));
check("CC-2 最終状態は妥当（候補あり・未確定でない確定記録なし）", wellFormed(all) && rec2.device_candidates.length === 2 && rec2.device_confirmation === null && rec2.device_confirmation_status !== "confirmed");

// CC-3: 同一ケースで device-search と device-confirm を並行して送る
const c3 = await mkCase("0044");
await post(`/cases/${c3}/device-search`, { model: "HeliosXR-A1" });
const r3 = await Promise.all([
  ...Array.from({ length: 5 }, () => post(`/cases/${c3}/device-search`, { model: "HeliosXR-A1" })),
  post(`/cases/${c3}/device-confirm`, { device_id: "HVN-DEV-XR-001", confirmed_by_role: "junior_fse", human_selected: true }),
  ...Array.from({ length: 5 }, () => post(`/cases/${c3}/device-search`, { model: "HeliosXR-A1" })),
]);
all = await rows();
const rec3 = all.find((c) => c.case_id === c3);
const confirms3 = r3.filter((r) => r.json.data?.device_confirmation_status === "confirmed" && r.json.store_state === "stored" && r.json.data?.device_confirmation);
check("CC-3 全件が 200（device-search は確定済みでも 200）", r3.every((r) => r.status === 200), JSON.stringify(r3.map((r) => r.status)));
check("CC-3 確定は高々 1 回で、最終状態は confirmed のまま確定記録が保たれる", confirms3.length === 1 && rec3.device_confirmation_status === "confirmed" && rec3.device_id === "HVN-DEV-XR-001" && rec3.device_confirmation?.verified === false);
check("CC-3 確定後の device-search は保存しない（not_stored）か、確定前に保存した（stored）", r3.filter((r) => r.json.data?.candidates).every((r) => ["stored", "not_stored"].includes(r.json.store_state)));

// CC-4: 同一ケースへの device-confirm を並行して送る（同一装置 / 別々の候補）
const c4 = await mkCase("0045");
await post(`/cases/${c4}/device-search`, { model: "HeliosXR-A1" });
const r4 = await Promise.all([1, 2, 3].map(() => post(`/cases/${c4}/device-confirm`, { device_id: "HVN-DEV-XR-001", confirmed_by_role: "junior_fse", human_selected: true })));
check("CC-4 同一装置の並行確定: 200 が 1 件、残りは 409（already_confirmed）", r4.filter((r) => r.status === 200).length === 1 && r4.filter((r) => r.status === 409).length === 2, JSON.stringify(r4.map((r) => r.status)));
const c4b = await mkCase("0046");
await post(`/cases/${c4b}/device-search`, { model: "HeliosXR-A1" });
const r4b = await Promise.all([post(`/cases/${c4b}/device-confirm`, { device_id: "HVN-DEV-XR-001", confirmed_by_role: "junior_fse", human_selected: true }), post(`/cases/${c4b}/device-confirm`, { device_id: "HVN-DEV-XR-002", confirmed_by_role: "junior_fse", human_selected: true })]);
all = await rows();
const rec4b = all.find((c) => c.case_id === c4b);
const winner = r4b.find((r) => r.status === 200);
check("CC-4 別々の候補の並行確定: 200 が 1 件で、最終の device_id は勝った側と一致", r4b.filter((r) => r.status === 200).length === 1 && r4b.filter((r) => r.status === 409).length === 1 && rec4b.device_id === winner?.json.data?.device_id, JSON.stringify(r4b.map((r) => r.status)));

// CC-5: 同じ dp_number の POST /cases を並行して送る
const same = mk("0047");
const r5 = await Promise.all(Array.from({ length: 6 }, () => post("/cases", same)));
all = await rows();
check("CC-5 同一 dp_number の並行登録: 201 が 1 件、残りは 409・not_stored", r5.filter((r) => r.status === 201).length === 1 && r5.filter((r) => r.status === 409 && r.json.store_state === "not_stored").length === 5, JSON.stringify(r5.map((r) => r.status)));
check("CC-5 cases.json に当該 dp_number は 1 件のみ", all.filter((c) => c.dp_number === same.dp_number).length === 1);

// D1-3: 過負荷（待機列 64 超）。R4 の Guardian 再現と同規模（履歴 10 件 × 1000 文の evaluate を 305 件同時）。拒否は cause=overload・再送可の文面で、枠は漏れない。
{
  // 負荷用の入力: 同一の長い塊の履歴 10 件（重複を除けば切捨てにならない）。text に別の長い塊を置くと γ 案で判定不能になるため、短い文にする
  const heavy = { text: "ok", history: Array.from({ length: 10 }, () => "y".repeat(1000)), role: "junior_fse" };
  const rs = await Promise.all(Array.from({ length: 305 }, () => post("/actions/evaluate", heavy)));
  const ok = rs.filter((r) => r.status === 200).length;
  const rej = rs.filter((r) => r.status === 403);
  check("D1-3 過負荷の試験: 応答は 200 か 403 のみ", rs.every((r) => r.status === 200 || r.status === 403), JSON.stringify([...new Set(rs.map((r) => r.status))]));
  check("D1-3 403 はすべて cause=overload（無害な入力を「危険」と誤認させない）", rej.every((r) => r.json.data?.cause === "overload" && r.json.safety?.rule_id === "SG-INPUT-01"), JSON.stringify(rej[0]?.json));
  check("D1-3 overload のメッセージは時間をおいた再試行を案内し、上限値を出さない", rej.every((r) => String(r.json.data?.user_message).includes("しばらく時間をおいて") && !/\d{2,}/.test(String(r.json.data?.user_message) + String(r.json.data?.reason))));
  console.log(`INFO D1-3: 200=${ok} 403(overload)=${rej.length}${rej.length === 0 ? "（このマシンでは待機列が上限に達しなかった。overload の再現は未達）" : ""}`);
  const after = await post("/actions/evaluate", { text: "インターロックとは何ですか", role: "junior_fse" });
  check("D1-3 過負荷の直後の通常文は 200（枠のリークなし）", after.status === 200);
}

console.log("\nCC-6 複数プロセスでの更新: 未検証（NOT_TESTED）。単一プロセスで PASS しても、複数プロセスの安全性は保証されない。");
if (failed > 0) {
  console.error(`\nRESULT: FAIL (${failed} 件)`);
  process.exit(1);
}
console.log("\nRESULT: PASS");
