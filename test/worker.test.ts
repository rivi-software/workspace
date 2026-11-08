import { installPostHogForTests } from "@rivi-software/posthog-tanstack-start/server";
// The Worker's own request handling (`workers/worker.ts`, CORE-1287): what it serves before TanStack Start (Better
// Auth and the API), the security headers every answer carries, earlier builds' assets, and errors reported on their
// way out. `exports.default` is the same Worker with a stand-in for Start (`test/worker-entry.ts`); the cases that
// need Start to answer something mount the Worker here with a Start of their own.
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorker } from "../workers/worker";
import type { Json } from "./fixtures";

/** A request as Workers hands it to `fetch`. */
const incoming = (url: string | URL, init?: RequestInit) =>
  // SAFETY: Workers adds `cf` to the request it hands `fetch`; nothing in workers/ or app/ reads `request.cf`,
  // so a plain Request stands in for it.
  new Request(url, init) as Request<unknown, IncomingRequestCfProperties>;

/** The Worker with `start` behind it, called as Workers would call it. */
const workerWith = (
  start: (request: Request) => Response | Promise<Response>
) => {
  const worker = createWorker(start);

  return (path: string, init?: RequestInit) =>
    worker.fetch(incoming(new URL(path, env.APP_URL), init), env);
};

describe("the Worker", () => {
  afterEach(() => installPostHogForTests(null));

  it("serves Better Auth and the API itself, and everything else through Start", async () => {
    const start = vi.fn<() => Response>(() => new Response("from Start"));
    const fetchPath = workerWith(start);

    // No cookie: no session, which Better Auth answers as JSON.
    const session = await fetchPath("/api/auth/get-session");
    const sessionBody: Json = await session.json();
    const me = await fetchPath("/api/v1/me");

    expect({
      session: [session.status, sessionBody],
      me: [me.status, me.headers.get("www-authenticate")],
      started: start.mock.calls.length,
    }).toStrictEqual({
      session: [200, null],
      me: [401, 'Bearer realm="Workspace API"'],
      started: 0,
    });

    const page = await fetchPath("/mail?folder=inbox");

    expect({
      page: await page.text(),
      started: start.mock.calls.length,
    }).toStrictEqual({ page: "from Start", started: 1 });
  });

  it("puts the baseline security headers on what the tests reach through exports.default", async () => {
    const res = await exports.default.fetch(
      `${env.APP_URL}/api/auth/get-session`
    );

    expect({
      status: res.status,
      xContentTypeOptions: res.headers.get("X-Content-Type-Options"),
      referrerPolicy: res.headers.get("Referrer-Policy"),
      xFrameOptions: res.headers.get("X-Frame-Options"),
      contentSecurityPolicy: res.headers.get("Content-Security-Policy"),
      strictTransportSecurity: res.headers.get("Strict-Transport-Security"),
    }).toStrictEqual({
      status: 200,
      xContentTypeOptions: "nosniff",
      referrerPolicy: "strict-origin-when-cross-origin",
      xFrameOptions: "DENY",
      contentSecurityPolicy: "frame-ancestors 'none'",
      strictTransportSecurity: "max-age=31536000; includeSubDomains",
    });
  });

  it("adds the frame rule to a response's own policy and keeps a frame rule the response set", async () => {
    const fetchPath = workerWith((request) => {
      const { pathname } = new URL(request.url);

      // A served file's sandbox (mail's and Drive's file routes): never framed.
      if (pathname === "/api/files/one") {
        return new Response("file", {
          headers: { "Content-Security-Policy": "sandbox; default-src 'none'" },
        });
      }

      // A Drive PDF, which the file page frames.
      return new Response("pdf", {
        headers: {
          "Content-Security-Policy":
            "default-src 'none'; frame-ancestors 'self'",
          "X-Frame-Options": "SAMEORIGIN",
        },
      });
    });

    const file = await fetchPath("/api/files/one");
    expect(file.headers.get("Content-Security-Policy")).toBe(
      "sandbox; default-src 'none'; frame-ancestors 'none'"
    );
    expect(file.headers.get("X-Frame-Options")).toBe("DENY");

    const pdf = await fetchPath("/api/drive/files/one");
    expect(pdf.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; frame-ancestors 'self'"
    );
    expect(pdf.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });

  it("sends Strict-Transport-Security over HTTPS only", async () => {
    const worker = createWorker(() => new Response("page"));

    const plain = await worker.fetch(
      incoming("http://localhost:5174/mail"),
      env
    );

    expect(plain.headers.get("Strict-Transport-Security")).toBeNull();
    expect(plain.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("answers an earlier build's file from the store, and a 404 for one it does not hold", async () => {
    const start = vi.fn<() => Response>(() => new Response("from Start"));
    const fetchPath = workerWith(start);
    await env.PREVIOUS_ASSETS.put(
      "assets/index-old.js",
      "export const old = 1;",
      {
        metadata: { contentType: "text/javascript" },
      }
    );

    const kept = await fetchPath("/assets/index-old.js");
    expect({
      status: kept.status,
      contentType: kept.headers.get("content-type"),
      keptText: await kept.text(),
      xContentTypeOptions: kept.headers.get("X-Content-Type-Options"),
    }).toStrictEqual({
      status: 200,
      contentType: "text/javascript",
      keptText: "export const old = 1;",
      xContentTypeOptions: "nosniff",
    });

    const gone = await fetchPath("/assets/index-never.js");
    expect(gone.status).toBe(404);
    expect(start).not.toHaveBeenCalled();
  });

  it("reports an error that escapes Start, with the request's path, and rethrows it", async () => {
    const captured: { error: unknown; properties: Record<string, string> }[] =
      [];

    installPostHogForTests({
      captureImmediate: () => Promise.resolve(),
      captureExceptionImmediate: (error, _distinctId, properties) => {
        captured.push({ error, properties: properties ?? {} });

        return Promise.resolve();
      },
    });
    const boom = new Error("Start fell over");

    const fetchPath = workerWith(() => {
      throw boom;
    });

    await expect(fetchPath("/mail?q=private")).rejects.toBe(boom);
    expect(captured).toHaveLength(1);
    expect(captured[0].error).toBe(boom);
    expect(captured[0].properties).toMatchObject({
      $pathname: "/mail",
      request_method: "GET",
    });
    // The query (a search, a token) stays out of what is reported.
    expect(JSON.stringify(captured[0].properties)).not.toContain("private");
  });
});
