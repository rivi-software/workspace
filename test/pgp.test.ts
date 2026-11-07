import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import * as openpgp from "openpgp";
import type { PrivateKey, PublicKey } from "openpgp";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { attachments, drafts, messages, pgpKeys } from "~/db/schema";
import type { User } from "~/db/schema";
import { ingestInboundEmail, parseRawEmail } from "~/lib/mail/ingest.server";
import { parseAutocrypt } from "~/lib/mail/pgp/autocrypt";
import {
  PgpError,
  exportOwnKey,
  generateOwnKey,
  importOwnKey,
  importPeerKeys,
  ownKeyView,
  peerKeyRow,
  removeOwnKey,
} from "~/lib/mail/pgp/keys.server";
import { multipartParts, splitEntity } from "~/lib/mail/pgp/mime";
import { parsePgpStatus } from "~/lib/mail/pgp/pgp";
import { recheckPgpMessage } from "~/lib/mail/pgp/recheck.server";
import { wkdHash } from "~/lib/mail/pgp/wkd.server";
import {
  SendError,
  checkComposed,
  saveDraft,
  sendMail,
} from "~/lib/mail/send.server";

import {
  db,
  defined,
  mailbox,
  recordingEmail,
  rejection,
  rejectionIncludes,
} from "./fixtures";
import { stubEnv } from "./stub-env";

const domain = env.MAIL_DOMAIN;
const CRLF = "\r\n";

/** Someone outside the workspace with a key of their own. */
const outsider = async (email: string, passphrase?: string) =>
  await openpgp.generateKey({
    type: "ecc",
    curve: "curve25519Legacy",
    userIDs: [{ name: email.split("@")[0], email }],
    passphrase,
    format: "object",
  });

const urlOf = (input: RequestInfo | URL): string =>
  input instanceof Request ? input.url : String(input);

/** A WKD that knows nobody, counting what it is asked. */
const noWkd = () => {
  const asked: string[] = [];

  const fetcher: typeof fetch = (input) => {
    asked.push(urlOf(input));

    return Promise.resolve(new Response("Not found", { status: 404 }));
  };

  return { asked, fetcher };
};

/** A mailbox's own public key, as a correspondent would have it. */
const ownPublicKey = async (user: User): Promise<PublicKey> => {
  const row = defined(
    await db.query.pgpKeys.findFirst({ where: eq(pgpKeys.userId, user.id) })
  );

  return await openpgp.readKey({ armoredKey: row.publicKey });
};

/** The headers every hand-written message here starts with. */
const envelope = (o: {
  from: string;
  to: string;
  subject: string;
  extra?: string[];
}) => [
  ...(o.extra ?? []),
  `From: ${o.from}`,
  `To: ${o.to}`,
  `Subject: ${o.subject}`,
  `Message-ID: <${crypto.randomUUID()}@acme.com>`,
  `Date: ${new Date().toUTCString()}`,
  "MIME-Version: 1.0",
];

/** A PGP/MIME signed message (RFC 3156 §5) as another mail client writes one; `tamper` changes the part after signing. */
const signedMail = async (o: {
  from: string;
  to: string;
  subject: string;
  body: string;
  key: PrivateKey;
  tamper?: (part: string) => string;
}) => {
  const part = [
    'Content-Type: text/plain; charset="utf-8"',
    "",
    o.body,
    "",
  ].join(CRLF);

  const signature = await openpgp.sign({
    message: await openpgp.createMessage({
      binary: new TextEncoder().encode(part),
    }),
    signingKeys: o.key,
    detached: true,
  });

  return [
    ...envelope(o),
    'Content-Type: multipart/signed; micalg=pgp-sha512; protocol="application/pgp-signature"; boundary="sig"',
    "",
    "--sig",
    o.tamper ? o.tamper(part) : part,
    "--sig",
    'Content-Type: application/pgp-signature; name="signature.asc"',
    "",
    signature,
    "--sig--",
    "",
  ].join(CRLF);
};

