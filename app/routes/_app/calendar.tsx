import { createFileRoute } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  CalendarPage,
  serverToday,
  viewRange,
} from "~/components/calendar/calendar";
import type { CalendarData } from "~/components/calendar/calendar";
import { SectionError } from "~/components/section-error";
import { isCalendarView, isDayKey } from "~/lib/calendar/calendar";
import type { CalendarView } from "~/lib/calendar/calendar";
import { listEvents } from "~/lib/calendar/calendar.server";
import { colleagues } from "~/lib/drive/drive.server";
import { keepShown } from "~/lib/keep-shown";
import { appContext } from "~/lib/request.server";
import { serverFnFetch } from "~/lib/server-fn-fetch";
import { tasksDue } from "~/lib/tasks/tasks.server";

// The router keeps search values as strings; a date would otherwise come back as a number.
const searchSchema = z.object({
  view: z.string().optional(),
  date: z.coerce.string().optional(),
});

interface Deps {
  view?: string;
  date?: string;
}

const getCalendar = createServerFn()
  .validator((d: Deps) => d)
  .handler(async ({ data }): Promise<CalendarData> => {
    const { db, user } = await appContext();
    const view: CalendarView = isCalendarView(data.view) ? data.view : "week";
    const date = isDayKey(data.date) ? data.date : null;
    // A day's leeway each side: the reader's zone puts a UTC day's events a day earlier or later.
    const { from, to } = viewRange(view, date ?? serverToday());

    const [events, tasks, people] = await Promise.all([
      listEvents(db, user.id, `${from}T00:00:00.000Z`, `${to}T00:00:00.000Z`),
      tasksDue(db, user.id, from, to),
      colleagues(db, user.id),
    ]);

    return { view, date, events, tasks, colleagues: people };
  });

const CalendarRoute = () => <CalendarPage data={Route.useLoaderData()} />;

/** What takes the calendar's place when it cannot load and there is nothing to keep (#3548). */
const CalendarError = ({ error }: ErrorComponentProps) => (
  <SectionError error={error} title="Calendar didn't load" />
);

/** The calendar (#3111): a week or a month (`?view=month`) on a day (`?date=YYYY-MM-DD`, today without). */
export const Route = createFileRoute("/_app/calendar")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ view: search.view, date: search.date }),
  // The week or month stays when the minute's refresh cannot load it again (#3548).
  loader: (run) =>
    keepShown(run, () => getCalendar({ data: run.deps, fetch: serverFnFetch })),
  head: () => ({ meta: [{ title: "Calendar · Workspace" }] }),
  component: CalendarRoute,
  errorComponent: CalendarError,
});
