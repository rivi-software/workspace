import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";

import type { Database } from "~/db";
import type { User } from "~/db/schema";
import { listHref } from "~/lib/mail/links";
import {
  MAX_ORGANIZED,
  ORGANIZE_ACTIONS,
  organizeConversations,
} from "~/lib/mail/mail.server";

import { dayInput, timeInput } from "./planner-tools.server";
import type { AskContext } from "./time";
import { zonedMoment, zonedStamp } from "./time";
import { keepUndo } from "./undo.server";

/** A snooze that names a day and no time ends at this hour of it. */
const SNOOZE_HOUR = "08:00";

/**
 * What the assistant can do to the person's mail: one of the list's own actions on conversations it found,
 * through Mail's interface (`organizeConversations`), each undoable for a while from its step on the page: the
 * action's undo is kept on the server (`keepUndo`), and the step carries its id. It never
 * sends, never deletes for good, never mutes and never moves a conversation into Spam or out of it.
 */
export const organizeTools = (
  env: Env,
  db: Database,
  user: User,
  { timeZone }: AskContext
): ToolSet => ({
  organize_mail: tool({
    description:
      "Organise conversations in the person's mailbox, when they ask for it: one action on up to 100 conversations found with search_mail (their ids, th_…). archive takes them out of the inbox, inbox puts them back there, trash moves them to the trash (nothing is deleted for good), star and unstar, read and unread, snooze hides them until a day and time on the person's clock (08:00 without a time), unsnooze ends that, and label and unlabel put one of the person's labels on or take it off, by its name. Conversations in Spam are left alone. The person can undo the action from its step on the page for ten minutes.",
    inputSchema: z.object({
      conversationIds: z
        .array(z.string())
        .min(1)
        .max(MAX_ORGANIZED)
        .describe("The conversations' ids (th_…)."),
      action: z.enum(ORGANIZE_ACTIONS),
      untilDate: dayInput
        .optional()
        .describe("For snooze: the day they come back."),
      untilTime: timeInput
        .optional()
        .describe("For snooze: the time they come back; 08:00 when left out."),
      label: z
        .string()
        .max(100)
        .optional()
        .describe("For label and unlabel: the label's name."),
    }),
    execute: async ({
      conversationIds,
      action,
      untilDate,
      untilTime,
      label,
    }) => {
      const until =
        action === "snooze" && untilDate
          ? zonedMoment(untilDate, untilTime ?? SNOOZE_HOUR, timeZone)
          : null;

      if (action === "snooze" && !until) {
        return {
          error: "A snooze needs the day the conversations come back.",
        };
      }

      const done = await organizeConversations(
        db,
        env,
        user.id,
        conversationIds,
        { action, until: until ?? undefined, label }
      );

      if (!done.ok) {
        return { error: done.error };
      }

      const at = new Date();

      return {
        action,
        count: done.count,
        // Left alone, and said so: the conversations in Spam, and the ids that are no conversation of this mailbox.
        inSpam: done.inSpam || undefined,
        missing: done.missing || undefined,
        label: done.label,
        until: until ? zonedStamp(until, timeZone) : undefined,
        // When it was done, from which the step's Undo counts its ten minutes, and the id its undo is kept under
        // (`assistant_undos`): the undo itself never leaves the server. None when nothing changed.
        at: at.toISOString(),
        undoId: done.undo ? await keepUndo(db, user.id, done.undo, at) : null,
        link: listHref(),
      };
    },
  }),
});
