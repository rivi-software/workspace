/**
 * The small router of the Workspace API (`api.server.ts`): a route is a method and a path with `:name` segments, and
 * a handler over the request's context. Kept apart from the entry so the sections' modules import nothing that
 * imports them back.
 */
import type { Database } from "~/db";
import type { User } from "~/db/schema";

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiContext {
  request: Request;
  url: URL;
  env: Env;
  db: Database;
  user: User;
  /** The route's `:name` segments. */
  params: Record<string, string>;
  query: URLSearchParams;
}

export type ApiHandler = (context: ApiContext) => Promise<Response>;

export interface ApiRoute {
  method: ApiMethod;
  /** Under `/api/v1`: `/mail/threads/:id`. */
  path: string;
  /** Whether the route changes something, for the reader of the list; every session may. */
  writes?: boolean;
  handler: ApiHandler;
}

/** A handler's answer that is a problem of the request: its words and status. */
export class ApiRequestError extends Error {
  override name = "ApiRequestError";
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const NO_STORE = { "Cache-Control": "no-store" };

export const json = (
  // oxlint-disable-next-line anti-slop/no-object-parameters -- each endpoint's own answer, typed where it is built: `Response.json` serialises any object
  data: object,
  status = 200,
  headers: Record<string, string> = {}
): Response =>
  Response.json(data, { status, headers: { ...NO_STORE, ...headers } });

export const problem = (
  error: string,
  status = 400,
  headers: Record<string, string> = {}
): Response => json({ ok: false, error }, status, headers);

const segments = (path: string): string[] => path.split("/").filter(Boolean);

/** The route's params when `path` fits its pattern, else null. */
const paramsOf = (
  pattern: string,
  path: string
): Record<string, string> | null => {
  const wanted = segments(pattern);
  const given = segments(path);

  if (wanted.length !== given.length) {
    return null;
  }

  const params: Record<string, string> = {};

  for (const [i, part] of wanted.entries()) {
    const value = given[i] ?? "";

    if (part.startsWith(":")) {
      try {
        params[part.slice(1)] = decodeURIComponent(value);
      } catch {
        return null;
      }
    } else if (part !== value) {
      return null;
    }
  }

  return params;
};

export type RouteMatch =
  | { route: ApiRoute; params: Record<string, string> }
  /** The path is served, by other methods. */
  | "no-method"
  | "no-path";

/** The first route whose method and pattern fit, with its params. */
export const matchRoute = (
  routes: ApiRoute[],
  method: string,
  path: string
): RouteMatch => {
  let pathKnown = false;

  for (const route of routes) {
    const params = paramsOf(route.path, path);

    if (!params) {
      continue;
    }

    pathKnown = true;

    if (route.method === method) {
      return { route, params };
    }
  }

  return pathKnown ? "no-method" : "no-path";
};
