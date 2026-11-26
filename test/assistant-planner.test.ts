import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { User } from "~/db/schema";
import { messageText } from "~/lib/assistant/assistant";
import {
  askZone,
  askedNote,
  daysLabel,
  stampLabel,
  zonedDay,
  zonedStamp,
} from "~/lib/assistant/time";
import { addDays, allDayRange } from "~/lib/calendar/calendar";
import { createEvent, listEvents } from "~/lib/calendar/calendar.server";
import { connectGitHub } from "~/lib/tasks/github.server";
import { createTask, listTasks, setTaskDone } from "~/lib/tasks/tasks.server";

import { ask, isObject, promptOf, toolPart } from "./assistant-turn";
import { db, mailbox } from "./fixtures";

const AMS = "Europe/Amsterdam";

const GITHUB_TOKEN = "github_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz";

/** The output of the turn's call of `tool`, with the list under `key` read as rows. */
const answered = (
  turn: Awaited<ReturnType<typeof ask>>,
  tool: string,
  key: string
) => {
  const output = toolPart(turn.last.parts, tool)?.output ?? {};
  const rows = output[key];

  return {
    output,
    rows: Array.isArray(rows) ? rows.filter(isObject) : [],
  };
};

const done = [{ text: "Done." }] as const;

/** Why a look at Ann's calendar was refused. */
const refusedLook = async (ann: User, input: { from: string; to?: string }) => {
  const turn = await ask(
    ann,
    "What is on?",
    [{ tool: "list_events", input }, ...done],
    { timeZone: AMS }
  );

  return toolPart(turn.last.parts, "list_events")?.output.error;
};

/** The lines that say when a question was asked, out of what a model was given. */
const askedLines = (prompt: string) =>
  prompt.match(/\[Asked on [^\]]+\]/gu) ?? [];

