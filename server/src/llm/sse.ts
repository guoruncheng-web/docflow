/**
 * Reads an OpenAI-compatible `text/event-stream` body.
 *
 * The buffering here is the whole point. A single SSE event is not guaranteed
 * to arrive in one chunk — the network can split `data: {"cho` from
 * `ices":[...]}` — so a reader that splits each chunk on newlines and parses
 * the pieces silently drops the fragment at the boundary. The symptom is
 * maddening: the model appears to emit malformed JSON, at random, on maybe one
 * call in six. It is not the model. Hold the trailing fragment until the
 * newline that ends it actually shows up.
 */
export async function* readSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      if (signal?.aborted) throw new Error('aborted');

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      // Whatever follows the last newline is incomplete; keep it for next time.
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const payload = trimmed.slice('data:'.length).trim();
        if (payload === '' || payload === '[DONE]') continue;

        try {
          yield JSON.parse(payload);
        } catch {
          // A provider that emits a non-JSON keepalive is not an error.
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
