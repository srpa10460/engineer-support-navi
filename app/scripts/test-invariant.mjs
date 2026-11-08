// R4: 機種確定の実行時不変条件（caseStore.assertInvariants）を、実コードをトランスパイルして直接検証する（サーバー不要）
// 使い方: npm run test:invariant
// 目的: AST 検査（静的・近似）に依存せず、updateCase 経由の確定・verified 昇格・確定の改変が実行時に拒否されることを確認する。
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

let failed = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : ` ${detail}`}`);
  if (!cond) failed++;
};

const root = process.cwd();
const tmp = await mkdtemp(path.join(os.tmpdir(), "esn-inv-"));
await mkdir(path.join(tmp, "lib"), { recursive: true });
const tr = async (src, dst, fix) => {
  let text = await readFile(path.join(root, "src", src), "utf8");
  text = fix ? fix(text) : text;
  const out = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  await writeFile(path.join(tmp, dst), out);
};
await tr("lib/roles.ts", "lib/roles.mjs");
await tr("lib/caseStore.ts", "lib/caseStore.mjs", (t) => t);
let store = await readFile(path.join(tmp, "lib/caseStore.mjs"), "utf8");
store = store.replace('from "@/lib/roles"', 'from "./roles.mjs"').replace(/import devicesFixture from "@\/data\/devices.json";?/, 'import devicesFixture from "./devices.json" with { type: "json" };');
await writeFile(path.join(tmp, "lib/caseStore.mjs"), store);
await copyFile(path.join(root, "src/data/devices.json"), path.join(tmp, "lib/devices.json"));

process.env.ESN_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), "esn-inv-data-"));
const m = await import(path.join(tmp, "lib/caseStore.mjs"));

const v = m.validateNewCase({ dp_number: "DP-FIC-2026-0001", site_id: "HVN-SITE-001", symptom_text: "Readyにならない", reporter_role: "junior_fse" });
check("検証付き作成の前提", v.ok === true);
const created = await m.createCase(v.value);
const id = created.record.case_id;
const throws = async (fn) => {
  try {
    await fn();
    return false;
  } catch (e) {
    return String(e.message).startsWith("CASE_INVARIANT_VIOLATION");
  }
};
const snapshot = async () => JSON.stringify(await m.getCase(id));

const s0 = await snapshot();
check("updateCase で confirmed へ遷移しようとすると拒否（確定記録なし）", await throws(() => m.updateCase(id, (c) => ({ record: { ...c, device_confirmation_status: "confirmed", device_id: "HVN-DEV-XR-001" }, result: 1 }))));
check("updateCase で confirmed + verified:true を渡すと拒否", await throws(() => m.updateCase(id, (c) => ({ record: { ...c, device_confirmation_status: "confirmed", device_id: "HVN-DEV-XR-001", device_confirmation: { device_id: "HVN-DEV-XR-001", confirmed_by_role: "junior_fse", source: "client_asserted_human_selection", verified: true, confirmed_at: "x" } }, result: 1 }))));
check("updateCase で confirmed + 正しい形式でも（confirmDevice 以外は）拒否", await throws(() => m.updateCase(id, (c) => ({ record: { ...c, device_confirmation_status: "confirmed", device_id: "HVN-DEV-XR-001", device_confirmation: { device_id: "HVN-DEV-XR-001", confirmed_by_role: "junior_fse", source: "client_asserted_human_selection", verified: false, confirmed_at: "x" } }, result: 1 }))));
check("拒否後も永続状態は不変", (await snapshot()) === s0);

// 候補を設定（updateCase で許可された変更）→ 候補外は confirmDevice でも確定しない
await m.updateCase(id, (c) => ({ record: { ...c, device_candidates: [{ device_id: "HVN-DEV-XR-001", model: "m", serial: "s", room: "r", install_year: 2020, modality: "XR", score: 1, reasons: [] }], device_confirmation_status: "needs_human_selection" }, result: 1 }));
const notCand = await m.confirmDevice(id, "HVN-DEV-XR-002", "junior_fse");
check("候補外は確定しない", notCand.found && notCand.result.kind === "not_a_candidate");
const ok = await m.confirmDevice(id, "HVN-DEV-XR-001", "junior_fse");
const rec = await m.getCase(id);
check("confirmDevice は verified=false・source 固定で確定", ok.result.kind === "confirmed" && rec.device_confirmation.verified === false && rec.device_confirmation.source === "client_asserted_human_selection");
const s1 = await snapshot();
check("確定済みの verified を true に変更しようとすると拒否", await throws(() => m.updateCase(id, (c) => ({ record: { ...c, device_confirmation: { ...c.device_confirmation, verified: true } }, result: 1 }))));
check("確定済みの device_id を変更しようとすると拒否", await throws(() => m.updateCase(id, (c) => ({ record: { ...c, device_id: "HVN-DEV-XR-002" }, result: 1 }))));
check("確定済みから unconfirmed へ戻そうとすると拒否", await throws(() => m.updateCase(id, (c) => ({ record: { ...c, device_confirmation_status: "unconfirmed", device_confirmation: null }, result: 1 }))));
check("source を書き換えようとすると拒否", await throws(() => m.updateCase(id, (c) => ({ record: { ...c, device_confirmation: { ...c.device_confirmation, source: "human_verified" } }, result: 1 }))));
check("拒否後も確定記録は不変", (await snapshot()) === s1);
const again = await m.confirmDevice(id, "HVN-DEV-XR-001", "junior_fse");
check("再確定は already_confirmed", again.result.kind === "already_confirmed");
const senior = await (async () => {
  const v2 = m.validateNewCase({ dp_number: "DP-FIC-2026-0002", site_id: "HVN-SITE-001", symptom_text: "x", reporter_role: "junior_fse" });
  const c2 = await m.createCase(v2.value);
  await m.updateCase(c2.record.case_id, (c) => ({ record: { ...c, device_candidates: [{ device_id: "HVN-DEV-XR-001", model: "m", serial: "s", room: "r", install_year: 2020, modality: "XR", score: 1, reasons: [] }] }, result: 1 }));
  return throws(() => m.confirmDevice(c2.record.case_id, "HVN-DEV-XR-001", "senior_se"));
})();
check("許可外ロールでの confirmDevice は保存前に拒否", await senior);

// 台帳照合・dp_number 形式
const fmt = (over) => m.validateNewCase({ dp_number: "DP-FIC-2026-0001", site_id: "HVN-SITE-001", symptom_text: "x", reporter_role: "junior_fse", ...over });
check("未知の site_id は invalid", fmt({ site_id: "ZZZ-SITE-999" }).ok === false);
check("別施設の device_id は invalid", fmt({ device_id: "HVN-DEV-XR-001", site_id: "HVN-SITE-002" }).ok === false || fmt({ device_id: "HVN-DEV-XR-001", site_id: "HVN-SITE-002" }).invalid?.includes("device_id"));
check("台帳にある device_id は有効", fmt({ device_id: "HVN-DEV-XR-001" }).ok === true);
for (const dp of ["DP-AB-4111-1111-1111-1111", "DP-AB-0901-2345-6789", "DP-YAMADA-2026-0003", "DP-FIC-2026-0901-2345-678", "DP-FIC-1999-0001", "DP-FIC-2026-0001-1-2-3"]) {
  check(`不正な dp_number は invalid: ${dp}`, fmt({ dp_number: dp }).ok === false);
}
for (const dp of ["DP-FIC-2026-0001", "DP-FIC-2026-0006", "DP-FIC-2026-0001-12-34", "DP-FIC-2026-0003-7"]) {
  check(`既存の正常な dp_number は有効: ${dp}`, fmt({ dp_number: dp }).ok === true);
}

// ---- R5 H-3: 状態隔離・不変条件・台帳照合・確定権限・永続化（H3 Draft 第 7 章。H3-1a から H3-6）----
const cand = (device_id) => ({ device_id, model: "m", serial: "s", room: "r", install_year: 2020, modality: "XR", score: 1, reasons: [] });
const mkCase = async (dp, site = "HVN-SITE-001") => {
  const vv = m.validateNewCase({ dp_number: dp, site_id: site, symptom_text: "x", reporter_role: "junior_fse" });
  return (await m.createCase(vv.value)).record.case_id;
};
const snap = async (cid) => JSON.stringify(await m.getCase(cid));
const h1 = await mkCase("DP-FIC-2026-0021");
// H3-1a: 複製上の正当な変更（in-place で書き換えて返す）は保存される
const r1a = await m.updateCase(h1, (c) => {
  c.device_candidates = [cand("HVN-DEV-XR-001")];
  c.device_confirmation_status = "needs_human_selection";
  return { record: c, result: 1 };
});
check("H3-1a 複製上の正当な in-place 変更は保存される", r1a.found && r1a.wrote === true && (await m.getCase(h1)).device_candidates.length === 1);
// H3-1b: in-place で未確定から確定へ書き換える（R4 Guardian の H-3 再現）は拒否され、永続状態は不変
const h1s1 = await snap(h1);
check("H3-1b in-place で confirmed へ書き換えると拒否（Guardian H-3 の再現）", await throws(() => m.updateCase(h1, (c) => {
  c.device_confirmation_status = "confirmed";
  c.device_id = "HVN-DEV-XR-003";
  c.device_confirmation = { device_id: "HVN-DEV-XR-003", confirmed_by_role: "junior_fse", source: "client_asserted_human_selection", verified: false, confirmed_at: "x" };
  return { record: c, result: 1 };
})));
check("H3-1b 拒否後も永続状態は不変", (await snap(h1)) === h1s1);
// H3-1c: 複製を書き換えたまま record:null を返しても保存されない（隔離）
const r1c = await m.updateCase(h1, (c) => {
  c.symptom_text = "改ざん";
  c.device_candidates = [];
  return { record: null, result: 1 };
});
check("H3-1c 複製を書き換えて record:null を返しても保存されない", r1c.found && r1c.wrote === false && (await snap(h1)) === h1s1);
// H3-2: 不変フィールド
for (const [k, val] of [["case_id", "CASE-x"], ["dp_number", "DP-FIC-2026-0099"], ["site_id", "HVN-SITE-002"], ["symptom_text", "別の症状"], ["reporter_role", "other"], ["created_at", "2000-01-01T00:00:00.000Z"], ["error_code", "E999"], ["observed_at", "2026-01-01T00:00:00Z"]]) {
  check(`H3-2 不変フィールドの変更は拒否: ${k}`, await throws(() => m.updateCase(h1, (c) => ({ record: { ...c, [k]: val }, result: 1 }))));
}
check("H3-2 device_id の変更（未確定）は拒否", await throws(() => m.updateCase(h1, (c) => ({ record: { ...c, device_id: "HVN-DEV-XR-002" }, result: 1 }))));
// H3-3: キー集合・型
check("H3-3 未知キーの追加は拒否", await throws(() => m.updateCase(h1, (c) => ({ record: { ...c, extra_field: 1 }, result: 1 }))));
check("H3-3 既知キーの欠落は拒否", await throws(() => m.updateCase(h1, (c) => { const rest = { ...c }; delete rest.hypotheses; return { record: rest, result: 1 }; })));
check("H3-3 型不一致（配列でない confirmed_facts）は拒否", await throws(() => m.updateCase(h1, (c) => ({ record: { ...c, confirmed_facts: "x" }, result: 1 }))));
check("H3-3 型不一致（不正な status）は拒否", await throws(() => m.updateCase(h1, (c) => ({ record: { ...c, status: "weird" }, result: 1 }))));
// H3-4: 台帳照合
check("H3-4b 他施設の装置を候補に入れると拒否", await throws(() => m.updateCase(h1, (c) => ({ record: { ...c, device_candidates: [cand("HVN-DEV-XR-003")] }, result: 1 }))));
check("H3-4b 台帳にない装置を候補に入れると拒否", await throws(() => m.updateCase(h1, (c) => ({ record: { ...c, device_candidates: [cand("HVN-DEV-ZZ-999")] }, result: 1 }))));
check("H3-4 拒否後も永続状態は不変", (await snap(h1)) === h1s1);
// H3-5: 確定権限
const h5 = await mkCase("DP-FIC-2026-0022");
await m.updateCase(h5, (c) => ({ record: { ...c, device_candidates: [cand("HVN-DEV-XR-001")], device_confirmation_status: "needs_human_selection" }, result: 1 }));
const h5s = await snap(h5);
const nc = await m.confirmDevice(h5, "HVN-DEV-XR-003", "junior_fse");
check("H3-5b 候補外（他施設）は confirmDevice でも not_a_candidate", nc.found && nc.result.kind === "not_a_candidate" && nc.wrote === false);
check("H3-5a 確定は updateCase 経由では拒否（スプレッド版）", await throws(() => m.updateCase(h5, (c) => ({ record: { ...c, device_confirmation_status: "confirmed", device_id: "HVN-DEV-XR-001", device_confirmation: { device_id: "HVN-DEV-XR-001", confirmed_by_role: "junior_fse", source: "client_asserted_human_selection", verified: false, confirmed_at: "x" } }, result: 1 }))));
check("H3-5 拒否後も永続状態は不変", (await snap(h5)) === h5s);
const okc = await m.confirmDevice(h5, "HVN-DEV-XR-001", "junior_fse");
check("H3-5 候補内の確定は成功し wrote=true", okc.found && okc.result.kind === "confirmed" && okc.wrote === true);
// H3-5d: 確定済みの改変（in-place 版）
const h5c = await snap(h5);
check("H3-5d 確定済みの verified を in-place で true にすると拒否", await throws(() => m.updateCase(h5, (c) => { c.device_confirmation.verified = true; return { record: c, result: 1 }; })));
check("H3-5d 確定済みの解除を in-place で行うと拒否", await throws(() => m.updateCase(h5, (c) => { c.device_confirmation_status = "unconfirmed"; c.device_confirmation = null; return { record: c, result: 1 }; })));
check("H3-5d 確定済みの device_id を in-place で変更すると拒否", await throws(() => m.updateCase(h5, (c) => { c.device_id = "HVN-DEV-XR-002"; c.device_confirmation.device_id = "HVN-DEV-XR-002"; return { record: c, result: 1 }; })));
check("H3-5d 拒否後も確定記録は不変", (await snap(h5)) === h5c);
// H3-6: 永続化の失敗（tmp への書込み失敗 = before_commit）。cases.json は不変で、tmp は残らない
if (typeof process.getuid === "function" && process.getuid() === 0) {
  console.log("SKIP: H3-6 は root では書込み禁止を再現できない");
} else {
  const { chmod, readdir } = await import("node:fs/promises");
  const origDir = process.env.ESN_DATA_DIR;
  const dirF = await mkdtemp(path.join(os.tmpdir(), "esn-inv-fail-"));
  process.env.ESN_DATA_DIR = dirF;
  const hf = await mkCase("DP-FIC-2026-0023");
  const before = await readFile(path.join(dirF, "cases.json"), "utf8");
  await chmod(dirF, 0o555);
  let phase = null;
  try {
    await m.updateCase(hf, (c) => ({ record: { ...c, device_candidates: [cand("HVN-DEV-XR-001")], device_confirmation_status: "needs_human_selection" }, result: 1 }));
  } catch (e) {
    phase = e instanceof m.StoreWriteError ? e.phase : `other:${e?.message}`;
  }
  await chmod(dirF, 0o755);
  const after = await readFile(path.join(dirF, "cases.json"), "utf8");
  const leftovers = (await readdir(dirF)).filter((f) => f.endsWith(".tmp"));
  check("H3-6 書込み失敗は StoreWriteError(before_commit)", phase === "before_commit", String(phase));
  check("H3-6 失敗後も cases.json は不変", before === after);
  check("H3-6 tmp ファイルが残らない", leftovers.length === 0, JSON.stringify(leftovers));
  process.env.ESN_DATA_DIR = origDir;
}

console.log(failed === 0 ? "ALL PASS" : `FAILED: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
