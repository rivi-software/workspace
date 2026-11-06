import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { attachments, drafts, messages } from "~/db/schema";
import { composeData } from "~/lib/mail/compose.server";
import { ingestInboundEmail } from "~/lib/mail/ingest.server";
import { saveDraft, sendMail } from "~/lib/mail/send.server";
import type { DraftInput } from "~/lib/mail/send.server";
import { inlineDataImages, sanitizeSignatureHtml } from "~/lib/mail/signatures";
import {
  SignatureError,
  deleteSignature,
  listSignatures,
  saveSignature,
  setDefaultSignatures,
} from "~/lib/mail/signatures.server";

import {
  db,
  defined,
  mail,
  mailbox,
  recordingEmail,
  rejection,
} from "./fixtures";

// A 1×1 PNG, as the editor puts an uploaded logo in the markup.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const logo = `<img src="data:image/png;base64,${PNG}" alt="RIVI" width="120">`;

const draft = (from: string, signatureId: string | null): DraftInput => ({
  mode: "new",
  from,
  to: [],
  cc: [],
  bcc: [],
  subject: "Later",
  text: "…",
  signatureId,
});

const signatureOf = async (id: string) => {
  const draftRow = await db.query.drafts.findFirst({
    where: eq(drafts.id, id),
  });

  return draftRow?.signatureId;
};

