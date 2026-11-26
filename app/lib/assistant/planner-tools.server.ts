import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";

import type { Database } from "~/db";
import type { User } from "~/db/schema";
import {
  addDays,
  allDayRange,
  calendarHref,
  daysBetween,
  parseDay,
  utcDay,
} from "~/lib/calendar/calendar";
import type { DayKey } from "~/lib/calendar/calendar";
import {
  CalendarError,
  createEvent,
  listEvents,
} from "~/lib/calendar/calendar.server";
import type { EventOccurrence } from "~/lib/calendar/calendar.server";
import { assignedIssues } from "~/lib/tasks/github.server";
import type { GitHubWork } from "~/lib/tasks/github.server";
import { groupTasks, issueLabel, tasksHref } from "~/lib/tasks/tasks";
import { TaskError, createTask, listTasks } from "~/lib/tasks/tasks.server";
import { truncate } from "~/lib/text";

import type { AskContext } from "./time";
import { zonedDay, zonedMoment, zonedStamp } from "./time";

/** At most this many days one look at the calendar spans, and this many occurrences it answers. */
const MAX_RANGE_DAYS = 62;
const MAX_EVENTS = 60;

/** At most this many tasks one listing answers. */
const MAX_TASKS = 100;

/** An event's description and a task's notes, cut at this length. */
const MAX_NOTE_CHARS = 500;

const DAY_MS = 86_400_000;

/** An event made without an end lasts this long. */
const DEFAULT_EVENT_MINUTES = 60;

/** A day as the model writes one for a tool. */
export const dayInput = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "A day is written YYYY-MM-DD.");

/** A time of day as the model writes one for a tool. */
export const timeInput = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u, "A time is written HH:MM.");

/** The first and last day an occurrence covers: an all-day one's stored days, a timed one's on the person's clock. */
const daysOf = (o: EventOccurrence, timeZone: string): [DayKey, DayKey] => {
  // The end is exclusive: a moment at midnight ends the day before.
  const last = new Date(Date.parse(o.end) - 1);

  return o.allDay
    ? [utcDay(o.start), utcDay(last)]
    : [zonedDay(o.start, timeZone), zonedDay(last, timeZone)];
};

const eventSummary = (o: EventOccurrence, timeZone: string) => {
  const [first, last] = daysOf(o, timeZone);

  // No id: every occurrence of a repeat shares its event's, and no tool takes one.
  return {
    title: o.title,
    allDay: o.allDay,
    // An all-day event answers its days, a timed one its moments on the person's clock.
    start: o.allDay ? first : zonedStamp(o.start, timeZone),
    end: o.allDay ? last : zonedStamp(o.end, timeZone),
    location: o.location || undefined,
    description: truncate(o.description, MAX_NOTE_CHARS) || undefined,
    organizer: o.mine ? "me" : o.owner.name,
    myAnswer: o.myStatus ?? undefined,
    guests: o.attendees.map((a) => `${a.name} (${a.status})`),
    repeats: o.repeat === "none" ? undefined : o.repeat,
    link: calendarHref("week", first),
  };
};

/** The day after `on`, or `on` itself when it is no day (which `momentOn` then refuses). */
const addDaysOrNull = (on: DayKey): DayKey =>
  parseDay(on) ? addDays(on, 1) : on;

/** When an event the model described starts and ends, as Calendar stores it, or why it cannot be. */
const eventSpan = (
  when: {
    date: DayKey;
    startTime?: string;
    endTime?: string;
    endDate?: DayKey;
  },
  timeZone: string
):
  | { startsAt: string; endsAt: string; allDay: boolean }
  | { error: string } => {
  const lastDay = when.endDate ?? when.date;

  if (!parseDay(when.date) || !parseDay(lastDay)) {
    return { error: "That is no day on the calendar." };
  }

  if (lastDay < when.date) {
    return { error: "The event ends before it starts." };
  }

  if (!when.startTime) {
    return when.endTime
      ? { error: "An event with an end time needs a start time." }
      : { ...allDayRange(when.date, lastDay), allDay: true };
  }

  const start = zonedMoment(when.date, when.startTime, timeZone);

  const end = when.endTime
    ? zonedMoment(lastDay, when.endTime, timeZone)
    : start && new Date(start.getTime() + DEFAULT_EVENT_MINUTES * 60_000);

  if (!start || !end) {
    return { error: "That is no day on the calendar." };
  }

  // An end that only names a time earlier than the start runs into the next day ("23:00 to 01:00").
  const endsAt =
    end.getTime() <= start.getTime() && !when.endDate
      ? zonedMoment(addDays(lastDay, 1), when.endTime, timeZone)
      : end;

  if (!endsAt || endsAt.getTime() <= start.getTime()) {
    return { error: "The event ends before it starts." };
  }

  return {
    startsAt: start.toISOString(),
    endsAt: endsAt.toISOString(),
    allDay: false,
  };
};

