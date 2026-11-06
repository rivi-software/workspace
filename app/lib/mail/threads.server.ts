/**
 * The state of a mailbox's conversations, and every write to it: where each sits (its folder, `trashed_at`, a
 * snooze), its marks (star, mute, read, labels) and its counters. The actions on conversations and their undo, what a
 * filed message does to its conversation (`filing.server.ts`), blocking a sender's conversation, the snooze's waking
 * and the recount after a message changes all go through here, so the rules live in one place:
 * - the trash and Spam note when a conversation went there (`trashed_at`, which `pruneExpired` counts 30 days
 *   from), every other folder forgets it, and a move ends a snooze;
 * - a move the owner makes into Spam teaches the spam filter that the mail others sent in it is spam, one out of
 *   Spam to the inbox or the archive that it is not (`learnThreads`); the trash says nothing either way, and neither
 *   does a filed message, which the spam filter judged itself;
 * - what each intent does is `intentEffect` in `views.ts`, which the list on the client reads too;
 * - an action answers its undo as a sealed record of what it changed, and the undo puts exactly that back, checking
 *   nothing again: the earlier folder, `trashed_at`, snooze, star, mute, read state and labels, and what the spam
 *   filter learnt, a message it had not learnt before unlearnt again.
 * The times come from `now`, which the tests set.
 */
import { and, asc, eq, gt, isNotNull, sql } from "drizzle-orm";

import type { Database } from "~/db";
import {
  aliases,
  attachments,
  labels,
  messages,
  threadLabels,
  threads,
  users,
} from "~/db/schema";
import type { Address, Thread, User } from "~/db/schema";
import { defined } from "~/lib/guards";

import { newId } from "../ids";
import { openSecret, sealSecret } from "../secret-box.server";
import { snippetOf } from "../text";
import { parseJsonAddresses } from "./addresses";
import type { Place } from "./folders";
import { deleteThreadForever, inIds, listWhere } from "./mailbox.server";
import type { ListOptions } from "./mailbox.server";
import { senderRuleMatches } from "./spam";
import { learnThreads, restoreLearnt } from "./spam.server";
import type { Learnt } from "./spam.server";
import { intentEffect } from "./views";
import type { ThreadAction } from "./views";

export class ThreadActionError extends Error {
  override name = "ThreadActionError";
}

/** Where a conversation sits: its folder, when it went to the trash or Spam, and a snooze. */
type Spot = Pick<Thread, "folder" | "trashedAt" | "snoozedUntil">;

/** The fields of a conversation an action changed, as they were before it. */
type Earlier = Partial<
  Pick<Thread, "folder" | "trashedAt" | "snoozedUntil" | "starred" | "muted">
>;

/** What an action changed, as its undo puts it back. */
interface Changes {
  user: string;
  threads: [id: string, earlier: Earlier][];
  /** The messages whose read flag it turned, with the flag they had, and their conversations. */
  read?: { was: boolean; threads: string[]; messages: string[] };
  /** The conversations a label went on (`added`) or came off (`removed`). */
  label?: { id: string; added: string[]; removed: string[] };
  /** What the spam filter learnt from it: each message with what it taught before. */
  learnt?: Learnt[];
}

/** Changes being recorded: each conversation's earlier fields once, whatever touched them first. */
interface Recording {
  readonly earlier: Map<string, Earlier>;
  read?: Changes["read"];
  label?: Changes["label"];
  learnt: Learnt[];
  note: (t: Thread, keys: (keyof Earlier)[]) => void;
}

const startRecording = (): Recording => {
  const earlier = new Map<string, Earlier>();

  return {
    earlier,
    learnt: [],
    note: (t, keys) => {
      const was = earlier.get(t.id) ?? {};

      for (const k of keys) {
        if (!(k in was)) {
          Object.assign(was, { [k]: t[k] });
        }
      }

      earlier.set(t.id, was);
    },
  };
};

const UNDO_PURPOSE = "mail-undo";

