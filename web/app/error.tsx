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
      <h1 style={{ fontSize: 18, margin: 0 }}>页面暂时出现异常</h1>
      <p style={{ color: "var(--text-dim)", maxWidth: 460, textAlign: "center" }}>
        工作空间、文档与审核记录仍安全保存在服务器，重新加载即可继续。
      </p>

      <button className="primary" onClick={reset}>
        <RotateCw size={14} />
        重新尝试
      </button>

      {error.digest && (
        <p className="mono" style={{ color: "var(--faint)", fontSize: 11 }}>
          {error.digest}
        </p>
      )}
    </div>
  );
}
