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
          <span className="label">建议字段</span>
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
              <span className="field-label">{fieldLabel(field.path, field.label)}</span>
              <span className="row" style={{ gap: 6 }}>
                {field.edited && <span className="chip">已编辑</span>}
                {field.method === "llm+unverified-quote" && (
                  <span className="chip warning" title="模型引用的文字未出现在文档中">
                    无原文依据
                  </span>
                )}
                {percent !== null && (
                  <>
                    <span className={`confidence${low ? " low" : ""}`} title={`置信度 ${percent}%`}>
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
                  aria-label={fieldLabel(field.path, field.label)}
                  disabled={record.status === "synced"}
                />
              </div>
            </div>
          );
        })}

        {record.lines.length > 0 && (
          <details style={{ marginTop: 12 }}>
            <summary className="label" style={{ cursor: "pointer" }}>
              {record.lines.length} 个明细项
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
          <span className="label">校验结果</span>
          <span className="label">{open.length} 项待处理</span>
        </div>

        {record.findings.length === 0 && (
          <p className="note">全部规则校验通过，无需额外处理。</p>
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
          <span className="label">人工审核</span>
          <span className={`chip ${statusTone(record.status)}`}>{statusLabel(record.status)}</span>
        </div>

        {record.approvalBlockers.length > 0 ? (
          <p className="note" style={{ color: "var(--danger)" }}>
            当前仍有 {open.length} 个校验项需要处理，暂时无法审核通过。
          </p>
        ) : (
          <p className="note">
            审核会锁定当前版本；后续修改任何字段都会自动撤回本次通过状态。
          </p>
        )}

        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="primary go"
            disabled={busy || record.approvalBlockers.length > 0 || record.approvedVersion !== null}
            onClick={() => decide.mutate({ decision: "approve" })}
          >
            {decide.isPending ? <Loader2 size={14} className="spin" /> : <ShieldCheck size={14} />}
            通过 v{record.currentVersion}
          </button>

          <button
            className="ghost"
            disabled={busy || record.status === "synced"}
            onClick={() => {
              const note = window.prompt("请输入驳回原因");
              if (note?.trim()) decide.mutate({ decision: "reject", note });
            }}
          >
            <X size={14} />
            驳回
          </button>
        </div>

        {record.approvals.length > 0 && (
          <div className="stack" style={{ marginTop: 12 }}>
            {record.approvals.slice(0, 3).map((approval, index) => (
              <p key={index} className="note" style={{ margin: 0 }}>
                <strong>{approval.decision === "approve" ? "已通过" : "已驳回"}</strong> v{approval.recordVersion}，操作人 {approval.by}
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
            <span className="label">本次文档处理成本</span>
            <span className="label">{record.usage.promptVersion}</span>
          </div>
          <div className="row" style={{ gap: 16, fontSize: 12.5 }}>
            <span>
              <span className="num" style={{ fontWeight: 600 }}>
                {dollars(record.usage.costMicros, 5)}
              </span>{" "}
              <span style={{ color: "var(--muted)" }}>模型成本</span>
            </span>
            <span>
              <span className="num" style={{ fontWeight: 600 }}>
                {(record.usage.latencyMs / 1000).toFixed(1)}s
              </span>{" "}
              <span style={{ color: "var(--muted)" }}>处理耗时</span>
            </span>
            <span>
              <span className="num" style={{ fontWeight: 600 }}>
                {record.usage.attempts}
              </span>{" "}
              <span style={{ color: "var(--muted)" }}>
                次尝试
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
        {resolved && <span className="chip ok">已处理</span>}
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
            placeholder="请输入覆盖原因"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            aria-label={`覆盖 ${finding.code} 的原因`}
          />
          <button className="ghost" disabled={busy || !reason.trim()} onClick={() => onResolve(reason)}>
            确认覆盖
          </button>
        </div>
      ) : (
        <div>
          <button className="ghost" disabled={busy} onClick={() => onResolve("已人工确认")}>
            <Check size={14} />
            确认知悉
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
        <span className="label">同步交付</span>
        <span className="label">模拟财务系统</span>
      </div>

      <div className="row">
        <select
          className="ghost"
          value={fault}
          onChange={(event) => setFault(event.target.value)}
          aria-label="注入同步故障"
        >
          <option value="none">不注入故障</option>
          <option value="rate_limit">模拟首次请求限流</option>
          <option value="server_error">模拟首次请求返回 500</option>
          <option value="timeout">模拟首次请求超时</option>
          <option value="lost_response">远端成功但响应丢失</option>
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
          同步到财务系统
        </button>
      </div>

      {record.approvedVersion === null && (
        <p className="note">只有审核通过的版本才能同步。</p>
      )}

      {record.mappingProblems.length > 0 && (
        <p className="error-text">目标系统会拒绝当前数据：{record.mappingProblems.join("; ")}。</p>
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
                {attempt.delayMs ? <span className="num" style={{ fontSize: 11 }}>{attempt.delayMs}ms 后重试</span> : null}
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
          查看将要同步的数据
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

function statusLabel(status: string): string {
  return ({ needs_review: "待审核", approved: "已通过", rejected: "已驳回", sync_pending: "待同步", synced: "已同步", sync_failed: "同步失败" } as Record<string, string>)[status] ?? status;
}

function fieldLabel(path: string, fallback: string): string {
  return ({ vendorName: "供应商", invoiceNumber: "发票号码", invoiceDate: "开票日期", dueDate: "到期日期", purchaseOrder: "采购单号", currency: "币种", subtotalMinor: "未税金额", taxMinor: "税额", totalMinor: "合计金额" } as Record<string, string>)[path] ?? fallback;
}

/** Shows minor units as money while keeping the edit field honest about them. */
function formatMoneyInput(value: string, currency: string): string {
  const numeric = Number(value.replace(/[^\d-]/g, ""));
  return Number.isFinite(numeric) && value !== "" ? money(numeric, currency) : value;
}
