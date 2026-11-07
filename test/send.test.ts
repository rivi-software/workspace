import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { draftFiles, drafts } from "~/db/schema";
import { parseAddressList } from "~/lib/mail/addresses";
import { saveFilter } from "~/lib/mail/filters.server";
import { ingestInboundEmail } from "~/lib/mail/ingest.server";
import { listThreads, loadThread } from "~/lib/mail/mailbox.server";
import { MAX_HTML } from "~/lib/mail/sanitize";
import {
  SendError,
  addDraftFiles,
  saveDraft,
  sendComposed,
  sendMail,
} from "~/lib/mail/send.server";
import type { ComposedMail, DraftInput } from "~/lib/mail/send.server";
import { saveSignature } from "~/lib/mail/signatures.server";

import {
  db,
  defined,
  mail,
  mailbox,
  recordingEmail,
  rejection,
  rejectionIncludes,
} from "./fixtures";

const domain = env.MAIL_DOMAIN;

/** A conversation and one of its messages, as the thread page reads them. */
const filed = async (userId: string, threadId: string, messageId: string) => {
  const loaded = defined(await loadThread(db, env, userId, threadId));

  return {
    thread: loaded.thread,
    message: defined(loaded.messages.find((m) => m.id === messageId)),
  };
};

describe("sending mail", () => {
  beforeAll(async () => {
    await mailbox("sam", "Sam Sender", [`team@${domain}`]);
  });

  it("sends a new message, files it under Sent and not in the inbox, and keeps a file in R2", async () => {
    const observed: unknown[] = [];
    const observedSubsets: unknown[] = [];

    const user = await mailbox("sam");

    const signatureId = await saveSignature(db, user.id, {
      name: "Work",
      text: "Sam\nRIVI",
    });

    const { sent, env: testEnv } = recordingEmail();

    const result = await sendMail(testEnv, db, user, {
      from: user.email,
      to: [{ email: "jane@acme.com", name: "Jane" }],
      cc: [],
      bcc: [{ email: "boss@acme.com", name: null }],
      subject: "Plan",
      text: "Here is the plan.",
      signatureId,
      files: [
        {
          filename: "plan.txt",
          contentType: "text/plain",
          content: new TextEncoder().encode("1. ship").buffer,
        },
      ],
    });

    observed.push(sent.length);
    observedSubsets.push(sent[0]);
    observed.push(sent[0].html?.includes("Here is the plan."));
    observedSubsets.push(sent[0].attachments?.[0]);

    const { thread, message } = await filed(
      user.id,
      result.threadId,
      result.messageId
    );

    observedSubsets.push(thread);
    await expect(
      listThreads(db, user.id, { folder: "sent" })
    ).resolves.toContainEqual(expect.objectContaining({ id: result.threadId }));
    await expect(
      listThreads(db, user.id, { folder: "inbox" })
    ).resolves.not.toContainEqual(
      expect.objectContaining({ id: result.threadId })
    );
    observedSubsets.push(message);

    expect(observedSubsets).toMatchObject([
      // sent[0]
      {
        from: { email: `sam@${domain}`, name: "Sam Sender" },
        // The binding takes bare recipient addresses; SES keeps the name.
        to: ["jane@acme.com"],
        bcc: ["boss@acme.com"],
        subject: "Plan",
        text: "Here is the plan.\n\n-- \nSam\nRIVI",
      },
      // sent[0].attachments?.[0]
      {
        filename: "plan.txt",
        type: "text/plain",
        disposition: "attachment",
        content: btoa("1. ship"),
      },
      // thread
      {
        folder: "archive",
        sentCount: 1,
        unreadCount: 0,
        hasAttachments: true,
      },
      // message
      {
        direction: "outbound",
        read: true,
        deliveryStatus: "sent",
        bcc: [{ email: "boss@acme.com", name: null }],
        attachments: [
          expect.objectContaining({
            filename: "plan.txt",
            size: 7,
            inline: false,
          }),
        ],
      },
    ]);
    observed.push(/^<sent\d+@/u.test(message.messageId));

    expect(observed).toStrictEqual([
      // sent.length
      1,
      // sent[0].html.includes("Here is the plan.")
      true,
      // /^<sent\d+@/u.test(message.messageId)
      true,
    ]);
  });

  it("threads a reply with In-Reply-To and References and keeps it in the conversation", async () => {
    const user = await mailbox("sam");

    const inbound = await ingestInboundEmail(
      env,
      null,
      mail({
        messageId: "<q1@acme.com>",
        references: ["<q0@acme.com>"],
        subject: "Question",
        to: [{ email: user.email, name: null }],
      }),
      user.email
    );

    if (inbound.status !== "stored") {
      throw new Error("not stored");
    }

    const { sent, env: testEnv } = recordingEmail();

    const result = await sendMail(testEnv, db, user, {
      from: user.email,
      to: [{ email: "jane@acme.com", name: null }],
      cc: [],
      bcc: [],
      subject: "",
      text: "Answer",
      inReplyToId: inbound.messageId,
      files: [],
    });

    expect({
      threadId: result.threadId,
      subject: sent[0].subject,
    }).toStrictEqual({ threadId: inbound.threadId, subject: "Re: Question" });
    // No signature chosen: the text goes out as written, even though Sam has a default.
    expect({ text: sent[0].text, headers: sent[0].headers }).toStrictEqual({
      text: "Answer",
      headers: {
        "In-Reply-To": "<q1@acme.com>",
        References: "<q0@acme.com> <q1@acme.com>",
      },
    });

    const { thread, message: ours } = await filed(
      user.id,
      inbound.threadId,
      result.messageId
    );

    expect(thread).toMatchObject({
      messageCount: 2,
      sentCount: 1,
      folder: "inbox",
    });

    // A reply from the other side threads back by the id Email Service gave the sent message.
    const back = await ingestInboundEmail(
      env,
      null,
      mail({
        subject: "Re: Question",
        inReplyTo: ours.messageId,
        to: [{ email: user.email, name: null }],
      }),
      user.email
    );

    expect(back.status === "stored" && back.threadId).toBe(inbound.threadId);
  });

  it("sends through SES once it has a key, and a reply threads back by the Message-ID SES gave it", async () => {
    const user = await mailbox("sam");
    const { sent, env: bindingEnv } = recordingEmail();
    const requests: { url: string; body: unknown }[] = [];

    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        requests.push({
          url: request.url,
          body: await request.json(),
        });

        return Response.json({ MessageId: "0107019a-ses-000000" });
      });

    const sesEnv: Env = {
      ...bindingEnv,
      SES_REGION: "eu-central-1",
      SES_ACCESS_KEY_ID: "AKIATESTKEY",
      SES_SECRET_ACCESS_KEY: "test-secret",
    };

    try {
      const result = await sendMail(sesEnv, db, user, {
        from: user.email,
        to: [{ email: "jane@acme.com", name: "Jane" }],
        cc: [],
        bcc: [],
        subject: "Through SES",
        text: "Hello",
        files: [],
      });

      expect(sent).toStrictEqual([]);
      expect(requests.map((r) => r.url)).toStrictEqual([
        "https://email.eu-central-1.amazonaws.com/v2/email/outbound-emails",
      ]);
      expect(defined(requests[0]).body).toMatchObject({
        FromEmailAddress: `"Sam Sender" <${user.email}>`,
        Destination: { ToAddresses: ['"Jane" <jane@acme.com>'] },
      });

      const { message: ours } = await filed(
        user.id,
        result.threadId,
        result.messageId
      );

      expect(ours.messageId).toBe(
        "<0107019a-ses-000000@eu-central-1.amazonses.com>"
      );

      const back = await ingestInboundEmail(
        env,
        null,
        mail({
          subject: "Re: Through SES",
          inReplyTo: ours.messageId,
          to: [{ email: user.email, name: null }],
        }),
        user.email
      );

      expect(back.status === "stored" && back.threadId).toBe(result.threadId);
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses to send as a stranger, without recipients, or when the provider fails, and stores nothing then", async () => {
    const observed: unknown[] = [];

    const user = await mailbox("sam");
    const base = { cc: [], bcc: [], subject: "x", text: "y", files: [] };
    await expect(
      sendMail(recordingEmail().env, db, user, {
        ...base,
        from: "other@acme.com",
        to: [{ email: "a@b.co", name: null }],
      })
    ).rejects.toBeInstanceOf(SendError);
    observed.push(
      await rejectionIncludes(
        sendMail(recordingEmail().env, db, user, {
          ...base,
          from: user.email,
          to: [],
        }),
        "Add at least one recipient."
      )
    );
    const threads = await listThreads(db, user.id, { folder: "sent" });
    const before = threads.length;
    observed.push(
      await rejectionIncludes(
        sendMail(recordingEmail("rate limited").env, db, user, {
          ...base,
          from: `team@${domain}`,
          to: [{ email: "a@b.co", name: null }],
        }),
        "The message was not sent: EMAIL_FAILED rate limited"
      )
    );
    const stranger = await mailbox("sid");

    const theirs = await saveSignature(db, stranger.id, {
      name: "Sid",
      text: "Sid",
    });

    const binding = recordingEmail();
    observed.push(
      await rejectionIncludes(
        sendMail(binding.env, db, user, {
          ...base,
          from: user.email,
          to: [{ email: "a@b.co", name: null }],
          signatureId: theirs,
        }),
        "The signature you chose no longer exists."
      ),
      binding.sent.length
    );
    const got32 = await listThreads(db, user.id, { folder: "sent" });
    observed.push(got32.length);

    expect(observed).toStrictEqual([
      // (await rejection(sendMail(recordingEmail().env, db, user, { ...base, from: { email: use...
      true,
      // (await rejection(sendMail(recordingEmail("rate limited").env, db, user, { ...base, from...
      true,
      // (await rejection(sendMail(binding.env, db, user, { ...base, from: { email: user.email, ...
      true,
      // binding.sent.length
      0,
      // got32.length
      before,
    ]);
  });

  it("refuses a body longer than the sanitiser reads rather than send it cut off, and sends and stores nothing", async () => {
    const user = await mailbox("sam");
    const before = await listThreads(db, user.id, { folder: "sent" });
    const binding = recordingEmail();

    const error = await rejection(
      sendMail(binding.env, db, user, {
        from: user.email,
        to: [{ email: "a@b.co", name: null }],
        cc: [],
        bcc: [],
        subject: "Long",
        text: "",
        html: `<div>${"x".repeat(MAX_HTML)}</div>`,
        files: [],
      })
    );

    const after = await listThreads(db, user.id, { folder: "sent" });

    expect({
      refused: error instanceof SendError && error.message,
      sent: binding.sent.length,
      filed: after.length,
    }).toStrictEqual({
      refused:
        "The message is too long to send: shorten it, or send the long part as a file.",
      sent: 0,
      filed: before.length,
    });
  });

  it("keeps a draft until it is sent", async () => {
    const user = await mailbox("sam");

    const id = await saveDraft(db, user.id, {
      mode: "new",
      from: user.email,
      to: [{ email: "a@b.co", name: null }],
      cc: [],
      bcc: [],
      subject: "Later",
      text: "…",
    });

    const again = await saveDraft(db, user.id, {
      id,
      mode: "new",
      from: user.email,
      to: [],
      cc: [],
      bcc: [],
      subject: "Later!",
      text: "…",
    });

    expect(again).toBe(id);

    const row = await db.query.drafts.findFirst({
      where: (d, { eq: e }) => e(d.id, id),
    });

    expect(row?.subject).toBe("Later!");
  });
});

