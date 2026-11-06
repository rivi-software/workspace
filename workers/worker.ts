import {
  isAssetRequest,
  servePreviousAsset,
} from "@rivi-software/cloudflare-deploy/previous-assets";
import { captureServerException } from "@rivi-software/posthog-tanstack-start/server";

import { createDb } from "~/db";
import { handleApi, isApiPath } from "~/lib/api/api.server";
import { authFor, isAuthPath } from "~/lib/auth.server";

import { handleInboundEmail } from "./email/inbound";
import { handleScheduled } from "./scheduled";

/**
 * What answers the requests the Worker does not serve itself: TanStack Start (SSR pages, server functions, the server
 * routes under /api) in production. The tests mount the same Worker with a stand-in, since Start needs the Vite build.
 */
export type StartHandler = (request: Request) => Response | Promise<Response>;

/** Baseline browser hardening for every page and API response. Nothing here is meant to be framed. */
const withSecurityHeaders = (res: Response, url: URL): Response => {
  if (res.status === 101) {
    return res;
  }

  const out = new Response(res.body, res);
  const h = out.headers;
  h.set("X-Content-Type-Options", "nosniff");

  // A response may ask for less (a file through a link outside the workspace sends no referrer at all).
  if (!h.has("Referrer-Policy")) {
    h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  }

  // A response that set its own frame policy keeps it (a Drive PDF the file page frames); the rest is never framed.
  // A policy of its own (the sandbox on a served file) gets the frame rule added, not replaced.
  if (!h.has("X-Frame-Options")) {
    // A constant; the rule mistakes `res.headers` for an Express request's headers.
    // nosemgrep: x-frame-options-misconfiguration
    h.set("X-Frame-Options", "DENY");
  }

  const csp = h.get("Content-Security-Policy");

  if (!csp) {
    h.set("Content-Security-Policy", "frame-ancestors 'none'");
  } else if (!/frame-ancestors/u.test(csp)) {
    h.set("Content-Security-Policy", `${csp}; frame-ancestors 'none'`);
  }

  if (url.protocol === "https:") {
    h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  return out;
};

/**
 * Better Auth (`/api/auth/*`: the password sign-in, passkeys, the second factor, sessions), the API for other
 * clients (`/api/v1/*`, docs/API.md), then Start. Served here rather than by route files, so the tests reach them
 * through `SELF.fetch` without the Vite build.
 */
const route = async (
  request: Request,
  env: Env,
  db: ReturnType<typeof createDb>,
  url: URL,
  start: StartHandler
): Promise<Response> => {
  if (isAuthPath(url.pathname)) {
    const auth = await authFor(env);

    return auth.handler(request);
  }

  if (isApiPath(url.pathname)) {
    return handleApi(request, env, db);
  }

  return start(request);
};

const handleFetch = async (
  request: Request,
  env: Env,
  start: StartHandler
): Promise<Response> => {
  const url = new URL(request.url);

  // A build file the live version does not have (static assets answer the ones it has): a chunk of an earlier
  // build, which a tab opened before the last deploy may still import.
  if (isAssetRequest(request, url)) {
    return withSecurityHeaders(
      await servePreviousAsset(request, env.PREVIOUS_ASSETS),
      url
    );
  }

  const db = createDb(env.DB);

  return withSecurityHeaders(await route(request, env, db, url, start), url);
};

/**
 * The Worker's handlers around `start`: `fetch` (earlier builds' assets, Better Auth, the API, then `start`; the
 * security headers on every answer), `email` (inbound mail) and `scheduled` (the cron, every minute). Errors that
 * escape `fetch` or `email` are reported to PostHog and rethrown, so Workers logs and traces still record them.
 */
export const createWorker = (start: StartHandler) =>
  ({
    async fetch(request, env) {
      try {
        return await handleFetch(request, env, start);
      } catch (error) {
        captureServerException(error, { request });
        throw error;
      }
    },

    async email(message, env) {
      try {
        await handleInboundEmail(message, env);
      } catch (error) {
        captureServerException(error, { properties: { handler: "email" } });
        throw error;
      }
    },

    // Every minute: snoozed conversations that are due, scheduled messages that are due, and a batch of each running
    // mailbox import.
    async scheduled(_controller, env) {
      await handleScheduled(env);
    },
  }) satisfies ExportedHandler<Env>;
