/** The moments the snooze and send-later menus offer, in the reader's own time zone (they run on the client). */
export interface SnoozePreset {
  key: string;
  label: string;
  at: Date;
}

const MORNING = 8;
const AFTERNOON = 13;
const EVENING = 18;

const at = (base: Date, dayOffset: number, hour: number): Date => {
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);

  return d;
};

export const snoozePresets = (now = new Date()): SnoozePreset[] => {
  const presets: SnoozePreset[] = [];
  // Later today: the evening, or three hours on when the evening is near or gone.
  const evening = at(now, 0, EVENING);

  const laterToday =
    evening.getTime() - now.getTime() > 90 * 60_000
      ? evening
      : new Date(now.getTime() + 3 * 3_600_000);

  if (laterToday.getDate() === now.getDate()) {
    presets.push({ key: "later", label: "Later today", at: laterToday });
  }

  presets.push({ key: "tomorrow", label: "Tomorrow", at: at(now, 1, MORNING) });
  // This weekend: Saturday morning; from Saturday on, the next one.
  const day = now.getDay();
  const toSaturday = day === 6 ? 7 : 6 - day;
  presets.push({
    key: "weekend",
    label: "This weekend",
    at: at(now, toSaturday, MORNING),
  });
  const toMonday = day === 0 ? 1 : 8 - day;
  presets.push({
    key: "week",
    label: "Next week",
    at: at(now, toMonday, MORNING),
  });
  const seen = new Set<number>();

  return presets.filter(
    (p) => !seen.has(p.at.getTime()) && seen.add(p.at.getTime())
  );
};

/** When "Send later" offers to send: tomorrow morning and afternoon, and Monday morning, as Gmail does. */
export const sendLaterPresets = (now = new Date()): SnoozePreset[] => {
  const toMonday = now.getDay() === 0 ? 1 : 8 - now.getDay();

  const presets = [
    { key: "morning", label: "Tomorrow morning", at: at(now, 1, MORNING) },
    {
      key: "afternoon",
      label: "Tomorrow afternoon",
      at: at(now, 1, AFTERNOON),
    },
    { key: "monday", label: "Monday morning", at: at(now, toMonday, MORNING) },
  ];

  const seen = new Set<number>();

  return presets.filter(
    (p) => !seen.has(p.at.getTime()) && seen.add(p.at.getTime())
  );
};

/** "Tomorrow, 08:00" or "Sat 1 Nov, 08:00": a snooze or send moment as the menu and the row show it. */
export const snoozeLabel = (iso: string | Date, now = new Date()): string => {
  const d = iso instanceof Date ? iso : new Date(iso);

  if (Number.isNaN(d.getTime())) {
    return "";
  }

  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

  const sameDay = d.toDateString() === now.toDateString();

  if (sameDay) {
    return `Today, ${time}`;
  }

  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);

  if (d.toDateString() === tomorrow.toDateString()) {
    return `Tomorrow, ${time}`;
  }

  const days = (d.getTime() - now.getTime()) / 86_400_000;

  if (days < 7) {
    return `${d.toLocaleDateString(undefined, { weekday: "short" })}, ${time}`;
  }

  const date = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });

  return `${date}, ${time}`;
};

const pad = (n: number) => String(n).padStart(2, "0");

/** What a `datetime-local` input holds for a moment: local time without the zone. */
export const toLocalInputValue = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
