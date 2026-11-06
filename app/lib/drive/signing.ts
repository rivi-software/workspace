/**
 * Signing a PDF in Drive (#2974), the vocabulary the editor, the signing pages and the server share: the fields a
 * person places on the pages and for whom, the states of a request, the limits, the links. A plain module: the
 * client reads it too.
 */
import { z } from "zod";

/** Who a field is for: the customer outside the workspace, or the workspace (the person here who signs for it). */
export type SigningParty = "customer" | "rivi";

export type SigningFieldKind = "signature" | "text" | "date" | "checkbox";

/**
 * A field on a page. Its box is in fractions of the page as it is shown (rotation applied), from the top left, so it
 * holds at any zoom. A date is the day its party signs, filled in then; a signature is its party's one signature.
 */
export interface SigningField {
  id: string;
  kind: SigningFieldKind;
  party: SigningParty;
  /** From 0. */
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** What it asks for ("Full name", "I agree to the terms"), the placeholder its party sees. */
  label: string;
  required: boolean;
}

/** What the signers filled in, by field id: a text, "yes" for a ticked box, a date as `YYYY-MM-DD`. */
export type SigningValues = Record<string, string>;

/** The state a request is in, as the pages show it: `expired` is a request still waiting past its end. */
export type SigningState =
  | "awaiting-customer"
  | "awaiting-rivi"
  | "completed"
  | "declined"
  | "cancelled"
  | "expired";

/** How long a request stays open for the customer. */
export const SIGNING_DAYS = 30;

/** The largest PDF that can be sent for signing: the signed copy still fits in a mail. */
export const MAX_SIGNING_BYTES = 15 * 1024 * 1024;
export const MAX_FIELDS = 100;
export const MAX_FIELD_TEXT = 500;
export const MAX_LABEL = 80;
export const MAX_MESSAGE = 2000;

/** A signature's PNG, as base64. */
export const MAX_SIGNATURE_BASE64 = 300_000;

/** The smallest box a field can have, as a fraction of the page. */
export const MIN_FIELD = 0.01;

export const PARTY_LABEL: Record<SigningParty, string> = {
  customer: "Customer",
  rivi: "Workspace",
};

export const FIELD_KIND_LABEL: Record<SigningFieldKind, string> = {
  signature: "Signature",
  text: "Text",
  date: "Date signed",
  checkbox: "Checkbox",
};

/** The box a new field of each kind starts with, in fractions of an A4 page. */
export const FIELD_DEFAULT_SIZE: Record<
  SigningFieldKind,
  { w: number; h: number }
> = {
  signature: { w: 0.3, h: 0.06 },
  text: { w: 0.3, h: 0.03 },
  date: { w: 0.18, h: 0.03 },
  checkbox: { w: 0.03, h: 0.021 },
};

export const SIGNING_STATE_LABEL: Record<SigningState, string> = {
  "awaiting-customer": "Waiting for the customer",
  "awaiting-rivi": "Waiting for the workspace",
  completed: "Signed",
  declined: "Declined",
  cancelled: "Cancelled",
  expired: "Expired",
};

/** The pill a state wears. */
export const SIGNING_STATE_TONE: Record<
  SigningState,
  "neutral" | "accent" | "amber" | "red"
> = {
  "awaiting-customer": "amber",
  "awaiting-rivi": "amber",
  completed: "accent",
  declined: "red",
  cancelled: "neutral",
  expired: "neutral",
};

/**
 * A request's state at `at`. Only the customer's turn ends: once they signed, it waits for the workspace however long
 * that takes.
 */
export const signingState = (
  r: { status: string; expiresAt: string },
  at = Date.now()
): SigningState => {
  if (r.status === "completed") {
    return "completed";
  }

  if (r.status === "declined") {
    return "declined";
  }

  if (r.status === "cancelled") {
    return "cancelled";
  }

  if (r.status === "customer-signed") {
    return "awaiting-rivi";
  }

  return Date.parse(r.expiresAt) <= at ? "expired" : "awaiting-customer";
};

