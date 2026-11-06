/**
 * What the signing tests share (#2974): a PDF in a person's Drive, the fields a request places on it, a request sent as
 * the editor sends it, and the customer's browser through the mailed code and the page's JSON posts.
 */
import { env } from "cloudflare:workers";
import {
  PDFArray,
  PDFDocument,
  PDFRawStream,
  decodePDFRawStream,
  degrees,
} from "pdf-lib";
import { expect } from "vitest";

import { finishUpload, startUpload } from "~/lib/drive/drive.server";
import type { SigningField } from "~/lib/drive/signing";
import { createSigningRequest, customerPost } from "~/lib/drive/signing.server";
import type { NewSigningRequest } from "~/lib/drive/signing.server";

import { db, defined, mailbox, recordingEmail } from "./fixtures";
import { stubEnv } from "./stub-env";

/** A 40 by 16 PNG with a stroke on it: a signature as the pages send it. */
export const SIGNATURE =
  "iVBORw0KGgoAAAANSUhEUgAAACgAAAAQCAYAAABk1z2tAAAAWUlEQVR4nGNgGAWjYIgDEbmA/9jwQLsLDHA5blA4lBjHUepIsF5SDSHWckociqKHFAPIsZBUPRjqyQ0RYhxHql686midnqhiBz1yJMV20KO4GHRF0igYSAAALVq0eUj+sSEAAAAASUVORK5CYII=";

export const origin = { ip: "198.51.100.7", userAgent: "vitest" };

export const pdfBytes = async (pages = 2, rotate = 0): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();

  for (let i = 0; i < pages; i += 1) {
    doc.addPage([595, 842]).setRotation(degrees(rotate));
  }

  return doc.save();
};

export const putFile = async (
  userId: string,
  name: string,
  bytes: Uint8Array,
  contentType: string
) => {
  const { node } = await startUpload(db, env, userId, {
    parentId: null,
    name,
    size: bytes.byteLength,
    contentType,
    multipart: false,
  });

  await env.DRIVE.put(defined(node.r2Key), bytes, {
    httpMetadata: { contentType },
  });

  return finishUpload(env, db, userId, node.id);
};

export const FIELDS: SigningField[] = [
  {
    id: "c-sig",
    kind: "signature",
    party: "customer",
    page: 0,
    x: 0.1,
    y: 0.8,
    w: 0.3,
    h: 0.06,
    label: "Signature",
    required: true,
  },
  {
    id: "c-name",
    kind: "text",
    party: "customer",
    page: 0,
    x: 0.1,
    y: 0.7,
    w: 0.3,
    h: 0.03,
    label: "Full name",
    required: true,
  },
  {
    id: "c-date",
    kind: "date",
    party: "customer",
    page: 0,
    x: 0.1,
    y: 0.75,
    w: 0.2,
    h: 0.03,
    label: "Date",
    required: true,
  },
  {
    id: "c-ok",
    kind: "checkbox",
    party: "customer",
    page: 1,
    x: 0.1,
    y: 0.1,
    w: 0.03,
    h: 0.02,
    label: "I agree to the terms",
    required: true,
  },
  {
    id: "r-sig",
    kind: "signature",
    party: "rivi",
    page: 1,
    x: 0.6,
    y: 0.8,
    w: 0.3,
    h: 0.06,
    label: "Signature",
    required: true,
  },
  {
    id: "r-title",
    kind: "text",
    party: "rivi",
    page: 1,
    x: 0.6,
    y: 0.7,
    w: 0.3,
    h: 0.03,
    label: "Title",
    required: true,
  },
  {
    id: "r-date",
    kind: "date",
    party: "rivi",
    page: 1,
    x: 0.6,
    y: 0.75,
    w: 0.2,
    h: 0.03,
    label: "Date",
    required: true,
  },
];

let ips = 0;

