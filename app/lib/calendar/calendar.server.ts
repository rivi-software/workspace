/**
 * Calendar (#3111): a person's events, theirs to change, and the ones colleagues invited them to, listed as what
 * falls in a range (`occurrences`), made, changed, deleted and answered. A person reads their own events and those
 * they are invited to, and nothing else.
 */
import { and, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";

import type { Database } from "~/db";
import { calendarAttendees, calendarEvents, users } from "~/db/schema";
import type { CalendarEvent } from "~/db/schema";
import { defined, stringList } from "~/lib/guards";
import { newId, nowIso } from "~/lib/ids";

import {
  MAX_ATTENDEES,
  MAX_EVENT_DAYS,
  MAX_EVENT_TEXT,
  MAX_EVENT_TITLE,
  addDays,
  isAttendeeStatus,
  isDayKey,
  isRepeat,
  occurrences,
  utcDay,
  zoneOk,
} from "./calendar";
import type { AttendeeStatus, Repeat } from "./calendar";

export class CalendarError extends Error {
  override name = "CalendarError";
}

export interface EventInput {
  title: string;
  description?: string;
  location?: string;
  /** Instants; an all-day event's the midnights of its first day and the day after its last. */
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  timeZone?: string;
  repeat?: string;
  repeatUntil?: string | null;
  /** The ids of the colleagues invited. */
  attendees?: string[];
}

export interface AttendeeView {
  id: string;
  name: string;
  status: AttendeeStatus;
}

/** An event as the dialog and the grid see it. */
export interface EventView {
  id: string;
  owner: { id: string; name: string };
  /** Whether the reader owns it, and so may change it. */
  mine: boolean;
  title: string;
  description: string;
  location: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  timeZone: string;
  repeat: Repeat;
  repeatUntil: string | null;
  attendees: AttendeeView[];
  /** The reader's own answer, when they were invited. */
  myStatus: AttendeeStatus | null;
  updatedAt: string;
}

/** One time an event happens, in a range. */
export type EventOccurrence = EventView & {
  key: string;
  start: string;
  end: string;
};

/** How many values one insert of attendees binds: three a row, under D1's 100. */
const ATTENDEE_ROWS_PER_INSERT = 30;

const isoOrThrow = (value: string, what: string): string => {
  const ms = Date.parse(value);

  if (!value || Number.isNaN(ms)) {
    throw new CalendarError(`The ${what} is not a moment.`);
  }

  return new Date(ms).toISOString();
};

const cleanText = (
  value: string | undefined,
  what: string,
  max: number
): string => {
  const v = (value ?? "").replaceAll(/\r\n?/gu, "\n").trim();

  if (v.length > max) {
    throw new CalendarError(`The ${what} is at most ${max} characters.`);
  }

  return v;
};

interface Cleaned {
  title: string;
  description: string;
  location: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  timeZone: string;
  repeat: Repeat;
  repeatUntil: string | null;
}

const clean = (input: EventInput): Cleaned => {
  const title = cleanText(input.title, "title", MAX_EVENT_TITLE).replaceAll(
    /\s+/gu,
    " "
  );

  if (!title) {
    throw new CalendarError("An event needs a title.");
  }

  const startsAt = isoOrThrow(input.startsAt, "start");
  const endsAt = isoOrThrow(input.endsAt, "end");

  if (
    input.allDay &&
    (!startsAt.endsWith("T00:00:00.000Z") || !endsAt.endsWith("T00:00:00.000Z"))
  ) {
    throw new CalendarError("An all-day event spans whole days.");
  }

  if (!(Date.parse(endsAt) > Date.parse(startsAt))) {
    throw new CalendarError("An event ends after it starts.");
  }

  if (Date.parse(endsAt) - Date.parse(startsAt) > MAX_EVENT_DAYS * 86_400_000) {
    throw new CalendarError(`An event spans at most ${MAX_EVENT_DAYS} days.`);
  }

  const timeZone = (input.timeZone ?? "UTC").trim() || "UTC";

  if (!zoneOk(timeZone)) {
    throw new CalendarError(`“${timeZone}” is no time zone.`);
  }

  const repeat = input.repeat || "none";

  if (!isRepeat(repeat)) {
    throw new CalendarError("Choose how the event repeats.");
  }

  const { repeatUntil: lastDay } = input;
  let repeatUntil: string | null = null;

  if (repeat !== "none" && lastDay) {
    if (!isDayKey(lastDay)) {
      throw new CalendarError("The last day is not a date.");
    }

    // A day before the first occurrence's own day (in UTC, a day's leeway for the zone) would repeat nothing.
    if (lastDay < addDays(utcDay(startsAt), -1)) {
      throw new CalendarError("The repeat ends before the event starts.");
    }

    repeatUntil = lastDay;
  }

  return {
    title,
    description: cleanText(input.description, "description", MAX_EVENT_TEXT),
    location: cleanText(input.location, "place", MAX_EVENT_TITLE),
    startsAt,
    endsAt,
    allDay: !!input.allDay,
    timeZone,
    repeat,
    repeatUntil,
  };
};

/** The colleagues among some ids: active people other than the owner, each once, at most `MAX_ATTENDEES`. */
const cleanAttendees = async (
  db: Database,
  ownerId: string,
  ids: string[] | undefined
) => {
  const wanted = [
    ...new Set(stringList(ids).filter((id) => id && id !== ownerId)),
  ];

  if (wanted.length > MAX_ATTENDEES) {
    throw new CalendarError(`At most ${MAX_ATTENDEES} people can be invited.`);
  }

  if (!wanted.length) {
    return [];
  }

  const found: string[] = [];

  for (let i = 0; i < wanted.length; i += 90) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- chunks of ids (D1's bound-variable limit) run in turn
    const rows = await db.query.users.findMany({
      where: and(
        inArray(users.id, wanted.slice(i, i + 90)),
        eq(users.active, true)
      ),
    });

    found.push(...rows.map((u) => u.id));
  }

  if (found.length !== wanted.length) {
    throw new CalendarError("Someone invited is not a colleague.");
  }

  return wanted;
};

const attendeesOf = async (
  db: Database,
  eventIds: string[]
): Promise<Map<string, AttendeeView[]>> => {
  const out = new Map<string, AttendeeView[]>();

  for (let i = 0; i < eventIds.length; i += 90) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- chunks of ids (D1's bound-variable limit) run in turn
    const rows = await db
      .select({
        eventId: calendarAttendees.eventId,
        id: calendarAttendees.userId,
        status: calendarAttendees.status,
        name: users.name,
        createdAt: calendarAttendees.createdAt,
      })
      .from(calendarAttendees)
      .innerJoin(users, eq(users.id, calendarAttendees.userId))
      .where(inArray(calendarAttendees.eventId, eventIds.slice(i, i + 90)))
      .orderBy(calendarAttendees.createdAt, users.name);

    for (const r of rows) {
      const list = out.get(r.eventId) ?? [];
      list.push({ id: r.id, name: r.name, status: r.status });
      out.set(r.eventId, list);
    }
  }

  return out;
};

const views = async (
  db: Database,
  userId: string,
  rows: CalendarEvent[]
): Promise<EventView[]> => {
  if (!rows.length) {
    return [];
  }

  const attendees = await attendeesOf(
    db,
    rows.map((e) => e.id)
  );

  const ownerIds = [...new Set(rows.map((e) => e.userId))];
  const owners = new Map<string, string>();

  for (let i = 0; i < ownerIds.length; i += 90) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- chunks of ids (D1's bound-variable limit) run in turn
    const people = await db.query.users.findMany({
      where: inArray(users.id, ownerIds.slice(i, i + 90)),
    });

    for (const p of people) {
      owners.set(p.id, p.name);
    }
  }

  return rows.map((e) => {
    const list = attendees.get(e.id) ?? [];

    return {
      id: e.id,
      owner: { id: e.userId, name: owners.get(e.userId) ?? "Someone" },
      mine: e.userId === userId,
      title: e.title,
      description: e.description,
      location: e.location,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      allDay: e.allDay,
      timeZone: e.timeZone,
      repeat: e.repeat,
      repeatUntil: e.repeatUntil,
      attendees: list,
      myStatus: list.find((a) => a.id === userId)?.status ?? null,
      updatedAt: e.updatedAt,
    };
  });
};

/** The events a person reads: their own, and those they are invited to. */
const readable = (db: Database, userId: string) =>
  or(
    eq(calendarEvents.userId, userId),
    inArray(
      calendarEvents.id,
      db
        .select({ id: calendarAttendees.eventId })
        .from(calendarAttendees)
        .where(eq(calendarAttendees.userId, userId))
    )
  );

/**
 * What of the person's calendar falls in [from, to): each occurrence of their own events and of the ones they are
 * invited to, start first. A repeat is read when it started before the range ends and has not ended two days before
 * it begins (its last day is a day in the event's zone, the range's bounds instants).
 */
export const listEvents = async (
  db: Database,
  userId: string,
  from: string,
  to: string
): Promise<EventOccurrence[]> => {
  const fromIso = isoOrThrow(from, "start");
  const toIso = isoOrThrow(to, "end");

  const rows = await db.query.calendarEvents.findMany({
    where: and(
      readable(db, userId),
      lt(calendarEvents.startsAt, toIso),
      or(
        and(
          eq(calendarEvents.repeat, "none"),
          gte(calendarEvents.endsAt, fromIso)
        ),
        and(
          ne(calendarEvents.repeat, "none"),
          or(
            isNull(calendarEvents.repeatUntil),
            gte(calendarEvents.repeatUntil, addDays(utcDay(fromIso), -2))
          )
        )
      )
    ),
    orderBy: (e, { asc }) => [asc(e.startsAt)],
    limit: 1000,
  });

  const out: EventOccurrence[] = [];

  for (const view of await views(db, userId, rows)) {
    for (const o of occurrences(view, fromIso, toIso)) {
      out.push({
        ...view,
        key: `${view.id}@${o.start}`,
        start: o.start,
        end: o.end,
      });
    }
  }

  return out.toSorted(
    (a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title)
  );
};

/** One event the person reads, or null. */
export const getEvent = async (
  db: Database,
  userId: string,
  id: string
): Promise<EventView | null> => {
  const row = await db.query.calendarEvents.findFirst({
    where: and(eq(calendarEvents.id, id), readable(db, userId)),
  });

  if (!row) {
    return null;
  }

  const [view] = await views(db, userId, [row]);

  return view ?? null;
};

const setAttendees = async (
  db: Database,
  eventId: string,
  ids: string[],
  keep: Set<string>
) => {
  await db
    .delete(calendarAttendees)
    .where(
      and(
        eq(calendarAttendees.eventId, eventId),
        ids.length
          ? sql`${calendarAttendees.userId} not in (select value from json_each(${JSON.stringify(ids)}))`
          : sql`1 = 1`
      )
    );
  const added = ids.filter((id) => !keep.has(id));

  for (let i = 0; i < added.length; i += ATTENDEE_ROWS_PER_INSERT) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- chunks of ids (D1's bound-variable limit) run in turn
    await db
      .insert(calendarAttendees)
      .values(
        added
          .slice(i, i + ATTENDEE_ROWS_PER_INSERT)
          .map((userId) => ({ eventId, userId }))
      )
      .onConflictDoNothing();
  }
};

export const createEvent = async (
  db: Database,
  userId: string,
  input: EventInput
): Promise<EventView> => {
  const values = clean(input);
  const attendees = await cleanAttendees(db, userId, input.attendees);
  const id = newId("ev");
  await db.insert(calendarEvents).values({ id, userId, ...values });
  await setAttendees(db, id, attendees, new Set());

  return defined(await getEvent(db, userId, id), "the result of get event");
};

/** Change one's own event; an attendee taken off no longer sees it, one kept keeps their answer. */
export const updateEvent = async (
  db: Database,
  userId: string,
  id: string,
  input: EventInput
): Promise<EventView> => {
  const row = await db.query.calendarEvents.findFirst({
    where: and(eq(calendarEvents.id, id), eq(calendarEvents.userId, userId)),
  });

  if (!row) {
    throw new CalendarError("No such event of yours.");
  }

  const values = clean(input);
  const attendees = await cleanAttendees(db, userId, input.attendees);

  const had = await db.query.calendarAttendees.findMany({
    where: eq(calendarAttendees.eventId, id),
  });

  await db
    .update(calendarEvents)
    .set({ ...values, updatedAt: nowIso() })
    .where(eq(calendarEvents.id, id));
  await setAttendees(db, id, attendees, new Set(had.map((a) => a.userId)));

  return defined(await getEvent(db, userId, id), "the result of get event");
};

/** Delete one's own event, for everyone invited too. */
export const deleteEvent = async (
  db: Database,
  userId: string,
  id: string
): Promise<boolean> => {
  const gone = await db
    .delete(calendarEvents)
    .where(and(eq(calendarEvents.id, id), eq(calendarEvents.userId, userId)))
    .returning({ id: calendarEvents.id });

  return gone.length > 0;
};

/** An invited person's answer. */
export const respondToEvent = async (
  db: Database,
  userId: string,
  id: string,
  status: string
): Promise<EventView> => {
  if (!isAttendeeStatus(status)) {
    throw new CalendarError("Answer with accept or decline.");
  }

  const changed = await db
    .update(calendarAttendees)
    .set({ status })
    .where(
      and(
        eq(calendarAttendees.eventId, id),
        eq(calendarAttendees.userId, userId)
      )
    )
    .returning({ eventId: calendarAttendees.eventId });

  if (!changed.length) {
    throw new CalendarError("You are not invited to that event.");
  }

  return defined(await getEvent(db, userId, id), "the result of get event");
};
