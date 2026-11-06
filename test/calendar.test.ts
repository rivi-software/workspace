import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { calendarAttendees, calendarEvents } from "~/db/schema";
import type { User } from "~/db/schema";
import {
  addMonths,
  allDayRange,
  fromZoned,
  itemDays,
  lanes,
  monthGrid,
  occurrences,
  parseDay,
  startOfWeek,
  stepView,
  viewTitle,
  weekDays,
  zonedParts,
} from "~/lib/calendar/calendar";
import type { EventLike } from "~/lib/calendar/calendar";
import {
  CalendarError,
  createEvent,
  deleteEvent,
  getEvent,
  listEvents,
  respondToEvent,
  updateEvent,
} from "~/lib/calendar/calendar.server";

import { db, defined, mailbox, rejection, rejectionIncludes } from "./fixtures";

const AMS = "Europe/Amsterdam";

const event = (over: Partial<EventLike> = {}): EventLike => ({
  startsAt: "2026-10-21T08:00:00.000Z",
  endsAt: "2026-10-21T09:00:00.000Z",
  allDay: false,
  timeZone: AMS,
  repeat: "none",
  repeatUntil: null,
  ...over,
});

describe("days and zones", () => {
  it("reads and steps days", () => {
    expect({
      k20260229: parseDay("2026-02-29"),
      k20261031: parseDay("2026-10-31"),
      k202610312: startOfWeek("2026-10-31"),
      k20261026: startOfWeek("2026-10-26"),
      k20261101: weekDays("2026-11-01"),
    }).toStrictEqual({
      k20260229: null,
      k20261031: { y: 2026, m: 10, d: 31 },
      k202610312: "2026-10-26",
      k20261026: "2026-10-26",
      k20261101: [
        "2026-10-26",
        "2026-10-27",
        "2026-10-28",
        "2026-10-29",
        "2026-10-30",
        "2026-10-31",
        "2026-11-01",
      ],
    });
    const grid = monthGrid("2026-11-15");
    expect({
      grid: grid.length,
      grid0: grid[0],
      grid41: grid[41],
    }).toStrictEqual({ grid: 42, grid0: "2026-10-26", grid41: "2026-12-06" });
    // The day of the month is held back where the month is shorter.
    expect({
      k20260131: addMonths("2026-01-31", 1),
      k202601312: addMonths("2026-01-31", 2),
      k20280229: addMonths("2028-02-29", 12),
      week: stepView("week", "2026-10-31", 1),
      month: stepView("month", "2026-10-31", 1),
      month2: stepView("month", "2026-10-31", -1),
      k20261103: allDayRange("2026-11-03", "2026-11-04"),
      endsAt: allDayRange("2026-11-03", "2026-11-01").endsAt,
    }).toStrictEqual({
      k20260131: "2026-02-28",
      k202601312: "2026-03-31",
      k20280229: "2029-02-28",
      week: "2026-11-07",
      month: "2026-11-01",
      month2: "2026-09-01",
      k20261103: {
        startsAt: "2026-11-03T00:00:00.000Z",
        endsAt: "2026-11-05T00:00:00.000Z",
      },
      endsAt: "2026-11-04T00:00:00.000Z",
    });
  });

  it("titles a view", () => {
    expect(viewTitle("month", "2026-11-15")).toMatch(/November.*2026/u);
    const week = viewTitle("week", "2026-10-31");
    expect({
      week: /Oct/u.test(week),
      week2: /Nov/u.test(week),
      week3: /26/u.test(week),
      week4: /2026/u.test(week),
      week5: /2026.*2027/u.test(viewTitle("week", "2026-12-31")),
    }).toStrictEqual({
      week: true,
      week2: true,
      week3: true,
      week4: true,
      week5: true,
    });
  });

  it("reads a zone's wall clock and finds the moment it names, across DST", () => {
    // 2026-10-25 02:00 CEST → 02:00 CET: the clocks go back in Amsterdam.
    expect(zonedParts(new Date("2026-10-21T08:00:00.000Z"), AMS)).toStrictEqual(
      {
        y: 2026,
        m: 10,
        d: 21,
        hh: 10,
        mm: 0,
      }
    );
    expect(
      fromZoned({ y: 2026, m: 10, d: 21, hh: 10, mm: 0 }, AMS).toISOString()
    ).toBe("2026-10-21T08:00:00.000Z");
    expect(
      fromZoned({ y: 2026, m: 10, d: 28, hh: 10, mm: 0 }, AMS).toISOString()
    ).toBe("2026-10-28T09:00:00.000Z");
    // 2026-03-29 02:30 never comes in Amsterdam (the clocks spring from 02:00 to 03:00): the moment an hour on.
    expect(
      fromZoned({ y: 2026, m: 3, d: 29, hh: 2, mm: 30 }, AMS).toISOString()
    ).toBe("2026-03-29T01:30:00.000Z");
    expect(
      fromZoned({ y: 2026, m: 7, d: 1, hh: 12, mm: 0 }, "UTC").toISOString()
    ).toBe("2026-07-01T12:00:00.000Z");
  });
});

