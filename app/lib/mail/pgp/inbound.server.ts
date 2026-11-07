/**
 * Mail that arrives with OpenPGP in it, opened for one mailbox: PGP/MIME (RFC 3156) signed or encrypted, or a block of
 * armored text in the body ("inline"). What it was encrypted to is opened with the owner's key and kept opened, so
 * search, the spam filter and the Assistant read it as any other mail (`ingest.server.ts` parses what this answers);
 * a signature is checked against the sender's key (`lookup.server.ts`), never against a key the message brings.
 * Nothing here throws for a message it cannot open: the message is kept as it came, its status saying why.
 */
import type { PrivateKey, VerifyMessageResult } from "openpgp";

import type { Database } from "~/db";
import type { User } from "~/db/schema";
import { errorMessage } from "~/lib/guards";

import { domainOf } from "../addresses";
import type { ParsedAttachment, ParsedMail } from "../ingest.server";
import { PgpError, ownPrivateKey, rememberPeerKey } from "./keys.server";
import { keyFor } from "./lookup.server";
import type { FoundKey } from "./lookup.server";
import {
  CRLF,
  byteString,
  canonicalLineEnds,
  contentTypeOf,
  decodedBody,
  headerValue,
  multipartParts,
  splitEntity,
  stringBytes,
  withoutHeaders,
} from "./mime";
import type { Entity } from "./mime";
import { PGP_CONFIG, keyAddresses, loadOpenPgp } from "./openpgp.server";
import type { PgpSignature, PgpStatus } from "./pgp";

/** What opening a message came to, for the caller to parse and file. */
export type Opened =
  /** No OpenPGP in it. */
  | { kind: "none" }
  /** PGP/MIME: the whole message again, its protected part in place of the signed or encrypted wrapping. */
  | { kind: "mime"; pgp: PgpStatus; message: Uint8Array<ArrayBuffer> }
  /** Inline: the body's text with each block opened, and the files with each `.pgp` one opened. */
  | {
      kind: "inline";
      pgp: PgpStatus;
      text: string;
      attachments: ParsedAttachment[];
    }
  /** Encrypted, and it could not be opened: kept as it came. */
  | { kind: "shut"; pgp: PgpStatus };

export interface OpenInput {
  raw: ArrayBuffer;
  /** The sender's address, lower-cased: whose key checks a signature. */
  from: string;
  /** The body's text and files as parsed, for the inline blocks. */
  text: string;
  attachments: ParsedAttachment[];
}

interface Context {
  env: Env;
  db: Database;
  owner: Pick<User, "id">;
  from: string;
  /** The sender's key, looked up once (over WKD when nothing is kept) and only if a signature asks for it. */
  candidate: () => Promise<FoundKey | null>;
}

type VerificationResult = VerifyMessageResult["signatures"][number];

/** A signature's verdict: the first one the sender's key made, else the first there is, which no key at hand made. */
const judge = async (
  results: VerificationResult[],
  candidate: FoundKey | null,
  from: string
): Promise<PgpSignature | null> => {
  for (const r of results) {
    // Each result's promise rejects for a key that is not at hand; a rejection nobody awaits would be reported.
    r.verified.catch(() => null);
  }

  const theirs = candidate
    ? results.find((r) => candidate.key.getKeys(r.keyID).length > 0)
    : undefined;

  const first = theirs ?? results[0];

  if (!first) {
    return null;
  }

  const keyId = first.keyID.toHex();

  if (!theirs || !candidate) {
    return {
      state: "unknown-key",
      keyId,
      fingerprint: null,
      source: null,
      reason: null,
    };
  }

  const checked = {
    keyId,
    fingerprint: candidate.fingerprint,
    source: candidate.source,
  };

  try {
    await first.verified;
  } catch (error) {
    return { state: "bad", ...checked, reason: errorMessage(error) };
  }

  return {
    state: keyAddresses(candidate.key).includes(from)
      ? "good"
      : "other-address",
    ...checked,
    reason: null,
  };
};

