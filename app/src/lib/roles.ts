// OD-03: デモ用 role は仕様上 junior_fse のみ（preparation/03_ARCHITECTURE.md OD-03、05 S-04、fixtures/safety_rules.json roles_blocked）。
// senior_se / senior_fse 等は仕様外のため採用しない（Rule Drift 解消・2026-11-02 Human 方針）。
// 自己申告のラベルであり認証ではない。上級ロールを追加する場合は Human が仕様に追記してから。
export const ALLOWED_REPORTER_ROLES: readonly string[] = ["junior_fse"];

export function isAllowedRole(v: unknown): v is string {
  return typeof v === "string" && ALLOWED_REPORTER_ROLES.includes(v);
}
