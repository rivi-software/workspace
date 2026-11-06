/**
 * Calendar's shared vocabulary (#3111): the views, the repeats, the attendee answers, the limits, the day and zone
 * arithmetic the grid and the server agree on, and `occurrences`, which turns a repeated event into what falls in a
 * range. A plain module: route components read it, and the server expands events with it.
 *
 * Days are "YYYY-MM-DD" keys and moments ISO instants. A timed event keeps the zone it was made in (`timeZone`),
 * so a weekly 10:00 stays 10:00 there across a DST change; an all-day event has no zone: its days are read from the
 * UTC midnights it is stored as.
 */

import { defined } from "~/lib/guards";

export const CALENDAR_VIEWS = ["week", "month"] as const;

export type CalendarView = (typeof CALENDAR_VIEWS)[number];

export const isCalendarView = (
  value: string | undefined
): value is CalendarView =>
  CALENDAR_VIEWS.some((candidate) => candidate === value);

export const REPEATS = [
  "none",
  "daily",
  "weekly",
  "monthly",
  "yearly",
] as const;

export type Repeat = (typeof REPEATS)[number];

export const isRepeat = (value: string | undefined): value is Repeat =>
  REPEATS.some((candidate) => candidate === value);

export const REPEAT_LABEL: Record<Repeat, string> = {
  none: "Does not repeat",
  daily: "Every day",
  weekly: "Every week",
  monthly: "Every month",
  yearly: "Every year",
};

export const ATTENDEE_STATUSES = [
  "needs-action",
  "accepted",
  "declined",
] as const;

export type AttendeeStatus = (typeof ATTENDEE_STATUSES)[number];

export const isAttendeeStatus = (
  value: string | undefined
): value is AttendeeStatus =>
  ATTENDEE_STATUSES.some((candidate) => candidate === value);

export const ATTENDEE_STATUS_LABEL: Record<AttendeeStatus, string> = {
  "needs-action": "Not answered",
  accepted: "Accepted",
  declined: "Declined",
};

export const MAX_EVENT_TITLE = 200;
export const MAX_EVENT_TEXT = 4000;

/** An event spans at most this many days. */
export const MAX_EVENT_DAYS = 366;

/** At most this many colleagues on one event. */
export const MAX_ATTENDEES = 100;

/** A repeated event answers at most this many occurrences in one range. */
export const MAX_OCCURRENCES = 500;

/** The first hour the week view scrolls to. */
export const WORKDAY_START_HOUR = 7;

/** A day as "YYYY-MM-DD". */
export type DayKey = string;

const pad = (n: number) => String(n).padStart(2, "0");

export const dayKey = (y: number, m: number, d: number): DayKey =>
  `${y}-${pad(m)}-${pad(d)}`;

export const parseDay = (
  key: string | undefined | null
): { y: number; m: number; d: number } | null => {
  const m = key?.match(/^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u);

  if (!m) {
    return null;
  }

  const parts = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  const check = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));

  if (
    check.getUTCFullYear() !== parts.y ||
    check.getUTCMonth() !== parts.m - 1 ||
    check.getUTCDate() !== parts.d
  ) {
    return null;
  }

  return parts;
};

/** The parts of a day key this module made itself, so it reads. */
const dayParts = (key: string): { y: number; m: number; d: number } =>
  defined(parseDay(key), `the day ${key}`);

export const isDayKey = (value: string | undefined | null): value is DayKey =>
  parseDay(value) !== null;

/** The day `n` days on from `key`. */
export const addDays = (key: DayKey, n: number): DayKey => {
  const p = dayParts(key);
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d + n));

  return dayKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
};

/** Whole days from `a` to `b` (negative when `b` is earlier). */
export const daysBetween = (a: DayKey, b: DayKey): number => {
  const pa = dayParts(a);
  const pb = dayParts(b);

  return Math.round(
    (Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) /
      86_400_000
  );
};

/** The day a moment falls on in UTC: what an all-day event's stored midnights read as. */
export const utcDay = (iso: string | Date): DayKey => {
  const d = new Date(iso);

  return dayKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
};

/** The day a moment falls on where the reader is: the browser's zone, so on the client only. */
export const localDay = (iso: string | Date): DayKey => {
  const d = new Date(iso);

  return dayKey(d.getFullYear(), d.getMonth() + 1, d.getDate());
};

