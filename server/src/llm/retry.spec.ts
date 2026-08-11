import { LlmError } from './llm.types';
import { AttemptRecord, DEFAULT_RETRY, backoffDelay, withRetry } from './retry';

describe('backoffDelay', () => {
  it('obeys the provider’s retry-after instead of guessing', () => {
    expect(backoffDelay(1, DEFAULT_RETRY, 2_500)).toBe(2_500);
  });

  it('caps retry-after at the policy maximum so a hostile header cannot stall us', () => {
    expect(backoffDelay(1, DEFAULT_RETRY, 60_000)).toBe(DEFAULT_RETRY.maxDelayMs);
  });

  it('grows the ceiling exponentially and never exceeds the cap', () => {
    const policy = { maxAttempts: 6, baseDelayMs: 100, maxDelayMs: 800 };

    for (const [attempt, ceiling] of [
      [1, 100],
      [2, 200],
      [3, 400],
      [4, 800],
      [5, 800],
    ] as const) {
      for (let i = 0; i < 40; i += 1) {
        const delay = backoffDelay(attempt, policy);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  /**
   * Full jitter is the point, not decoration: a provider that rate-limits
   * usually rate-limits every in-flight request at once, and a fixed schedule
   * sends the whole batch back in lockstep to trip the limit again.
   */
  it('spreads delays rather than returning a fixed schedule', () => {
    const policy = { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 8_000 };
    const seen = new Set(Array.from({ length: 50 }, () => backoffDelay(3, policy)));

    expect(seen.size).toBeGreaterThan(5);
  });
});

describe('withRetry', () => {
  const noSleep = () => Promise.resolve();

  it('returns the first success without retrying', async () => {
    const operation = jest.fn().mockResolvedValue('ok');

    await expect(withRetry(operation, { sleep: noSleep })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries a rate limit and succeeds on a later attempt', async () => {
    const operation = jest
      .fn()
      .mockRejectedValueOnce(new LlmError('rate_limited', 'slow down', 10))
      .mockResolvedValue('ok');

    await expect(withRetry(operation, { sleep: noSleep })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not retry invalid output by default, because the same request repeats the same answer', async () => {
    const operation = jest.fn().mockRejectedValue(new LlmError('invalid_output', 'bad json'));

    await expect(withRetry(operation, { sleep: noSleep })).rejects.toThrow('bad json');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries invalid output when the caller says the next request differs', async () => {
    const operation = jest
      .fn()
      .mockRejectedValueOnce(new LlmError('invalid_output', 'bad json'))
      .mockResolvedValue('repaired');

    await expect(
      withRetry(operation, { sleep: noSleep, isRetryable: (error) => error instanceof LlmError }),
    ).resolves.toBe('repaired');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('gives up after the policy’s attempt limit and rethrows the last error', async () => {
    const operation = jest.fn().mockRejectedValue(new LlmError('upstream_error', 'boom'));

    await expect(
      withRetry(operation, { sleep: noSleep, policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 } }),
    ).rejects.toThrow('boom');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('reports every attempt so the UI can draw the timeline', async () => {
    const records: AttemptRecord[] = [];

    await withRetry(
      jest.fn().mockRejectedValueOnce(new LlmError('rate_limited', 'slow down', 25)).mockResolvedValue('ok'),
      { sleep: noSleep, onAttempt: (record) => void records.push(record) },
    );

    expect(records).toEqual([
      { attempt: 1, outcome: 'rate_limited', error: 'slow down', delayMs: 25 },
      { attempt: 2, outcome: 'ok' },
    ]);
  });

  it('does not report a wait on the attempt it gives up on', async () => {
    const records: AttemptRecord[] = [];

    await withRetry(jest.fn().mockRejectedValue(new LlmError('invalid_output', 'bad')), {
      sleep: noSleep,
      onAttempt: (record) => void records.push(record),
    }).catch(() => undefined);

    expect(records).toEqual([{ attempt: 1, outcome: 'invalid_output', error: 'bad' }]);
  });
});
