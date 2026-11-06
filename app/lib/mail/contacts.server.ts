import { and, desc, eq, or, sql } from "drizzle-orm";

import type { Database } from "~/db";
import { contacts } from "~/db/schema";
import type { Address } from "~/db/schema";

import { isValidEmail } from "./addresses";

/**
 * Remember the people on a message the owner sent or received, for the composer's suggestions: a new address is
 * added, a known one counts another use and takes a name it lacked. The owner's own addresses are left out.
 * `wrote` marks them as people the owner wrote to (`written_at`), whose mail the spam filter never holds back.
 */
export const touchContacts = async (
  db: Database,
  userId: string,
  people: Address[],
  own = new Set<string>(),
  wrote = false
): Promise<void> => {
  const now = new Date().toISOString();
  const seen = new Set<string>();

  for (const a of people) {
    const email = a.email.trim().toLowerCase();

    if (!email || own.has(email) || seen.has(email) || !isValidEmail(email)) {
      continue;
    }

    if (
      /^(?:no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce)/iu.test(
        email
      )
    ) {
      continue;
    }

    seen.add(email);
    // oxlint-disable-next-line eslint/no-await-in-loop -- one contact per statement, in turn
    await db
      .insert(contacts)
      .values({
        userId,
        email,
        name: a.name?.trim() || null,
        timesUsed: 1,
        lastUsedAt: now,
        writtenAt: wrote ? now : null,
      })
      .onConflictDoUpdate({
        target: [contacts.userId, contacts.email],
        set: {
          timesUsed: sql`${contacts.timesUsed} + 1`,
          lastUsedAt: now,
          name: sql`coalesce(nullif(excluded.name, ''), ${contacts.name})`,
          writtenAt: sql`coalesce(excluded.written_at, ${contacts.writtenAt})`,
        },
      });
  }
};

/** The people whose address or name starts with (or contains) what was typed, most used and most recent first. */
export const searchContacts = async (
  db: Database,
  userId: string,
  q: string,
  limit = 8
): Promise<Address[]> => {
  const needle = q
    .trim()
    .toLowerCase()
    .replaceAll(/[\\%_]/gu, "\\$&");

  const where = needle
    ? and(
        eq(contacts.userId, userId),
        or(
          sql`${contacts.email} like ${`%${needle}%`} escape '\\'`,
          sql`lower(${contacts.name}) like ${`%${needle}%`} escape '\\'`
        )
      )
    : eq(contacts.userId, userId);

  const rows = await db.query.contacts.findMany({
    where,
    orderBy: [desc(contacts.timesUsed), desc(contacts.lastUsedAt)],
    limit,
  });

  return rows.map((r) => ({ email: r.email, name: r.name }));
};
