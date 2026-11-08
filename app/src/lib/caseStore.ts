// TP-01 Case Store（OD-01: JSON file store）
// 仕様: preparation/03_ARCHITECTURE.md §4.2 Case Schema / 02_REQUIREMENTS.md FR-P0-01
// 保存先: ESN_DATA_DIR（未設定時は ../runtime/data）。実データは扱わない（架空データ専用）。
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import devicesFixture from "@/data/devices.json";
import { ALLOWED_REPORTER_ROLES } from "@/lib/roles";

export type DeviceConfirmationStatus = "unconfirmed" | "needs_human_selection" | "confirmed";
export type CaseStatus = "open" | "blocked" | "waiting_info" | "handoff_ready" | "closed";
export type ClaudeSessionState = "idle" | "pending" | "failed" | "resumed";
// R5 L5: 保存の成否の区分。stored=永続化(rename)完了後、not_stored=確実に保存していない、unknown=保存の有無を断定できない。
export type StoreState = "stored" | "not_stored" | "unknown";

// TP-02: 直近の装置検索で提示した候補（確定の対象はこの中からのみ）
export type DeviceCandidate = {
  device_id: string;
  model: string;
  serial: string;
  room: string;
  install_year: number;
  modality: string;
  score: number;
  reasons: string[];
};

// TP-02: Human による明示選択イベント（FR-P0-02）
export type DeviceConfirmation = {
  device_id: string;
  confirmed_by_role: string;
  // P0 最小構成（G-08）: クライアントの自己申告であり認証されていない。Human 操作の証拠として扱わない。
  source: "client_asserted_human_selection";
  verified: false;
  confirmed_at: string;
};

export type CaseRecord = {
  case_id: string;
  dp_number: string;
  site_id: string;
  reporter_role: string;
  device_id: string | null;
  device_confirmation_status: DeviceConfirmationStatus;
  device_candidates: DeviceCandidate[];
  device_confirmation: DeviceConfirmation | null;
  symptom_text: string;
  error_code: string | null;
  observed_at: string | null;
  confirmed_facts: string[];
  hypotheses: string[];
  missing_info: string[];
  status: CaseStatus;
  claude_session_state: ClaudeSessionState;
  created_at: string;
  updated_at: string;
};

// R4-04: dp_number は「プロジェクト符号(許可リスト)-西暦(20xx)-連番4桁[-枝番 1〜2 桁 ×2 まで]」。
// 枝番を含めた西暦以降の数字は最大 8 桁で、電話番号（10 桁以上）・個人番号（12 桁）・カード番号（13 桁以上）を保存できない。
// 既存の正常値は fixtures の DP-FIC-2026-0001〜0006 のみ（互換性確認済み）。DESIGN CANDIDATE（Canonical ではない。Human 確定待ち）。
export const DP_PROJECT_CODES = ["FIC"] as const;
const DP_FORMAT = new RegExp(`^DP-(?:${DP_PROJECT_CODES.join("|")})-20\\d{2}-\\d{4}(?:-\\d{1,2}){0,2}$`);

// R4-04: site_id / device_id はサーバー側台帳（fixtures の devices）で照合する。台帳に無い値・別施設の装置は保存しない。
const KNOWN_SITES: ReadonlySet<string> = new Set(devicesFixture.devices.map((d) => d.site_id));
const isKnownDeviceAtSite = (deviceId: string, siteId: string) => devicesFixture.devices.some((d) => d.device_id === deviceId && d.site_id === siteId);

export const REQUIRED_FIELDS = ["dp_number", "site_id", "symptom_text", "reporter_role"] as const;

const MAX_LEN = 2000;


export type ValidationResult =
  | { ok: true; value: Pick<CaseRecord, "dp_number" | "site_id" | "symptom_text" | "reporter_role" | "device_id" | "error_code" | "observed_at"> }
  | { ok: false; missing: string[]; invalid: string[] };

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