const isJunk = (folder: Place) => folder === "trash" || folder === "spam";

/** A conversation moved to `folder` at `now`: the trash and Spam note when, every other folder forgets it, and a snooze ends. */
const movedTo = (folder: Place, now: Date): Spot => ({
  folder,
  trashedAt: isJunk(folder) ? now.toISOString() : null,
  snoozedUntil: null,
});

/** `set` on the owner's conversations among `ids`, in one statement whatever their number. */
const update = async (
  db: Database,
  userId: string,
  ids: string[],
  set: Partial<typeof threads.$inferInsert>
) => {
  if (!ids.length) {
    return;
  }

  await db
    .update(threads)
    .set(set)
    .where(and(eq(threads.userId, userId), inIds(threads.id, ids)));
};

/** Marks on conversations (star, mute, the end of a snooze), noted for the undo. */
const mark = async (
  db: Database,
  userId: string,
  rows: Thread[],
  set: Pick<Earlier, "starred" | "muted" | "snoozedUntil">,
  recording: Recording | null
) => {
  // SAFETY: `set` is a Pick of Earlier's marks, so every key of it is a key of Earlier.
  const keys = Object.keys(set) as (keyof Earlier)[];

  for (const t of rows) {
    recording?.note(t, keys);
  }

  await update(
    db,
    userId,
    rows.map((t) => t.id),
    set
  );
};

/**
 * What the spam filter learns from a move: the conversations that go into Spam teach "spam", those that leave it for
 * the inbox or the archive teach "ham", and a move into the trash teaches nothing.
 */
const learnFromMove = async (
  db: Database,
  userId: string,
  moving: Thread[],
  spot: Spot
): Promise<Learnt[]> => {
  if (spot.folder === "trash") {
    return [];
  }

  const intoSpam = spot.folder === "spam";

  const ids = moving.flatMap((t) =>
    (t.folder === "spam") === intoSpam ? [] : [t.id]
  );

  return await learnThreads(db, userId, ids, intoSpam ? "spam" : "ham");
};

/**
 * Conversations to a spot (a folder, or the inbox with a snooze), those already there left alone. A move the owner
 * makes (`learn`) into Spam or out of it to the inbox or the archive teaches the spam filter.
 */
const relocate = async (
  db: Database,
  userId: string,
  rows: Thread[],
  spot: Spot,
  options: { learn: boolean; recording: Recording | null }
) => {
  const moving = rows.filter(
    (t) => t.folder !== spot.folder || t.snoozedUntil !== spot.snoozedUntil
  );

  if (!moving.length) {
    return;
  }

  for (const t of moving) {
    options.recording?.note(t, ["folder", "trashedAt", "snoozedUntil"]);
  }

  await update(
    db,
    userId,
    moving.map((t) => t.id),
    spot
  );

  if (!options.learn) {
    return;
  }

  const learnt = await learnFromMove(db, userId, moving, spot);

  options.recording?.learnt.push(...learnt);
};

const recountUnread = async (db: Database, threadIds: string[]) => {
  await db
    .update(threads)
    .set({
      unreadCount: sql`(select count(*) from messages where thread_id = ${threads.id} and read = 0)`,
    })
    .where(inIds(threads.id, threadIds));
};

/** The messages of the owner's conversations read or unread, their unread counts with them. */
const setRead = async (
  db: Database,
  userId: string,
  threadIds: string[],
  read: boolean,
  recording: Recording | null
) => {
  if (!threadIds.length) {
    return;
  }

  const turned = await db
    .update(messages)
    .set({ read })
    .where(
      and(
        eq(messages.userId, userId),
        inIds(messages.threadId, threadIds),
        eq(messages.read, !read)
      )
    )
    .returning({ id: messages.id, threadId: messages.threadId });

  if (!turned.length) {
    return;
  }

  const touched = [...new Set(turned.map((m) => m.threadId))];
  await recountUnread(db, touched);

  if (recording) {
    recording.read = {
      was: !read,
      threads: touched,
      messages: turned.map((m) => m.id),
    };
  }
};

