import { afterEach, describe, expect, it, vi } from "vitest";

import { ServerFnCallError, serverFnFetch } from "~/lib/server-fn-fetch";

// Start's client calls a GET server function with its data in the query, a mail search among it.
const CALL =
  "/_serverFn/9f86d081884c7d65?payload=%7B%22q%22%3A%22invoice%22%7D";

const answering = (response: Response) =>
  vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

const thrown = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("Expected the call to fail");
};

describe("a server function's call from a /mail loader (#3547)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names the call when the answer has no content type, where Start throws a bare invariant", async () => {
    answering(new Response(null, { status: 200 }));

    const error = await thrown(serverFnFetch(CALL, { method: "GET" }));

    expect(error).toBeInstanceOf(ServerFnCallError);
    expect(error).toMatchObject({
      call: "GET /_serverFn/9f86d081884c7d65",
      message:
        "GET /_serverFn/9f86d081884c7d65 answered 200 with no content type",
    });
  });

  it("names the call when a serialized answer is neither JSON nor framed", async () => {
    answering(
      new Response("<html></html>", {
        headers: { "content-type": "text/html", "x-tss-serialized": "true" },
      })
    );

    const error = await thrown(serverFnFetch(CALL, { method: "GET" }));

    expect(error).toMatchObject({
      message:
        "GET /_serverFn/9f86d081884c7d65 answered 200 as text/html, not a serialized result",
    });
  });

  it("names the call when the request itself fails, and keeps the browser's error as the cause", async () => {
    const offline = new TypeError("Failed to fetch");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(offline);

    const error = await thrown(serverFnFetch(CALL, { method: "GET" }));

    expect(error).toBeInstanceOf(ServerFnCallError);
    expect(error).toMatchObject({
      message: "GET /_serverFn/9f86d081884c7d65 failed: Failed to fetch",
      cause: offline,
    });
  });

  it("never puts the call's query in what it reports", async () => {
    answering(new Response(null, { status: 502 }));

    const error = await thrown(serverFnFetch(CALL, { method: "GET" }));

    expect(String(error)).not.toContain("invoice");
    expect(String(error)).not.toContain("payload");
  });

  it("leaves a call the page cancelled as it was", async () => {
    const controller = new AbortController();
    controller.abort();

    const aborted = new DOMException(
      "The operation was aborted.",
      "AbortError"
    );

    vi.spyOn(globalThis, "fetch").mockRejectedValue(aborted);

    await expect(
      serverFnFetch(CALL, { method: "GET", signal: controller.signal })
    ).rejects.toBe(aborted);
  });

  it("passes every answer Start reads on to it unchanged", async () => {
    const readable = [
      // A result, serialized as JSON or framed.
      Response.json(
        { result: {} },
        { headers: { "x-tss-serialized": "true" } }
      ),
      new Response("", {
        headers: {
          "content-type": "application/x-tss-framed; v=1",
          "x-tss-serialized": "true",
        },
      }),
      // A redirect to /login or a notFound, as plain JSON.
      Response.json({ isSerializedRedirect: true, to: "/login" }),
      // A Response the function returned or threw itself, which needs no content type.
      new Response(null, { headers: { "x-tss-raw": "true" } }),
      new Response(null, { status: 403, headers: { "x-tss-raw": "thrown" } }),
      // The CSRF middleware's refusal, which Start turns into an error of its own.
      new Response("Forbidden", { status: 403 }),
    ];

    for (const response of readable) {
      answering(response);
      // oxlint-disable-next-line no-await-in-loop -- one stubbed answer at a time
      await expect(serverFnFetch(CALL, { method: "GET" })).resolves.toBe(
        response
      );
    }
  });

  it("calls the page's own fetch, so the SDKs that wrap it still see the call", async () => {
    const spy = answering(Response.json({ result: {} }));

    await serverFnFetch(CALL, { method: "GET" });

    expect(spy).toHaveBeenCalledWith(CALL, { method: "GET" });
  });
});
