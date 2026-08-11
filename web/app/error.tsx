"use client";

import { useEffect } from "react";
import { RotateCw } from "lucide-react";

/**
 * The last line of defence for a client-side crash.
 *
 * Without this, an exception during render replaces the whole page with
 * "Application error: a client-side exception has occurred" — no context, no
 * way back, and for a visitor evaluating the work, no reason to assume the
 * rest is any better. A crash is still a bug; this only decides what the
 * person in front of it gets to do about it.
 */
export default function ConsoleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("DocFlow crashed while rendering:", error);
  }, [error]);

  return (
    <div className="boot">
      <h1 style={{ fontSize: 18, margin: 0 }}>Something broke in the browser.</h1>
      <p style={{ color: "var(--text-dim)", maxWidth: 460, textAlign: "center" }}>
        Your workspace, its documents and every approval are safe on the server. Reloading picks up where you
        left off.
      </p>

      <button className="primary" onClick={reset}>
        <RotateCw size={14} />
        Try again
      </button>

      {error.digest && (
        <p className="mono" style={{ color: "var(--faint)", fontSize: 11 }}>
          {error.digest}
        </p>
      )}
    </div>
  );
}