// 必須欠落は保存せず、欠落フィールド一覧を返す（N-02）。
export function validateNewCase(input: unknown): ValidationResult {
  const obj = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const missing: string[] = [];
  const invalid: string[] = [];

  const required: Record<string, string | null> = {};
  for (const f of REQUIRED_FIELDS) {
    const v = str(obj[f]);
    required[f] = v;
    if (v === null) missing.push(f);
    else if (v.length > MAX_LEN) invalid.push(f);
  }

  const optional = (f: string): string | null => {
    const raw = obj[f];
    if (raw === undefined || raw === null || raw === "") return null;
    const v = str(raw);
    if (v === null || v.length > MAX_LEN) {
      invalid.push(f);
      return null;
    }
    return v;
  };
  const device_id = optional("device_id");
  const error_code = optional("error_code");
  const observed_at = optional("observed_at");

  // R3: dp_number の枝番は数字のみ（氏名・Base64 等の自由記述を識別子に混入させない。N-R2-01/08）。
  // 識別子系フィールドは形式検証（自由記述の混入・個人情報の保存経路を塞ぐ。G-05 / N-01b）
  // DESIGN CANDIDATE: 下記の形式は preparation/fixtures の例（DP-FIC-2026-0001, HVN-SITE-001, HVN-DEV-XR-001, E210）から
  // 導いた暫定の検証であり、Canonical 仕様ではない。実運用の ID 体系は未確認（要事実確認）。Human が確定するまで仕様化しない。
  const checkFmt = (f: string, v: string | null, re: RegExp) => {
    if (v !== null && !re.test(v) && !invalid.includes(f)) invalid.push(f);
  };
  checkFmt("dp_number", required.dp_number, DP_FORMAT);
  checkFmt("site_id", required.site_id, /^[A-Z]{2,6}-SITE-\d{3}$/);
  checkFmt("device_id", device_id, /^[A-Z]{2,6}-DEV-[A-Z]{1,4}-\d{3}$/);
  checkFmt("error_code", error_code, /^[A-Z]\d{3,4}$/);
  // 台帳照合（形式が正しい場合のみ。形式違反は上で invalid 済み）
  if (required.site_id !== null && !invalid.includes("site_id") && !KNOWN_SITES.has(required.site_id)) invalid.push("site_id");
  if (device_id !== null && !invalid.includes("device_id") && !invalid.includes("site_id") && required.site_id !== null && !isKnownDeviceAtSite(device_id, required.site_id)) invalid.push("device_id");
  if (required.reporter_role !== null && !ALLOWED_REPORTER_ROLES.includes(required.reporter_role) && !invalid.includes("reporter_role")) {
    invalid.push("reporter_role");
  }
  if (observed_at !== null) {
    const isoLike = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(observed_at);
    if ((!isoLike || Number.isNaN(Date.parse(observed_at))) && !invalid.includes("observed_at")) invalid.push("observed_at");
  }

  if (missing.length > 0 || invalid.length > 0) return { ok: false, missing, invalid };
  return {
    ok: true,
    value: {
      dp_number: required.dp_number!,
      site_id: required.site_id!,
      symptom_text: required.symptom_text!,
      reporter_role: required.reporter_role!,
      device_id,
      error_code,
      observed_at,
    },
  };
}

export type CreateResult =
  | { kind: "created"; record: CaseRecord }
  | { kind: "duplicate"; existing_case_id: string };

function dataDir(): string {
  return process.env.ESN_DATA_DIR ?? path.resolve(process.cwd(), "..", "runtime", "data");
}
const casesFile = () => path.join(dataDir(), "cases.json");

// TP-01 時点の保存行には TP-02 の項目が無いので既定値で補う
function normalize(c: CaseRecord): CaseRecord {
  return { ...c, device_candidates: c.device_candidates ?? [], device_confirmation: c.device_confirmation ?? null };
}

async function readAll(): Promise<CaseRecord[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(casesFile(), "utf8"));
    return Array.isArray(parsed) ? (parsed as CaseRecord[]).map(normalize) : [];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

// R5 L5: 保存の失敗を段階で区別する。before_commit=tmp への書込み段階（cases.json は旧状態のまま）、
// commit_unknown=rename の実行中・実行後（保存の有無を断定しない）。
export class StoreWriteError extends Error {
  readonly phase: "before_commit" | "commit_unknown";
  constructor(phase: "before_commit" | "commit_unknown", cause: unknown) {
    super(`STORE_WRITE_FAILED:${phase}`, { cause });
    this.phase = phase;
  }
}

// tmp に書いてから rename（クラッシュ時に半端なファイルを残さない）。失敗時は自分の tmp だけを削除する。
async function writeAll(records: CaseRecord[]): Promise<void> {
  const tmp = `${casesFile()}.${process.pid}.tmp`;
  try {
    await mkdir(dataDir(), { recursive: true });
    await writeFile(tmp, JSON.stringify(records, null, 2), "utf8");
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw new StoreWriteError("before_commit", e);
  }
  try {
    await rename(tmp, casesFile());
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw new StoreWriteError("commit_unknown", e);
  }
}

// 同一プロセス内の書き込みを直列化（重複DP競合を防ぐ）
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

