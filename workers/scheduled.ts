import { captureServerException } from "@rivi-software/posthog-tanstack-start/server";

import { createDb } from "~/db";
import type { Database } from "~/db";
import { pruneDrive } from "~/lib/drive/drive.server";
import { runImports } from "~/lib/mail/import/import.server";
import { pruneExpired } from "~/lib/mail/mailbox.server";
import { sendDueDrafts } from "~/lib/mail/schedule.server";
import { pruneSpamTokens } from "~/lib/mail/spam.server";
import { wakeSnoozed } from "~/lib/mail/threads.server";
import { runRemovals } from "~/lib/removal.server";
import { indexForSearch } from "~/lib/search/indexer.server";

/**
 * The housekeeping, last in the cron: the cron's D1 queries share one invocation's limit, and the mail matters more.
 * Drive's and Mail's prunes and the spam filters' fail on their own too.
 */
const prune = async (env: Env, db: Database, at: Date): Promise<void> => {
  try {
    const { deleted, abandoned } = await pruneDrive(env, db);

    if (deleted || abandoned) {
      console.log(
        JSON.stringify({ event: "drive.pruned", deleted, abandoned })
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({ event: "drive.prune.error", error: String(error) })
    );
    captureServerException(error, {
      properties: { handler: "scheduled", job: "drive-prune" },
    });
  }

  try {
    const deleted = await pruneExpired(db, env);

    if (deleted) {
      console.log(JSON.stringify({ event: "mail.pruned", deleted }));
    }
  } catch (error) {
    console.error(
      JSON.stringify({ event: "mail.prune.error", error: String(error) })
    );
    captureServerException(error, {
      properties: { handler: "scheduled", job: "mail-prune" },
    });
  }

  try {
    const turn = await pruneSpamTokens(db, at);

    if (turn?.forgotten) {
      console.log(
        JSON.stringify({ event: "mail.spam.pruned", forgotten: turn.forgotten })
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({ event: "mail.spam.prune.error", error: String(error) })
    );
    captureServerException(error, {
      properties: { handler: "scheduled", job: "spam-prune" },
    });
  }
};

/**
 * The cron (`triggers` in wrangler.jsonc, every minute): snoozed conversations whose time came wake in every mailbox,
 * the scheduled messages that are due go out, then each running mailbox import takes a batch, then the people an admin
 * removed lose another batch of what was theirs, then the search by meaning reads a few conversations and files into
 * its index. Last, a batch of what
 * expired goes in every drive and every mailbox: Drive's trash after 30 days and the uploads abandoned for a day, then
 * Mail's trash and Spam after 30 days, whether or not anyone opens Drive or Mail; then the spam filter of the mailbox
 * whose turn the minute `at` is forgets its idle words, each mailbox once a day. `at` is the minute the run was
 * scheduled for, now when a test runs the cron itself. Each part fails on its own, so a broken import never holds
 * back the mail.
 */
export const handleScheduled = async (
  env: Env,
  at = new Date()
): Promise<void> => {
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

  try {
    const removed = await runRemovals(env, db);

    if (removed) {
      console.log(JSON.stringify({ event: "people.removed", removed }));
    }
  } catch (error) {
    console.error(
      JSON.stringify({ event: "people.removal_error", error: String(error) })
    );
    captureServerException(error, {
      properties: { handler: "scheduled", job: "removal" },
    });
  }

  // After the mail: a few conversations and files read into the index, and the vectors of what is gone taken out.
  // It does nothing where the Worker has no index.
  try {
    const done = await indexForSearch(env, db);

    if (done?.indexed || done?.removed) {
      console.log(JSON.stringify({ event: "search.indexed", ...done }));
    }
  } catch (error) {
    console.error(
      JSON.stringify({ event: "search.index.error", error: String(error) })
    );
    captureServerException(error, {
      properties: { handler: "scheduled", job: "search-index" },
    });
  }

  await prune(env, db, at);
};
