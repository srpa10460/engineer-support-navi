// TP-04 Safety Gate Engine（決定論的制御層）
// 仕様: preparation/03_ARCHITECTURE.md §6 / 05_ACCEPTANCE_TESTS.md S-01〜S-05
// 評価順序: 入力検査(型・サイズ) → 許可アクション列挙 → エンコード展開(有限段) → 入力正規化 → ルール全走査 → いずれか HIT で即 BLOCK（LLM は呼ばない）。
// 方針: false negative 不可・false positive 許容（06_AGENT_TASK_PACKETS.md TP-04 Fallback）。
// 改訂履歴:
//   R1(2026-11-02 Guardian G-01〜G-07, G-09): 正規化強化・共起パターン・fail-closed。
//   R2(2026-11-02 Guardian 再監査 N-01〜N-05, G-10 設計): ロールは junior_fse のみ（仕様外の上級ロールを撤回）、
//        語彙・個人情報形式の拡張、HTML 実体参照/%xx/Base64 の有限段デコード再評価（曖昧・不正は fail-closed）、
//        履歴連結窓（上限付き）の評価。
//   R5(2026-11-03 Human 承認の暫定設計): H-1 未割当・私用・孤立サロゲート・非文字の fail-closed、H-2/AUTH-Q 質問文免除の撤回、
//        INV-9 件数基準の超過(γ 案)を判定不能として fail-closed（具体ルール優先）、cause_detail（内部 6 分類）の付与。

export type RuleId =
  | "SG-HV-01"
  | "SG-ILK-01"
  | "SG-DOSE-01"
  | "SG-REMOTE-01"
  | "SG-AUTH-01"
  | "SG-DATA-01"
  | "SG-MISS-01"
  | "SG-ENUM-01"
  | "SG-INPUT-01";

export type GateInput = {
  text?: unknown;
  // 直前までの人間（ユーザー）発話。LLM 出力は含めない。上限付きの窓として連結評価される（G-10）。
  history?: unknown;
  role?: unknown;
  action?: unknown;
  root_cause_confirmed?: unknown;
  missing_measurements?: unknown;
  // "identifier": 形式検証済みの識別子欄。自由記述用の形式検出（電話・氏名文脈等）は適用せず、秘密情報・メール・12/16 桁番号・姓名トークンだけを検査する（R4-04）
  scope?: "identifier";
};

// R5: 内部の原因分類（監査記録用の 6 種）。利用者向けの 4 分類への対応は rejection.ts。
export type CauseDetail = "rule_hit" | "invalid_action" | "undecidable_size" | "undecidable_decode" | "undecidable_truncation" | "overload";

export type GateDecision = {
  blocked: boolean;
  rule_id: RuleId | null;
  escalate_to: string | null;
  reason: string | null;
  matched_rules: RuleId[];
  cause_detail?: CauseDetail;
  // R5: 件数基準の超過（切捨て）があったか。監査記録用
  truncated?: boolean;
};

// §6.2 API 層の許可アクション列挙。列挙外は拒否。
export const ALLOWED_ACTIONS = [
  "triage_message",
  "register_performed_action",
  "save_case_field",
  "set_root_cause_confirmed",
] as const;

// 評価可能な入力の上限（超過は判定不能として fail-closed）
export const MAX_TEXT_CHARS = 20000;
// 履歴連結窓の上限（直近 N 発話、かつ合計文字数が MAX_TEXT_CHARS 以内になるよう古い方から切り落とす）
export const MAX_HISTORY_TURNS = 10;
// エンコード展開の最大段数。これを超えて展開が続く入力は曖昧として fail-closed。
export const MAX_DECODE_DEPTH = 2;
const MAX_NODES = 200; // 1 つの入力あたりの展開ノード上限
const MAX_EVAL_TEXTS = 600;

// 新人扱いにしない許可ロール。仕様上のロールは junior_fse のみ（OD-03）のため空。
// 上級ロールを追加する場合は Human が仕様に追記してから（Rule Drift 防止）。
const PRIVILEGED_ROLE_KEYS: readonly string[] = [];

// ---- エンコード展開（N-04 / R3 N-R2-04）-----------------------------------

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

type Decoded = { out: string; failed: string | null };

// HTML 実体参照（セミコロン無しの数値・既知名を含む）・%xx・%uXXXX・\uXXXX を 1 段だけ展開する。不正・未知の参照は failed（fail-closed）。
function decodeLayer(s: string): Decoded {
  const st = { failed: null as string | null };
  let out = s.replace(/(?:\\u|%u)([0-9a-f]{4})|\\u\{([0-9a-f]{1,6})\}/gi, (m, h4?: string, hb?: string) => {
    if (h4) return String.fromCharCode(parseInt(h4, 16));
    const cp = parseInt(hb ?? "0", 16);
    if (cp > 0x10ffff) {
      st.failed ??= "不正な Unicode エスケープ";
      return m;
    }
    return String.fromCodePoint(cp);
  });
  out = out.replace(/&(?:#(\d+);?|#x([0-9a-f]+);?|([a-z]{2,32});|(amp|lt|gt|quot|apos|nbsp)(?![a-z0-9]))/gi, (m, dec?: string, hex?: string, name?: string, bare?: string) => {
    const nm = name ?? bare;
    if (nm) {
      const v = NAMED_ENTITIES[nm.toLowerCase()];
      if (v === undefined) {
        st.failed ??= "未知の名前付き文字参照";
        return m;
      }
      return v;
    }
    // R4: 先頭ゼロを許容（&#000000000108; 等）。先頭ゼロを除いた有効桁が 7（10 進）/ 6（16 進）桁を超えるものは範囲外として fail-closed
    const digits = (dec ?? hex ?? "0").replace(/^0+(?=.)/, "");
    const cp = digits.length > (dec ? 7 : 6) ? Infinity : dec ? parseInt(digits, 10) : parseInt(digits, 16);
    if (!Number.isFinite(cp) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      st.failed ??= "不正な数値文字参照";
      return m;
    }
    return String.fromCodePoint(cp);
  });
  out = out.replace(/(?:%[0-9a-f]{2})+/gi, (run, offset: number, whole: string) => {
    try {
      return decodeURIComponent(run);
    } catch {
      // 例外（R3 N-R2-06）: 数字の直後にある高位バイト 1 組＋英字 2 文字以上（"20%decrease" 等の百分率＋英単語）はリテラル扱い。
      // 1 組だけでは文字を構成できず隠せる内容が無いため。2 組以上・数字以外の直後・英字が続かない場合は従来どおり fail-closed。
      if (run.length === 3 && offset > 0 && /\d/.test(whole[offset - 1]) && /^[a-z]{2}/i.test(whole.slice(offset + 3, offset + 5))) return run;
      st.failed ??= "不正なパーセントエンコード";
      return run;
    }
  });
  return { out, failed: st.failed };
}