/** What the composer holds, its recipients as typed. */
const composed = (
  from: string,
  to: string,
  over: Partial<ComposedMail> = {}
): ComposedMail => ({
  from,
  to: parseAddressList(to),
  cc: parseAddressList(""),
  bcc: parseAddressList(""),
  subject: "Plan",
  text: "Here it is.",
  ...over,
});

const draftFrom = (from: string): DraftInput => ({
  mode: "new",
  from,
  to: [{ email: "jane@acme.com", name: "Jane" }],
  cc: [],
  bcc: [],
  subject: "Plan",
  text: "Here it is.",
});

const textFile = (filename: string, content: string) => ({
  filename,
  contentType: "text/plain",
  content: new TextEncoder().encode(content).buffer,
});

describe("sending what the composer holds", () => {
  it("sends from an alias under the person's name, the draft's files before the extra ones, and deletes the draft", async () => {
    const user = await mailbox("sam");
    const team = `team@${domain}`;
    const draftId = await saveDraft(db, user.id, draftFrom(team));

    const [kept] = await addDraftFiles(db, env, user.id, draftId, [
      textFile("kept.txt", "kept"),
    ]);

    const { sent, env: testEnv } = recordingEmail();

    const result = await sendComposed(testEnv, db, user, {
      ...composed(team, "Jane <jane@acme.com>"),
      draftId,
      files: [textFile("extra.txt", "extra")],
    });

    const { message } = await filed(user.id, result.threadId, result.messageId);

    expect({
      from: sent[0]?.from,
      to: sent[0]?.to,
      attachments: sent[0]?.attachments?.map((a) => a.filename),
      filedFrom: message.from,
      draft: await db.query.drafts.findFirst({ where: eq(drafts.id, draftId) }),
      draftFiles: await db.query.draftFiles.findMany({
        where: eq(draftFiles.draftId, draftId),
      }),
      kept: await env.MAIL.head(defined(kept).r2Key),
    }).toStrictEqual({
      from: { email: team, name: "Sam Sender" },
      to: ["jane@acme.com"],
      attachments: ["kept.txt", "extra.txt"],
      filedFrom: { email: team, name: "Sam Sender" },
      draft: undefined,
      draftFiles: [],
      kept: null,
    });
  });

  it("refuses an address the person cannot send as, and names what is not an address, sending nothing and keeping the draft", async () => {
    const user = await mailbox("sam");
    const draftId = await saveDraft(db, user.id, draftFrom(user.email));
    const { sent, env: testEnv } = recordingEmail();

    const notMine = await rejection(
      sendComposed(testEnv, db, user, {
        ...composed("other@acme.com", "jane@acme.com"),
        draftId,
      })
    );

    const notAddresses = await rejection(
      sendComposed(testEnv, db, user, {
        ...composed(user.email, "jane@acme.com, nobody"),
        cc: parseAddressList("jane@acme"),
        draftId,
      })
    );

    const kept = await db.query.drafts.findFirst({
      where: eq(drafts.id, draftId),
    });

    expect({
      notMine: notMine instanceof SendError && notMine.message,
      notAddresses: notAddresses instanceof SendError && notAddresses.message,
      sent: sent.length,
      draft: kept?.id,
    }).toStrictEqual({
      notMine: "You cannot send as other@acme.com.",
      notAddresses: "Check these addresses: nobody, jane@acme",
      sent: 0,
      draft: draftId,
    });
  });
});

