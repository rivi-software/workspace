import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/db";
import {
  driveNodes,
  handSignatures,
  signingEvents,
  signingRequests,
  users,
} from "~/db/schema";
import type { SigningEvent, SigningRequest, User } from "~/db/schema";
/**
 * Signing a PDF in Drive (#2974). A person who reaches a PDF asks a customer outside the workspace and a signer inside
 * it (themselves or a colleague) to sign it: they place the fields, fill in the workspace's texts and boxes, and send.
 * The PDF is copied for the request, so what is signed is what was sent. The request goes out from the person's own
 * mailbox (Mail's `sendAsPerson`) with a link under `/s/sign/`; the customer confirms their address with a one-time
 * code mailed there (`visitor.server.ts`, as an invite's), fills in their fields and signs, or declines. Then the
 * workspace signs: its signer, or, when the request was sent with `auto_sign`, the person who asked with their saved
 * signature (`hand_signatures`), at once. The signed copy (`signing-pdf.server.ts`: the fields drawn in, a
 * certificate page after the last) is kept with the request, filed in Drive beside the original and mailed to the
 * customer from the person's mailbox.
 *
 * A request is the business of who asked and its signer only. Sending one shares the PDF outside the workspace, so
 * it needs sharing outside to be on (Settings → Drive) and the file reached through Drive's gate; after that the
 * request stands on its own copy. Every step is recorded in `signing_events` with its address and browser.
 */
import { randomToken, sha256Hex } from "~/lib/crypto";
import { defined, errorMessage } from "~/lib/guards";

import { sameOriginPost } from "../auth.server";
import { newId } from "../ids";
import { domainOf, isValidEmail } from "../mail/addresses";
import { sendAsPerson } from "../mail/mail.server";
import { MAX_ATTACHMENT_BYTES } from "../mail/send.server";
import { openSecret, sealSecret } from "../secret-box.server";
import { externalSharingOn } from "../workspace-settings.server";
import { reachFile } from "./access.server";
import { maskEmail } from "./drive";
import { DriveError, finishUpload, startUpload } from "./drive.server";
import { mailOut } from "./mail-out.server";
import {
  MAX_MESSAGE,
  MAX_SIGNATURE_BASE64,
  MAX_SIGNING_BYTES,
  SIGNING_DAYS,
  SIGNING_EVENT_LABEL,
  customerSigningPath,
  datesFor,
  isPdf,
  parseFields,
  partyValues,
  riviPrefill,
  signingHref,
  signingState,
} from "./signing";
import type { SigningField, SigningState, SigningValues } from "./signing";
import { customerOf, originOf, record } from "./signing-events.server";
import type { Origin } from "./signing-events.server";
import {
  PdfError,
  isSignaturePng,
  readSignablePdf,
  signedPdf,
} from "./signing-pdf.server";
import {
  admit,
  readPasses,
  tooManyRequests,
  visitorPost,
} from "./visitor.server";
import type { Visits } from "./visitor.server";

export class SigningError extends Error {
  override name = "SigningError";
}

/** Requests one person sends in an hour, and how soon a reminder may follow the last mail. */
const REQUESTS_PER_HOUR = 20;
const REMIND_AFTER_MS = 60 * 60 * 1000;

const SEAL_TOKEN = "signing-link";

const log = (
  event: string,
  fields: Record<string, string | number | boolean | null>
) => {
  console.log(JSON.stringify({ event, ...fields }));
};

const notFound = () =>
  new Response("not found", {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });

/** The customer's page: what is mailed. */
export const signingUrl = (env: Env, token: string): string =>
  `${env.APP_URL.replace(/\/+$/u, "")}${customerSigningPath(token)}`;

export const appUrl = (env: Env, path: string): string =>
  `${env.APP_URL.replace(/\/+$/u, "")}${path}`;

const bytesSha256 = async (bytes: Uint8Array): Promise<string> => {
  // SAFETY: every `Uint8Array` here is made over an `ArrayBuffer`, never a `SharedArrayBuffer`.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>
  );

  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
};

const fromBase64 = (base64: string): Uint8Array =>
  Uint8Array.from(atob(base64), (c) => c.codePointAt(0) ?? 0);

// SAFETY: `fieldsJson` is only written from `parseFields`' output, so it holds a `SigningField[]`.
const fieldsOf = (r: SigningRequest): SigningField[] =>
  JSON.parse(r.fieldsJson) as SigningField[];

// SAFETY: `valuesJson` is only written from the checked values of a request, so it holds `SigningValues`.
const valuesOf = (r: SigningRequest): SigningValues =>
  JSON.parse(r.valuesJson) as SigningValues;

const person = async (db: Database, id: string): Promise<User | null> =>
  (await db.query.users.findFirst({ where: eq(users.id, id) })) ?? null;

const personOf = (u: User) => ({
  userId: u.id,
  name: `${u.name} <${u.email}>`,
});

const longDate = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "long",
  timeZone: "UTC",
});

/* ---------- a person's own signature ---------- */

/**
 * A signature as the pages post it, checked: a PNG (base64, a `data:` URL's prefix allowed) a PDF can take, no larger
 * than `MAX_SIGNATURE_BASE64`. Answers its base64.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the page's post body: this function is where it is parsed
export const checkSignature = async (raw: unknown): Promise<string> => {
  const text = z.string().safeParse(raw);

  const base64 = text.success
    ? text.data.replace(/^data:image\/png;base64,/u, "").trim()
    : "";

  if (!base64) {
    throw new SigningError("Draw or type your signature first.");
  }

  if (
    base64.length > MAX_SIGNATURE_BASE64 ||
    !/^[A-Za-z0-9+/]+=*$/u.test(base64)
  ) {
    throw new SigningError(
      "That signature is not readable. Draw or type it again."
    );
  }

  if (!(await isSignaturePng(fromBase64(base64)))) {
    throw new SigningError(
      "That signature is not readable. Draw or type it again."
    );
  }

  return base64;
};

/** The person's saved signature, as base64, or null. */
export const handSignatureOf = async (
  db: Database,
  userId: string
): Promise<string | null> => {
  const row = await db.query.handSignatures.findFirst({
    where: eq(handSignatures.userId, userId),
  });

  return row?.png ?? null;
};