describe("the assistant in Calendar and Tasks", () => {
  let ann: User;
  let bo: User;
  beforeAll(async () => {
    ann = await mailbox("plan-ann", "Ann");
    bo = await mailbox("plan-bo", "Bo");
  });

  it("reads the calendar on the person's own clock: their events and their invitations, never a stranger's", async () => {
    await createEvent(db, ann.id, {
      title: "Planning",
      location: "Studio 2",
      startsAt: "2027-03-09T09:00:00.000Z",
      endsAt: "2027-03-09T10:00:00.000Z",
      allDay: false,
      timeZone: AMS,
    });
    await createEvent(db, ann.id, {
      title: "Conference",
      ...allDayRange("2027-03-10", "2027-03-11"),
      allDay: true,
      timeZone: AMS,
    });
    // 23:30 in UTC on the 10th is half past midnight on the 11th in Amsterdam.
    await createEvent(db, ann.id, {
      title: "Late show",
      startsAt: "2027-03-10T23:30:00.000Z",
      endsAt: "2027-03-11T00:30:00.000Z",
      allDay: false,
      timeZone: AMS,
    });
    await createEvent(db, bo.id, {
      title: "Review with Bo",
      startsAt: "2027-03-09T13:00:00.000Z",
      endsAt: "2027-03-09T13:30:00.000Z",
      allDay: false,
      timeZone: AMS,
      attendees: [ann.id],
    });
    await createEvent(db, bo.id, {
      title: "Bo alone",
      startsAt: "2027-03-09T15:00:00.000Z",
      endsAt: "2027-03-09T16:00:00.000Z",
      allDay: false,
      timeZone: AMS,
    });

    const look = async (
      input: { from: string; to?: string },
      timeZone?: string
    ) =>
      answered(
        await ask(
          ann,
          "What is on?",
          [{ tool: "list_events", input }, ...done],
          { timeZone }
        ),
        "list_events",
        "events"
      );

    const [ninth, tenth, both, tenthInUtc] = [
      await look({ from: "2027-03-09" }, AMS),
      await look({ from: "2027-03-10" }, AMS),
      await look({ from: "2027-03-10", to: "2027-03-11" }, AMS),
      await look({ from: "2027-03-10" }),
    ];

    expect({
      ninth: ninth.rows.map((e) => [e.title, e.start, e.end, e.organizer]),
      first: ninth.rows[0],
      invited: ninth.rows[1]?.myAnswer,
      tenth: tenth.rows.map((e) => [e.title, e.start, e.end]),
      both: both.rows.map((e) => [e.title, e.start]),
      // Without a zone the day is UTC's, where the late show starts on the 10th.
      tenthInUtc: tenthInUtc.rows.map((e) => [e.title, e.start]),
      zones: [ninth.output.timeZone, tenthInUtc.output.timeZone],
    }).toStrictEqual({
      ninth: [
        ["Planning", "2027-03-09 10:00", "2027-03-09 11:00", "me"],
        ["Review with Bo", "2027-03-09 14:00", "2027-03-09 14:30", "Bo"],
      ],
      first: {
        title: "Planning",
        allDay: false,
        start: "2027-03-09 10:00",
        end: "2027-03-09 11:00",
        location: "Studio 2",
        organizer: "me",
        guests: [],
        link: "/calendar?date=2027-03-09",
      },
      invited: "needs-action",
      tenth: [["Conference", "2027-03-10", "2027-03-11"]],
      both: [
        ["Conference", "2027-03-10"],
        ["Late show", "2027-03-11 00:30"],
      ],
      tenthInUtc: [
        ["Conference", "2027-03-10"],
        ["Late show", "2027-03-10 23:30"],
      ],
      zones: [AMS, "UTC"],
    });
  });

  it("answers each time a repeat comes back on its own day, and an event over midnight with the day of each end", async () => {
    await createEvent(db, ann.id, {
      title: "Weekly stand-up",
      startsAt: "2028-05-01T08:00:00.000Z",
      endsAt: "2028-05-01T08:30:00.000Z",
      allDay: false,
      timeZone: AMS,
      repeat: "weekly",
    });
    await createEvent(db, ann.id, {
      title: "Night shift",
      startsAt: "2028-05-23T21:00:00.000Z",
      endsAt: "2028-05-23T23:00:00.000Z",
      allDay: false,
      timeZone: AMS,
    });

    const look = async (from: string) =>
      answered(
        await ask(
          ann,
          "What is on?",
          [{ tool: "list_events", input: { from } }, ...done],
          { timeZone: AMS }
        ),
        "list_events",
        "events"
      );

    // The fourth time the stand-up comes back, and the day the night shift ends on (it starts the evening before).
    const [fourth, secondDay] = [
      await look("2028-05-22"),
      await look("2028-05-24"),
    ];

    expect({
      fourth: fourth.rows.map((e) => [e.title, e.start, e.repeats, e.link]),
      secondDay: secondDay.rows.map((e) => [e.title, e.start, e.end, e.link]),
    }).toStrictEqual({
      fourth: [
        [
          "Weekly stand-up",
          "2028-05-22 10:00",
          "weekly",
          "/calendar?date=2028-05-22",
        ],
      ],
      secondDay: [
        [
          "Night shift",
          "2028-05-23 23:00",
          "2028-05-24 01:00",
          "/calendar?date=2028-05-23",
        ],
      ],
    });
  });

  it("refuses a look at the calendar that names no day, runs backwards or is too long", async () => {
    expect([
      await refusedLook(ann, { from: "2027-02-30" }),
      await refusedLook(ann, { from: "2027-03-10", to: "2027-03-09" }),
      await refusedLook(ann, { from: "2027-01-01", to: "2027-06-01" }),
    ]).toStrictEqual([
      "That is no day on the calendar.",
      "The last day is before the first.",
      "Look at 62 days at most at a time.",
    ]);
  });

  it("reads the open tasks by when they are due with the person's GitHub issues, and says why when there are none", async () => {
    const today = zonedDay(new Date(), AMS);
    await createTask(db, ann.id, { title: "Someday thing" });
    await createTask(db, ann.id, { title: "Today thing", dueOn: today });
    await createTask(db, ann.id, {
      title: "Overdue thing",
      dueOn: addDays(today, -2),
      priority: "high",
    });
    const finished = await createTask(db, ann.id, { title: "Done thing" });
    await setTaskDone(env, db, ann.id, finished.id, true);
    await createTask(db, bo.id, { title: "Bo's thing" });

    const list = async (status: "open" | "done" | undefined) =>
      answered(
        await ask(
          ann,
          "What is open?",
          [{ tool: "list_tasks", input: status ? { status } : {} }, ...done],
          { timeZone: AMS }
        ),
        "list_tasks",
        "tasks"
      );

    // Before Ann connects GitHub there are no issues to read, and nothing is asked of GitHub.
    const unconnected = await list("open");

    // GitHub in memory: the account the token is Ann's, and one issue assigned to her. Nothing reaches GitHub.
    const asked: string[] = [];
    let down = false;

    const github: typeof fetch = (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      asked.push(url.pathname);

      if (down) {
        return Promise.reject(new Error("GitHub is down."));
      }

      return Promise.resolve(
        url.pathname === "/user"
          ? Response.json({ login: "ann", name: "Ann" })
          : Response.json([
              {
                number: 42,
                title: "Stream drops at night",
                html_url: "https://github.com/acme/radio/issues/42",
                state: "open",
                updated_at: "2027-03-09T09:00:00.000Z",
                repository_url: "https://api.github.com/repos/acme/radio",
                labels: [{ name: "bug" }],
              },
            ])
      );
    };

    await connectGitHub(env, db, ann.id, GITHUB_TOKEN, github);
    asked.length = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(github);

    try {
      const open = await list(undefined);
      const closed = await list("done");
      down = true;
      const quiet = await list("open");

      expect({
        unconnected: [
          unconnected.output.issues,
          JSON.stringify(unconnected.output.issuesNote).includes(
            "not connected"
          ),
        ],
        today: open.output.today,
        tasks: open.rows.map((t) => [t.title, t.due, t.priority]),
        link: open.output.link,
        issues: open.output.issues,
        // The issues are asked for with the open tasks alone.
        asked,
        quiet: [
          quiet.output.issues,
          JSON.stringify(quiet.output.issuesNote).includes(
            "the issues are missing"
          ),
        ],
        quietTasks: quiet.rows.length,
        closed: closed.rows.map((t) => t.title),
        closedIssues: "issues" in closed.output,
      }).toStrictEqual({
        unconnected: [null, true],
        today,
        tasks: [
          ["Overdue thing", "overdue", "high"],
          ["Today thing", "today", "normal"],
          ["Someday thing", "someday", "normal"],
        ],
        link: "/tasks",
        issues: [
          {
            issue: "acme/radio#42",
            title: "Stream drops at night",
            labels: ["bug"],
            updatedAt: "2027-03-09 10:00",
            link: "https://github.com/acme/radio/issues/42",
          },
        ],
        asked: ["/issues", "/issues"],
        quiet: [null, true],
        quietTasks: 3,
        closed: ["Done thing"],
        closedIssues: false,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("adds a to-do and an event of the person's own on their clock, and says why when it cannot", async () => {
    const add = async (
      tool: "create_task" | "create_event",
      input: { [key: string]: string }
    ) => {
      const turn = await ask(ann, "Add it.", [{ tool, input }, ...done], {
        timeZone: AMS,
      });

      return toolPart(turn.last.parts, tool)?.output ?? {};
    };

    const task = await add("create_task", {
      title: "Call Joris",
      dueOn: "2027-04-12",
      priority: "high",
    });

    // Winter time is an hour ahead of UTC in Amsterdam, summer time two.
    const winter = await add("create_event", {
      title: "Call with Joris",
      date: "2027-03-12",
      startTime: "14:00",
    });

    await add("create_event", {
      title: "Summer call",
      date: "2027-07-01",
      startTime: "14:00",
      endTime: "14:30",
    });

    const overnight = await add("create_event", {
      title: "Night shift",
      date: "2027-03-13",
      startTime: "23:00",
      endTime: "01:00",
    });

    // An end on a later day may name an earlier time of day.
    const twoDays = await add("create_event", {
      title: "Night shift, both days named",
      date: "2027-03-20",
      startTime: "23:00",
      endDate: "2027-03-21",
      endTime: "01:00",
    });

    const holiday = await add("create_event", {
      title: "Holiday",
      date: "2027-03-15",
      endDate: "2027-03-16",
    });

    const refusals = [
      await add("create_event", { title: "No day", date: "2027-02-30" }),
      await add("create_event", {
        title: "Backwards",
        date: "2027-03-16",
        endDate: "2027-03-15",
      }),
      await add("create_event", {
        title: "Half a time",
        date: "2027-03-16",
        endTime: "10:00",
      }),
      await add("create_task", { title: "Bad day", dueOn: "2027-02-30" }),
    ];

    const tasks = await listTasks(db, ann.id, "open");

    const made = await listEvents(
      db,
      ann.id,
      "2027-03-12T00:00:00.000Z",
      "2027-07-02T00:00:00.000Z"
    );

    const forBo = await listEvents(
      db,
      bo.id,
      "2027-03-12T00:00:00.000Z",
      "2027-07-02T00:00:00.000Z"
    );

    const stored = (title: string) => {
      const e = made.find((event) => event.title === title);

      return e && [e.startsAt, e.endsAt, e.allDay, e.timeZone, e.attendees];
    };

    expect({
      task: [task.title, task.dueOn, task.priority, task.link],
      inTasks: tasks.find((t) => t.title === "Call Joris")?.dueOn,
      winter: [winter.start, winter.end, winter.link],
      stored: [
        stored("Call with Joris"),
        stored("Summer call"),
        stored("Night shift"),
        stored("Holiday"),
      ],
      holiday: [holiday.allDay, holiday.start, holiday.end],
      refusals: refusals.map((r) => r.error),
      // Nobody else got anything.
      bo: forBo.length,
      overnight: overnight.end,
      twoDays: [twoDays.start, twoDays.end],
    }).toStrictEqual({
      task: ["Call Joris", "2027-04-12", "high", "/tasks"],
      inTasks: "2027-04-12",
      winter: [
        "2027-03-12 14:00",
        "2027-03-12 15:00",
        "/calendar?date=2027-03-12",
      ],
      stored: [
        [
          "2027-03-12T13:00:00.000Z",
          "2027-03-12T14:00:00.000Z",
          false,
          AMS,
          [],
        ],
        [
          "2027-07-01T12:00:00.000Z",
          "2027-07-01T12:30:00.000Z",
          false,
          AMS,
          [],
        ],
        [
          "2027-03-13T22:00:00.000Z",
          "2027-03-14T00:00:00.000Z",
          false,
          AMS,
          [],
        ],
        ["2027-03-15T00:00:00.000Z", "2027-03-17T00:00:00.000Z", true, AMS, []],
      ],
      holiday: [true, "2027-03-15", "2027-03-16"],
      refusals: [
        "That is no day on the calendar.",
        "The event ends before it starts.",
        "An event with an end time needs a start time.",
        "The due day is not a date.",
      ],
      bo: 0,
      overnight: "2027-03-14 01:00",
      twoDays: ["2027-03-20 23:00", "2027-03-21 01:00"],
    });
  });

  it("tells the model when each question was asked, the same line each time the conversation is replayed", async () => {
    const first = await ask(ann, "What is on today?", [{ text: "Nothing." }], {
      timeZone: AMS,
    });

    const second = await ask(ann, "And tomorrow?", [{ text: "Nothing." }], {
      conversationId: first.conversationId,
      timeZone: AMS,
    });

    const elsewhere = await ask(ann, "And on Mars?", [{ text: "Nothing." }], {
      timeZone: "Mars/Olympus",
    });

    const [note] = askedLines(promptOf(first.model, 1));

    expect({
      written:
        /^\[Asked on \w+day \d{1,2} \w+ \d{4} at \d\d:\d\d, Europe\/Amsterdam time\]$/u.test(
          note ?? ""
        ),
      // The first question keeps its own line in the next turn, so the model's cached prefix holds.
      replayed: askedLines(promptOf(second.model, 1))[0] === note,
      lines: askedLines(promptOf(second.model, 1)).length,
      // The conversation as stored and shown carries the person's words alone.
      kept: first.stored.messages.map(messageText),
      unknownZone: askedLines(promptOf(elsewhere.model, 1))[0]?.endsWith(
        ", UTC time]"
      ),
    }).toStrictEqual({
      written: true,
      replayed: true,
      lines: 2,
      kept: ["What is on today?", "Nothing."],
      unknownZone: true,
    });
  });
});

describe("the assistant's clock", () => {
  it("reads a moment in the person's zone, and UTC for a zone it does not know", () => {
    const at = new Date("2026-11-16T23:30:00.000Z");

    expect([
      askedNote(at, AMS),
      askedNote(at, "UTC"),
      zonedDay(at, AMS),
      zonedStamp(at, "America/New_York"),
      askZone(" Europe/Amsterdam "),
      askZone("Mars/Olympus"),
      askZone(null),
      // A step on the page names a day from its own numbers, the same on the server and in the browser.
      daysLabel("2026-11-17", undefined),
      daysLabel("2026-11-17", "2026-11-22"),
      daysLabel("2026-11-28", "2026-12-02"),
      stampLabel("2026-11-18 14:00"),
      stampLabel("2026-11-18"),
      stampLabel("soon"),
    ]).toStrictEqual([
      "[Asked on Tuesday 17 November 2026 at 00:30, Europe/Amsterdam time]",
      "[Asked on Monday 16 November 2026 at 23:30, UTC time]",
      "2026-11-17",
      "2026-11-16 18:30",
      AMS,
      "UTC",
      "UTC",
      "17 November",
      "17 to 22 November",
      "28 November to 2 December",
      "18 November, 14:00",
      "18 November",
      "soon",
    ]);
  });
});
