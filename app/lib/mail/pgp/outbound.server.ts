/**
 * A message the owner sends signed, encrypted or both, written out in full as PGP/MIME (RFC 3156) for
 * `sendRawMail`: the body and files in one entity with the protected headers inside it, then either signed
 * (`multipart/signed`, the owner's public key attached so a reply can be encrypted) or encrypted to every recipient
 * and the owner (`multipart/encrypted`, the subject outside it "..."). The send itself is `send.server.ts`'s.
 */
import type { PrivateKey, PublicKey } from "openpgp";

import type { Database } from "~/db";
import type { Address, User } from "~/db/schema";

import type { InlineImage } from "../signatures";
import { autocryptHeader } from "./autocrypt";
import { PgpError, ownPrivateKey } from "./keys.server";
import { recipientKeys } from "./lookup.server";
import {
  CRLF,
  canonicalLineEnds,
  encodedWords,
  filePart,
  headerAddress,
  headerLine,
  mailDate,
  multipart,
  stringBytes,
  textPart,
  writePart,
} from "./mime";
import type { Part } from "./mime";
import { PGP_CONFIG, loadOpenPgp } from "./openpgp.server";
import type { PgpStatus } from "./pgp";

/** Email Service takes a message of up to 25 MiB; signed or encrypted, a message is counted once written out. */
const MAX_RAW_BYTES = 25 * 1024 * 1024;

export interface PgpChoice {
  sign: boolean;
  encrypt: boolean;
}

export interface PgpMail extends PgpChoice {
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  text: string;
  html: string | null;
  /** The signature's images, which the HTML names by Content-ID. */
  images: InlineImage[];
  files: { filename: string; contentType: string; content: ArrayBuffer }[];
  /** In-Reply-To and References, for a reply. */
  threading: Record<string, string>;
  messageId: string;
  date: Date;
}

export interface BuiltPgpMail {
  raw: string;
  /** To, Cc and Bcc, each address once: the envelope, since the message itself names no Bcc. */
  recipients: string[];
  /** The Autocrypt header, which SES carries and Email Service's allowlist refuses. */
  sesOnlyHeaders: Record<string, string>;
  /** What the sent copy files as its status. */
  pgp: PgpStatus;
}

/** Each address once, lower-cased. */
const addressesOf = (list: Address[]): string[] => [
  ...new Set(list.map((a) => a.email.toLowerCase())),
];

/**
 * Who sees whom: the To and Cc recipients, whom the message names, and the Bcc recipients, whom it must not betray.
 * An address on both is shown.
 */
export const recipientsOf = (mail: Pick<PgpMail, "to" | "cc" | "bcc">) => {
  const shown = addressesOf([...mail.to, ...mail.cc]);
  const hidden = addressesOf(mail.bcc).filter((a) => !shown.includes(a));

  return { shown, hidden };
};

/**
 * The keys a choice needs, or a PgpError that says which is missing: the owner's own, and for encryption one for
 * every recipient (kept, a colleague's, or found over WKD), the Bcc recipients' apart. Send later runs it as it
 * schedules a message.
 */
export const pgpKeysFor = async (
  env: Env,
  db: Database,
  user: Pick<User, "id">,
  choice: PgpChoice,
  recipients: { shown: string[]; hidden: string[] },
  options: { fetch?: typeof fetch } = {}
) => {
  const own = await ownPrivateKey(env, db, user.id);

  if (!own) {
    throw new PgpError(
      "Add your OpenPGP key under Settings → Mail to sign or encrypt a message."
    );
  }

  if (!choice.encrypt) {
    return { own, shownKeys: [], hiddenKeys: [] };
  }

  const shown = await recipientKeys(env, db, user, recipients.shown, options);
  const hidden = await recipientKeys(env, db, user, recipients.hidden, options);
  const missing = [...shown.missing, ...hidden.missing];

  if (missing.length) {
    throw new PgpError(
      `There is no OpenPGP key for ${missing.join(", ")}. Send it without encryption, or import their key under Settings → Mail.`
    );
  }

  return { own, shownKeys: shown.keys, hiddenKeys: hidden.keys };
};

