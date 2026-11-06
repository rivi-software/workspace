/**
 * Tasks (#3111): a person's own to-dos, listed open or done and by their due day for the calendar, made by hand or
 * from a GitHub issue assigned to them, and marked done, which closes a linked issue through their own GitHub
 * connection (`github.server.ts`). Every read and write is the person's own: nothing here answers for another
 * person's tasks.
 */
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";

import type { Database } from "~/db";
import { tasks } from "~/db/schema";
import type { Task } from "~/db/schema";
import { isDayKey } from "~/lib/calendar/calendar";
import type { DayKey } from "~/lib/calendar/calendar";
import { defined } from "~/lib/guards";
import { newId, nowIso } from "~/lib/ids";

import { githubErrorMessage, githubFor } from "./github.server";
import type { Fetch, IssueRef } from "./github.server";
import {
  DONE_LIST_DAYS,
  MAX_TASK_NOTES,
  MAX_TASK_TITLE,
  TASK_LIST_LIMIT,
  isTaskPriority,
} from "./tasks";
import type { AssignedIssue, TaskPriority, TaskRow, TaskView } from "./tasks";

export class TaskError extends Error {
  override name = "TaskError";
}

export interface TaskInput {
  title: string;
  notes?: string;
  dueOn?: string | null;
  priority?: string;
}

const toRow = (t: Task): TaskRow => ({
  id: t.id,
  title: t.title,
  notes: t.notes,
  status: t.status,
  priority: t.priority,
  dueOn: t.dueOn,
  completedAt: t.completedAt,
  github:
    t.githubRepo && t.githubNumber
      ? {
          repo: t.githubRepo,
          number: t.githubNumber,
          url:
            t.githubUrl ??
            `https://github.com/${t.githubRepo}/issues/${t.githubNumber}`,
          title: t.githubTitle,
          state: t.githubState,
          syncedAt: t.githubSyncedAt,
        }
      : null,
  updatedAt: t.updatedAt,
  createdAt: t.createdAt,
});

const cleanTitle = (title: string | undefined): string => {
  const t = (title ?? "").replaceAll(/\s+/gu, " ").trim();

  if (!t) {
    throw new TaskError("A task needs a title.");
  }

  if (t.length > MAX_TASK_TITLE) {
    throw new TaskError(`A title is at most ${MAX_TASK_TITLE} characters.`);
  }

  return t;
};

const cleanNotes = (notes: string | undefined): string => {
  const n = (notes ?? "").replaceAll(/\r\n?/gu, "\n").trim();

  if (n.length > MAX_TASK_NOTES) {
    throw new TaskError(`Notes are at most ${MAX_TASK_NOTES} characters.`);
  }

  return n;
};

const cleanDue = (dueOn: string | null | undefined): DayKey | null => {
  if (dueOn === undefined || dueOn === null || dueOn === "") {
    return null;
  }

  if (!isDayKey(dueOn)) {
    throw new TaskError("The due day is not a date.");
  }

  return dueOn;
};

const cleanPriority = (priority: string | undefined): TaskPriority => {
  if (priority === undefined || priority === "") {
    return "normal";
  }

  if (!isTaskPriority(priority)) {
    throw new TaskError("Choose a priority.");
  }

  return priority;
};

/** The person's own task, or null. */
export const getTask = async (
  db: Database,
  userId: string,
  id: string
): Promise<TaskRow | null> => {
  const row = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, id), eq(tasks.userId, userId)),
  });

  return row ? toRow(row) : null;
};

const own = async (db: Database, userId: string, id: string): Promise<Task> => {
  const row = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, id), eq(tasks.userId, userId)),
  });

  if (!row) {
    throw new TaskError("No such task.");
  }

  return row;
};

/** The open tasks (the client groups them by due day), or what was done in the last year, the last done first. */
export const listTasks = async (
  db: Database,
  userId: string,
  view: TaskView
): Promise<TaskRow[]> => {
  if (view === "done") {
    const since = new Date(
      Date.now() - DONE_LIST_DAYS * 86_400_000
    ).toISOString();

    const rows = await db.query.tasks.findMany({
      where: and(
        eq(tasks.userId, userId),
        eq(tasks.status, "done"),
        gte(tasks.completedAt, since)
      ),
      orderBy: [desc(tasks.completedAt)],
      limit: TASK_LIST_LIMIT,
    });

    return rows.map(toRow);
  }

  // The dated ones first, soonest due; the undated after them, oldest first.
  const rows = await db.query.tasks.findMany({
    where: and(eq(tasks.userId, userId), eq(tasks.status, "open")),
    orderBy: [
      sql`${tasks.dueOn} is null`,
      asc(tasks.dueOn),
      asc(tasks.createdAt),
    ],
    limit: TASK_LIST_LIMIT,
  });

  return rows.map(toRow);
};