/** A label on conversations, one row each from the JSON array (a `values` row binds three); a deleted label is skipped. */
const addLabel = async (
  db: Database,
  userId: string,
  labelId: string,
  threadIds: string[]
) => {
  if (!threadIds.length) {
    return;
  }

  await db.run(
    sql`insert into ${threadLabels} (thread_id, label_id, user_id)
      select j.value, l.id, ${userId} from json_each(${JSON.stringify(threadIds)}) j
      join labels l on l.id = ${labelId} and l.user_id = ${userId}
      where true on conflict do nothing`
  );
};

const removeLabel = async (
  db: Database,
  userId: string,
  labelId: string,
  threadIds: string[]
) => {
  if (!threadIds.length) {
    return;
  }

  await db
    .delete(threadLabels)
    .where(
      and(
        eq(threadLabels.userId, userId),
        eq(threadLabels.labelId, labelId),
        inIds(threadLabels.threadId, threadIds)
      )
    );
};

const sealUndo = async (
  env: Env,
  userId: string,
  recording: Recording
): Promise<string | null> => {
  if (
    !recording.earlier.size &&
    !recording.read &&
    !recording.label &&
    !recording.learnt.length
  ) {
    return null;
  }

  const changes: Changes = {
    user: userId,
    threads: [...recording.earlier],
    read: recording.read,
    label: recording.label,
    learnt: recording.learnt,
  };

  return await sealSecret(env, UNDO_PURPOSE, JSON.stringify(changes));
};

type Effect = ReturnType<typeof intentEffect>;

/** Deletes the conversations for good, one at a time; how many went. */
const deleteForever = async (
  db: Database,
  env: Env,
  userId: string,
  rows: Thread[]
): Promise<number> => {
  let count = 0;

  for (const t of rows) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one thread at a time, so a failure leaves a known state: the ones before it done, the rest untouched
    if (await deleteThreadForever(db, env, userId, t.id)) {
      count += 1;
    }
  }

  return count;
};

/** A snooze needs a moment that is a date and at least a minute away. */
const checkSnooze = (action: ThreadAction, now: Date) => {
  if (action.intent !== "snooze") {
    return;
  }

  const until = action.until ? new Date(action.until) : null;

  if (!until || Number.isNaN(until.getTime())) {
    throw new ThreadActionError(
      "Choose when the conversation should come back."
    );
  }

  if (until.getTime() < now.getTime() + 60_000) {
    throw new ThreadActionError("That moment has passed: choose a later one.");
  }
};

const findLabel = async (db: Database, userId: string, id: string) =>
  await db.query.labels.findFirst({
    where: and(eq(labels.id, id), eq(labels.userId, userId)),
  });

/** The label an intent puts on or takes off, which must still exist; null for an intent without one. */
const labelOf = async (db: Database, userId: string, effect: Effect) => {
  if (!effect.label) {
    return null;
  }

  const label = await findLabel(db, userId, effect.label.id);

  if (!label) {
    throw new ThreadActionError("That label no longer exists.");
  }

  return label;
};

/** A label put on the conversations that lack it, or taken off those that have it, noted for the undo. */
const changeLabel = async (
  db: Database,
  userId: string,
  labelId: string,
  on: boolean,
  own: string[],
  recording: Recording
) => {
  const threadLabelsRows = await db.query.threadLabels.findMany({
    where: and(
      eq(threadLabels.labelId, labelId),
      inIds(threadLabels.threadId, own)
    ),
  });

  const had = new Set(threadLabelsRows.map((r) => r.threadId));

  const added = on ? own.filter((id) => !had.has(id)) : [];
  const removed = on ? [] : own.filter((id) => had.has(id));
  await addLabel(db, userId, labelId, added);
  await removeLabel(db, userId, labelId, removed);

  if (added.length || removed.length) {
    recording.label = { id: labelId, added, removed };
  }
};

