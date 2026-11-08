// G-08 P0 最小構成 + R3 N-R2-05: 機種確定経路の構造的分離を TypeScript AST で静的に検査する（サーバー不要）
// 使い方: npm run test:boundary
// 検査（字面ではなく構文木。変数経由の代入・括弧記法・スプレッドも対象にする近似検査。完全な証明ではない）:
//  1. device_confirmation_status への "confirmed" の書込み（オブジェクトリテラル・代入・括弧記法）は caseStore.confirmDevice のみ（R4: 実行時の不変条件 assertInvariants が本命。AST 検査は補助）
//  2. verified の値は常に false リテラル（true・式・変数・スプレッド越しの上書きを src 全体で禁止）
//  3. updateCase / createCase の使用ファイルは許可リストのみ（新規ファイルが書込み経路を持てば失敗）
//  4. TP-05 用 AI 経路（triage / adapter / llm / claude）が存在する場合、caseStore・deviceSearch・device-confirm を import しない
//  5. 確定の provenance（source）は caseStore の固定定数 CONFIRM_SOURCE のみ
//  7. 危険な構成要素（computed key、Object.assign/defineProperty、Reflect.set、動的 import、eval、new Function）が src に存在しない
//  6. 許可ロールは junior_fse のみ、safetyGate に上級ロール許可が無い
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const root = path.join(process.cwd(), "src");
let failed = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : ` ${detail}`}`);
  if (!cond) failed++;
};

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = await walk(root);
const rel = (f) => path.relative(root, f).split(path.sep).join("/");
const CONFIRM_ROUTE = "app/api/v1/cases/[id]/device-confirm/route.ts";

const parsed = [];
for (const f of files) {
  const text = await readFile(f, "utf8");
  parsed.push({ f, r: rel(f), text, sf: ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS) });
}

const propName = (n) => {
  if (ts.isIdentifier(n) || ts.isStringLiteral(n)) return n.text;
  if (ts.isComputedPropertyName(n) && ts.isStringLiteral(n.expression)) return n.expression.text; // ["verified"]: true も検出
  return null;
};
const dangerous = [];
const isStr = (n, v) => !!n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === v;
const strLit = (n) => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null);
const lhsName = (n) => {
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  if (ts.isElementAccessExpression(n)) return strLit(n.argumentExpression);
  return null;
};

// false リテラル（false as const を含む）
const isFalse = (n) => n.kind === ts.SyntaxKind.FalseKeyword || (ts.isAsExpression(n) && n.expression.kind === ts.SyntaxKind.FalseKeyword);
const confirmedWriters = new Set();
const statusWriters = new Set(); // device_confirmation_status への任意の書込み（値が confirmed 以外でも記録）
const verifiedViolations = [];
const sourceValues = [];
const mutatorUsers = new Set();
for (const { r, sf } of parsed) {
  const visit = (n, fn = "") => {
    const nextFn = ts.isFunctionDeclaration(n) && n.name ? n.name.text : fn;
    if (ts.isComputedPropertyName(n) && !ts.isStringLiteral(n.expression)) dangerous.push(`${r}:computed-key`);
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      if (e.kind === ts.SyntaxKind.ImportKeyword) dangerous.push(`${r}:dynamic-import`);
      if (ts.isIdentifier(e) && e.text === "eval") dangerous.push(`${r}:eval`);
      if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && ((e.expression.text === "Object" && /^(assign|defineProperty|defineProperties|setPrototypeOf)$/.test(e.name.text)) || (e.expression.text === "Reflect" && /^(set|defineProperty)$/.test(e.name.text)))) dangerous.push(`${r}:${e.expression.text}.${e.name.text}`);
    }
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Function") dangerous.push(`${r}:new-Function`);
    if (ts.isPropertyAssignment(n)) {
      const name = propName(n.name);
      if (name === "device_confirmation_status") {
        statusWriters.add(r);
        if (!isStr(n.initializer, "unconfirmed") && !isStr(n.initializer, "needs_human_selection")) confirmedWriters.add(`${r}#${fn}` + (isStr(n.initializer, "confirmed") ? "" : "[non-literal]"));
      }
      if (name === "verified" && !isFalse(n.initializer)) verifiedViolations.push(`${r}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
      if (name === "source" && r === "lib/caseStore.ts") sourceValues.push(ts.isIdentifier(n.initializer) ? `id:${n.initializer.text}` : strLit(n.initializer));
    } else if (ts.isShorthandPropertyAssignment(n)) {
      const name = n.name.text;
      if (name === "verified") verifiedViolations.push(`${r}:shorthand`);
      if (name === "device_confirmation_status") {
        statusWriters.add(r);
        confirmedWriters.add(`${r}#${fn}[shorthand]`);
      }
    } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const name = lhsName(n.left);
      if (name === "device_confirmation_status") {
        statusWriters.add(r);
        confirmedWriters.add(`${r}#${fn}[assign]`);
      }
      if (name === "verified" && !isFalse(n.right)) verifiedViolations.push(`${r}:assign`);
    } else if (ts.isIdentifier(n) && (n.text === "updateCase" || n.text === "createCase") && !(ts.isImportSpecifier(n.parent) && false)) {
      mutatorUsers.add(r);
    }
    ts.forEachChild(n, (c) => visit(c, nextFn));
  };
  visit(sf);
}

