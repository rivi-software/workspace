import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";

import { taskAction } from "~/lib/tasks/actions";
import type { TaskResult } from "~/lib/tasks/actions";

import { useToast } from "../toast";

type Succeeded = Extract<TaskResult, { ok: true }>;

const doneMessage = (github: Succeeded["github"]): string => {
  if (github === "closed") {
    return "Done, and the issue is closed on GitHub.";
  }

  if (github === "not-connected") {
    return "Done. GitHub is not connected, so the issue stays open.";
  }

  return "Done.";
};

const reopenMessage = (github: Succeeded["github"]): string => {
  if (github === "reopened") {
    return "Reopened, and the issue is open again on GitHub.";
  }

  if (github === "not-connected") {
    return "Reopened. GitHub is not connected, so the issue stays as it is.";
  }

  return "Reopened.";
};

const describe = (result: Succeeded): string | null => {
  switch (result.intent) {
    case "create": {
      return "Task added.";
    }

    case "update": {
      return "Task saved.";
    }

    case "delete": {
      return "Task deleted.";
    }

    case "done": {
      return doneMessage(result.github);
    }

    case "reopen": {
      return reopenMessage(result.github);
    }

    case "add-issue": {
      return result.existed
        ? "That issue is in your tasks already."
        : "Issue added to your tasks.";
    }

    case "link": {
      return result.task?.github ? "Issue linked." : "Link taken off.";
    }

    default: {
      return null;
    }
  }
};

/**
 * One Tasks intent, from anywhere: the server does it, every loader on screen refreshes, and a toast says what
 * happened; a refusal (GitHub's, or the server's) is a toast too, and the answer says so.
 */
export const useTaskAction = () => {
  const router = useRouter();
  const toast = useToast();
  const act = useServerFn(taskAction);

  return useCallback(
    async (
      fields: Record<string, string>,
      options: { quiet?: boolean } = {}
    ): Promise<TaskResult | null> => {
      const fd = new FormData();

      for (const [k, v] of Object.entries(fields)) {
        fd.set(k, v);
      }

      let result: TaskResult;

      try {
        result = await act({ data: fd });
      } catch (error) {
        toast.show({
          message: error instanceof Error ? error.message : String(error),
          tone: "error",
        });

        return null;
      }

      if (!result.ok) {
        toast.show({ message: result.error, tone: "error" });

        return result;
      }

      await router.invalidate();
      const message = options.quiet ? null : describe(result);

      if (message) {
        toast.show({ message });
      }

      return result;
    },
    [act, router, toast]
  );
};