export const saveHandSignature = async (
  db: Database,
  userId: string,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the page's post body, parsed by `checkSignature`
  raw: unknown
) => {
  const png = await checkSignature(raw);
  const updatedAt = new Date().toISOString();
  await db
    .insert(handSignatures)
    .values({ userId, png, updatedAt })
    .onConflictDoUpdate({
      target: handSignatures.userId,
      set: { png, updatedAt },
    });
};

export const deleteHandSignature = async (db: Database, userId: string) => {
  await db.delete(handSignatures).where(eq(handSignatures.userId, userId));
};

/* ---------- sending a request ---------- */

export interface NewSigningRequest {
  nodeId: string;
  customerName: string;
  customerEmail: string;
  /** Who signs for the workspace: the person asking or a colleague. */
  signerId: string;
  /** The workspace signs with the asker's saved signature once the customer has; the asker must be the signer. */
  autoSign: boolean;
  message: string;
  /** As the editor posted them (`parseFields`). */
  fields: unknown;
  /** The workspace's texts and boxes, by field id. */
  riviValues: unknown;
}

const mailRequest = async (
  env: Env,
  db: Database,
  user: User,
  r: SigningRequest,
  url: string,
  reminder = false
) => {
  await sendAsPerson(env, db, user, {
    to: [{ email: r.customerEmail, name: r.customerName }],
    subject: `${reminder ? "Reminder: " : ""}Please sign "${r.name}"`,
    text: [
      `Hello ${r.customerName},`,
      `${user.name} of ${env.APP_NAME} asks you to sign "${r.name}".`,
      ...(r.message ? [r.message] : []),
      `Review and sign it here:\n${url}`,
      `When you open it, we mail a code to this address to confirm it is you. The request is open until ${longDate.format(new Date(r.expiresAt))}.`,
      `Kind regards,\n${user.name}`,
    ].join("\n\n"),
  });
};

/**
 * A request for signatures on a PDF the person reaches: checked, the PDF copied for it, and mailed to the customer
 * from the person's mailbox. When the mail fails, nothing is kept.
 */
// oxlint-disable-next-line eslint/complexity -- one send: its checks run in order, each refusing with its own message
export const createSigningRequest = async (
  env: Env,
  db: Database,
  user: User,
  input: NewSigningRequest,
  origin: Origin,
  at = Date.now()
): Promise<{ request: SigningRequest; url: string }> => {
  if (!(await externalSharingOn(db))) {
    throw new SigningError(
      "An admin turned off sharing outside the workspace, which sending for signatures needs."
    );
  }

  const file = await reachFile(db, user.id, input.nodeId, "outside");

  if (!file) {
    throw new SigningError("That file is gone.");
  }

  if (!isPdf(file.node.contentType, file.node.name)) {
    throw new SigningError("Only a PDF can be sent for signatures.");
  }

  if (file.node.size > MAX_SIGNING_BYTES) {
    throw new SigningError("A PDF sent for signatures can be 15 MB at most.");
  }

  const customerName = input.customerName.trim().slice(0, 120);
  const customerEmail = input.customerEmail.trim().toLowerCase();

  if (!customerName) {
    throw new SigningError("Give the customer's name.");
  }

  if (!isValidEmail(customerEmail)) {
    throw new SigningError(`"${input.customerEmail}" is not a valid address.`);
  }

  if (domainOf(customerEmail) === env.MAIL_DOMAIN.toLowerCase()) {
    throw new SigningError(
      "The customer signs from outside the workspace: give their own address."
    );
  }

  const message = input.message.trim().slice(0, MAX_MESSAGE);

  const signer =
    input.signerId === user.id ? user : await person(db, input.signerId);

  if (!signer || !signer.active) {
    throw new SigningError("Choose who signs for the workspace.");
  }

  if (input.autoSign) {
    if (signer.id !== user.id) {
      throw new SigningError(
        `Only you can sign automatically, with your own signature.`
      );
    }

    if (!(await handSignatureOf(db, user.id))) {
      throw new SigningError(
        "Save your signature first: automatic signing uses it."
      );
    }
  }

  const [sent] = await db
    .select({ n: sql<number>`count(*)` })
    .from(signingRequests)
    .where(
      and(
        eq(signingRequests.createdBy, user.id),
        sql`${signingRequests.createdAt} > ${new Date(at - 3_600_000).toISOString()}`
      )
    );

  if ((sent?.n ?? 0) >= REQUESTS_PER_HOUR) {
    throw new SigningError(
      "Too many requests in the last hour. Wait a while, then send again."
    );
  }

  const object = await env.DRIVE.get(file.key);

  if (!object) {
    throw new SigningError("That file is gone.");
  }

  const bytes = new Uint8Array(await object.arrayBuffer());
  let pageCount: number;

  try {
    ({ pageCount } = await readSignablePdf(bytes));
  } catch (error) {
    if (error instanceof PdfError) {
      throw new SigningError(error.message);
    }

    throw error;
  }

  const parsed = parseFields(input.fields, pageCount);

  if ("error" in parsed) {
    throw new SigningError(parsed.error);
  }

  const prefill = riviPrefill(parsed.fields, input.riviValues);

  if ("error" in prefill) {
    throw new SigningError(prefill.error);
  }

  const id = newId("sr");
  const token = randomToken(32);
  const originalKey = `signing/${id}/original.pdf`;
  const now = new Date(at).toISOString();
  const expiresAt = new Date(at + SIGNING_DAYS * 86_400_000).toISOString();
  await env.DRIVE.put(originalKey, bytes, {
    httpMetadata: { contentType: "application/pdf" },
  });
  await db.insert(signingRequests).values({
    id,
    nodeId: file.node.id,
    name: file.node.name,
    createdBy: user.id,
    signerId: signer.id,
    autoSign: input.autoSign,
    customerName,
    customerEmail,
    message,
    pageCount,
    fieldsJson: JSON.stringify(parsed.fields),
    valuesJson: JSON.stringify(prefill.values),
    originalKey,
    originalSha256: await bytesSha256(bytes),
    tokenHash: await sha256Hex(token),
    tokenSealed: await sealSecret(env, SEAL_TOKEN, token),
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });

  const request = defined(
    await db.query.signingRequests.findFirst({
      where: eq(signingRequests.id, id),
    }),
    "the signing request just inserted"
  );

  const url = signingUrl(env, token);

  try {
    await mailRequest(env, db, user, request, url);
  } catch (error) {
    await db.delete(signingRequests).where(eq(signingRequests.id, id));
    await env.DRIVE.delete(originalKey);
    throw new SigningError(
      `The request to ${customerEmail} was not sent: ${errorMessage(error)}`
    );
  }

  await record(db, id, "created", personOf(user), origin, at);
  await record(db, id, "sent", personOf(user), origin, at, customerEmail);
  log("drive.signing.created", {
    requestId: id,
    nodeId: file.node.id,
    by: user.id,
  });

  return { request, url };
};

