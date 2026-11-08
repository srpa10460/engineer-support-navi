import type { Metadata } from "next";
import "./globals.css";

// 外部フォント取得は行わない（NFR-01 ローカル単体でデモ可能）
export const metadata: Metadata = {
  title: "エンジニアサポートNavi",
  description: "新人サービスエンジニア向け技術支援（架空データによるデモ）",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
