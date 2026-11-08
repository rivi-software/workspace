import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { drafts, threadLabels } from "~/db/schema";
import type { User } from "~/db/schema";
import { ingestInboundEmail } from "~/lib/mail/ingest.server";
import { createLabel } from "~/lib/mail/labels.server";
import { draftHref, listHref, threadHref } from "~/lib/mail/links";
import {
  findConversations,
  readConversation,
  writeDraft,
} from "~/lib/mail/mail.server";
import { sendMail } from "~/lib/mail/send.server";
import { saveSignature } from "~/lib/mail/signatures.server";
import { applyThreadAction } from "~/lib/mail/threads.server";

import {
  db,
  defined,
  mail,
  mailbox,
  parseJson,
  recordingEmail,
} from "./fixtures";

const domain = env.MAIL_DOMAIN;

const stored = async (user: User, over: Parameters<typeof mail>[0] = {}) => {
  const r = await ingestInboundEmail(
    env,
    null,
    mail({ to: [{ email: user.email, name: null }], ...over }),
    user.email
  );

  if (r.status !== "stored") {
    throw new Error(r.status);
  }

  return r;
};

const file = (
  filename: string,
  text: string,
  inline = false,
  contentId: string | null = null
) => ({
  filename,
  mimeType: "text/plain",
  content: new TextEncoder().encode(text),
  contentId,
  inline,
});

/** A conversation with Jane: her question with three files, and the owner's answer with a Bcc. */
const conversation = async (user: User, subject: string) => {
  const first = await stored(user, {
    messageId: `<q.${crypto.randomUUID()}@wavelength.fm>`,
    from: { email: "jane@wavelength.fm", name: "Jane Wave" },
    subject,
    text: "Can you send the log?\n\nOn Monday Bo wrote:\n> the earlier mail",
    attachments: [
      file("log.txt", "the log"),
      file("logo.png", "png", true, "logo@x"),
      file("notes.txt", "shown inline, named by no Content-ID", true),
    ],
  });

  const { env: mailEnv } = recordingEmail(
    undefined,
    `<a.${crypto.randomUUID()}@${domain}>`
  );

  await sendMail(mailEnv, db, user, {
    from: user.email,
    to: [{ email: "jane@wavelength.fm", name: "Jane Wave" }],
    cc: [],
    bcc: [{ email: "secret@elsewhere.org", name: null }],
    subject: "",
    text: "Here it is.",
    inReplyToId: first.messageId,
    files: [],
  });

  return first;
};