/** The marks, the move and the wake an intent asks for, each noted in the recording. */
const applyMarks = async (
  db: Database,
  userId: string,
  rows: Thread[],
  effect: Effect,
  recording: Recording,
  now: Date
) => {
  const { starred, muted, move } = effect;

  if (starred !== undefined) {
    await mark(
      db,
      userId,
      rows.filter((t) => t.starred !== starred),
      { starred },
      recording
    );
  }

  if (muted !== undefined) {
    await mark(
      db,
      userId,
      rows.filter((t) => t.muted !== muted),
      { muted },
      recording
    );
  }

  if (move) {
    const until =
      move.snoozedUntil && new Date(move.snoozedUntil).toISOString();

    await relocate(
      db,
      userId,
      move.from ? rows.filter((t) => t.folder === move.from) : rows,
      { ...movedTo(move.folder, now), snoozedUntil: until },
      { learn: true, recording }
    );
  }

  if (effect.wake) {
    await mark(
      db,
      userId,
      rows.filter((t) => t.snoozedUntil),
      { snoozedUntil: null },
      recording
    );
  }
};

/**
 * One intent on the owner's threads among `ids` (at most 500): star, move (archive, trash, spam, inbox), read state,
 * delete for good (from the trash or spam), mute, snooze, a label on or off. Answers how many it acted on and its
 * undo for `undoThreadAction`: null when it changed nothing, or deleted.
 */
export const applyThreadAction = async (
  db: Database,
  env: Env,
  userId: string,
  ids: string[],
  action: ThreadAction,
  now = new Date()
): Promise<{ undo: string | null; count: number }> => {
  const unique = [...new Set(ids)].filter(Boolean).slice(0, 500);

  if (!unique.length) {
    return { undo: null, count: 0 };
  }

  const rows = await db.query.threads.findMany({
    where: and(eq(threads.userId, userId), inIds(threads.id, unique)),
  });

  const own = rows.map((t) => t.id);

  if (!own.length) {
    return { undo: null, count: 0 };
  }

  // What the intent does is `intentEffect` (`views.ts`), the list's prediction of it too.
  const effect = intentEffect(action);

  if (effect.deleted) {
    return { undo: null, count: await deleteForever(db, env, userId, rows) };
  }

  checkSnooze(action, now);

  const label = await labelOf(db, userId, effect);
  const recording = startRecording();

  await applyMarks(db, userId, rows, effect, recording, now);

  if (effect.read !== undefined) {
    await setRead(db, userId, own, effect.read, recording);
  }

  if (label && effect.label) {
    await changeLabel(db, userId, label.id, effect.label.on, own, recording);
  }

  return { undo: await sealUndo(env, userId, recording), count: own.length };
};

/**
 * Put back what an action changed (its `undo`), exactly as it was: nothing is checked again (a snooze that ends
 * within the minute, a label deleted since) and nothing is learnt again. False for an undo that is not the owner's.
 */
export const undoThreadAction = async (
  db: Database,
  env: Env,
  userId: string,
  undo: string
): Promise<boolean> => {
  const opened = await openSecret(env, UNDO_PURPOSE, undo);

  if (!opened) {
    return false;
  }

  // SAFETY: the text is what `sealUndo` sealed under the undo purpose: opening it proves it is a `Changes` this module wrote.
  const changes = JSON.parse(opened) as Changes;

  if (changes.user !== userId) {
    return false;
  }

  // Conversations that were alike go back in one statement.
  const alike = new Map<string, string[]>();

  for (const [id, earlier] of changes.threads) {
    const key = JSON.stringify(earlier);
    alike.set(key, [...(alike.get(key) ?? []), id]);
  }

  for (const [key, ids] of alike) {
    // SAFETY: `key` is `JSON.stringify` of an `Earlier` from the undo's own record, a few lines above.
    // oxlint-disable-next-line eslint/no-await-in-loop -- one thread at a time, so a failure leaves a known state: the ones before it done, the rest untouched
    await update(db, userId, ids, JSON.parse(key) as Earlier);
  }

  if (changes.read) {
    await db
      .update(messages)
      .set({ read: changes.read.was })
      .where(
        and(
          eq(messages.userId, userId),
          inIds(messages.id, changes.read.messages)
        )
      );
    await recountUnread(db, changes.read.threads);
  }

  if (changes.label) {
    await removeLabel(db, userId, changes.label.id, changes.label.added);
    await addLabel(db, userId, changes.label.id, changes.label.removed);
  }

  await restoreLearnt(db, userId, changes.learnt ?? []);

  return true;
};