/** The open tasks due between two days, both included, for the calendar. */
export const tasksDue = async (
  db: Database,
  userId: string,
  from: DayKey,
  to: DayKey
): Promise<TaskRow[]> => {
  const rows = await db.query.tasks.findMany({
    where: and(
      eq(tasks.userId, userId),
      eq(tasks.status, "open"),
      gte(tasks.dueOn, from),
      lte(tasks.dueOn, to)
    ),
    orderBy: (t) => [asc(t.dueOn), asc(t.createdAt)],
    limit: TASK_LIST_LIMIT,
  });

  return rows.map(toRow);
};

export const createTask = async (
  db: Database,
  userId: string,
  input: TaskInput
): Promise<TaskRow> => {
  const id = newId("tk");
  await db.insert(tasks).values({
    id,
    userId,
    title: cleanTitle(input.title),
    notes: cleanNotes(input.notes),
    dueOn: cleanDue(input.dueOn),
    priority: cleanPriority(input.priority),
  });

  return defined(await getTask(db, userId, id), "the result of get task");
};

export const updateTask = async (
  db: Database,
  userId: string,
  id: string,
  input: Partial<TaskInput>
): Promise<TaskRow> => {
  const task = await own(db, userId, id);
  await db
    .update(tasks)
    .set({
      title: input.title === undefined ? task.title : cleanTitle(input.title),
      notes: input.notes === undefined ? task.notes : cleanNotes(input.notes),
      dueOn: input.dueOn === undefined ? task.dueOn : cleanDue(input.dueOn),
      priority:
        input.priority === undefined
          ? task.priority
          : cleanPriority(input.priority),
      updatedAt: nowIso(),
    })
    .where(eq(tasks.id, id));

  return defined(await getTask(db, userId, id), "the result of get task");
};

export const deleteTask = async (
  db: Database,
  userId: string,
  id: string
): Promise<boolean> => {
  const gone = await db
    .delete(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.userId, userId)))
    .returning({ id: tasks.id });

  return gone.length > 0;
};

export type DoneResult =
  | {
      ok: true;
      task: TaskRow;
      github: "closed" | "reopened" | "unlinked" | "not-connected";
    }
  | { ok: false; error: string };

/**
 * Mark a task done or open again. A task linked to a GitHub issue closes or reopens the issue first, through the
 * person's own connection; when GitHub refuses, the task stays as it was and the answer says why. Without a
 * connection the task changes alone, and the answer says the issue did not.
 */
export const setTaskDone = async (
  env: Env,
  db: Database,
  userId: string,
  id: string,
  done: boolean,
  fetchFn?: Fetch
): Promise<DoneResult> => {
  const task = await own(db, userId, id);
  let github: Extract<DoneResult, { ok: true }>["github"] = "unlinked";
  const patch: Partial<Task> = {};

  if (task.githubRepo && task.githubNumber) {
    const client = await githubFor(env, db, userId, fetchFn);

    if (client) {
      try {
        const issue = await client.setState(
          { repo: task.githubRepo, number: task.githubNumber },
          done ? "closed" : "open"
        );

        github = done ? "closed" : "reopened";
        patch.githubTitle = issue.title;
        patch.githubState = issue.state;
        patch.githubUrl = issue.url;
        patch.githubSyncedAt = nowIso();
      } catch (error) {
        return { ok: false, error: githubErrorMessage(error) };
      }
    } else {
      github = "not-connected";
    }
  }

  await db
    .update(tasks)
    .set({
      ...patch,
      status: done ? "done" : "open",
      completedAt: done ? nowIso() : null,
      updatedAt: nowIso(),
    })
    .where(eq(tasks.id, id));

  return {
    ok: true,
    task: defined(await getTask(db, userId, id), "the result of get task"),
    github,
  };
};

/**
 * The person's task for an issue, the repository's name compared case aside: a stored name is GitHub's own, what
 * a person types may not be. A repository renamed or moved since is found only under the name GitHub answers
 * (`lookupIssue`), so every write asks again with the issue GitHub answered before it writes.
 */
const taskForIssue = async (
  db: Database,
  userId: string,
  ref: IssueRef
): Promise<Task | null> => {
  const row = await db.query.tasks.findFirst({
    where: and(
      eq(tasks.userId, userId),
      sql`lower(${tasks.githubRepo}) = lower(${ref.repo})`,
      eq(tasks.githubNumber, ref.number)
    ),
  });

  return row ?? null;
};

