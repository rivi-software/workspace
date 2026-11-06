/** The Calendar section of the Workspace API (docs/API.md): a range of occurrences with the person's tasks, and their own events. */
import { daysBetween, isDayKey, isRepeat } from "~/lib/calendar/calendar";
import {
  createEvent,
  deleteEvent,
  listEvents,
  respondToEvent,
  updateEvent,
} from "~/lib/calendar/calendar.server";
import type { EventInput } from "~/lib/calendar/calendar.server";
import { colleagues } from "~/lib/drive/drive.server";
import { stringList } from "~/lib/guards";
import { tasksDue } from "~/lib/tasks/tasks.server";

import { field, fieldOrNull, readBody } from "./body.server";
import type { JsonBody } from "./body.server";
import { ApiRequestError, json } from "./routing.server";
import type { ApiContext, ApiRoute } from "./routing.server";

/** The most days one request reads: two months, a day of leeway each side. */
const MAX_RANGE_DAYS = 64;

const range = async (context: ApiContext): Promise<Response> => {
  const { db, user, query } = context;
  const from = query.get("from") ?? "";
  const to = query.get("to") ?? "";

  if (!isDayKey(from) || !isDayKey(to)) {
    throw new ApiRequestError("Ask for a range of days, from and to.");
  }

  const days = daysBetween(from, to);

  if (days < 1 || days > MAX_RANGE_DAYS) {
    throw new ApiRequestError(
      `Ask for one to ${MAX_RANGE_DAYS} days at a time.`
    );
  }

  const [events, tasks, people] = await Promise.all([
    listEvents(db, user.id, `${from}T00:00:00.000Z`, `${to}T00:00:00.000Z`),
    tasksDue(db, user.id, from, to),
    colleagues(db, user.id),
  ]);

  return json({ from, to, events, tasks, colleagues: people });
};

const eventInput = (body: JsonBody): EventInput => {
  const repeat = fieldOrNull(body, "repeat") ?? "none";

  if (!isRepeat(repeat)) {
    throw new ApiRequestError("Choose a repeat.");
  }

  return {
    title: field(body, "title"),
    description: field(body, "description"),
    location: field(body, "location"),
    startsAt: field(body, "startsAt"),
    endsAt: field(body, "endsAt"),
    allDay: body.allDay === true,
    timeZone: fieldOrNull(body, "timeZone") ?? undefined,
    repeat,
    repeatUntil: fieldOrNull(body, "repeatUntil"),
    attendees: stringList(body.attendees),
  };
};

const create = async (context: ApiContext): Promise<Response> => {
  const { db, user, request } = context;

  const event = await createEvent(
    db,
    user.id,
    eventInput(await readBody(request))
  );

  return json({ ok: true, event });
};

const update = async (context: ApiContext): Promise<Response> => {
  const { db, user, request, params } = context;

  const event = await updateEvent(
    db,
    user.id,
    params.id ?? "",
    eventInput(await readBody(request))
  );

  return json({ ok: true, event });
};

const remove = async (context: ApiContext): Promise<Response> => {
  const { db, user, params } = context;

  if (!(await deleteEvent(db, user.id, params.id ?? ""))) {
    throw new ApiRequestError("No such event of yours.", 404);
  }

  return json({ ok: true });
};

const respond = async (context: ApiContext): Promise<Response> => {
  const { db, user, request, params } = context;
  const body = await readBody(request);

  const event = await respondToEvent(
    db,
    user.id,
    params.id ?? "",
    field(body, "status")
  );

  return json({ ok: true, event });
};

export const calendarRoutes: ApiRoute[] = [
  { method: "GET", path: "/calendar", handler: range },
  { method: "POST", path: "/calendar/events", writes: true, handler: create },
  {
    method: "PUT",
    path: "/calendar/events/:id",
    writes: true,
    handler: update,
  },
  {
    method: "DELETE",
    path: "/calendar/events/:id",
    writes: true,
    handler: remove,
  },
  {
    method: "POST",
    path: "/calendar/events/:id/respond",
    writes: true,
    handler: respond,
  },
];