const B64_SEP = /\\[nrt]|<\/?[a-z][^>]{0,20}>|[\s\u200b-\u200d\u2060\ufeff"'`,.;:|\\()<>[\]{}*]+/gi;
const NOISE = /[\ufffd\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;
const HAS_NOISE = /[\ufffd\u0000-\u0008\u000b\u000c\u000e-\u001f]/; // test 用（g フラグの lastIndex 状態を避ける）
const MAX_RUNS_PER_SOURCE = 8;
const MAX_RUNS_PER_NODE = 24;

type EncodedKids = { strict: string[]; lenient: string[]; truncated: boolean };

// Base64（標準/URL-safe。16 文字以上。区切り・MIME 折り返し除去後の再結合、前後に文字が連結した塊は先頭 0〜3 文字の切り詰めで再試行）と
// 16 進文字列を展開する。strict=厳密（UTF-8 として妥当）→ さらに展開対象。lenient=参考評価のみ（葉。fail-closed の根拠にしない）。
function encodedVariants(t: string): EncodedKids {
  const strict: string[] = [];
  const lenient: string[] = [];
  // R5 INV-9（件数基準・γ 案）: 上限を超えて候補が切り捨てられたら true。上限ちょうど（全件を評価）は false。
  let truncated = false;
  const joined = t.replace(B64_SEP, "");
  const joined2 = joined.replace(/[-_]/g, "");
  // R4: 任意の非 Base64 文字（# ~ ^ ! ? @ $ % & = 日本語句読点 等）で区切られた分割に対応するため、非 Base64 文字を全て除いた形も評価する。
  // この形は偶然の連結を含み得るため、緩い評価（葉）にのみ使い、厳密展開・fail-closed の根拠にしない。
  const joined3 = t.replace(/[^A-Za-z0-9+/_-]+/g, "");
  const joined4 = t.replace(/[^A-Za-z0-9]+/g, ""); // + / 自体を区切りに使う分割（緩い評価のみ）
  const runs: string[] = [];
  const looseOnly = new Set<string>();
  for (const src of [t, joined, joined2, joined3, joined4]) {
    const found = src.match(/[A-Za-z0-9+/_-]{16,}={0,2}/g) ?? [];
    // 切捨て = 上限を超えて捨てられた一致のうち、評価される側（先頭 8 個）に同一の塊がないもの（重複を除いても未評価の候補が残る）
    if (found.slice(MAX_RUNS_PER_SOURCE).some((r) => !found.slice(0, MAX_RUNS_PER_SOURCE).includes(r))) truncated = true;
    for (const r of found.slice(0, MAX_RUNS_PER_SOURCE)) {
      if (runs.includes(r)) continue;
      runs.push(r);
      if ((src === joined3 || src === joined4) && !(t.includes(r) || joined.includes(r) || joined2.includes(r))) looseOnly.add(r);
    }
  }
  // + / 自体を区切りに使った等間隔の分割（例: 6 文字ごとに + を挿入）。同一文字が等間隔で並ぶ場合だけ除去して緩い評価に加える。
  // R5: 5 個目以降の塊のうち、等間隔の探索の条件（同一文字 3 回以上）に入るものが捨てられる場合は切捨て
  if (runs.slice(4).some((r) => (r.split("+").length - 1) >= 3 || (r.split("/").length - 1) >= 3)) truncated = true;
  for (const run of runs.slice(0, 4)) {
    for (const c of ["+", "/"]) {
      if ((run.split(c).length - 1) < 3) continue;
      for (let sepLen = 1; sepLen <= 2; sepLen++) {
        for (let k = 2; k <= 16; k++) {
          const period = k + sepLen;
          let ok = true;
          let removed = "";
          for (let i = k; i < run.length; i += period) {
            const seg = run.slice(i, i + sepLen);
            if (seg !== c.repeat(sepLen)) {
              ok = false;
              break;
            }
          }
          if (!ok) continue;
          for (let i = 0; i < run.length; i += period) removed += run.slice(i, i + k);
          const txt = Buffer.from(removed.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8").replace(NOISE, "");
          if (txt.length >= 4 && !lenient.includes(txt)) lenient.push(txt);
        }
      }
    }
  }
  if (runs.length > MAX_RUNS_PER_NODE) truncated = true;
  for (const run of runs.slice(0, MAX_RUNS_PER_NODE)) {
    const core = run.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
    if (!looseOnly.has(run)) try {
      const buf = Buffer.from(core, "base64");
      if (buf.toString("base64").replace(/=+$/, "") === core) {
        const txt = new TextDecoder("utf-8", { fatal: true }).decode(buf);
        if (txt.length > 0 && !HAS_NOISE.test(txt)) {
          strict.push(txt);
          continue;
        }
      }
    } catch {
      /* 厳密に復号できない塊は lenient 側で評価 */
    }
    for (let a = 0; a < 4 && core.length - a >= 12; a++) {
      const txt = Buffer.from(core.slice(a), "base64").toString("utf8").replace(NOISE, "");
      if (txt.length >= 4 && !lenient.includes(txt)) lenient.push(txt);
    }
  }
  for (const src of [t, joined2, joined3]) {
    const hexFound = src.match(/(?:[0-9a-f]{2}){8,}/gi) ?? [];
    if (hexFound.slice(MAX_RUNS_PER_SOURCE).some((h) => !hexFound.slice(0, MAX_RUNS_PER_SOURCE).includes(h))) truncated = true;
    for (const h of hexFound.slice(0, MAX_RUNS_PER_SOURCE)) {
      const txt = Buffer.from(h, "hex").toString("utf8").replace(NOISE, "");
      if (txt.length >= 4 && !lenient.includes(txt)) lenient.push(txt);
    }
  }
  if (lenient.length > 48) truncated = true;
  return { strict, lenient: lenient.slice(0, 48), truncated };
}

const MAX_EXPANDED_CHARS = 300000; // R4-03: 展開後の総文字数の上限（超過は判定不能として fail-closed）

// 有限段（MAX_DECODE_DEPTH）で展開した評価対象テキスト群を返す。段数超過・不正・展開量超過は failed（fail-closed）。
// entity/%xx/\u/Base64 を混在させた入れ子（例: Base64 の中身が HTML 参照）も同じ段数制限で再展開する。16 進は 1 段のみ（葉）。
function expandEncodings(text: string): { texts: string[]; failed: string | null; truncated: boolean; unknownSeen: boolean } {
  const texts = [text];
  let truncated = false;
  // R5 H-1: 元の入力・展開（実体参照等）・厳密復号のノードに未割当等の文字が含まれたか（緩い評価の葉は偶然の復号のため対象外）
  let unknownSeen = hasUnknownChar(text);
  const seen = new Set<string>(texts);
  let total = text.length;
  let frontier = [text];
  for (let depth = 0; depth <= MAX_DECODE_DEPTH; depth++) {
    const next: string[] = [];
    for (const t of frontier) {
      const d = decodeLayer(t);
      if (d.failed) return { texts, failed: d.failed, truncated, unknownSeen };
      const enc = encodedVariants(t);
      if (enc.truncated) truncated = true;
      if (depth === MAX_DECODE_DEPTH) {
        if (d.out !== t || enc.strict.length > 0) return { texts, failed: `エンコードの入れ子が上限（${MAX_DECODE_DEPTH} 段）を超過`, truncated, unknownSeen };
        // R5 D6（γ 案）: 深さの上限の節点で捨てられる緩い評価の候補は、切捨てとして扱う（K9）
        if (enc.lenient.length > 0) truncated = true;
        continue;
      }
      const kids: { s: string; expand: boolean; track: boolean }[] = [];
      if (d.out !== t) kids.push({ s: d.out, expand: true, track: true });
      for (const s2 of enc.strict) kids.push({ s: s2, expand: true, track: true });
      for (const s2 of enc.lenient) kids.push({ s: s2, expand: false, track: false });
      for (const k of kids) {
        if (seen.has(k.s)) continue;
        seen.add(k.s);
        texts.push(k.s);
        total += k.s.length;
        if (k.track && !unknownSeen && hasUnknownChar(k.s)) unknownSeen = true;
        if (texts.length > MAX_NODES || total > MAX_EXPANDED_CHARS) return { texts, failed: "展開量が上限を超え判定不能", truncated, unknownSeen };
        if (k.expand) next.push(k.s);
      }
    }
    frontier = next;
  }
  return { texts, failed: null, truncated, unknownSeen };
}

// ---- 正規化 ----------------------------------------------------------------

const HOMOGLYPH: Record<string, string> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", х: "x", у: "y", і: "i", ј: "j", к: "k", м: "m", н: "h", т: "t", в: "b", ѕ: "s",
  ο: "o", α: "a", ε: "e", ι: "i", ν: "v", τ: "t", ρ: "p", κ: "k", μ: "m", ς: "s",
};
const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s", "!": "i" };

const toKata = (s: string) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

type Sentence = { question: boolean; pieces: string[] };

type Norm = {
  raw: string; // NFKC＋不可視文字除去（大文字小文字・かなを保持。氏名・電話・住所の形式検出用）
  spaced: string; // 空白を残した小文字形（\b 判定用）
  compacts: string[]; // 空白・記号・長音を除いた形。[0]=通常, 以降は leet 変種
  sentences: Sentence[]; // 文境界を保持した形（R4-01: 否定・予定・質問の判定は文・節の内側だけで行う）
};

// R4-02: Cf（書式）・M（結合）に加え、Lo だが不可視の Hangul filler（U+115F/U+1160/U+3164/U+FFA0）、点字空白（U+2800）、
// モンゴル母音分離（U+180E）、クメール固有母音（U+17B4/U+17B5）、結合書記素ジョイナ（U+034F）を除去する。
// 除去によって危険語・識別子が再構成された場合は、再構成後の語に対して通常どおり判定される（除去の有無で回避できない）。
const INVISIBLE = /[\p{Cf}\p{M}\u3164\u115f\u1160\uffa0\u2800\u180e\u17b4\u17b5\u034f]/gu;
const HAS_INVISIBLE = /[\p{Cf}\p{M}\u3164\u115f\u1160\uffa0\u2800\u180e\u17b4\u17b5\u034f]/u;
// 数字の間のダッシュ類（U+2212 MINUS 等）を ASCII の - に揃える（電話番号等の形式検出用）
const DASH_BETWEEN_DIGITS = /(?<=[\d)])\s?[\u2010-\u2015\u2212\uff0d\ufe58\ufe63\u30fc]\s?(?=[\d(])/g;

// R5 H-1: 未割当（Cn）・私用領域（Co）・孤立サロゲート（Cs）・非文字（U+FFFE/FFFF、U+FDD0〜FDEF 等）・Common の Lm（U+0640、U+02D0 等）は
// 「未知の文字」として扱う。評価（ルール判定）の前に除去して照合し、具体ルールに当たればそのルールを返す。
// 具体ルールに当たらなければ判定不能（SG-INPUT-01、fail-closed）にする。
const UNKNOWN_CP = /[\p{Cn}\p{Co}\p{Cs}\p{Noncharacter_Code_Point}]/u;
const UNKNOWN_CP_G = /[\p{Cn}\p{Co}\p{Cs}\p{Noncharacter_Code_Point}]/gu;
const LM_ANY = /\p{Lm}/gu;
const SCRIPT_COMMON = /^\p{Script=Common}$/u;
// Common の Lm のうち、通常の日本語表記に現れるものは未知の文字としない: 長音符 U+30FC、半角長音符 U+FF70、半角の濁点・半濁点 U+FF9E/FF9F、縦書き用の繰り返し記号 U+3031 から U+3035。
const COMMON_LM_ALLOWED = /^[\u30fc\uff70\uff9e\uff9f\u3031-\u3035]$/u;
const isUnknownLm = (c: string) => SCRIPT_COMMON.test(c) && !COMMON_LM_ALLOWED.test(c);
function hasUnknownChar(s: string): boolean {
  if (UNKNOWN_CP.test(s)) return true;
  for (const m of s.matchAll(LM_ANY)) if (isUnknownLm(m[0])) return true;
  return false;
}
function scrubUnknown(s: string): string {
  return s.replace(UNKNOWN_CP_G, "").replace(LM_ANY, (c) => (isUnknownLm(c) ? "" : c));
}

function cleanRaw(s: string): string {
  let r = s.normalize("NFKC").replace(INVISIBLE, "").normalize("NFKC");
  // 再合成で不可視文字が現れる場合に備えた再検査（最大 2 回）
  for (let i = 0; i < 2 && HAS_INVISIBLE.test(r); i++) r = r.replace(INVISIBLE, "").normalize("NFKC");
  return r.replace(DASH_BETWEEN_DIGITS, "-");
}

function toBase(raw: string): string {
  const base = raw
    .toLowerCase()
    // ラテン拡張の合成済み文字（ń 等）は分解して結合文字を落とす（かなの濁点は分解しない）
    .replace(/[\u00c0-\u024f\u1e00-\u1eff]/g, (c) => c.normalize("NFD").replace(/\p{M}/gu, ""))
    // 制御文字は除去（空白類は空白に）
    .replace(/\p{Cc}/gu, (c) => (/\s/.test(c) ? " " : ""));
  return toKata(base).replace(/[^\u0000-\u007f]/g, (c) => HOMOGLYPH[c] ?? c);
}

const strip = (b: string) => b.replace(/ー/g, "").replace(/[\s\p{P}\p{S}\p{Z}]+/gu, "");
// leet 変種: 「1」は i / l の両方に読めるため 2 通り、「|」は l として展開する
const leetOf = (b: string, one: string) => b.replace(/[013457@$!|]/g, (c) => (c === "1" ? one : c === "|" ? "l" : (LEET[c] ?? c)));

const SENT_SPLIT = /(?<=[。.!?！？\n])/;
// 節・語の区切り（句読点・空白・括弧）。否定表現の除去はこの区切りをまたがない
const PIECE_SPLIT = /[\s\u3000。、，,.．!?！？;；:：「」『』（）()\[\]【】〔〕<>＜＞"'“”‘’/\\]+/;
const QUESTION_END = new RegExp(`(${toKata("か|かな|でしょうか|ですか|ますか|ましたか")})[。.\\s]*$|[?？]\\s*$`);

function normalize(s: string): Norm {
  const raw = cleanRaw(s);
  const base = toBase(raw);
  const compact = strip(base);
  const spaced = base.replace(/\s+/g, " ").trim();
  const sentences: Sentence[] = raw
    .split(SENT_SPLIT)
    .map((x) => toBase(x))
    .filter((x) => x.trim().length > 0)
    .map((x) => ({ question: QUESTION_END.test(x.trim()), pieces: x.split(PIECE_SPLIT).filter(Boolean) }));
  return { raw, spaced, compacts: [...new Set([compact, strip(leetOf(base, "i")), strip(leetOf(base, "l"))])], sentences };
}

// パターンは「平仮名・長音を含む自然な表記」で書き、構築時に正規化後の形（片仮名・長音なし）へ揃える。
const pats = (...srcs: string[]): RegExp[] => srcs.map((x) => new RegExp(toKata(x).replace(/ー/g, "")));
const anyRe = (t: string, res: RegExp[]) => res.some((r) => r.test(t));
const hasC = (n: Norm, res: RegExp[]) => n.compacts.some((c) => anyRe(c, res));
const bothC = (n: Norm, a: RegExp[], b: RegExp[]) => n.compacts.some((c) => anyRe(c, a) && anyRe(c, b));

// ---- 語彙 ------------------------------------------------------------------

// 共通の操作動詞（危険対象語と共起したら BLOCK）
const OP = pats(
  "変更|変え|設定|せってい|調整|ちょうせい|触|さわ|操作|制御|リセット|照射|しょうしゃ|入れ直|いれなお|落と|上げ|あげ|下げ|さげ|増や|減ら|書換|書き換|倍|にして|最大|最小|切替|切り替|にしたい|にする|にしろ|にせよ|にセット|に上げ|に下げ|に増や|に合わせ",
  "set|adjust|raise|lower|reduce|increase|decrease|change|modify|reset|touch|operate|control|fire|expose|irradiat|trigger|enable|disable|override",
);
// 依頼表現（読取系でなければ未知の操作要求として BLOCK）
// 「〜している/していた」（状態の記述）は依頼ではないため除外する
const REQ_JP = pats("てくれ|ください|下さい|たい|てほし|ほしい|せよ|しろ|お願い|おねがい|やって|頼|请|帮我|麻烦|해줘|해주세요|하세요");
// 「して」は節末（直後が文末・文末記号・語尾の ね/よ）のときだけ依頼とみなす。接続助詞の「作動して〜」「点灯していて〜」は除外（R3 N-R2-06）
const REQ_SHITE = new RegExp(toKata("して") + "(?=\\s*$|\\s*[。.!?！？]|[ねよ]\\s*($|[。.!?！？]))");
const REQ_EN = [/\b(please|pls|help me|can you|could you|would you|lets?)\b/];
const READONLY_JP = pats("確認|かくにん|表示|ひょうじ|教え|おしえ|説明|せつめい|状態|じょうたい|見て|みて|見せ|とは|なぜ|どうして|理由|意味|履歴");
const READONLY_EN = [/\b(check|show|explain|what|why|status|display|meaning|history|where)\b/];
const requestFallback = (n: Norm) =>
  (hasC(n, REQ_JP) || REQ_SHITE.test(n.spaced) || anyRe(n.spaced, REQ_EN)) && !(hasC(n, READONLY_JP) || anyRe(n.spaced, READONLY_EN));

const HV_A = pats("高電圧|こうでんあつ|高圧|こうあつ|highvoltage|hvタンク|hvtank|タンク|ハイボルテージ|活線|かっせん|ライブ(?!ラリ)|livewire|livepart|htcable|htケーブル|高圧ケーブル|hvcable|energized|通電中");
const HV_B = pats(
  "removal|取り外|取外|開け|あけ|開放|開い|ひら|外し|外す|はず|カバー|活線|かっせん|live|open|cover|remove|作業|さぎょう|中を|分解|ぶんかい|修理|測定|そくてい|点検|てんけん|抜|抵抗を測|抵抗測定|probe|access|measure|inspect",
);

// インターロック系: 強い対象語（動作語・依頼表現でも BLOCK）と弱い対象語（無効化語との共起のみ BLOCK）
const ILK_STRONG = pats(
  "インターロック|インタロッ|インタロク|interlock|interlok|interock|interlck|intrlock|inerlock|nterlock|iterlock|ドアセンサ|ドアセンサー|ロック機構|安全スイッチ|安全回路|安全装置|ドアロック|ドアスイッチ|安全ロック|safety(lock|switch|circuit|device)|联锁|聯鎖|聯锁|联鎖|인터락",
);
const ILK_WEAK = pats("連動|扉|安全機構|doorswitch|doorlockcircuit|ドアが開");
const DEFEAT = pats(
  "off(?![a-z])|効かな|きかな|抜く|抜い|抜き|抜け|ぬく|貼|切りたい|切りたく|切れ|だま|fool|trick|mute|false|塞|ふさ|迂回|うかい|スキップ|skip|ignore|キャンセル|cancel|without|入れず|入れずに|殺|disarm|bỏ qua|無効|むこう|解除|かいじょ|バイパス|bypass|disable|override|外し|外す|はず|ジャンパ|jumper|短絡|ショート|short|回避|切って|切る|切断|オフ|turnoff|defeat|circumvent|停止|止め|绕过|绕开|绕行|해제|무효|우회|关闭|無視|むし|なしで|無しで|なしに|なしの|常時閉|alwaysclosed|alwaysclose|tie|貼っ|貼り|磁石|bridge|ブリッジ",
);

const DOSE_STRONG = pats("線量|せんりょう|電流値|電圧値|管電流|管電圧|かんでんりゅう|かんでんあつ|dose|tubecurrent|tubevoltage");
const DOSE_WEAK = pats("出力|kvp|x線管|xtube|xraytube|線質");
const DOSE_B = pats("変更|変え|上げ|下げ|増や|減ら|書き換|書換|出し|override|change|modify|increase|decrease|\\d(kv|ma|mas)に");

const XRAY_A = pats("x線|xray|レントゲン");
const XRAY_B = pats("出して|出せ|出す|出力して|出力せよ|出力する|出力させ|撃|発射|はっしゃ|飛ばし|曝射|ばくしゃ|照射して|照射する|照射せ|発生させ|expose|irradiate|fire|emit");

const BAKUSHA_EXEC = pats("(曝射|ばくしゃ)(して|さ|でき|し(?!て?い)|を行|する|せよ|しろ)");

const REMOTE_A = pats(
  "遠隔|えんかく|リモート|remote|ネットワーク経由|ネット経由|vpn|ssh|rdp|vnc|teamviewer|anydesk|ngrok|外部から|远程|遠程|원격",
);
const REMOTE_B = pats(
  "入って|入る|入り込|入りたい|接続して|接続しろ|接続しよう|つないで|繋いで|繋げて|電源|でんげん|起動|再起動|サイクル|シャットダウン|停止|ブレーカ|x線|xray|曝射|ばくしゃ|ログイン|login|コンソール|reset|reboot|restart|cycle|shutdown|power|start|重启|재시작",
);

const REPLACE = pats(
  "交換|こうかん|取り替|取替|入れ替|いれかえ|換装|(?<!切|切り)換え|差し替|差替|載せ替|載せかえ|のせ替|付け替|付替|取換|取り換|取りかえ|とりかえ|リプレース|リプレイス|置換|スワップ|replac|swap|substitut|更换|更換|교체|리플레이스",
);
const PERFORMED = pats(
  "実施|じっし|済|ずみ|完了|かんりょう|確定|かくてい|登録|とうろく|記録|きろく|した(?!い)|ました|行った|行いました|行い|おこなった|完遂|遂行|complete|交換ok|交換はok|てある|替えた|換えた|し終|終え|終わ|にした|ことにし|ことに|done|completed|performed|register|markas|finish|did|record|log|swapped|replaced|changed|installed|了|登记|登記|完成|완료|했",
);

// 否定・未了・予定の言い回し（これ自体は実施確定ではない）。PERFORMED 判定の前に除去する。肯定語が残る限り BLOCK は維持される。
const NEGATED = pats(
  "未(実施|確定|完了|登録|記録|交換)|(実施|完了|確定|登録|記録|交換)(していない|していません|してない|してません|されていない|されてない|できていない|ない|ません)|(実施|完了|確定|登録|記録|交換)(予定|前|待ち)",
);
// R5 AUTH-Q（Human 承認済み）: R4 の質問文免除（文末が か / ？の文は実施確定とみなさない）は撤回した。
// 実施済み肯定表現は、質問形式でも SG-AUTH-01 で BLOCK する（誤拒否の増加は受容済みの帰結。別集計）。
// 否定・予定・質問の判定は「文」の内側かつ「節（句読点・空白で区切られた片）」の内側だけで行う。
// 句読点をまたいだ連結で肯定語が消えない（N-R3-01）。除去後の各片は連結して REPLACE/PERFORMED を全体で判定する。
function authHit(n: Norm): boolean {
  for (const variant of [(b: string) => b, (b: string) => leetOf(b, "i"), (b: string) => leetOf(b, "l")]) {
    // REPLACE と PERFORMED は全文から探す（質問形式でも免除しない。AUTH-Q）。否定・予定の除去は節の内側だけで行う。
    const allText: string[] = [];
    for (const sent of n.sentences) {
      const text = sent.pieces.map((p) => scrubNegated(strip(variant(p)))).join("");
      allText.push(text);
    }
    if (anyRe(allText.join(""), REPLACE) && anyRe(allText.join(""), PERFORMED)) return true;
  }
  return false;
}
const scrubNegated = (c: string) => NEGATED.reduce((acc, r) => acc.replace(new RegExp(r.source, "g"), ""), c);

const PATIENT = pats("患者|かんじゃ|patient|カルテ|診察券|被験者|利用者|顧客|お客様");
const PII = pats(
  "氏名|しめい|名前|なまえ|実名|本名|name|番号|ばんごう|住所|じゅうしょ|生年月日|dob|mrn|電話|でんわ|メール|email|マイナンバー|保険証|id(?![a-z])",
);
const PII_STRONG = pats("氏名|しめい|住所|じゅうしょ|生年月日|電話番号|マイナンバー|mrn|dob|カルテ番号|診察券番号|保険証");
const STORE = pats(
  "保存|ほぞん|記録|きろく|登録|とうろく|取り込|とりこ|入力|にゅうりょく|追加|ついか|save|store|import|record|add|ケースに|書き込|upload|送信|共有|貼り付|ペースト",
);
const NUMID = pats("(カルテ|診察券|mrn|患者id|patientid|患者番号|保険者番号|被保険者番号|保険証番号|被保険者)[a-z]{0,4}\\d{3,}");
const NAME_AFTER_PATIENT = /(患者|かんじゃ)[\s　]*[一-龥ァ-ヶぁ-ん]{2,5}(さん|様|氏|ちゃん|くん|君)/;
const ENG_PATIENT_NAME = /patient\s+[A-Z][a-z]+\s+[A-Z][a-z]+/;
const SECRETS = [
  /sk-ant-[a-z0-9_-]{10,}/,
  /ghp_[a-z0-9]{20,}/,
  /github_pat_/,
  /akia[0-9a-z]{16}/,
  /begin[a-z ]*private key/,
  /xox[baprs]-/,
  /(password|passwd|パスワード|apikey|api_key|api-key|secret|token)\s*[:=]/,
  // 記号が無い言い方（パスワードは hunter2 です / password is xxxx）（R4-04）。説明語が続く場合は除く
  /(?:パスワード|パスワ-ド|password|passwd|暗証番号)\s?(?:ハ|ガ|is)\s?(?!required|incorrect|invalid|wrong|expired|empty|set|reset|not|too)[a-z0-9!@#$%^&*_-]{5,}/,
];
// 個人情報の形式検出（N-01b）。氏名・連絡先・住所・年齢は患者語・保存語が無くても拒否する（FP 許容）。
// R4-03: 量指定子に上限を付ける（二乗時間の探索を避ける）。"@" を含まない入力では走査しない。
const EMAIL = /[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,255}\.[a-z]{2,}/;
// 難読化メール（R4-04）: name [at] example.com / name (at) example (dot) com / name＠…
const EMAIL_OBF = /[a-z0-9._%+-]{1,64}\s?[[({<]\s?(?:at|アット)\s?[\])}>]\s?[a-z0-9-]{1,63}(?:\s?[[({<]?\s?(?:dot|ドット|\.)\s?[\])}>]?\s?[a-z0-9-]{1,63}){1,3}/;
const hasEmail = (spaced: string, raw: string) => (spaced.includes("@") && EMAIL.test(spaced)) || EMAIL_OBF.test(spaced) || EMAIL_OBF.test(raw.toLowerCase());
const PHONE = [
  /(?<!\d)0\d{1,4}[\s.\-‐]\d{1,4}[\s.\-‐]\d{3,4}(?!\d)/, // 区切りは ハイフン・空白・ドット（R3）
  /(?<!\d)0[1-9]\d{8,9}(?!\d)/,
  /\+81[\d\s-]{9,}/,
  /\(0\d{1,4}\)\s?\d{1,4}[\s.\-‐]\d{3,4}(?!\d)/, // (090)1234-5678（R4-04）
  /(?:[〇零一二三四五六七八九][\s\-ー−]?){10,11}/, // 漢数字の電話番号（R3）
];
const CARD16 = /(?<!\d)(?:\d[ \-]?){15}\d(?!\d)/;
// 12 桁の個人番号（連続または 4-4-4 区切り）（R4-04）
const NUM12 = /(?<!\d)\d{12}(?!\d)|(?<!\d)\d{4}[\s-]\d{4}[\s-]\d{4}(?!\d)/;
// 生年月日（R3）: 日付表記と「生年月日・生まれ・誕生日・DOB」の共起
const DATE_LIKE = /(?<!\d)(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?!\d)|(?<!\d)\d{2}\s?[/.\-]\s?\d{1,2}\s?[/.\-]\s?\d{1,2}(?!\d)|(?<!\d)(?:19|20)\d{2}\s?[/.\-年]\s?\d{1,2}\s?[/.\-月]\s?\d{1,2}|(?:昭和|平成|令和|大正)\s?\d{1,2}年\s?\d{1,2}月/;
const BIRTH_WORD = /生年月日|生まれ|誕生日|\bdob\b|birth|\bborn\b|\d日生/;
// 住所（R3）: 都道府県＋市区町村 / 市区＋町名＋居住語
const ADDRESS_PREF = /(東京都|北海道|(?:京都|大阪)府|[一-龥]{2,3}県)[一-龥ぁ-んァ-ヶー]{1,8}(市|区|町|村|郡)/;
const ADDRESS_LOCAL = /[一-龥]{1,4}(市|区)[一-龥ぁ-んァ-ヶ]{1,6}(丁目|番地|在住|の自宅|自宅|住まい|住んで|\d)/;
const POSTAL = /(?<!\d)\d{3}-\d{4}(?!\d)|〒/;
const ADDRESS = /(都|道|府|県)[^\s]{0,12}(市|区|町|村)[^\s]{0,15}\d/;
const AGE = /\d{1,3}\s?(?:歳|才)|\bage\s?[:=]?\s?\d{1,3}\b|\d{1,3}\s?(?:years?\s?old|yo|y\/o)\b/;
const SSN = /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/;
// 患者のイニシャル（患者T.H. / patient T.H.）（R4-04）
const INITIALS = /(?:患者|patient|pt)\.?\s?[A-Z]\.\s?[A-Z]\.?/;
// 役割ラベル直後の人名らしい漢字 2〜4 字（報告者は寺島健です 等）。ヒューリスティックであり未知の氏名の完全な検出ではない。
const NON_NAME_AFTER_LABEL = ["不在", "不明", "未定", "現場", "本人", "交換", "確認", "調査", "対応", "待機", "同行", "別途", "上級", "担当", "施設", "病院", "技術", "保守", "メーカー", "当社", "弊社", "自分", "私"];
const LABELED_PERSON_RE = /(?:報告者|担当者|連絡者|依頼者|対応者|立会者|来院者|記入者|入力者|ユーザー)\s?(?:は|が|：|:|=)\s?([一-龥]{2,4})(?:です|だ|さん|。|、|$|が|と|から)/;
const LABELED_PERSON = { test: (raw: string): boolean => { const m = raw.match(LABELED_PERSON_RE); return !!m && !NON_NAME_AFTER_LABEL.some((w) => m[1].startsWith(w) || m[1] === w); } };
const LABELED_NAME = /\bname\s*[:=]\s*\S+/;
const GENERIC_HONORIFIC_BASES = ["担当者", "管理者", "利用者", "関係者", "責任者", "担当", "各位", "お客", "医師", "技師", "看護師", "技術者", "作業者", "運用者", "保守", "責任", "管理", "関係", "皆", "貴", "ユーザ"];
// 氏名の最大限の検出（R3）。網羅は不能（既知の限界）: よくある姓＋名、かな姓＋かな名、ローマ字の姓名、敬称付きを検出する。
const SURNAME_KANJI = "佐藤|鈴木|高橋|田中|伊藤|渡辺|山本|中村|小林|加藤|吉田|山田|佐々木|山口|松本|井上|木村|斎藤|斉藤|清水|山崎|池田|橋本|阿部|石川|山下|中島|石井|小川|前田|岡田|長谷川|藤田|後藤|近藤|村上|遠藤|青木|坂本|福田|太田|西村|藤井|金子|岡本|藤原|三浦|中野|原田|松田|竹内|小野|田村|中山|和田|石田|上田|森田|柴田|酒井|工藤|横山|宮崎|宮本|内田|高木|安藤|谷口|大野|丸山|今井|河野|藤本|村田|武田|上野|杉山|増田|平野|大塚|千葉|久保|松井|小島|岩崎|桜井|野口|松尾|菅原|木下|野村|新井";
const GIVEN_KANJI = "太郎|次郎|二郎|三郎|一郎|健太|翔太|大輔|拓也|直樹|花子|美咲|陽子|恵子|裕子|由美|智子|久美子|真理|結衣|大樹|健一|健二|誠|学|剛|優|蓮|颯|翼|愛|葵";
const NAME_KANJI = new RegExp(`(${SURNAME_KANJI})(${GIVEN_KANJI})`);
const SURNAME_KANA = toKata("やまだ|たなか|すずき|さとう|たかはし|いとう|わたなべ|なかむら|こばやし|かとう|よしだ|やまもと|ささき|やまぐち|まつもと|いのうえ|きむら|さいとう|しみず|はやし");
const GIVEN_KANA = toKata("たろう|はなこ|いちろう|じろう|けんた|ゆうた|だいすけ|たくや|なおき|ようこ|けいこ|ゆみ|ともこ|さくら|みさき|あおい|ひなた|けんじ|まこと|あきら");
const NAME_KANA = new RegExp(`(${SURNAME_KANA})(${GIVEN_KANA})`);
const NAME_TOKENS_EN = new Set(
  "yamada tanaka suzuki sato takahashi ito watanabe nakamura kobayashi kato yoshida yamamoto sasaki yamaguchi matsumoto inoue kimura hayashi saito shimizu taro hanako ichiro jiro kenta yuta daisuke takuya naoki yoko keiko yumi tomoko sakura misaki smith johnson williams brown jones miller davis john mary james robert michael david".split(" "),
);
function hasRomajiName(raw: string): boolean {
  if (/\b(Mr|Mrs|Ms|Dr)\.?\s+[A-Z][a-z]+/.test(raw) || /\b[A-Za-z]+-(san|sama|kun|chan)\b/i.test(raw)) return true;
  for (const m of raw.matchAll(/([A-Za-z]{2,15})[\s　]+([A-Za-z]{2,15})/g)) {
    const [a, b] = [m[1], m[2]];
    const ia = NAME_TOKENS_EN.has(a.toLowerCase());
    const ib = NAME_TOKENS_EN.has(b.toLowerCase());
    const capA = /^[A-Z]/.test(a);
    const capB = /^[A-Z]/.test(b);
    if (ia && ib) return true;
    if ((ia && capA && capB) || (ib && capA && capB)) return true;
  }
  return false;
}
function hasPersonalName(raw: string): boolean {
  if (NAME_KANJI.test(raw) || NAME_KANA.test(toKata(raw)) || hasRomajiName(raw)) return true;
  for (const m of raw.matchAll(/([一-龥]{2,4})(さん|様|氏|先生|殿|くん|君|ちゃん)/g)) {
    const base = m[1];
    if (!GENERIC_HONORIFIC_BASES.some((g) => base === g || base.endsWith(g))) return true;
  }
  return false;
}

type Rule = {
  rule_id: RuleId;
  escalate_to: string;
  reason: string;
  hit: (n: Norm, ctx: { role: string | null; input: GateInput }) => boolean;
};

// 評価順は §6.1 のテーブル順（first_match_blocks）。
export const RULES: Rule[] = [
  {
    rule_id: "SG-HV-01",
    escalate_to: "L3以上の有資格者",
    reason: "高電圧部作業は資格・手順・LOTO前提。AIは実行指示できない。",
    hit: (n) => {
      const act = hasC(n, HV_B) || hasC(n, OP) || requestFallback(n);
      if (hasC(n, HV_A) && act) return true;
      // 単独の略語 hv は単語境界が必要なため空白を残した形で判定
      return /\bhv\b/.test(n.spaced) && act;
    },
  },
  {
    rule_id: "SG-ILK-01",
    escalate_to: "施設安全担当 / 上級SE",
    reason: "インターロック無効化は重大安全リスク。",
    hit: (n) => (hasC(n, ILK_STRONG) && (hasC(n, DEFEAT) || hasC(n, OP) || requestFallback(n))) || bothC(n, ILK_WEAK, DEFEAT),
  },
  {
    rule_id: "SG-DOSE-01",
    escalate_to: "上級SE",
    reason: "線量・X線出力関連の本番変更は権限と手順が必要。",
    hit: (n) => {
      // mA/mAs/kV は数値付き・単語境界で判定
      const abbrev = /\bmas?\b/.test(n.spaced) || /\d\s?(kv|ma|mas)\b/.test(n.spaced) || /\bkv\b/.test(n.spaced);
      const strong = hasC(n, DOSE_STRONG);
      const weak = hasC(n, DOSE_WEAK) || abbrev;
      if (strong && (hasC(n, DOSE_B) || hasC(n, OP) || requestFallback(n))) return true;
      if (weak && (hasC(n, DOSE_B) || hasC(n, OP))) return true;
      if (bothC(n, XRAY_A, XRAY_B)) return true;
      // 「X線」の語が無い曝射の実行・可能化（例: ばくしゃしてください / 曝射できるようにしたい）。読取・説明の質問は除く
      return hasC(n, BAKUSHA_EXEC) && !(hasC(n, READONLY_JP) || anyRe(n.spaced, READONLY_EN));
    },
  },
  {
    rule_id: "SG-REMOTE-01",
    escalate_to: "現場担当者",
    reason: "大会版・設計上、遠隔制御は行わない。",
    hit: (n) => hasC(n, REMOTE_A) && (hasC(n, REMOTE_B) || hasC(n, OP) || requestFallback(n)),
  },
  {
    rule_id: "SG-AUTH-01",
    escalate_to: "上級SE",
    reason: "新人ロールでは部品交換の実施確定を許可しない。",
    // 仕様上のロールは junior_fse のみ。許可ロール（PRIVILEGED_ROLE_KEYS）以外・未指定・不明は fail-safe で新人扱い。
    hit: (n, { role }) => {
      const key = role === null ? null : role.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
      const privileged = key !== null && PRIVILEGED_ROLE_KEYS.includes(key);
      if (privileged) return false;
      return authHit(n);
    },
  },
  {
    rule_id: "SG-DATA-01",
    escalate_to: "Human Gate",
    reason: "患者・実個人データ・機密情報の保存要求は拒否。",
    hit: (n, { input }) => {
      if (n.compacts.some((c) => anyRe(c, SECRETS)) || anyRe(n.spaced, SECRETS)) return true;
      if (input.scope === "identifier") {
        return (
          hasEmail(n.spaced, n.raw) ||
          CARD16.test(n.raw) ||
          NUM12.test(n.raw) ||
          (n.raw.toLowerCase().match(/[a-z]+/g) ?? []).some((w) => NAME_TOKENS_EN.has(w))
        );
      }
      if (anyRe(n.compacts[0], NUMID)) return true;
      if (NAME_AFTER_PATIENT.test(n.raw) || ENG_PATIENT_NAME.test(n.raw)) return true;
      if (hasEmail(n.spaced, n.raw) || PHONE.some((r) => r.test(n.raw)) || POSTAL.test(n.raw) || ADDRESS.test(n.raw)) return true;
      if (AGE.test(n.raw) || SSN.test(n.raw) || LABELED_NAME.test(n.spaced) || hasPersonalName(n.raw)) return true;
      if (CARD16.test(n.raw) || NUM12.test(n.raw) || INITIALS.test(n.raw) || LABELED_PERSON.test(n.raw) || ADDRESS_PREF.test(n.raw) || ADDRESS_LOCAL.test(n.raw)) return true;
      if (DATE_LIKE.test(n.raw) && BIRTH_WORD.test(n.raw.toLowerCase())) return true;
      if (hasC(n, PATIENT) && (hasC(n, PII) || hasC(n, STORE))) return true;
      return hasC(n, PII_STRONG) && hasC(n, STORE);
    },
  },
  {
    rule_id: "SG-MISS-01",
    escalate_to: "測定実施後に再評価",
    reason: "必須測定欠落時の原因確定を禁止。",
    hit: (_n, { input }) => {
      const m = input.missing_measurements;
      // 欠落なしと明示できるのは undefined / null / false / 空配列のみ。それ以外（文字列・数値・オブジェクト等）は欠落ありとみなす（fail-closed）
      const noMissing = m === undefined || m === null || m === false || (Array.isArray(m) && m.length === 0);
      // root_cause_confirmed が false 以外（文字列 "true" 等の型不正を含む）は確定要求とみなす
      const confirmedRequested = input.root_cause_confirmed !== undefined && input.root_cause_confirmed !== false;
      return confirmedRequested && !noMissing;
    },
  },
];

function allowed(): GateDecision {
  return { blocked: false, rule_id: null, escalate_to: null, reason: null, matched_rules: [] };
}

function blockedBy(rule_id: RuleId, reason: string, cause_detail: CauseDetail, truncated = false): GateDecision {
  return { blocked: true, rule_id, escalate_to: "Human Gate", reason, matched_rules: [rule_id], cause_detail, truncated };
}

export type EvaluateOptions = { only?: RuleId[] };

// 履歴連結窓: 直近 MAX_HISTORY_TURNS 発話のうち、現在発話と合わせて MAX_TEXT_CHARS 以内に収まる分（古い方から切り落とす）。
// 窓外の古い発話は評価対象にならない（設計上の上限。Guardian 確認事項）。型不正は null（呼び出し側で fail-closed）。
export function buildHistoryWindow(history: unknown, current: string): string[] | null {
  if (history === undefined) return [];
  if (!Array.isArray(history) || history.length > 1000) return null;
  if (history.some((h) => typeof h !== "string" || h.length > MAX_TEXT_CHARS)) return null;
  const win = (history as string[]).slice(-MAX_HISTORY_TURNS);
  let total = current.length + win.reduce((a, h) => a + h.length, 0);
  while (win.length > 0 && total > MAX_TEXT_CHARS) total -= win.shift()!.length;
  return win;
}

function* evaluateSteps(input: GateInput, opts: EvaluateOptions): Generator<void, GateDecision, void> {
  // 型・サイズ検査（判定不能は fail-closed）。text は文字列のみ受け付ける。
  if (input.text !== undefined && typeof input.text !== "string") {
    return blockedBy("SG-INPUT-01", "text は文字列のみ。型不正で判定不能な入力は拒否（fail-closed）。", "undecidable_size");
  }
  if (typeof input.text === "string" && input.text.length > MAX_TEXT_CHARS) {
    return blockedBy("SG-INPUT-01", `入力が上限（${MAX_TEXT_CHARS} 文字）を超え判定不能のため拒否（fail-closed）。`, "undecidable_size");
  }

  // §6.2 許可アクション列挙（opts.only 指定時＝保存経路での限定走査では適用しない）
  if (!opts.only && input.action !== undefined) {
    if (typeof input.action !== "string" || !(ALLOWED_ACTIONS as readonly string[]).includes(input.action)) {
      return blockedBy("SG-ENUM-01", "許可アクション列挙外の要求は拒否（§6.2）。", "invalid_action");
    }
  }

  const text = typeof input.text === "string" ? input.text : "";
  const role = typeof input.role === "string" && input.role.trim() ? input.role.trim() : null;

  const win = buildHistoryWindow(input.history, text);
  if (win === null) {
    return blockedBy("SG-INPUT-01", "history は文字列配列のみ（件数・長さ上限あり）。型不正・過大で判定不能な入力は拒否（fail-closed）。", "undecidable_size");
  }

  // 評価対象: 現在発話 / 履歴＋現在（改行連結）/ 履歴＋現在（無区切り連結。分割語の結合対策）
  const bases = win.length > 0 ? [text, [...win, text].join("\n"), [...win, text].join("")] : [text];
  const targets: string[] = [];
  // R5: 件数基準の切捨て（INV-9）と未知の文字（H-1）。具体ルールに当たらなかった場合にだけ判定不能として扱う。
  let truncated = false;
  let unknownSeen = false;
  for (const b of bases) {
    const ex = expandEncodings(b);
    if (ex.failed) return blockedBy("SG-INPUT-01", `エンコードが曖昧・不正で判定不能のため拒否（fail-closed）: ${ex.failed}`, "undecidable_decode", ex.truncated);
    targets.push(...ex.texts);
    if (ex.truncated) truncated = true;
    if (ex.unknownSeen) unknownSeen = true;
    yield;
  }
  if (targets.length > MAX_EVAL_TEXTS) return blockedBy("SG-INPUT-01", "展開後の評価対象が上限を超え判定不能のため拒否（fail-closed）。", "undecidable_decode", truncated);

  const hits: Rule[] = [];
  for (const t of new Set(targets)) {
    // R5 H-1: 未知の文字を除去した形で照合する（除去の有無でルール判定を回避させない）
    const n = normalize(scrubUnknown(t));
    for (const rule of RULES) {
      if (opts.only && !opts.only.includes(rule.rule_id)) continue;
      if (!hits.includes(rule) && rule.hit(n, { role, input })) hits.push(rule);
    }
    yield;
  }
  if (hits.length === 0) {
    // 具体ルールに当たらない場合のみ、判定不能（fail-closed）。切捨て（γ 案）を未知の文字より先に記録する。
    if (truncated) return blockedBy("SG-INPUT-01", "展開の候補が上限を超えて切り捨てられ、未評価の候補が残るため判定不能（fail-closed）。", "undecidable_truncation", true);
    if (unknownSeen) return blockedBy("SG-INPUT-01", "未知の文字（未割当・私用領域・非文字など）を含み判定不能（fail-closed）。", "undecidable_decode");
    return allowed();
  }
  hits.sort((a, b) => RULES.indexOf(a) - RULES.indexOf(b));
  const first = hits[0];
  return {
    blocked: true,
    rule_id: first.rule_id,
    escalate_to: first.escalate_to,
    reason: first.reason,
    matched_rules: hits.map((h) => h.rule_id),
    cause_detail: "rule_hit",
    truncated,
  };
}

// 同期版（テスト・単発用）。ルート（HTTP）は evaluateAsync を使い、イベントループを占有しない。
export function evaluate(input: GateInput, opts: EvaluateOptions = {}): GateDecision {
  const g = evaluateSteps(input, opts);
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
}

// R4-03: 非同期版。評価を小さな単位に分け、10ms を超えたらイベントループへ制御を返す（/health 等の他リクエストを長く止めない）。
// 同時評価数は MAX_CONCURRENT_EVALS、待機列は MAX_QUEUED_EVALS まで。超過は判定不能として fail-closed（SG-INPUT-01）。
const MAX_CONCURRENT_EVALS = 2;
const MAX_QUEUED_EVALS = 64;
let activeEvals = 0;
const waiters: (() => void)[] = [];
const tick = () => new Promise<void>((r) => setImmediate(r));

export async function evaluateAsync(input: GateInput, opts: EvaluateOptions = {}): Promise<GateDecision> {
  if (activeEvals >= MAX_CONCURRENT_EVALS) {
    if (waiters.length >= MAX_QUEUED_EVALS) return blockedBy("SG-INPUT-01", "評価の待機列が上限を超え判定不能のため拒否（fail-closed。過負荷）。", "overload");
    await new Promise<void>((resolve) => waiters.push(resolve));
  } else {
    activeEvals++;
  }
  try {
    const g = evaluateSteps(input, opts);
    let sliceStart = Date.now();
    let r = g.next();
    while (!r.done) {
      if (Date.now() - sliceStart > 10) {
        await tick();
        sliceStart = Date.now();
      }
      r = g.next();
    }
    return r.value;
  } finally {
    const next = waiters.shift();
    if (next) next(); // 枠を待機側へ引き継ぐ（activeEvals は据え置き）
    else activeEvals--;
  }
}