export function createCase(v: Extract<ValidationResult, { ok: true }>["value"]): Promise<CreateResult> {
  return serialized(async () => {
    const all = await readAll();
    const dup = all.find((c) => c.dp_number === v.dp_number);
    if (dup) return { kind: "duplicate", existing_case_id: dup.case_id };
    const now = new Date().toISOString();
    const record: CaseRecord = {
      case_id: `CASE-${randomUUID()}`,
      dp_number: v.dp_number,
      site_id: v.site_id,
      reporter_role: v.reporter_role,
      device_id: v.device_id,
      // 装置は自動確定しない（TP-02 / Human 確定）
      device_confirmation_status: "unconfirmed",
      device_candidates: [],
      device_confirmation: null,
      symptom_text: v.symptom_text,
      error_code: v.error_code,
      observed_at: v.observed_at,
      confirmed_facts: [],
      hypotheses: [],
      missing_info: [],
      status: "open",
      claude_session_state: "idle",
      created_at: now,
      updated_at: now,
    };
    all.push(record);
    await writeAll(all);
    return { kind: "created", record };
  });
}

export async function getCase(caseId: string): Promise<CaseRecord | null> {
  return (await readAll()).find((c) => c.case_id === caseId) ?? null;
}

export async function listCases(): Promise<CaseRecord[]> {
  return readAll();
}

// ---- 実行時の強制条件（R4: AST 検査だけに依存しない。R5: H-3 の 5 層）------------------------------
// L1 状態隔離: fn には複製を渡し、比較の基準（pristine）は凍結した元を使う（fn が in-place で書き換えても基準は変わらない）。
// L2 不変条件: 形・不変フィールド・遷移。L3 台帳照合。L4 確定権限（confirmDevice 経由かつ候補内のみ）。L5 永続化（writeAll）。
const CONFIRM_SOURCE = "client_asserted_human_selection" as const;

// CaseRecord の既知キー（next のキー集合はこれと完全一致すること）
const CASE_KEYS = [
  "case_id", "dp_number", "site_id", "reporter_role", "device_id", "device_confirmation_status", "device_candidates", "device_confirmation",
  "symptom_text", "error_code", "observed_at", "confirmed_facts", "hypotheses", "missing_info", "status", "claude_session_state", "created_at", "updated_at",
] as const;
// 作成後は変更できないフィールド（updated_at はサーバーが付与）。device_id は確定時のみ（下記）。
const IMMUTABLE_KEYS = ["case_id", "dp_number", "site_id", "reporter_role", "created_at", "symptom_text", "error_code", "observed_at"] as const;
const DEVICE_STATUSES: readonly string[] = ["unconfirmed", "needs_human_selection", "confirmed"];
const CASE_STATUSES: readonly string[] = ["open", "blocked", "waiting_info", "handoff_ready", "closed"];
const SESSION_STATES: readonly string[] = ["idle", "pending", "failed", "resumed"];

function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

function assertShape(next: CaseRecord, fail: (m: string) => never): void {
  const keys = Object.keys(next);
  if (keys.length !== CASE_KEYS.length || !CASE_KEYS.every((k) => keys.includes(k))) fail("レコードのキー集合が CaseRecord と一致しない");
  const n = next as unknown as Record<string, unknown>;
  for (const k of ["case_id", "dp_number", "site_id", "reporter_role", "symptom_text", "created_at", "updated_at"]) if (!isStr(n[k])) fail(`型不正: ${k}`);
  for (const k of ["device_id", "error_code", "observed_at"]) if (!isStrOrNull(n[k])) fail(`型不正: ${k}`);
  for (const k of ["confirmed_facts", "hypotheses", "missing_info"]) if (!isStrArray(n[k])) fail(`型不正: ${k}`);
  if (!DEVICE_STATUSES.includes(next.device_confirmation_status)) fail("型不正: device_confirmation_status");
  if (!CASE_STATUSES.includes(next.status)) fail("型不正: status");
  if (!SESSION_STATES.includes(next.claude_session_state)) fail("型不正: claude_session_state");
  if (!Array.isArray(next.device_candidates) || next.device_candidates.some((c) => c === null || typeof c !== "object" || !isStr((c as { device_id: unknown }).device_id))) {
    fail("型不正: device_candidates");
  }
  const dc = next.device_confirmation as unknown;
  if (dc !== null && (typeof dc !== "object" || !isStr((dc as Record<string, unknown>).device_id) || !isStr((dc as Record<string, unknown>).confirmed_at))) fail("型不正: device_confirmation");
}

