import {
  dayKey,
  fromZoned,
  isDayKey,
  parseDay,
  zoneOk,
  zonedParts,
} from "~/lib/calendar/calendar";
import type { DayKey } from "~/lib/calendar/calendar";

/**
 * Time as the Assistant tells it: in the zone of the person asking, which the server does not know by itself. The
 * page and the app send it with a question (`ChatInput.timeZone`); a question without one is read in UTC.
 */

/** When and where a question is asked: what "today" and "14:00" mean in it. */
export interface AskContext {
  /** An IANA zone the runtime knows. */
  timeZone: string;
  now: Date;
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** The zone a question named when the runtime knows it, else UTC. */
export const askZone = (timeZone: string | null | undefined): string => {
  const zone = (timeZone ?? "").trim();

  return zone && zoneOk(zone) ? zone : "UTC";
};

const two = (n: number) => String(n).padStart(2, "0");

/** The day a moment falls on in a zone. */
export const zonedDay = (at: Date | string, timeZone: string): DayKey => {
  const p = zonedParts(new Date(at), timeZone);

  return dayKey(p.y, p.m, p.d);
};

/** The moment a zone's clocks read `clock` ("HH:MM", midnight without one) on a day; null for a day that is none. */
export const zonedMoment = (
  on: DayKey,
  clock: string | undefined,
  timeZone: string
): Date | null => {
  const p = parseDay(on);

  if (!p) {
    return null;
  }

  const [hh = 0, mm = 0] = (clock ?? "00:00").split(":").map(Number);

  return fromZoned({ ...p, hh, mm }, timeZone);
};

/** A moment on a zone's clock, "2026-11-17 14:05": what a tool answers and the model reads as a time. */
export const zonedStamp = (at: Date | string, timeZone: string): string => {
  const p = zonedParts(new Date(at), timeZone);

  return `${dayKey(p.y, p.m, p.d)} ${two(p.hh)}:${two(p.mm)}`;
};

/** A day in words, "Tuesday 17 November 2026", from its own numbers and no zone. */
export const dayInWords = (day: DayKey): string => {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];

  return `${weekday} ${d} ${MONTHS[m - 1]} ${y}`;
};

/** A day as a step on the page names it, "17 November": from the day's own numbers, so the server and the browser agree. */
export const dayLabel = (day: DayKey): string => {
  const [, m = 1, d = 1] = day.split("-").map(Number);

  return `${d} ${MONTHS[m - 1]}`;
};

/** Two days as a step names them: "17 November", "17 to 22 November", "28 November to 2 December". */
export const daysLabel = (from: DayKey, to: DayKey | undefined): string => {
  if (!to || to === from) {
    return dayLabel(from);
  }

  return from.slice(0, 7) === to.slice(0, 7)
    ? `${Number(from.slice(8))} to ${dayLabel(to)}`
    : `${dayLabel(from)} to ${dayLabel(to)}`;
};

/** What a tool answered as a day or a moment ("2026-11-18", "2026-11-18 14:00"), as a step names it: "18 November, 14:00". */
export const stampLabel = (stamp: string): string => {
  const [day = "", clock] = stamp.split(" ");

  if (!isDayKey(day)) {
    return stamp;
  }

  return clock ? `${dayLabel(day)}, ${clock}` : dayLabel(day);
};

/** A moment in words on a zone's clock: "Tuesday 17 November 2026 at 14:05, Europe/Amsterdam time". */
export const momentInWords = (at: Date | string, timeZone: string): string => {
  const p = zonedParts(new Date(at), timeZone);

  return `${dayInWords(dayKey(p.y, p.m, p.d))} at ${two(p.hh)}:${two(p.mm)}, ${timeZone} time`;
};

/** How every question's note of its moment starts: the model reads it, and the mock model skips it. */
export const ASKED_PREFIX = "[Asked on ";

/**
 * The line that opens a question as the model reads it: when it was asked, on the person's clock. It is the same
 * for a question each time the conversation is replayed, so the model knows the day without a date in the system
 * prompt, which would change the prompt's cached prefix at midnight.
 */
export const askedNote = (at: Date | string, timeZone: string): string =>
  `${ASKED_PREFIX}${momentInWords(at, timeZone)}]`;