/** A PGP/MIME encrypted message (RFC 3156 §4) with protected headers and a file inside, signed when `signWith` is given. */
const encryptedMail = async (o: {
  from: string;
  to: string;
  subject: string;
  body: string;
  encryptTo: PublicKey;
  signWith?: PrivateKey;
}) => {
  const inner = [
    'Content-Type: multipart/mixed; boundary="inner"; protected-headers="v1"',
    `Subject: ${o.subject}`,
    "",
    "--inner",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    o.body,
    "--inner",
    'Content-Type: text/plain; name="notes.txt"',
    'Content-Disposition: attachment; filename="notes.txt"',
    "",
    "the file inside",
    "--inner--",
    "",
  ].join(CRLF);

  const encrypted = await openpgp.encrypt({
    message: await openpgp.createMessage({
      binary: new TextEncoder().encode(inner),
    }),
    encryptionKeys: o.encryptTo,
    signingKeys: o.signWith,
  });

  return [
    ...envelope({ ...o, subject: "..." }),
    'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="enc"',
    "",
    "--enc",
    "Content-Type: application/pgp-encrypted",
    "",
    "Version: 1",
    "--enc",
    'Content-Type: application/octet-stream; name="encrypted.asc"',
    "",
    encrypted,
    "--enc--",
    "",
  ].join(CRLF);
};

/** A plain-text message with a body made elsewhere (an inline block). */
const textMail = (o: {
  from: string;
  to: string;
  subject: string;
  body: string;
  extra?: string[];
}) => [...envelope(o), "Content-Type: text/plain", "", o.body].join(CRLF);

/** Deliver a raw message to a mailbox as Email Routing would, and read back what was filed. */
const deliver = async (
  raw: string,
  to: User,
  fetcher: typeof fetch = noWkd().fetcher
) => {
  const bytes = new TextEncoder().encode(raw);
  const parsed = await parseRawEmail(bytes.buffer, "someone@acme.com");

  const result = await ingestInboundEmail(env, bytes.buffer, parsed, to.email, {
    fetch: fetcher,
  });

  if (result.status !== "stored") {
    throw new Error(`Not stored: ${result.status}`);
  }

  const message = defined(
    await db.query.messages.findFirst({
      where: eq(messages.id, result.messageId),
    })
  );

  const files = await db.query.attachments.findMany({
    where: eq(attachments.messageId, message.id),
  });

  return { message, pgp: parsePgpStatus(message.pgpJson), files };
};

const sesEnv = (base: Env): Env => ({
  ...base,
  SES_REGION: "eu-central-1",
  SES_ACCESS_KEY_ID: "AKIATESTKEY",
  SES_SECRET_ACCESS_KEY: "test-secret",
});

interface SesRawBody {
  Destination: { ToAddresses: string[] };
  Content: { Raw: { Data: string } };
}

/** Amazon SES, spied: the raw message each call carried, and its envelope. */
const spySes = () => {
  const calls: { raw: string; recipients: string[] }[] = [];

  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const body = await new Request(input, init).json<SesRawBody>();

      calls.push({
        raw: atob(body.Content.Raw.Data),
        recipients: body.Destination.ToAddresses,
      });

      return Response.json({ MessageId: `0107019a-${crypto.randomUUID()}` });
    });

  return { calls, spy };
};

