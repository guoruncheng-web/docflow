import { readSseStream } from './sse';

/** Feeds the reader an exact sequence of chunks, byte boundaries included. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of readSseStream(streamOf(chunks))) events.push(event);
  return events;
}

describe('readSseStream', () => {
  it('reads whole events delivered one per chunk', async () => {
    const events = await collect([
      'data: {"n":1}\n\n',
      'data: {"n":2}\n\n',
      'data: [DONE]\n\n',
    ]);

    expect(events).toEqual([{ n: 1 }, { n: 2 }]);
  });

  /**
   * The regression this file exists for.
   *
   * Splitting each chunk on newlines and parsing the pieces loses whatever
   * straddles the boundary. In production it showed up as the model appearing
   * to emit malformed JSON on roughly one call in six, which sent the
   * investigation entirely the wrong way.
   */
  it('reassembles an event split across chunk boundaries', async () => {
    const events = await collect(['data: {"cho', 'ices":[{"delta":{"content":"hi"}}]}\n\n']);

    expect(events).toEqual([{ choices: [{ delta: { content: 'hi' } }] }]);
  });

  it('reassembles an event split mid-newline', async () => {
    const events = await collect(['data: {"n":1}\n', '\ndata: {"n":2}\n\n']);

    expect(events).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('handles several events arriving in one chunk', async () => {
    const events = await collect(['data: {"n":1}\n\ndata: {"n":2}\n\ndata: {"n":3}\n\n']);

    expect(events).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('ignores comments and keepalives without failing the stream', async () => {
    const events = await collect([': keepalive\n\n', 'data: {"n":1}\n\n', 'data: not-json\n\n']);

    expect(events).toEqual([{ n: 1 }]);
  });

  it('drops a trailing fragment that never completed rather than parsing half of it', async () => {
    const events = await collect(['data: {"n":1}\n\n', 'data: {"n":2']);

    expect(events).toEqual([{ n: 1 }]);
  });

  it('survives a multi-byte character split across chunks', async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('data: {"s":"日本"}\n\n');

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Cut inside the three-byte sequence for 日.
        controller.enqueue(bytes.slice(0, 14));
        controller.enqueue(bytes.slice(14));
        controller.close();
      },
    });

    const events: unknown[] = [];
    for await (const event of readSseStream(stream)) events.push(event);

    expect(events).toEqual([{ s: '日本' }]);
  });
});
