// テスト用の固定応答(ESN_PROPOSAL_FIXTURE が設定されたときだけ使う)。本番の収録・提出では使わない。画面に「テスト用の固定応答」と表示される。
import type { EvRef } from "./types";
export function fixtureText(kind: string, ev: EvRef[]): string | null {
  const r = ev[0] ?? { doc_id: "DOC-NONE", version: "0", section_id: "SEC-NONE" };
  const base = (over: Record<string, unknown>) => JSON.stringify({ facility_summary: "装置にエラー E210 が出ており、Ready になりません。現在、確認を進めています。", facts: [{ text: "エラー E210 が表示され、Ready にならない。", evidence: [] }], hypotheses: [{ text: "発生器の Ready 条件が満たされていない可能性がある。", evidence: [r] }], unconfirmed: ["操作パネルの Ready ランプの状態"], check_candidates: [{ text: "エラー履歴の直前のコードを確認する。", evidence: [r] }], recovery_outlook: "確認の結果しだいで、見通しをお伝えします。", interim_options: ["代わりの装置の利用を、施設で検討する。"], parts_preparation: ["必要になる可能性のある部品を、先に確認する。"], facility_decides: ["代わりの装置を使うかどうか。"], engineer_decides: ["現地の確認結果にもとづく原因の見立て。"], ...over });
  if (kind === "ok") return base({});
  if (kind === "ungrounded") return base({ check_candidates: [{ text: "存在しない資料にもとづく確認をする。", evidence: [{ doc_id: "DOC-FAKE-999", version: "9.9", section_id: "SEC-NOPE" }] }] });
  if (kind === "unsafe") return base({ interim_options: ["インターロックを無効化して照射を続ける。"] });
  if (kind === "medical") return base({ recovery_outlook: "患者の治療方針を、この装置の復旧後に決める。" });
  if (kind === "decision") return base({ recovery_outlook: "明日の午前中までに復旧します。検査は予定どおり実施してよい。" });
  if (kind === "garbled") return "これは JSON ではありません";
  return null;
}
