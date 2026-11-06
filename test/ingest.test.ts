import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import {
  handleInboundEmail,
  ingestInboundEmail,
  parseRawEmail,
  resolveMailbox,
} from "~/lib/mail/ingest.server";
import { listThreads, loadThread } from "~/lib/mail/mailbox.server";
import { applyThreadAction } from "~/lib/mail/threads.server";

import { db, defined, forwardable, mail, mailbox, rawMail } from "./fixtures";

const domain = env.MAIL_DOMAIN;

/** A conversation as the thread page reads it. */
const conversation = async (threadId: string) =>
  defined(await loadThread(db, env, "usr_rik", threadId));

describe("inbound mail", () => {
  beforeAll(async () => {
    await mailbox("rik", "Rik Visser", [`hello@${domain}`]);
  });

  it("files a message in the mailbox of its envelope recipient, once", async () => {
    const m = mail({ subject: "Welcome" });
    const first = await ingestInboundEmail(env, null, m, `rik@${domain}`);
    expect(first.status).toBe("stored");

    if (first.status !== "stored") {
      return;
    }

    expect(first.created).toBeTruthy();
    const { thread } = await conversation(first.threadId);
    expect(thread).toMatchObject({
      folder: "inbox",
      unreadCount: 1,
      messageCount: 1,
      subject: "Welcome",
    });
    expect(JSON.parse(thread.participantsJson)).toStrictEqual([
      { email: "jane@acme.com", name: "Jane Doe" },
    ]);
    const again = await ingestInboundEmail(env, null, m, `rik@${domain}`);
    expect(again.status).toBe("duplicate");
  });

  it("delivers aliases and plus-tags to the owner, and nothing to an unknown address", async () => {
    const viaAlias = await ingestInboundEmail(
      env,
      null,
      mail(),
      `hello@${domain}`
    );

    expect(viaAlias.status).toBe("stored");

    const viaTag = await ingestInboundEmail(
      env,
      null,
      mail(),
      `Rik+news@${domain}`
    );

    expect(viaTag.status).toBe("stored");
    await expect(resolveMailbox(db, `nobody@${domain}`)).resolves.toBeNull();

    const { status } = await ingestInboundEmail(
      env,
      null,
      mail(),
      `nobody@${domain}`
    );

    expect(status).toBe("no-mailbox");
  });

  it("threads a reply by its References, then by subject and sender, and brings an archived thread back", async () => {
    const first = await ingestInboundEmail(
      env,
      null,
      mail({ messageId: "<t1@acme.com>", subject: "Budget" }),
      `rik@${domain}`
    );

    if (first.status !== "stored") {
      throw new Error("not stored");
    }

    await applyThreadAction(db, env, "usr_rik", [first.threadId], {
      intent: "archive",
    });

    const byRef = await ingestInboundEmail(
      env,
      null,
      mail({ subject: "Re: Budget", references: ["<t1@acme.com>"] }),
      `rik@${domain}`
    );

    expect(byRef.status === "stored" && byRef.threadId).toBe(first.threadId);
    expect(byRef.status === "stored" && byRef.created).toBeFalsy();
    const { thread } = await conversation(first.threadId);
    expect(thread).toMatchObject({ folder: "inbox", messageCount: 2 });

    const bySubject = await ingestInboundEmail(
      env,
      null,
      mail({ subject: "RE: budget" }),
      `rik@${domain}`
    );

    expect(bySubject.status === "stored" && bySubject.threadId).toBe(
      first.threadId
    );

    // The same subject from someone new is a conversation of its own.
    const stranger = await ingestInboundEmail(
      env,
      null,
      mail({
        subject: "Re: Budget",
        from: { email: "pat@initech.net", name: null },
      }),
      `rik@${domain}`
    );

    expect(stranger.status === "stored" && stranger.threadId).not.toBe(
      first.threadId
    );
  });

  it("threads a reply whose References names 120 messages (CORE-1203)", async () => {
    const root = await ingestInboundEmail(
      env,
      null,
      mail({ messageId: "<long-root@acme.com>", subject: "Long conversation" }),
      `rik@${domain}`
    );

    if (root.status !== "stored") {
      throw new Error("not stored");
    }

    const earlier = Array.from(
      { length: 119 },
      (_, i) => `<long-${i}@acme.com>`
    );

    const reply = await ingestInboundEmail(
      env,
      null,
      mail({
        subject: "Something else entirely",
        inReplyTo: defined(earlier.at(-1)),
        references: ["<long-root@acme.com>", ...earlier],
      }),
      `rik@${domain}`
    );

    expect(reply.status === "stored" && reply.threadId).toBe(root.threadId);
  });

  it("parses a raw message with an HTML part and keeps the raw copy and the attachments in R2", async () => {
    const raw = rawMail({
      subject: "Report",
      body: "See attached",
      html: "<p>See <b>attached</b></p>",
      messageId: "<raw-report@acme.com>",
    });

    const parsed = await parseRawEmail(
      new TextEncoder().encode(raw).buffer,
      "jane@acme.com"
    );

    expect(parsed).toMatchObject({
      messageId: "<raw-report@acme.com>",
      from: { email: "jane@acme.com", name: "Jane Doe" },
      subject: "Report",
      text: "See attached",
      html: "<p>See <b>attached</b></p>",
    });
    parsed.attachments.push({
      filename: "report.pdf",
      mimeType: "application/pdf",
      content: new TextEncoder().encode("%PDF-1.4"),
      contentId: null,
      inline: false,
    });

    const stored = await ingestInboundEmail(
      env,
      new TextEncoder().encode(raw).buffer,
      parsed,
      `rik@${domain}`
    );

    if (stored.status !== "stored") {
      throw new Error("not stored");
    }

    const { thread, messages } = await conversation(stored.threadId);
    expect({ hasAttachments: thread.hasAttachments, messages }).toStrictEqual({
      hasAttachments: true,
      messages: [
        expect.objectContaining({
          id: stored.messageId,
          hasRaw: true,
          attachments: [
            expect.objectContaining({
              filename: "report.pdf",
              contentType: "application/pdf",
            }),
          ],
        }),
      ],
    });
    const getResult = await env.MAIL.get(`raw/usr_rik/${stored.messageId}.eml`);
    await expect(getResult?.text()).resolves.toBe(raw);
    const { objects } = await env.MAIL.list({ prefix: "att/usr_rik/" });
    const files = objects;
    const attachment = await env.MAIL.get(files[0].key);

    expect({
      files: files.length,
      MAILGetText: await attachment?.text(),
    }).toStrictEqual({ files: 1, MAILGetText: "%PDF-1.4" });
  });

  it("runs as the Email Workers handler and rejects mail for no mailbox", async () => {
    const ok = forwardable(
      rawMail({ subject: "Through the handler" }),
      "jane@acme.com",
      `rik@${domain}`
    );

    const result = await handleInboundEmail(ok.message, env);
    expect(result.status).toBe("stored");
    expect(ok.rejected).toStrictEqual([]);

    const rows = await listThreads(db, "usr_rik", {
      folder: "inbox",
      q: "Through the handler",
    });

    expect(rows).toHaveLength(1);

    const none = forwardable(
      rawMail({ to: `ghost@${domain}` }),
      "jane@acme.com",
      `ghost@${domain}`
    );

    const { status } = await handleInboundEmail(none.message, env);
    expect(status).toBe("no-mailbox");
    expect(none.rejected).toStrictEqual(["No such mailbox"]);
  });
});
