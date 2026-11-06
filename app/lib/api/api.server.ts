import { captureServerException } from "@rivi-software/posthog-tanstack-start/server";

/**
 * The Workspace API for other clients (docs/API.md): `/api/v1`, served by the Worker before TanStack Start
 * (`workers/worker.ts`). A request carries a session token as a bearer token (`Authorization: Bearer …`, Better
 * Auth's `bearer` plugin), which `getSessionUser` turns into the person while the session stands. The routes are the
 * sections' modules beside this one, each a list of handlers over the same server modules the console's loaders
 * call. A handler answers JSON (`json`) or throws: a server module's own error becomes a `400` with its words
 * (`problemOf`), an `ApiRequestError` its status, and anything else a `500` reported to PostHog.
 */
import type { Database } from "~/db";
import { AssistantError } from "~/lib/assistant/chat.server";
import { getSessionUser } from "~/lib/auth.server";
import { CalendarError } from "~/lib/calendar/calendar.server";
import { DriveError } from "~/lib/drive/drive.server";
import { errorMessage } from "~/lib/guards";
import { ComposeNotFound } from "~/lib/mail/compose.server";
import { LabelError } from "~/lib/mail/labels.server";
import { ScheduleError } from "~/lib/mail/schedule.server";
import { SendError } from "~/lib/mail/send.server";
import { ThreadActionError } from "~/lib/mail/threads.server";
import { TaskError } from "~/lib/tasks/tasks.server";

import { assistantRoutes } from "./assistant.server";
import { calendarRoutes } from "./calendar.server";
import { driveRoutes } from "./drive.server";
import { mailRoutes } from "./mail.server";
import { meRoutes } from "./me.server";
import { ApiRequestError, matchRoute, problem } from "./routing.server";
import type { ApiContext, ApiRoute } from "./routing.server";
import { tasksRoutes } from "./tasks.server";

export { ApiRequestError, json, problem } from "./routing.server";

export type { ApiContext, ApiRoute } from "./routing.server";

/** The API's path under the Worker. */
export const API_PATH = "/api/v1";

export const isApiPath = (pathname: string): boolean =>
  pathname === API_PATH || pathname.startsWith(`${API_PATH}/`);

/** Every route of the API, by section. */
const ROUTES: ApiRoute[] = [
  ...meRoutes,
  ...mailRoutes,
  ...driveRoutes,
  ...calendarRoutes,
  ...tasksRoutes,
  ...assistantRoutes,
];

const unauthorized = (request: Request): Response =>
  problem("Sign in first.", 401, {
    "WWW-Authenticate": request.headers.get("authorization")
      ? 'Bearer error="invalid_token"'
      : 'Bearer realm="Workspace API"',
  });

/** The status a server module's own error answers with, and its words; null for an error nobody expected. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a catch clause holds whatever a handler threw; only the known errors become answers
const problemOf = (error: unknown): Response | null => {
  if (error instanceof ApiRequestError) {
    return problem(error.message, error.status);
  }

  if (error instanceof AssistantError) {
    return problem(error.message, error.status);
  }

  if (error instanceof ComposeNotFound) {
    return problem("That message is not yours.", 404);
  }

  if (
    error instanceof ThreadActionError ||
    error instanceof SendError ||
    error instanceof ScheduleError ||
    error instanceof LabelError ||
    error instanceof DriveError ||
    error instanceof CalendarError ||
    error instanceof TaskError
  ) {
    return problem(error.message, 400);
  }

  return null;
};

/** `/api/v1/*`: the token, the route, the person, then the section's handler. */
export const handleApi = async (
  request: Request,
  env: Env,
  db: Database
): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname.slice(API_PATH.length) || "/";
  const match = matchRoute(ROUTES, request.method, path);

  if (match === "no-path") {
    return problem("No such endpoint.", 404);
  }

  // The bearer token (or a session cookie) names the person, while they are active.
  const user = await getSessionUser(request, env, db);

  if (!user) {
    return unauthorized(request);
  }

  if (match === "no-method") {
    return problem("That endpoint takes another method.", 405);
  }

  const { route, params } = match;

  const context: ApiContext = {
    request,
    url,
    env,
    db,
    user,
    params,
    query: url.searchParams,
  };

  try {
    return await route.handler(context);
  } catch (error) {
    const answer = problemOf(error);

    if (answer) {
      return answer;
    }

    console.error(
      JSON.stringify({
        event: "api.error",
        method: request.method,
        path,
        error: errorMessage(error),
      })
    );
    captureServerException(error, { request, distinctId: user.id });

    return problem("Something went wrong. Try again in a moment.", 500);
  }
};
