import {
  and,
  asc,
  eq,
  getTableName,
  inArray,
  isNotNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";

import type { Database } from "~/db";
import {
  accounts,
  aliases,
  assistantConversations,
  assistantMessages,
  attachments,
  calendarAttendees,
  calendarEvents,
  contacts,
  draftFiles,
  drafts,
  driveLinks,
  driveNodes,
  driveShares,
  driveStars,
  filters,
  githubConnections,
  handSignatures,
  imageSenders,
  labels,
  mailImports,
  messages,
  passkeys,
  pgpKeys,
  pgpPeerKeys,
  recoveryAddresses,
  recoveryTokens,
  senderRules,
  sessions,
  signatures,
  signingEvents,
  signingRequests,
  spamTokens,
  tasks,
  threadLabels,
  threads,
  twoFactors,
  users,
  workspaceSettings,
} from "~/db/schema";

/** Rows deleted by one statement: one bound value, however many rows, and short enough for D1's time limit. */
const ROW_BATCH = 500;

/** Drive nodes a round: their ids are bound one each, under D1's 100. */
const NODE_BATCH = 90;

/** Signing requests a round; each has up to two stored PDFs. */
const REQUEST_BATCH = 50;

/**
 * How many rounds (a statement, or a listing of stored objects and their deletion) one removal takes before it waits
 * for the next minute: well inside a Worker's budget of D1 queries and subrequests, with the rest of the cron after.
 */
export const REMOVAL_ROUNDS = 100;

/** One kind of thing of the person's; a round deletes up to its batch and answers how many it found (0: all gone). */
interface Step {
  /** The `table.column`s that name a person and are cleared once the step is through. */
  covers: string[];
  batch: number;
  round: (env: Env, db: Database, userId: string) => Promise<number>;
}

/** Up to `ROW_BATCH` rows of a table whose `column` names the person. */
const rows = (table: SQLiteTable, column: AnySQLiteColumn): Step => ({
  covers: [`${getTableName(table)}.${column.name}`],
  batch: ROW_BATCH,
  round: async (_env, db, userId) => {
    const result = await db.run(
      sql`delete from ${table} where rowid in (select rowid from ${table} where ${column} = ${userId} limit ${ROW_BATCH})`
    );

    return result.meta.changes;
  },
});

/** A colleague's row that names the person as who made or changed it keeps the row and forgets the name. */
const forget = (table: SQLiteTable, column: AnySQLiteColumn): Step => ({
  covers: [`${getTableName(table)}.${column.name}`],
  // One statement does all of it, so a second round is never needed.
  batch: Number.POSITIVE_INFINITY,
  round: async (_env, db, userId) => {
    const result = await db.run(
      sql`update ${table} set ${sql.identifier(column.name)} = null where ${column} = ${userId}`
    );

    return result.meta.changes;
  },
});

/**
 * The mail bucket under one of the person's prefixes (`raw/`, `att/`, `draft/` and their id): every raw message,
 * attachment and draft file is filed under its owner, so a listing finds them without reading the rows.
 */
const mailObjects = (prefix: string): Step => ({
  covers: [],
  batch: 1000,
  round: async (env, _db, userId) => {
    const listed = await env.MAIL.list({
      prefix: `${prefix}/${userId}/`,
      limit: 1000,
    });

    const keys = listed.objects.map((o) => o.key);

    if (keys.length) {
      await env.MAIL.delete(keys);
    }

    return keys.length;
  },
});

/**
 * The person's Drive: every node they own, their files' objects with them. A folder's subtree is the owner's alone
 * (`moveNodes` keeps a node with its owner), so the owner's rows are the whole of it; shares, links and stars on
 * the nodes go with them (`on delete cascade`), and a signing request made from a file forgets it.
 */
const driveRound: Step = {
  covers: ["drive_nodes.user_id"],
  batch: NODE_BATCH,
  round: async (env, db, userId) => {
    const nodes = await db.query.driveNodes.findMany({
      where: eq(driveNodes.userId, userId),
      limit: NODE_BATCH,
    });

    const keys: string[] = [];

    for (const n of nodes) {
      if (n.r2Key && n.uploadId) {
        try {
          // oxlint-disable-next-line eslint/no-await-in-loop -- an unfinished upload's parts are dropped one upload at a time
          await env.DRIVE.resumeMultipartUpload(n.r2Key, n.uploadId).abort();
        } catch {
          // already gone, or completed
        }
      }

      if (n.r2Key) {
        keys.push(n.r2Key);
      }
    }

    // The objects go before the rows, so a failure leaves rows that still point at what remains.
    if (keys.length) {
      await env.DRIVE.delete(keys);
    }

    if (nodes.length) {
      await db.delete(driveNodes).where(
        inArray(
          driveNodes.id,
          nodes.map((n) => n.id)
        )
      );
    }

    return nodes.length;
  },
};

/**
 * Every signing request the person asked or was to sign, with its copies of the PDF; its events go with it. A
 * colleague's request with the person as signer goes too: it cannot name a signer who is no longer there.
 */
const signingRound: Step = {
  covers: ["signing_requests.created_by", "signing_requests.signer_id"],
  batch: REQUEST_BATCH,
  round: async (env, db, userId) => {
    const requests = await db.query.signingRequests.findMany({
      where: or(
        eq(signingRequests.createdBy, userId),
        eq(signingRequests.signerId, userId)
      ),
      limit: REQUEST_BATCH,
    });

    const keys = requests.flatMap((r) =>
      r.signedKey ? [r.originalKey, r.signedKey] : [r.originalKey]
    );

    if (keys.length) {
      await env.DRIVE.delete(keys);
    }

    if (requests.length) {
      await db.delete(signingRequests).where(
        inArray(
          signingRequests.id,
          requests.map((r) => r.id)
        )
      );
    }

    return requests.length;
  },
};

/** The nodes a person made in a colleague's folder stay the colleague's, without a maker. */
const forgetDriveMaker: Step = {
  covers: ["drive_nodes.created_by"],
  batch: Number.POSITIVE_INFINITY,
  round: async (_env, db, userId) => {
    const result = await db
      .update(driveNodes)
      .set({ createdBy: null })
      .where(
        and(eq(driveNodes.createdBy, userId), ne(driveNodes.userId, userId))
      );

    return result.meta.changes;
  },
};

/**
 * In the order the foreign keys need: what points at a row goes before it. `test/removal.test.ts` fails on a table
 * that names a person and is not here, so a new one is added with its table.
 */
export const REMOVAL_STEPS: readonly Step[] = [
  // Mail: the stored objects first, then the rows from the leaves in.
  mailObjects("raw"),
  mailObjects("att"),
  mailObjects("draft"),
  rows(draftFiles, draftFiles.userId),
  rows(drafts, drafts.userId),
  rows(attachments, attachments.userId),
  rows(threadLabels, threadLabels.userId),
  rows(messages, messages.userId),
  rows(threads, threads.userId),
  rows(labels, labels.userId),
  rows(contacts, contacts.userId),
  rows(filters, filters.userId),
  rows(spamTokens, spamTokens.userId),
  rows(senderRules, senderRules.userId),
  rows(imageSenders, imageSenders.userId),
  rows(signatures, signatures.userId),
  rows(mailImports, mailImports.userId),
  rows(pgpPeerKeys, pgpPeerKeys.userId),
  rows(pgpKeys, pgpKeys.userId),
  // Signing, then Drive.
  signingRound,
  forget(signingEvents, signingEvents.userId),
  rows(handSignatures, handSignatures.userId),
  rows(driveStars, driveStars.userId),
  rows(driveShares, driveShares.userId),
  rows(driveShares, driveShares.ownerId),
  rows(driveLinks, driveLinks.createdBy),
  forget(driveLinks, driveLinks.revokedBy),
  forgetDriveMaker,
  driveRound,
  // The Assistant, Calendar and Tasks.
  rows(assistantMessages, assistantMessages.userId),
  rows(assistantConversations, assistantConversations.userId),
  rows(calendarAttendees, calendarAttendees.userId),
  rows(calendarEvents, calendarEvents.userId),
  rows(tasks, tasks.userId),
  rows(githubConnections, githubConnections.userId),
  // Signing in, and the addresses, which bounce until here and are free once the row goes.
  rows(sessions, sessions.userId),
  rows(accounts, accounts.userId),
  rows(twoFactors, twoFactors.userId),
  rows(passkeys, passkeys.userId),
  rows(recoveryTokens, recoveryTokens.userId),
  rows(recoveryAddresses, recoveryAddresses.userId),
  rows(aliases, aliases.userId),
  forget(workspaceSettings, workspaceSettings.updatedBy),
];

/**
 * Take a removal on by up to `rounds` rounds: each step runs until a round finds less than its batch, and once the
 * last step is through the person's row goes. Answers whether they are gone. Every round deletes what is there, so
 * two runs at once (the cron overlapping itself, or the admin's request) only repeat work, never break it, and a
 * run cut short goes on from the first step the next time.
 */
export const continueRemoval = async (
  env: Env,
  db: Database,
  userId: string,
  rounds = REMOVAL_ROUNDS
): Promise<boolean> => {
  let left = rounds;

  for (const step of REMOVAL_STEPS) {
    for (;;) {
      if (left <= 0) {
        return false;
      }

      left -= 1;
      // oxlint-disable-next-line eslint/no-await-in-loop -- each round reads what the one before left, in the order the foreign keys need
      const found = await step.round(env, db, userId);

      if (found < step.batch) {
        break;
      }
    }
  }

  await db
    .delete(users)
    .where(and(eq(users.id, userId), isNotNull(users.removingSince)));

  return true;
};

/** The cron's part: the removals under way, oldest first, each as far as its rounds go. Answers how many finished. */
export const runRemovals = async (env: Env, db: Database): Promise<number> => {
  const removing = await db
    .select({ id: users.id })
    .from(users)
    .where(isNotNull(users.removingSince))
    .orderBy(asc(users.removingSince))
    .limit(3);

  let finished = 0;

  for (const r of removing) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one person at a time, so the minute's budget is shared in order
    if (await continueRemoval(env, db, r.id)) {
      finished += 1;
    }
  }

  return finished;
};