/** What the editor starts from: the PDF, who can sign for the workspace, and whether the person can auto-sign. */
export interface SigningEditor {
  node: { id: string; name: string; size: number };
  me: { id: string; name: string };
  colleagues: { id: string; name: string; email: string }[];
  savedSignature: string | null;
  /** Why it cannot be sent, when it cannot. */
  blocked: string | null;
}

/** Why a file cannot be sent for signatures, or null when it can. */
const blockedReason = async (
  db: Database,
  node: { contentType: string | null; name: string; size: number }
): Promise<string | null> => {
  if (!isPdf(node.contentType ?? "", node.name)) {
    return "Only a PDF can be sent for signatures.";
  }

  if (node.size > MAX_SIGNING_BYTES) {
    return "A PDF sent for signatures can be 15 MB at most.";
  }

  return (await externalSharingOn(db))
    ? null
    : "An admin turned off sharing outside the workspace, which sending for signatures needs.";
};

export const signingEditor = async (
  db: Database,
  user: User,
  nodeId: string
): Promise<SigningEditor | null> => {
  const file = await reachFile(db, user.id, nodeId, "outside");

  if (!file) {
    return null;
  }

  const blocked = await blockedReason(db, file.node);

  const people = await db.query.users.findMany({
    where: and(eq(users.active, true), ne(users.id, user.id)),
    orderBy: (u, { asc }) => [asc(u.name)],
  });

  return {
    node: { id: file.node.id, name: file.node.name, size: file.node.size },
    me: { id: user.id, name: user.name },
    colleagues: people.map((u) => ({ id: u.id, name: u.name, email: u.email })),
    savedSignature: await handSignatureOf(db, user.id),
    blocked,
  };
};

/* ---------- what the person sees ---------- */

export interface SigningRow {
  id: string;
  name: string;
  state: SigningState;
  customer: { name: string; email: string };
  createdBy: { id: string; name: string };
  signer: { id: string; name: string };
  autoSign: boolean;
  /** Whether it waits for this person to sign for the workspace. */
  myTurn: boolean;
  createdAt: string;
  updatedAt: string;
}

export const namesOf = async (
  db: Database,
  ids: string[]
): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  const wanted = [...new Set(ids)];

  if (!wanted.length) {
    return out;
  }

  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, wanted.slice(0, 90)));

  for (const r of rows) {
    out.set(r.id, r.name);
  }

  return out;
};

