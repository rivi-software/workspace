/** A request's JSON body as the sections' handlers read it: an object whose members stay `unknown` until a reader checks each. */
import type { parseJsonObject } from "~/lib/guards";
import { isJsonObject, stringOrNull } from "~/lib/guards";

import { ApiRequestError } from "./routing.server";

/** The object a request's JSON body is, each member still `unknown` until a handler reads it (`field`, `idsOf`). */
export type JsonBody = ReturnType<typeof parseJsonObject>;

/** The JSON object a request's body holds; a problem for anything else. */
export const readBody = async (request: Request): Promise<JsonBody> => {
  if (
    !/^application\/json\b/iu.test(request.headers.get("content-type") ?? "")
  ) {
    throw new ApiRequestError("Send JSON.", 415);
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    throw new ApiRequestError("The body is not JSON.", 400);
  }

  if (!isJsonObject(body) || Array.isArray(body)) {
    throw new ApiRequestError("Send a JSON object.", 400);
  }

  return body;
};

/** A body's string field, trimmed; empty when it is missing or no string. */
export const field = (body: JsonBody, key: string): string =>
  (stringOrNull(body[key]) ?? "").trim();

/** A body's string field, or null when it is missing, empty or no string. */
export const fieldOrNull = (body: JsonBody, key: string): string | null =>
  field(body, key) || null;

/** A body's list of ids (`ids`, or `id` for one): the strings among them, at most `max`. */
export const idsOf = (body: JsonBody, max = 500): string[] => {
  const raw = body.ids;

  if (Array.isArray(raw)) {
    return raw
      .filter((id): id is string => stringOrNull(id) !== null && id !== "")
      .slice(0, max);
  }

  const one = fieldOrNull(body, "id");

  return one ? [one] : [];
};

/** The objects among a body's list field; anything else, and any entry that is no object, is left out. */
export const objectList = (body: JsonBody, key: string): JsonBody[] => {
  const raw = body[key];

  return Array.isArray(raw) ? raw.filter(isJsonObject) : [];
};
