import { and, asc, eq, sql } from "drizzle-orm";

import type { Database } from "~/db";
import { filters, labels } from "~/db/schema";

import { newId } from "../ids";
import {
  filterMatches,
  hasActions,
  hasConditions,
  parseFilterActions,
  parseFilterConditions,
} from "./filters";
import type { FilterActions, FilterConditions, FilterInput } from "./filters";

export class FilterError extends Error {
  override name = "FilterError";
}

export interface FilterView {
  id: string;
  position: number;
  conditions: FilterConditions;
  actions: FilterActions;
}

export const MAX_FILTERS = 100;

/** A person's filters in the order they run. */
export const listFilters = async (
  db: Database,
  userId: string
): Promise<FilterView[]> => {
  const rows = await db.query.filters.findMany({
    where: eq(filters.userId, userId),
    orderBy: [asc(filters.position), asc(filters.createdAt)],
  });

  return rows.map((f) => ({
    id: f.id,
    position: f.position,
    conditions: parseFilterConditions(f.conditionsJson),
    actions: parseFilterActions(f.actionsJson),
  }));
};

/** Add a filter at the end, or change one of the owner's (`id`). A filter needs a condition and an action. */
export const saveFilter = async (
  db: Database,
  userId: string,
  input: {
    id?: string | null;
    conditions: FilterConditions;
    actions: FilterActions;
  }
): Promise<string> => {
  const conditions = parseFilterConditions(JSON.stringify(input.conditions));
  const actions = parseFilterActions(JSON.stringify(input.actions));

  if (!hasConditions(conditions)) {
    throw new FilterError(
      "Say what the filter looks for: a sender, a recipient, a subject or words."
    );
  }

  if (!hasActions(actions)) {
    throw new FilterError("Say what the filter does with the message.");
  }

  if (actions.labelId) {
    const label = await db.query.labels.findFirst({
      where: and(eq(labels.id, actions.labelId), eq(labels.userId, userId)),
    });

    if (!label) {
      throw new FilterError("That label no longer exists.");
    }
  }

  const values = {
    conditionsJson: JSON.stringify(conditions),
    actionsJson: JSON.stringify(actions),
  };

  if (input.id) {
    const updated = await db
      .update(filters)
      .set(values)
      .where(and(eq(filters.id, input.id), eq(filters.userId, userId)))
      .returning({ id: filters.id });

    if (!updated.length) {
      throw new FilterError("That filter no longer exists.");
    }

    return input.id;
  }

  const [last] = await db
    .select({
      n: sql<number>`count(*)`,
      max: sql<number>`coalesce(max(position), 0)`,
    })
    .from(filters)
    .where(eq(filters.userId, userId));

  if (Number(last?.n ?? 0) >= MAX_FILTERS) {
    throw new FilterError(`You can have ${MAX_FILTERS} filters at most.`);
  }

  const id = newId("flt");
  await db
    .insert(filters)
    .values({ id, userId, position: Number(last?.max ?? 0) + 1, ...values });

  return id;
};

export const deleteFilter = async (
  db: Database,
  userId: string,
  id: string
): Promise<void> => {
  await db
    .delete(filters)
    .where(and(eq(filters.id, id), eq(filters.userId, userId)));
};

/** Move a filter one place up or down in the order they run. */
export const moveFilter = async (
  db: Database,
  userId: string,
  id: string,
  direction: "up" | "down"
): Promise<void> => {
  const list = await listFilters(db, userId);
  const i = list.findIndex((f) => f.id === id);

  if (i === -1) {
    return;
  }

  const j = direction === "up" ? i - 1 : i + 1;

  if (j < 0 || j >= list.length) {
    return;
  }

  const order = list.map((f) => f.id);
  [order[i], order[j]] = [order[j], order[i]];

  // The whole list gets fresh positions: two filters could share one from before positions were distinct.
  for (const [n, fid] of order.entries()) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- filters are written in order, one rank each
    await db
      .update(filters)
      .set({ position: n + 1 })
      .where(eq(filters.id, fid));
  }
};

/** What every matching filter does with a message, together; the labels of every match all go on. */
export interface FilterOutcome {
  skipInbox: boolean;
  markRead: boolean;
  star: boolean;
  trash: boolean;
  spam: boolean;
  neverSpam: boolean;
  labelIds: string[];
  matched: number;
}

export const filterOutcome = async (
  db: Database,
  userId: string,
  input: FilterInput
): Promise<FilterOutcome> => {
  const out: FilterOutcome = {
    skipInbox: false,
    markRead: false,
    star: false,
    trash: false,
    spam: false,
    neverSpam: false,
    labelIds: [],
    matched: 0,
  };

  const labelsRows = await db.query.labels.findMany({
    where: eq(labels.userId, userId),
  });

  const known = new Set(labelsRows.map((l) => l.id));

  for (const f of await listFilters(db, userId)) {
    if (!filterMatches(f.conditions, input)) {
      continue;
    }

    out.matched += 1;
    const a = f.actions;
    out.skipInbox ||= !!a.skipInbox;
    out.markRead ||= !!a.markRead;
    out.star ||= !!a.star;
    out.trash ||= !!a.trash;
    out.spam ||= !!a.spam;
    out.neverSpam ||= !!a.neverSpam;

    // A label deleted since the filter was made is skipped, not written (the thread's labels reference one).
    if (
      a.labelId &&
      known.has(a.labelId) &&
      !out.labelIds.includes(a.labelId)
    ) {
      out.labelIds.push(a.labelId);
    }
  }

  return out;
};
