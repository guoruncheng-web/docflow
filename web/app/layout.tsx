import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "DocFlow｜智能票据识别与审核",
  description:
    "提取票据字段并标注原文证据，通过确定性规则校验，交由人工审核后幂等同步。",
  // Chrome offers to translate an English page for a visitor whose browser is
  // set to another language, and its translator replaces text nodes with its
  // own <font> wrappers. React then updates a tree it no longer recognises and
  // the page dies on an insertBefore — as a blank "Application error", usually
  // mid-stream. Learned the hard way on the previous demo.
  other: { google: "notranslate" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" translate="no" className="notranslate">
      <body>
        <Providers>{children}</Providers>
        <footer className="icp-footer">
          <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">粤ICP备2026057508号-3</a>
        </footer>
      </body>
    </html>
  );
}