const rawKeysOf = async (userId: string) => {
  const { objects } = await env.MAIL.list({ prefix: `raw/${userId}/` });

  return objects.map((o) => o.key);
};

const noteSubject = () => `Note to self ${crypto.randomUUID()}`;

describe("a message to one of the owner's own addresses", () => {
  it.each(["the send", "the copy"])(
    "ends in Inbox and Sent when %s is filed first, even where a filter keeps the owner's mail out of the inbox",
    async (firstFiled) => {
      const local = firstFiled === "the send" ? "sol" : "sky";
      const notes = `${local}.notes@${domain}`;
      const user = await mailbox(local, local, [notes]);
      await saveFilter(db, user.id, {
        conditions: { from: user.email },
        actions: { skipInbox: true },
      });
      const title = noteSubject();
      const id = `<own-${crypto.randomUUID()}@${domain}>`;
      const rawText = `Subject: ${title}\r\n\r\nNotes.`;
      const raw = new TextEncoder().encode(rawText).buffer;

      const copy = () =>
        ingestInboundEmail(
          env,
          raw,
          mail({
            messageId: id,
            from: { email: user.email, name: user.name },
            to: [{ email: notes, name: null }],
            subject: title,
            text: "Notes.",
          }),
          notes
        );

      const send = () =>
        sendMail(recordingEmail(undefined, id).env, db, user, {
          from: user.email,
          to: [{ email: notes, name: null }],
          cc: [],
          bcc: [],
          subject: title,
          text: "Notes.",
          files: [],
        });

      const sendFirst = async () => {
        const sent = await send();
        const outcome = await copy();

        return {
          ...sent,
          outcome,
          expected: {
            status: "duplicate",
            threadId: sent.threadId,
            messageId: sent.messageId,
          },
        };
      };

      const copyFirst = async () => {
        const arrived = await copy();

        if (arrived.status !== "stored") {
          throw new Error("not stored");
        }

        const listed = await listThreads(db, user.id, { folder: "inbox" });
        const sent = await send();

        return {
          ...sent,
          outcome: {
            inInbox: listed.some((t) => t.id === arrived.threadId),
            threadId: sent.threadId,
            messageId: sent.messageId,
          },
          expected: {
            inInbox: false,
            threadId: arrived.threadId,
            messageId: arrived.messageId,
          },
        };
      };

      const { threadId, messageId, outcome, expected } =
        firstFiled === "the send" ? await sendFirst() : await copyFirst();

      // The send's copy is a duplicate carrying (among the rest of its answer) the two ids; the other order's
      // outcome is made of exactly the three, so `toMatchObject` holds both to the same answers.
      expect(outcome).toMatchObject(expected);

      await Promise.all(
        (["inbox", "sent"] as const).map(async (folder) => {
          const threads = await listThreads(db, user.id, { folder });

          expect(threads.map((t) => t.id)).toContain(threadId);
        })
      );

      // One conversation: nothing is left of one the second side started for itself.
      const threads2 = await listThreads(db, user.id, {
        folder: "archive",
        q: title,
      });

      expect(threads2.map((t) => t.id)).toStrictEqual([threadId]);
      const loaded = defined(await loadThread(db, env, user.id, threadId));
      expect(loaded.thread).toMatchObject({
        folder: "inbox",
        unreadCount: 0,
        sentCount: 1,
      });
      expect({
        messages: loaded.messages,
        rawKeysOf: await rawKeysOf(user.id),
      }).toStrictEqual({
        messages: [
          expect.objectContaining({
            id: messageId,
            direction: "outbound",
            read: true,
            deliveryStatus: "sent",
            hasRaw: true,
          }),
        ],
        rawKeysOf: [`raw/${user.id}/${messageId}.eml`],
      });
      const getResult = await env.MAIL.get(`raw/${user.id}/${messageId}.eml`);
      await expect(getResult?.text()).resolves.toBe(rawText);
    }
  );
});
