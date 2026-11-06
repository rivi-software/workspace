import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";

import { driveAction } from "~/lib/drive/actions";
import type { DriveResult } from "~/lib/drive/actions";

import { useToast } from "../toast";

const describe = (intent: string, count: number): string | null => {
  const what = count === 1 ? "Item" : `${count} items`;

  switch (intent) {
    case "trash": {
      return `${what} moved to the trash.`;
    }

    case "restore": {
      return `${what} restored.`;
    }

    case "delete": {
      return `${what} deleted forever.`;
    }

    case "move": {
      return count ? `${what} moved.` : "Already there.";
    }

    case "empty-trash": {
      return count ? `${what} deleted forever.` : "The trash was empty.";
    }

    default: {
      return null;
    }
  }
};

/**
 * One Drive intent, from anywhere: the server does it, every loader on screen refreshes, and a toast says what
 * happened, with Undo where the server offered one (trashing restores; `z` presses it).
 */
export const useDriveAction = () => {
  const router = useRouter();
  const toast = useToast();
  const act = useServerFn(driveAction);

  return useCallback(
    async (
      fields: Record<string, string>,
      options: { quiet?: boolean; after?: () => void } = {}
    ): Promise<DriveResult | null> => {
      const fd = new FormData();

      for (const [k, v] of Object.entries(fields)) {
        fd.set(k, v);
      }

      let result: DriveResult;

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
      await router.invalidate();

      const message = options.quiet
        ? null
        : describe(result.intent, result.count);

      if (message) {
        const undo =
          result.undo && result.undo.ids.length > 0 ? result.undo : null;

        toast.show({
          message,
          undo: !!undo,
          action: undo
            ? {
                label: "Undo",
                onClick: () => {
                  const back = new FormData();
                  back.set("intent", undo.intent);
                  back.set("ids", JSON.stringify(undo.ids));
                  void act({ data: back }).then(() => router.invalidate());
                },
              }
            : undefined,
        });
      }

      return result;
    },
    [act, router, toast]
  );
};
