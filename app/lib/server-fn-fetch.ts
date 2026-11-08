import {
  TSS_CONTENT_TYPE_FRAMED,
  X_TSS_RAW_RESPONSE,
  X_TSS_SERIALIZED,
} from "@tanstack/react-start";
import type { CustomFetch } from "@tanstack/react-start";

import { errorMessage } from "./guards";

/**
 * A server function's call that got no answer Start can read (#3547), named by its method and path. Start's own
 * errors name nothing in production: its client throws a bare "Invariant failed" for an answer without a content type,
 * and the browser a bare "Failed to fetch". A path's id is the SHA-256 of `<file>--<name>_createServerFn_handler`,
 * the file relative to `apps/workspace` (`app/routes/_app/mail.tsx--getMail_createServerFn_handler`). The query is
 * left out: a GET call carries its data there, a mail search among it.
 */
export class ServerFnCallError extends Error {
  override name = "ServerFnCallError";

  /** "GET /_serverFn/<id>". */
  readonly call: string;

  constructor(call: string, problem: string, options?: ErrorOptions) {
    super(`${call} ${problem}`, options);
    this.call = call;
  }
}

/** What Start's client cannot read in an answer, or null (`getResponse` in `@tanstack/start-client-core`). */
const unreadable = (response: Response): string | null => {
  const raw = response.headers.get(X_TSS_RAW_RESPONSE);

  // A Response the function returned or threw itself, which Start passes on as it is.
  if (raw === "true" || raw === "thrown") {
    return null;
  }

  const type = response.headers.get("content-type");

  if (!type) {
    return "with no content type";
  }

  const serialized = Boolean(response.headers.get(X_TSS_SERIALIZED));

  const deserializable =
    type.includes("application/json") || type.includes(TSS_CONTENT_TYPE_FRAMED);

  return serialized && !deserializable
    ? `as ${type}, not a serialized result`
    : null;
};

const requestOf = (input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : null;

  const url = new URL(
    input instanceof Request ? input.url : input,
    "http://localhost"
  );

  return {
    call: `${init?.method ?? request?.method ?? "GET"} ${url.pathname}`,
    signal: init?.signal ?? request?.signal,
  };
};

/**
 * The fetch the console's loaders call their server functions with (`serverFn({ fetch })`): the page's own `fetch`, so
 * PostHog's tracing headers still go along, and a `ServerFnCallError` naming the call where Start would throw
 * something that names nothing. A call the page cancelled fails as it was.
 */
export const serverFnFetch: CustomFetch = async (input, init) => {
  const { call, signal } = requestOf(input, init);
  let response: Response;

  try {
    response = await fetch(input, init);
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }

    throw new ServerFnCallError(call, `failed: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  const problem = unreadable(response);

  if (problem) {
    throw new ServerFnCallError(call, `answered ${response.status} ${problem}`);
  }

  return response;
};