describe("signatures", () => {
  it("makes the first one the default and keeps one default when another is chosen", async () => {
    const user = await mailbox("sigrid");

    const work = await saveSignature(db, user.id, {
      name: " Work ",
      text: "Sigrid\nRIVI\n",
    });

    const short = await saveSignature(db, user.id, {
      name: "Short",
      text: "— S",
    });

    await expect(listSignatures(db, user.id)).resolves.toMatchObject([
      { id: work, name: "Work", text: "Sigrid\nRIVI", isDefault: true },
      { id: short, name: "Short", text: "— S", isDefault: false },
    ]);
    await setDefaultSignatures(db, user.id, { new: short });
    const signatures = await listSignatures(db, user.id);
    expect(signatures.map((s) => s.isDefault)).toStrictEqual([false, true]);
    await setDefaultSignatures(db, user.id, { new: null });
    const signatures2 = await listSignatures(db, user.id);
    expect(signatures2.map((s) => s.isDefault)).toStrictEqual([false, false]);
    // Deleting the default leaves none rather than promoting another.
    await setDefaultSignatures(db, user.id, { new: work });
    await deleteSignature(db, user.id, work);
    await expect(listSignatures(db, user.id)).resolves.toMatchObject([
      { id: short, isDefault: false },
    ]);
  });

  it("keeps a default of its own for replies and forwards", async () => {
    const observed: unknown[] = [];

    const user = await mailbox("rhea");

    const full = await saveSignature(db, user.id, {
      name: "Full",
      text: "Rhea\nRIVI Software",
    });

    const short = await saveSignature(db, user.id, {
      name: "Short",
      text: "— R",
    });

    // The first signature is both defaults, as the one default was before.
    const defaults = async () => {
      const signatures = await listSignatures(db, user.id);

      return signatures.map((s) => [s.name, s.isDefault, s.isReplyDefault]);
    };

    observed.push(await defaults());
    await setDefaultSignatures(db, user.id, { new: full, reply: short });
    observed.push(await defaults());
    // One default changes without the other; the same signature can be both.
    await setDefaultSignatures(db, user.id, { reply: full });
    observed.push(await defaults());
    await setDefaultSignatures(db, user.id, { new: short, reply: null });
    observed.push(await defaults());
    // A signature that is not the person's changes neither default.
    const other = await mailbox("rolf");

    const theirs = await saveSignature(db, other.id, {
      name: "Rolf",
      text: "Rolf",
    });

    observed.push(
      (await rejection(
        setDefaultSignatures(db, user.id, { new: full, reply: theirs })
      )) instanceof SignatureError,
      await defaults()
    );
    // Deleting the reply default leaves replies without one.
    await setDefaultSignatures(db, user.id, { reply: short });
    await deleteSignature(db, user.id, short);
    observed.push(await defaults());

    expect(observed).toStrictEqual([
      // defaults()
      [
        ["Full", true, true],
        ["Short", false, false],
      ],
      // defaults()
      [
        ["Full", true, false],
        ["Short", false, true],
      ],
      // defaults()
      [
        ["Full", true, true],
        ["Short", false, false],
      ],
      // defaults()
      [
        ["Full", false, false],
        ["Short", true, false],
      ],
      // (await rejection(setDefaultSignatures(db, user.id, { new: full, reply: theirs }))) inst...
      true,
      // defaults()
      [
        ["Full", false, false],
        ["Short", true, false],
      ],
      // defaults()
      [["Full", false, false]],
    ]);
  });

  it("starts a new message on the default and a reply or forward on the reply default", async () => {
    const observed: unknown[] = [];

    const user = await mailbox("cora");

    const full = await saveSignature(db, user.id, {
      name: "Full",
      text: "Cora\nRIVI Software",
    });

    const short = await saveSignature(db, user.id, {
      name: "Short",
      text: "— C",
    });

    await setDefaultSignatures(db, user.id, { new: full, reply: short });

    const inbound = await ingestInboundEmail(
      env,
      null,
      mail({ subject: "Numbers", to: [{ email: user.email, name: null }] }),
      user.email
    );

    if (inbound.status !== "stored") {
      throw new Error("not stored");
    }

    const { messageId } = inbound;

    const startsOn = async (params: Parameters<typeof composeData>[2]) => {
      const { prefill } = await composeData(db, user, params);

      return prefill.signatureId;
    };

    observed.push(
      await startsOn({}),
      await startsOn({ reply: messageId, mode: "reply" }),
      await startsOn({ reply: messageId, mode: "all" }),
      await startsOn({ reply: messageId, mode: "forward" })
    );
    // No reply default: a reply starts without a signature, a new message still on its own.
    await setDefaultSignatures(db, user.id, { reply: null });
    observed.push(
      await startsOn({ reply: messageId, mode: "reply" }),
      await startsOn({})
    );

    // A draft keeps the signature it was saved with, whichever default it would start on now.
    const id = await saveDraft(db, user.id, {
      ...draft(user.email, full),
      mode: "reply",
      inReplyToId: messageId,
    });

    observed.push(await startsOn({ draft: id }));

    expect(observed).toStrictEqual([
      // startsOn({})
      full,
      // startsOn({ reply: messageId, mode: "reply" })
      short,
      // startsOn({ reply: messageId, mode: "all" })
      short,
      // startsOn({ reply: messageId, mode: "forward" })
      short,
      // startsOn({ reply: messageId, mode: "reply" })
      null,
      // startsOn({})
      full,
      // startsOn({ draft: id })
      full,
    ]);
  });

  it("changes, chooses and deletes only the owner's signatures", async () => {
    const observed: unknown[] = [];

    const owner = await mailbox("olga");
    const other = await mailbox("otto");

    const id = await saveSignature(db, owner.id, {
      name: "Mine",
      text: "Olga",
    });

    observed.push(
      (await rejection(
        saveSignature(db, other.id, { id, name: "Taken", text: "Otto" })
      )) instanceof SignatureError,
      (await rejection(
        setDefaultSignatures(db, other.id, { new: id })
      )) instanceof SignatureError,
      (await rejection(
        setDefaultSignatures(db, other.id, { reply: id })
      )) instanceof SignatureError
    );
    await deleteSignature(db, other.id, id);
    await expect(listSignatures(db, owner.id)).resolves.toMatchObject([
      { id, name: "Mine", text: "Olga" },
    ]);
    await saveSignature(db, owner.id, { id, name: "Renamed", text: "Olga K." });
    await expect(listSignatures(db, owner.id)).resolves.toMatchObject([
      { id, name: "Renamed", text: "Olga K.", isDefault: true },
    ]);
    // A draft does not keep someone else's signature.
    observed.push(
      await signatureOf(await saveDraft(db, other.id, draft(other.email, id)))
    );

    expect(observed).toStrictEqual([
      // (await rejection(saveSignature(db, other.id, { id, name: "Taken", text: "Otto" }))) ins...
      true,
      // (await rejection(setDefaultSignatures(db, other.id, { new: id }))) instanceof Signature...
      true,
      // (await rejection(setDefaultSignatures(db, other.id, { reply: id }))) instanceof Signatu...
      true,
      // signatureOf(await saveDraft(db, other.id, draft(other.email, id)))
      null,
    ]);
  });

  it("needs a name and some text", async () => {
    const user = await mailbox("nina");
    await expect(
      saveSignature(db, user.id, { name: " ", text: "Nina" })
    ).rejects.toThrow("A signature needs a name.");
    await expect(
      saveSignature(db, user.id, { name: "Work", text: "\n " })
    ).rejects.toThrow("A signature needs some text.");
    await expect(listSignatures(db, user.id)).resolves.toStrictEqual([]);
  });

  it("takes a deleted signature off the drafts that used it", async () => {
    const user = await mailbox("dora");
    const id = await saveSignature(db, user.id, { name: "Work", text: "Dora" });
    const draftId = await saveDraft(db, user.id, draft(user.email, id));
    await expect(signatureOf(draftId)).resolves.toBe(id);
    await deleteSignature(db, user.id, id);
    await expect(signatureOf(draftId)).resolves.toBeNull();
  });
});

