// R5 拒否の監査記録（ケース記録 cases.json とは別ファイルへの追記）。
// 方針（PATCH-5.3 第 7.5 節）: 拒否した本文・ハッシュは記録しない。メタデータのみ。1 拒否につき最大 1 件。
// 書込みに失敗しても例外を投げない（安全拒否の応答を監査の成否に依存させない）。失敗は標準エラーに固定文のみを出す。
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type AuditEntry = {
  route: string;
  rule_id: string;
  cause_detail: string;
  input_length: number;
  truncated: boolean;
};

export const AUDIT_FILE_NAME = "audit_rejections.jsonl";

const dataDir = () => process.env.ESN_DATA_DIR ?? path.resolve(process.cwd(), "..", "runtime", "data");

// 同一プロセス内の追記を直列化する
let queue: Promise<void> = Promise.resolve();

export function recordRejection(entry: AuditEntry): Promise<void> {
  const run = queue.then(async () => {
    try {
      await mkdir(dataDir(), { recursive: true });
      const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n";
      await appendFile(path.join(dataDir(), AUDIT_FILE_NAME), line, "utf8");
    } catch {
      // 本文・パス・例外内容を出さない固定文のみ
      console.error("AUDIT_WRITE_FAILED");
    }
  });
  queue = run;
  return run;
}
