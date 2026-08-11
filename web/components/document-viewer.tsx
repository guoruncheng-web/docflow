"use client";

import { useEffect, useRef, useState } from "react";
import { FileWarning, Loader2 } from "lucide-react";
import { API_URL, tokenStore } from "@/lib/api";

/**
 * Renders the original document and draws the evidence for the focused field
 * over it.
 *
 * The page is rendered in the browser rather than as a server-made image for
 * two reasons: a serverless function has no business rasterising PDFs on every
 * request, and the reviewer gets real text they can select rather than a
 * screenshot of it. The highlight is positioned in the page's own coordinate
 * space and scaled with the canvas, so it stays on the words it refers to
 * whatever the window does.
 *
 * The file arrives through a short-lived signed URL minted per request; the
 * store itself is private, so this component never holds a link worth keeping.
 */

type Props = {
  documentId: string;
  /** [x, y, width, height] in PDF user units, top-left origin. */
  highlight: number[] | null;
  highlightPage: number | null;
};

const PDFJS_VERSION = "4.10.38";

export function DocumentViewer({ documentId, highlight, highlightPage }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    setStatus("loading");
    container.innerHTML = "";

    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        // The worker is served from the same bundle rather than a CDN, so the
        // page keeps working behind a network that blocks third-party scripts.
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url,
        ).toString();

        const token = tokenStore.read();
        const response = await fetch(`${API_URL}/documents/${documentId}/file`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });

        if (!response.ok) throw new Error("This document could not be opened.");
        const { url } = (await response.json()) as { url: string };

        const file = await fetch(url);
        if (!file.ok) throw new Error("The stored file could not be read.");

        const bytes = new Uint8Array(await file.arrayBuffer());
        if (cancelled) return;

        const pdf = await pdfjs.getDocument({ data: bytes }).promise;
        if (cancelled) return;

        setPageCount(pdf.numPages);

        // Fit the width of the space available, within reason: a page rendered
        // wider than the column forces horizontal scrolling on the one thing
        // the reviewer is reading.
        const available = Math.min(container.clientWidth || 640, 820);
        const first = await pdf.getPage(1);
        const naturalWidth = first.getViewport({ scale: 1 }).width;
        const chosen = Math.max(0.6, Math.min(2, available / naturalWidth));

        if (!cancelled) setScale(chosen);

        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
          if (cancelled) return;

          const page = await pdf.getPage(pageNumber);
          const viewport = page.getViewport({ scale: chosen * (window.devicePixelRatio || 1) });

          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.width = `${viewport.width / (window.devicePixelRatio || 1)}px`;
          canvas.style.height = `${viewport.height / (window.devicePixelRatio || 1)}px`;

          const frame = document.createElement("div");
          frame.className = "page-frame";
          frame.dataset.page = String(pageNumber);
          frame.appendChild(canvas);
          container.appendChild(frame);

          const context = canvas.getContext("2d");
          if (context) {
            await page.render({ canvasContext: context, viewport }).promise;
          }
        }

        if (!cancelled) setStatus("ready");
      } catch (error) {
        if (cancelled) return;
        setStatus("error");
        setMessage((error as Error).message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [documentId]);

  // The highlight is a DOM node placed into the rendered page rather than React
  // state inside it: the canvases are created imperatively above, and mixing
  // the two rendering models over the same subtree is how a page ends up
  // fighting itself.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.querySelectorAll(".evidence").forEach((node) => node.remove());
    if (!highlight || !highlightPage) return;

    const frame = container.querySelector<HTMLElement>(`.page-frame[data-page="${highlightPage}"]`);
    if (!frame) return;

    const [x, y, width, height] = highlight;
    const box = document.createElement("div");
    box.className = "evidence";
    // A couple of points of padding so the border sits around the words rather
    // than through them.
    box.style.left = `${x * scale - 2}px`;
    box.style.top = `${y * scale - 2}px`;
    box.style.width = `${width * scale + 4}px`;
    box.style.height = `${height * scale + 4}px`;

    frame.appendChild(box);
    box.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlight, highlightPage, scale, status]);

  return (
    <div className="viewer">
      {status === "loading" && (
        <div className="viewer-empty">
          <Loader2 size={18} className="spin" />
          <p>Opening the document…</p>
        </div>
      )}

      {status === "error" && (
        <div className="viewer-empty">
          <FileWarning size={20} />
          <p>{message}</p>
        </div>
      )}

      <div ref={containerRef} style={{ display: "grid", gap: 16, justifyItems: "center" }} />

      {status === "ready" && pageCount > 1 && (
        <p className="label">
          {pageCount} pages · rendered in your browser, pdf.js {PDFJS_VERSION}
        </p>
      )}
    </div>
  );
}
