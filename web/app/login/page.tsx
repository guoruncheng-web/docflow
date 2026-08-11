"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, FileText, Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth";

export default function EntryPage() {
  const router = useRouter();
  const { status, startDemo } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "authenticated") router.replace("/");
  }, [status, router]);

  async function open() {
    setBusy(true);
    setError(null);

    try {
      await startDemo();
      router.replace("/");
    } catch (caught) {
      setError((caught as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="entry">
      <div className="entry-pitch">
        <div className="brand">
          <span className="brand-mark">
            <FileText size={14} />
          </span>
          docflow
        </div>

        <h1>Invoices, read and checked before anyone books them.</h1>

        <p>
          A document arrives. Its fields are extracted with the exact line each value came from, checked
          against rules that are ordinary code rather than a second opinion from the model, and held for a
          person whenever anything is uncertain. What gets sent to the accounting system is what somebody
          approved — and sending it twice creates one bill.
        </p>

        <ul className="facts">
          <li>
            <span className="num">$0.0007</span>
            <span>to read one invoice, recorded per call rather than estimated</span>
          </li>
          <li>
            <span className="num">9 of 9</span>
            <span>fields shown with the words on the page they were read from</span>
          </li>
          <li>
            <span className="num">1 bill</span>
            <span>at the destination after a delivery that succeeded and lost its response</span>
          </li>
          <li>
            <span className="num">0</span>
            <span>records delivered without a person approving that exact version</span>
          </li>
        </ul>
      </div>

      <div className="entry-action">
        <h2 style={{ margin: 0, fontSize: 18 }}>Open a demo workspace</h2>
        <p style={{ margin: 0, color: "var(--ink-dim)", fontSize: 13.5 }}>
          Yours alone, no sign-up, deleted after a day. It comes with six synthetic invoices: one clean, one
          that is a duplicate of it, one whose total does not add up, one in a currency the destination
          cannot book, one dated next year, and one carrying an instruction aimed at the model.
        </p>

        <button className="primary" style={{ height: 40 }} onClick={open} disabled={busy}>
          {busy ? <Loader2 size={16} className="spin" /> : null}
          Open a demo workspace
          {!busy && <ArrowRight size={16} />}
        </button>

        {error && <p className="error-text">{error}</p>}

        <p className="note">
          Every model call in the demo is real and costs real money, which is why the workspace is
          disposable and the number in the corner is measured rather than claimed.
        </p>
      </div>
    </div>
  );
}
