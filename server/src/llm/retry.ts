import { LlmError } from './llm.types';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8_000 };

/**
 * Exponential backoff with full jitter.
 *
 * The jitter is not decoration. When a provider rate-limits, it usually
 * rate-limits every in-flight request at once; a fixed 1s/2s/4s schedule sends
 * the whole batch back in lockstep and re-triggers the limit. Spreading each
 * retry uniformly across its window breaks up the herd.
 *
 * `retryAfterMs` from the provider always wins — it knows when it will be ready
 * and guessing shorter just wastes an attempt.
 */
export function backoffDelay(attempt: number, policy: RetryPolicy, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, policy.maxDelayMs);

  const ceiling = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
  return Math.round(Math.random() * ceiling);
}

export interface AttemptRecord {
  attempt: number;
  outcome: string;
  error?: string;
  delayMs?: number;
}

/**
 * Runs `operation`, retrying the failures that are worth retrying and recording
 * every attempt. The record is what the UI draws its timeline from — a retry
 * nobody can see may as well not have happened.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    policy?: RetryPolicy;
    onAttempt?: (record: AttemptRecord) => void | Promise<void>;
    sleep?: (ms: number) => Promise<void>;
    /**
     * Overrides which failures are worth another attempt.
     *
     * The default refuses to retry `invalid_output`, because repeating an
     * identical request gets an identical answer. A caller that changes the
     * request between attempts — showing the model its rejected output and the
     * complaint, say — can retry it usefully and says so here, rather than
     * disguising the error as something else to slip past the policy.
     */
    isRetryable?: (error: unknown) => boolean;
  } = {},
): Promise<T> {
  const policy = options.policy ?? DEFAULT_RETRY;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const isRetryable =
    options.isRetryable ?? ((error: unknown) => error instanceof LlmError && error.retryable);

  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      const result = await operation(attempt);
      await options.onAttempt?.({ attempt, outcome: 'ok' });
      return result;
    } catch (error) {
      lastError = error;

      const kind = error instanceof LlmError ? error.kind : 'upstream_error';
      const retryable = isRetryable(error);
      const isLast = attempt === policy.maxAttempts;

      if (!retryable || isLast) {
        await options.onAttempt?.({ attempt, outcome: kind, error: (error as Error).message });
        break;
      }

      const delayMs = backoffDelay(
        attempt,
        policy,
        error instanceof LlmError ? error.retryAfterMs : undefined,
      );

      await options.onAttempt?.({ attempt, outcome: kind, error: (error as Error).message, delayMs });
      await sleep(delayMs);
    }
  }

  throw lastError;
}
