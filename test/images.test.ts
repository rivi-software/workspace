import { beforeAll, describe, expect, it } from "vitest";

import type { User } from "~/db/schema";
import {
  ImageSenderError,
  MAX_IMAGE_SENDERS,
  addImageSender,
  listImageSenders,
  loadsImages,
  removeImageSender,
} from "~/lib/mail/images.server";

import { db, mailbox } from "./fixtures";

describe("senders whose images always load", () => {
  let user: User;
  let other: User;
  beforeAll(async () => {
    user = await mailbox("iris", "Iris Images");
    other = await mailbox("otto", "Otto Other");
  });

  it("keeps an address or a domain as typed, once, for its owner only", async () => {
    await expect(addImageSender(db, user.id, "not an address")).rejects.toThrow(
      ImageSenderError
    );

    const add1 = await addImageSender(
      db,
      user.id,
      "News <News@Letters.example>"
    );

    const add2 = await addImageSender(db, user.id, "news@letters.example");
    const add3 = await addImageSender(db, user.id, "Shop.example");
    const userSenders = await listImageSenders(db, user.id);
    const otherSenders = await listImageSenders(db, other.id);

    expect({
      addImageSender: add1,
      addImageSender2: add2,
      addImageSender3: add3,
      listImageSendersMap: userSenders.map((s) => s.sender),
      listImageSenders: otherSenders,
    }).toStrictEqual({
      addImageSender: "news@letters.example",
      addImageSender2: "news@letters.example",
      addImageSender3: "@shop.example",
      listImageSendersMap: ["@shop.example", "news@letters.example"],
      listImageSenders: [],
    });

    await removeImageSender(db, user.id, "@Shop.example");
    const imageSenders = await listImageSenders(db, user.id);
    expect(imageSenders.map((s) => s.sender)).toStrictEqual([
      "news@letters.example",
    ]);
  });

  it("loads them for the address or everyone at the domain, in mail that arrived, never in Spam", async () => {
    await addImageSender(db, user.id, "@shop.example");
    const senders = await listImageSenders(db, user.id);

    const loads = (from: string, folder: "inbox" | "archive" | "spam") =>
      loadsImages(senders, { direction: "inbound", from }, folder);

    expect({
      address: loads("News@letters.example", "inbox"),
      domain: loads("deals@eu.shop.example", "archive"),
      other: loads("someone@else.example", "inbox"),
      spam: loads("news@letters.example", "spam"),
      sent: loadsImages(
        senders,
        { direction: "outbound", from: "news@letters.example" },
        "inbox"
      ),
    }).toStrictEqual({
      address: true,
      domain: true,
      other: false,
      spam: false,
      sent: false,
    });
  });

  it("stops at its limit, but still takes a sender already on the list", async () => {
    const full = await mailbox("fiona", "Fiona Full");

    await Promise.all(
      Array.from({ length: MAX_IMAGE_SENDERS }, (_, i) =>
        addImageSender(db, full.id, `sender${i}@full.example`)
      )
    );

    await expect(
      addImageSender(db, full.id, "one@more.example")
    ).rejects.toThrow(ImageSenderError);
    await expect(
      addImageSender(db, full.id, "sender0@full.example")
    ).resolves.toBe("sender0@full.example");
  });
});
