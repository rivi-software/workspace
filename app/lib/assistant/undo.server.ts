import { and, eq, gte, isNull, lt } from "drizzle-orm";

import type { Database } from "~/db";
import { assistantUndos } from "~/db/schema";

import { newId } from "../ids";
import { UNDO_WINDOW_MS } from "./assistant";

/**
 * The undos of what the assistant did to a person's mail (`assistant_undos`). Mail's sealed undo puts a
 * change back whenever it is handed in and checks nothing again, so it never leaves the server: the tool keeps it
 * here and answers an id, and the step's Undo claims it by that id, once and within `UNDO_WINDOW_MS`.
 */

/** A person's undos are forgotten once they are this old, long after they could be taken. */
const KEPT_MS = 24 * 60 * 60 * 1000;

/** Keep an action's undo for its step, and answer the id the step carries. */
export const keepUndo = async (
  db: Database,
  userId: string,
  undo: string,
  now = new Date()
): Promise<string> => {
  const id = newId("au");

  await db
    .delete(assistantUndos)
    .where(
      and(
        eq(assistantUndos.userId, userId),
        lt(
          assistantUndos.createdAt,
          new Date(now.getTime() - KEPT_MS).toISOString()
        )
      )
    );

  await db
    .insert(assistantUndos)
    .values({ id, userId, undo, createdAt: now.toISOString() });

  return id;
};

export type ClaimedUndo =
  | { ok: true; undo: string }
  | { ok: false; why: "gone" | "late" };

/**
 * Take a person's undo to use it: the one statement that marks it used is the one that reads it, so of two claims
 * at once one gets it. `late` when its ten minutes are over, `gone` when it was used, is another person's or never
 * was.
 */
export const claimUndo = async (
  db: Database,
  userId: string,
  id: string,
  now = new Date()
): Promise<ClaimedUndo> => {
  const since = new Date(now.getTime() - UNDO_WINDOW_MS).toISOString();

  const mine = and(
    eq(assistantUndos.id, id),
    eq(assistantUndos.userId, userId)
  );

  const [claimed] = await db
    .update(assistantUndos)
    .set({ usedAt: now.toISOString() })
    .where(
      and(
        mine,
        isNull(assistantUndos.usedAt),
        gte(assistantUndos.createdAt, since)
      )
    )
    .returning({ undo: assistantUndos.undo });

  if (claimed) {
    return { ok: true, undo: claimed.undo };
  }

  const row = await db.query.assistantUndos.findFirst({ where: mine });

  return { ok: false, why: row && !row.usedAt ? "late" : "gone" };
};

/** Give a claimed undo back, when putting the change back failed and the person may try again. */
export const releaseUndo = async (db: Database, id: string): Promise<void> => {
  await db
    .update(assistantUndos)
    .set({ usedAt: null })
    .where(eq(assistantUndos.id, id));
};