describe(occurrences, () => {
  const week = [
    "2026-10-26T00:00:00.000Z",
    "2026-11-02T00:00:00.000Z",
  ] as const;

  it("answers an event that does not repeat once, when it overlaps the range", () => {
    expect(
      occurrences(
        event(),
        "2026-10-21T08:30:00.000Z",
        "2026-10-22T00:00:00.000Z"
      )
    ).toStrictEqual([
      { start: "2026-10-21T08:00:00.000Z", end: "2026-10-21T09:00:00.000Z" },
    ]);
    expect(
      occurrences(
        event(),
        "2026-10-21T09:00:00.000Z",
        "2026-10-22T00:00:00.000Z"
      )
    ).toStrictEqual([]);
    expect(
      occurrences(event({ endsAt: "2026-10-21T07:00:00.000Z" }), ...week)
    ).toStrictEqual([]);
  });

  it("keeps a weekly repeat's wall-clock time in its zone across the DST change", () => {
    const weekly = event({ repeat: "weekly" });
    expect(occurrences(weekly, ...week)).toStrictEqual([
      // 10:00 in Amsterdam, now CET.
      { start: "2026-10-28T09:00:00.000Z", end: "2026-10-28T10:00:00.000Z" },
    ]);
    expect(
      occurrences(
        weekly,
        "2026-10-19T00:00:00.000Z",
        "2026-11-09T00:00:00.000Z"
      )
    ).toStrictEqual([
      { start: "2026-10-21T08:00:00.000Z", end: "2026-10-21T09:00:00.000Z" },
      { start: "2026-10-28T09:00:00.000Z", end: "2026-10-28T10:00:00.000Z" },
      { start: "2026-11-04T09:00:00.000Z", end: "2026-11-04T10:00:00.000Z" },
    ]);
    // In UTC the instants step by exactly a week.
    expect(
      occurrences(event({ repeat: "weekly", timeZone: "UTC" }), ...week).map(
        (o) => o.start
      )
    ).toStrictEqual(["2026-10-28T08:00:00.000Z"]);
  });

  it("stops at the last day, steps days, months and years, and holds a day back in a short month", () => {
    expect(
      occurrences(
        event({ repeat: "daily", repeatUntil: "2026-10-28" }),
        "2026-10-26T00:00:00.000Z",
        "2026-11-02T00:00:00.000Z"
      ).map((o) => o.start)
    ).toStrictEqual([
      "2026-10-26T09:00:00.000Z",
      "2026-10-27T09:00:00.000Z",
      "2026-10-28T09:00:00.000Z",
    ]);

    const monthly = event({
      startsAt: "2026-01-31T10:00:00.000Z",
      endsAt: "2026-01-31T11:00:00.000Z",
      timeZone: "UTC",
      repeat: "monthly",
    });

    expect(
      occurrences(
        monthly,
        "2026-02-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z"
      ).map((o) => o.start)
    ).toStrictEqual([
      "2026-02-28T10:00:00.000Z",
      "2026-03-31T10:00:00.000Z",
      "2026-04-30T10:00:00.000Z",
    ]);

    const yearly = event({
      startsAt: "2028-02-29T00:00:00.000Z",
      endsAt: "2028-03-01T00:00:00.000Z",
      allDay: true,
      repeat: "yearly",
    });

    expect(
      occurrences(
        yearly,
        "2029-01-01T00:00:00.000Z",
        "2030-12-31T00:00:00.000Z"
      ).map((o) => o.start)
    ).toStrictEqual(["2029-02-28T00:00:00.000Z", "2030-02-28T00:00:00.000Z"]);
  });

  it("jumps to the range for an old daily repeat, and answers at most the cap", () => {
    const old = event({
      startsAt: "2019-03-04T06:00:00.000Z",
      endsAt: "2019-03-04T06:30:00.000Z",
      timeZone: "UTC",
      repeat: "daily",
    });

    const began = Date.now();
    const found = occurrences(old, ...week);
    expect(Date.now() - began).toBeLessThan(500);
    expect(found.map((o) => o.start)).toStrictEqual([
      "2026-10-26T06:00:00.000Z",
      "2026-10-27T06:00:00.000Z",
      "2026-10-28T06:00:00.000Z",
      "2026-10-29T06:00:00.000Z",
      "2026-10-30T06:00:00.000Z",
      "2026-10-31T06:00:00.000Z",
      "2026-11-01T06:00:00.000Z",
    ]);
    expect(
      occurrences(old, "2020-01-01T00:00:00.000Z", "2030-01-01T00:00:00.000Z")
        .length
    ).toBeLessThanOrEqual(500);
  });

  it("lays overlapping items side by side and reads an item's days", () => {
    const laid = lanes([
      {
        id: "a",
        start: "2026-10-21T08:00:00.000Z",
        end: "2026-10-21T09:00:00.000Z",
      },
      {
        id: "b",
        start: "2026-10-21T08:30:00.000Z",
        end: "2026-10-21T09:30:00.000Z",
      },
      {
        id: "c",
        start: "2026-10-21T10:00:00.000Z",
        end: "2026-10-21T11:00:00.000Z",
      },
    ]);

    expect(laid.map((l) => [l.item.id, l.lane, l.lanes])).toStrictEqual([
      ["a", 0, 2],
      ["b", 1, 2],
      ["c", 0, 1],
    ]);
    expect(
      itemDays({
        start: "2026-11-03T00:00:00.000Z",
        end: "2026-11-05T00:00:00.000Z",
        allDay: true,
      })
    ).toStrictEqual(["2026-11-03", "2026-11-04"]);
  });
});