export const visitor = (
  path: string,
  init: RequestInit = {},
  cookie?: string
) => {
  const headers = new Headers(init.headers);

  // A client of its own unless the test names one: the throttles count per client.
  if (!headers.has("cf-connecting-ip")) {
    ips += 1;
    headers.set("cf-connecting-ip", `203.0.113.${ips % 250}`);
  }

  if (cookie) {
    headers.set("cookie", cookie);
  }

  return new Request(`${env.APP_URL}${path}`, { ...init, headers });
};

/** A request on a fresh PDF, sent as the editor sends it, from an env that records its mail. */
export const sent = async (
  local: string,
  over: Partial<NewSigningRequest> = {}
) => {
  const asker = await mailbox(local, `${local} Asker`);

  const file = await putFile(
    asker.id,
    "Contract.pdf",
    await pdfBytes(),
    "application/pdf"
  );

  const recorded = recordingEmail();

  const mail = {
    sent: recorded.sent,
    env: stubEnv({ ...recorded.env }),
  };

  const { request, url } = await createSigningRequest(
    mail.env,
    db,
    asker,
    {
      nodeId: file.id,
      customerName: "Cas Customer",
      customerEmail: "Cas@Example.org",
      signerId: asker.id,
      autoSign: false,
      message: "Here is the contract we discussed.",
      fields: FIELDS,
      riviValues: { "r-title": "Director" },
      ...over,
    },
    origin
  );

  return {
    asker,
    file,
    mail,
    request,
    url,
    token: defined(url.split("/s/sign/")[1]),
  };
};

export const form = (fields: Record<string, string>) => {
  const body = new FormData();

  for (const [k, v] of Object.entries(fields)) {
    body.set(k, v);
  }

  return body;
};

/** The customer through the code: the pass cookie their browser carries. */
export const confirmed = async (
  token: string,
  mailEnv: Env,
  outbox: { subject?: unknown }[]
) => {
  const before = outbox.length;

  const asked = await customerPost(
    mailEnv,
    db,
    visitor(`/s/sign/${token}`, {
      method: "POST",
      body: form({ intent: "send-code" }),
    }),
    token
  );

  expect(asked.headers.get("location")).toContain("step=code");

  const [code] = defined(
    String(defined(outbox[before]).subject).match(/\d{6}/u)
  );

  const done = await customerPost(
    mailEnv,
    db,
    visitor(`/s/sign/${token}`, {
      method: "POST",
      body: form({ intent: "code", code }),
    }),
    token
  );

  const cookie = done.headers.get("set-cookie");
  expect(cookie).toMatch(/^sign_pass_sr_/u);
  expect(cookie).toContain("Path=/s/");

  return defined(defined(cookie).split(";")[0]);
};

/** What the signing page's script posts, as JSON, to its own route. */
export interface SigningPost {
  intent: "sign" | "decline";
  values?: Record<string, string>;
  signature?: string;
  agree?: boolean;
  reason?: string;
}

export const postJson = (
  mailEnv: Env,
  token: string,
  cookie: string,
  body: SigningPost
) =>
  customerPost(
    mailEnv,
    db,
    visitor(
      `/s/sign/${token}`,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
        },
      },
      cookie
    ),
    token
  );

/** The text a PDF draws, page by page: what the signed copy and its certificate say. */
export const drawnText = (doc: PDFDocument): { page: number; text: string }[] =>
  doc.getPages().flatMap((page, n) => {
    const contents = page.node.Contents();

    const streams =
      contents instanceof PDFArray
        ? contents.asArray().map((ref) => doc.context.lookup(ref))
        : [contents];

    return streams.flatMap((stream) => {
      if (!(stream instanceof PDFRawStream)) {
        return [];
      }

      const ops = Array.from(decodePDFRawStream(stream).decode(), (b) =>
        String.fromCodePoint(b)
      );

      return [...ops.join("").matchAll(/<(?<hex>[0-9A-Fa-f]*)>\s*Tj/gu)].map(
        ([, hex]) => ({
          page: n,
          text: (hex.match(/../gu) ?? [])
            .map((h) => String.fromCodePoint(Number.parseInt(h, 16)))
            .join(""),
        })
      );
    });
  });
