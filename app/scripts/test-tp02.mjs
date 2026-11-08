// TP-02 自動テスト: AC-02 / A-01〜A-03 + 自動確定なし・Human 明示選択・施設境界・不正入力
// 使い方: ESN_DATA_DIR=<一時ディレクトリ> npm run dev（別ターミナル）→ ESN_DATA_DIR=<同じ> npm run test:tp02
// 本番の runtime/data を汚さないため、ESN_DATA_DIR 必須。架空データのみ使用。
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

const call = async (p, body, raw) => {
  const res = await fetch(`${base}/api/v1${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};
const get = async (p) => {
  const res = await fetch(`${base}/api/v1${p}`);
  return { status: res.status, json: await res.json() };
};
const row = async (caseId) => {
  const all = JSON.parse(await readFile(path.join(dataDir, "cases.json"), "utf8"));
  return all.find((c) => c.case_id === caseId);
};
const ids = (r) => (r.json.data?.candidates ?? []).map((c) => c.device_id).sort().join(",");

// 実行ごとに一意な DP（同じ ESN_DATA_DIR での再実行でも重複しない）
const run = String(Date.now() % 90 + 10);
const newCase = async (site = "HVN-SITE-001", n = 1) => {
  const r = await call("/cases", { dp_number: `DP-FIC-2026-0003-${run}-${n}`, site_id: site, symptom_text: "Readyにならない", reporter_role: "junior_fse" });
  return r.json.data.case_id;
};

// --- A-01 同一施設・同一型式2台（room 未指定）
const a = await newCase("HVN-SITE-001", 1);
const a01 = await call(`/cases/${a}/device-search`, { model: "HeliosXR-A1" });
check("A-01 200", a01.status === 200, `status=${a01.status}`);
check("A-01 候補は XR-001 と XR-002", ids(a01) === "HVN-DEV-XR-001,HVN-DEV-XR-002", ids(a01));
check("A-01 status=needs_human_selection・曖昧フラグ", a01.json.data.status === "needs_human_selection" && a01.json.data.ambiguous === true);
check("A-01 各候補に根拠（reasons）", a01.json.data.candidates.every((c) => c.reasons.length >= 2 && c.reasons.some((x) => x.includes("HeliosXR-A1"))));
let saved = await row(a);
check("A-01 自動確定しない（device_id=null, confirmed でない）", saved.device_id === null && saved.device_confirmation_status === "needs_human_selection");
check("A-01 他施設の XR-003 は候補に出ない", !ids(a01).includes("XR-003"));

// --- A-02 シリアル末尾のみ（複数ヒット）
const b = await newCase("HVN-SITE-001", 2);
const a02 = await call(`/cases/${b}/device-search`, { serial_fragment: "100" });
check("A-02 複数候補（XR-001, XR-002）", ids(a02) === "HVN-DEV-XR-001,HVN-DEV-XR-002", ids(a02));
check("A-02 識別根拠にシリアル部分一致", a02.json.data.candidates.every((c) => c.reasons.some((x) => x.startsWith("シリアル部分一致"))));
check("A-02 Human 選択待ち", a02.json.data.status === "needs_human_selection" && (await row(b)).device_id === null);

// --- A-03 部屋名「撮影室」曖昧（自由記述）
const c = await newCase("HVN-SITE-001", 3);
const a03 = await call(`/cases/${c}/device-search`, { free_text: "撮影室のXR" });
check("A-03 曖昧フラグと候補（室1/室2）", a03.json.data.ambiguous === true && ids(a03) === "HVN-DEV-XR-001,HVN-DEV-XR-002", ids(a03));
check("A-03 推測で確定しない", (await row(c)).device_confirmation_status === "needs_human_selection" && (await row(c)).device_id === null);
check("A-03 透視室の RF は候補に出ない", !ids(a03).includes("RF"));

// --- 1件でも自動確定しない
const d = await newCase("HVN-SITE-001", 4);
const one = await call(`/cases/${d}/device-search`, { serial_fragment: "10045" });
check("単一候補でも needs_human_selection（自動 confirmed なし）", ids(one) === "HVN-DEV-XR-002" && one.json.data.status === "needs_human_selection" && (await row(d)).device_id === null);

// --- 0件・未解釈の語
const zero = await call(`/cases/${d}/device-search`, { serial_fragment: "99999" });
check("該当なし -> 候補0・unconfirmed", zero.status === 200 && zero.json.data.candidates.length === 0 && zero.json.data.status === "unconfirmed");
const unk = await call(`/cases/${d}/device-search`, { free_text: "地下のMR" });
check("未解釈の語は条件にせず返す（推測で絞らない）", unk.json.data.unmatched_terms.length === 2 && unk.json.data.candidates.length === 0);

// --- Human 明示選択による確定
const notCand = await call(`/cases/${a}/device-confirm`, { device_id: "HVN-DEV-XR-003", human_selected: true, confirmed_by_role: "junior_fse" });
check("候補外（他施設）の装置は確定できない -> 409", notCand.status === 409 && notCand.json.errors.includes("device_not_in_candidates"));
const noFlag = await call(`/cases/${a}/device-confirm`, { device_id: "HVN-DEV-XR-001", confirmed_by_role: "junior_fse" });
check("human_selected なし -> 422", noFlag.status === 422 && noFlag.json.errors.includes("missing:human_selected"));
const falseFlag = await call(`/cases/${a}/device-confirm`, { device_id: "HVN-DEV-XR-001", human_selected: "true", confirmed_by_role: "junior_fse" });
check("human_selected が true 以外 -> 422", falseFlag.status === 422 && falseFlag.json.errors.includes("invalid:human_selected"));
check("拒否された確定は保存されない", (await row(a)).device_id === null);

const ok = await call(`/cases/${a}/device-confirm`, { device_id: "HVN-DEV-XR-002", human_selected: true, confirmed_by_role: "junior_fse" });
check("候補からの明示選択 -> 200 confirmed", ok.status === 200 && ok.json.data.device_confirmation_status === "confirmed" && ok.json.data.device_id === "HVN-DEV-XR-002");
saved = await row(a);
check("確定イベントを記録（source=client_asserted_human_selection・verified=false, role, 時刻）", saved.device_confirmation?.source === "client_asserted_human_selection" && saved.device_confirmation?.verified === false && saved.device_confirmation.confirmed_by_role === "junior_fse" && !!saved.device_confirmation.confirmed_at);
const again = await call(`/cases/${a}/device-confirm`, { device_id: "HVN-DEV-XR-001", human_selected: true, confirmed_by_role: "junior_fse" });
check("確定済みの上書き -> 409", again.status === 409 && (await row(a)).device_id === "HVN-DEV-XR-002");
const after = await call(`/cases/${a}/device-search`, { model: "HeliosXR-A1" });
check("確定後の再検索で確定が外れない", after.json.data.status === "confirmed" && (await row(a)).device_confirmation_status === "confirmed");
const g = await get(`/cases/${a}`);
check("GET /cases/:id に確定結果が残る", g.json.data.device_id === "HVN-DEV-XR-002");

// 未検索のケースは確定できない
const e = await newCase("HVN-SITE-002", 5);
const blind = await call(`/cases/${e}/device-confirm`, { device_id: "HVN-DEV-XR-003", human_selected: true, confirmed_by_role: "junior_fse" });
check("未検索で確定 -> 409（候補なし）", blind.status === 409 && (await row(e)).device_id === null);
const site2 = await call(`/cases/${e}/device-search`, { modality: "XR" });
check("施設2では XR-003 のみ", ids(site2) === "HVN-DEV-XR-003");

// --- 不正入力
check("条件なし -> 422", (await call(`/cases/${a}/device-search`, {})).status === 422);
check("不正JSON -> 400", (await call(`/cases/${a}/device-search`, null, "{bad")).status === 400);
check("設置年が文字列 -> 422", (await call(`/cases/${a}/device-search`, { install_year: "2019" })).status === 422);
check("存在しない case -> 404", (await call(`/cases/CASE-none/device-search`, { model: "x" })).status === 404);
check("存在しない case の確定 -> 404", (await call(`/cases/CASE-none/device-confirm`, { device_id: "x", human_selected: true, confirmed_by_role: "junior_fse" })).status === 404);

console.log(failed === 0 ? "ALL PASS" : `FAILED: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