/** A detached signature (the second part of `multipart/signed`) over the first part's exact bytes, line ends made CRLF. */
const verifyDetached = async (
  ctx: Context,
  signed: string,
  signaturePart: string
): Promise<PgpSignature | null> => {
  const openpgp = await loadOpenPgp();
  const body = decodedBody(splitEntity(signaturePart));

  let signature: Awaited<ReturnType<typeof openpgp.readSignature>>;

  try {
    signature = body.includes("-----BEGIN PGP SIGNATURE-----")
      ? await openpgp.readSignature({
          armoredSignature: body,
          config: PGP_CONFIG,
        })
      : await openpgp.readSignature({
          binarySignature: stringBytes(body),
          config: PGP_CONFIG,
        });
  } catch {
    return null;
  }

  const keyId = signature.getSigningKeyIDs()[0]?.toHex() ?? "";
  const candidate = await ctx.candidate();
  const ids = signature.getSigningKeyIDs();

  if (!candidate || !ids.some((id) => candidate.key.getKeys(id).length > 0)) {
    return {
      state: "unknown-key",
      keyId,
      fingerprint: null,
      source: null,
      reason: null,
    };
  }

  const result = await openpgp.verify({
    message: await openpgp.createMessage({
      binary: stringBytes(canonicalLineEnds(signed)),
    }),
    signature,
    verificationKeys: candidate.key,
    format: "binary",
    config: PGP_CONFIG,
  });

  return await judge(result.signatures, candidate, ctx.from);
};

/** What describes a body part rather than the message: the outer message's go, the protected part's stay. */
const PART_HEADERS = [
  "content-type",
  "content-transfer-encoding",
  "content-disposition",
  "content-description",
  "content-id",
];

/** What describes the message rather than a part: the outer message's stay, even when the protected part repeats them. */
const ENVELOPE_HEADERS = [
  "from",
  "sender",
  "to",
  "cc",
  "bcc",
  "reply-to",
  "date",
  "message-id",
  "in-reply-to",
  "references",
  "mime-version",
];

/**
 * The message with its protected part in place of the whole: the outer headers, then the part's own. A Subject the part
 * carries (protected headers, as Thunderbird writes them under an outer "...") takes the outer one's place.
 */
const rebuild = (top: Entity, part: string): Uint8Array<ArrayBuffer> => {
  const inner = splitEntity(part);
  const protectedSubject = headerValue(inner.headers, "subject");

  const outerHead = withoutHeaders(
    top.head,
    protectedSubject ? [...PART_HEADERS, "subject"] : PART_HEADERS
  );

  const innerHead = withoutHeaders(inner.head, ENVELOPE_HEADERS);

  return stringBytes(`${outerHead}${innerHead}${CRLF}${inner.body}`);
};

const status = (
  pgp: Partial<PgpStatus> & Pick<PgpStatus, "format">
): PgpStatus => ({
  encrypted: false,
  decrypted: false,
  error: null,
  signature: null,
  ...pgp,
});

const shut = (format: PgpStatus["format"], error: string): Opened => ({
  kind: "shut",
  pgp: status({ format, encrypted: true, error }),
});

const NO_KEY =
  "This mailbox has no OpenPGP key, so the message stays encrypted. Add your key under Settings → Mail, then check the message again.";

/** The owner's private key, or the words for why there is none to open with. */
const decryptionKey = async (
  ctx: Context
): Promise<{ key: PrivateKey } | { error: string }> => {
  try {
    const key = await ownPrivateKey(ctx.env, ctx.db, ctx.owner.id);

    return key ? { key } : { error: NO_KEY };
  } catch (error) {
    if (error instanceof PgpError) {
      return { error: error.message };
    }

    throw error;
  }
};