/** Opening a conversation reads it. */
export const markThreadRead = async (
  db: Database,
  userId: string,
  threadId: string
) => {
  await setRead(db, userId, [threadId], true, null);
};

/** Every thread a view shows, read; at most 1000 at a time. */
export const markAllRead = async (
  db: Database,
  userId: string,
  options: ListOptions
) => {
  const { where } = listWhere(userId, options);

  const rows = await db
    .select({ id: threads.id })
    .from(threads)
    .where(and(...where, gt(threads.unreadCount, 0)))
    .limit(1000);

  await setRead(
    db,
    userId,
    rows.map((r) => r.id),
    true,
    null
  );

  return rows.length;
};

/**
 * Snoozed conversations whose moment has come return to the top of the inbox: the owner's, or every mailbox's (the
 * cron, each minute). One update, searched per mailbox on `threads_user_snoozed_idx`: without a `user_id` it would
 * read every thread, every minute.
 */
export const wakeSnoozed = async (
  db: Database,
  now = new Date(),
  userId?: string
) => {
  const at = now.toISOString();

  const woken = await db
    .update(threads)
    .set({ ...movedTo("inbox", now), lastMessageAt: at })
    .where(
      and(
        userId
          ? eq(threads.userId, userId)
          : sql`${threads.userId} in (select id from users)`,
        isNotNull(threads.snoozedUntil),
        sql`${threads.snoozedUntil} <= ${at}`
      )
    )
    .returning({ id: threads.id });

  return woken.length;
};

/**
 * After blocking a sender from a message's menu: their conversation goes to Spam too, learnt as spam, when
 * everything others sent in it is theirs. A conversation with other people in it stays. Answers whether it moved.
 */
export const blockConversation = async (
  db: Database,
  userId: string,
  threadId: string,
  sender: string,
  now = new Date()
): Promise<boolean> => {
  const thread = await db.query.threads.findFirst({
    where: and(eq(threads.id, threadId), eq(threads.userId, userId)),
  });

  if (!thread || thread.folder === "spam") {
    return false;
  }

  const senders = await db
    .selectDistinct({ from: messages.fromEmail })
    .from(messages)
    .where(
      and(eq(messages.threadId, thread.id), eq(messages.direction, "inbound"))
    );

  if (
    !senders.length ||
    !senders.every((s) => senderRuleMatches(sender, s.from))
  ) {
    return false;
  }

  await relocate(db, userId, [thread], movedTo("spam", now), {
    learn: true,
    recording: null,
  });

  return true;
};

/* ---------- what a filed message does to its conversation (`filing.server.ts`) ---------- */

/** A new conversation for a message, in `folder` (the trash and Spam noting when) and starred or not. */
export const startThread = async (
  db: Database,
  userId: string,
  subject: string,
  place: { folder: Place; starred: boolean },
  now = new Date()
): Promise<Thread> => {
  const id = newId("th");
  await db.insert(threads).values({
    id,
    userId,
    subject,
    starred: place.starred,
    ...movedTo(place.folder, now),
  });

  return defined(
    await db.query.threads.findFirst({ where: eq(threads.id, id) }),
    "the result of find first"
  );
};

/** What a filed message asks of its conversation. */
export interface Asked {
  folder?: Place | null;
  unsnooze?: boolean;
  starred?: boolean;
  labelIds?: string[];
}

/**
 * What a filed message asks of its conversation: a move (nothing for one already there), the end of a snooze, a
 * star, labels. Nothing is learnt: the spam filter judged the message itself.
 */
