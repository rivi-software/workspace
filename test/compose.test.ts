import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { draftFiles, drafts, messages, users } from "~/db/schema";
import { composeData } from "~/lib/mail/compose.server";
import { addImageSender } from "~/lib/mail/images.server";
import {
  handleInboundEmail,
  ingestInboundEmail,
  parseRawEmail,
} from "~/lib/mail/ingest.server";
import { saveVacation } from "~/lib/mail/preferences.server";
import {
  addDraftFiles,
  deleteDraft,
  draftFilesForSending,
  draftForThread,
  removeDraftFile,
  sanitizeOutgoingHtml,
  saveDraft,
  sendMail,
} from "~/lib/mail/send.server";
import { saveSignature } from "~/lib/mail/signatures.server";
import { applyThreadAction } from "~/lib/mail/threads.server";
import {
  isAutomatedMail,
  maybeAutoReply,
  vacationActive,
} from "~/lib/mail/vacation.server";
import { htmlIsBlank } from "~/lib/text";

import {
  db,
  defined,
  forwardable,
  mail,
  mailbox,
  rawMail,
  recordingEmail,
  rejectionIncludes,
} from "./fixtures";

const bytes = (s: string) => new TextEncoder().encode(s).buffer;

describe("the rich composer's message", () => {
  it("sends what was written as HTML, made safe, with the signature above the quote and a text part made from it", async () => {
    const user = await mailbox("rich", "Rich Writer");

    const signatureId = await saveSignature(db, user.id, {
      name: "Work",
      text: "Rich\nRIVI",
    });

    const { sent, env: testEnv } = recordingEmail();
    await sendMail(testEnv, db, user, {
      from: user.email,
      to: [{ email: "jane@acme.com", name: null }],
      cc: [],
      bcc: [],
      subject: "Rich",
      text: "",
      html: '<div>Hello <b>Jane</b><script>x()</script></div><div class="gmail_quote">On x, y wrote:<blockquote>old</blockquote></div>',
      signatureId,
      files: [],
    });
    expect(sent[0].html).not.toContain("<script");
    expect(sent[0].html).toContain("<b>Jane</b>");
    expect(sent[0].html).toMatch(/rivi_signature[\s\S]*gmail_quote/u);
    expect(sent[0].text).toBe(
      "Hello Jane\n\n-- \nRich\nRIVI\n\nOn x, y wrote:\n> old"
    );
  });

  it("knows an empty editor from a message, and strips styles and scripts from what goes out", () => {
    expect(htmlIsBlank("<div><br></div>")).toBeTruthy();
    expect(htmlIsBlank("<div>hi</div>")).toBeFalsy();
    expect(htmlIsBlank('<img src="https://x/a.png">')).toBeFalsy();
    expect(
      sanitizeOutgoingHtml(
        '<style>p{}</style><p onclick="x()">a<a href="javascript:1">b</a></p>'
      )
    ).toBe('<p>a<a target="_blank" rel="noopener noreferrer">b</a></p>');
  });
});

/**
 * One of lol-html's `element.attributes`, a [name, value] pair. The DOM's `Element` shares the type's name and wins
 * the merge, so the compiler takes them for the DOM's `Attr`.
 */
const isAttributePair = (value: unknown): value is [string, string] =>
  Array.isArray(value) &&
  typeof value[0] === "string" &&
  typeof value[1] === "string";

/** The event handler attributes in markup as an HTML parser reads it (lol-html, not the sanitiser's expressions). */
const handlersIn = async (html: string): Promise<string[]> => {
  const found: string[] = [];
  await new HTMLRewriter()
    .on("*", {
      element(el) {
        for (const pair of el.attributes) {
          if (isAttributePair(pair) && pair[0].startsWith("on")) {
            found.push(`${el.tagName} ${pair[0]}`);
          }
        }
      },
    })
    .transform(new Response(html))
    .text();

  return found;
};

/** What markup loads from the web as an HTML parser reads it: an image's address, a style that names a `url(`. */
const loadsIn = async (html: string): Promise<string[]> => {
  const found: string[] = [];
  await new HTMLRewriter()
    .on("*", {
      element(el) {
        for (const pair of el.attributes) {
          if (
            isAttributePair(pair) &&
            (["src", "background", "poster"].includes(pair[0]) ||
              (pair[0] === "style" && pair[1].includes("url(")))
          ) {
            found.push(`${el.tagName} ${pair[0]}=${pair[1]}`);
          }
        }
      },
    })
    .transform(new Response(html))
    .text();

  return found;
};

