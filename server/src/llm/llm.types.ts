export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  /** Overrides the configured default; used to fall back to a cheaper model. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Called with each token as it arrives, for streaming to the browser. */
  onToken?: (token: string) => void;
}

export interface CompletionResult {
  text: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  latencyMs: number;
  ttfbMs: number | null;
}

/** Why a call failed, in terms the caller can act on. */
export type LlmFailureKind = 'rate_limited' | 'timeout' | 'upstream_error' | 'invalid_output';

export class LlmError extends Error {
  constructor(
    readonly kind: LlmFailureKind,
    message: string,
    /** Rate-limit responses often say exactly how long to wait; obey them. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }

  get retryable(): boolean {
    return this.kind !== 'invalid_output';
  }
}
