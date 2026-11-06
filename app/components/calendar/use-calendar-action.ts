import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";

import { calendarAction } from "~/lib/calendar/actions";
import type { CalendarResult } from "~/lib/calendar/actions";

import { useToast } from "../toast";

/** What the toast says of an answer to an invitation. */
const respondMessage = (status: string | undefined) => {
  if (status === "accepted") {
    return "You accepted.";
  }

  return status === "declined" ? "You declined." : "Answer taken back.";
};

const describe = (
  intent: string,
  fields: Record<string, string>
): string | null => {
  switch (intent) {
    case "create": {
      return "Event added.";
    }

    case "update": {
      return "Event saved.";
    }

    case "delete": {
      return "Event deleted.";
    }

    case "respond": {
      return respondMessage(fields.status);
    }

    default: {
      return null;
    }
  }
};

/**
 * One Calendar intent, from anywhere: the server does it, every loader on screen refreshes, and a toast says what
 * happened; a refusal is a toast too, and the answer says so.
 */
export const useCalendarAction = () => {
  const router = useRouter();
  const toast = useToast();
  const act = useServerFn(calendarAction);

  return useCallback(
    async (
      fields: Record<string, string>,
      options: { quiet?: boolean } = {}
    ): Promise<CalendarResult | null> => {
      const fd = new FormData();

      for (const [k, v] of Object.entries(fields)) {
        fd.set(k, v);
      }

      let result: CalendarResult;

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
      const message = options.quiet ? null : describe(result.intent, fields);

      if (message) {
        toast.show({ message });
      }

      return result;
    },
    [act, router, toast]
  );
};
