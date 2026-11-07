/**
 * The senders whose images from the web a person always loads, an address or everyone at a domain, matched as the
 * spam filter's blocked and allowed senders are (`senderRuleFor`). Loading them tells the sender the message was
 * opened, and from where, so mail in Spam never loads them by itself: a forged sender is what lands there.
 */
import { and, asc, eq, sql } from "drizzle-orm";

import type { Database } from "~/db";
import { imageSenders } from "~/db/schema";
import type { ImageSender, Message, Thread } from "~/db/schema";

import { senderRuleFor, senderRuleOf } from "./spam";

export class ImageSenderError extends Error {
  override name = "ImageSenderError";
}

export const MAX_IMAGE_SENDERS = 500;

export const listImageSenders = async (
  db: Database,
  userId: string
): Promise<ImageSender[]> =>
  await db.query.imageSenders.findMany({
    where: eq(imageSenders.userId, userId),
    orderBy: [asc(imageSenders.sender)],
  });

/** Always load images from a sender (an address or a domain, as typed); answers the sender as kept. */
export const addImageSender = async (
  db: Database,
  userId: string,
  input: string
): Promise<string> => {
  const sender = senderRuleOf(input);

  if (!sender) {
    throw new ImageSenderError(
      "Give an address (jane@acme.com) or a domain (acme.com)."
    );
  }

  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(imageSenders)
    .where(eq(imageSenders.userId, userId));

  const existing = await db.query.imageSenders.findFirst({
    where: and(
      eq(imageSenders.userId, userId),
      eq(imageSenders.sender, sender)
    ),
  });

  if (!existing && Number(row?.n ?? 0) >= MAX_IMAGE_SENDERS) {
    throw new ImageSenderError(
      `You can always load images from ${MAX_IMAGE_SENDERS} senders at most.`
    );
  }

  await db
    .insert(imageSenders)
    .values({ userId, sender })
    .onConflictDoNothing();

  return sender;
};

export const removeImageSender = async (
  db: Database,
  userId: string,
  sender: string
) => {
  await db
    .delete(imageSenders)
    .where(
      and(
        eq(imageSenders.userId, userId),
        eq(imageSenders.sender, sender.toLowerCase())
      )
    );
};

/**
 * Whether a message in a conversation in `folder` loads its images from the web on opening, and so whether its quote
 * in the composer does: one that arrived, from a sender on the list, outside Spam.
 */
export const loadsImages = (
  senders: ImageSender[],
  message: { direction: Message["direction"]; from: string },
  folder: Thread["folder"]
): boolean =>
  message.direction === "inbound" &&
  folder !== "spam" &&
  senderRuleFor(senders, message.from) !== null;