// 1. confirmed の書込み箇所
// device-search route は outcome.status（型で "confirmed" を除外済み）を書く。型の除外が外れたら失敗させる。
const SEARCH_ROUTE = "app/api/v1/cases/[id]/device-search/route.ts";
const ds = parsed.find((p) => p.r === "lib/deviceSearch.ts");
const searchTyped = !!ds && /status:\s*Exclude<DeviceConfirmationStatus,\s*"confirmed">/.test(ds.text) && /const status:\s*Exclude<DeviceConfirmationStatus,\s*"confirmed">/.test(ds.text);
const writers = [...confirmedWriters].filter((x) => !(x.startsWith(`${SEARCH_ROUTE}#`) && x.endsWith("[non-literal]") && searchTyped));
check("device_confirmation_status への確定書込みは caseStore.confirmDevice のみ", writers.length === 1 && writers[0] === "lib/caseStore.ts#confirmDevice", JSON.stringify(writers));
check("device-search の status 型は confirmed を除外している", searchTyped);

// 2. verified は常に false
check("verified に false 以外を代入・設定する箇所が無い", verifiedViolations.length === 0, JSON.stringify(verifiedViolations));
const store = parsed.find((p) => p.r === "lib/caseStore.ts");
check("DeviceConfirmation.verified の型は false リテラル", !!store && /verified:\s*false;/.test(store.text));

// 3. 書込み経路（updateCase / createCase）の使用ファイル固定
const ALLOWED_MUTATORS = new Set(["lib/caseStore.ts", "app/api/v1/cases/route.ts", "app/api/v1/cases/[id]/device-search/route.ts", CONFIRM_ROUTE]);
const extra = [...mutatorUsers].filter((x) => !ALLOWED_MUTATORS.has(x));
check("updateCase / createCase を使うファイルは許可リストのみ", extra.length === 0, JSON.stringify(extra));

// 4. AI 経路（TP-05 で作成予定）からの確定・書込み経路 import 禁止
const aiFiles = parsed.filter((p) => /(^|\/)(triage|adapter|llm|claude)[^/]*(\/|\.ts)/i.test(p.r) || /lib\/(triage|adapter|llm|claude)/i.test(p.r));
const aiViolations = [];
for (const { r, sf } of aiFiles) {
  sf.forEachChild((n) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
      const spec = n.moduleSpecifier ? strLit(n.moduleSpecifier) : null;
      if (spec && /(caseStore|deviceSearch|device-confirm)/.test(spec)) aiViolations.push(`${r}:${spec}`);
    }
  });
  if (/updateCase|createCase|device-confirm/.test(sf.text)) aiViolations.push(`${r}:text`);
}
check(`AI 経路（${aiFiles.length} ファイル）が機種確定経路・書込み経路を使わない`, aiViolations.length === 0, JSON.stringify(aiViolations));

// 5. provenance
const storeText = store?.text ?? "";
check("確定の source は固定定数 CONFIRM_SOURCE のみ", sourceValues.length >= 1 && sourceValues.every((v) => v === "id:CONFIRM_SOURCE") && /const CONFIRM_SOURCE = "client_asserted_human_selection" as const;/.test(storeText), JSON.stringify(sourceValues));
// R5 H-3: 比較の基準は凍結した pristine（fn に渡さない）で、fn には複製を渡す
check("実行時の不変条件 assertInvariants が mutate 内で保存前に呼ばれる（基準は pristine）", /assertInvariants\(pristine, out\.record, allowConfirm\);\s*\n\s*all\[i\] =/.test(storeText));
check("mutate は fn に structuredClone した複製を渡し、基準 pristine を凍結する（状態隔離。AST 検査は補助で、本命は実行時の検査）", /const pristine = deepFreeze\(all\[i\]\)/.test(storeText) && /fn\(structuredClone\(pristine\)\)/.test(storeText));
check("危険な構成要素（computed key / Object.assign / defineProperty / Reflect.set / 動的 import / eval / new Function）が無い", dangerous.length === 0, JSON.stringify(dangerous));

// 6. 許可ロール
const roles = await readFile(path.join(root, "lib", "roles.ts"), "utf8");
const m = roles.match(/ALLOWED_REPORTER_ROLES[^=]*=\s*\[([^\]]*)\]/);
const list = m ? m[1].split(",").map((x) => x.trim().replace(/["']/g, "")).filter(Boolean) : null;
check("許可ロールは junior_fse のみ", Array.isArray(list) && list.length === 1 && list[0] === "junior_fse", JSON.stringify(list));
const gate = await readFile(path.join(root, "lib", "safetyGate.ts"), "utf8");
check("safetyGate に上級ロール許可が無い", /PRIVILEGED_ROLE_KEYS:\s*readonly string\[\]\s*=\s*\[\]/.test(gate));

// 自己検証: 検査器が違反パターンを検出できること（検査器自体の健全性）
const probe = ts.createSourceFile("probe.ts", 'const k = "confirmed"; const a = { device_confirmation_status: k, verified: true }; x["device_confirmation_status"] = k;', ts.ScriptTarget.Latest, true);
let probeStatus = 0;
let probeVerified = 0;
const pv = (n) => {
  if (ts.isPropertyAssignment(n) && propName(n.name) === "device_confirmation_status" && !isStr(n.initializer, "unconfirmed")) probeStatus++;
  if (ts.isPropertyAssignment(n) && propName(n.name) === "verified" && n.initializer.kind !== ts.SyntaxKind.FalseKeyword) probeVerified++;
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && lhsName(n.left) === "device_confirmation_status") probeStatus++;
  ts.forEachChild(n, pv);
};
pv(probe);
check("検査器の自己検証（変数経由・括弧記法・verified:true を検出）", probeStatus === 2 && probeVerified === 1, `status=${probeStatus} verified=${probeVerified}`);

console.log(failed === 0 ? "ALL PASS" : `FAILED: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
