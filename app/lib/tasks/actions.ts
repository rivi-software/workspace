/**
 * The server functions the Tasks components call (#3111): a task made, changed, done, reopened, deleted or linked
 * to a GitHub issue, one made from an assigned issue, and the GitHub connection under Settings → Tasks. A plain
 * module, as `drive/actions.ts`: the components import it, and only its handlers reach the `*.server.ts` modules.
 */
import { createServerFn } from "@tanstack/react-start";

import { field, formData, formPost } from "~/lib/forms";
import { appContext } from "~/lib/request.server";

import {
  GitHubError,
  connectGitHub,
  disconnectGitHub,
  githubErrorMessage,
} from "./github.server";
import { parseIssueRef } from "./tasks";
import type { TaskRow } from "./tasks";
import {
  TaskError,
  addIssueTask,
  createTask,
  deleteTask,
  linkIssue,
  setTaskDone,
  updateTask,
} from "./tasks.server";

export type TaskResult =
  | {
      ok: true;
      intent: string;
      task: TaskRow | null;
      /** What happened to a linked GitHub issue on done or reopen. */
      github?: "closed" | "reopened" | "unlinked" | "not-connected";
      /** Whether the person already had a task for the issue. */
      existed?: boolean;
    }
  | { ok: false; error: string };

const readIssue = (data: FormData): { repo: string; number: number } | null => {
  const text = field(data, "issue");

  if (!text) {
    return null;
  }

  const ref = parseIssueRef(text);

  if (!ref) {
    throw new TaskError(
      "Name the issue as owner/name#123 or paste its GitHub address (an issue, not a pull request)."
    );
  }

  return ref;
};

/**
 * One intent: `create` (`title`, `notes`, `dueOn`, `priority`), `update` (`id` and those), `done` and `reopen`
 * (`id`), `delete` (`id`), `link` (`id` and `issue`: `owner/name#123` or the issue's address; empty takes the link
 * off) and `add-issue` (`issue`).
 */
export const taskAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }): Promise<TaskResult> => {
    const { db, env, user } = await appContext();
    const intent = field(data, "intent");
    const id = field(data, "id");

    try {
      switch (intent) {
        case "create": {
          return {
            ok: true,
            intent,
            task: await createTask(db, user.id, {
              title: field(data, "title"),
              notes: field(data, "notes"),
              dueOn: field(data, "dueOn") || null,
              priority: field(data, "priority"),
            }),
          };
        }

        case "update": {
          return {
            ok: true,
            intent,
            task: await updateTask(db, user.id, id, {
              title: field(data, "title"),
              notes: field(data, "notes"),
              dueOn: field(data, "dueOn") || null,
              priority: field(data, "priority"),
            }),
          };
        }

        case "done":
        case "reopen": {
          const r = await setTaskDone(env, db, user.id, id, intent === "done");

          return r.ok
            ? { ok: true, intent, task: r.task, github: r.github }
            : r;
        }

        case "delete": {
          if (!(await deleteTask(db, user.id, id))) {
            return { ok: false, error: "No such task." };
          }

          return { ok: true, intent, task: null };
        }

        case "link": {
          return {
            ok: true,
            intent,
            task: await linkIssue(env, db, user.id, id, readIssue(data)),
          };
        }

        case "add-issue": {
          const ref = readIssue(data);

          if (!ref) {
            return { ok: false, error: "Name the issue." };
          }

          const r = await addIssueTask(env, db, user.id, ref);

          return { ok: true, intent, task: r.task, existed: r.existed };
        }

        default: {
          break;
        }
      }

      return { ok: false, error: "Unknown action." };
    } catch (error) {
      if (error instanceof TaskError) {
        return { ok: false, error: error.message };
      }

      throw error;
    }
  });

export interface GitHubConnectResult {
  error?: string;
  message?: string;
}

/** Settings → Tasks: `connect` with a `token` of the person's own, or `disconnect`. */
export const githubAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }): Promise<GitHubConnectResult> => {
    const { db, env, user } = await appContext();
    const intent = field(data, "intent");

    try {
      if (intent === "connect") {
        const me = await connectGitHub(env, db, user.id, field(data, "token"));
        console.log(
          JSON.stringify({
            event: "github.connected",
            by: user.id,
            login: me.login,
          })
        );

        return {
          message: `Connected as ${me.login}. Your assigned issues are on the Tasks page.`,
        };
      }

      if (intent === "disconnect") {
        await disconnectGitHub(db, user.id);
        console.log(
          JSON.stringify({ event: "github.disconnected", by: user.id })
        );

        return {
          message:
            "Disconnected. The token is gone; your tasks stay, their issues untouched.",
        };
      }
    } catch (error) {
      if (error instanceof GitHubError) {
        return { error: githubErrorMessage(error) };
      }

      throw error;
    }

    return { error: "Unknown action." };
  });