describe("Mail for the Assistant", () => {
  let max: User;
  beforeAll(async () => {
    max = await mailbox("mail-max", "Max Mail");
  });

  it("finds a person's own conversations with some people, spam and the trash left out", async () => {
    const renewal = await stored(max, {
      from: { email: "jane@wavelength.fm", name: "Jane Wave" },
      subject: "Renewal",
      text: "Shall we renew?",
    });

    const cc = await stored(max, {
      from: { email: "bob@elsewhere.org", name: null },
      cc: [{ email: "jane@wavelength.fm", name: null }],
      subject: "Copied",
    });

    const moveOut = async (folder: "trash" | "spam") => {
      const gone = await stored(max, {
        from: { email: "jane@wavelength.fm", name: "Jane Wave" },
        subject: `In the ${folder}`,
      });

      await applyThreadAction(db, env, max.id, [gone.threadId], {
        intent: folder,
      });
    };

    for (const folder of ["trash", "spam"] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each message arrives and is moved before the next arrives, in the order listed
      await moveOut(folder);
    }

    await stored(max, {
      from: { email: "bob@elsewhere.org", name: null },
      subject: "Not Jane",
    });
    const other = await mailbox("mail-otto", "Otto");
    await stored(other, {
      from: { email: "jane@wavelength.fm", name: "Jane Wave" },
      subject: "Otto's mail with Jane",
    });

    const found = await findConversations(db, max.id, {
      folder: "archive",
      with: [" Jane@Wavelength.FM", "nobody@nowhere.org"],
      limit: 8,
    });

    expect(found.map((t) => t.subject)).toStrictEqual(["Copied", "Renewal"]);
    expect(found[1]).toMatchObject({
      id: renewal.threadId,
      people: [{ email: "jane@wavelength.fm", name: "Jane Wave" }],
      snippet: "Shall we renew?",
      unreadCount: 1,
      link: threadHref(renewal.threadId),
    });
    expect(defined(found[0]).id).toBe(cc.threadId);
    await expect(
      findConversations(db, max.id, { folder: "archive", with: [], limit: 8 })
    ).resolves.toStrictEqual([]);

    // A search is the list's: the search box's language over a view.
    const conversations = await findConversations(db, max.id, {
      folder: "archive",
      q: "subject:renewal",
      limit: 8,
    });

    expect(conversations.map((t) => t.id)).toStrictEqual([renewal.threadId]);
  });

  it("reads a conversation as text: each message's own words, its people and the files its page lists", async () => {
    const first = await conversation(max, "The log");
    const label = await createLabel(db, max.id, { name: "Support" });
    await db
      .insert(threadLabels)
      .values({ userId: max.id, threadId: first.threadId, labelId: label.id });

    const read = defined(await readConversation(db, max.id, first.threadId));
    expect(read).toMatchObject({
      subject: "The log",
      labels: ["Support"],
      link: threadHref(first.threadId),
      people: [{ email: "jane@wavelength.fm", name: "Jane Wave" }],
    });
    expect(
      read.messages.map((m) => [m.direction, m.from.email, m.text, m.files])
    ).toStrictEqual([
      [
        "inbound",
        "jane@wavelength.fm",
        "Can you send the log?",
        ["log.txt", "notes.txt"],
      ],
      ["outbound", max.email, "Here it is.", []],
    ]);
    expect(JSON.stringify(read)).not.toContain("secret@elsewhere.org");
    expect(JSON.stringify(read)).not.toContain("/api/files/");
    // Another person's conversation is not there for them.
    const other = await mailbox("mail-otto", "Otto");
    await expect(
      readConversation(db, other.id, first.threadId)
    ).resolves.toBeNull();
  });

  it("writes a reply on the composer's own start: the last message from someone else, the body above the quote", async () => {
    const observed: unknown[] = [];

    await saveSignature(db, max.id, { name: "Short", text: "Max" });
    const first = await conversation(max, "Reply to me");

    const written = await writeDraft(db, max, {
      reply: first.threadId,
      body: "Friday works.\nSee you then.\n\nhttps://rivi.software is the site.",
    });

    if (!written.ok) {
      throw new Error(written.error);
    }

    expect(written).toMatchObject({
      to: "Jane Wave <jane@wavelength.fm>",
      subject: "Re: Reply to me",
      link: draftHref(written.draftId),
    });

    const row = defined(
      await db.query.drafts.findFirst({
        where: eq(drafts.id, written.draftId),
      })
    );

    // Jane's question is answered, not the owner's own answer that came after it.
    expect(row).toMatchObject({
      userId: max.id,
      mode: "reply",
      threadId: first.threadId,
      inReplyToId: first.messageId,
      fromEmail: max.email,
    });
    observed.push(
      JSON.parse(row.toJson),
      row.signatureId === null,
      // The composer's markup: a block per paragraph, a line break within one, links made; the quote under it.
      Boolean(
        defined(row.html).startsWith(
          "<div>Friday works.<br>See you then.</div><div><br></div><div>"
        )
      ),
      row.html?.includes('<a href="https://rivi.software"'),
      row.html?.includes("Can you send the log?"),
      {
        "Friday works.\nSee you then.": row.text.startsWith(
          "Friday works.\nSee you then."
        ),
        text: row.text.includes("> Can you send the log?"),
      }
    );

    const other = await mailbox("mail-otto", "Otto");
    observed.push(
      await writeDraft(db, other, { reply: first.threadId, body: "Mine?" })
    );

    expect(observed).toStrictEqual([
      // JSON.parse(row.toJson)
      [{ email: "jane@wavelength.fm", name: "Jane Wave" }],
      // row.signatureId === null
      false,
      // Boolean(defined(row.html).startsWith( "<div>Friday works.<br>See you then.</div><div><b...
      true,
      // row.html.includes('<a href="https://rivi.software"')
      true,
      // row.html.includes("Can you send the log?")
      true,
      // { "Friday works.\nSee you then.": row.text.startsWith( "Friday works.\nSee you then." )...
      { "Friday works.\nSee you then.": true, text: true },
      // writeDraft(db, other, { reply: first.threadId, body: "Mine?" })
      {
        ok: false,
        error: "No such conversation in this mailbox.",
      },
    ]);
  });

  it("writes a new message to the addresses given, and refuses one without a good recipient", async () => {
    const written = await writeDraft(db, max, {
      to: ["Kim <kim@acme.com>"],
      cc: ["lee@acme.com"],
      subject: "The offsite",
      body: "The agenda.",
    });

    if (!written.ok) {
      throw new Error(written.error);
    }

    expect(written).toMatchObject({
      to: "Kim <kim@acme.com>",
      subject: "The offsite",
    });

    const row = defined(
      await db.query.drafts.findFirst({
        where: eq(drafts.id, written.draftId),
      })
    );

    expect(row).toMatchObject({
      mode: "new",
      threadId: null,
      subject: "The offsite",
    });
    expect({
      parse: parseJson(row.ccJson),
      html: row.html,
      writeDraft: await writeDraft(db, max, {
        to: ["not an address"],
        body: "x",
      }),
      writeDraft2: await writeDraft(db, max, { to: [], body: "x" }),
    }).toStrictEqual({
      parse: [{ email: "lee@acme.com", name: null }],
      html: "<div>The agenda.</div><div><br></div>",
      writeDraft: {
        ok: false,
        error: "Not an address: not an address.",
      },
      writeDraft2: {
        ok: false,
        error: "A new message needs a recipient.",
      },
    });
  });

  it("links to its own pages", () => {
    expect(threadHref("th_1")).toBe("/mail/t/th_1");
    expect(draftHref("dr_1")).toBe("/mail/compose?draft=dr_1");
    expect(listHref()).toBe("/mail");
    expect(listHref("from:jane budget")).toBe(
      "/mail?folder=archive&q=from%3Ajane%20budget"
    );
  });
});