/**
 * The inner entity encrypted once, under one session key, for the To and Cc recipients and the owner by their key
 * IDs, and for each Bcc recipient under a wildcard key ID (GnuPG's `--hidden-recipient`): every recipient gets the
 * same message, and none can read from it whose keys the others are.
 */
const encryptFor = async (
  inner: string,
  keys: { shown: PublicKey[]; hidden: PublicKey[] },
  signingKey: PrivateKey | undefined
): Promise<string> => {
  const openpgp = await loadOpenPgp();

  const sessionKey = await openpgp.generateSessionKey({
    encryptionKeys: [...keys.shown, ...keys.hidden],
    config: PGP_CONFIG,
  });

  const message = await openpgp.encrypt({
    message: await openpgp.createMessage({ binary: stringBytes(inner) }),
    encryptionKeys: keys.shown,
    signingKeys: signingKey,
    sessionKey,
    format: "object",
    config: PGP_CONFIG,
  });

  if (keys.hidden.length) {
    const hidden = await openpgp.encryptSessionKey({
      ...sessionKey,
      encryptionKeys: keys.hidden,
      wildcard: true,
      format: "object",
      config: PGP_CONFIG,
    });

    // The session key packets come before the encrypted data; the hidden ones go after the shown ones.
    const dataAt = message.packets.findIndex(
      (packet) =>
        packet.constructor !== openpgp.PublicKeyEncryptedSessionKeyPacket
    );

    message.packets.splice(dataAt, 0, ...hidden.packets);
  }

  return message.armor();
};

/** The body: the text, and the HTML beside it with the images it shows. */
const bodyPart = (mail: PgpMail): Part => {
  if (!mail.html) {
    return textPart(mail.text, "plain");
  }

  const html = textPart(mail.html, "html");

  const shown = mail.images.length
    ? multipart("related", [
        html,
        ...mail.images.map((i) =>
          filePart({
            filename: i.filename,
            contentType: i.contentType,
            content: Uint8Array.from(
              atob(i.base64),
              (c) => c.codePointAt(0) ?? 0
            ),
            inline: true,
            contentId: i.contentId,
          })
        ),
      ])
    : html;

  return multipart("alternative", [textPart(mail.text, "plain"), shown]);
};

const addressList = (list: Address[]): string =>
  list.map(headerAddress).join(", ");

