/**
 * The server functions the Calendar components call (#3111): an event made, changed, deleted or answered. A plain
 * module, as `drive/actions.ts`: the components import it, and only its handlers reach the `*.server.ts` modules.
 */
import { createServerFn } from "@tanstack/react-start";

import { field, formData, formPost } from "~/lib/forms";
import { appContext } from "~/lib/request.server";

import {
  CalendarError,
  createEvent,
  deleteEvent,
  respondToEvent,
  updateEvent,
} from "./calendar.server";
import type { EventInput, EventView } from "./calendar.server";

export type CalendarResult =
  | { ok: true; intent: string; event: EventView | null }
  | { ok: false; error: string };

/** The ids a form names in `attendees`: a JSON array, or ids separated by whitespace or commas. */
const readAttendees = (data: FormData): string[] => {
  const raw = field(data, "attendees");

  if (!raw) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {
    // not JSON
  }

  return raw.split(/[\s,]+/u).filter(Boolean);
};

const readEvent = (data: FormData): EventInput => ({
  title: field(data, "title"),
  description: field(data, "description"),
  location: field(data, "location"),
  startsAt: field(data, "startsAt"),
  endsAt: field(data, "endsAt"),
  allDay: field(data, "allDay") === "1",
  timeZone: field(data, "timeZone", "UTC"),
  repeat: field(data, "repeat", "none"),
  repeatUntil: field(data, "repeatUntil") || null,
  attendees: readAttendees(data),
});

/**
 * One intent: `create` (the event's fields), `update` (`id` and the fields), `delete` (`id`) or `respond` (`id` and
 * `status`: accepted or declined, or needs-action to take an answer back).
 */
export const calendarAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }): Promise<CalendarResult> => {
    const { db, user } = await appContext();
    const intent = field(data, "intent");

    try {
      switch (intent) {
        case "create": {
          return {
            ok: true,
            intent,
            event: await createEvent(db, user.id, readEvent(data)),
          };
        }

        case "update": {
          return {
            ok: true,
            intent,
            event: await updateEvent(
              db,
              user.id,
              field(data, "id"),
              readEvent(data)
            ),
          };
        }

        case "delete": {
          if (!(await deleteEvent(db, user.id, field(data, "id")))) {
            return { ok: false, error: "No such event of yours." };
          }

          return { ok: true, intent, event: null };
        }

        case "respond": {
          return {
            ok: true,
            intent,
            event: await respondToEvent(
              db,
              user.id,
              field(data, "id"),
              field(data, "status")
            ),
          };
        }

        default: {
          break;
        }
      }

      return { ok: false, error: "Unknown action." };
    } catch (error) {
      if (error instanceof CalendarError) {
        return { ok: false, error: error.message };
      }

      throw error;
    }
  });
