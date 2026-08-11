import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, dollars, money, streamProcessing, tokenStore } from "./api";

function streamOf(chunks: string[]): Response {
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("api", () => {
  it("sends the stored token as a bearer credential", async () => {
    tokenStore.write("a-token");
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await api("/documents");

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer a-token");
  });

  it("leaves the content type to the browser when sending a file", async () => {
    // Setting it by hand on a FormData body omits the multipart boundary, and
    // the request arrives as an unparseable blob.
    const fetchMock = vi.fn(async () => Response.json({ id: "1" }));
    vi.stubGlobal("fetch", fetchMock);

    await api("/documents/uploads", { method: "POST", body: new FormData() });

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("surfaces the API's message so a refusal reaches the user", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ message: "Only an approved record can be delivered." }, { status: 409 })),
    );

    await expect(api("/records/1/sync", { method: "POST" })).rejects.toThrow(
      "Only an approved record can be delivered.",
    );
  });

  it("carries the status code so a 401 can be told from a 409", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));

    const error = await api("/documents").catch((caught: ApiError) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
  });
});

describe("streamProcessing", () => {
  it("routes stages, tokens, attempts and the result to their handlers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamOf([
          'event: stage\ndata: {"stage":"reading","provider":"pdfjs-text-layer"}\n\n',
          'event: token\ndata: {"token":"{\\"vendorName\\""}\n\n',
          'event: attempt\ndata: {"attempt":1,"outcome":"ok"}\n\n',
          'event: done\ndata: {"recordId":"rec-1","findings":[],"costMicros":742,"latencyMs":3600}\n\n',
        ]),
      ),
    );

    const stages: string[] = [];
    const tokens: string[] = [];
    let done: { recordId: string } | null = null;

    await streamProcessing("doc-1", {
      onStage: (stage) => stages.push(stage),
      onToken: (token) => tokens.push(token),
      onDone: (payload) => (done = payload as never),
    });

    expect(stages).toEqual(["reading"]);
    expect(tokens).toEqual(['{"vendorName"']);
    expect(done).toMatchObject({ recordId: "rec-1" });
  });

  it("reassembles an event split across chunk boundaries", async () => {
    // The failure this prevents looks like the model emitting broken JSON once
    // every few runs, and sends you looking at the model.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamOf(['event: token\ndata: {"tok', 'en":"NW-2291"}\n\n'])),
    );

    const tokens: string[] = [];
    await streamProcessing("doc-1", { onToken: (token) => tokens.push(token) });

    expect(tokens).toEqual(["NW-2291"]);
  });

  it("reads several events packed into one chunk", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamOf(['event: token\ndata: {"token":"a"}\n\nevent: token\ndata: {"token":"b"}\n\n']),
      ),
    );

    const tokens: string[] = [];
    await streamProcessing("doc-1", { onToken: (token) => tokens.push(token) });

    expect(tokens).toEqual(["a", "b"]);
  });

  it("survives a multi-byte character split across chunks", async () => {
    const bytes = new TextEncoder().encode('event: token\ndata: {"token":"€"}\n\n');
    const encoder = new TextEncoder();
    const split = 30;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
    void encoder;

    const tokens: string[] = [];
    await streamProcessing("doc-1", { onToken: (token) => tokens.push(token) });

    expect(tokens).toEqual(["€"]);
  });

  it("reports a failure event rather than resolving as if it worked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamOf(['event: failed\ndata: {"message":"This PDF has no text layer."}\n\n'])),
    );

    const failures: string[] = [];
    await streamProcessing("doc-1", { onFailed: (message) => failures.push(message) });

    expect(failures).toEqual(["This PDF has no text layer."]);
  });

  it("throws when the request itself is rejected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ message: "No such document" }, { status: 404 })));

    await expect(streamProcessing("doc-1", {})).rejects.toThrow("No such document");
  });
});

describe("money", () => {
  it("renders integer minor units without floating point", () => {
    expect(money(57840, "USD")).toBe("USD 578.40");
    expect(money(5, "EUR")).toBe("EUR 0.05");
    expect(money(60720000, "JPY")).toBe("JPY 607,200.00");
  });

  it("shows an absent amount as absent rather than as zero", () => {
    expect(money(null)).toBe("—");
  });
});

describe("dollars", () => {
  it("renders integer micros as money", () => {
    expect(dollars(742)).toBe("$0.0007");
    expect(dollars(742, 5)).toBe("$0.00074");
  });
});