describe("a person's calendar", () => {
  let ann: User;
  let bo: User;
  let cat: User;
  beforeAll(async () => {
    ann = await mailbox("cal-ann", "Ann Calendar");
    bo = await mailbox("cal-bo", "Bo Calendar");
    cat = await mailbox("cal-cat", "Cat Calendar");
  });

  const range = [
    "2026-11-02T00:00:00.000Z",
    "2026-11-09T00:00:00.000Z",
  ] as const;

  it("makes an event with colleagues invited, who see it and answer, and only they", async () => {
    const observed: unknown[] = [];

    const made = await createEvent(db, ann.id, {
      title: "  Planning   meeting ",
      description: "Agenda to follow.",
      location: "Studio 2",
      startsAt: "2026-11-03T09:00:00.000Z",
      endsAt: "2026-11-03T10:00:00.000Z",
      allDay: false,
      timeZone: AMS,
      attendees: [bo.id, ann.id, bo.id],
    });

    expect(made).toMatchObject({
      title: "Planning meeting",
      mine: true,
      owner: { id: ann.id, name: "Ann Calendar" },
      attendees: [{ id: bo.id, name: "Bo Calendar", status: "needs-action" }],
      myStatus: null,
      repeat: "none",
    });

    const bos = await listEvents(db, bo.id, ...range);
    observed.push({
      bosMap: bos.map((e) => [e.id, e.mine, e.myStatus, e.key]),
      listEvents: await listEvents(db, cat.id, ...range),
      getEvent: await getEvent(db, cat.id, made.id),
    });

    await respondToEvent(db, bo.id, made.id, "accepted");
    observed.push(
      defined(defined(await getEvent(db, ann.id, made.id)).attendees[0]).status,
      (await rejection(
        respondToEvent(db, cat.id, made.id, "accepted")
      )) instanceof CalendarError,
      (await rejection(respondToEvent(db, bo.id, made.id, "maybe"))) instanceof
        CalendarError,
      // Only the owner changes it; a colleague taken off no longer sees it, one kept keeps their answer.
      await rejectionIncludes(
        updateEvent(db, bo.id, made.id, {
          ...made,
          title: "Mine now",
          attendees: [],
        }),
        "No such event of yours."
      )
    );

    const changed = await updateEvent(db, ann.id, made.id, {
      ...made,
      title: "Planning meeting (moved)",
      startsAt: "2026-11-03T13:00:00.000Z",
      endsAt: "2026-11-03T14:00:00.000Z",
      attendees: [bo.id, cat.id],
    });

    observed.push(changed.attendees.map((a) => [a.name, a.status]));

    const again = await updateEvent(db, ann.id, made.id, {
      ...changed,
      attendees: [cat.id],
    });

    const catEvents = await listEvents(db, cat.id, ...range);

    expect({
      attendeesMap: again.attendees.map((a) => a.id),
      listEvents: await listEvents(db, bo.id, ...range),
      listEventsMap: catEvents.map((e) => e.start),
    }).toStrictEqual({
      attendeesMap: [cat.id],
      listEvents: [],
      listEventsMap: ["2026-11-03T13:00:00.000Z"],
    });

    observed.push(
      Boolean(await deleteEvent(db, cat.id, made.id)),
      Boolean(await deleteEvent(db, ann.id, made.id)),
      await db.query.calendarAttendees.findMany({
        where: eq(calendarAttendees.eventId, made.id),
      })
    );

    expect(observed).toStrictEqual([
      // { bosMap: bos.map((e) => [e.id, e.mine, e.myStatus, e.key]), listEvents: await listEven...
      {
        bosMap: [
          [
            made.id,
            false,
            "needs-action",
            `${made.id}@2026-11-03T09:00:00.000Z`,
          ],
        ],
        listEvents: [],
        getEvent: null,
      },
      // defined(defined(await getEvent(db, ann.id, made.id)).attendees[0]).status
      "accepted",
      // (await rejection(respondToEvent(db, cat.id, made.id, "accepted"))) instanceof CalendarE...
      true,
      // (await rejection(respondToEvent(db, bo.id, made.id, "maybe"))) instanceof CalendarError
      true,
      // (await rejection(updateEvent(db, bo.id, made.id, { ...made, title: "Mine now", attendee...
      true,
      // changed.attendees.map((a) => [a.name, a.status])
      [
        ["Bo Calendar", "accepted"],
        ["Cat Calendar", "needs-action"],
      ],
      // Boolean(await deleteEvent(db, cat.id, made.id))
      false,
      // Boolean(await deleteEvent(db, ann.id, made.id))
      true,
      // db.query.calendarAttendees.findMany({ where: eq(calendarAttendees.eventId, made.id), })
      [],
    ]);
  });

  it("refuses what cannot be an event", async () => {
    const observed: unknown[] = [];

    const base = {
      title: "x",
      startsAt: "2026-11-03T09:00:00.000Z",
      endsAt: "2026-11-03T10:00:00.000Z",
      allDay: false,
    };

    observed.push(
      await rejectionIncludes(
        createEvent(db, ann.id, { ...base, title: "  " }),
        "An event needs a title."
      ),
      await rejectionIncludes(
        createEvent(db, ann.id, {
          ...base,
          endsAt: "2026-11-03T09:00:00.000Z",
        }),
        "An event ends after it starts."
      ),
      await rejectionIncludes(
        createEvent(db, ann.id, { ...base, startsAt: "soon" }),
        "The start is not a moment."
      ),
      await rejectionIncludes(
        createEvent(db, ann.id, { ...base, timeZone: "Mars/Olympus" }),
        "no time zone"
      ),
      await rejectionIncludes(
        createEvent(db, ann.id, { ...base, repeat: "hourly" }),
        "Choose how the event repeats."
      ),
      await rejectionIncludes(
        createEvent(db, ann.id, {
          ...base,
          repeat: "weekly",
          repeatUntil: "2026-10-01",
        }),
        "The repeat ends before the event starts."
      ),
      await rejectionIncludes(
        createEvent(db, ann.id, {
          ...base,
          allDay: true,
          startsAt: "2026-11-03T09:00:00.000Z",
          endsAt: "2026-11-04T00:00:00.000Z",
        }),
        "whole days"
      ),
      await rejectionIncludes(
        createEvent(db, ann.id, { ...base, attendees: ["usr_nobody"] }),
        "not a colleague"
      ),
      await rejectionIncludes(
        createEvent(db, ann.id, {
          ...base,
          endsAt: "2028-11-03T10:00:00.000Z",
        }),
        "at most 366 days"
      )
    );

    expect(observed).toStrictEqual([
      // (await rejection(createEvent(db, ann.id, { ...base, title: " " })))?.message.includes("...
      true,
      // (await rejection(createEvent(db, ann.id, { ...base, endsAt: "2026-11-03T09:00:00.000Z" ...
      true,
      // (await rejection(createEvent(db, ann.id, { ...base, startsAt: "soon" })))?.message.incl...
      true,
      // (await rejection(createEvent(db, ann.id, { ...base, timeZone: "Mars/Olympus" })))?.mess...
      true,
      // (await rejection(createEvent(db, ann.id, { ...base, repeat: "hourly" })))?.message.incl...
      true,
      // (await rejection(createEvent(db, ann.id, { ...base, repeat: "weekly", repeatUntil: "202...
      true,
      // (await rejection(createEvent(db, ann.id, { ...base, allDay: true, startsAt: "2026-11-03...
      true,
      // (await rejection(createEvent(db, ann.id, { ...base, attendees: ["usr_nobody"] })))?.mes...
      true,
      // (await rejection(createEvent(db, ann.id, { ...base, endsAt: "2028-11-03T10:00:00.000Z" ...
      true,
    ]);
  });

  it("lists each time a repeat falls in the range, and an all-day event by its days", async () => {
    const standup = await createEvent(db, ann.id, {
      title: "Stand-up",
      startsAt: "2026-10-05T08:00:00.000Z",
      endsAt: "2026-10-05T08:15:00.000Z",
      allDay: false,
      timeZone: AMS,
      repeat: "daily",
      repeatUntil: "2026-11-04",
    });

    const offsite = await createEvent(db, ann.id, {
      title: "Offsite",
      startsAt: "2026-11-05T00:00:00.000Z",
      endsAt: "2026-11-07T00:00:00.000Z",
      allDay: true,
    });

    const listed = await listEvents(db, ann.id, ...range);
    expect(listed.map((e) => [e.title, e.start, e.end])).toStrictEqual([
      // 10:00 Amsterdam, CET since 25 October.
      ["Stand-up", "2026-11-02T09:00:00.000Z", "2026-11-02T09:15:00.000Z"],
      ["Stand-up", "2026-11-03T09:00:00.000Z", "2026-11-03T09:15:00.000Z"],
      ["Stand-up", "2026-11-04T09:00:00.000Z", "2026-11-04T09:15:00.000Z"],
      ["Offsite", "2026-11-05T00:00:00.000Z", "2026-11-07T00:00:00.000Z"],
    ]);
    expect(defined(listed[0]).key).toBe(
      `${standup.id}@2026-11-02T09:00:00.000Z`
    );
    expect(defined(listed[3]).allDay).toBeTruthy();
    // The week after: the repeat has ended, the offsite is over.
    await expect(
      listEvents(
        db,
        ann.id,
        "2026-11-09T00:00:00.000Z",
        "2026-11-16T00:00:00.000Z"
      )
    ).resolves.toStrictEqual([]);
    await deleteEvent(db, ann.id, standup.id);
    await deleteEvent(db, ann.id, offsite.id);
    await expect(
      db.query.calendarEvents.findMany({
        where: eq(calendarEvents.userId, ann.id),
      })
    ).resolves.toStrictEqual([]);
  });
});