describe("HTML signatures", () => {
  it("keeps the markup sanitised, its own images with it, and reads its text from it", async () => {
    const observed: unknown[] = [];

    const user = await mailbox("hilde");

    const id = await saveSignature(db, user.id, {
      name: "Logo",
      text: "",
      html: `<table style="color:#333"><tr><td>${logo}</td><td><b>Hilde</b><br><a href="https://rivi.software" onclick="x()">rivi.software</a></td></tr></table><script>alert(1)</script><style>td{color:red}</style><img src="data:text/html;base64,PHA+">`,
    });

    const [saved] = await listSignatures(db, user.id);
    observed.push(
      saved.id,
      saved.html?.includes(`src="data:image/png;base64,${PNG}"`),
      saved.html?.includes('style="color:#333"'),
      saved.html?.includes("<b>Hilde</b>"),
      /script|onclick|<style|data:text/u.test(saved.html ?? ""),
      // A link whose text is its address is read once.
      saved.text
    );

    expect(observed).toStrictEqual([
      // saved.id
      id,
      // saved.html.includes(`src="data:image/png;base64,${PNG}"`)
      true,
      // saved.html.includes('style="color:#333"')
      true,
      // saved.html.includes("<b>Hilde</b>")
      true,
      // /script|onclick|<style|data:text/u.test(saved.html)
      false,
      // saved.text
      "[RIVI]  Hilde\nrivi.software",
    ]);
  });

  it("takes a signature that is only an image, and refuses one too large to keep", async () => {
    const user = await mailbox("ivo");
    await saveSignature(db, user.id, {
      name: "Logo only",
      text: "",
      html: logo,
    });
    await expect(listSignatures(db, user.id)).resolves.toMatchObject([
      { name: "Logo only" },
    ]);
    await expect(
      saveSignature(db, user.id, {
        name: "Huge",
        text: "",
        html: `<img src="data:image/png;base64,${"A".repeat(900_000)}">`,
      })
    ).rejects.toThrow("The signature is too large");
  });

  it("drops a data: image from mail that arrives, and keeps one only for a signature", () => {
    const html = `<p>Hi</p>${logo}<img src="data:image/svg+xml;base64,PHN2Zz4=">`;
    expect(sanitizeSignatureHtml(html)).toContain(
      `data:image/png;base64,${PNG}`
    );
    expect(sanitizeSignatureHtml(html)).not.toContain("svg+xml");
  });

  it("turns each distinct image into one inline attachment", () => {
    const { html, images } = inlineDataImages(
      `${logo}<br>${logo}`,
      "rivi.software"
    );

    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      contentType: "image/png",
      filename: "image1.png",
      base64: PNG,
    });
    expect(images[0].contentId).toMatch(/^sig1\.[a-z0-9]+@rivi\.software$/u);
    expect(
      html.match(
        new RegExp(`cid:${images[0].contentId.replaceAll(".", "\\.")}`, "gu")
      )
    ).toHaveLength(2);
    expect(html).not.toContain("data:");
  });

  it("sends the signature's markup in the HTML part, its images inline, and its text in the text part", async () => {
    const observed: unknown[] = [];

    const user = await mailbox("hugo", "Hugo");

    const signatureId = await saveSignature(db, user.id, {
      name: "Work",
      text: "",
      html: `${logo}<div><b>Hugo</b> · RIVI</div>`,
    });

    const { sent, env: testEnv } = recordingEmail();

    const { messageId } = await sendMail(testEnv, db, user, {
      from: user.email,
      to: [{ email: "jane@acme.com", name: null }],
      cc: [],
      bcc: [],
      subject: "Logo",
      text: "",
      html: "<div>See below.</div>",
      signatureId,
      files: [],
    });

    const [out] = sent;
    observed.push(
      out.html?.includes(
        '<div class="rivi_signature">-- <br><img src="cid:sig1.'
      ),
      out.html?.includes("<b>Hugo</b> · RIVI"),
      out.html?.includes("data:"),
      {
        text: out.text,
        attachments: out.attachments,
      }
    );

    // The sent copy shows the logo too: an inline file of the message, found by its Content-ID.
    const files = await db.query.attachments.findMany({
      where: eq(attachments.messageId, messageId),
    });

    expect(files).toMatchObject([
      { inline: true, contentType: "image/png", size: 68 },
    ]);
    observed.push(out.html?.includes(`cid:${files[0].contentId}`));
    const object = await env.MAIL.get(files[0].r2Key);
    observed.push(
      new Uint8Array(await defined(object).arrayBuffer()).slice(1, 4)
    );

    // And a thread made of it lists no attachment: the logo is part of the message.
    const stored = await db.query.messages.findFirst({
      where: and(eq(messages.id, messageId), eq(messages.userId, user.id)),
    });

    observed.push(stored?.html?.includes("cid:sig1."));

    expect(observed).toStrictEqual([
      // out.html.includes('<div class="rivi_signature">-- <br><img src="cid:sig1.')
      true,
      // out.html.includes("<b>Hugo</b> · RIVI")
      true,
      // out.html.includes("data:")
      false,
      // { text: out.text, attachments: out.attachments }
      {
        text: "See below.\n\n-- \n[RIVI]\nHugo · RIVI",
        attachments: [
          expect.objectContaining({
            disposition: "inline",
            contentId: expect.stringMatching(/^sig1\./u),
            type: "image/png",
            content: PNG,
          }),
        ],
      },
      // out.html.includes(`cid:${files[0].contentId}`)
      true,
      // new Uint8Array(await defined(object).arrayBuffer()).slice(1, 4)
      new TextEncoder().encode("PNG"),
      // stored?.html.includes("cid:sig1.")
      true,
    ]);
  });

  it("puts an HTML signature under a message written as plain text too", async () => {
    const user = await mailbox("hanna", "Hanna");

    const signatureId = await saveSignature(db, user.id, {
      name: "Work",
      text: "",
      html: "<b>Hanna</b>",
    });

    const { sent, env: testEnv } = recordingEmail();
    await sendMail(testEnv, db, user, {
      from: user.email,
      to: [{ email: "jane@acme.com", name: null }],
      cc: [],
      bcc: [],
      subject: "Plain",
      text: "Just text.",
      signatureId,
      files: [],
    });
    expect(sent[0].text).toBe("Just text.\n\n-- \nHanna");
    expect(sent[0].html).toContain('<p style="margin:0 0 16px">Just text.</p>');
    expect(sent[0].html).toContain(
      '<div class="rivi_signature">-- <br><b>Hanna</b></div>'
    );
  });
});
