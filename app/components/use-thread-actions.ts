import { useLoaderData, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";

import { withCleanup } from "~/lib/cleanup";
import { threadsAction, undoAction } from "~/lib/mail/actions";
import type { ThreadsResult } from "~/lib/mail/actions";
import { snoozeLabel } from "~/lib/mail/snooze";
import { leavesView } from "~/lib/mail/views";
import type { ThreadAction } from "~/lib/mail/views";

import { useLeaving } from "./mail-leaving";
import { useToast } from "./toast";

const describe = (action: ThreadAction, count: number): string | null => {
  const what = count === 1 ? "Conversation" : `${count} conversations`;

  switch (action.intent) {
    case "archive": {
      return `${what} archived.`;
    }

    case "trash": {
      return `${what} moved to the trash.`;
    }

    case "spam": {
      return `${what} marked as spam.`;
    }

    case "inbox": {
      return `${what} moved to the inbox.`;
    }

    case "snooze": {
      return `${what} snoozed until ${action.until ? snoozeLabel(action.until) : "later"}.`;
    }

    case "unsnooze": {
      return `${what} back in the inbox.`;
    }

    case "mute": {
      return `${what} muted.`;
    }

    case "unmute": {
      return `${what} unmuted.`;
    }

    case "delete": {
      return `${what} deleted forever.`;
    }

    default: {
      return null;
    }
  }
};

/**
 * One intent on some threads, from anywhere: the rows it takes out of the list go at once, the server does it, every
 * loader on screen refreshes, and a toast says what happened with an Undo that puts it back (`z` presses the latest).
 */
export const useThreadActions = () => {
  const router = useRouter();
  const toast = useToast();
  const list = useLoaderData({ from: "/_app/mail" });
  const { hide } = useLeaving();
  const act = useServerFn(threadsAction);
  const undo = useServerFn(undoAction);

  const revert = useCallback(
    async (token: string) => {
      const fd = new FormData();
      fd.set("undo", token);
      await undo({ data: fd });
      await router.invalidate();
    },
    [undo, router]
  );

  return useCallback(
    async (
      ids: string[],
      action: ThreadAction,
      options: { quiet?: boolean; after?: () => void } = {}
    ): Promise<ThreadsResult | null> => {
      if (!ids.length) {
        return null;
      }

      const fd = new FormData();
      fd.set("ids", JSON.stringify(ids));
      fd.set("intent", action.intent);

      if (action.until) {
        fd.set("until", action.until);
      }

      if (action.labelId) {
        fd.set("labelId", action.labelId);
      }

      // The rows come back if the action fails, and stop being hidden once the list has reloaded without them.
      const show = hide(
        list.threads
          .filter((t) => ids.includes(t.id) && leavesView(list, t, action))
          .map((t) => t.id)
      );

      return await withCleanup(async () => {
        let result: ThreadsResult;

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

        options.after?.();
        const message = options.quiet ? null : describe(action, result.count);
        const token = result.undo;

        if (message) {
          toast.show({
            message,
            undo: !!token,
            action: token
              ? {
                  label: "Undo",
                  onClick: () => {
                    revert(token);
                  },
                }
              : undefined,
          });
        }

        // `sync` waits for the loaders: without it they reload in the background and the rows would come back first.
        await router.invalidate({ sync: true });

        return result;
      }, show);
    },
    [act, router, toast, revert, list, hide]
  );
};
