import { createFileRoute } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { SectionError } from "~/components/section-error";
import { TasksPage } from "~/components/tasks/tasks";
import type { TasksData } from "~/components/tasks/tasks";
import { keepShown } from "~/lib/keep-shown";
import { appContext } from "~/lib/request.server";
import { serverFnFetch } from "~/lib/server-fn-fetch";
import { assignedIssues } from "~/lib/tasks/github.server";
import { TASK_VIEW_LABEL, isTaskView } from "~/lib/tasks/tasks";
import type { TaskView } from "~/lib/tasks/tasks";
import { listTasks, refreshLinkedIssues } from "~/lib/tasks/tasks.server";

const searchSchema = z.object({ view: z.string().optional() });

const getTasks = createServerFn()
  .validator((d: { view?: string }) => d)
  .handler(async ({ data }): Promise<TasksData> => {
    const { db, env, user } = await appContext();
    const view: TaskView = isTaskView(data.view) ? data.view : "open";

    // What is the person's on GitHub, read live and never waited on for long: a GitHub that does not answer leaves
    // its section out.
    const github = await assignedIssues(env, db, user.id);

    // The issues GitHub just listed say what the linked tasks' issues look like now.
    if (github.issues?.length) {
      await refreshLinkedIssues(db, user.id, github.issues);
    }

    const tasks = await listTasks(db, user.id, view);

    return { view, tasks, github };
  });

const TasksRoute = () => <TasksPage data={Route.useLoaderData()} />;

/** What takes the tasks' place when they cannot load and there is nothing to keep (#3548). */
const TasksError = ({ error }: ErrorComponentProps) => (
  <SectionError error={error} title="Tasks didn't load" />
);

/** Tasks (#3111): the open ones, or the done ones (`?view=done`). */
export const Route = createFileRoute("/_app/tasks")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ view: search.view }),
  // The list stays when the minute's refresh cannot load it again (#3548).
  loader: (run) =>
    keepShown(run, () => getTasks({ data: run.deps, fetch: serverFnFetch })),
  head: ({ loaderData }) => ({
    meta: [
      {
        title: `${loaderData ? TASK_VIEW_LABEL[loaderData.view] : "Tasks"} · Workspace`,
      },
    ],
  }),
  component: TasksRoute,
  errorComponent: TasksError,
});
