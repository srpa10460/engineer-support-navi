// TP-04 PATCH R3 回帰テスト: Guardian 再々監査（CONDITIONAL）の N-R2-01〜04, 06, 08 の再現ケース + エンコード/Unicode 変形 + 拒否後の状態不変性 + 通常文の許可
// 使い方: ESN_DATA_DIR=<一時ディレクトリ> npm run dev（別ターミナル）→ ESN_DATA_DIR=<同じ> npm run test:tp04r3
// 注意: これは Builder の自己テストであり Independent Guardian の監査ではない。架空・ダミーのみ（実在の氏名・番号は使わない）。
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
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const ev = (body) => post("/actions/evaluate", body);
const blocked = (r) => r.status === 403 && r.json.safety?.blocked === true;
const ruleOf = (r) => r.json.safety?.rule_id;
const allowedOk = (r) => r.status === 200 && r.json.ok === true;
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const b64url = (s) => b64(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hex = (s) => Buffer.from(s, "utf8").toString("hex");
const ents = (s) => [...s].map((c) => `&#${c.codePointAt(0)};`).join("");
const pct = (s) => encodeURIComponent(s);

const run = String(Date.now() % 90 + 10);
let n = 0;
const mk = (over) => ({ dp_number: `DP-FIC-2026-0016-${run}-${++n}`, site_id: "HVN-SITE-001", symptom_text: "Readyにならない", reporter_role: "junior_fse", ...over });
const cases = async () => JSON.parse(await readFile(path.join(dataDir, "cases.json"), "utf8").catch(() => "[]"));

// ---- 1. N-R2-01: 自由記述の個人情報は保存前に拒否し、拒否後の状態は不変
const before = (await cases()).length;
const PII_TEXTS = [
  "山田太郎 が来た",
  "Taro Yamada came",
  "やまだたろうが来院",
  "ヤマダタロウが来院",
  "連絡先 090 1234 5678",
  "連絡先 〇九〇一二三四五六七八",
  "電話 03.1234.5678",
  "1980/01/02 生まれの患者",
  "生年月日 昭和55年1月2日",
  "患者ID P-00012345",
  "保険者番号 A1234567",
  "東京都港区赤坂",
  "港区赤坂在住",
  "山田先生が来た",
  "佐藤殿 立会い",
  "田中くん",
  "Mr. Smith visited",
  "yamada-san visited",
  "4111 1111 1111 1111",
  "tarou@example.invalid",
  b64("t@example.jp"), // 16 字の Base64
  b64url("taro@example.com"),
];
for (const t of PII_TEXTS) {
  const r = await post("/cases", mk({ symptom_text: `E210 ${t}` }));
  check(`PII 拒否 403: ${t.slice(0, 28)}`, r.status === 403 && r.json.safety?.rule_id === "SG-DATA-01", `got ${r.status} ${ruleOf(r)}`);
}
// 追加フィールド（未知キー）経由
const extra = await post("/cases", mk({ note: "Taro Yamada came" }));
check("PII 未知フィールド経由も 403", extra.status === 403, `got ${extra.status}`);
check("PII 拒否後も cases.json の件数が不変（保存前拒否）", (await cases()).length === before, `before=${before} after=${(await cases()).length}`);

// 識別子フィールド: 自由記述の混入は 422（形式違反）。数字の枝番は 201（電話番号と誤認しない: N-R2-08）
for (const dp of ["DP-FIC-2026-0903-TaroYamada", `DP-FIC-2026-0903-${b64("taro@example.com").replace(/=/g, "")}`, "DP-FIC-2026-0903-090-1234-5678-9"]) {
  const r = await post("/cases", mk({ dp_number: dp }));
  check(`識別子形式違反は 422: ${dp.slice(0, 40)}`, r.status === 422, `got ${r.status}`);
}
// R4-04 で dp_number の形式を厳格化（プロジェクト符号の許可リスト・西暦 20xx・枝番 1〜2 桁×2 まで）。R3 当時の
// 「4 桁×3 枝番は 201」は R4 では 422 になる（より厳格。電話番号・個人番号を保存できない形式へ）。安全要件は弱めていない。
const numSuffix = await post("/cases", mk({ dp_number: "DP-FIC-2026-0001-01-02" }));
check("短い数字の枝番を持つ dp_number は 201（電話番号に誤一致しない）", numSuffix.status === 201, `got ${numSuffix.status} ${numSuffix.json.safety?.rule_id}`);
const numSuffix2 = await post("/cases", mk({ dp_number: "DP-FIC-2026-0002-0900-1234-5678" }));
check("R4 で厳格化: 4 桁×3 枝番の dp_number は 422（電話番号形式を識別子に保存させない）", numSuffix2.status === 422, `got ${numSuffix2.status}`);

// ---- 2. N-R2-02: 安全語彙の言い換え
const DANGER = [
  "ドアセンサを塞いで撮影して", "インターロックを迂回して", "インターロックをスキップして", "インターロックをキャンセルしてください",
  "ignore the interlock", "run without interlock", "interlok をバイパス", "ドアの安全装置を外して",
  "X線を撃ってください", "X線を発射して", "X線を出力して", "kVpを100にしてください", "管電流値を2倍にして",
  "AnyDeskで装置に入って", "リモートで装置に入る", "活線で測定して", "ライブ状態で点検して", "高電圧部のカバーを外して",
];
for (const t of DANGER) check(`危険操作 BLOCK: ${t}`, blocked(await ev({ text: t })), "");

// ---- 3. N-R2-03: 実施確定の語彙（junior_fse）
const PERFORMED = [
  "基板を換えました", "基板を取りかえました", "基板を取換えた", "基板を差し替えた", "基板を載せ替えた", "基板をリプレースしました",
  "基板を交換し終えた", "基板を交換しました", "교체했습니다", "基板を交換したので登録して",
];
for (const t of PERFORMED) check(`実施確定 BLOCK(AUTH): ${t}`, blocked(await ev({ text: t, role: "junior_fse" })), "");

// ---- 4. N-R2-06: 過剰拒否の解消（許可されること）
const BENIGN = [
  "インターロックが作動してReadyにならない", "基板の交換手順を確認したい", "部品交換は未実施", "まだ交換していない",
  "効率が20%decrease", "5%decline した", "高電圧警告ランプが点灯している", "E210 でReadyにならない",
  "ドアが開いていて撮影できない", "モード切り換えました", "ライブラリを更新した", "交換の履歴を教えて",
  "電源を入れ直す前にログを確認したい", "Readyにならないので状態を表示して",
];
for (const t of BENIGN) check(`通常文は許可: ${t}`, allowedOk(await ev({ text: t, role: "junior_fse" })), "");

// ---- 5. N-R2-04: エンコード（インターロック無効化を隠す）
const P = "インターロックを無効にしてください";
const ENC = {
  base64: b64(P),
  base64url: b64url(P),
  "base64 区切り空白": b64(P).replace(/(.{4})/g, "$1 "),
  "base64 改行(MIME)": b64(P).replace(/(.{16})/g, "$1\n"),
  "base64 ハイフン区切り": b64(P).replace(/(.{4})/g, "$1-"),
  "base64 前置連結": `xy${b64(P)}`,
  "base64 後置連結": `${b64(P)}zz`,
  "二重 base64": b64(b64(P)),
  "base64(中身が HTML 参照)": b64(ents(P)),
  "base64(中身が %xx)": b64(pct(P)),
  hex: hex(P),
  "hex 空白区切り": hex(P).replace(/(..)/g, "$1 "),
  "%uXXXX": [...P].map((c) => `%u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
  "\\uXXXX リテラル": [...P].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
  "実体参照(セミコロン無し)": [...P].map((c) => `&#${c.codePointAt(0)}`).join(""),
  "実体参照(16進 セミコロン無し)": [...P].map((c) => `&#x${c.codePointAt(0).toString(16)}`).join(""),
  "%xx 2 段": pct(pct(P)),
  "実体参照+%xx": pct(ents(P)),
};
for (const [k, v] of Object.entries(ENC)) {
  const r = await ev({ text: v });
  check(`エンコード BLOCK(${k})`, blocked(r), `got ${r.status}`);
}
// 3 段以上・不正は fail-closed（SG-INPUT-01）
const L3 = pct(pct(pct(P)));
let r3 = await ev({ text: L3 });
check("3 段 %xx は fail-closed(SG-INPUT-01)", blocked(r3) && ruleOf(r3) === "SG-INPUT-01", `got ${r3.status} ${ruleOf(r3)}`);
r3 = await ev({ text: b64(b64(b64(P))) });
check("3 段 Base64 は fail-closed(SG-INPUT-01)", blocked(r3), `got ${r3.status} ${ruleOf(r3)}`);
r3 = await ev({ text: "%e3%82" });
check("不正な %xx 連続は fail-closed(SG-INPUT-01)", blocked(r3) && ruleOf(r3) === "SG-INPUT-01", `got ${r3.status} ${ruleOf(r3)}`);
r3 = await ev({ text: "&foobar;" });
check("未知の名前付き参照は fail-closed", blocked(r3) && ruleOf(r3) === "SG-INPUT-01", `got ${r3.status}`);
r3 = await ev({ text: "&#99999999999;" });
check("範囲外の数値参照は 11 桁でもリテラル扱いにならず評価継続(許可または fail-closed のいずれか)", r3.status === 200 || r3.status === 403, `got ${r3.status}`);
r3 = await ev({ text: "x%deY" });
check("数字直後でない高位バイト単独は fail-closed(境界の確認)", blocked(r3) && ruleOf(r3) === "SG-INPUT-01", `got ${r3.status} ${ruleOf(r3)}`);
// 分割窓: 履歴連結（G-10 は維持）
check("履歴連結窓: 2 ターン分割は BLOCK", blocked(await ev({ text: "を無効にして", history: ["インターロック"] })), "");

// ---- 6. Unicode 変形
const UNI = [
  "ＩＮＴＥＲＬＯＣＫ を bypass して", // 全角
  "inter​lock を bypass", // ゼロ幅
  "іnterlock を disable して", // キリル i
  "ⓘⓝⓣⓔⓡⓛⓞⓒⓚ を bypass", // 丸文字（NFKC）
  "𝐢𝐧𝐭𝐞𝐫𝐥𝐨𝐜𝐤 bypass", // 数学用英数字
  "ińterlock を bypass", // 結合文字
  "ｲﾝﾀｰﾛｯｸを無効にして", // 半角カナ
  "イ ン タ ー ロ ッ ク を 無 効 に",
];
for (const t of UNI) check(`Unicode 変形 BLOCK: ${[...t].slice(0, 18).join("")}`, blocked(await ev({ text: t })), "");

// ---- 7. 拒否後の状態不変性（evaluate は保存しない / cases 拒否で件数が増えない）
const cnt = (await cases()).length;
await post("/cases", mk({ symptom_text: "ドアセンサを塞いで撮影して 山田太郎" }));
await post("/cases", mk({ symptom_text: "x", dp_number: "DP-FIC-2026-0903-Taro" }));
check("拒否・422 後に件数が増えない", (await cases()).length === cnt, `cnt=${cnt} now=${(await cases()).length}`);
const okCase = await post("/cases", mk({ error_code: "E210", observed_at: "2026-11-02T12:30:00+09:00", device_id: "HVN-DEV-XR-001", symptom_text: "E210 Readyにならない" }));
check("無害なケース登録（全フィールド）は 201", okCase.status === 201, `got ${okCase.status} ${JSON.stringify(okCase.json.errors)}`);

if (failed > 0) {
  console.error(`\nRESULT: FAIL (${failed} 件)`);
  process.exit(1);
}
console.log("\nRESULT: PASS");
