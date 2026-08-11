import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

// Inter for the interface; Plex Mono wherever a figure, code or identifier has
// to line up — money columns, confidence, idempotency keys.
const sans = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "DocFlow — invoices read, checked and approved",
  description:
    "Extracts invoice fields with the source line each value came from, applies deterministic rules, holds anything uncertain for a person, and delivers approved records idempotently.",
  // Chrome offers to translate an English page for a visitor whose browser is
  // set to another language, and its translator replaces text nodes with its
  // own <font> wrappers. React then updates a tree it no longer recognises and
  // the page dies on an insertBefore — as a blank "Application error", usually
  // mid-stream. Learned the hard way on the previous demo.
  other: { google: "notranslate" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" translate="no" className={`${sans.variable} ${mono.variable} notranslate`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