export const buildPgpMail = async (
  env: Env,
  db: Database,
  user: Pick<User, "id">,
  mail: PgpMail,
  options: { fetch?: typeof fetch } = {}
): Promise<BuiltPgpMail> => {
  const recipients = recipientsOf(mail);

  const { own, shownKeys, hiddenKeys } = await pgpKeysFor(
    env,
    db,
    user,
    mail,
    recipients,
    options
  );

  const openpgp = await loadOpenPgp();
  const keyId = own.getKeyID().toHex().toUpperCase();
  const publicKey = own.toPublic();

  const parts = [
    bodyPart(mail),
    ...mail.files.map((f) =>
      filePart({ ...f, content: new Uint8Array(f.content) })
    ),
  ];

  // Signed mail carries the key that checks it, so a reply can be encrypted (as Thunderbird attaches its own).
  if (mail.sign) {
    parts.push({
      headers: [
        `Content-Type: application/pgp-keys; name="OpenPGP_0x${keyId}.asc"`,
        "Content-Description: OpenPGP public key",
        `Content-Disposition: attachment; filename="OpenPGP_0x${keyId}.asc"`,
      ],
      body: canonicalLineEnds(publicKey.armor()),
    });
  }

  // The headers a reader trusts, inside what is signed or encrypted (protected headers, as Thunderbird writes them).
  const protectedHeaders = [
    headerLine("From", headerAddress(mail.from)),
    ...(mail.to.length ? [headerLine("To", addressList(mail.to))] : []),
    ...(mail.cc.length ? [headerLine("Cc", addressList(mail.cc))] : []),
    headerLine("Subject", encodedWords(mail.subject)),
  ];

  const innerPart = multipart("mixed", parts, {
    extra: 'protected-headers="v1"',
    headers: protectedHeaders,
  });

  const inner = writePart(innerPart);

  let outer: Part;

  if (mail.encrypt) {
    const encrypted = await encryptFor(
      inner,
      // The owner's own key too, so what they sent stays readable to them in another client.
      { shown: [...shownKeys, publicKey], hidden: hiddenKeys },
      mail.sign ? own : undefined
    );

    outer = multipart(
      "encrypted",
      [
        {
          headers: [
            "Content-Type: application/pgp-encrypted",
            "Content-Description: PGP/MIME version identification",
          ],
          body: `Version: 1${CRLF}`,
        },
        {
          headers: [
            'Content-Type: application/octet-stream; name="encrypted.asc"',
            "Content-Description: OpenPGP encrypted message",
            'Content-Disposition: inline; filename="encrypted.asc"',
          ],
          body: canonicalLineEnds(encrypted),
        },
      ],
      {
        extra: 'protocol="application/pgp-encrypted"',
        preamble:
          "This is an OpenPGP/MIME encrypted message (RFC 4880 and 3156)",
      }
    );
  } else {
    const armored = await openpgp.sign({
      message: await openpgp.createMessage({ binary: stringBytes(inner) }),
      signingKeys: own,
      detached: true,
      format: "armored",
      config: PGP_CONFIG,
    });

    const signature = await openpgp.readSignature({
      armoredSignature: armored,
      config: PGP_CONFIG,
    });

    const hash =
      signature.packets[0]?.hashAlgorithm ?? openpgp.enums.hash.sha512;

    const micalg = `pgp-${openpgp.enums.read(openpgp.enums.hash, hash).toLowerCase()}`;

    // `multipart` writes the first part as `writePart` did above, so the bytes signed are the bytes sent.
    outer = multipart(
      "signed",
      [
        innerPart,
        {
          headers: [
            'Content-Type: application/pgp-signature; name="OpenPGP_signature.asc"',
            "Content-Description: OpenPGP digital signature",
            'Content-Disposition: attachment; filename="OpenPGP_signature.asc"',
          ],
          body: canonicalLineEnds(armored),
        },
      ],
      {
        extra: `micalg=${micalg}; protocol="application/pgp-signature"`,
        preamble: "This is an OpenPGP/MIME signed message (RFC 4880 and 3156)",
      }
    );
  }

  const headers = [
    headerLine("From", headerAddress(mail.from)),
    ...(mail.to.length ? [headerLine("To", addressList(mail.to))] : []),
    ...(mail.cc.length ? [headerLine("Cc", addressList(mail.cc))] : []),
    // Encrypted, the subject is inside; outside it reads as Thunderbird and others write it.
    headerLine("Subject", mail.encrypt ? "..." : encodedWords(mail.subject)),
    `Date: ${mailDate(mail.date)}`,
    `Message-ID: ${mail.messageId}`,
    ...Object.entries(mail.threading).map(([name, value]) =>
      headerLine(name, value)
    ),
    "MIME-Version: 1.0",
    ...outer.headers,
  ];

  const raw = writePart({ headers, body: outer.body });

  if (raw.length > MAX_RAW_BYTES) {
    throw new PgpError(
      "Signed or encrypted, the message is larger than the 25 MB a message can be. Send the large files another way, such as a Drive link."
    );
  }

  return {
    raw,
    recipients: [...recipients.shown, ...recipients.hidden],
    sesOnlyHeaders: {
      Autocrypt: autocryptHeader(mail.from.email, publicKey.write()),
    },
    pgp: {
      format: "mime",
      partial: false,
      encrypted: mail.encrypt,
      decrypted: mail.encrypt,
      error: null,
      signature: mail.sign
        ? {
            state: "good",
            keyId: own.getKeyID().toHex(),
            fingerprint: own.getFingerprint(),
            source: "workspace",
            reason: null,
          }
        : null,
    },
  };
};