describe("a person's own key", () => {
  it("is made for their address and aliases, sealed, exported locked, and made only once", async () => {
    const ava = await mailbox("ava", "Ava Key", [`hello@${domain}`]);
    await generateOwnKey(env, db, ava);
    const view = defined(await ownKeyView(db, ava.id));

    const row = defined(
      await db.query.pgpKeys.findFirst({ where: eq(pgpKeys.userId, ava.id) })
    );

    const exported = await exportOwnKey(env, db, ava.id, "a long passphrase");
    const locked = await openpgp.readPrivateKey({ armoredKey: exported });

    const unlocked = await openpgp.decryptKey({
      privateKey: locked,
      passphrase: "a long passphrase",
    });

    expect({
      addresses: view.addresses.toSorted(),
      sealed: row.privateKeySealed.startsWith("v1."),
      plain: row.privateKeySealed.includes("PRIVATE KEY"),
      exportedLocked: locked.isDecrypted(),
      sameKey: unlocked.getFingerprint() === view.fingerprint,
    }).toStrictEqual({
      addresses: [ava.email, `hello@${domain}`].toSorted(),
      sealed: true,
      plain: false,
      exportedLocked: false,
      sameKey: true,
    });

    const short = await rejection(exportOwnKey(env, db, ava.id, "short"));
    const twice = await rejection(generateOwnKey(env, db, ava));

    expect({
      short: short instanceof PgpError,
      twice: twice?.message.includes("already have a key"),
    }).toStrictEqual({ short: true, twice: true });
  });

  it("is imported with its passphrase, and refused locked, wrong, or for someone else", async () => {
    const ben = await mailbox("ben", "Ben Import");
    const { privateKey } = await outsider(ben.email, "ben's passphrase");
    const armored = privateKey.armor();
    const stranger = await outsider("ben@elsewhere.example");

    const refused = [
      await rejectionIncludes(
        importOwnKey(env, db, ben, armored, "wrong"),
        "passphrase does not unlock"
      ),
      await rejectionIncludes(
        importOwnKey(env, db, ben, stranger.privateKey.armor(), ""),
        "names none of your addresses"
      ),
    ];

    await importOwnKey(env, db, ben, armored, "ben's passphrase");
    const view = await ownKeyView(db, ben.id);

    expect({ refused, fingerprint: view?.fingerprint }).toStrictEqual({
      refused: [true, true],
      fingerprint: privateKey.getFingerprint(),
    });
  });
});