/** The pages of signing inside the workspace. */
export const SIGNING_LIST_HREF = "/drive/sign";

export const signingHref = (requestId: string): string =>
  `/drive/sign/r/${requestId}`;

export const newSigningHref = (nodeId: string): string =>
  `/drive/sign/new/${nodeId}`;

/** The PDF of a request inside the workspace: the original, or the signed copy once there is one. */
export const signingDocumentHref = (
  requestId: string,
  signed = false
): string =>
  `/api/drive/sign/${requestId}/document${signed ? "?signed=1" : ""}`;

/** The customer's page, and its PDF. */
export const customerSigningPath = (token: string): string =>
  `/s/sign/${token}`;

export const customerDocumentPath = (token: string, signed = false): string =>
  `/s/sign/${token}/document${signed ? "?signed=1" : ""}`;

/** Whether a file can be sent for signing: a PDF, by its type or its name. */
export const isPdf = (contentType: string, name: string): boolean =>
  contentType.toLowerCase() === "application/pdf" || /\.pdf$/iu.test(name);

/** A fraction of a page's width or height; anything else reads as missing. */
const fractionSchema = z.number().min(0).max(1).nullable().catch(null);

/** One field as the editor posts it: an id, kind and party that must read, the rest checked field by field. */
const fieldSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,32}$/iu),
  kind: z.enum(["signature", "text", "date", "checkbox"]),
  party: z.enum(["customer", "rivi"]),
  page: z.number().int().catch(-1),
  x: fractionSchema,
  y: fractionSchema,
  w: fractionSchema,
  h: fractionSchema,
  label: z
    .string()
    .catch("")
    .transform((label) => label.trim().slice(0, MAX_LABEL)),
  required: z.boolean().catch(true),
});

/**
 * The fields a request is sent with, read from what the editor posted: each on one of `pageCount` pages and inside
 * it, with a label of its own (else its kind's), a few of each party. Answers the fields, or what is wrong with them.
 */
export const parseFields = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the editor's post body: this function is where it is parsed
  raw: unknown,
  pageCount: number
): { fields: SigningField[] } | { error: string } => {
  if (!Array.isArray(raw)) {
    return { error: "The fields are missing." };
  }

  if (raw.length > MAX_FIELDS) {
    return { error: `A document takes at most ${MAX_FIELDS} fields.` };
  }

  const fields: SigningField[] = [];
  const ids = new Set<string>();

  for (const item of raw) {
    const parsed = fieldSchema.safeParse(item);

    if (!parsed.success || ids.has(parsed.data.id)) {
      return { error: "A field is not readable." };
    }

    const { id, kind, party, page, x, y, w, h, label, required } = parsed.data;

    if (page < 0 || page >= pageCount) {
      return { error: "A field is on a page the PDF does not have." };
    }

    if (
      x === null ||
      y === null ||
      w === null ||
      h === null ||
      w < MIN_FIELD ||
      h < MIN_FIELD
    ) {
      return { error: "A field is too small or off its page." };
    }

    if (x + w > 1.0001 || y + h > 1.0001) {
      return { error: "A field runs off its page." };
    }

    ids.add(id);

    fields.push({
      id,
      kind,
      party,
      page,
      x,
      y,
      w,
      h,
      label: label || FIELD_KIND_LABEL[kind],
      // A signature and a date are always given; a box may stay unticked unless it must be ticked.
      required: kind === "signature" || kind === "date" ? true : required,
    });
  }

  const unsigned = (["customer", "rivi"] as const).find(
    (party) => !fields.some((f) => f.party === party && f.kind === "signature")
  );

  if (unsigned) {
    return { error: `Place a signature field for ${PARTY_LABEL[unsigned]}.` };
  }

  return { fields };
};