/** Today where the reader is (the browser's zone on the client, UTC on the server). */
export const todayKey = (now = new Date()): DayKey => localDay(now);

/** The Monday on or before the day: weeks start on Monday. */
export const startOfWeek = (key: DayKey): DayKey => {
  const p = dayParts(key);
  const weekday = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();

  return addDays(key, -((weekday + 6) % 7));
};

/** The seven days of the week the day is in, Monday first. */
export const weekDays = (key: DayKey): DayKey[] => {
  const monday = startOfWeek(key);

  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
};

/** The first day of the day's month. */
export const startOfMonth = (key: DayKey): DayKey => {
  const p = dayParts(key);

  return dayKey(p.y, p.m, 1);
};

/** The same day `n` months on, the day of the month held back to the last day where the month is shorter. */
export const addMonths = (key: DayKey, n: number): DayKey => {
  const p = dayParts(key);
  const first = new Date(Date.UTC(p.y, p.m - 1 + n, 1));

  const last = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)
  ).getUTCDate();

  return dayKey(
    first.getUTCFullYear(),
    first.getUTCMonth() + 1,
    Math.min(p.d, last)
  );
};

/** The 42 days of the month grid: six weeks from the Monday on or before the first. */
export const monthGrid = (key: DayKey): DayKey[] => {
  const first = startOfWeek(startOfMonth(key));

  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
};

/** The days the view shows for the day it is on. */
export const viewDays = (view: CalendarView, key: DayKey): DayKey[] =>
  view === "month" ? monthGrid(key) : weekDays(key);

/** The day the view moves to, a step back or on. */
export const stepView = (
  view: CalendarView,
  key: DayKey,
  delta: 1 | -1
): DayKey =>
  view === "month"
    ? addMonths(startOfMonth(key), delta)
    : addDays(key, 7 * delta);

/** A view on a day; the week view of today without params. */
export const calendarHref = (
  view: CalendarView = "week",
  date?: DayKey
): string => {
  const params = new URLSearchParams();

  if (view !== "week") {
    params.set("view", view);
  }

  if (date) {
    params.set("date", date);
  }

  const q = params.toString();

  return q ? `/calendar?${q}` : "/calendar";
};

/* ---------- zones ---------- */

export interface ZonedParts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
}

/** Whether the runtime knows the zone (an IANA name such as Europe/Amsterdam). */
export const zoneOk = (tz: string): boolean => {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz });

    return true;
  } catch {
    return false;
  }
};

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatter = (tz: string): Intl.DateTimeFormat => {
  let f = formatters.get(tz);

  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(tz, f);
  }

  return f;
};

/** The wall-clock time of a moment in a zone. */
export const zonedParts = (date: Date, tz: string): ZonedParts => {
  const out: ZonedParts = { y: 0, m: 0, d: 0, hh: 0, mm: 0 };

  for (const part of formatter(tz).formatToParts(date)) {
    const n = Number(part.value);

    if (part.type === "year") {
      out.y = n;
    } else if (part.type === "month") {
      out.m = n;
    } else if (part.type === "day") {
      out.d = n;
    } else if (part.type === "hour") {
      out.hh = n;
    } else if (part.type === "minute") {
      out.mm = n;
    }
  }

  return out;
};

const asUtc = (p: ZonedParts) => Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);

/** The zone's offset from UTC at a moment, in minutes. */
const zoneOffset = (date: Date, tz: string): number =>
  Math.round((asUtc(zonedParts(date, tz)) - date.getTime()) / 60_000);

/**
 * The moment at which a zone's clocks read these parts. A wall-clock time that never comes (the hour spring
 * forward skips) answers the moment an hour on; one that comes twice answers the first.
 */
export const fromZoned = (p: ZonedParts, tz: string): Date => {
  const wall = asUtc(p);
  const first = wall - zoneOffset(new Date(wall), tz) * 60_000;
  const second = wall - zoneOffset(new Date(first), tz) * 60_000;

  return new Date(second);
};

/* ---------- occurrences ---------- */

export interface EventLike {
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  timeZone: string;
  repeat: Repeat;
  repeatUntil: string | null;
}

/** One time an event happens: its start and end as instants (an all-day one's as its stored midnights). */
export interface Occurrence {
  start: string;
  end: string;
}

