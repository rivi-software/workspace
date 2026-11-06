import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { fileMessage } from "~/lib/mail/filing.server";
import type { Filed } from "~/lib/mail/filing.server";
import { labelNamed } from "~/lib/mail/labels.server";
import { listThreads, loadThread } from "~/lib/mail/mailbox.server";
import { applyThreadAction } from "~/lib/mail/threads.server";

import { db, defined, mail, mailbox, sorted } from "./fixtures";

const bytes = (text: string) => new TextEncoder().encode(text).buffer;

/** The raw copies kept in R2 for a mailbox. */
const rawKeys = async (userId: string) => {
  const { objects } = await env.MAIL.list({ prefix: `raw/${userId}/` });

  return objects.map((o) => o.key);
};

describe("filing a message", () => {
  it("files a redelivery that lands while the first is filed once, and keeps one raw copy", async () => {
    const user = await mailbox("fia");

    const m = mail({
      subject: "Twice at once",
      to: [{ email: user.email, name: null }],
    });

    const raw = bytes("Subject: Twice at once\r\n\r\nHi");
    let first: Filed | undefined;

    const second = await fileMessage(env, db, user, {
      policy: "arrival",
      mail: m,
      raw,
      // The other delivery is filed between this one's duplicate check and its insert.
      place: async () => {
        first ??= await fileMessage(env, db, user, {
          policy: "arrival",
          mail: m,
          raw,
          place: () => ({ folder: "inbox" }),
        });

        return { folder: "inbox" };
      },
    });

    if (first?.status !== "filed") {
      throw new Error("not filed");
    }

    expect(second).toStrictEqual({
      status: "duplicate",
      threadId: first.threadId,
      messageId: first.messageId,
    });
    await expect(rawKeys(user.id)).resolves.toStrictEqual([
      `raw/${user.id}/${first.messageId}.eml`,
    ]);

    const listed = await listThreads(db, user.id, {
      folder: "archive",
      q: "Twice at once",
    });

    expect(listed.map((t) => t.id)).toStrictEqual([first.threadId]);
    expect(
      defined(await loadThread(db, env, user.id, first.threadId)).messages
    ).toHaveLength(1);
  });

  it("takes back the raw copy and the conversation it made when the insert fails", async () => {
    const user = await mailbox("finn");

    const broken = mail({ subject: "Never filed" });
    // The message's date is required: the insert fails without one.
    Reflect.set(broken, "date", null);

    await expect(
      fileMessage(env, db, user, {
        policy: "arrival",
        mail: broken,
        raw: bytes("Subject: Never filed\r\n\r\n"),
        place: () => ({ folder: "inbox" }),
      })
    ).rejects.toThrow("Failed query");
    await expect(rawKeys(user.id)).resolves.toStrictEqual([]);
    await expect(
      listThreads(db, user.id, { folder: "archive", q: "Never filed" })
    ).resolves.toStrictEqual([]);
  });

  it("leaves the conversation it would have joined where it was when the insert fails", async () => {
    const user = await mailbox("fleur");

    const first = await fileMessage(env, db, user, {
      policy: "arrival",
      mail: mail({ messageId: "<root@fleur.test>", subject: "Kept aside" }),
      raw: null,
      place: () => ({ folder: "inbox" }),
    });

    if (first.status !== "filed") {
      throw new Error("not filed");
    }

    await applyThreadAction(db, env, user.id, [first.threadId], {
      intent: "archive",
    });

    const undated = mail({
      subject: "Re: Kept aside",
      inReplyTo: "<root@fleur.test>",
    });

    Reflect.set(undated, "date", null);

    await expect(
      fileMessage(env, db, user, {
        policy: "arrival",
        mail: undated,
        raw: bytes("Subject: Re: Kept aside\r\n\r\n"),
        place: () => ({ folder: "inbox" }),
      })
    ).rejects.toThrow("Failed query");
    await expect(
      listThreads(db, user.id, { folder: "inbox" })
    ).resolves.toStrictEqual([]);
    expect(
      defined(await loadThread(db, env, user.id, first.threadId)).messages
    ).toHaveLength(1);
    await expect(rawKeys(user.id)).resolves.toStrictEqual([]);
  });

  it("puts more labels on a conversation than D1 binds values for, and skips a deleted one", async () => {
    const user = await mailbox("flo");

    const labels = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        labelNamed(db, user.id, `Folder ${i}`)
      )
    );

    const labelIds = labels.map((label) => defined(label));

    const filed = await fileMessage(env, db, user, {
      policy: "history",
      mail: mail({ subject: "Many folders" }),
      raw: null,
      place: () => ({
        folder: "archive",
        labelIds: [...labelIds, "lb_deleted"],
      }),
    });

    if (filed.status !== "filed") {
      throw new Error("not filed");
    }

    const thread = await loadThread(db, env, user.id, filed.threadId);
    expect(sorted(defined(thread).labels.map((l) => l.id))).toStrictEqual(
      sorted(labelIds)
    );
  });
});
