/**
 * "Check again" on a message that arrived with OpenPGP: its raw message read back from R2 and opened anew, so a key
 * imported since (the owner's own, or the sender's) opens what stayed shut or checks a signature no key could. Only a
 * message that now opens has its text and files replaced; otherwise the status alone is written.
 */
import { and, eq } from "drizzle-orm";

import type { Database } from "~/db";
import { attachments, messages } from "~/db/schema";
import type { User } from "~/db/schema";

import { snippetOf } from "../../text";
import { storeAttachments } from "../filing.server";
import { openPgpMail, parseRawEmail } from "../ingest.server";
import { recomputeThread } from "../threads.server";
import { parsePgpStatus } from "./pgp";
import type { PgpStatus } from "./pgp";

/** The message's status after another look; null when it is not the owner's, has no raw message, or holds no OpenPGP. */
export const recheckPgpMessage = async (
  env: Env,
  db: Database,
  user: Pick<User, "id">,
  messageId: string,
  options: { fetch?: typeof fetch } = {}
): Promise<PgpStatus | null> => {
  const row = await db.query.messages.findFirst({
    where: and(eq(messages.id, messageId), eq(messages.userId, user.id)),
  });

  if (!row?.rawKey || row.direction !== "inbound") {
    return null;
  }

  const object = await env.MAIL.get(row.rawKey);

  if (!object) {
    return null;
  }

  const raw = await object.arrayBuffer();

  const parsed = await parseRawEmail(raw, row.fromEmail, {
    messageId: row.messageId,
    date: row.date,
  });

  const { mail, pgp } = await openPgpMail(env, db, user, raw, parsed, options);

  if (!pgp) {
    return null;
  }

  const before = parsePgpStatus(row.pgpJson);
  const opensNow = pgp.decrypted && !(before?.encrypted && before.decrypted);

  if (!opensNow) {
    await db
      .update(messages)
      .set({ pgpJson: JSON.stringify(pgp) })
      .where(eq(messages.id, row.id));

    return pgp;
  }

  // What stayed shut is opened: the opened text and files take the place of the ciphertext's.
  const old = await db.query.attachments.findMany({
    where: eq(attachments.messageId, row.id),
  });

  for (const a of old) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- the stored objects go before their rows, one at a time
    await env.MAIL.delete(a.r2Key);
  }

  await db.delete(attachments).where(eq(attachments.messageId, row.id));
  await storeAttachments(env, db, user.id, row.id, mail.attachments);

  await db
    .update(messages)
    .set({
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      snippet: snippetOf(mail.text),
      pgpJson: JSON.stringify(pgp),
    })
    .where(eq(messages.id, row.id));

  await recomputeThread(db, row.threadId);

  return pgp;
};
