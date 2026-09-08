"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, HelpCircle, Loader2, LogOut, Play, Upload } from "lucide-react";
import {
  api,
  dollars,
  money,
  streamProcessing,
  type QueueItem,
  type RecordDetail,
  type Sample,
  type Usage,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { DocumentViewer } from "@/components/document-viewer";
import { ReviewPanel } from "@/components/review-panel";

export default function DeskPage() {
  const router = useRouter();
  const { status, user, signOut } = useAuth();

  useEffect(() => {
    if (status === "anonymous") router.replace("/login");
  }, [status, router]);

  if (status !== "authenticated" || !user) {
    return (
      <div className="boot">
        <Loader2 size={18} className="spin" />
        <p>正在打开工作空间…</p>
      </div>
    );
  }

  return <Desk organizationName={user.organizationName} onSignOut={signOut} />;
}

type Stage = { stage: string; detail: Record<string, unknown> };

function Desk({ organizationName, onSignOut }: { organizationName: string; onSignOut: () => void }) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const [stream, setStream] = useState("");
  const [stage, setStage] = useState<Stage | null>(null);
  const [processing, setProcessing] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  const documents = useQuery({ queryKey: ["documents"], queryFn: () => api<QueueItem[]>("/documents") });
  const samples = useQuery({ queryKey: ["samples"], queryFn: () => api<Sample[]>("/samples") });
  const usage = useQuery({ queryKey: ["usage"], queryFn: () => api<Usage>("/usage") });

  const selected = documents.data?.find((document) => document.id === selectedId) ?? null;

  const record = useQuery({
    queryKey: ["record", selected?.recordId],
    queryFn: () => api<RecordDetail>(`/records/${selected!.recordId}`),
    enabled: Boolean(selected?.recordId),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["documents"] });
    void queryClient.invalidateQueries({ queryKey: ["usage"] });
  };

  /**
   * Reads a document, showing the work.
   *
   * The tokens are streamed onto the screen as they arrive rather than
   * replaced by a spinner, because "it extracted the fields" and "watch it
   * extract the fields, then watch the rules judge the result" are different
   * claims, and only one of them can be checked by looking.
   */
  async function process(documentId: string) {
    setProcessing(documentId);
    setStream("");
    setFailure(null);
    setStage(null);

    try {
      await streamProcessing(documentId, {
        onStage: (name, detail) => setStage({ stage: name, detail }),
        onToken: (token) => setStream((current) => current + token),
        onDone: () => {
          refresh();
          void queryClient.invalidateQueries({ queryKey: ["record"] });
        },
        onFailed: (message) => setFailure(message),
      });
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setProcessing(null);
      refresh();
    }
  }

  const addSample = useMutation({
    mutationFn: (slug: string) =>
      api<{ id: string }>("/documents/from-sample", { method: "POST", body: JSON.stringify({ slug }) }),
    onSuccess: async (created) => {
      refresh();
      setSelectedId(created.id);
      await process(created.id);
    },
  });

  const upload = useMutation({
    mutationFn: (file: File) => {
      const body = new FormData();
      body.append("file", file);
      return api<{ id: string }>("/documents/uploads", { method: "POST", body });
    },
    onSuccess: async (created) => {
      refresh();
      setSelectedId(created.id);
      await process(created.id);
    },
    onError: (error: Error) => setFailure(error.message),
  });

  const queue = documents.data ?? [];
  const focused = record.data?.fields.find((field) => field.path === focusedField) ?? null;

  return (
    <div className="desk">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <FileText size={14} />
          </span>
          docflow
        </div>

        <div className="spacer" />

        <a className="language-link" href="https://docflow-web-woad.vercel.app" target="_blank" rel="noreferrer">
          English ↗
        </a>

        {usage.data && (
          <span className="pill mono" title="当前工作空间的模型调用成本">
            {dollars(usage.data.spentMicros)} · {usage.data.documents} 份文档
          </span>
        )}

        <span className="pill">{organizationName}</span>

        <button className="ghost" onClick={onSignOut} title="退出登录" aria-label="退出登录">
          <LogOut size={14} />
        </button>
      </header>

      <aside className="queue">
        <div className="queue-head">
          <p className="label">待处理文档</p>
          <h2>
            {queue.length} 份文档
          </h2>

          <div className="row">
            <button className="ghost" onClick={() => uploadRef.current?.click()} disabled={upload.isPending}>
              {upload.isPending ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}
              上传 PDF
            </button>
            <input
              ref={uploadRef}
              type="file"
              accept="application/pdf"
              style={{ display: "none" }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) upload.mutate(file);
                event.target.value = "";
              }}
            />
          </div>
        </div>

        {queue.length === 0 && (
          <div className="section">
            <p className="label" style={{ marginBottom: 8 }}>
              或选择以下示例
            </p>
            <div className="gallery">
              {(samples.data ?? []).map((sample) => (
                <button
                  key={sample.slug}
                  className="sample"
                  disabled={addSample.isPending}
                  onClick={() => addSample.mutate(sample.slug)}
                >
                  <strong>{sample.title}</strong>
                  <span>{sample.teaser}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {queue.map((item) => (
          <button
            key={item.id}
            className="doc"
            aria-current={item.id === selectedId}
            onClick={() => {
              setSelectedId(item.id);
              setFocusedField(null);
            }}
          >
            <div className="doc-top">
              <span className="doc-name">{item.vendorName ?? item.filename}</span>
              <span className="num" style={{ fontSize: 12 }}>
                {item.totalMinor === null ? "" : money(item.totalMinor, item.currency ?? "USD")}
              </span>
            </div>
            <div className="doc-meta">
              <span>{item.invoiceNumber ?? item.filename}</span>
              {item.openErrors > 0 && <span className="chip error">{item.openErrors} 个阻断项</span>}
              {item.openErrors === 0 && item.openWarnings > 0 && (
                <span className="chip warning">{item.openWarnings} 个待确认项</span>
              )}
              {item.recordStatus && item.openErrors === 0 && item.openWarnings === 0 && (
                <span className={`chip ${item.recordStatus === "synced" ? "ok" : "pending"}`}>
                  {statusLabel(item.recordStatus)}
                </span>
              )}
              {!item.recordId && <span className="chip pending">尚未识别</span>}
            </div>
          </button>
        ))}

        {queue.length > 0 && (
          <div className="section">
            <p className="label" style={{ marginBottom: 8 }}>
              添加其他示例
            </p>
            <div className="gallery">
              {(samples.data ?? []).map((sample) => (
                <button
                  key={sample.slug}
                  className="sample"
                  disabled={addSample.isPending}
                  onClick={() => addSample.mutate(sample.slug)}
                >
                  <strong>{sample.title}</strong>
                  <span>{sample.teaser}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </aside>

      <main style={{ overflow: "hidden", display: "grid", gridTemplateRows: "auto minmax(0,1fr)" }}>
        {selected && (
          <div className="section" style={{ background: "var(--paper)", borderBottom: "1px solid var(--line)" }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <p className="label">{selected.filename}</p>
                <strong style={{ fontSize: 15 }}>{selected.vendorName ?? "尚未识别"}</strong>
              </div>

              <button
                className="primary"
                disabled={processing !== null}
                onClick={() => process(selected.id)}
              >
                {processing === selected.id ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
                {selected.recordId ? "重新识别" : "识别这份文档"}
              </button>
            </div>

            {stage && processing === selected.id && (
              <p className="note">
                {stage.stage === "reading" && `正在使用 ${String(stage.detail.provider)} 读取页面…`}
                {stage.stage === "extracting" &&
                  `已从 ${String(stage.detail.pages)} 页提取 ${String(stage.detail.characters)} 个字符，正在请求模型…`}
                {stage.stage === "validating" && "正在执行规则校验…"}
              </p>
            )}

            {stream && processing === selected.id && (
              <pre className="stream" style={{ marginTop: 12 }}>
                {stream}
              </pre>
            )}

            {failure && <p className="error-text">{failure}</p>}
          </div>
        )}

        {selected ? (
          <DocumentViewer
            documentId={selected.id}
            highlight={focused?.evidenceBox ?? null}
            highlightPage={focused?.evidencePage ?? null}
          />
        ) : (
          <div className="viewer">
            <div className="viewer-empty">
              <HelpCircle size={22} />
              <p>
                从左侧选择一张示例票据，或上传自己的 PDF。每张示例都对应一种可验证的处理结果。
              </p>
            </div>
          </div>
        )}
      </main>

      {record.data ? (
        <ReviewPanel record={record.data} focusedField={focusedField} onFocusField={setFocusedField} />
      ) : (
        <aside className="review">
          <div className="section">
            <p className="label">审核</p>
            <p className="note">
              {selected
                ? "识别文档后，建议字段、原文证据和校验结果会显示在这里。"
                : "尚未选择文档。"}
            </p>
          </div>
        </aside>
      )}
    </div>
  );
}

function statusLabel(value: string): string {
  return ({ needs_review: "待审核", approved: "已通过", rejected: "已驳回", sync_pending: "待同步", synced: "已同步", sync_failed: "同步失败" } as Record<string, string>)[value] ?? value.replace(/_/g, " ");
}
