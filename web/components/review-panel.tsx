"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, CircleAlert, Loader2, Send, ShieldCheck, X } from "lucide-react";
import { api, dollars, money, type Field, type Finding, type RecordDetail } from "@/lib/api";

/**
 * The reviewer's side of the desk.
 *
 * Everything here is arranged around one question: can this be approved, and
 * if not, exactly what is in the way. Confidence is shown but never decides;
 * findings are the gate, and each carries the sentence a person needs to act
 * on it. Approving with a blocker open is refused by the API — the disabled
 * button is a courtesy, not the control.
 */

type Props = {
  record: RecordDetail;
  focusedField: string | null;
  onFocusField: (path: string | null) => void;
};

export function ReviewPanel({ record, focusedField, onFocusField }: Props) {
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  // Edits are local until committed, so typing does not fire a version per
  // keystroke; the stored value wins again whenever the record reloads.
  useEffect(() => setDrafts({}), [record.id, record.currentVersion]);

  const refresh = (updated: RecordDetail) => {
    queryClient.setQueryData(["record", record.id], updated);
    void queryClient.invalidateQueries({ queryKey: ["documents"] });
    void queryClient.invalidateQueries({ queryKey: ["usage"] });
  };

  const save = useMutation({
    mutationFn: (changes: Record<string, unknown>) =>
      api<RecordDetail>(`/records/${record.id}/fields`, {
        method: "PATCH",
        body: JSON.stringify({ changes }),
      }),
    onSuccess: refresh,
    onError: (caught: Error) => setError(caught.message),
  });

  const resolve = useMutation({
    mutationFn: ({ finding, resolution }: { finding: Finding; resolution: string }) =>
      api<RecordDetail>(`/records/${record.id}/findings/${finding.id}/resolve`, {
        method: "POST",
        body: JSON.stringify({ resolution }),
      }),
    onSuccess: refresh,
    onError: (caught: Error) => setError(caught.message),
  });

  const decide = useMutation({
    mutationFn: ({ decision, note }: { decision: "approve" | "reject"; note?: string }) =>
      api<RecordDetail>(`/records/${record.id}/${decision}`, {
        method: "POST",
        body: JSON.stringify({ note }),
      }),
    onSuccess: refresh,
    onError: (caught: Error) => setError(caught.message),
  });

  const commit = (field: Field) => {
    const draft = drafts[field.path];
    if (draft === undefined) return;

    const current = field.value === null ? "" : String(field.value);
    if (draft === current) return;

    setError(null);
    save.mutate({ [field.path]: field.kind === "money" ? Number(draft.replace(/[^\d-]/g, "")) : draft });
  };

  const currency = String(record.fields.find((field) => field.path === "currency")?.value ?? "USD");
  const open = record.findings.filter((finding) => finding.resolvedAt === null);
  const busy = save.isPending || resolve.isPending || decide.isPending;

  return (
    <aside className="review">
      <section className="section">
        <div className="section-head">
          <span className="label">Proposed fields</span>
          <span className="label">v{record.currentVersion}</span>
        </div>

        {record.fields.map((field) => {
          const draft = drafts[field.path];
          const shown = draft ?? (field.value === null ? "" : String(field.value));
          const percent = field.confidence === null ? null : Math.round(field.confidence * 100);
          const low = field.confidence !== null && field.confidence < field.reviewBelow;

          return (
            <div
              key={field.path}
              className={`field${focusedField === field.path ? " focused" : ""}`}
              onFocus={() => onFocusField(field.path)}
              onMouseEnter={() => onFocusField(field.path)}
            >
              <span className="field-label">{field.label}</span>
              <span className="row" style={{ gap: 6 }}>
                {field.edited && <span className="chip">edited</span>}
                {field.method === "llm+unverified-quote" && (
                  <span className="chip warning" title="The model quoted text that is not in this document">
                    no source
                  </span>
                )}
                {percent !== null && (
                  <>
                    <span className={`confidence${low ? " low" : ""}`} title={`${percent}% confidence`}>
                      <span style={{ width: `${percent}%` }} />
                    </span>
                    <span className="num" style={{ fontSize: 11, color: "var(--faint)" }}>
                      {percent}%
                    </span>
                  </>
                )}
              </span>

              <div className="field-value">
                <input
                  value={field.kind === "money" ? formatMoneyInput(shown, currency) : shown}
                  onChange={(event) =>
                    setDrafts((current) => ({ ...current, [field.path]: event.target.value }))
                  }
                  onBlur={() => commit(field)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                  }}
                  aria-label={field.label}
                  disabled={record.status === "synced"}
                />
              </div>
            </div>
          );
        })}

        {record.lines.length > 0 && (
          <details style={{ marginTop: 12 }}>
            <summary className="label" style={{ cursor: "pointer" }}>
              {record.lines.length} line items
            </summary>
            <div className="stack" style={{ marginTop: 8 }}>
              {record.lines.map((line, index) => (
                <div key={index} className="row" style={{ justifyContent: "space-between", fontSize: 12.5 }}>
                  <span style={{ color: "var(--ink-dim)" }}>
                    {line.quantity} × {line.description}
                  </span>
                  <span className="num">{money(line.amountMinor, currency)}</span>
                </div>
              ))}
            </div>
          </details>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <span className="label">Findings</span>
          <span className="label">{open.length} open</span>
        </div>

        {record.findings.length === 0 && (
          <p className="note">Every rule passed. Nothing here is asking for a decision.</p>
        )}

        {record.findings.map((finding) => (
          <FindingCard
            key={finding.id}
            finding={finding}
            busy={busy}
            onFocusField={onFocusField}
            onResolve={(resolution) => {
              setError(null);
              resolve.mutate({ finding, resolution });
            }}
          />
        ))}
      </section>

      <section className="section">
        <div className="section-head">
          <span className="label">Approval</span>
          <span className={`chip ${statusTone(record.status)}`}>{record.status.replace(/_/g, " ")}</span>
        </div>

        {record.approvalBlockers.length > 0 ? (
          <p className="note" style={{ color: "var(--danger)" }}>
            {record.approvalBlockers.join(" ")}
          </p>
        ) : (
          <p className="note">
            Approving records this exact version. Editing anything afterwards withdraws the approval.
          </p>
        )}

        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="primary go"
            disabled={busy || record.approvalBlockers.length > 0 || record.approvedVersion !== null}
            onClick={() => decide.mutate({ decision: "approve" })}
          >
            {decide.isPending ? <Loader2 size={14} className="spin" /> : <ShieldCheck size={14} />}
            Approve v{record.currentVersion}
          </button>

          <button
            className="ghost"
            disabled={busy || record.status === "synced"}
            onClick={() => {
              const note = window.prompt("Why is this being rejected?");
              if (note?.trim()) decide.mutate({ decision: "reject", note });
            }}
          >
            <X size={14} />
            Reject
          </button>
        </div>

        {record.approvals.length > 0 && (
          <div className="stack" style={{ marginTop: 12 }}>
            {record.approvals.slice(0, 3).map((approval, index) => (
              <p key={index} className="note" style={{ margin: 0 }}>
                <strong>{approval.decision}</strong> v{approval.recordVersion} by {approval.by}
                {approval.note ? ` — ${approval.note}` : ""}
              </p>
            ))}
          </div>
        )}

        {error && <p className="error-text">{error}</p>}
      </section>

      <DeliverySection record={record} onChanged={refresh} />

      {record.usage && (
        <section className="section">
          <div className="section-head">
            <span className="label">What this document cost</span>
            <span className="label">{record.usage.promptVersion}</span>
          </div>
          <div className="row" style={{ gap: 16, fontSize: 12.5 }}>
            <span>
              <span className="num" style={{ fontWeight: 600 }}>
                {dollars(record.usage.costMicros, 5)}
              </span>{" "}
              <span style={{ color: "var(--muted)" }}>model spend</span>
            </span>
            <span>
              <span className="num" style={{ fontWeight: 600 }}>
                {(record.usage.latencyMs / 1000).toFixed(1)}s
              </span>{" "}
              <span style={{ color: "var(--muted)" }}>to read it</span>
            </span>
            <span>
              <span className="num" style={{ fontWeight: 600 }}>
                {record.usage.attempts}
              </span>{" "}
              <span style={{ color: "var(--muted)" }}>
                attempt{record.usage.attempts === 1 ? "" : "s"}
              </span>
            </span>
          </div>
        </section>
      )}
    </aside>
  );
}

function FindingCard({
  finding,
  busy,
  onResolve,
  onFocusField,
}: {
  finding: Finding;
  busy: boolean;
  onResolve: (resolution: string) => void;
  onFocusField: (path: string | null) => void;
}) {
  const [reason, setReason] = useState("");
  const resolved = finding.resolvedAt !== null;

  return (
    <div
      className={`finding ${finding.severity}${resolved ? " resolved" : ""}`}
      onMouseEnter={() => finding.fieldPath && onFocusField(finding.fieldPath)}
    >
      <div className="finding-top">
        {finding.severity === "error" ? <CircleAlert size={14} /> : <AlertTriangle size={14} />}
        <span className="outcome">{finding.code}</span>
        {resolved && <span className="chip ok">resolved</span>}
      </div>

      <p>{finding.message}</p>

      {resolved ? (
        <p className="note" style={{ margin: 0 }}>
          {finding.resolution}
        </p>
      ) : finding.severity === "error" ? (
        <div className="row">
          <input
            className="ghost"
            style={{ flex: 1, minWidth: 140 }}
            placeholder="Reason for overriding"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            aria-label={`Reason for overriding ${finding.code}`}
          />
          <button className="ghost" disabled={busy || !reason.trim()} onClick={() => onResolve(reason)}>
            Override
          </button>
        </div>
      ) : (
        <div>
          <button className="ghost" disabled={busy} onClick={() => onResolve("Acknowledged")}>
            <Check size={14} />
            Acknowledge
          </button>
        </div>
      )}
    </div>
  );
}

function DeliverySection({
  record,
  onChanged,
}: {
  record: RecordDetail;
  onChanged: (updated: RecordDetail) => void;
}) {
  const [fault, setFault] = useState("none");
  const [message, setMessage] = useState<string | null>(null);

  const deliver = useMutation({
    mutationFn: () =>
      api<{ outcome: { message: string }; record: RecordDetail }>(`/records/${record.id}/sync`, {
        method: "POST",
        body: JSON.stringify({ fault }),
      }),
    onSuccess: (result) => {
      setMessage(result.outcome.message);
      onChanged(result.record);
    },
    onError: (caught: Error) => setMessage(caught.message),
  });

  const job = record.syncJobs[0];

  return (
    <section className="section">
      <div className="section-head">
        <span className="label">Delivery</span>
        <span className="label">mock accounting</span>
      </div>

      <div className="row">
        <select
          className="ghost"
          value={fault}
          onChange={(event) => setFault(event.target.value)}
          aria-label="Inject a delivery fault"
        >
          <option value="none">No fault</option>
          <option value="rate_limit">Rate-limit the first attempt</option>
          <option value="server_error">Fail the first attempt with a 500</option>
          <option value="timeout">Time out the first attempt</option>
          <option value="lost_response">Succeed remotely, lose the response</option>
        </select>

        <button
          className="primary"
          disabled={deliver.isPending || record.approvedVersion === null}
          onClick={() => {
            setMessage(null);
            deliver.mutate();
          }}
        >
          {deliver.isPending ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
          Deliver
        </button>
      </div>

      {record.approvedVersion === null && (
        <p className="note">Only an approved version can be delivered.</p>
      )}

      {record.mappingProblems.length > 0 && (
        <p className="error-text">The destination would refuse this: {record.mappingProblems.join("; ")}.</p>
      )}

      {job && (
        <div className="stack" style={{ marginTop: 12 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className={`chip ${job.status === "synced" ? "ok" : job.status === "failed" ? "error" : "pending"}`}>
              {job.status}
            </span>
            {job.externalId && <span className="num" style={{ fontSize: 12 }}>{job.externalId}</span>}
          </div>

          <div className="timeline">
            {job.attempts.map((attempt) => (
              <div
                key={attempt.attempt}
                className={`step ${attempt.outcome.startsWith("ok") ? "good" : "bad"}`}
              >
                <span className="index">#{attempt.attempt}</span>
                <span className="outcome">{attempt.outcome.replace(/_/g, " ")}</span>
                <span style={{ color: "var(--muted)", flex: 1 }}>{attempt.error ?? ""}</span>
                {attempt.delayMs ? <span className="num" style={{ fontSize: 11 }}>retry in {attempt.delayMs}ms</span> : null}
              </div>
            ))}
          </div>

          {/* The key is on screen because it is the reason a retry is safe, and
              a claim about idempotency is worth less than the string itself. */}
          <p className="note mono" style={{ fontSize: 11, wordBreak: "break-all" }}>
            {job.idempotencyKey}
          </p>
        </div>
      )}

      {message && <p className="note">{message}</p>}

      <details style={{ marginTop: 12 }}>
        <summary className="label" style={{ cursor: "pointer" }}>
          What would be sent
        </summary>
        <pre className="payload" style={{ marginTop: 8 }}>
          {JSON.stringify(record.destinationPayload, null, 2)}
        </pre>
      </details>
    </section>
  );
}

function statusTone(status: string): string {
  if (status === "synced" || status === "approved") return "ok";
  if (status === "sync_failed" || status === "rejected") return "error";
  return "pending";
}

/** Shows minor units as money while keeping the edit field honest about them. */
function formatMoneyInput(value: string, currency: string): string {
  const numeric = Number(value.replace(/[^\d-]/g, ""));
  return Number.isFinite(numeric) && value !== "" ? money(numeric, currency) : value;
}
