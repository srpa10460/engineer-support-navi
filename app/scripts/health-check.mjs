// TP-00 自動テスト: 起動中のサーバーに対して /api/v1/health を検査する
// 使い方: npm run dev（別ターミナル）→ npm run test:health
const base = process.env.ESN_BASE_URL ?? "http://127.0.0.1:3000";
const url = `${base}/api/v1/health`;

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

let res;
try {
  res = await fetch(url);
} catch (e) {
  fail(`接続できません ${url} (${e.message})`);
}

if (res.status !== 200) fail(`HTTP ${res.status} (期待 200)`);

const body = await res.json();
if (body.ok !== true) fail("ok が true ではありません");
if (body.data?.status !== "ok") fail("data.status が ok ではありません");
if (!body.safety || body.safety.blocked !== false) fail("safety.blocked が false ではありません");
if (!Array.isArray(body.errors) || body.errors.length !== 0) fail("errors が空配列ではありません");

console.log(`PASS: ${url} -> 200 ok phase=${body.data.phase}`);