describe("mail that arrives with OpenPGP", () => {
  let cleo: User;
  let jane: Awaited<ReturnType<typeof outsider>>;

  beforeAll(async () => {
    cleo = await mailbox("cleo", "Cleo Reader");
    await generateOwnKey(env, db, cleo);
    jane = await outsider("jane@acme.com");
    await importPeerKeys(db, cleo.id, jane.publicKey.armor());
  });

  it("checks a PGP/MIME signature against the sender's key and files the signed part alone", async () => {
    const raw = await signedMail({
      from: "Jane <jane@acme.com>",
      to: cleo.email,
      subject: "Signed hello",
      body: "Hello, signed.",
      key: jane.privateKey,
    });

    const { message, pgp, files } = await deliver(raw, cleo);

    expect({ text: message.text, files, pgp }).toMatchObject({
      text: "Hello, signed.",
      files: [],
      pgp: {
        format: "mime",
        encrypted: false,
        signature: {
          state: "good",
          source: "imported",
          fingerprint: jane.publicKey.getFingerprint(),
        },
      },
    });
  });

  it("calls a signature over a changed message bad", async () => {
    const raw = await signedMail({
      from: "jane@acme.com",
      to: cleo.email,
      subject: "Changed on the way",
      body: "Pay 10 euros.",
      key: jane.privateKey,
      tamper: (part) => part.replace("10", "1000"),
    });

    const { message, pgp } = await deliver(raw, cleo);

    expect({ text: message.text, state: pgp?.signature?.state }).toStrictEqual({
      text: "Pay 1000 euros.",
      state: "bad",
    });
  });

  it("finds an unknown sender's key over WKD and keeps it", async () => {
    const kim = await outsider("kim@wkd.example");
    const hash = await wkdHash("kim");
    const published = `https://openpgpkey.wkd.example/.well-known/openpgpkey/wkd.example/hu/${hash}?l=kim`;

    const wkd: typeof fetch = (input) =>
      Promise.resolve(
        urlOf(input) === published
          ? new Response(new Uint8Array(kim.publicKey.write()))
          : new Response("Not found", { status: 404 })
      );

    const raw = await signedMail({
      from: "kim@wkd.example",
      to: cleo.email,
      subject: "From WKD",
      body: "Find my key.",
      key: kim.privateKey,
    });

    const { pgp } = await deliver(raw, cleo, wkd);
    const kept = await peerKeyRow(db, cleo.id, "kim@wkd.example");

    expect({ signature: pgp?.signature, kept: kept?.source }).toMatchObject({
      signature: { state: "good", source: "wkd" },
      kept: "wkd",
    });
  });

  it("says when no key can check a signature, and asks the sender's domain once a day", async () => {
    const lou = await outsider("lou@nokeys.example");
    const signingKey = await lou.privateKey.getSigningKey();
    const none = noWkd();

    const raw = await signedMail({
      from: "lou@nokeys.example",
      to: cleo.email,
      subject: "No key anywhere",
      body: "Who am I?",
      key: lou.privateKey,
    });

    const { pgp } = await deliver(raw, cleo, none.fetcher);
    const askedFirst = none.asked.length;

    // The miss is remembered: the next message from the address does not ask its domain again.
    await deliver(
      raw.replace(/Message-ID: <[^>]+>/u, "Message-ID: <again@nokeys.example>"),
      cleo,
      none.fetcher
    );

    expect({
      signature: pgp?.signature,
      askedFirst,
      askedAfter: none.asked.length,
    }).toMatchObject({
      signature: {
        state: "unknown-key",
        keyId: signingKey.getKeyID().toHex(),
        fingerprint: null,
      },
      askedFirst: 2,
      askedAfter: 2,
    });
  });

  it("opens what was encrypted to the mailbox: the text, the protected subject, the file and the signature", async () => {
    const raw = await encryptedMail({
      from: "jane@acme.com",
      to: cleo.email,
      subject: "The real subject",
      body: "Only for Cleo.",
      encryptTo: await ownPublicKey(cleo),
      signWith: jane.privateKey,
    });

    const { message, pgp, files } = await deliver(raw, cleo);

    expect({
      subject: message.subject,
      text: message.text,
      files: files.map((f) => f.filename),
      pgp,
    }).toMatchObject({
      subject: "The real subject",
      text: "Only for Cleo.",
      files: ["notes.txt"],
      pgp: {
        format: "mime",
        encrypted: true,
        decrypted: true,
        signature: { state: "good", source: "imported" },
      },
    });
  });

  it("opens inline blocks: a cleartext signature and an encrypted body", async () => {
    const cleartext = await openpgp.sign({
      message: await openpgp.createCleartextMessage({ text: "Signed inline." }),
      signingKeys: jane.privateKey,
    });

    const armored = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: "Encrypted inline." }),
      encryptionKeys: await ownPublicKey(cleo),
    });

    const from = "jane@acme.com";

    const signed = await deliver(
      textMail({
        from,
        to: cleo.email,
        subject: "Inline signed",
        body: cleartext,
      }),
      cleo
    );

    const encrypted = await deliver(
      textMail({
        from,
        to: cleo.email,
        subject: "Inline encrypted",
        body: armored,
      }),
      cleo
    );

    expect({
      signed: { text: signed.message.text.trim(), pgp: signed.pgp },
      encrypted: { text: encrypted.message.text.trim(), pgp: encrypted.pgp },
    }).toMatchObject({
      signed: {
        text: "Signed inline.",
        pgp: { format: "inline", signature: { state: "good" } },
      },
      encrypted: {
        text: "Encrypted inline.",
        pgp: {
          format: "inline",
          encrypted: true,
          decrypted: true,
          signature: null,
        },
      },
    });
  });

  it("keeps what stays shut as it came, and opens it on Check again once the key is back", async () => {
    const dot = await mailbox("dot", "Dot Later");
    await generateOwnKey(env, db, dot);
    const publicKey = await ownPublicKey(dot);
    const exported = await exportOwnKey(env, db, dot.id, "dot's passphrase");
    await removeOwnKey(db, dot.id);

    const raw = await encryptedMail({
      from: "jane@acme.com",
      to: dot.email,
      subject: "For later",
      body: "Readable once the key is back.",
      encryptTo: publicKey,
    });

    const shut = await deliver(raw, dot);

    expect({
      pgp: shut.pgp,
      readable: shut.message.text.includes("Readable once"),
    }).toMatchObject({
      pgp: {
        encrypted: true,
        decrypted: false,
        error: expect.stringContaining("no OpenPGP key"),
      },
      readable: false,
    });

    await importOwnKey(env, db, dot, exported, "dot's passphrase");

    const after = await recheckPgpMessage(env, db, dot, shut.message.id, {
      fetch: noWkd().fetcher,
    });

    const reread = defined(
      await db.query.messages.findFirst({
        where: eq(messages.id, shut.message.id),
      })
    );

    const files = await db.query.attachments.findMany({
      where: eq(attachments.messageId, reread.id),
    });

    expect({
      after,
      subject: reread.subject,
      text: reread.text,
      files: files.map((f) => f.filename),
    }).toMatchObject({
      after: { encrypted: true, decrypted: true },
      subject: "For later",
      text: "Readable once the key is back.",
      files: ["notes.txt"],
    });
  });

  it("learns a key from an Autocrypt header only when the message passed DKIM for the sender's domain", async () => {
    const ann = await outsider("ann@acme.com");
    const keydata = btoa(String.fromCodePoint(...ann.publicKey.write()));
    const autocrypt = `Autocrypt: addr=ann@acme.com; prefer-encrypt=mutual; keydata=${keydata}`;
    const to = cleo.email;
    const from = "ann@acme.com";

    await deliver(
      textMail({
        from,
        to,
        subject: "No checks",
        body: "Hi",
        extra: [autocrypt],
      }),
      cleo
    );

    const before = await peerKeyRow(db, cleo.id, from);

    await deliver(
      textMail({
        from,
        to,
        subject: "Checked",
        body: "Hi again",
        extra: [
          "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=acme.com header.s=s1; dmarc=pass header.from=acme.com; spf=pass smtp.mailfrom=ann@acme.com",
          "Received: from mail.acme.com (mail.acme.com [203.0.113.5]) by mx.cloudflare.net with ESMTP",
          autocrypt,
        ],
      }),
      cleo
    );

    const after = await peerKeyRow(db, cleo.id, from);

    expect({ before, after }).toMatchObject({
      before: undefined,
      after: {
        source: "autocrypt",
        preferEncrypt: true,
        fingerprint: ann.publicKey.getFingerprint(),
      },
    });
  });
});