const openSigned = async (
  ctx: Context,
  top: Entity,
  boundary: string
): Promise<Opened> => {
  const [signed, signaturePart] = multipartParts(top.body, boundary);

  if (signed === undefined || signaturePart === undefined) {
    return { kind: "none" };
  }

  return {
    kind: "mime",
    pgp: status({
      format: "mime",
      signature: await verifyDetached(ctx, signed, signaturePart),
    }),
    message: rebuild(top, signed),
  };
};

const openEncrypted = async (
  ctx: Context,
  top: Entity,
  boundary: string
): Promise<Opened> => {
  const payload = multipartParts(top.body, boundary)
    .map(splitEntity)
    .find(
      (part) =>
        contentTypeOf(part.headers).mediaType === "application/octet-stream"
    );

  if (!payload) {
    return shut("mime", "The encrypted part of the message is missing.");
  }

  const own = await decryptionKey(ctx);

  if ("error" in own) {
    return shut("mime", own.error);
  }

  const openpgp = await loadOpenPgp();
  const body = decodedBody(payload);
  const candidate = await ctx.candidate();
  let decrypted: { data: Uint8Array; signatures: VerificationResult[] };

  try {
    const message = body.includes("-----BEGIN PGP MESSAGE-----")
      ? await openpgp.readMessage({ armoredMessage: body, config: PGP_CONFIG })
      : await openpgp.readMessage({
          binaryMessage: stringBytes(body),
          config: PGP_CONFIG,
        });

    decrypted = await openpgp.decrypt({
      message,
      decryptionKeys: own.key,
      verificationKeys: candidate ? [candidate.key] : [],
      expectSigned: false,
      format: "binary",
      config: PGP_CONFIG,
    });
  } catch (error) {
    return shut("mime", `Your key could not open it: ${errorMessage(error)}`);
  }

  const inner = byteString(decrypted.data);
  const entity = splitEntity(inner);
  const type = contentTypeOf(entity.headers);
  let signature = await judge(decrypted.signatures, candidate, ctx.from);
  let content = inner;

  // Signed, then encrypted as a whole (RFC 3156 §6.1): the signature is the inner `multipart/signed`'s.
  if (
    type.mediaType === "multipart/signed" &&
    type.params.protocol?.toLowerCase() === "application/pgp-signature" &&
    type.params.boundary
  ) {
    const [signed, signaturePart] = multipartParts(
      entity.body,
      type.params.boundary
    );

    if (signed !== undefined && signaturePart !== undefined) {
      signature = await verifyDetached(ctx, signed, signaturePart);
      content = signed;
    }
  }

  return {
    kind: "mime",
    pgp: status({
      format: "mime",
      encrypted: true,
      decrypted: true,
      signature,
    }),
    message: rebuild(top, content),
  };
};

/** Where a block that starts a line begins, from `from` on; -1 when there is none (a block quoted with `> ` is no block). */
const blockStart = (text: string, marker: string, from: number): number => {
  let at = text.indexOf(marker, from);

  while (at > 0 && text[at - 1] !== "\n") {
    at = text.indexOf(marker, at + marker.length);
  }

  return at;
};

const ENCRYPTED_BEGIN = "-----BEGIN PGP MESSAGE-----";
const ENCRYPTED_END = "-----END PGP MESSAGE-----";
const SIGNED_BEGIN = "-----BEGIN PGP SIGNED MESSAGE-----";
const SIGNED_END = "-----END PGP SIGNATURE-----";

const ENCRYPTED_FILE = /\.(?:pgp|gpg)$/iu;

/** Each block of `begin` to `end` in the text, replaced with what `open` makes of it, or left when it answers null. */
const replaceBlocks = async (
  text: string,
  begin: string,
  end: string,
  open: (block: string) => Promise<string | null>
): Promise<{ text: string; found: boolean }> => {
  let out = "";
  let at = 0;
  let found = false;

  for (;;) {
    const start = blockStart(text, begin, at);
    const stop = start === -1 ? -1 : text.indexOf(end, start);

    if (stop === -1) {
      break;
    }

    const after = stop + end.length;
    // oxlint-disable-next-line eslint/no-await-in-loop -- a body has one block, or a few at most, opened in order
    const opened = await open(text.slice(start, after));
    out += text.slice(at, start) + (opened ?? text.slice(start, after));
    found ||= opened !== null;
    at = after;
  }

  return { text: out + text.slice(at), found };
};

