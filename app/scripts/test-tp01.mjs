// TP-01 自動テスト: AC-01 / N-01 / N-02 + 重複DP・不正入力
// 使い方: ESN_DATA_DIR=<一時ディレクトリ> npm run dev（別ターミナル）→ ESN_DATA_DIR=<同じ> npm run test:tp01
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

const post = async (body, raw) => {
  const res = await fetch(`${base}/api/v1/cases`, {
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
const rows = async () => {
  try {
    return JSON.parse(await readFile(path.join(dataDir, "cases.json"), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
};

const N01 = { dp_number: "DP-FIC-2026-0001", site_id: "HVN-SITE-001", symptom_text: "E210 Readyにならない", reporter_role: "junior_fse" };

// --- N-01 必須項目つき新規登録
const before = (await rows()).length;
const c1 = await post(N01);
check("N-01 POST /cases -> 201", c1.status === 201, `status=${c1.status}`);
const rec = c1.json.data;
check("N-01 一意 case_id が採番される", typeof rec?.case_id === "string" && rec.case_id.startsWith("CASE-"));
check("N-01 envelope: ok=true, errors=[], case_id 一致", c1.json.ok === true && c1.json.errors.length === 0 && c1.json.case_id === rec.case_id);
check("N-01 装置は自動確定されない", rec.device_confirmation_status === "unconfirmed" && rec.device_id === null);
const g1 = await get(`/cases/${rec.case_id}`);
check("N-01 再GETで同一内容", g1.status === 200 && JSON.stringify(g1.json.data) === JSON.stringify(rec));
check("N-01 保存行が1件増える", (await rows()).length === before + 1);

// --- N-02 必須欠落の拒否（dp 欠落）
const beforeN02 = (await rows()).length;
const noDp = { ...N01 };
delete noDp.dp_number;
const c2 = await post(noDp);
check("N-02 dp 欠落 -> 422", c2.status === 422, `status=${c2.status}`);
check("N-02 欠落フィールド一覧に dp_number", c2.json.ok === false && c2.json.data?.missing_fields?.includes("dp_number") && c2.json.errors.includes("missing:dp_number"));
check("N-02 保存されない（新規行なし）", (await rows()).length === beforeN02);

// 各必須項目の欠落・空白のみも拒否
for (const f of ["site_id", "symptom_text", "reporter_role"]) {
  const r = await post({ ...N01, dp_number: "DP-FIC-2026-0099", [f]: "   " });
  check(`必須 ${f} が空白のみ -> 422 + 保存なし`, r.status === 422 && r.json.data.missing_fields.includes(f) && (await rows()).length === beforeN02);
}
const multi = await post({});
check("全欠落 -> 4項目すべて列挙", multi.status === 422 && multi.json.data.missing_fields.length === 4);

// --- 重複DP拒否（FR-P0-01）
const dup = await post({ ...N01, symptom_text: "別内容" });
check("重複 dp_number -> 409 + 既存 case_id", dup.status === 409 && dup.json.data.existing_case_id === rec.case_id && dup.json.errors.includes("duplicate_dp_number"));
check("重複は保存されない", (await rows()).length === beforeN02);

// 並行登録: 同一DPを同時に投げても1件のみ
const racers = await Promise.all(Array.from({ length: 5 }, () => post({ ...N01, dp_number: "DP-FIC-2026-0002" })));
check("同一DP同時5件 -> 201 は1件のみ", racers.filter((r) => r.status === 201).length === 1 && racers.filter((r) => r.status === 409).length === 4);

// --- 不正入力
const bad = await post(null, "{not json");
check("不正JSON -> 400", bad.status === 400 && bad.json.errors.includes("invalid_json"));
const arr = await post([1, 2]);
check("配列ボディ -> 422", arr.status === 422);
const num = await post({ ...N01, dp_number: 12345 });
check("型不正（dp_number が数値）-> 422", num.status === 422 && num.json.data.missing_fields.includes("dp_number"));
const long = await post({ ...N01, dp_number: "DP-FIC-2026-0098", symptom_text: "x".repeat(2001) });
check("長さ超過 -> 422 invalid", long.status === 422 && long.json.data.invalid_fields.includes("symptom_text"));
const nf = await get("/cases/CASE-does-not-exist");
check("存在しない case_id -> 404", nf.status === 404 && nf.json.errors.includes("case_not_found"));

// --- 一覧
const list = await get("/cases");
const n = (await rows()).length;
check("GET /cases 一覧が保存件数と一致", list.status === 200 && list.json.data.cases.length === n);

console.log(failed === 0 ? "ALL PASS" : `FAILED: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
