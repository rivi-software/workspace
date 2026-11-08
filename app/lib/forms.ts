import { redirect } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

/** Validator for server functions that take an HTML form submission. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a server function's validator: it receives whatever the client posted and is the boundary that checks it
export const formData = (input: unknown): FormData => {
  if (!(input instanceof FormData)) {
    throw new TypeError("Expected FormData");
  }

  return input;
};

/**
 * Keeps forms working without JavaScript. `useAction` renders `<form action={fn.url}>`, so when the
 * browser posts the form itself (no client script ran) the server function still executes; this
 * middleware then sends the browser back to the page instead of showing the serialized result.
 */
export const formPost = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    // oxlint-disable-next-line node/callback-return -- `next` is the middleware's continuation, awaited and read below, not a Node-style callback
    const res = await next();
    const request = getRequest();

    if (request.headers.get("sec-fetch-dest") === "document") {
      // SAFETY: a function middleware's `next()` resolves to an object whose `result` is the server function's return value; its type does not list it and only `instanceof Response` is asked of it.
      const out = res as typeof res & { result?: unknown };

      if (!(out.result instanceof Response)) {
        return {
          ...res,
          result: redirect({
            href: request.headers.get("referer") ?? "/",
            statusCode: 303,
          }),
        };
      }
    }

    return res;
  }
);
