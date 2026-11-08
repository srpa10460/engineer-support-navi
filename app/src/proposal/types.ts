// 提案の下書き(Claude)の型。既存の API・lib には依存しない(純粋な型と関数だけ)。
export type EvRef = { doc_id: string; version: string; section_id: string };
export type Item = { text: string; evidence: EvRef[] };
export type Draft = {
  facility_summary: string;
  facts: Item[];
  hypotheses: Item[];
  unconfirmed: string[];
  check_candidates: Item[];
  recovery_outlook: string;
  interim_options: string[];
  parts_preparation: string[];
  facility_decides: string[];
  engineer_decides: string[];
};
export type SafetyCheck = { allowed: boolean; rule_id: string | null };
export type CallMeta = { source: "claude" | "fixture"; model: string | null; request_id: string | null; response_id: string | null; input_tokens: number | null; output_tokens: number | null; ms: number };