const rowsOf = async (
  db: Database,
  userId: string,
  list: SigningRequest[],
  at: number
) => {
  const names = await namesOf(
    db,
    list.flatMap((r) => [r.createdBy, r.signerId])
  );

  return list.map((r): SigningRow => {
    const state = signingState(r, at);

    return {
      id: r.id,
      name: r.name,
      state,
      customer: { name: r.customerName, email: r.customerEmail },
      createdBy: { id: r.createdBy, name: names.get(r.createdBy) ?? "Someone" },
      signer: { id: r.signerId, name: names.get(r.signerId) ?? "Someone" },
      autoSign: r.autoSign,
      myTurn: state === "awaiting-rivi" && r.signerId === userId,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });
};

/** The requests the person sent or signs for, newest first (at most 100); those on one file when `nodeId`. */
export const listSigningRequests = async (
  db: Database,
  userId: string,
  options: { nodeId?: string } = {},
  at = Date.now()
): Promise<SigningRow[]> => {
  const mine = or(
    eq(signingRequests.createdBy, userId),
    eq(signingRequests.signerId, userId)
  );

  const list = await db.query.signingRequests.findMany({
    where: options.nodeId
      ? and(mine, eq(signingRequests.nodeId, options.nodeId))
      : mine,
    orderBy: [desc(signingRequests.createdAt)],
    limit: options.nodeId ? 20 : 100,
  });

  return rowsOf(db, userId, list, at);
};

/** A request the person sent or signs for, or null. */
const ownRequest = async (db: Database, userId: string, id: string) => {
  const r = await db.query.signingRequests.findFirst({
    where: eq(signingRequests.id, id),
  });

  return r && (r.createdBy === userId || r.signerId === userId) ? r : null;
};

export interface SigningEventView {
  id: string;
  kind: string;
  what: string;
  actor: string;
  ip: string | null;
  userAgent: string | null;
  detail: string | null;
  at: string;
}

const eventView = (e: SigningEvent): SigningEventView => ({
  id: e.id,
  kind: e.kind,
  what: SIGNING_EVENT_LABEL.get(e.kind) ?? e.kind,
  actor: e.actor,
  ip: e.ip,
  userAgent: e.userAgent,
  detail: e.detail,
  at: e.createdAt,
});

const eventsOf = (db: Database, requestId: string): Promise<SigningEvent[]> =>
  db.query.signingEvents.findMany({
    where: eq(signingEvents.requestId, requestId),
    orderBy: (e, { asc }) => [asc(e.createdAt)],
  });

/** A request as its page shows it to the person who sent it or signs it for the workspace. */
export type SigningRequestView = SigningRow & {
  message: string;
  pageCount: number;
  fields: SigningField[];
  values: SigningValues;
  originalSha256: string;
  signedSha256: string | null;
  /** The signed copy in Drive, while it is there. */
  signedNodeId: string | null;
  /** The file it was made from, while it is there. */
  nodeId: string | null;
  expiresAt: string;
  customerSignedAt: string | null;
  signerSignedAt: string | null;
  completedAt: string | null;
  endedAt: string | null;
  declineReason: string | null;
  customerSignature: string | null;
  signerSignature: string | null;
  /** The customer's link, for the person who sent it, while it is open. */
  url: string | null;
  canCancel: boolean;
  canRemind: boolean;
  /** For the signer when it is their turn: whether they saved a signature to sign with. */
  savedSignature: string | null;
  events: SigningEventView[];
};

export const signingRequestView = async (
  env: Env,
  db: Database,
  userId: string,
  id: string,
  at = Date.now()
): Promise<SigningRequestView | null> => {
  const r = await ownRequest(db, userId, id);

  if (!r) {
    return null;
  }

  const rows = await rowsOf(db, userId, [r], at);
  const row = defined(rows[0], "the row of a request just found");
  const asker = r.createdBy === userId;

  const open =
    row.state === "awaiting-customer" || row.state === "awaiting-rivi";

  const token =
    asker && open ? await openSecret(env, SEAL_TOKEN, r.tokenSealed) : null;

  const events = await eventsOf(db, r.id);

  return {
    ...row,
    message: r.message,
    pageCount: r.pageCount,
    fields: fieldsOf(r),
    values: valuesOf(r),
    originalSha256: r.originalSha256,
    signedSha256: r.signedSha256,
    signedNodeId: r.signedNodeId,
    nodeId: r.nodeId,
    expiresAt: r.expiresAt,
    customerSignedAt: r.customerSignedAt,
    signerSignedAt: r.signerSignedAt,
    completedAt: r.completedAt,
    endedAt: r.endedAt,
    declineReason: r.declineReason,
    customerSignature: r.customerSignature,
    signerSignature: r.signerSignature,
    url: token ? signingUrl(env, token) : null,
    canCancel: asker && open,
    canRemind:
      asker &&
      row.state === "awaiting-customer" &&
      at - Date.parse(r.remindedAt ?? r.createdAt) >= REMIND_AFTER_MS,
    savedSignature: row.myTurn ? await handSignatureOf(db, userId) : null,
    events: events.map(eventView),
  };
};

export const signedName = (name: string): string => {
  const base = name.replace(/\.pdf$/iu, "");

  return `${base} (signed).pdf`;
};

const pdfResponse = async (env: Env, r: SigningRequest, signed: boolean) => {
  const key = signed ? r.signedKey : r.originalKey;

  if (!key) {
    return null;
  }

  const object = await env.DRIVE.get(key);

  if (!object) {
    return null;
  }

  const name = signed ? signedName(r.name) : r.name;

  return new Response(object.body, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${signed ? "attachment" : "inline"}; filename="${name.replaceAll(/["\r\n]/gu, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Content-Length": String(object.size),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'self'",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
};

/** The PDF of a request for its asker or signer: the original, or the signed copy once there is one. */
export const signingDocument = async (
  env: Env,
  db: Database,
  userId: string,
  id: string,
  signed: boolean
): Promise<Response | null> => {
  const r = await ownRequest(db, userId, id);

  if (!r) {
    return null;
  }

  return pdfResponse(env, r, signed);
};

/* ---------- the person's actions ---------- */

export const cancelSigningRequest = async (
  db: Database,
  user: User,
  id: string,
  origin: Origin,
  at = Date.now()
): Promise<void> => {
  const r = await ownRequest(db, user.id, id);

  if (!r || r.createdBy !== user.id) {
    throw new SigningError("Only who sent a request can cancel it.");
  }

  const state = signingState(r, at);

  if (state !== "awaiting-customer" && state !== "awaiting-rivi") {
    throw new SigningError("That request is not open any more.");
  }

  const now = new Date(at).toISOString();

  const [done] = await db
    .update(signingRequests)
    .set({ status: "cancelled", endedAt: now, updatedAt: now, codeHash: null })
    .where(
      and(
        eq(signingRequests.id, r.id),
        inArray(signingRequests.status, ["sent", "customer-signed"]),
        isNull(signingRequests.signerSignedAt)
      )
    )
    .returning({ id: signingRequests.id });

  if (!done) {
    throw new SigningError("That request is not open any more.");
  }

  await record(db, r.id, "cancelled", personOf(user), origin, at);
};

/** The request mailed to the customer again, once an hour at most. */
export const remindCustomer = async (
  env: Env,
  db: Database,
  user: User,
  id: string,
  origin: Origin,
  at = Date.now()
): Promise<void> => {
  const r = await ownRequest(db, user.id, id);

  if (!r || r.createdBy !== user.id) {
    throw new SigningError("Only who sent a request can send a reminder.");
  }

  if (signingState(r, at) !== "awaiting-customer") {
    throw new SigningError("The customer has nothing to sign now.");
  }

  if (at - Date.parse(r.remindedAt ?? r.createdAt) < REMIND_AFTER_MS) {
    throw new SigningError(
      "A mail went out within the hour. Wait a while, then remind again."
    );
  }

  const token = await openSecret(env, SEAL_TOKEN, r.tokenSealed);

  if (!token) {
    throw new SigningError("That request's link cannot be read any more.");
  }

  try {
    await mailRequest(env, db, user, r, signingUrl(env, token), true);
  } catch (error) {
    throw new SigningError(`The reminder was not sent: ${errorMessage(error)}`);
  }

  const now = new Date(at).toISOString();
  await db
    .update(signingRequests)
    .set({ remindedAt: now, updatedAt: now })
    .where(eq(signingRequests.id, r.id));
  await record(db, r.id, "reminded", personOf(user), origin, at);
};

/**
 * The signed copy in Drive, for the person who asked: beside the original when they may still add to its folder,
 * else at the root of their drive. Null when it could not be filed (the copy stays with the request).
 */
const fileSignedCopy = async (
  env: Env,
  db: Database,
  r: SigningRequest,
  bytes: Uint8Array
): Promise<string | null> => {
  const original = r.nodeId
    ? await db.query.driveNodes.findFirst({
        where: eq(driveNodes.id, r.nodeId),
      })
    : null;

  const parents =
    original && !original.trashedAt && original.parentId
      ? [original.parentId, null]
      : [null];

  const upload = async (parentId: string | null): Promise<string> => {
    const { node } = await startUpload(db, env, r.createdBy, {
      parentId,
      name: signedName(r.name),
      size: bytes.byteLength,
      contentType: "application/pdf",
      multipart: false,
    });

    await env.DRIVE.put(defined(node.r2Key, "the key of a new upload"), bytes, {
      httpMetadata: { contentType: "application/pdf" },
    });

    const { id: uploadId } = await finishUpload(env, db, r.createdBy, node.id);

    return uploadId;
  };

  for (const parentId of parents) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the next folder is tried only when this one refused the copy
      return await upload(parentId);
    } catch (error) {
      if (!(error instanceof DriveError)) {
        throw error;
      }
    }
  }

  return null;
};