describe("drafts and their files", () => {
  it("keeps the markup, derives the text, holds files in R2 and lets them go with the draft", async () => {
    const observed: unknown[] = [];

    const user = await mailbox("dee", "Dee Draft");

    const id = await saveDraft(db, user.id, {
      mode: "new",
      from: user.email,
      to: [{ email: "a@b.co", name: null }],
      cc: [],
      bcc: [],
      subject: "Later",
      text: "",
      html: "<p>Soon</p><ul><li>one</li></ul>",
    });

    const row = await db.query.drafts.findFirst({ where: eq(drafts.id, id) });
    expect(row).toMatchObject({
      html: "<p>Soon</p><ul><li>one</li></ul>",
      text: "Soon\n\n- one",
    });

    const [file] = await addDraftFiles(db, env, user.id, id, [
      { filename: "a.txt", contentType: "text/plain", content: bytes("aaa") },
    ]);

    const got1 = await env.MAIL.get(file.r2Key);
    observed.push(got1 === null);
    await addDraftFiles(db, env, user.id, id, [
      { filename: "b.txt", contentType: "text/plain", content: bytes("bb") },
    ]);
    const forSending = await draftFilesForSending(db, env, user.id, id);
    observed.push(
      forSending.map((f) => [f.filename, new TextDecoder().decode(f.content)])
    );
    await removeDraftFile(db, env, user.id, file.id);

    const remainingForSending = await draftFilesForSending(
      db,
      env,
      user.id,
      id
    );

    observed.push({
      MAILGet: await env.MAIL.get(file.r2Key),
      draftFilesForSendingMap: remainingForSending.map((f) => f.filename),
    });
    // The composer starts from the draft with its files.
    const data = await composeData(db, user, { draft: id });
    expect(data.prefill).toMatchObject({
      draftId: id,
      html: "<p>Soon</p><ul><li>one</li></ul>",
      subject: "Later",
    });
    observed.push(
      data.prefill.files.map((f) => f.filename),
      await rejectionIncludes(
        addDraftFiles(db, env, user.id, id, [
          {
            filename: "big.bin",
            contentType: "application/octet-stream",
            content: new ArrayBuffer(21 * 1024 * 1024),
          },
        ]),
        "too large"
      )
    );

    const remaining = await db.query.draftFiles.findMany({
      where: eq(draftFiles.draftId, id),
    });

    await deleteDraft(db, env, user.id, id);
    observed.push(
      await db.query.drafts.findFirst({ where: eq(drafts.id, id) })
    );

    expect(observed).toStrictEqual([
      // got1 === null
      false,
      // forSending.map((f) => [f.filename, new TextDecoder().decode(f.content)])
      [
        ["a.txt", "aaa"],
        ["b.txt", "bb"],
      ],
      // { MAILGet: await env.MAIL.get(file.r2Key), draftFilesForSendingMap: ( await draftFilesF...
      { MAILGet: null, draftFilesForSendingMap: ["b.txt"] },
      // data.prefill.files.map((f) => f.filename)
      ["b.txt"],
      // (await rejection(addDraftFiles(db, env, user.id, id, [ { filename: "big.bin", contentTy...
      true,
      // db.query.drafts.findFirst({ where: eq(drafts.id, id) })
      undefined,
    ]);

    await Promise.all(
      remaining.map((f) => expect(env.MAIL.get(f.r2Key)).resolves.toBeNull())
    );
  });

  it("finds the draft written in a thread and starts a reply from the original's markup", async () => {
    const observed: unknown[] = [];

    const user = await mailbox("dee", "Dee Draft");

    const inbound = await ingestInboundEmail(
      env,
      null,
      mail({
        subject: "Markup",
        html: "<style>p{color:red}</style><p>Hello <b>there</b></p>",
        text: "Hello there",
        to: [{ email: user.email, name: null }],
      }),
      user.email
    );

    if (inbound.status !== "stored") {
      throw new Error("not stored");
    }

    const reply = await composeData(db, user, {
      reply: inbound.messageId,
      mode: "reply",
    });

    expect(reply.prefill).toMatchObject({
      mode: "reply",
      threadId: inbound.threadId,
      to: "Jane Doe <jane@acme.com>",
    });
    observed.push(
      {
        html: reply.prefill.html.includes('<div class="gmail_quote">'),
        html2: reply.prefill.html.includes("Hello <b>there</b>"),
      },
      reply.prefill.html.includes("<style>"),
      reply.prefill.text.includes("> Hello there")
    );

    const forward = await composeData(db, user, {
      reply: inbound.messageId,
      mode: "forward",
    });

    observed.push({
      subject: forward.prefill.subject,
      html: forward.prefill.html.includes("Forwarded message"),
    });

    const draftId = await saveDraft(db, user.id, {
      threadId: inbound.threadId,
      inReplyToId: inbound.messageId,
      mode: "reply",
      from: user.email,
      to: [],
      cc: [],
      bcc: [],
      subject: "Re: Markup",
      text: "",
      html: "<p>Soon</p>",
    });

    const draft = await draftForThread(db, user.id, inbound.threadId);
    observed.push(draft?.id);

    expect(observed).toStrictEqual([
      // { html: reply.prefill.html.includes('<div class="gmail_quote">'), html2: reply.prefill....
      { html: true, html2: true },
      // reply.prefill.html.includes("<style>")
      false,
      // reply.prefill.text.includes("> Hello there")
      true,
      // { subject: forward.prefill.subject, html: forward.prefill.html.includes("Forwarded mess...
      { subject: "Fwd: Markup", html: true },
      // draft?.id
      draftId,
    ]);
  });

  it("starts a reply or forward from markup in which no tag the sender cut off runs a handler", async () => {
    const user = await mailbox("quill", "Quill Quote");

    const inbound = await ingestInboundEmail(
      env,
      null,
      mail({
        subject: "Broken",
        // An xmp the browser reads as text, and a tag cut off at the end that the quote's own markup would close.
        html: '<p>Hi</p><xmp><b title="</xmp><img src=x onerror=alert(1)>">x</b></xmp><img src=x onerror=alert(2)//',
        text: "Hi",
        to: [{ email: user.email, name: null }],
      }),
      user.email
    );

    if (inbound.status !== "stored") {
      throw new Error("not stored");
    }

    await Promise.all(
      (["reply", "forward"] as const).map(async (mode) => {
        const { prefill } = await composeData(db, user, {
          reply: inbound.messageId,
          mode,
        });

        expect({
          escaped: prefill.html.includes("&lt;img src=x onerror=alert(2)//</"),
          mode,
        }).toStrictEqual({
          escaped: true,
          mode,
        });
        await expect(handlersIn(prefill.html)).resolves.toStrictEqual([]);
      })
    );
  });

  it("holds the original's images from the web in the quote unless opening it loads them, and sends them all the same", async () => {
    const user = await mailbox("pia", "Pia Pixel");

    const inbound = await ingestInboundEmail(
      env,
      null,
      mail({
        subject: "Letters",
        from: { email: "news@letters.example", name: "Letters" },
        html: '<p>Hi</p><img src="https://tracker.example/p.gif" alt=""><p style="background:url(https://tracker.example/b.gif)">x</p>',
        text: "Hi",
        to: [{ email: user.email, name: null }],
      }),
      user.email
    );

    if (inbound.status !== "stored") {
      throw new Error("not stored");
    }

    const quote = async (mode: "reply" | "forward") => {
      const { prefill } = await composeData(db, user, {
        reply: inbound.messageId,
        mode,
      });

      return prefill.html;
    };

    const loading = [
      "img src=https://tracker.example/p.gif",
      "p style=background:url(https://tracker.example/b.gif)",
    ];

    const reply = await quote("reply");
    const forward = await quote("forward");

    const { sent, env: testEnv } = recordingEmail();
    await sendMail(testEnv, db, user, {
      from: user.email,
      to: [{ email: "ann@acme.com", name: null }],
      cc: [],
      bcc: [],
      subject: "Fwd: Letters",
      text: "",
      html: forward,
      files: [],
    });

    await addImageSender(db, user.id, "letters.example");
    const allowed = await quote("reply");

    await applyThreadAction(db, env, user.id, [inbound.threadId], {
      intent: "spam",
    });
    const inSpam = await quote("reply");

    expect({
      reply: await loadsIn(reply),
      forward: await loadsIn(forward),
      sent: await loadsIn(sent[0].html ?? ""),
      heldInSent: sent[0].html?.includes("data-held-"),
      allowed: await loadsIn(allowed),
      inSpam: await loadsIn(inSpam),
    }).toStrictEqual({
      reply: [],
      forward: [],
      sent: loading,
      heldInSent: false,
      allowed: loading,
      inSpam: [],
    });
  });
});

