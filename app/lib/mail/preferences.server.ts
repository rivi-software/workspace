import { eq } from "drizzle-orm";

import type { Database } from "~/db";
import { users } from "~/db/schema";

import { parsePreferences } from "./preferences";
import type { MailPreferences } from "./preferences";

export class PreferencesError extends Error {
  override name = "PreferencesError";
}

/** Change some of a person's mail preferences; what is not named stays. */
export const savePreferences = async (
  db: Database,
  userId: string,
  changes: Partial<MailPreferences>
): Promise<MailPreferences> => {
  const row = await db.query.users.findFirst({ where: eq(users.id, userId) });

  const next = parsePreferences(
    JSON.stringify({ ...parsePreferences(row?.preferencesJson), ...changes })
  );

  await db
    .update(users)
    .set({ preferencesJson: JSON.stringify(next) })
    .where(eq(users.id, userId));

  return next;
};

export interface VacationInput {
  on: boolean;
  subject: string;
  text: string;
  from: string | null;
  until: string | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/u;

/** The vacation responder's settings: switched on only with some text, the dates as days or not at all. */
export const saveVacation = async (
  db: Database,
  userId: string,
  input: VacationInput
): Promise<void> => {
  const text = input.text.trim();

  if (input.on && !text) {
    throw new PreferencesError("Write what the automatic reply should say.");
  }

  const from = input.from && DAY.test(input.from) ? input.from : null;
  const until = input.until && DAY.test(input.until) ? input.until : null;

  if (from && until && until < from) {
    throw new PreferencesError("The end comes before the start.");
  }

  await db
    .update(users)
    .set({
      vacationOn: input.on,
      vacationSubject: input.subject.trim().slice(0, 200),
      vacationText: text.slice(0, 5000),
      vacationFrom: from,
      vacationUntil: until,
    })
    .where(eq(users.id, userId));
};
