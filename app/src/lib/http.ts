// 全 POST 経路共通の本文読み込み（N-05）。ストリームを読みながらバイト上限を強制する。
// Content-Length が無い・偽装されている chunked 送信でも、上限を超えた時点で読み込みを打ち切る（fail-closed）。
import type { StoreState } from "@/lib/caseStore";
import { errorEnvelope } from "@/lib/envelope";

const NO_STORE = { "Cache-Control": "no-store" };

export const MAX_BODY_BYTES = {
  cases: 65_536,
  device: 16_384,
  documents: 16_384,
  evaluate: 200_000,
} as const;

export type LimitedBody = { ok: true; text: string } | { ok: false; response: Response };

function fail(status: number, error: string, extra: Record<string, unknown>, caseId: string | null, storeState?: StoreState): LimitedBody {
  return { ok: false, response: Response.json(errorEnvelope([error], extra, caseId, storeState), { status, headers: NO_STORE }) };
}

export async function readTextLimited(request: Request, maxBytes: number, caseId: string | null = null, storeState?: StoreState): Promise<LimitedBody> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return fail(413, "payload_too_large", { max_bytes: maxBytes }, caseId, storeState);
  }
  if (!request.body) return { ok: true, text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return fail(413, "payload_too_large", { max_bytes: maxBytes }, caseId, storeState);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(merged) };
  } catch {
    // 不正な UTF-8 は解釈不能として拒否（fail-closed）
    return fail(400, "invalid_encoding", {}, caseId, storeState);
  }
}

export type LimitedJson = { ok: true; body: unknown } | { ok: false; response: Response };

export async function readJsonLimited(request: Request, maxBytes: number, caseId: string | null = null, storeState?: StoreState): Promise<LimitedJson> {
  const t = await readTextLimited(request, maxBytes, caseId, storeState);
  if (!t.ok) return t;
  try {
    return { ok: true, body: JSON.parse(t.text) };
  } catch {
    return { ok: false, response: Response.json(errorEnvelope(["invalid_json"], {}, caseId, storeState), { status: 400, headers: NO_STORE }) };
  }
}