describe("sending signed and encrypted mail", () => {
  let eve: User;
  let fay: User;
  let max: Awaited<ReturnType<typeof outsider>>;

  beforeAll(async () => {
    eve = await mailbox("eve", "Eve Sender");
    fay = await mailbox("fay", "Fay Colleague");
    await generateOwnKey(env, db, eve);
    await generateOwnKey(env, db, fay);
    max = await outsider("max@acme.com");
    await importPeerKeys(db, eve.id, max.publicKey.armor());
  });

  it("signs as RFC 3156 says, carries the key and Autocrypt through SES, and a colleague's copy checks out", async () => {
    const { calls, spy } = spySes();

    try {
      await sendMail(sesEnv(recordingEmail().env), db, eve, {
        from: eve.email,
        to: [{ email: fay.email, name: "Fay" }],
        cc: [],
        bcc: [{ email: "max@acme.com", name: null }],
        subject: "Signed from Eve",
        text: "Hello Fay.",
        files: [],
        pgp: { sign: true, encrypt: false },
      });
    } finally {
      spy.mockRestore();
    }

    const { raw, recipients } = defined(calls[0]);
    const top = splitEntity(raw);
    const boundary = defined(/boundary="(?<b>[^"]+)"/u.exec(raw)?.groups?.b);
    const [signed, signaturePart] = multipartParts(top.body, boundary);
    const eveKey = await ownPublicKey(eve);

    // The signature checks out over the first part's exact bytes, with nothing but the sender's public key.
    const verified = await openpgp.verify({
      message: await openpgp.createMessage({
        binary: new TextEncoder().encode(defined(signed)),
      }),
      signature: await openpgp.readSignature({
        armoredSignature: splitEntity(defined(signaturePart)).body,
      }),
      verificationKeys: eveKey,
    });

    await expect(
      defined(verified.signatures[0]).verified
    ).resolves.toBeTruthy();

    expect({
      recipients: recipients.toSorted(),
      bcc: /^Bcc:/imu.test(raw),
      autocrypt: /^Autocrypt: addr=eve@/mu.test(raw),
      type: top.headers.find((h) => h.name === "content-type")?.value,
      keyAttached: defined(signed).includes(
        `OpenPGP_0x${eveKey.getKeyID().toHex().toUpperCase()}.asc`
      ),
    }).toMatchObject({
      recipients: [fay.email, "max@acme.com"].toSorted(),
      bcc: false,
      autocrypt: true,
      type: expect.stringMatching(
        /^multipart\/signed; boundary="[^"]+"; micalg=pgp-sha512; protocol="application\/pgp-signature"$/u
      ),
      keyAttached: true,
    });

    const copy = await deliver(raw, fay);

    expect({
      text: copy.message.text,
      signature: copy.pgp?.signature,
      files: copy.files.map((f) => f.contentType),
    }).toMatchObject({
      text: "Hello Fay.",
      signature: { state: "good", source: "workspace" },
      files: ["application/pgp-keys"],
    });
  });

  it("encrypts to every recipient and the sender, hides the subject outside, and files the sent copy readable", async () => {
    const { calls, spy } = spySes();
    let sent: Awaited<ReturnType<typeof sendMail>>;

    try {
      sent = await sendMail(sesEnv(recordingEmail().env), db, eve, {
        from: eve.email,
        to: [{ email: "max@acme.com", name: "Max" }],
        cc: [{ email: fay.email, name: null }],
        bcc: [],
        subject: "Secret plans",
        text: "Meet at noon.",
        files: [
          {
            filename: "plan.txt",
            contentType: "text/plain",
            content: new TextEncoder().encode("the plan").buffer,
          },
        ],
        pgp: { sign: true, encrypt: true },
      });
    } finally {
      spy.mockRestore();
    }

    const { raw } = defined(calls[0]);

    const armored = raw.slice(
      raw.indexOf("-----BEGIN PGP MESSAGE-----"),
      raw.indexOf("-----END PGP MESSAGE-----") + 25
    );

    const opened = await openpgp.decrypt({
      message: await openpgp.readMessage({ armoredMessage: armored }),
      decryptionKeys: max.privateKey,
      verificationKeys: await ownPublicKey(eve),
      expectSigned: true,
    });

    expect({
      subjectHidden: /^Subject: \.\.\.$/mu.test(raw),
      leaks: raw.includes("Secret plans") || raw.includes("Meet at noon"),
      subjectInside: opened.data.includes("Subject: Secret plans"),
      protectedHeaders: opened.data.includes('protected-headers="v1"'),
    }).toStrictEqual({
      subjectHidden: true,
      leaks: false,
      subjectInside: true,
      protectedHeaders: true,
    });

    // Fay, on Cc, opens her copy with her own key. Signed too, the sender's key travels inside, for a reply.
    const copy = await deliver(raw, fay);

    expect({
      subject: copy.message.subject,
      text: copy.message.text,
      files: copy.files.map((f) => f.contentType),
      pgp: copy.pgp,
    }).toMatchObject({
      subject: "Secret plans",
      text: "Meet at noon.",
      files: ["text/plain", "application/pgp-keys"],
      pgp: { encrypted: true, decrypted: true, signature: { state: "good" } },
    });

    // The sender's own copy is filed as written.
    const own = defined(
      await db.query.messages.findFirst({
        where: eq(messages.id, sent.messageId),
      })
    );

    expect({
      subject: own.subject,
      pgp: parsePgpStatus(own.pgpJson),
    }).toMatchObject({
      subject: "Secret plans",
      pgp: { encrypted: true, signature: { state: "good" } },
    });
  });

  it("refuses to encrypt to someone without a key, and to sign without a key of one's own", async () => {
    const { sent, env: testEnv } = recordingEmail();
    const gus = await mailbox("gus", "Gus Nokey");

    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(noWkd().fetcher);

    let refused: Error | null;
    let unsigned: Error | null;

    try {
      refused = await rejection(
        sendMail(testEnv, db, eve, {
          from: eve.email,
          to: [{ email: "nokey@nowhere.example", name: null }],
          cc: [],
          bcc: [],
          subject: "x",
          text: "y",
          files: [],
          pgp: { sign: false, encrypt: true },
        })
      );

      unsigned = await rejection(
        checkComposed(testEnv, db, gus, {
          from: gus.email,
          to: { addresses: [{ email: fay.email, name: null }], invalid: [] },
          cc: { addresses: [], invalid: [] },
          bcc: { addresses: [], invalid: [] },
          subject: "x",
          text: "y",
          pgp: { sign: true, encrypt: false },
        })
      );
    } finally {
      spy.mockRestore();
    }

    expect({
      refused: refused instanceof SendError,
      words: refused?.message.includes(
        "no OpenPGP key for nokey@nowhere.example"
      ),
      unsigned: unsigned?.message.includes("Add your OpenPGP key"),
      sent,
    }).toStrictEqual({ refused: true, words: true, unsigned: true, sent: [] });
  });

  it("sends through the binding once per recipient when SES is not set up", async () => {
    const envelopes: string[] = [];

    // Raw mail reaches the binding as `cloudflare:email`'s `EmailMessage`, whose envelope is all a test can read.
    const binding = {
      send: (message: EmailMessage) => {
        envelopes.push(message.to);

        return Promise.resolve({
          messageId: `<${crypto.randomUUID()}@${domain}>`,
        });
      },
    };

    await sendMail(stubEnv({ ...env, EMAIL: binding }), db, eve, {
      from: eve.email,
      to: [{ email: fay.email, name: null }],
      cc: [{ email: "max@acme.com", name: null }],
      bcc: [],
      subject: "Two copies",
      text: "One each.",
      files: [],
      pgp: { sign: true, encrypt: false },
    });

    expect(envelopes.toSorted()).toStrictEqual(
      [fay.email, "max@acme.com"].toSorted()
    );
  });

  it("keeps the choice on a draft, for the cron to send as it was written", async () => {
    const draftId = await saveDraft(db, eve.id, {
      mode: "new",
      from: eve.email,
      to: [{ email: "max@acme.com", name: null }],
      cc: [],
      bcc: [],
      subject: "Later",
      text: "Signed and encrypted later.",
      pgp: { sign: true, encrypt: true },
    });

    await expect(
      db.query.drafts.findFirst({ where: eq(drafts.id, draftId) })
    ).resolves.toMatchObject({ pgpSign: true, pgpEncrypt: true });
  });
});

