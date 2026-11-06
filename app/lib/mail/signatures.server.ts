import { and, eq } from "drizzle-orm";

import type { Database } from "~/db";
import { signatures } from "~/db/schema";
import type { Signature } from "~/db/schema";

import { newId } from "../ids";
import { htmlIsBlank, htmlToText } from "../text";
import { MAX_SIGNATURE_HTML, sanitizeSignatureHtml } from "./signatures";

export class SignatureError extends Error {
  override name = "SignatureError";
}

/** A person's signatures in the order they made them. */
export const listSignatures = async (
  db: Database,
  userId: string
): Promise<Signature[]> =>
  await db.query.signatures.findMany({
    where: eq(signatures.userId, userId),
    orderBy: (s, { asc }) => [asc(s.createdAt), asc(s.id)],
  });

/** One of the owner's signatures, or nothing for an id that is not theirs (or no longer exists). */
export const findSignature = async (
  db: Database,
  userId: string,
  id: string
): Promise<Signature | undefined> =>
  await db.query.signatures.findFirst({
    where: and(eq(signatures.id, id), eq(signatures.userId, userId)),
  });

/**
 * Add a signature, or change one of the owner's (`id`). A person's first signature becomes both their defaults. Given
 * `html`, the signature is that markup, sanitised (`sanitizeSignatureHtml`), and its text is the markup's reading;
 * otherwise it is `text`.
 */
export const saveSignature = async (
  db: Database,
  userId: string,
  input: {
    id?: string | null;
    name: string;
    text: string;
    html?: string | null;
  }
): Promise<string> => {
  const name = input.name.trim();

  if (!name) {
    throw new SignatureError("A signature needs a name.");
  }

  if (input.html && input.html.length > MAX_SIGNATURE_HTML) {
    throw new SignatureError(
      "The signature is too large: make its images smaller (a logo of a few kilobytes is plenty)."
    );
  }

  const html =
    input.html && !htmlIsBlank(input.html)
      ? sanitizeSignatureHtml(input.html)
      : null;

  const text = html ? htmlToText(html).trim() : input.text.trim();

  if (!text && !html) {
    throw new SignatureError("A signature needs some text.");
  }

  if (input.id) {
    const updated = await db
      .update(signatures)
      .set({ name, text, html })
      .where(and(eq(signatures.id, input.id), eq(signatures.userId, userId)))
      .returning({ id: signatures.id });

    if (!updated.length) {
      throw new SignatureError("That signature no longer exists.");
    }

    return input.id;
  }

  const first = !(await db.query.signatures.findFirst({
    where: eq(signatures.userId, userId),
  }));

  const id = newId("sig");
  await db.insert(signatures).values({
    id,
    userId,
    name,
    text,
    html,
    isDefault: first,
    isReplyDefault: first,
  });

  return id;
};

/**
 * Make one of the owner's signatures a default, or none (`null`): what the composer starts a new message on (`new`),
 * and what it starts a reply or forward on (`reply`). A default left out stays as it is.
 */
export const setDefaultSignatures = async (
  db: Database,
  userId: string,
  defaults: { new?: string | null; reply?: string | null }
) => {
  if (defaults.new === undefined && defaults.reply === undefined) {
    return;
  }

  for (const id of [defaults.new, defaults.reply]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- two ids, checked in turn
    if (id && !(await findSignature(db, userId, id))) {
      throw new SignatureError("That signature no longer exists.");
    }
  }

  const mine = eq(signatures.userId, userId);

  // One of each per person (a unique index each): the old ones are cleared before the new ones are set, in one batch.
  const clear = db
    .update(signatures)
    .set({
      ...(defaults.new !== undefined && { isDefault: false }),
      ...(defaults.reply !== undefined && { isReplyDefault: false }),
    })
    .where(mine);

  const sets = [];

  if (defaults.new) {
    sets.push(
      db
        .update(signatures)
        .set({ isDefault: true })
        .where(and(eq(signatures.id, defaults.new), mine))
    );
  }

  if (defaults.reply) {
    sets.push(
      db
        .update(signatures)
        .set({ isReplyDefault: true })
        .where(and(eq(signatures.id, defaults.reply), mine))
    );
  }

  await db.batch([clear, ...sets]);
};

/** Delete one of the owner's signatures. Drafts that used it go out without one; deleting a default leaves it empty. */
export const deleteSignature = async (
  db: Database,
  userId: string,
  id: string
) => {
  await db
    .delete(signatures)
    .where(and(eq(signatures.id, id), eq(signatures.userId, userId)));
};
