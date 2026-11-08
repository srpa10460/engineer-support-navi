// TP-03 自動テスト: AC-03 / N-03 + E-01〜E-03 + 索引外を返さない・機種詐称不可・未確定ケース拒否
// 使い方: ESN_DATA_DIR=<一時ディレクトリ> npm run dev（別ターミナル）→ ESN_DATA_DIR=<同じ> npm run test:tp03
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

const post = async (p, body) => {
  const res = await fetch(`${base}/api/v1${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};
const get = async (p) => {
  const res = await fetch(`${base}/api/v1${p}`);
  return { status: res.status, json: await res.json() };
};

const run = String(Date.now() % 90 + 10);
let n = 0;
// 装置確定済みケースを作る（Human 明示選択イベントを経由。自動確定はしない）
const confirmedCase = async (model, deviceId, errorCode) => {
  const c = await post("/cases", {
    dp_number: `DP-FIC-2026-0013-${run}-${++n}`,
    site_id: "HVN-SITE-001",
    symptom_text: "Readyにならない",
    reporter_role: "junior_fse",
    error_code: errorCode,
  });
  const id = c.json.data.case_id;
  await post(`/cases/${id}/device-search`, { model });
  await post(`/cases/${id}/device-confirm`, { device_id: deviceId, human_selected: true, confirmed_by_role: "junior_fse" });
  return id;
};
const ref = (d, v, s) => encodeURIComponent(`${d}~${v}~${s}`);

// --- N-03 E210 文書ヒット（XR-001 確定済み）
const xr = await confirmedCase("HeliosXR-A1", "HVN-DEV-XR-001", "E210");
const s1 = await post(`/cases/${xr}/document-search`, {});
check("N-03 検索 200", s1.status === 200, `status=${s1.status}`);
const hits = s1.json.data?.hits ?? [];
const e210 = hits.find((h) => h.doc_id === "DOC-HVN-XR-A1-ERR" && h.section_id === "SEC-E210");
check("N-03 DOC-HVN-XR-A1-ERR v1.4 / SEC-E210 を返す", !!e210 && e210.version === "1.4", JSON.stringify(hits.map((h) => h.evidence_id)));
check("N-03 SEC-E210-CHK も返す", hits.some((h) => h.section_id === "SEC-E210-CHK"));
check("N-03 全ヒットが doc_id/version/section_id/excerpt を持つ", hits.length > 0 && hits.every((h) => h.doc_id && h.version && h.section_id && h.excerpt && h.excerpt_hash));
check("N-03 RF 文書を返さない（機種適合のみ）", hits.every((h) => !h.doc_id.includes("RF-B2")));
check("N-03 無関係な E440 節を返さない", !hits.some((h) => h.section_id === "SEC-E440"));
check("N-03 一致語の根拠（reasons）付き", hits.every((h) => h.reasons.length >= 2));

// Evidence 解決
const ok = await get(`/cases/${xr}/evidence/${ref("DOC-HVN-XR-A1-ERR", "1.4", "SEC-E210")}`);
check("N-03 Evidence 解決 200", ok.status === 200 && ok.json.ok === true, `status=${ok.status}`);
check("N-03 excerpt は文書ファイル由来（E210 の見出し本文を含む）", ok.json.data?.excerpt?.includes("Generator Not Ready"));
const src = await readFile(path.join(process.cwd(), "src", "data", "documents", "DOC-HVN-XR-A1-ERR_v1.4.md"), "utf8");
check("N-03 excerpt が文書原文に実在", src.includes(ok.json.data.excerpt));

// --- E-01 存在しない doc_id
const e01 = await get(`/cases/${xr}/evidence/${ref("DOC-DOES-NOT-EXIST", "1.0", "SEC-E210")}`);
check("E-01 索引外 doc_id は 422 REJECT", e01.status === 422 && e01.json.data?.reject_code === "DOC_NOT_IN_INDEX", JSON.stringify(e01.json));
check("E-01 文書内容を返さない", e01.json.data?.excerpt === undefined);

// --- E-02 版不一致
const e02 = await get(`/cases/${xr}/evidence/${ref("DOC-HVN-XR-A1-ERR", "9.9", "SEC-E210")}`);
check("E-02 版不一致は 422 REJECT", e02.status === 422 && e02.json.data?.reject_code === "VERSION_MISMATCH", JSON.stringify(e02.json));
check("E-02 誤版の内容を返さない", e02.json.data?.excerpt === undefined);

// --- 節が索引にない
const e04 = await get(`/cases/${xr}/evidence/${ref("DOC-HVN-XR-A1-ERR", "1.4", "SEC-E999")}`);
check("索引外 section_id は 422 REJECT", e04.status === 422 && e04.json.data?.reject_code === "SECTION_NOT_IN_INDEX");

// --- E-03 他機種マニュアル流用（XR ケースに RF 文書）
const e03 = await get(`/cases/${xr}/evidence/${ref("DOC-HVN-RF-B2-SM", "2.0", "SEC-RF-BOOT")}`);
check("E-03 RF 文書は XR ケースで 422 REJECT（MODEL_MISMATCH）", e03.status === 422 && e03.json.data?.reject_code === "MODEL_MISMATCH", JSON.stringify(e03.json));
check("E-03 RF 文書の内容を返さない", e03.json.data?.excerpt === undefined);
// 逆方向: RF ケースに XR 文書
const rf = await confirmedCase("HeliosRF-B2", "HVN-DEV-RF-001", null);
const e03b = await get(`/cases/${rf}/evidence/${ref("DOC-HVN-XR-A1-ERR", "1.4", "SEC-E210")}`);
check("E-03 逆方向（RF ケースに XR 文書）も REJECT", e03b.status === 422 && e03b.json.data?.reject_code === "MODEL_MISMATCH");
const rfOk = await get(`/cases/${rf}/evidence/${ref("DOC-HVN-RF-B2-SM", "2.0", "SEC-RF-BOOT")}`);
check("RF ケースでは RF 文書を解決できる", rfOk.status === 200);
// 共通安全文書は両機種で解決できる
const safe = await get(`/cases/${xr}/evidence/${ref("DOC-HVN-SAFETY", "1.0", "SEC-SG-HV")}`);
check("共通安全文書（SAFETY）は XR で解決できる", safe.status === 200);

// --- 機種詐称不可: body の model は無視される
const spoof = await post(`/cases/${xr}/document-search`, { model: "HeliosRF-B2", error_code: "E210", query: "起動シーケンス" });
check("body の model は無視（RF 文書が出ない）", spoof.status === 200 && spoof.json.data.model === "HeliosXR-A1" && spoof.json.data.hits.every((h) => !h.doc_id.includes("RF-B2")));

// --- 装置未確定ケースは検索・解決とも拒否
const un = await post("/cases", { dp_number: `DP-FIC-2026-0013-${run}-9`, site_id: "HVN-SITE-001", symptom_text: "x", reporter_role: "junior_fse", error_code: "E210" });
const uid = un.json.data.case_id;
const uns = await post(`/cases/${uid}/document-search`, {});
check("未確定ケースの検索は 409 device_not_confirmed", uns.status === 409 && uns.json.errors.includes("device_not_confirmed") && (uns.json.data.hits ?? []).length === 0);
const unr = await get(`/cases/${uid}/evidence/${ref("DOC-HVN-XR-A1-ERR", "1.4", "SEC-E210")}`);
check("未確定ケースの Evidence 解決は 409", unr.status === 409);

// --- 入力検証
const bad = await post(`/cases/${xr}/document-search`, { error_code: 123 });
check("不正な型は 422", bad.status === 422 && bad.json.data.invalid_fields.includes("error_code"));
const noRef = await get(`/cases/${xr}/evidence/not-a-ref`);
check("不正な refId は 422", noRef.status === 422);
const nf = await get(`/cases/CASE-NOPE/evidence/${ref("DOC-HVN-XR-A1-ERR", "1.4", "SEC-E210")}`);
check("存在しないケースは 404", nf.status === 404);
const noTerm = await post(`/cases/${rf}/document-search`, {});
check("語句なし（error_code 無し）は 0 件（全文書を返さない）", noTerm.status === 200 && noTerm.json.data.hits.length === 0);

if (failed > 0) {
  console.error(`\nRESULT: FAIL (${failed} 件)`);
  process.exit(1);
}
console.log("\nRESULT: PASS");