/** The completed request's copy filed in Drive; when it cannot be, the copy stays with the request and it is noted. */
const fileInDrive = async (
  env: Env,
  db: Database,
  r: SigningRequest,
  bytes: Uint8Array,
  by: User,
  at: number
): Promise<void> => {
  try {
    const signedNodeId = await fileSignedCopy(env, db, r, bytes);

    if (signedNodeId) {
      await db
        .update(signingRequests)
        .set({ signedNodeId })
        .where(eq(signingRequests.id, r.id));
    }
  } catch (error) {
    log("drive.signing.file-failed", {
      requestId: r.id,
      error: errorMessage(error),
    });
    await record(
      db,
      r.id,
      "file-failed",
      personOf(by),
      null,
      at,
      errorMessage(error)
    );
  }
};

const makeSignedCopy = async (
  env: Env,
  db: Database,
  r: SigningRequest,
  rivi: { user: User; auto: boolean; origin: Origin | null },
  at: number
): Promise<Uint8Array> => {
  const object = await env.DRIVE.get(r.originalKey);

  if (!object) {
    throw new Error("the original is missing");
  }

  const original = new Uint8Array(await object.arrayBuffer());
  const events = await eventsOf(db, r.id);
  const asker = await person(db, r.createdBy);

  const customerSigned = events.findLast((e) => e.kind === "customer-signed");

  const riviSigned = events.findLast(
    (e) => e.kind === "signed" || e.kind === "auto-signed"
  );

  const customerSignature = fromBase64(
    defined(r.customerSignature, "the customer's signature")
  );

  const riviSignature = fromBase64(
    defined(r.signerSignature, "the workspace's signature")
  );

  return signedPdf({
    original,
    fields: fieldsOf(r),
    values: valuesOf(r),
    signatures: {
      customer: customerSignature,
      rivi: riviSignature,
    },
    certificate: {
      appName: env.APP_NAME,
      requestId: r.id,
      documentName: r.name,
      pageCount: r.pageCount,
      originalSha256: r.originalSha256,
      sentBy: asker ? `${asker.name} <${asker.email}>` : env.APP_NAME,
      sentAt: r.createdAt,
      signers: [
        {
          role: "Customer",
          name: r.customerName,
          email: r.customerEmail,
          signedAt: defined(r.customerSignedAt, "when the customer signed"),
          how: "Signed on the request's page, after confirming their address with a code mailed to it",
          ip: customerSigned?.ip ?? null,
          userAgent: customerSigned?.userAgent ?? null,
          signature: customerSignature,
        },
        {
          role: `For ${env.APP_NAME}`,
          name: rivi.user.name,
          email: rivi.user.email,
          signedAt: r.signerSignedAt ?? new Date(at).toISOString(),
          how: rivi.auto
            ? `Signed automatically with their saved signature, as they chose when sending the request`
            : `Signed in ${env.APP_NAME}, signed in to their account`,
          ip: riviSigned?.ip ?? null,
          userAgent: riviSigned?.userAgent ?? null,
          signature: riviSignature,
        },
      ],
      events: events.map((e) => ({
        at: e.createdAt,
        what: SIGNING_EVENT_LABEL.get(e.kind) ?? e.kind,
        who: e.actor,
        ip: e.ip,
      })),
    },
  });
};

/** The signed copy to the customer, from the asker's mailbox, the signer copied when it is someone else. */
const mailSignedCopy = async (
  env: Env,
  db: Database,
  r: SigningRequest,
  bytes: Uint8Array,
  at: number
) => {
  const asker = await person(db, r.createdBy);

  if (!asker) {
    return;
  }

  const signer = r.signerId === asker.id ? null : await person(db, r.signerId);
  const token = await openSecret(env, SEAL_TOKEN, r.tokenSealed);
  const attach = bytes.byteLength <= MAX_ATTACHMENT_BYTES;

  try {
    await sendAsPerson(env, db, asker, {
      to: [{ email: r.customerEmail, name: r.customerName }],
      cc: signer ? [{ email: signer.email, name: signer.name }] : [],
      subject: `Signed: ${r.name}`,
      text: [
        `Hello ${r.customerName},`,
        `"${r.name}" is signed by you and by ${env.APP_NAME}. ${attach ? "The signed copy is attached" : "The signed copy is too large to attach; download it from the link below"}, with a certificate of the signing on its last page.`,
        ...(token
          ? [
              `You can also download it here for ${SIGNING_DAYS} days:\n${signingUrl(env, token)}`,
            ]
          : []),
        `Its SHA-256, to check a copy against: ${r.signedSha256}`,
        `Kind regards,\n${asker.name}`,
      ].join("\n\n"),
      files: attach
        ? [
            {
              filename: signedName(r.name),
              contentType: "application/pdf",
              content: new Uint8Array(bytes).buffer,
            },
          ]
        : [],
    });
  } catch (error) {
    await record(
      db,
      r.id,
      "mail-failed",
      personOf(asker),
      null,
      at,
      errorMessage(error)
    );
  }
};

