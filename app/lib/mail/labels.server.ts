import { and, asc, eq, sql } from "drizzle-orm";

import type { Database } from "~/db";
import { labels } from "~/db/schema";

import { newId } from "../ids";
import { MAX_LABEL_NAME, isLabelColor } from "./folders";
import type { LabelColor, LabelRef } from "./folders";

export class LabelError extends Error {
  override name = "LabelError";
}

/** A person's labels, by name. */
export const listLabels = async (
  db: Database,
  userId: string
): Promise<LabelRef[]> => {
  const rows = await db.query.labels.findMany({
    where: eq(labels.userId, userId),
    orderBy: [asc(sql`lower(${labels.name})`)],
  });

  return rows.map((l) => ({
    id: l.id,
    name: l.name,
    color: isLabelColor(l.color) ? l.color : "gray",
  }));
};

const cleanName = (name: string): string => {
  const clean = name.replaceAll(/\s+/gu, " ").trim();

  if (!clean) {
    throw new LabelError("A label needs a name.");
  }

  if (clean.length > MAX_LABEL_NAME) {
    throw new LabelError(
      `A label's name is at most ${MAX_LABEL_NAME} characters.`
    );
  }

  return clean;
};

const nameTaken = async (
  db: Database,
  userId: string,
  name: string,
  exceptId?: string
) => {
  const same = await db.query.labels.findFirst({
    where: and(
      eq(labels.userId, userId),
      sql`lower(${labels.name}) = ${name.toLowerCase()}`
    ),
  });

  return !!same && same.id !== exceptId;
};

/** Add a label; the composer's label menu and the settings page both do. */
export const createLabel = async (
  db: Database,
  userId: string,
  input: { name: string; color?: string | null }
): Promise<LabelRef> => {
  const name = cleanName(input.name);

  if (await nameTaken(db, userId, name)) {
    throw new LabelError(`You already have a label "${name}".`);
  }

  const wanted = input.color ?? undefined;
  const color: LabelColor = isLabelColor(wanted) ? wanted : "gray";
  const id = newId("lb");
  await db.insert(labels).values({ id, userId, name, color });

  return { id, name, color };
};

/**
 * The person's label with this name (case aside), made when there is none: what an import puts an Outlook folder or
 * category on. A name longer than a label takes keeps its end, where a folder path says the most.
 */
export const labelNamed = async (
  db: Database,
  userId: string,
  name: string,
  color: LabelColor = "gray"
): Promise<string | null> => {
  let clean = name.replaceAll(/\s+/gu, " ").trim();

  if (!clean) {
    return null;
  }

  if (clean.length > MAX_LABEL_NAME) {
    clean = `…${clean.slice(-(MAX_LABEL_NAME - 1)).trim()}`;
  }

  const same = await db.query.labels.findFirst({
    where: and(
      eq(labels.userId, userId),
      sql`lower(${labels.name}) = ${clean.toLowerCase()}`
    ),
  });

  if (same) {
    return same.id;
  }

  const id = newId("lb");
  await db.insert(labels).values({ id, userId, name: clean, color });

  return id;
};

export const updateLabel = async (
  db: Database,
  userId: string,
  id: string,
  input: { name?: string; color?: string | null }
): Promise<void> => {
  const set: Partial<typeof labels.$inferInsert> = {};

  if (input.name !== undefined) {
    const name = cleanName(input.name);

    if (await nameTaken(db, userId, name, id)) {
      throw new LabelError(`You already have a label "${name}".`);
    }

    set.name = name;
  }

  if (input.color !== undefined && input.color !== null) {
    if (!isLabelColor(input.color)) {
      throw new LabelError("That colour is not in the palette.");
    }

    set.color = input.color;
  }

  const updated = await db
    .update(labels)
    .set(set)
    .where(and(eq(labels.id, id), eq(labels.userId, userId)))
    .returning({ id: labels.id });

  if (!updated.length) {
    throw new LabelError("That label no longer exists.");
  }
};

/** Delete a label; it leaves every thread it was on (`thread_labels` cascades) and every filter that applied it. */
export const deleteLabel = async (
  db: Database,
  userId: string,
  id: string
): Promise<void> => {
  await db
    .delete(labels)
    .where(and(eq(labels.id, id), eq(labels.userId, userId)));
};