/** Why `list_tasks` answers no issues, so the model says they are missing rather than that there are none. */
const issuesNote = (github: GitHubWork): string | undefined => {
  if (!github.connected) {
    return "The person has not connected GitHub in Tasks, so no issues are listed.";
  }

  return github.issues
    ? undefined
    : "GitHub did not answer in time. Say that the issues are missing rather than that there are none.";
};

/**
 * What the assistant can do in Calendar and Tasks, through the modules their pages call: it reads the person's
 * events, the ones they are invited to, their to-dos and the GitHub issues assigned to them, and it adds a to-do or an
 * event of the person's own. It invites nobody, and it has no way to change or delete what is there.
 */
export const plannerTools = (
  env: Env,
  db: Database,
  user: User,
  { timeZone, now }: AskContext
): ToolSet => ({
  list_events: tool({
    description:
      "Read the person's calendar between two days, both included: their own events and the ones a colleague invited them to, repeats written out, soonest first. Days are YYYY-MM-DD in the person's time zone; without `to` it is the one day. Answers each event's title, its start and end on the person's clock (its days when it lasts whole days), place, organizer, guests with their answers and a link to that day.",
    inputSchema: z.object({
      from: dayInput.describe("The first day."),
      to: dayInput
        .optional()
        .describe("The last day; the first when left out."),
    }),
    execute: async ({ from, to }) => {
      const last = to ?? from;
      const start = zonedMoment(from, undefined, timeZone);
      const end = zonedMoment(addDaysOrNull(last), undefined, timeZone);

      if (!start || !end) {
        return { error: "That is no day on the calendar." };
      }

      if (last < from) {
        return { error: "The last day is before the first." };
      }

      if (daysBetween(from, last) >= MAX_RANGE_DAYS) {
        return {
          error: `Look at ${MAX_RANGE_DAYS} days at most at a time.`,
        };
      }

      // A day's leeway each side: an all-day event is stored on UTC's days, which the person's zone can straddle.
      const found = await listEvents(
        db,
        user.id,
        new Date(start.getTime() - DAY_MS).toISOString(),
        new Date(end.getTime() + DAY_MS).toISOString()
      );

      const inRange = found.filter((o) => {
        const [first, final] = daysOf(o, timeZone);

        return first <= last && final >= from;
      });

      return {
        timeZone,
        from,
        to: last,
        // What is answered below, and how many more fell in the range.
        count: Math.min(inRange.length, MAX_EVENTS),
        omitted: Math.max(0, inRange.length - MAX_EVENTS),
        events: inRange
          .slice(0, MAX_EVENTS)
          .map((o) => eventSummary(o, timeZone)),
        link: calendarHref("week", from),
      };
    },
  }),

  list_tasks: tool({
    description:
      "Read the person's to-dos: the open ones by when they are due (overdue, today, upcoming, someday), or the ones done in the last year. With the open ones come the open GitHub issues assigned to the person, when they connected GitHub in Tasks.",
    inputSchema: z.object({
      status: z
        .enum(["open", "done"])
        .default("open")
        .describe("open (the default) or done."),
    }),
    execute: async ({ status }) => {
      const today = zonedDay(now, timeZone);

      // The issues come with the open tasks alone, as on the Tasks page: GitHub answers what is assigned and open.
      const [rows, github] = await Promise.all([
        listTasks(db, user.id, status),
        status === "open" ? assignedIssues(env, db, user.id) : undefined,
      ]);

      const tasks =
        status === "open"
          ? groupTasks(rows, today).flatMap((g) =>
              g.rows.map((row) => ({ row, due: g.key }))
            )
          : rows.map((row) => ({ row, due: undefined }));

      return {
        today,
        // What is answered below, and how many more there are.
        count: Math.min(tasks.length, MAX_TASKS),
        omitted: Math.max(0, tasks.length - MAX_TASKS),
        tasks: tasks.slice(0, MAX_TASKS).map(({ row, due }) => ({
          id: row.id,
          title: row.title,
          notes: truncate(row.notes, MAX_NOTE_CHARS) || undefined,
          priority: row.priority,
          dueOn: row.dueOn ?? undefined,
          due,
          doneAt: row.completedAt
            ? zonedStamp(row.completedAt, timeZone)
            : undefined,
          issue: row.github ? issueLabel(row.github) : undefined,
        })),
        link: tasksHref(status),
        ...(github && {
          // Null when the person has not connected GitHub, or it did not answer in time.
          issues:
            github.issues?.map((issue) => ({
              issue: issueLabel(issue),
              title: issue.title,
              labels: issue.labels,
              updatedAt: zonedStamp(issue.updatedAt, timeZone),
              link: issue.url,
            })) ?? null,
          issuesNote: issuesNote(github),
        }),
      };
    },
  }),

  create_task: tool({
    description:
      "Add a to-do to the person's own Tasks, when they ask for one. A due day is YYYY-MM-DD in the person's time zone; leave it out for a task without a day.",
    inputSchema: z.object({
      title: z.string().min(1).max(200),
      notes: z.string().max(4000).optional(),
      dueOn: dayInput.optional().describe("The day it is due."),
      priority: z.enum(["low", "normal", "high"]).default("normal"),
    }),
    execute: async ({ title, notes, dueOn, priority }) => {
      try {
        const task = await createTask(db, user.id, {
          title,
          notes,
          dueOn,
          priority,
        });

        return {
          id: task.id,
          title: task.title,
          dueOn: task.dueOn ?? undefined,
          priority: task.priority,
          link: tasksHref(),
          note: "The task is in the person's Tasks.",
        };
      } catch (error) {
        if (error instanceof TaskError) {
          return { error: error.message };
        }

        throw error;
      }
    },
  }),

  create_event: tool({
    description:
      "Add an event to the person's own calendar, when they ask for one. Days are YYYY-MM-DD and times HH:MM on the 24-hour clock, in the person's time zone. With `startTime` the event is timed and lasts an hour unless `endTime` says otherwise; without it the event lasts the whole day, through `endDate` when given. It invites nobody: the person adds guests in Calendar.",
    inputSchema: z.object({
      title: z.string().min(1).max(200),
      date: dayInput.describe("The day it starts."),
      startTime: timeInput.optional().describe("Leave out for a whole day."),
      endTime: timeInput.optional(),
      endDate: dayInput
        .optional()
        .describe("The day it ends, when that is a later day."),
      location: z.string().max(4000).optional(),
      description: z.string().max(4000).optional(),
    }),
    execute: async ({
      title,
      date,
      startTime,
      endTime,
      endDate,
      location,
      description,
    }) => {
      const span = eventSpan({ date, startTime, endTime, endDate }, timeZone);

      if ("error" in span) {
        return span;
      }

      try {
        const event = await createEvent(db, user.id, {
          title,
          location,
          description,
          timeZone,
          ...span,
        });

        return {
          id: event.id,
          title: event.title,
          allDay: event.allDay,
          start: event.allDay ? date : zonedStamp(event.startsAt, timeZone),
          end: event.allDay
            ? (endDate ?? date)
            : zonedStamp(event.endsAt, timeZone),
          link: calendarHref("week", date),
          note: "The event is on the person's calendar, with no guests.",
        };
      } catch (error) {
        if (error instanceof CalendarError) {
          return { error: error.message };
        }

        throw error;
      }
    },
  }),
});