describe("the vacation responder", () => {
  it("answers a person once in four days, never a machine, a list or itself", async () => {
    const observed: unknown[] = [];

    const user = await mailbox("vic", "Vic Vacation");
    observed.push(
      await rejectionIncludes(
        saveVacation(db, user.id, {
          on: true,
          subject: "",
          text: "  ",
          from: null,
          until: null,
        }),
        "what the automatic reply"
      )
    );
    await saveVacation(db, user.id, {
      on: true,
      subject: "",
      text: "I am away.",
      from: "2000-01-01",
      until: "2999-12-31",
    });

    const fresh = defined(
      await db.query.users.findFirst({
        where: eq(users.id, user.id),
      })
    );

    observed.push({
      vacationActive: vacationActive(fresh),
      vacationActive2: vacationActive({
        ...fresh,
        vacationUntil: "2000-01-02",
      }),
      vacationActive3: vacationActive({
        ...fresh,
        vacationFrom: "2999-01-01",
        vacationUntil: null,
      }),
      isAutomatedMail: isAutomatedMail(
        [{ key: "auto-submitted", value: "auto-replied" }],
        "a@b.co"
      ),
      isAutomatedMail2: isAutomatedMail(
        [{ key: "precedence", value: "bulk" }],
        "a@b.co"
      ),
      isAutomatedMail3: isAutomatedMail(
        [{ key: "list-id", value: "<x.list>" }],
        "a@b.co"
      ),
      isAutomatedMail4: isAutomatedMail([], "no-reply@shop.example"),
      isAutomatedMail5: isAutomatedMail(
        [{ key: "auto-submitted", value: "no" }],
        "jane@acme.com"
      ),
    });

    const { sent, env: testEnv } = recordingEmail();
    const own = new Set([user.email]);

    const input = {
      messageId: "<v1@acme.com>",
      references: [],
      from: { email: "jane@acme.com", name: "Jane" },
      subject: "Lunch?",
    };

    observed.push(Boolean(await maybeAutoReply(testEnv, fresh, own, input)));
    expect(sent[0]).toMatchObject({
      // The binding takes bare recipient addresses; SES keeps the name.
      to: ["jane@acme.com"],
      subject: "Automatic reply: Re: Lunch?",
      text: "I am away.",
      headers: {
        "Auto-Submitted": "auto-replied",
        "In-Reply-To": "<v1@acme.com>",
      },
    });
    observed.push(
      Boolean(
        await maybeAutoReply(testEnv, fresh, own, {
          ...input,
          messageId: "<v2@acme.com>",
        })
      ),
      Boolean(
        await maybeAutoReply(testEnv, fresh, own, {
          ...input,
          from: { email: user.email, name: null },
        })
      ),
      sent.length
    );

    // Through the email handler: a list's mail is stored but not answered.
    const raw = rawMail({ to: user.email, subject: "Newsletter" }).replace(
      "Subject:",
      "List-Unsubscribe: <https://list.example/u>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\nSubject:"
    );

    const parsed = await parseRawEmail(bytes(raw), "news@list.example");
    observed.push({
      automated: parsed.automated,
      unsubscribe: parsed.unsubscribe,
    });
    const { message } = forwardable(raw, "news@list.example", user.email);
    const result = await handleInboundEmail(message, testEnv);
    observed.push(result.status);

    const stored = await db.query.messages.findFirst({
      where: eq(
        messages.id,
        result.status === "stored" ? result.messageId : ""
      ),
    });

    expect(JSON.parse(defined(defined(stored).listUnsubscribe))).toMatchObject({
      http: "https://list.example/u",
      oneClick: true,
    });
    observed.push(sent.length);

    expect(observed).toStrictEqual([
      // (await rejection(saveVacation(db, user.id, { on: true, subject: "", text: " ", from: nu...
      true,
      // { vacationActive: vacationActive(fresh), vacationActive2: vacationActive({ ...fresh, va...
      {
        vacationActive: true,
        vacationActive2: false,
        vacationActive3: false,
        isAutomatedMail: true,
        isAutomatedMail2: true,
        isAutomatedMail3: true,
        isAutomatedMail4: true,
        isAutomatedMail5: false,
      },
      // Boolean(await maybeAutoReply(testEnv, fresh, own, input))
      true,
      // Boolean(await maybeAutoReply(testEnv, fresh, own, { ...input, messageId: "<v2@acme.com>...
      false,
      // Boolean(await maybeAutoReply(testEnv, fresh, own, { ...input, from: { email: user.email...
      false,
      // sent.length
      1,
      // { automated: parsed.automated, unsubscribe: parsed.unsubscribe, }
      {
        automated: true,
        unsubscribe: {
          http: "https://list.example/u",
          mailto: null,
          oneClick: true,
        },
      },
      // result.status
      "stored",
      // sent.length
      1,
    ]);
  });
});
