/**
 * Tasks' shared vocabulary (#3111): the views, the priorities, the limits, a task as the list shows it, how the open
 * ones are grouped by their due day, and how a GitHub issue is named. A plain module: route components read it.
 */
import { addDays, daysBetween, parseDay } from "~/lib/calendar/calendar";
import type { DayKey } from "~/lib/calendar/calendar";
import { defined } from "~/lib/guards";

export const TASK_VIEWS = ["open", "done"] as const;

export type TaskView = (typeof TASK_VIEWS)[number];

export const isTaskView = (value: string | undefined): value is TaskView =>
  TASK_VIEWS.some((view) => view === value);

export const TASK_VIEW_LABEL: Record<TaskView, string> = {
  open: "Tasks",
  done: "Done",
};

export const TASK_PRIORITIES = ["low", "normal", "high"] as const;

export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const isTaskPriority = (
  value: string | undefined
): value is TaskPriority =>
  TASK_PRIORITIES.some((priority) => priority === value);

export const TASK_PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
};

export const MAX_TASK_TITLE = 200;
export const MAX_TASK_NOTES = 4000;

/** At most this many tasks a view lists. */
export const TASK_LIST_LIMIT = 500;

/** The done list keeps what was finished in the last year. */
export const DONE_LIST_DAYS = 365;

/** A GitHub issue a task is linked to: where it is and what it last looked like. */
export interface TaskIssue {
  /** `owner/name`. */
  repo: string;
  number: number;
  url: string;
  title: string | null;
  state: "open" | "closed" | null;
  /** When the state was last read from GitHub; null for a link GitHub was not asked about yet. */
  syncedAt: string | null;
}

/** What a task row carries to the client. */
export interface TaskRow {
  id: string;
  title: string;
  notes: string;
  status: "open" | "done";
  priority: TaskPriority;
  dueOn: DayKey | null;
  completedAt: string | null;
  github: TaskIssue | null;
  updatedAt: string;
  createdAt: string;
}

export type TaskGroupKey = "overdue" | "today" | "upcoming" | "someday";

/** The groups in the order the list shows them. */
const TASK_GROUP_ORDER: readonly TaskGroupKey[] = [
  "overdue",
  "today",
  "upcoming",
  "someday",
];

export const TASK_GROUP_LABEL: Record<TaskGroupKey, string> = {
  overdue: "Overdue",
  today: "Today",
  upcoming: "Upcoming",
  someday: "No date",
};

/**
 * The open tasks by when they are due, relative to `today` (the reader's day): overdue first, then today, then the
 * dated ones to come, then those without a day; within a group the sooner due, then the higher priority, then the
 * older first.
 */
export const groupTasks = (
  rows: TaskRow[],
  today: DayKey
): { key: TaskGroupKey; label: string; rows: TaskRow[] }[] => {
  const rank: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };

  const order = (a: TaskRow, b: TaskRow) =>
    (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999") ||
    rank[a.priority] - rank[b.priority] ||
    a.createdAt.localeCompare(b.createdAt);

  const groups: Record<TaskGroupKey, TaskRow[]> = {
    overdue: [],
    today: [],
    upcoming: [],
    someday: [],
  };

  for (const row of rows) {
    if (!row.dueOn) {
      groups.someday.push(row);
    } else if (row.dueOn < today) {
      groups.overdue.push(row);
    } else if (row.dueOn === today) {
      groups.today.push(row);
    } else {
      groups.upcoming.push(row);
    }
  }

  return TASK_GROUP_ORDER.flatMap((key) =>
    groups[key].length > 0
      ? [
          {
            key,
            label: TASK_GROUP_LABEL[key],
            rows: groups[key].toSorted(order),
          },
        ]
      : []
  );
};

/** "Today", "Tomorrow", "Yesterday", "Mon 3 Nov" or "3 Nov 2025": a due day as the row shows it. */
export const dueLabel = (dueOn: DayKey, today: DayKey): string => {
  const gap = daysBetween(today, dueOn);

  if (gap === 0) {
    return "Today";
  }

  if (gap === 1) {
    return "Tomorrow";
  }

  if (gap === -1) {
    return "Yesterday";
  }

  const p = defined(parseDay(dueOn), "the result of parse day");
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d));

  if (gap > 1 && gap < 7) {
    return d.toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  }

  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year:
      p.y === defined(parseDay(today), "the result of parse day").y
        ? undefined
        : "numeric",
    timeZone: "UTC",
  });
};

/** The day `n` days from today, for the quick choices. */
export const dayFromToday = (today: DayKey, n: number): DayKey =>
  addDays(today, n);

/** `owner/name#123` as an issue is named. */
export const issueLabel = (issue: Pick<TaskIssue, "repo" | "number">): string =>
  `${issue.repo}#${issue.number}`;

export const ISSUE_REPO =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/u;

/**
 * The issue a person typed or pasted: its GitHub address (`https://github.com/owner/name/issues/123`) or the short
 * form `owner/name#123`. Null for anything else, a pull request included.
 */
export const parseIssueRef = (
  text: string
): { repo: string; number: number } | null => {
  const t = text.trim();

  let m = t.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/(?<repo>[^/\s]+\/[^/\s#]+)\/issues\/(?<number>\d+)(?:[/?#].*)?$/iu
  );

  if (!m) {
    m = t.match(/^(?<repo>[^/\s#]+\/[^/\s#]+)#(?<number>\d+)$/u);
  }

  if (!m) {
    return null;
  }

  const repo = defined(m[1], "the item").replace(/\.git$/u, "");
  const number = Number(m[2]);

  if (!ISSUE_REPO.test(repo) || !Number.isInteger(number) || number < 1) {
    return null;
  }

  return { repo, number };
};

/** The Tasks page, on a view. */
export const tasksHref = (view: TaskView = "open"): string =>
  view === "open" ? "/tasks" : `/tasks?view=${view}`;

/** What the Tasks page shows of a GitHub issue assigned to the person. */
export interface AssignedIssue {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  updatedAt: string;
  labels: string[];
}