/** Today in UTC as `YYYY-MM-DD`: what a date field holds. */
export const signingDate = (at = Date.now()): string =>
  new Date(at).toISOString().slice(0, 10);

/**
 * What one party filled in, checked against its fields: every required text given, every required box ticked,
 * nothing longer than `MAX_FIELD_TEXT`, and only its own fields (a date is set by the server, a signature is its
 * image). Answers its values, or what is missing.
 */
/** What a page posts for a party's fields: a text, or `true` for a ticked box, by field id. */
const givenSchema = z.record(
  z.string(),
  z
    .union([z.string(), z.literal(true)])
    .optional()
    .catch(undefined)
);

export const partyValues = (
  fields: SigningField[],
  party: SigningParty,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the page's post body: this function is where it is parsed
  given: unknown,
  at = Date.now()
): { values: SigningValues } | { error: string } => {
  const input = givenSchema.catch({}).parse(given);

  const values: SigningValues = {};

  for (const f of fields) {
    if (f.party !== party) {
      continue;
    }

    if (f.kind === "date") {
      values[f.id] = signingDate(at);
    } else if (f.kind === "text") {
      const text = z.string().safeParse(input[f.id]);
      const v = text.success ? text.data.trim() : "";

      if (v.length > MAX_FIELD_TEXT) {
        return {
          error: `"${f.label}" takes at most ${MAX_FIELD_TEXT} characters.`,
        };
      }

      if (f.required && !v) {
        return { error: `Fill in "${f.label}".` };
      }

      if (v) {
        values[f.id] = v;
      }
    } else if (f.kind === "checkbox") {
      const ticked = input[f.id] === "yes" || input[f.id] === true;

      if (f.required && !ticked) {
        return { error: `Tick "${f.label}".` };
      }

      if (ticked) {
        values[f.id] = "yes";
      }
    }
  }

  return { values };
};

/**
 * The workspace's own fields as the person asking filled them in the editor: they are part of what the customer
 * signs, so its signer signs them as they are. Answers the texts and boxes (the dates come when the workspace signs),
 * or what is missing.
 */
export const riviPrefill = (
  fields: SigningField[],
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the editor's post body, parsed by `partyValues`
  given: unknown
): { values: SigningValues } | { error: string } => {
  const read = partyValues(fields, "rivi", given);

  if ("error" in read) {
    return read;
  }

  const values: SigningValues = {};

  for (const f of fields) {
    const value = read.values[f.id];

    if (f.party === "rivi" && f.kind !== "date" && value !== undefined) {
      values[f.id] = value;
    }
  }

  return { values };
};

/** A party's date fields, filled with the day it signs. */
export const datesFor = (
  fields: SigningField[],
  party: SigningParty,
  at = Date.now()
) => {
  const values: SigningValues = {};

  for (const f of fields) {
    if (f.party === party && f.kind === "date") {
      values[f.id] = signingDate(at);
    }
  }

  return values;
};

/** What each step of a request reads as in its history and on the certificate. */
export const SIGNING_EVENT_LABEL: ReadonlyMap<string, string> = new Map(
  Object.entries({
    created: "Request made",
    sent: "Sent to the customer",
    reminded: "Reminder sent",
    "code-sent": "Code mailed to the customer",
    confirmed: "Email address confirmed",
    "customer-signed": "Signed by the customer",
    signed: "Signed for the workspace",
    "auto-signed": "Signed for the workspace automatically",
    "auto-sign-failed": "Could not sign automatically",
    completed: "Signed copy made",
    "complete-failed": "Signed copy could not be made",
    "file-failed": "Signed copy not filed in Drive",
    declined: "Declined by the customer",
    cancelled: "Cancelled",
    "mail-failed": "A mail was not sent",
  })
);

/** The `data:` URL of a signature kept as base64, for an `<img>`. */
export const signatureDataUrl = (base64: string): string =>
  `data:image/png;base64,${base64}`;
