import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readSseStream } from './sse';
import { ChatMessage, CompletionRequest, CompletionResult, LlmError } from './llm.types';

/**
 * A chat client written against the OpenAI-compatible surface rather than any
 * one vendor's SDK.
 *
 * DeepSeek, OpenAI, Together, Groq, vLLM and most self-hosted gateways all
 * speak `POST /chat/completions` with the same body, so switching provider is
 * two environment variables and no code. Clients care about this more than they
 * let on: they may already have an OpenAI contract, or want to move to an open
 * model when the bill arrives, and a codebase welded to one SDK makes that a
 * rewrite instead of a config change.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultModel: string;
  readonly providerName: string;

  /** Dollars per million tokens, so cost can be reported per call. */
  private readonly inputPricePerMillion: number;
  private readonly outputPricePerMillion: number;

  constructor(config: ConfigService) {
    this.baseUrl = (config.get<string>('LLM_BASE_URL') ?? 'https://api.deepseek.com/v1').replace(/\/$/, '');
    this.apiKey = config.getOrThrow<string>('LLM_API_KEY');
    this.defaultModel = config.get<string>('LLM_MODEL') ?? 'deepseek-chat';
    this.providerName = config.get<string>('LLM_PROVIDER') ?? 'deepseek';
    this.inputPricePerMillion = Number(config.get<string>('LLM_INPUT_PRICE') ?? '0.27');
    this.outputPricePerMillion = Number(config.get<string>('LLM_OUTPUT_PRICE') ?? '1.10');
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const model = request.model ?? this.defaultModel;
    const started = Date.now();
    let ttfbMs: number | null = null;
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;

    const response = await this.post(
      {
        model,
        stream: true,
        // Ask for usage on the final chunk; without this the token counts are
        // absent from a streamed response and cost has to be guessed.
        stream_options: { include_usage: true },
        temperature: request.temperature ?? 0,
        max_tokens: request.maxTokens ?? 700,
        messages: request.messages,
      },
      request.signal,
    );

    for await (const event of readSseStream(response.body!, request.signal)) {
      const chunk = event as {
        choices?: { delta?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const token = chunk.choices?.[0]?.delta?.content;
      if (token) {
        if (ttfbMs === null) ttfbMs = Date.now() - started;
        text += token;
        request.onToken?.(token);
      }

      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? 0;
        outputTokens = chunk.usage.completion_tokens ?? 0;
      }
    }

    return {
      text: text.trim(),
      model,
      provider: this.providerName,
      inputTokens,
      outputTokens,
      costMicros: this.costMicros(inputTokens, outputTokens),
      latencyMs: Date.now() - started,
      ttfbMs,
    };
  }

  /** Cost in millionths of a dollar; integer arithmetic, no floating money. */
  costMicros(inputTokens: number, outputTokens: number): number {
    const dollars =
      (inputTokens / 1_000_000) * this.inputPricePerMillion +
      (outputTokens / 1_000_000) * this.outputPricePerMillion;

    return Math.round(dollars * 1_000_000);
  }

  private async post(body: unknown, signal?: AbortSignal): Promise<Response> {
    let response: Response;

    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(60_000),
      });
    } catch (error) {
      const name = (error as Error).name;
      // A timeout is worth retrying; a DNS failure usually is too.
      throw new LlmError(
        name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'upstream_error',
        `Request to ${this.providerName} failed: ${name}`,
      );
    }

    if (response.ok) return response;

    const detail = (await response.text().catch(() => '')).slice(0, 400);

    if (response.status === 429) {
      throw new LlmError('rate_limited', `Rate limited by ${this.providerName}`, retryAfterMs(response));
    }

    // 5xx is the provider's problem and usually transient; 4xx is ours and will
    // fail again identically, so it is not worth a retry.
    throw new LlmError(
      response.status >= 500 ? 'upstream_error' : 'invalid_output',
      `${this.providerName} returned ${response.status}: ${detail}`,
    );
  }
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;

  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

export type { ChatMessage };
