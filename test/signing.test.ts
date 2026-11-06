import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
  rgb,
} from "pdf-lib";
import type { PDFObject } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { driveNodes, signingRequests } from "~/db/schema";
import {
  parseFields,
  partyValues,
  riviPrefill,
  signingState,
} from "~/lib/drive/signing";
import { signedPdf } from "~/lib/drive/signing-pdf.server";
import {
  SigningError,
  cancelSigningRequest,
  createSigningRequest,
  customerDocument,
  customerPage,
  customerPost,
  listSigningRequests,
  remindCustomer,
  saveHandSignature,
  signForRivi,
  signingDocument,
  signingRequestView,
} from "~/lib/drive/signing.server";
import type { NewSigningRequest } from "~/lib/drive/signing.server";
import { setExternalSharing } from "~/lib/workspace-settings.server";

import {
  db,
  defined,
  mailbox,
  recordingEmail,
  rejectionIncludes,
} from "./fixtures";
import {
  FIELDS,
  SIGNATURE,
  confirmed,
  drawnText,
  form,
  origin,
  pdfBytes,
  postJson,
  putFile,
  sent,
  visitor,
} from "./signing-fixtures";

const HOUR = 3_600_000;

/** The signed copies filed whole in a person's drive. */
const signedCopiesOf = async (userId: string) => {
  const driveNodesRows = await db.query.driveNodes.findMany({
    where: eq(driveNodes.userId, userId),
  });

  return driveNodesRows.filter(
    (n) => n.status === "ready" && n.name.endsWith("(signed).pdf")
  );
};