/** What opening the inline blocks found so far, kept in one place since each block's opening adds to it. */
interface InlineState {
  signature: PgpSignature | null;
  encrypted: boolean;
  /** Why something encrypted stayed shut. */
  failure: string | null;
  own: { key: PrivateKey } | { error: string } | null;
}

const openInline = async (ctx: Context, input: OpenInput): Promise<Opened> => {
  const openpgp = await loadOpenPgp();

  const state: InlineState = {
    signature: null,
    encrypted: false,
    failure: null,
    own: null,
  };

  const decrypt = async (
    message: Awaited<ReturnType<typeof openpgp.readMessage>>
  ): Promise<Uint8Array | null> => {
    state.encrypted = true;
    state.own ??= await decryptionKey(ctx);

    if ("error" in state.own) {
      state.failure = state.own.error;

      return null;
    }

    const candidate = await ctx.candidate();

    try {
      const result = await openpgp.decrypt({
        message,
        decryptionKeys: state.own.key,
        verificationKeys: candidate ? [candidate.key] : [],
        expectSigned: false,
        format: "binary",
        config: PGP_CONFIG,
      });

      state.signature =
        (await judge(result.signatures, candidate, ctx.from)) ??
        state.signature;

      return result.data;
    } catch (error) {
      state.failure = `Your key could not open it: ${errorMessage(error)}`;

      return null;
    }
  };

  const opened = await replaceBlocks(
    input.text,
    ENCRYPTED_BEGIN,
    ENCRYPTED_END,
    async (block) => {
      try {
        const data = await decrypt(
          await openpgp.readMessage({
            armoredMessage: block,
            config: PGP_CONFIG,
          })
        );

        return data ? new TextDecoder().decode(data) : null;
      } catch {
        return null;
      }
    }
  );

  const signed = await replaceBlocks(
    opened.text,
    SIGNED_BEGIN,
    SIGNED_END,
    async (block) => {
      try {
        const message = await openpgp.readCleartextMessage({
          cleartextMessage: block,
          config: PGP_CONFIG,
        });

        const candidate = await ctx.candidate();
        const ids = message.getSigningKeyIDs();

        if (
          candidate &&
          ids.some((id) => candidate.key.getKeys(id).length > 0)
        ) {
          const result = await openpgp.verify({
            message,
            verificationKeys: candidate.key,
            config: PGP_CONFIG,
          });

          state.signature = await judge(result.signatures, candidate, ctx.from);
        } else {
          state.signature = {
            state: "unknown-key",
            keyId: ids[0]?.toHex() ?? "",
            fingerprint: null,
            source: null,
            reason: null,
          };
        }

        return message.getText();
      } catch {
        return null;
      }
    }
  );

  const attachments: ParsedAttachment[] = [];
  let openedFiles = false;

  for (const a of input.attachments) {
    if (!ENCRYPTED_FILE.test(a.filename)) {
      attachments.push(a);
      continue;
    }

    try {
      const armored =
        byteString(a.content.subarray(0, ENCRYPTED_BEGIN.length)) ===
        ENCRYPTED_BEGIN;

      const message = armored
        ? // oxlint-disable-next-line eslint/no-await-in-loop -- files are opened one at a time, so one is in memory twice at once
          await openpgp.readMessage({
            armoredMessage: byteString(a.content),
            config: PGP_CONFIG,
          })
        : // oxlint-disable-next-line eslint/no-await-in-loop -- as above
          await openpgp.readMessage({
            binaryMessage: a.content,
            config: PGP_CONFIG,
          });

      // oxlint-disable-next-line eslint/no-await-in-loop -- as above
      const data = await decrypt(message);

      if (data) {
        attachments.push({
          ...a,
          filename: a.filename.replace(ENCRYPTED_FILE, ""),
          mimeType: "application/octet-stream",
          content: data,
        });
        openedFiles = true;
        continue;
      }
    } catch {
      // Not an OpenPGP message after all: kept as it came.
    }

    attachments.push(a);
  }

  if (!opened.found && !signed.found && !openedFiles) {
    return state.encrypted && state.failure
      ? shut("inline", state.failure)
      : { kind: "none" };
  }

  return {
    kind: "inline",
    pgp: status({
      format: "inline",
      encrypted: state.encrypted,
      decrypted: state.encrypted && !state.failure,
      error: state.failure,
      signature: state.signature,
    }),
    text: signed.text,
    attachments,
  };
};

