export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080/api";

const TOKEN_KEY = "docflow.token";

export type Severity = "error" | "warning";

export type QueueItem = {
  id: string;
  filename: string;
  status: string;
  templateKey: string;
  pageCount: number;
  byteSize: number;
  createdAt: string;
  recordId: string | null;
  recordStatus: string | null;
  vendorName: string | null;
  invoiceNumber: string | null;
  totalMinor: number | null;
  currency: string | null;
  openErrors: number;
  openWarnings: number;
};

export type Sample = {
  slug: string;
  title: string;
  teaser: string;
  vendorName: string;
  invoiceNumber: string;
  currencyCode: string;
  totalMinor: number;
};

export type Field = {
  path: string;
  label: string;
  kind: "text" | "date" | "money" | "currency" | "lines";
  required: boolean;
  reviewBelow: number;
  value: string | number | null;
  confidence: number | null;
  method: string | null;
  evidence: string | null;
  evidencePage: number | null;
  evidenceBox: number[] | null;
  edited: boolean;
};

export type Finding = {
  id: string;
  code: string;
  severity: Severity;
  fieldPath: string | null;
  message: string;
  resolvedAt: string | null;
  resolution: string | null;
};

export type SyncAttempt = {
  attempt: number;
  outcome: string;
  status: number | null;
  error: string | null;
  delayMs: number | null;
  latencyMs: number;
  at: string;
};

export type SyncJob = {
  id: string;
  destination: string;
  status: string;
  idempotencyKey: string;
  externalId: string | null;
  attempts: SyncAttempt[];
  requestBody: unknown;
  responseBody: unknown;
};

export type RecordDetail = {
  id: string;
  status: string;
  currentVersion: number;
  approvedVersion: number | null;
  document: {
    id: string;
    filename: string;
    pageCount: number;
    pages: Array<{ pageNumber: number; width: number; height: number }>;
  };
  fields: Field[];
  lines: Array<{ description: string; quantity: number; unitPriceMinor: number; amountMinor: number }>;
  findings: Finding[];
  approvals: Array<{ decision: string; recordVersion: number; by: string; note: string | null; at: string }>;
  versions: Array<{ version: number; reason: string; changedBy: string; at: string }>;
  syncJobs: SyncJob[];
  destinationPayload: Record<string, unknown>;
  mappingProblems: string[];
  approvalBlockers: string[];
  usage: {
    costMicros: number;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    attempts: number;
    promptVersion: string;
  } | null;
};

export type Usage = {
  documents: number;
  recordsByStatus: Record<string, number>;
  calls: number;
  spentMicros: number;
  inputTokens: number;
  outputTokens: number;
  deliveries: { total: number; synced: number; failed: number; retries: number };
  recent: Array<{
    purpose: string;
    outcome: string;
    model: string;
    costMicros: number;
    latencyMs: number;
    at: string;
  }>;
};

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  organizationId: string;
  organizationName: string;
};

export type AuthResponse = { accessToken: string; user: AuthUser };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const tokenStore = {
  read: () => (typeof window === "undefined" ? null : window.localStorage.getItem(TOKEN_KEY)),
  write: (token: string) => window.localStorage.setItem(TOKEN_KEY, token),
  clear: () => window.localStorage.removeItem(TOKEN_KEY),
};

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = tokenStore.read();

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) throw new ApiError(response.status, await readErrorMessage(response));
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string | string[] };
    const message = Array.isArray(body.message) ? body.message[0] : body.message;
    return message ?? `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

export type ProcessHandlers = {
  onStage?: (stage: string, detail: Record<string, unknown>) => void;
  onToken?: (token: string) => void;
  onAttempt?: (attempt: { attempt: number; outcome: string; error?: string; delayMs?: number }) => void;
  onDone?: (payload: { recordId: string; findings: Finding[]; costMicros: number; latencyMs: number }) => void;
  onFailed?: (message: string) => void;
};

/**
 * Reads a processing run as it happens.
 *
 * The buffering is the whole trick. A server-sent event is not guaranteed to
 * arrive in one network chunk, and a reader that splits each chunk on blank
 * lines silently drops whatever straddles the boundary — which looks exactly
 * like the model emitting broken JSON once every few runs, and sends you
 * looking in the wrong place for an afternoon.
 */
export async function streamProcessing(documentId: string, handlers: ProcessHandlers): Promise<void> {
  const token = tokenStore.read();

  const response = await fetch(`${API_URL}/documents/${documentId}/process`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: "{}",
  });

  if (!response.ok || !response.body) {
    throw new ApiError(response.status, await readErrorMessage(response));
  }

  const reader = response.body.getReader();
  // A multi-byte character can be split across chunks too; the decoder is
  // created once, in streaming mode, so it can hold the incomplete sequence.
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      dispatch(buffer.slice(0, boundary), handlers);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
  }

  // A trailing fragment never completed, so it is dropped rather than parsed
  // as though it had.
  if (buffer.trim()) dispatch(buffer, handlers);
}

function dispatch(block: string, handlers: ProcessHandlers): void {
  const event = block.match(/^event: (.+)$/m)?.[1]?.trim();
  const data = block.match(/^data: (.+)$/m)?.[1];
  if (!event || !data) return;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(data);
  } catch {
    return;
  }

  if (event === "stage") handlers.onStage?.(String(payload.stage), payload);
  else if (event === "token") handlers.onToken?.(String(payload.token));
  else if (event === "attempt") handlers.onAttempt?.(payload as never);
  else if (event === "done") handlers.onDone?.(payload as never);
  else if (event === "failed") handlers.onFailed?.(String(payload.message));
}

/** Money the way the record stores it: integer minor units, never a float. */
export function money(minor: number | null | undefined, currency = "USD"): string {
  if (minor === null || minor === undefined) return "—";
  const sign = minor < 0 ? "-" : "";
  const absolute = Math.abs(minor);
  const whole = Math.floor(absolute / 100).toLocaleString("en-US");
  return `${sign}${currency} ${whole}.${String(absolute % 100).padStart(2, "0")}`;
}

/** Model spend, in dollars, from integer millionths. */
export function dollars(micros: number, fractionDigits = 4): string {
  return `$${(micros / 1_000_000).toFixed(fractionDigits)}`;
}