/** A day `n` repeats on from `day`. */
const stepDay = (day: DayKey, repeat: Repeat, n: number): DayKey => {
  switch (repeat) {
    case "daily": {
      return addDays(day, n);
    }

    case "weekly": {
      return addDays(day, 7 * n);
    }

    case "monthly": {
      return addMonths(day, n);
    }

    default: {
      return addMonths(day, 12 * n);
    }
  }
};

/** The parts stepped `n` repeats on from the first occurrence's, at the same wall-clock time. */
const stepped = (first: ZonedParts, repeat: Repeat, n: number): ZonedParts => {
  const day = dayKey(first.y, first.m, first.d);

  const next = stepDay(day, repeat, n);

  const p = dayParts(next);

  return { ...first, y: p.y, m: p.m, d: p.d };
};

/** How many repeats a span of days (and of months) holds, rounded down. */
const repeatsIn = (repeat: Repeat, days: number, months: number): number => {
  switch (repeat) {
    case "daily": {
      return days;
    }

    case "weekly": {
      return Math.floor(days / 7);
    }

    case "monthly": {
      return months;
    }

    default: {
      return Math.floor(months / 12);
    }
  }
};

/** Roughly how many repeats lie between the first occurrence and a day, one short so none is skipped. */
const jumpTo = (first: ZonedParts, repeat: Repeat, day: DayKey): number => {
  const start = dayKey(first.y, first.m, first.d);
  const days = daysBetween(start, day);

  if (days <= 0) {
    return 0;
  }

  const target = dayParts(day);
  const months = (target.y - first.y) * 12 + (target.m - first.m);

  return Math.max(0, repeatsIn(repeat, days, months) - 1);
};

/**
 * What of an event falls in [from, to): the event itself when it does not repeat, else each repeat that starts on or
 * before `repeatUntil` and overlaps the range, at most `MAX_OCCURRENCES`. A timed repeat keeps its wall-clock time
 * in the event's zone; an all-day one steps its days.
 */
export const occurrences = (
  event: EventLike,
  from: string,
  to: string
): Occurrence[] => {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const startMs = Date.parse(event.startsAt);
  const endMs = Date.parse(event.endsAt);

  if (!(startMs < endMs) || !(fromMs < toMs)) {
    return [];
  }

  const duration = endMs - startMs;
  const overlaps = (s: number) => s < toMs && s + duration > fromMs;

  if (event.repeat === "none") {
    return overlaps(startMs)
      ? [{ start: event.startsAt, end: event.endsAt }]
      : [];
  }

  const tz = event.allDay || !zoneOk(event.timeZone) ? "UTC" : event.timeZone;
  const first = zonedParts(new Date(startMs), tz);
  const out: Occurrence[] = [];
  // Start a repeat or so before the range: the day keys below are the zone's, the range's day UTC's, a day apart at most.
  let n = jumpTo(first, event.repeat, addDays(utcDay(from), -2));

  for (
    let steps = 0;
    steps < MAX_OCCURRENCES * 2 && out.length < MAX_OCCURRENCES;
    steps += 1, n += 1
  ) {
    const parts = stepped(first, event.repeat, n);
    const day = dayKey(parts.y, parts.m, parts.d);

    if (event.repeatUntil && day > event.repeatUntil) {
      break;
    }

    const s = tz === "UTC" ? asUtc(parts) : fromZoned(parts, tz).getTime();

    if (s >= toMs) {
      break;
    }

    if (overlaps(s)) {
      out.push({
        start: new Date(s).toISOString(),
        end: new Date(s + duration).toISOString(),
      });
    }
  }

  return out;
};

/* ---------- what the grid shows ---------- */

/** Whom an item on the calendar belongs to, which colours it: one's own event, one a colleague invited one to, a task due. */
export type ItemKind = "own" | "invited" | "task";

/** One thing on the grid: an occurrence of an event, or a task on its due day. */
export interface CalendarItem {
  key: string;
  kind: ItemKind;
  title: string;
  /** Instants; an all-day item's are the midnights of its days (`allDay`). */
  start: string;
  end: string;
  allDay: boolean;
  /** The event's id, for the dialog; null for a task. */
  eventId: string | null;
  /** Where a task opens. */
  href: string | null;
  /** Whether the reader declined the event (shown struck through). */
  declined: boolean;
  /** Amber for a high-priority task; neutral otherwise. */
  tone: "neutral" | "amber";
}

