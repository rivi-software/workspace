/** The Tasks section of the Workspace API (docs/API.md): the open or done tasks with the person's GitHub issues, and the changes to them. */
import { numberOr } from "~/lib/guards";
import { assignedIssues } from "~/lib/tasks/github.server";
import { isTaskView } from "~/lib/tasks/tasks";
import type { TaskView } from "~/lib/tasks/tasks";
import {
  addIssueTask,
  createTask,
  deleteTask,
  listTasks,
  refreshLinkedIssues,
  setTaskDone,
  updateTask,
} from "~/lib/tasks/tasks.server";
import type { TaskInput } from "~/lib/tasks/tasks.server";

import { field, fieldOrNull, readBody } from "./body.server";
import type { JsonBody } from "./body.server";
import { ApiRequestError, json } from "./routing.server";
import type { ApiContext, ApiRoute } from "./routing.server";

const list = async (context: ApiContext): Promise<Response> => {
  const { db, env, user, query } = context;
  const asked = query.get("view") ?? undefined;
  const view: TaskView = isTaskView(asked) ? asked : "open";

  // As the console's page does: what is the person's on GitHub, read live and never waited on for long.
  const github = await assignedIssues(env, db, user.id);

  if (github.issues?.length) {
    await refreshLinkedIssues(db, user.id, github.issues);
  }

  const tasks = await listTasks(db, user.id, view);

  return json({ view, tasks, github });
};

/** The fields a task request names; a field left out stays as it is on a change. */
const taskInput = (body: JsonBody, whole: boolean): Partial<TaskInput> => {
  const input: Partial<TaskInput> = {};

  if (whole || body.title !== undefined) {
    input.title = field(body, "title");
  }

  if (whole || body.notes !== undefined) {
    input.notes = field(body, "notes");
  }

  if (whole || body.dueOn !== undefined) {
    input.dueOn = fieldOrNull(body, "dueOn");
  }

  if (whole || body.priority !== undefined) {
    input.priority = field(body, "priority");
  }

  return input;
};

const create = async (context: ApiContext): Promise<Response> => {
  const { db, user, request } = context;
  const input = taskInput(await readBody(request), true);

  const task = await createTask(db, user.id, {
    title: input.title ?? "",
    notes: input.notes,
    dueOn: input.dueOn,
    priority: input.priority,
  });

  return json({ ok: true, task });
};

const update = async (context: ApiContext): Promise<Response> => {
  const { db, user, request, params } = context;

  const task = await updateTask(
    db,
    user.id,
    params.id ?? "",
    taskInput(await readBody(request), false)
  );

  return json({ ok: true, task });
};

const remove = async (context: ApiContext): Promise<Response> => {
  const { db, user, params } = context;

  if (!(await deleteTask(db, user.id, params.id ?? ""))) {
    throw new ApiRequestError("No such task of yours.", 404);
  }

  return json({ ok: true });
};

const done = async (context: ApiContext): Promise<Response> => {
  const { db, env, user, request, params } = context;
  const body = await readBody(request);

  const result = await setTaskDone(
    env,
    db,
    user.id,
    params.id ?? "",
    body.done !== false
  );

  return result.ok ? json(result) : json(result, 400);
};

const fromIssue = async (context: ApiContext): Promise<Response> => {
  const { db, env, user, request } = context;
  const body = await readBody(request);
  const number = numberOr(body.number, Number.NaN);

  if (!field(body, "repo") || !Number.isInteger(number)) {
    throw new ApiRequestError("Name the issue's repository and number.");
  }

  const { task, existed } = await addIssueTask(env, db, user.id, {
    repo: field(body, "repo"),
    number,
  });

  return json({ ok: true, task, existed });
};

export const tasksRoutes: ApiRoute[] = [
  { method: "GET", path: "/tasks", handler: list },
  { method: "POST", path: "/tasks", writes: true, handler: create },
  {
    method: "POST",
    path: "/tasks/from-issue",
    writes: true,
    handler: fromIssue,
  },
  { method: "PUT", path: "/tasks/:id", writes: true, handler: update },
  { method: "DELETE", path: "/tasks/:id", writes: true, handler: remove },
  { method: "POST", path: "/tasks/:id/done", writes: true, handler: done },
];