/**
 * The workspace's signature on a request the customer signed, then the signed copy: claimed first (one of two wins),
 * made and kept with the request, which completes, then filed in Drive and mailed to the customer. When the copy
 * cannot be made or kept, or the request not completed, the claim is taken back, so the signer can try again. Filing
 * comes only after: a request taken back leaves no copy in Drive, and a copy that cannot be filed stays with its
 * request.
 */
const finish = async (
  env: Env,
  db: Database,
  r: SigningRequest,
  rivi: { user: User; signature: string; origin: Origin | null; auto: boolean },
  at: number
): Promise<void> => {
  const fields = fieldsOf(r);
  const now = new Date(at).toISOString();
  const values = { ...valuesOf(r), ...datesFor(fields, "rivi", at) };

  const [claimed] = await db
    .update(signingRequests)
    .set({
      signerSignature: rivi.signature,
      signerSignedAt: now,
      valuesJson: JSON.stringify(values),
      updatedAt: now,
    })
    .where(
      and(
        eq(signingRequests.id, r.id),
        eq(signingRequests.status, "customer-signed"),
        isNull(signingRequests.signerSignedAt)
      )
    )
    .returning();

  if (!claimed) {
    throw new SigningError(
      "That request is signed already, or not open any more."
    );
  }

  await record(
    db,
    r.id,
    rivi.auto ? "auto-signed" : "signed",
    personOf(rivi.user),
    rivi.origin,
    at
  );

  let signed: Uint8Array;
  let signedSha256: string;

  try {
    signed = await makeSignedCopy(env, db, claimed, rivi, at);
    const signedKey = `signing/${r.id}/signed.pdf`;
    await env.DRIVE.put(signedKey, signed, {
      httpMetadata: { contentType: "application/pdf" },
    });
    signedSha256 = await bytesSha256(signed);
    await db
      .update(signingRequests)
      .set({
        status: "completed",
        signedKey,
        signedSha256,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(signingRequests.id, r.id));
  } catch (error) {
    await db
      .update(signingRequests)
      .set({
        signerSignature: null,
        signerSignedAt: null,
        valuesJson: r.valuesJson,
      })
      .where(
        and(
          eq(signingRequests.id, r.id),
          eq(signingRequests.status, "customer-signed")
        )
      );
    await record(
      db,
      r.id,
      "complete-failed",
      personOf(rivi.user),
      null,
      at,
      errorMessage(error)
    );
    log("drive.signing.complete-failed", {
      requestId: r.id,
      error: errorMessage(error),
    });
    throw new SigningError(
      `The signed copy could not be made: ${errorMessage(error)}`
    );
  }

  await record(
    db,
    r.id,
    "completed",
    personOf(rivi.user),
    null,
    at,
    signedSha256
  );
  log("drive.signing.completed", { requestId: r.id, auto: rivi.auto });
  await fileInDrive(env, db, claimed, signed, rivi.user, at);
  await mailSignedCopy(env, db, { ...claimed, signedSha256 }, signed, at);
};

/** The workspace's signer signs, with a signature drawn now or their saved one (`signature` null). */
export const signForRivi = async (
  env: Env,
  db: Database,
  user: User,
  id: string,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the page's post body, parsed by `checkSignature`
  signature: unknown,
  origin: Origin,
  at = Date.now()
): Promise<void> => {
  const r = await ownRequest(db, user.id, id);

  if (!r || r.signerId !== user.id) {
    throw new SigningError(
      "Only the person chosen can sign for the workspace."
    );
  }

  if (signingState(r, at) !== "awaiting-rivi") {
    throw new SigningError(
      r.status === "sent"
        ? "The customer signs first."
        : "That request is not open any more."
    );
  }

  let png: string;

  if (signature === null || signature === undefined || signature === "") {
    const saved = await handSignatureOf(db, user.id);

    if (!saved) {
      throw new SigningError("Draw or type your signature first.");
    }

    png = saved;
  } else {
    png = await checkSignature(signature);
  }

  await finish(env, db, r, { user, signature: png, origin, auto: false }, at);
};

/* ---------- the customer's side ---------- */

/** Whether the customer may still open a request: while it is open, and for `SIGNING_DAYS` after it was signed. */
const customerMayOpen = (r: SigningRequest, at: number): boolean => {
  const state = signingState(r, at);

  if (state === "completed") {
    return (
      !!r.completedAt &&
      Date.parse(r.completedAt) + SIGNING_DAYS * 86_400_000 > at
    );
  }

  return state === "awaiting-customer" || state === "awaiting-rivi";
};

/**
 * What a signing request brings to `visitor.server.ts`: the customer's code goes to their address and is recorded in
 * the request's history, and their pass lasts its 24 hours.
 */
export const requestVisits: Visits<SigningRequest> = {
  name: "signing",
  pass: { seal: "signing-pass", cookie: "sign_pass_", field: "r" },
  endsAt: () => null,
  codeTo: (r) => r.customerEmail,
  codeOpens: (r) => `"${r.name}" for signing`,
  codeSent: (r, { db, request, at }) =>
    record(
      db,
      r.id,
      "code-sent",
      customerOf(r),
      request && originOf(request),
      at
    ),
  confirmed: (r, { db, request, at }) =>
    record(
      db,
      r.id,
      "confirmed",
      customerOf(r),
      request && originOf(request),
      at
    ),
};

/**
 * The request a token opens, under the visitor's lookup throttle (`admit`), with whether the request carries the
 * customer's pass.
 */
const admitCustomer = async (
  env: Env,
  db: Database,
  request: Request,
  token: string,
  at: number
): Promise<{ r: SigningRequest; confirmed: boolean } | null | "throttled"> => {
  const r = await admit(env, request, requestVisits, async () =>
    token
      ? ((await db.query.signingRequests.findFirst({
          where: eq(signingRequests.tokenHash, await sha256Hex(token)),
        })) ?? null)
      : null
  );

  if (r === "throttled" || !r) {
    return r;
  }

  const passes = await readPasses(request, env, requestVisits, at);

  return { r, confirmed: passes.has(r.id) };
};

/** What `/s/sign/$token` shows. */
export type CustomerPage =
  | { state: "throttled" }
  | {
      state: "ended";
      why: "declined" | "cancelled" | "expired";
      name: string;
      from: string;
    }
  | { state: "confirm"; name: string; from: string; email: string }
  | {
      state: "sign";
      name: string;
      from: string;
      customerName: string;
      message: string;
      pageCount: number;
      fields: SigningField[];
      /** The workspace's texts and boxes, as the customer signs them. */
      values: SigningValues;
      expiresAt: string;
    }
  | { state: "signed"; name: string; from: string; signedAt: string }
  | { state: "completed"; name: string; from: string; completedAt: string };

export const customerPage = async (
  env: Env,
  db: Database,
  request: Request,
  token: string,
  at = Date.now()
): Promise<CustomerPage | null> => {
  const admitted = await admitCustomer(env, db, request, token, at);

  if (admitted === "throttled") {
    return { state: "throttled" };
  }

  if (!admitted) {
    return null;
  }

  const { r, confirmed } = admitted;
  const creator = await person(db, r.createdBy);
  const from = creator?.name ?? env.APP_NAME;
  const state = signingState(r, at);

  if (state === "declined" || state === "cancelled" || state === "expired") {
    return { state: "ended", why: state, name: r.name, from };
  }

  if (!customerMayOpen(r, at)) {
    return null;
  }

  if (!confirmed) {
    return {
      state: "confirm",
      name: r.name,
      from,
      email: maskEmail(r.customerEmail),
    };
  }

  if (state === "completed") {
    return {
      state: "completed",
      name: r.name,
      from,
      completedAt: defined(r.completedAt, "when the request completed"),
    };
  }

  if (state === "awaiting-rivi") {
    return {
      state: "signed",
      name: r.name,
      from,
      signedAt: defined(r.customerSignedAt, "when the customer signed"),
    };
  }

  return {
    state: "sign",
    name: r.name,
    from,
    customerName: r.customerName,
    message: r.message,
    pageCount: r.pageCount,
    fields: fieldsOf(r),
    values: valuesOf(r),
    expiresAt: r.expiresAt,
  };
};

/** The PDF on the customer's page (with their pass): the original, or the signed copy once there is one. */
export const customerDocument = async (
  env: Env,
  db: Database,
  request: Request,
  token: string,
  signed: boolean,
  at = Date.now()
): Promise<Response> => {
  const admitted = await admitCustomer(env, db, request, token, at);

  if (admitted === "throttled") {
    return tooManyRequests();
  }

  if (!admitted?.confirmed || !customerMayOpen(admitted.r, at)) {
    return notFound();
  }

  return (await pdfResponse(env, admitted.r, signed)) ?? notFound();
};

const tellSigner = async (
  env: Env,
  db: Database,
  r: SigningRequest,
  signer: User,
  at: number
) => {
  try {
    await mailOut(
      env,
      signer.email,
      env.APP_NAME,
      `${r.customerName} signed "${r.name}": your signature is next`,
      [
        `${r.customerName} (${r.customerEmail}) signed "${r.name}".`,
        `Sign it for the workspace here:\n${appUrl(env, signingHref(r.id))}`,
      ].join("\n\n")
    );
  } catch (error) {
    await record(
      db,
      r.id,
      "mail-failed",
      personOf(signer),
      null,
      at,
      errorMessage(error)
    );
  }
};

/** Why the workspace's signature was not added automatically. */
const autoSignHeld = (signer: User): string =>
  signer.active ? "No saved signature" : "Deactivated";

/**
 * The customer signs: their fields as they filled them, their signature, and their consent to sign electronically.
 * With `auto_sign`, the workspace signs at once with the asker's saved signature; else its signer is told it is their
 * turn.
 */
export const customerSigns = async (
  env: Env,
  db: Database,
  r: SigningRequest,
  input: { values?: unknown; signature?: unknown; agree?: unknown },
  origin: Origin,
  at = Date.now()
): Promise<void> => {
  if (input.agree !== true) {
    throw new SigningError("Confirm that you agree to sign electronically.");
  }

  const fields = fieldsOf(r);
  const given = partyValues(fields, "customer", input.values, at);

  if ("error" in given) {
    throw new SigningError(given.error);
  }

  const signature = await checkSignature(input.signature);
  const now = new Date(at).toISOString();

  const [signed] = await db
    .update(signingRequests)
    .set({
      status: "customer-signed",
      customerSignature: signature,
      customerSignedAt: now,
      valuesJson: JSON.stringify({ ...valuesOf(r), ...given.values }),
      codeHash: null,
      updatedAt: now,
    })
    .where(
      and(eq(signingRequests.id, r.id), eq(signingRequests.status, "sent"))
    )
    .returning();

  if (!signed) {
    throw new SigningError("This request is not open for your signature.");
  }

  await record(db, r.id, "customer-signed", customerOf(r), origin, at);
  log("drive.signing.customer-signed", { requestId: r.id });

  const signer = await person(db, r.signerId);

  if (r.autoSign && signer) {
    const saved = await handSignatureOf(db, signer.id);

    if (saved && signer.active) {
      try {
        await finish(
          env,
          db,
          signed,
          { user: signer, signature: saved, origin: null, auto: true },
          at
        );

        return;
      } catch (error) {
        // The customer's signature stands; the signer finishes it by hand.
        if (!(error instanceof SigningError)) {
          throw error;
        }
      }
    } else {
      await record(
        db,
        r.id,
        "auto-sign-failed",
        personOf(signer),
        null,
        at,
        autoSignHeld(signer)
      );
    }
  }

  if (signer) {
    await tellSigner(env, db, signed, signer, at);
  }
};

/** The customer declines, with their reason; the asker is told. */
export const customerDeclines = async (
  env: Env,
  db: Database,
  r: SigningRequest,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the page's post body: this function is where it is parsed
  rawReason: unknown,
  origin: Origin,
  at = Date.now()
): Promise<void> => {
  const text = z.string().safeParse(rawReason);
  const reason = text.success ? text.data.trim().slice(0, MAX_MESSAGE) : "";

  const now = new Date(at).toISOString();

  const [done] = await db
    .update(signingRequests)
    .set({
      status: "declined",
      endedAt: now,
      declineReason: reason || null,
      codeHash: null,
      updatedAt: now,
    })
    .where(
      and(eq(signingRequests.id, r.id), eq(signingRequests.status, "sent"))
    )
    .returning({ id: signingRequests.id });

  if (!done) {
    throw new SigningError("This request is not open for your signature.");
  }

  await record(
    db,
    r.id,
    "declined",
    customerOf(r),
    origin,
    at,
    reason || undefined
  );
  const asker = await person(db, r.createdBy);

  if (!asker) {
    return;
  }

  try {
    await mailOut(
      env,
      asker.email,
      env.APP_NAME,
      `${r.customerName} declined to sign "${r.name}"`,
      [
        `${r.customerName} (${r.customerEmail}) declined to sign "${r.name}".`,
        reason ? `Their reason:\n${reason}` : "They gave no reason.",
        `The request: ${appUrl(env, signingHref(r.id))}`,
      ].join("\n\n")
    );
  } catch (error) {
    await record(
      db,
      r.id,
      "mail-failed",
      personOf(asker),
      null,
      at,
      errorMessage(error)
    );
  }
};

const answer = (body: { ok: boolean; error?: string }, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * What the page's script posts: an `intent` and, to sign, the values and signature; to decline, a reason.
 * Every key is optional: a decline carries no values and an unknown intent is answered by the handler below,
 * and each consumer checks what it reads (`customerSigns`, `customerDeclines`).
 */
const postSchema = z.looseObject({
  intent: z.unknown().optional(),
  values: z.unknown().optional(),
  signature: z.unknown().optional(),
  agree: z.unknown().optional(),
  reason: z.unknown().optional(),
});

/** The JSON posts of `customerPost`: signing and declining, which need the customer's pass. */
const customerJsonPost = async (
  env: Env,
  db: Database,
  request: Request,
  admitted: Awaited<ReturnType<typeof admitCustomer>>,
  at: number
): Promise<Response> => {
  if (admitted === "throttled") {
    return answer(
      { ok: false, error: "Too many attempts from here. Wait 15 minutes." },
      429
    );
  }

  if (
    !admitted?.confirmed ||
    signingState(admitted.r, at) !== "awaiting-customer"
  ) {
    return answer(
      { ok: false, error: "This request is not open for your signature." },
      409
    );
  }

  let parsed: ReturnType<typeof postSchema.safeParse>;

  try {
    parsed = postSchema.safeParse(await request.json());
  } catch {
    return answer({ ok: false, error: "That was not readable." }, 400);
  }

  if (!parsed.success) {
    return answer({ ok: false, error: "That was not readable." }, 400);
  }

  const body = parsed.data;
  const origin = originOf(request);

  try {
    if (body.intent === "sign") {
      await customerSigns(env, db, admitted.r, body, origin, at);
    } else if (body.intent === "decline") {
      await customerDeclines(env, db, admitted.r, body.reason, origin, at);
    } else {
      return answer({ ok: false, error: "Unknown action." }, 400);
    }

    return answer({ ok: true });
  } catch (error) {
    if (error instanceof SigningError) {
      return answer({ ok: false, error: error.message }, 422);
    }

    throw error;
  }
};

/**
 * The posts of `/s/sign/$token`. The code's forms (`send-code`, `code`) are classic form posts (`visitorPost`),
 * answered with a redirect back to the page (with the pass once the code was right, else an `error` or the `step` to
 * show). Signing and declining are JSON from the page's script (`{ intent: "sign", values, signature, agree }`, `{
 * intent: "decline", reason }`), answered with JSON, and need the pass. A post from another site is refused, by the
 * same rule for both (`sameOriginPost`).
 */
export const customerPost = async (
  env: Env,
  db: Database,
  request: Request,
  token: string,
  at = Date.now()
): Promise<Response> => {
  const json = (request.headers.get("content-type") ?? "").includes(
    "application/json"
  );

  if (!json) {
    return visitorPost(
      env,
      db,
      request,
      requestVisits,
      {
        path: customerSigningPath(token),
        form: () => request.formData(),
        row: async () => {
          const admitted = await admitCustomer(env, db, request, token, at);

          if (admitted === "throttled") {
            return admitted;
          }

          return admitted && customerMayOpen(admitted.r, at)
            ? admitted.r
            : null;
        },
      },
      at
    );
  }

  if (!sameOriginPost(request)) {
    return answer({ ok: false, error: "Refused." }, 403);
  }

  return customerJsonPost(
    env,
    db,
    request,
    await admitCustomer(env, db, request, token, at),
    at
  );
};