/**
 * Open what OpenPGP protects in a message for `owner`. `fetch` is for the tests' WKD; the sender's domain is asked for
 * their key only when a signature needs it and the mailbox keeps none.
 */
export const openPgp = async (
  env: Env,
  db: Database,
  owner: Pick<User, "id">,
  input: OpenInput,
  options: { fetch?: typeof fetch } = {}
): Promise<Opened> => {
  const top = splitEntity(byteString(new Uint8Array(input.raw)));
  const type = contentTypeOf(top.headers);
  const protocol = type.params.protocol?.toLowerCase();
  let looked: Promise<FoundKey | null> | null = null;

  const ctx: Context = {
    env,
    db,
    owner,
    from: input.from,
    candidate: () => {
      looked ??= keyFor(env, db, owner, input.from, {
        wkd: true,
        fetch: options.fetch,
      });

      return looked;
    },
  };

  if (type.params.boundary) {
    if (
      type.mediaType === "multipart/encrypted" &&
      protocol === "application/pgp-encrypted"
    ) {
      return await openEncrypted(ctx, top, type.params.boundary);
    }

    if (
      type.mediaType === "multipart/signed" &&
      protocol === "application/pgp-signature"
    ) {
      return await openSigned(ctx, top, type.params.boundary);
    }
  }

  const inline =
    input.text.includes("-----BEGIN PGP ") ||
    input.attachments.some((a) => ENCRYPTED_FILE.test(a.filename));

  return inline ? await openInline(ctx, input) : { kind: "none" };
};

/**
 * Keep the key a sender's Autocrypt header carries, when the header can be believed: it names the From address, that
 * address is not this workspace's (a colleague's own key is the one that counts), and Cloudflare's MX found the
 * message signed by the From's domain or passing DMARC. A message without those checks (local mail, an import) teaches
 * nothing, and neither does a key that cannot encrypt.
 */
export const learnAutocrypt = async (
  env: Env,
  db: Database,
  owner: Pick<User, "id">,
  mail: Pick<ParsedMail, "autocrypt" | "from" | "date" | "signals">
): Promise<void> => {
  const header = mail.autocrypt;
  const from = mail.from.email.toLowerCase();
  const domain = domainOf(from);

  if (
    !header ||
    header.addr !== from ||
    domain === env.MAIL_DOMAIN.toLowerCase()
  ) {
    return;
  }

  const checks = mail.signals?.checks;

  const vouched =
    checks?.dmarc === "pass" ||
    !!checks?.dkimDomains.some((d) => domain === d || domain.endsWith(`.${d}`));

  if (!vouched) {
    return;
  }

  try {
    const openpgp = await loadOpenPgp();

    const key = await openpgp.readKey({
      binaryKey: header.keydata,
      config: PGP_CONFIG,
    });

    if (!keyAddresses(key).includes(from)) {
      return;
    }

    await key.getEncryptionKey();

    await rememberPeerKey(db, owner.id, {
      address: from,
      key: key.toPublic(),
      source: "autocrypt",
      preferEncrypt: header.preferEncrypt,
      seenAt: mail.date,
    });
  } catch {
    // Not a key, or one that cannot encrypt: nothing to learn.
  }
};