function assertInvariants(prev: CaseRecord, next: CaseRecord, allowConfirm: boolean): void {
  const fail = (m: string): never => {
    throw new Error(`CASE_INVARIANT_VIOLATION: ${m}`);
  };
  assertShape(next, fail);
  // L2 不変フィールド
  for (const k of IMMUTABLE_KEYS) if (next[k] !== prev[k]) fail(`不変フィールドの変更: ${k}`);
  // L3 台帳照合: 候補は、そのケースの施設の台帳にある装置のみ
  for (const c of next.device_candidates) {
    if (!isKnownDeviceAtSite(c.device_id, next.site_id)) fail("候補に台帳外または他施設の装置");
  }
  const dc = next.device_confirmation;
  if (dc !== null) {
    if (dc.verified !== false) fail("verified は false 固定");
    if (dc.source !== CONFIRM_SOURCE) fail("source は自己申告の固定値のみ");
    if (next.device_confirmation_status !== "confirmed" || next.device_id !== dc.device_id) fail("確定記録と状態・device_id の不整合");
    if (!ALLOWED_REPORTER_ROLES.includes(dc.confirmed_by_role)) fail("許可外ロール");
  } else if (next.device_confirmation_status === "confirmed") {
    fail("確定状態には確定記録が必要");
  }
  if (next.device_confirmation_status === "confirmed") {
    // L3 台帳照合: 確定する装置は、そのケースの施設の台帳にあること
    if (next.device_id === null || !isKnownDeviceAtSite(next.device_id, next.site_id)) fail("確定する装置が台帳外または他施設");
  }
  if (next.device_confirmation_status === "confirmed" && prev.device_confirmation_status !== "confirmed") {
    // L4 確定権限: confirmDevice の経路のみ。かつ、変更前に提示済みの候補の中からのみ
    if (!allowConfirm) fail("確定への遷移は confirmDevice（Human の明示選択の経路）のみ");
    if (!prev.device_candidates.some((c) => c.device_id === next.device_id)) fail("確定する装置が変更前の候補に含まれない");
  }
  if (next.device_confirmation_status !== "confirmed" && next.device_id !== prev.device_id) fail("device_id は確定時のみ変更できる");
  if (prev.device_confirmation_status === "confirmed") {
    const a = prev.device_confirmation;
    const b = next.device_confirmation;
    const same = a !== null && b !== null && a.device_id === b.device_id && a.confirmed_by_role === b.confirmed_by_role && a.source === b.source && a.verified === b.verified && a.confirmed_at === b.confirmed_at;
    if (next.device_confirmation_status !== "confirmed" || !same || next.device_id !== prev.device_id) {
      fail("確定済みの機種・確定記録は変更できない");
    }
  }
}

function mutate<R>(
  caseId: string,
  allowConfirm: boolean,
  fn: (c: CaseRecord) => { record: CaseRecord; result: R } | { record: null; result: R },
): Promise<{ found: false } | { found: true; result: R; wrote: boolean }> {
  return serialized(async () => {
    const all = await readAll();
    const i = all.findIndex((c) => c.case_id === caseId);
    if (i < 0) return { found: false as const };
    const pristine = deepFreeze(all[i]); // 比較の基準。fn には渡さない
    const out = fn(structuredClone(pristine)); // fn が書き換えてよいのは複製だけ
    if (out.record) {
      assertInvariants(pristine, out.record, allowConfirm);
      all[i] = { ...out.record, updated_at: new Date().toISOString() };
      await writeAll(all);
    }
    return { found: true as const, result: out.result, wrote: out.record !== null };
  });
}

// 1件を読み→変更→保存（書き込みは直列化）。fn が null を返したら保存しない。確定状態への遷移はここからは行えない。
export function updateCase<R>(
  caseId: string,
  fn: (c: CaseRecord) => { record: CaseRecord; result: R } | { record: null; result: R },
): Promise<{ found: false } | { found: true; result: R; wrote: boolean }> {
  return mutate(caseId, false, fn);
}

export type ConfirmResult =
  | { kind: "confirmed"; record: CaseRecord }
  | { kind: "already_confirmed"; device_id: string | null }
  | { kind: "not_a_candidate"; candidate_ids: string[] };

// Human による装置確定（直近の候補からの明示選択のみ）。機種確定へ遷移できる唯一の関数。
// 自己申告のため verified=false・source 固定で記録する（認証導入までの P0 方針。Human の明示承認が必要）。
export function confirmDevice(caseId: string, deviceId: string, role: string) {
  return mutate<ConfirmResult>(caseId, true, (c) => {
    if (c.device_confirmation_status === "confirmed") return { record: null, result: { kind: "already_confirmed", device_id: c.device_id } };
    if (!c.device_candidates.some((d) => d.device_id === deviceId)) {
      return { record: null, result: { kind: "not_a_candidate", candidate_ids: c.device_candidates.map((d) => d.device_id) } };
    }
    const record: CaseRecord = {
      ...c,
      device_id: deviceId,
      device_confirmation_status: "confirmed",
      device_confirmation: { device_id: deviceId, confirmed_by_role: role, source: CONFIRM_SOURCE, verified: false, confirmed_at: new Date().toISOString() },
    };
    return { record, result: { kind: "confirmed", record } };
  });
}
