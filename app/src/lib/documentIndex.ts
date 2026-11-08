// TP-03 文書索引と Evidence 解決（FR-P0-03 / AC-03: N-03, E-01〜E-03）
// 仕様: preparation/03_ARCHITECTURE.md §7 Evidence Management
// 原則: 索引（documents_index.json）に実在する doc_id + version + section_id だけを返す。
//       excerpt は必ず文書ファイルから再取得し、呼び出し側（LLM 等）の渡した文字列は使わない。
// データ: src/data/（preparation/fixtures の写し。架空データのみ）
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import indexData from "@/data/documents_index.json";

type IndexSection = { section_id: string; title: string };
type IndexDoc = { doc_id: string; title: string; version: string; models: string[]; path: string; sections: IndexSection[] };

const DOCS: readonly IndexDoc[] = indexData.documents;
const DOC_DIR = path.join(process.cwd(), "src", "data", "documents");

export type EvidenceRef = {
  evidence_id: string;
  doc_id: string;
  version: string;
  section_id: string;
  title: string;
  excerpt: string;
  excerpt_hash: string;
  source_path: string;
};

export type RejectCode = "DOC_NOT_IN_INDEX" | "VERSION_MISMATCH" | "SECTION_NOT_IN_INDEX" | "MODEL_MISMATCH" | "SECTION_BODY_MISSING";

export type ResolveResult = { ok: true; evidence: EvidenceRef } | { ok: false; code: RejectCode; detail: string };

const bodyCache = new Map<string, string>();

function readDoc(doc: IndexDoc): string {
  let body = bodyCache.get(doc.path);
  if (body === undefined) {
    body = readFileSync(path.join(DOC_DIR, path.basename(doc.path)), "utf8");
    bodyCache.set(doc.path, body);
  }
  return body;
}

// 「## <section_id> ...」見出しから次の「## 」見出し直前までを節本文とする（見出し行は含めない）
function sectionBody(doc: IndexDoc, sectionId: string): string | null {
  const lines = readDoc(doc).split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${sectionId} `) || l === `## ${sectionId}`);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

export function makeRefId(docId: string, version: string, sectionId: string): string {
  return `${docId}~${version}~${sectionId}`;
}

export function parseRefId(refId: string): { doc_id: string; version: string; section_id: string } | null {
  const parts = refId.split("~");
  if (parts.length !== 3 || parts.some((p) => p.length === 0 || p.length > 100)) return null;
  return { doc_id: parts[0], version: parts[1], section_id: parts[2] };
}

// 索引と文書ファイルで解決する。model が渡された場合は機種適合も検査する（E-03）。
export function resolveEvidence(docId: string, version: string, sectionId: string, model: string | null): ResolveResult {
  const doc = DOCS.find((d) => d.doc_id === docId);
  if (!doc) return { ok: false, code: "DOC_NOT_IN_INDEX", detail: `doc_id=${docId}` };
  if (doc.version !== version) return { ok: false, code: "VERSION_MISMATCH", detail: `doc_id=${docId} version=${version}（索引は ${doc.version}）` };
  const sec = doc.sections.find((s) => s.section_id === sectionId);
  if (!sec) return { ok: false, code: "SECTION_NOT_IN_INDEX", detail: `section_id=${sectionId}` };
  if (model !== null && !doc.models.includes(model)) {
    return { ok: false, code: "MODEL_MISMATCH", detail: `doc_id=${docId} は ${doc.models.join("/")} 用。対象機種=${model}` };
  }
  const body = sectionBody(doc, sectionId);
  if (body === null || body.length === 0) return { ok: false, code: "SECTION_BODY_MISSING", detail: `section_id=${sectionId}` };
  return {
    ok: true,
    evidence: {
      evidence_id: makeRefId(doc.doc_id, doc.version, sec.section_id),
      doc_id: doc.doc_id,
      version: doc.version,
      section_id: sec.section_id,
      title: sec.title,
      excerpt: body,
      excerpt_hash: createHash("sha256").update(body).digest("hex").slice(0, 16),
      source_path: `documents/${path.basename(doc.path)}`,
    },
  };
}

export type SearchInput = { model: string | null; error_code: string | null; query: string | null };
export type DocHit = EvidenceRef & { reasons: string[] };

const MAX_LEN = 200;

export function validateSearch(raw: unknown): { ok: true; input: SearchInput } | { ok: false; invalid: string[] } {
  const invalid: string[] = [];
  const isObj = raw !== null && typeof raw === "object" && !Array.isArray(raw);
  if (!isObj) invalid.push("body");
  const obj = isObj ? (raw as Record<string, unknown>) : {};
  const opt = (f: string): string | null => {
    const v = obj[f];
    if (v === undefined || v === null || v === "") return null;
    if (typeof v !== "string" || v.trim().length === 0 || v.length > MAX_LEN) {
      invalid.push(f);
      return null;
    }
    return v.trim();
  };
  // model は受け取らない（機種は確定済み装置からのみ決める）
  const input = { model: null as string | null, error_code: opt("error_code"), query: opt("query") };
  return invalid.length ? { ok: false, invalid } : { ok: true, input };
}

// 機種に適合する文書のうち、エラーコード（節 ID / 見出し / 本文）または語句に合う節のみを返す。
// 機種が不明（null）の場合は何も返さない（他機種文書の流用防止。装置確定が前提）。
export function searchDocuments(input: SearchInput): DocHit[] {
  if (input.model === null) return [];
  const terms = [input.error_code, ...(input.query ? input.query.split(/\s+/) : [])]
    .filter((t): t is string => !!t)
    .map((t) => t.toLowerCase());
  if (terms.length === 0) return [];
  const hits: DocHit[] = [];
  for (const doc of DOCS) {
    if (!doc.models.includes(input.model)) continue;
    for (const sec of doc.sections) {
      const r = resolveEvidence(doc.doc_id, doc.version, sec.section_id, input.model);
      if (!r.ok) continue;
      const haystack = `${sec.section_id} ${sec.title} ${r.evidence.excerpt}`.toLowerCase();
      const matched = terms.filter((t) => haystack.includes(t));
      if (matched.length === 0) continue;
      hits.push({ ...r.evidence, reasons: [`機種適合: ${input.model}`, ...matched.map((t) => `一致語: ${t}`)] });
    }
  }
  // 一致語の多い順、同数なら evidence_id 順（決定的な並び）
  return hits.sort((a, b) => b.reasons.length - a.reasons.length || a.evidence_id.localeCompare(b.evidence_id));
}