/** A request to the Worker's Web Key Directory. */
const at = (path: string) =>
  SELF.fetch(`${env.APP_URL}/.well-known/openpgpkey/${path}`);

describe("the Web Key Directory", () => {
  it("names a local part as the draft's example does", async () => {
    await expect(wkdHash("Joe.Doe")).resolves.toBe(
      "iy9q119eutrkn8s1mk4r39qejnbu3n5q"
    );
  });

  it("serves a person's key at the advanced and the direct path, and nothing it cannot match", async () => {
    const hal = await mailbox("hal", "Hal Published");
    await generateOwnKey(env, db, hal);
    // A mailbox without a key publishes nothing.
    await mailbox("ida", "Ida Unpublished");
    const hash = await wkdHash("hal");

    const advanced = await at(`${domain}/hu/${hash}?l=hal`);
    const direct = await at(`hu/${hash}?l=hal`);

    const key = await openpgp.readKey({
      binaryKey: new Uint8Array(await direct.arrayBuffer()),
    });

    const misses = await Promise.all([
      at(`hu/${hash}?l=other`),
      at(`hu/${hash}`),
      at(`hu/${await wkdHash("ida")}?l=ida`),
    ]);

    const policy = await at("policy");

    expect({
      advanced: advanced.status,
      direct: direct.status,
      cors: direct.headers.get("access-control-allow-origin"),
      names: key.users.map((u) => u.userID?.email),
      misses: misses.map((r) => r.status),
      policy: policy.status,
    }).toStrictEqual({
      advanced: 200,
      direct: 200,
      cors: "*",
      names: [hal.email],
      misses: [404, 404, 404],
      policy: 200,
    });
  });
});

describe("the Autocrypt header", () => {
  it("is read with its required attributes, and ignored with an unknown one", () => {
    expect([
      parseAutocrypt(
        "addr=Ann@Acme.com; prefer-encrypt=mutual; _future=1; keydata=AAEC"
      ),
      parseAutocrypt("addr=ann@acme.com; keydata=AAEC; color=blue"),
      parseAutocrypt("addr=ann@acme.com"),
    ]).toStrictEqual([
      {
        addr: "ann@acme.com",
        preferEncrypt: true,
        keydata: new Uint8Array([0, 1, 2]),
      },
      null,
      null,
    ]);
  });
});