export const settleThread = async (
  db: Database,
  thread: Thread,
  asked: Asked,
  now = new Date()
) => {
  if (asked.folder) {
    await relocate(db, thread.userId, [thread], movedTo(asked.folder, now), {
      learn: false,
      recording: null,
    });
  } else if (asked.unsnooze && thread.snoozedUntil) {
    await mark(db, thread.userId, [thread], { snoozedUntil: null }, null);
  }

  if (asked.starred && !thread.starred) {
    await mark(db, thread.userId, [thread], { starred: true }, null);
  }

  // The labels as one JSON array, each a row (a `values` row binds three); a label deleted since is skipped.
  if (asked.labelIds?.length) {
    await db.run(
      sql`insert into ${threadLabels} (thread_id, label_id, user_id)
        select ${thread.id}, l.id, ${thread.userId} from json_each(${JSON.stringify(asked.labelIds)}) j
        join labels l on l.id = j.value and l.user_id = ${thread.userId}
        where true on conflict do nothing`
    );
  }
};

/* ---------- counters and the owner ---------- */

/** A person's own addresses: their mailbox first, then their aliases. */
export const ownAddresses = async (
  db: Database,
  user: Pick<User, "id" | "email">
): Promise<Set<string>> => {
  const own = new Set([user.email]);

  for (const a of await db.query.aliases.findMany({
    where: eq(aliases.userId, user.id),
  })) {
    own.add(a.address);
  }

  return own;
};

/**
 * The thread's counters, snippet, people and last activity, from its messages. Called after every message change;
 * a thread left without messages is removed.
 */
export const recomputeThread = async (db: Database, threadId: string) => {
  const thread = await db.query.threads.findFirst({
    where: eq(threads.id, threadId),
  });

  if (!thread) {
    return;
  }

  const rows = await db.query.messages.findMany({
    where: eq(messages.threadId, threadId),
    orderBy: [asc(messages.date), asc(messages.createdAt)],
  });

  if (!rows.length) {
    await db.delete(threadLabels).where(eq(threadLabels.threadId, threadId));
    await db.delete(threads).where(eq(threads.id, threadId));

    return;
  }

  const owner = await db.query.users.findFirst({
    where: eq(users.id, thread.userId),
  });

  const own = owner ? await ownAddresses(db, owner) : new Set<string>();
  const people = new Map<string, Address>();

  for (const m of rows) {
    const all: Address[] = [
      { email: m.fromEmail, name: m.fromName },
      ...parseJsonAddresses(m.toJson),
      ...parseJsonAddresses(m.ccJson),
    ];

    for (const a of all) {
      if (own.has(a.email)) {
        continue;
      }

      const prev = people.get(a.email);

      if (!prev || (!prev.name && a.name)) {
        people.set(a.email, a);
      }
    }
  }

  const last = defined(rows.at(-1), "the last message of the thread");

  const [files] = await db
    .select({ n: sql<number>`count(*)` })
    .from(attachments)
    .where(
      and(
        sql`${attachments.messageId} in (select id from messages where thread_id = ${threadId})`,
        eq(attachments.inline, false)
      )
    );

  const lastAt = last.date > last.createdAt ? last.createdAt : last.date;
  await db
    .update(threads)
    .set({
      messageCount: rows.length,
      unreadCount: rows.filter((m) => !m.read).length,
      sentCount: rows.filter((m) => m.direction === "outbound").length,
      hasAttachments: Number(files?.n ?? 0) > 0,
      participantsJson: JSON.stringify([...people.values()]),
      snippet: snippetOf(last.text),
      // A thread woken from a snooze sits at the time it woke until something newer happens to it.
      lastMessageAt:
        thread.lastMessageAt > lastAt && thread.messageCount === rows.length
          ? thread.lastMessageAt
          : lastAt,
      subject: thread.subject || rows[0].subject,
    })
    .where(eq(threads.id, threadId));
};
