// TP-02 装置特定（FR-P0-02 / AC-02: A-01〜A-03）
// 仕様: preparation/02_REQUIREMENTS.md FR-P0-02 / 03_ARCHITECTURE.md §3 device-search, device-confirm
// 原則: 候補と根拠を返すだけで、装置を自動確定しない。確定は Human の明示選択イベントのみ。
// データ: src/data/devices.json（preparation/fixtures/devices.json の写し。架空データのみ）
import devicesFixture from "@/data/devices.json";
import { isAllowedRole } from "@/lib/roles";
import type { CaseRecord, DeviceCandidate, DeviceConfirmationStatus } from "@/lib/caseStore";

type Device = {
  device_id: string;
  site_id: string;
  model: string;
  serial: string;
  room: string;
  install_year: number;
  modality: string;
};

const DEVICES: readonly Device[] = devicesFixture.devices;

const MAX_LEN = 200;

export type SearchQuery = {
  model: string | null;
  serial_fragment: string | null;
  room: string | null;
  install_year: number | null;
  modality: string | null;
  free_text: string | null;
};

export type QueryValidation = { ok: true; query: SearchQuery } | { ok: false; invalid: string[] };

function optStr(obj: Record<string, unknown>, f: string, invalid: string[]): string | null {
  const raw = obj[f];
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || raw.trim().length === 0 || raw.length > MAX_LEN) {
    invalid.push(f);
    return null;
  }
  return raw.trim();
}

export function validateQuery(input: unknown): QueryValidation {
  const obj = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const invalid: string[] = [];
  const q: SearchQuery = {
    model: optStr(obj, "model", invalid),
    serial_fragment: optStr(obj, "serial_fragment", invalid),
    room: optStr(obj, "room", invalid),
    install_year: null,
    modality: optStr(obj, "modality", invalid),
    free_text: optStr(obj, "free_text", invalid),
  };
  const y = obj.install_year;
  if (y !== undefined && y !== null && y !== "") {
    if (typeof y === "number" && Number.isInteger(y) && y >= 1900 && y <= 2100) q.install_year = y;
    else invalid.push("install_year");
  }
  if (invalid.length > 0) return { ok: false, invalid };
  if (Object.values(q).every((v) => v === null)) return { ok: false, invalid: ["no_criteria"] };
  return { ok: true, query: q };
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

// 自由記述（例:「撮影室のXR」）を語に分け、型式・モダリティ・部屋名のどれに当たるかで条件化する
function freeTextTerms(text: string): string[] {
  return text
    .normalize("NFKC")
    .split(/[\sのにでと、。,./・]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

type Criterion = { label: string; test: (d: Device) => boolean };

function buildCriteria(q: SearchQuery, siteDevices: readonly Device[]): { criteria: Criterion[]; unmatched_terms: string[] } {
  const criteria: Criterion[] = [];
  if (q.model) criteria.push({ label: `型式一致: ${q.model}`, test: (d) => norm(d.model) === norm(q.model!) });
  if (q.serial_fragment) {
    criteria.push({ label: `シリアル部分一致: ${q.serial_fragment}`, test: (d) => norm(d.serial).includes(norm(q.serial_fragment!)) });
  }
  if (q.room) criteria.push({ label: `部屋名部分一致: ${q.room}`, test: (d) => norm(d.room).includes(norm(q.room!)) });
  if (q.install_year !== null) criteria.push({ label: `設置年一致: ${q.install_year}`, test: (d) => d.install_year === q.install_year });
  if (q.modality) criteria.push({ label: `モダリティ一致: ${q.modality}`, test: (d) => norm(d.modality) === norm(q.modality!) });

  // 自由記述の語は、施設内のどの装置属性にも当たらなければ条件にせず、未解釈として返す（推測で絞らない）
  const unmatched_terms: string[] = [];
  for (const term of q.free_text ? freeTextTerms(q.free_text) : []) {
    const t = norm(term);
    const byModality = siteDevices.some((d) => norm(d.modality) === t);
    const byModel = siteDevices.some((d) => norm(d.model) === t);
    const byRoom = siteDevices.some((d) => norm(d.room).includes(t));
    if (byModality) criteria.push({ label: `モダリティ一致: ${term}`, test: (d) => norm(d.modality) === t });
    else if (byModel) criteria.push({ label: `型式一致: ${term}`, test: (d) => norm(d.model) === t });
    else if (byRoom) criteria.push({ label: `部屋名部分一致: ${term}`, test: (d) => norm(d.room).includes(t) });
    else unmatched_terms.push(term);
  }
  return { criteria, unmatched_terms };
}

export type SearchOutcome = {
  candidates: DeviceCandidate[];
  ambiguous: boolean;
  // R3: 検索結果は確定状態になれない（型で "confirmed" を除外。確定は device-confirm のみ）
  status: Exclude<DeviceConfirmationStatus, "confirmed">;
  unmatched_terms: string[];
  note: string;
};

// ケースの施設内だけを対象に、全条件を満たす装置を候補として返す
export function searchDevices(c: Pick<CaseRecord, "site_id">, q: SearchQuery): SearchOutcome {
  const siteDevices = DEVICES.filter((d) => d.site_id === c.site_id);
  const { criteria, unmatched_terms } = buildCriteria(q, siteDevices);

  const candidates: DeviceCandidate[] =
    criteria.length === 0
      ? []
      : siteDevices
          .filter((d) => criteria.every((cr) => cr.test(d)))
          .map((d) => ({
            device_id: d.device_id,
            model: d.model,
            serial: d.serial,
            room: d.room,
            install_year: d.install_year,
            modality: d.modality,
            // 一致した条件数（全候補が全条件を満たすため同点＝順位付けで選ばせない）
            score: criteria.length,
            reasons: [`施設一致: ${c.site_id}`, ...criteria.map((cr) => cr.label)],
          }));

  // 1件でも自動確定はしない（Human の選択を待つ）
  const status: Exclude<DeviceConfirmationStatus, "confirmed"> = candidates.length > 0 ? "needs_human_selection" : "unconfirmed";
  const note =
    candidates.length === 0
      ? "該当する装置がありません。条件を見直してください"
      : candidates.length === 1
        ? "候補は1台です。装置を確認し、明示的に選択してください"
        : `候補が${candidates.length}台あります。現地の情報で装置を選択してください`;
  return { candidates, ambiguous: candidates.length > 1, status, unmatched_terms, note };
}

export type ConfirmValidation =
  | { ok: true; device_id: string; confirmed_by_role: string }
  | { ok: false; missing: string[]; invalid: string[] };

// 確定は「人が候補から選んだ」ことを明示する入力のみ受け付ける
export function validateConfirm(input: unknown): ConfirmValidation {
  const obj = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const missing: string[] = [];
  const invalid: string[] = [];
  const device_id = typeof obj.device_id === "string" && obj.device_id.trim() ? obj.device_id.trim() : null;
  if (!device_id) missing.push("device_id");
  if (obj.human_selected === undefined) missing.push("human_selected");
  else if (obj.human_selected !== true) invalid.push("human_selected");
  const role = typeof obj.confirmed_by_role === "string" && obj.confirmed_by_role.trim() ? obj.confirmed_by_role.trim() : null;
  if (!role) missing.push("confirmed_by_role");
  else if (!isAllowedRole(role)) invalid.push("confirmed_by_role");
  if (missing.length > 0 || invalid.length > 0) return { ok: false, missing, invalid };
  return { ok: true, device_id: device_id!, confirmed_by_role: role! };
}
