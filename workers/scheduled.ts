import { captureServerException } from "@rivi-software/posthog-tanstack-start/server";

import { createDb } from "~/db";
import { runImports } from "~/lib/mail/import/import.server";
import { sendDueDrafts } from "~/lib/mail/schedule.server";
import { wakeSnoozed } from "~/lib/mail/threads.server";

/**
 * The cron (`triggers` in wrangler.jsonc, every minute): snoozed conversations whose time came wake in every mailbox,
 * the scheduled messages that are due go out, then each running mailbox import takes a batch. Each part fails on
 * its own, so a broken import never holds back the mail.
 */
export const handleScheduled = async (env: Env): Promise<void> => {
  const db = createDb(env.DB);

  try {
    // Whoever reads the mail, the Assistant too, finds them back in the inbox, whether or not /mail was opened.
    const woken = await wakeSnoozed(db);

    if (woken) {
      console.log(JSON.stringify({ event: "mail.snooze.woken", woken }));
    }
  } catch (error) {
    console.error(
      JSON.stringify({ event: "mail.snooze.error", error: String(error) })
    );
    captureServerException(error, {
      properties: { handler: "scheduled", job: "wake" },
    });
  }

  try {
    const { sent, failed } = await sendDueDrafts(env, db);

    if (sent || failed) {
      console.log(
        JSON.stringify({ event: "mail.scheduled.sent", sent, failed })
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({ event: "mail.scheduled.error", error: String(error) })
    );
    captureServerException(error, {
      properties: { handler: "scheduled", job: "send" },
    });
  }

  try {
    const { batches, imported } = await runImports(env, db);

    if (batches) {
      console.log(
        JSON.stringify({ event: "mail.import.batch", batches, imported })
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({ event: "mail.import.batch_error", error: String(error) })
    );
    captureServerException(error, {
      properties: { handler: "scheduled", job: "import" },
    });
  }
};
