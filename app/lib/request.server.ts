import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";

import { createDb } from "~/db";

import { requireUser } from "./auth.server";

/**
 * Common per-request context for signed-in code. Call it inside server functions and server route
 * handlers: the current Request comes from TanStack Start's request context.
 */
export const appContext = async () => {
  const request = getRequest();
  const db = createDb(env.DB);
  const user = await requireUser(request, env, db);

  return { env, db, user, request };
};

/** What `appContext` resolves to, for a helper's parameter: a type import never loads this module in the client. */
export type AppContext = Awaited<ReturnType<typeof appContext>>;

export const isSecure = (request: Request) =>
  new URL(request.url).protocol === "https:";