const reopened = async (
  db: Database,
  userId: string,
  task: Task
): Promise<TaskRow> => {
  if (task.status === "done") {
    await db
      .update(tasks)
      .set({ status: "open", completedAt: null, updatedAt: nowIso() })
      .where(eq(tasks.id, task.id));
  }

  return defined(await getTask(db, userId, task.id), "the result of get task");
};

const issueColumns = (issue: AssignedIssue) => ({
  githubRepo: issue.repo,
  githubNumber: issue.number,
  githubUrl: issue.url,
  githubTitle: issue.title,
  githubState: issue.state,
  githubSyncedAt: nowIso(),
});

const lookupIssue = async (
  env: Env,
  db: Database,
  userId: string,
  ref: IssueRef,
  fetchFn?: Fetch
): Promise<AssignedIssue> => {
  const client = await githubFor(env, db, userId, fetchFn);

  if (!client) {
    throw new TaskError("Connect GitHub under Settings → Tasks first.");
  }

  let issue: AssignedIssue | null;

  try {
    issue = await client.lookup(ref);
  } catch (error) {
    throw new TaskError(githubErrorMessage(error));
  }

  if (!issue) {
    throw new TaskError(
      `GitHub has no issue ${ref.repo}#${ref.number} you can see.`
    );
  }

  return issue;
};

/**
 * A task from a GitHub issue: the one the person already has for it (opened again when it was done), else a new
 * one titled as the issue is, looked up through their connection so the link is to a real issue they can see.
 */
export const addIssueTask = async (
  env: Env,
  db: Database,
  userId: string,
  ref: IssueRef,
  fetchFn?: Fetch
): Promise<{ task: TaskRow; existed: boolean }> => {
  const had = await taskForIssue(db, userId, ref);

  if (had) {
    return { task: await reopened(db, userId, had), existed: true };
  }

  const issue = await lookupIssue(env, db, userId, ref, fetchFn);
  // GitHub may name the repository anew (renamed, moved): the task under that name is the one.
  const named = await taskForIssue(db, userId, issue);

  if (named) {
    return { task: await reopened(db, userId, named), existed: true };
  }

  const id = newId("tk");
  await db.insert(tasks).values({
    id,
    userId,
    title: cleanTitle(issue.title),
    ...issueColumns(issue),
  });

  return {
    task: defined(await getTask(db, userId, id), "the result of get task"),
    existed: false,
  };
};

/** Link a task of the person's to a GitHub issue (one task per issue), or take the link off. */
export const linkIssue = async (
  env: Env,
  db: Database,
  userId: string,
  id: string,
  ref: IssueRef | null,
  fetchFn?: Fetch
): Promise<TaskRow> => {
  await own(db, userId, id);

  if (!ref) {
    await db
      .update(tasks)
      .set({
        githubRepo: null,
        githubNumber: null,
        githubUrl: null,
        githubTitle: null,
        githubState: null,
        githubSyncedAt: null,
        updatedAt: nowIso(),
      })
      .where(eq(tasks.id, id));

    return defined(await getTask(db, userId, id), "the result of get task");
  }

  const other = await taskForIssue(db, userId, ref);

  if (other && other.id !== id) {
    throw new TaskError(
      `Another task of yours is already ${other.githubRepo}#${ref.number}.`
    );
  }

  const issue = await lookupIssue(env, db, userId, ref, fetchFn);
  const named = await taskForIssue(db, userId, issue);

  if (named && named.id !== id) {
    throw new TaskError(
      `Another task of yours is already ${issue.repo}#${issue.number}.`
    );
  }

  await db
    .update(tasks)
    .set({ ...issueColumns(issue), updatedAt: nowIso() })
    .where(eq(tasks.id, id));

  return defined(await getTask(db, userId, id), "the result of get task");
};

/** What the person's tasks keep of the issues GitHub just listed: the title and state as they are now. */
export const refreshLinkedIssues = async (
  db: Database,
  userId: string,
  issues: AssignedIssue[]
): Promise<number> => {
  if (!issues.length) {
    return 0;
  }

  const linked = await db.query.tasks.findMany({
    where: and(eq(tasks.userId, userId), eq(tasks.status, "open")),
    limit: TASK_LIST_LIMIT,
  });

  const byRef = new Map(issues.map((i) => [`${i.repo}#${i.number}`, i]));
  let changed = 0;

  for (const task of linked) {
    if (!task.githubRepo || !task.githubNumber) {
      continue;
    }

    const issue = byRef.get(`${task.githubRepo}#${task.githubNumber}`);

    if (
      !issue ||
      (issue.title === task.githubTitle && issue.state === task.githubState)
    ) {
      continue;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- one task at a time, in turn
    await db
      .update(tasks)
      .set({ ...issueColumns(issue) })
      .where(eq(tasks.id, task.id));
    changed += 1;
  }

  return changed;
};