/** The days an all-day item covers, in the reader's zone when timed, from the stored midnights when not. */
export const itemDays = (
  item: Pick<CalendarItem, "start" | "end" | "allDay">
): DayKey[] => {
  const first = item.allDay ? utcDay(item.start) : localDay(item.start);
  // The end is exclusive: a moment at midnight ends the day before.
  const endMs = Date.parse(item.end) - 1;

  const last = item.allDay
    ? utcDay(new Date(endMs))
    : localDay(new Date(endMs));

  const n = Math.max(0, daysBetween(first, last));

  return Array.from({ length: n + 1 }, (_, i) => addDays(first, i));
};

/** The minutes into its day a timed item starts and ends on a day, clipped to the day. */
export const minutesOn = (
  item: Pick<CalendarItem, "start" | "end">,
  day: DayKey
): [number, number] => {
  const p = dayParts(day);
  const dayStart = new Date(p.y, p.m - 1, p.d).getTime();
  const dayEnd = new Date(p.y, p.m - 1, p.d + 1).getTime();
  const s = Math.max(Date.parse(item.start), dayStart);
  const e = Math.min(Date.parse(item.end), dayEnd);

  return [
    Math.round((s - dayStart) / 60_000),
    Math.round((e - dayStart) / 60_000),
  ];
};

/** Timed items laid side by side where they overlap: each one's lane and how many lanes its cluster has. */
export const lanes = <T extends { start: string; end: string }>(
  items: T[]
): { item: T; lane: number; lanes: number }[] => {
  const sorted = items.toSorted(
    (a, b) =>
      Date.parse(a.start) - Date.parse(b.start) ||
      Date.parse(b.end) - Date.parse(a.end)
  );

  const out: { item: T; lane: number; lanes: number }[] = [];
  let cluster: { item: T; lane: number; lanes: number }[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;

  const close = () => {
    for (const c of cluster) {
      c.lanes = laneEnds.length;
    }

    out.push(...cluster);
    cluster = [];
    laneEnds = [];
  };

  for (const item of sorted) {
    const s = Date.parse(item.start);
    const e = Math.max(Date.parse(item.end), s + 15 * 60_000);

    if (s >= clusterEnd) {
      close();
    }

    let lane = laneEnds.findIndex((end) => end <= s);

    if (lane < 0) {
      lane = laneEnds.length;
    }

    laneEnds[lane] = e;
    clusterEnd = Math.max(clusterEnd, e);
    cluster.push({ item, lane, lanes: 0 });
  }

  close();

  return out;
};

/** "9:00 – 10:30", in the reader's locale; on the client only. */
const clockTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

export const timeRange = (start: string, end: string): string =>
  `${clockTime(start)} – ${clockTime(end)}`;

const shortDay = (q: { y: number; m: number; d: number }, withYear: boolean) =>
  new Date(Date.UTC(q.y, q.m - 1, q.d)).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: withYear ? "numeric" : undefined,
    timeZone: "UTC",
  });

/** The title of a view: the month of a month view, the span of a week ("27 Oct – 2 Nov 2026"). */
export const viewTitle = (view: CalendarView, key: DayKey): string => {
  const p = dayParts(key);

  if (view === "month") {
    return new Date(Date.UTC(p.y, p.m - 1, 1)).toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  }

  const days = weekDays(key);
  const a = dayParts(days[0] ?? key);
  const b = dayParts(days[6] ?? key);

  return `${shortDay(a, a.y !== b.y)} – ${shortDay(b, true)}`;
};

/** The reader's zone, for an event made on the client; UTC where the browser cannot say. */
export const readerZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

/** What a `date` or `time` input holds for a moment, in the reader's zone; on the client only. */
export const toDateInput = (d: Date): string => localDay(d);

export const toTimeInput = (d: Date): string =>
  `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** The moment a `date` and a `time` input name, in the reader's zone; null when either is unreadable. */
export const fromInputs = (date: string, time: string): Date | null => {
  const p = parseDay(date);
  const t = time.match(/^(?<hour>\d{2}):(?<minute>\d{2})$/u);

  if (!p || !t) {
    return null;
  }

  return new Date(p.y, p.m - 1, p.d, Number(t[1]), Number(t[2]));
};

/** The stored midnights of an all-day event from its first to its last day, inclusive. */
export const allDayRange = (first: DayKey, last: DayKey) => {
  const end = addDays(last < first ? first : last, 1);

  return { startsAt: `${first}T00:00:00.000Z`, endsAt: `${end}T00:00:00.000Z` };
};