/** A bucket that takes every read and write but the keys `refuses` names, which fail as if R2 were down. */
const bucketRefusing = (
  bucket: R2Bucket,
  refuses: (key: string) => boolean
): R2Bucket =>
  new Proxy(bucket, {
    get(target, prop) {
      if (prop === "put") {
        return (key: string, ...rest: [never, never]) => {
          if (refuses(key)) {
            throw new Error("R2 is down");
          }

          return target.put(key, ...rest);
        };
      }

      // SAFETY: `prop` is whatever key the code under test reads off the bucket, a member of R2Bucket; a key it
      // lacks reads as `undefined`, which `unknown` holds and the next line passes through.
      const value: unknown = target[prop as keyof R2Bucket];

      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the trap meets every member of the real R2 binding, and only its methods need binding to it; there is no input contract to parse
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

describe("the fields of a request", () => {
  it("keeps fields on the PDF's pages, and needs a signature for each party", () => {
    expect(parseFields(FIELDS, 2)).toStrictEqual({ fields: FIELDS });
    expect(parseFields(FIELDS, 1)).toStrictEqual({
      error: "A field is on a page the PDF does not have.",
    });
    expect(
      parseFields(
        FIELDS.filter((f) => f.id !== "r-sig"),
        2
      )
    ).toStrictEqual({
      error: "Place a signature field for Workspace.",
    });
    expect(
      parseFields([{ ...FIELDS[0], x: 0.9 }, ...FIELDS.slice(1)], 2)
    ).toStrictEqual({
      error: "A field runs off its page.",
    });
    expect(parseFields([...FIELDS, FIELDS[0]], 2)).toStrictEqual({
      error: "A field is not readable.",
    });
  });

  it("checks what a party filled in and dates it the day it signs", () => {
    const at = Date.parse("2026-10-30T12:00:00Z");
    expect(
      partyValues(FIELDS, "customer", { "c-name": " Cas " }, at)
    ).toStrictEqual({
      error: 'Tick "I agree to the terms".',
    });
    expect(
      partyValues(
        FIELDS,
        "customer",
        { "c-name": "Cas", "c-ok": "yes", "r-title": "x" },
        at
      )
    ).toStrictEqual({
      values: { "c-name": "Cas", "c-date": "2026-10-30", "c-ok": "yes" },
    });
    expect(riviPrefill(FIELDS, {})).toStrictEqual({
      error: 'Fill in "Title".',
    });
    expect(riviPrefill(FIELDS, { "r-title": "Director" })).toStrictEqual({
      values: { "r-title": "Director" },
    });
  });
});

describe("sending for signatures", () => {
  it("copies the PDF and mails the customer from the asker's own address", async () => {
    const { asker, mail, request, url } = await sent("sg-send");
    expect({
      customerEmail: request.customerEmail,
      pageCount: request.pageCount,
    }).toStrictEqual({ customerEmail: "cas@example.org", pageCount: 2 });
    await expect(env.DRIVE.head(request.originalKey)).resolves.not.toBeNull();
    expect({
      sent: mail.sent.length,
      stringify: JSON.stringify(defined(mail.sent[0]).from).includes(
        asker.email
      ),
      String: String(defined(mail.sent[0]).text).includes(url),
      String2: String(defined(mail.sent[0]).text).includes(
        "Here is the contract we discussed."
      ),
    }).toStrictEqual({ sent: 1, stringify: true, String: true, String2: true });
    const view = await signingRequestView(env, db, asker.id, request.id);
    const listedRequests = await listSigningRequests(db, asker.id);

    expect({
      state: view?.state,
      url: view?.url,
      eventsMap: view?.events.map((e) => e.kind),
      listSigningRequestsMap: listedRequests
        .map((r) => r.id)
        .includes(request.id),
    }).toStrictEqual({
      state: "awaiting-customer",
      url,
      eventsMap: ["created", "sent"],
      listSigningRequestsMap: true,
    });
  });

  it("refuses what is not a signable PDF, a missing workspace value, and auto-signing without a signature", async () => {
    const observed: unknown[] = [];

    const asker = await mailbox("sg-refuse", "Ref Asker");
    const colleague = await mailbox("sg-refuse-colleague", "Col League");

    const text = await putFile(
      asker.id,
      "notes.txt",
      new TextEncoder().encode("hi"),
      "text/plain"
    );

    const fake = await putFile(
      asker.id,
      "fake.pdf",
      new TextEncoder().encode("not a pdf"),
      "application/pdf"
    );

    const pdf = await putFile(
      asker.id,
      "real.pdf",
      await pdfBytes(),
      "application/pdf"
    );

    const base = {
      customerName: "Cas",
      customerEmail: "cas@example.org",
      signerId: asker.id,
      autoSign: false,
      message: "",
      fields: FIELDS,
      riviValues: { "r-title": "Director" },
    };

    const send = (over: Partial<NewSigningRequest>) =>
      createSigningRequest(
        recordingEmail().env,
        db,
        asker,
        { ...base, nodeId: pdf.id, ...over },
        origin
      );

    observed.push(
      await rejectionIncludes(send({ nodeId: text.id }), "Only a PDF"),
      await rejectionIncludes(
        send({ nodeId: fake.id }),
        "does not read as a PDF"
      ),
      await rejectionIncludes(send({ riviValues: {} }), 'Fill in "Title"'),
      await rejectionIncludes(
        send({ customerEmail: `x@${env.MAIL_DOMAIN}` }),
        "outside the workspace"
      ),
      await rejectionIncludes(
        send({ autoSign: true }),
        "Save your signature first"
      ),
      await rejectionIncludes(
        send({ autoSign: true, signerId: colleague.id }),
        "Only you"
      ),
      await rejectionIncludes(
        createSigningRequest(
          recordingEmail("refused").env,
          db,
          asker,
          { ...base, nodeId: pdf.id },
          origin
        ),
        "was not sent"
      )
    );

    const got33 = await db.query.signingRequests.findMany({
      where: eq(signingRequests.createdBy, asker.id),
    });

    observed.push(got33.length);

    expect(observed).toStrictEqual([
      // (await rejection(send({ nodeId: text.id })))?.message.includes("Only a PDF")
      true,
      // (await rejection(send({ nodeId: fake.id })))?.message.includes("does not read as a PDF")
      true,
      // (await rejection(send({ riviValues: {} })))?.message.includes('Fill in "Title"')
      true,
      // (await rejection(send({ customerEmail: `x@${env.MAIL_DOMAIN}` })))?.message.includes("o...
      true,
      // (await rejection(send({ autoSign: true })))?.message.includes("Save your signature first")
      true,
      // (await rejection(send({ autoSign: true, signerId: colleague.id })))?.message.includes("...
      true,
      // (await rejection(createSigningRequest( recordingEmail("refused").env, db, asker, { ...b...
      true,
      // got33.length
      0,
    ]);
  });

  it("needs sharing outside the workspace to be on", async () => {
    const admin = await mailbox("sg-admin");
    await setExternalSharing(db, admin.id, false);

    try {
      await expect(sent("sg-off")).rejects.toBeInstanceOf(SigningError);
    } finally {
      await setExternalSharing(db, admin.id, true);
    }
  });
});

describe("the customer's side", () => {
  it("opens only after the code, then signs; the workspace's signer signs after and the signed copy is filed and mailed", async () => {
    const observed: unknown[] = [];
    const observedSubsets: unknown[] = [];

    const colleague = await mailbox("sg-flow-signer", "Sig Ner");

    const { asker, file, mail, request, token } = await sent("sg-flow", {
      signerId: colleague.id,
    });

    observedSubsets.push(
      await customerPage(mail.env, db, visitor(`/s/sign/${token}`), token)
    );

    const { status } = await customerDocument(
      mail.env,
      db,
      visitor("/x"),
      token,
      false
    );

    observed.push(status);
    const cookie = await confirmed(token, mail.env, mail.sent);

    const page = await customerPage(
      mail.env,
      db,
      visitor(`/s/sign/${token}`, {}, cookie),
      token
    );

    observedSubsets.push(page);

    const doc = await customerDocument(
      mail.env,
      db,
      visitor("/x", {}, cookie),
      token,
      false
    );

    observed.push(
      {
        status: doc.status,
        contentType: doc.headers.get("content-type"),
      },
      // The workspace cannot sign before the customer.
      await rejectionIncludes(
        signForRivi(mail.env, db, colleague, request.id, SIGNATURE, origin),
        "The customer signs first."
      )
    );

    const values = { "c-name": "Cas Customer", "c-ok": "yes" };

    let res = await postJson(mail.env, token, cookie, {
      intent: "sign",
      values,
      signature: SIGNATURE,
    });

    observed.push(await res.json());
    res = await postJson(mail.env, token, cookie, {
      intent: "sign",
      values: {},
      signature: SIGNATURE,
      agree: true,
    });
    observed.push(await res.json());
    res = await postJson(mail.env, token, cookie, {
      intent: "sign",
      values,
      signature: "nope",
      agree: true,
    });
    // SAFETY: the signing page's post answers JSON with a boolean `ok` on every path (`answer` in
    // app/lib/drive/signing.server.ts).
    observed.push(Boolean(((await res.json()) as { ok: boolean }).ok));
    const before = mail.sent.length;
    res = await postJson(mail.env, token, cookie, {
      intent: "sign",
      values,
      signature: SIGNATURE,
      agree: true,
    });
    observed.push(await res.json());
    // A second post finds it signed.
    res = await postJson(mail.env, token, cookie, {
      intent: "sign",
      values,
      signature: SIGNATURE,
      agree: true,
    });
    observed.push(
      res.status,
      // The signer is told it is their turn.
      mail.sent.slice(before).map((m) => String(m.to))
    );
    observedSubsets.push(
      await customerPage(
        mail.env,
        db,
        visitor(`/s/sign/${token}`, {}, cookie),
        token
      )
    );
    // Only the chosen signer signs for the workspace; the asker cannot.
    observed.push(
      await rejectionIncludes(
        signForRivi(mail.env, db, asker, request.id, SIGNATURE, origin),
        "Only the person chosen"
      )
    );

    await signForRivi(mail.env, db, colleague, request.id, SIGNATURE, origin);

    const view = defined(
      await signingRequestView(mail.env, db, asker.id, request.id)
    );

    observed.push(view.state);
    observedSubsets.push(view.values);
    observed.push(
      {
        rDate: /^\d{4}-\d{2}-\d{2}$/u.test(view.values["r-date"]),
        eventsMap: view.events.map((e) => e.kind),
      },
      view.events
        .find((e) => e.kind === "customer-signed")
        ?.ip?.startsWith("203.0.113.") ?? false
    );

    // The signed copy: the pages and the certificate, its hash kept, filed beside the original in Drive.
    const signed = await signingDocument(
      mail.env,
      db,
      asker.id,
      request.id,
      true
    );

    const bytes = new Uint8Array(await defined(signed).arrayBuffer());

    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (b) => b.toString(16).padStart(2, "0")
    ).join("");

    const load = await PDFDocument.load(bytes);
    observed.push({
      digest,
      getPageCount: load.getPageCount() >= 3,
    });

    const filed = await db.query.driveNodes.findFirst({
      where: eq(driveNodes.id, defined(view.signedNodeId)),
    });

    observedSubsets.push(filed);

    // Mailed to the customer from the asker, the signer copied, the copy attached.
    const last = defined(mail.sent.at(-1));
    observed.push({
      String: String(last.subject),
      stringify: JSON.stringify(last.from).includes(asker.email),
      String2: String(last.to).includes("cas@example.org"),
      stringify2: JSON.stringify(last).includes("Contract (signed).pdf"),
    });

    // The customer downloads it while their pass lasts.
    observedSubsets.push(
      await customerPage(
        mail.env,
        db,
        visitor(`/s/sign/${token}`, {}, cookie),
        token
      )
    );

    expect(observedSubsets).toMatchObject([
      // customerPage(mail.env, db, visitor(`/s/sign/${token}`), token)
      {
        state: "confirm",
        email: "c•••@example.org",
        from: "sg-flow Asker",
      },
      // page
      {
        state: "sign",
        pageCount: 2,
        values: { "r-title": "Director" },
      },
      // customerPage(mail.env, db, visitor(`/s/sign/${token}`, {}, cookie), token)
      {
        state: "signed",
      },
      // view.values
      {
        "c-name": "Cas Customer",
        "c-ok": "yes",
        "r-title": "Director",
      },
      // filed
      {
        name: "Contract (signed).pdf",
        parentId: file.parentId,
        userId: asker.id,
      },
      // customerPage(mail.env, db, visitor(`/s/sign/${token}`, {}, cookie), token)
      {
        state: "completed",
      },
    ]);

    const { status: documentStatus } = await customerDocument(
      mail.env,
      db,
      visitor("/x", {}, cookie),
      token,
      true
    );

    observed.push(documentStatus);

    expect(observed).toStrictEqual([
      // status
      404,
      // { status: doc.status, contentType: doc.headers.get("content-type"), }
      { status: 200, contentType: "application/pdf" },
      // (await rejection(signForRivi(mail.env, db, colleague, request.id, SIGNATURE, origin)))?...
      true,
      // res.json()
      {
        ok: false,
        error: "Confirm that you agree to sign electronically.",
      },
      // res.json()
      {
        ok: false,
        error: 'Fill in "Full name".',
      },
      // Boolean(((await res.json()) as { ok: boolean }).ok)
      false,
      // res.json()
      { ok: true },
      // res.status
      409,
      // mail.sent.slice(before).map((m) => String(m.to))
      [colleague.email],
      // (await rejection(signForRivi(mail.env, db, asker, request.id, SIGNATURE, origin)))?.mes...
      true,
      // view.state
      "completed",
      // { rDate: /^\d{4}-\d{2}-\d{2}$/u.test(view.values["r-date"]), eventsMap: view.events.map...
      {
        rDate: true,
        eventsMap: [
          "created",
          "sent",
          "code-sent",
          "confirmed",
          "customer-signed",
          "signed",
          "completed",
        ],
      },
      // /^203\.0\.113\./u.test(view.events.find((e) => e.kind === "customer-signed")?.ip)
      true,
      // { digest, getPageCount: load.getPageCount() >= 3, }
      { digest: view.signedSha256, getPageCount: true },
      // { String: String(last.subject), stringify: JSON.stringify(last.from).includes(asker.ema...
      {
        String: "Signed: Contract.pdf",
        stringify: true,
        String2: true,
        stringify2: true,
      },
      // documentStatus
      200,
    ]);
  });

  it("signs for the workspace at once with the asker's saved signature when they chose to", async () => {
    const asker = await mailbox("sg-auto", "Auto Asker");
    await saveHandSignature(db, asker.id, `data:image/png;base64,${SIGNATURE}`);
    const { mail, request, token } = await sent("sg-auto", { autoSign: true });
    const cookie = await confirmed(token, mail.env, mail.sent);

    const res = await postJson(mail.env, token, cookie, {
      intent: "sign",
      values: { "c-name": "Cas", "c-ok": "yes" },
      signature: SIGNATURE,
      agree: true,
    });

    await expect(res.json()).resolves.toStrictEqual({ ok: true });

    const view = defined(
      await signingRequestView(mail.env, db, asker.id, request.id)
    );

    expect(view.state).toBe("completed");
    expect(view.events.map((e) => e.kind)).toContain("auto-signed");
    expect(view.signerSignature).toBe(SIGNATURE);
  });

  it("leaves it to the signer when the saved signature is gone by the time the customer signs", async () => {
    const asker = await mailbox("sg-auto-gone", "Gone Asker");
    await saveHandSignature(db, asker.id, SIGNATURE);

    const { mail, request, token } = await sent("sg-auto-gone", {
      autoSign: true,
    });

    const { deleteHandSignature } = await import("~/lib/drive/signing.server");
    await deleteHandSignature(db, asker.id);
    const cookie = await confirmed(token, mail.env, mail.sent);
    await postJson(mail.env, token, cookie, {
      intent: "sign",
      values: { "c-name": "Cas", "c-ok": "yes" },
      signature: SIGNATURE,
      agree: true,
    });

    const view = defined(
      await signingRequestView(mail.env, db, asker.id, request.id)
    );

    expect(view.state).toBe("awaiting-rivi");
    expect(view.myTurn).toBeTruthy();
    expect(view.events.map((e) => e.kind)).toContain("auto-sign-failed");
    await signForRivi(mail.env, db, asker, request.id, SIGNATURE, origin);
    expect(
      defined(await signingRequestView(mail.env, db, asker.id, request.id))
        .state
    ).toBe("completed");
  });

  it("takes the workspace's signature back when the signed copy cannot be kept, so the signer can sign again", async () => {
    const asker = await mailbox("sg-auto-keep", "Keep Asker");
    await saveHandSignature(db, asker.id, SIGNATURE);

    const { mail, request, token } = await sent("sg-auto-keep", {
      autoSign: true,
    });

    const cookie = await confirmed(token, mail.env, mail.sent);

    // The bucket takes the original's reads and Drive's files, but not the signed copy kept with the request.
    const drive = bucketRefusing(env.DRIVE, (key) =>
      key.endsWith("/signed.pdf")
    );

    const res = await postJson({ ...mail.env, DRIVE: drive }, token, cookie, {
      intent: "sign",
      values: { "c-name": "Cas", "c-ok": "yes" },
      signature: SIGNATURE,
      agree: true,
    });

    await expect(res.json()).resolves.toStrictEqual({ ok: true });

    const view = defined(
      await signingRequestView(mail.env, db, asker.id, request.id)
    );

    expect({
      state: view.state,
      myTurn: view.myTurn,
      eventsMap: view.events.map((e) => e.kind),
    }).toStrictEqual({
      state: "awaiting-rivi",
      myTurn: true,
      eventsMap: expect.arrayContaining(["auto-signed", "complete-failed"]),
    });
    // Taken back before anything was filed: no signed copy in Drive.
    await expect(signedCopiesOf(asker.id)).resolves.toHaveLength(0);
    await signForRivi(mail.env, db, asker, request.id, SIGNATURE, origin);
    expect(
      defined(await signingRequestView(mail.env, db, asker.id, request.id))
        .state
    ).toBe("completed");
    await expect(signedCopiesOf(asker.id)).resolves.toHaveLength(1);
  });

  it("completes when the signed copy cannot be filed in Drive, and keeps it with the request", async () => {
    const asker = await mailbox("sg-file-fails", "File Asker");
    const { mail, request, token } = await sent("sg-file-fails");
    const cookie = await confirmed(token, mail.env, mail.sent);
    await postJson(mail.env, token, cookie, {
      intent: "sign",
      values: { "c-name": "Cas", "c-ok": "yes" },
      signature: SIGNATURE,
      agree: true,
    });

    // The bucket keeps the request's copies, but Drive's own files cannot be written.
    const drive = bucketRefusing(env.DRIVE, (key) => key.startsWith("drive/"));

    await signForRivi(
      { ...mail.env, DRIVE: drive },
      db,
      asker,
      request.id,
      SIGNATURE,
      origin
    );

    const view = defined(
      await signingRequestView(mail.env, db, asker.id, request.id)
    );

    expect(view).toMatchObject({ state: "completed", signedNodeId: null });
    expect(view.events.map((e) => e.kind)).toStrictEqual(
      expect.arrayContaining(["completed", "file-failed"])
    );
    await expect(signedCopiesOf(asker.id)).resolves.toHaveLength(0);

    const document = await signingDocument(
      mail.env,
      db,
      asker.id,
      request.id,
      true
    );

    expect(document?.status).toBe(200);
    expect(String(defined(mail.sent.at(-1)).subject)).toBe(
      "Signed: Contract.pdf"
    );
  });

  it("declines with a reason, and the asker hears of it", async () => {
    const { asker, mail, request, token } = await sent("sg-decline");
    const cookie = await confirmed(token, mail.env, mail.sent);

    const res = await postJson(mail.env, token, cookie, {
      intent: "decline",
      reason: "Wrong amount.",
    });

    await expect(res.json()).resolves.toStrictEqual({ ok: true });
    expect(String(defined(mail.sent.at(-1)).to)).toBe(asker.email);
    expect(String(defined(mail.sent.at(-1)).text)).toContain("Wrong amount.");

    const view = defined(
      await signingRequestView(mail.env, db, asker.id, request.id)
    );

    expect(view).toMatchObject({
      state: "declined",
      declineReason: "Wrong amount.",
      canCancel: false,
    });
    await expect(
      customerPage(mail.env, db, visitor(`/s/sign/${token}`, {}, cookie), token)
    ).resolves.toMatchObject({
      state: "ended",
      why: "declined",
    });
  });

  it("stops at a cancel, an expiry, a wrong code too often and a post from another site", async () => {
    const observed: unknown[] = [];

    const { asker, mail, request, token } = await sent("sg-stop");

    await customerPost(
      mail.env,
      db,
      visitor("/x", { method: "POST", body: form({ intent: "send-code" }) }),
      token
    );

    const [code] = defined(
      String(defined(mail.sent.at(-1)).subject).match(/\d{6}/u)
    );

    const wrong = code === "000000" ? "111111" : "000000";

    for (let i = 0; i < 5; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each wrong code takes one of the five tries on the request, which the next reads
      await customerPost(
        mail.env,
        db,
        visitor("/x", {
          method: "POST",
          body: form({ intent: "code", code: wrong }),
        }),
        token
      );
    }

    // Five wrong tries spend the code: the right one no longer works.
    const late = await customerPost(
      mail.env,
      db,
      visitor("/x", { method: "POST", body: form({ intent: "code", code }) }),
      token
    );

    observed.push(
      late.headers.get("set-cookie"),
      late.headers.get("location")?.includes("error=code")
    );

    const cross = await customerPost(
      mail.env,
      db,
      visitor("/x", {
        method: "POST",
        body: JSON.stringify({ intent: "decline" }),
        headers: {
          "content-type": "application/json",
          "sec-fetch-site": "cross-site",
        },
      }),
      token
    );

    observed.push(
      cross.status,
      await rejectionIncludes(
        remindCustomer(mail.env, db, asker, request.id, origin),
        "within the hour"
      )
    );
    await remindCustomer(
      mail.env,
      db,
      asker,
      request.id,
      origin,
      Date.now() + 2 * 3_600_000
    );
    observed.push(String(defined(mail.sent.at(-1)).subject));

    const ended = Date.parse(request.expiresAt) + 1;
    observed.push(
      signingState({ status: "sent", expiresAt: request.expiresAt }, ended),
      // The customer's signature stands past the end: the workspace can still sign.
      signingState(
        { status: "customer-signed", expiresAt: request.expiresAt },
        ended
      )
    );
    await cancelSigningRequest(db, asker, request.id, origin);
    await expect(
      customerPage(mail.env, db, visitor(`/s/sign/${token}`), token)
    ).resolves.toMatchObject({
      state: "ended",
      why: "cancelled",
    });
    observed.push(
      await rejectionIncludes(
        cancelSigningRequest(db, asker, request.id, origin),
        "not open"
      )
    );
    // Nobody else sees the request.
    const stranger = await mailbox("sg-stop-stranger");
    observed.push({
      signingRequestView: await signingRequestView(
        env,
        db,
        stranger.id,
        request.id
      ),
      signingDocument: await signingDocument(
        env,
        db,
        stranger.id,
        request.id,
        false
      ),
    });

    expect(observed).toStrictEqual([
      // late.headers.get("set-cookie")
      null,
      // late.headers.get("location").includes("error=code")
      true,
      // cross.status
      403,
      // (await rejection(remindCustomer(mail.env, db, asker, request.id, origin)))?.message.inc...
      true,
      // String(defined(mail.sent.at(-1)).subject)
      'Reminder: Please sign "Contract.pdf"',
      // signingState({ status: "sent", expiresAt: request.expiresAt }, ended)
      "expired",
      // signingState( { status: "customer-signed", expiresAt: request.expiresAt }, ended )
      "awaiting-rivi",
      // (await rejection(cancelSigningRequest(db, asker, request.id, origin)))?.message.include...
      true,
      // { signingRequestView: await signingRequestView( env, db, stranger.id, request.id ), sig...
      { signingRequestView: null, signingDocument: null },
    ]);
  });

  it("ends a pass made while the request waits for the customer at its expiry, and lets them in again after they signed", async () => {
    const { mail, request, token } = await sent("sg-late");
    const expiry = Date.parse(request.expiresAt);
    const page = `/s/sign/${token}`;

    /** The customer through the code at `at`: their pass, and how long their browser keeps it. */
    const confirmAt = async (at: number) => {
      await customerPost(
        mail.env,
        db,
        visitor(page, { method: "POST", body: form({ intent: "send-code" }) }),
        token,
        at
      );

      const [code] = defined(
        String(defined(mail.sent.at(-1)).subject).match(/\d{6}/u)
      );

      const done = await customerPost(
        mail.env,
        db,
        visitor(page, { method: "POST", body: form({ intent: "code", code }) }),
        token,
        at
      );

      const cookie = defined(done.headers.get("set-cookie"));

      return {
        cookie: defined(cookie.split(";")[0]),
        maxAge: cookie.match(/Max-Age=(?<seconds>\d+)/u)?.groups?.seconds,
      };
    };

    const stateAt = async (cookie: string, at: number) => {
      const shown = await customerPage(
        mail.env,
        db,
        visitor(page, {}, cookie),
        token,
        at
      );

      return shown?.state;
    };

    // Confirmed an hour before the request expires: the pass lasts that hour, not 24.
    const early = await confirmAt(expiry - HOUR);
    const opened = await stateAt(early.cookie, expiry - HOUR + 60_000);

    const signed = await customerPost(
      mail.env,
      db,
      visitor(
        page,
        {
          method: "POST",
          body: JSON.stringify({
            intent: "sign",
            values: { "c-name": "Cas Customer", "c-ok": "yes" },
            signature: SIGNATURE,
            agree: true,
          }),
          headers: { "content-type": "application/json" },
        },
        early.cookie
      ),
      token,
      expiry - HOUR + 120_000
    );

    // Past the expiry the signed request waits for the workspace and the customer may still open it, but not with
    // that pass.
    const after = await stateAt(early.cookie, expiry + 60_000);

    const { status: documentStatus } = await customerDocument(
      mail.env,
      db,
      visitor("/x", {}, early.cookie),
      token,
      false,
      expiry + 60_000
    );

    // A new code lets them in again, for 24 hours: a request they signed has no end of its own.
    const again = await confirmAt(expiry + 120_000);

    expect({
      maxAge: early.maxAge,
      opened,
      signed: await signed.json(),
      after,
      documentStatus,
      maxAgeAgain: again.maxAge,
      again: await stateAt(again.cookie, expiry + 180_000),
    }).toStrictEqual({
      maxAge: "3600",
      opened: "sign",
      signed: { ok: true },
      after: "confirm",
      documentStatus: 404,
      maxAgeAgain: "86400",
      again: "signed",
    });
  });

  it("takes the code's forms from its own page or from no browser, never from another site", async () => {
    const { mail, token } = await sent("sg-origin");
    const { origin: appOrigin } = new URL(env.APP_URL);
    const before = mail.sent.length;

    const post = async (headers: Record<string, string>) => {
      const res = await customerPost(
        mail.env,
        db,
        visitor(`/s/sign/${token}`, {
          method: "POST",
          body: form({ intent: "send-code" }),
          headers,
        }),
        token
      );

      return {
        status: res.status,
        location: res.headers.get("location"),
        mailed: mail.sent.length - before,
      };
    };

    expect([
      await post({ "sec-fetch-site": "cross-site" }),
      // Only a person typing an address sends `none`; no form or script on a page does.
      await post({ "sec-fetch-site": "none" }),
      await post({ origin: "https://elsewhere.example" }),
      await post({ "sec-fetch-site": "same-origin" }),
      await post({ origin: appOrigin }),
      await post({}),
    ]).toStrictEqual([
      { status: 403, location: null, mailed: 0 },
      { status: 403, location: null, mailed: 0 },
      { status: 403, location: null, mailed: 0 },
      { status: 303, location: `/s/sign/${token}?step=code`, mailed: 1 },
      { status: 303, location: `/s/sign/${token}?step=code`, mailed: 2 },
      { status: 303, location: `/s/sign/${token}?step=code`, mailed: 3 },
    ]);
  });

  it("answers an unknown token with nothing", async () => {
    await expect(
      customerPage(env, db, visitor("/s/sign/nope"), "nope")
    ).resolves.toBeNull();
  });
});

/** The operators of a page's contents or a form XObject, as text. */
const operatorsOf = (
  doc: PDFDocument,
  contents: PDFObject | undefined
): string => {
  const resolved =
    contents instanceof PDFArray
      ? contents.asArray().map((ref) => doc.context.lookup(ref))
      : [contents instanceof PDFRef ? doc.context.lookup(contents) : contents];

  return resolved
    .map((stream) =>
      stream instanceof PDFRawStream
        ? Array.from(decodePDFRawStream(stream).decode(), (b) =>
            String.fromCodePoint(b)
          ).join("")
        : ""
    )
    .join("\n");
};

/** How the standard fonts write `text` in a content stream: its bytes in hex. */
const hexOf = (text: string): string =>
  `<${Array.from(text, (c) =>
    defined(c.codePointAt(0)).toString(16).toUpperCase().padStart(2, "0")
  ).join("")}>`;

/** The texts a content stream writes in hex. */
const hexTexts = (ops: string): string[] =>
  [...ops.matchAll(/<(?<hex>[0-9A-Fa-f]*)>\s*Tj/gu)].map(([, hex]) =>
    (hex?.match(/../gu) ?? [])
      .map((h) => String.fromCodePoint(Number.parseInt(h, 16)))
      .join("")
  );

/** Each line of text drawn in a pdf-lib PDF, with its page, in drawing order; standard fonts write it as hex. */
describe("the signed copy", () => {
  it("draws the fields on turned pages too, and adds the certificate", async () => {
    await Promise.all(
      [0, 90, 180, 270].map(async (rotate) => {
        const bytes = await signedPdf({
          original: await pdfBytes(2, rotate),
          fields: FIELDS,
          values: {
            "c-name": "Zoë Ünïcode 名前",
            "c-ok": "yes",
            "c-date": "2026-10-30",
            "r-title": "Director",
            "r-date": "2026-10-30",
          },
          signatures: {
            customer: Uint8Array.from(atob(SIGNATURE), (c) =>
              defined(c.codePointAt(0))
            ),
            rivi: Uint8Array.from(atob(SIGNATURE), (c) =>
              defined(c.codePointAt(0))
            ),
          },
          certificate: {
            appName: "Workspace",
            requestId: "sr_test",
            documentName: "Contract.pdf",
            pageCount: 2,
            originalSha256: "a".repeat(64),
            sentBy: "Asker <asker@rivi.software>",
            sentAt: "2026-10-30T10:00:00.000Z",
            signers: [],
            events: Array.from({ length: 80 }, (_, i) => ({
              at: "2026-10-30T10:00:00.000Z",
              what: "Code mailed to the customer",
              who: `Cas <cas@example.org> ${i}`,
              ip: "203.0.113.1",
            })),
          },
        });

        const doc = await PDFDocument.load(bytes);
        // Two pages, and a certificate long enough to need more than one.
        expect(doc.getPageCount()).toBeGreaterThan(3);
      })
    );
  });

  it("starts both columns of a certificate row on one page", async () => {
    const signature = Uint8Array.from(atob(SIGNATURE), (c) =>
      defined(c.codePointAt(0))
    );

    const labels = new Set([
      "Name",
      "Email",
      "Signed",
      "How",
      "IP address",
      "Browser",
    ]);

    const shifts = Array.from({ length: 15 }, (_, shift) => shift);

    // Each longer document name moves every row below it down a line, so some row meets each page's end.
    await Promise.all(
      shifts.map(async (shift) => {
        const doc = await PDFDocument.load(
          await signedPdf({
            original: await pdfBytes(1),
            fields: [],
            values: {},
            signatures: { customer: signature, rivi: signature },
            certificate: {
              appName: "Workspace",
              requestId: "sr_test",
              documentName: [
                "Contract.pdf",
                ...Array.from({ length: shift }, () => "x".repeat(60)),
              ].join(" "),
              pageCount: 1,
              originalSha256: "a".repeat(64),
              sentBy: "Asker <asker@rivi.software>",
              sentAt: "2026-10-30T10:00:00.000Z",
              signers: Array.from({ length: 6 }, (_, i) => ({
                role: `Signer ${i}`,
                name: `Signer ${i}`,
                email: `signer-${i}@example.org`,
                signedAt: "2026-10-30T11:00:00.000Z",
                how: "Signed on the request's page",
                ip: "203.0.113.1",
                userAgent:
                  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
                signature,
              })),
              events: Array.from({ length: 60 }, (_, i) => ({
                at: new Date(Date.UTC(2026, 9, 30, 10, i)).toISOString(),
                what: "Code mailed to the customer",
                who: `Cas <cas@example.org> ${i}`,
                ip: null,
              })),
            },
          })
        );

        const drawn = drawnText(doc);
        const events = drawn.findIndex((d) => d.text === "What happened");
        expect(events).toBeGreaterThan(0);
        const split: string[] = [];

        for (const [i, d] of drawn.entries()) {
          const left =
            i < events ? labels.has(d.text) : d.text.endsWith(" UTC");

          if (left && drawn[i + 1]?.page !== d.page) {
            split.push(`${d.text} (shift ${shift})`);
          }
        }

        expect(split).toStrictEqual([]);
      })
    );
  });

  it("paints a fillable original's own fields under the values, and leaves no form to type into", async () => {
    const original = await PDFDocument.create();
    const page = original.addPage([595, 842]);
    original.addPage([595, 842]);
    const pdfForm = original.getForm();
    // The form's own grey box where FIELDS puts the customer's name, as the fillable contract that hid every value had.
    pdfForm.createTextField("name").addToPage(page, {
      x: 0.1 * 595,
      y: 0.27 * 842,
      width: 0.3 * 595,
      height: 0.03 * 842,
      backgroundColor: rgb(0.96, 0.96, 0.97),
      borderWidth: 0,
    });
    // Filled in before it was sent, its look left to the viewer.
    const company = pdfForm.createTextField("company");
    company.setText("Acme");
    company.addToPage(page, { x: 300, y: 500, width: 200, height: 20 });

    for (const widget of company.acroField.getWidgets()) {
      widget.dict.delete(PDFName.of("AP"));
    }

    // A field no viewer shows.
    const hidden = pdfForm.createTextField("hidden");
    hidden.setText("Secret");
    hidden.addToPage(page, {
      x: 300,
      y: 400,
      width: 200,
      height: 20,
      hidden: true,
    });

    const signature = Uint8Array.from(atob(SIGNATURE), (c) =>
      defined(c.codePointAt(0))
    );

    const doc = await PDFDocument.load(
      await signedPdf({
        original: await original.save({ updateFieldAppearances: false }),
        fields: FIELDS,
        values: {
          "c-name": "Cas Customer",
          "c-ok": "yes",
          "c-date": "2026-11-04",
          "r-title": "Director",
          "r-date": "2026-11-04",
        },
        signatures: { customer: signature, rivi: signature },
        certificate: {
          appName: "Workspace",
          requestId: "sr_test",
          documentName: "Contract.pdf",
          pageCount: 2,
          originalSha256: "a".repeat(64),
          sentBy: "Asker <asker@rivi.software>",
          sentAt: "2026-11-04T10:00:00.000Z",
          signers: [],
          events: [],
        },
      })
    );

    const first = doc.getPage(0);
    const ops = operatorsOf(doc, first.node.Contents());

    const painted = [
      ...(first.node
        .Resources()
        ?.lookup(PDFName.of("XObject"), PDFDict)
        .entries() ?? []),
    ].flatMap(([key, ref]) =>
      key.decodeText().startsWith("FormField")
        ? [hexTexts(operatorsOf(doc, ref)).join(" ")]
        : []
    );

    const widgets = doc
      .getPages()
      .flatMap((p) => p.node.Annots()?.asArray() ?? [])
      .filter(
        (ref) =>
          doc.context.lookup(ref, PDFDict).lookup(PDFName.of("Subtype")) ===
          PDFName.of("Widget")
      );

    expect({
      form: doc.catalog.has(PDFName.of("AcroForm")),
      widgets: widgets.length,
      painted,
      // The name is drawn after the box that covered it, so over it.
      nameOverBox:
        ops.search(/\/FormField\S* Do/u) >= 0 &&
        ops.search(/\/FormField\S* Do/u) < ops.indexOf(hexOf("Cas Customer")),
    }).toStrictEqual({
      form: false,
      widgets: 0,
      painted: ["", "Acme"],
      nameOverBox: true,
    });
  });
});
