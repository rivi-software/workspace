/**
 * The PDF side of signing (#2974), on pdf-lib: whether a PDF can be signed (and its pages), and the signed copy, with
 * what the signers filled in and their signatures drawn into the fields, and a certificate page at the end that
 * records the request, the original's SHA-256 and every step with its time, address and browser.
 *
 * A field's box is in fractions of its page as pdf.js shows it: the crop box, turned by the page's `/Rotate`. Each
 * box is mapped back onto the unrotated page and drawn turned the same way, so it lands where it was placed and
 * reads upright. A fillable original's own form is painted into its pages first and taken out (`flattenForm`), so the
 * values are drawn over its fields rather than hidden under them, and nobody can type over the signed copy.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  StandardFonts,
  concatTransformationMatrix,
  degrees,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  rgb,
} from "pdf-lib";
import type { PDFFont, PDFImage, PDFObject, PDFPage } from "pdf-lib";

import { defined, errorMessage } from "~/lib/guards";

import type { SigningField, SigningValues } from "./signing";

export class PdfError extends Error {
  override name = "PdfError";
}

/** The pages of a PDF that can be signed; a PDF that is protected or does not read is refused with why. */
export const readSignablePdf = async (
  bytes: Uint8Array
): Promise<{ pageCount: number }> => {
  let doc: PDFDocument;

  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    if (
      (error instanceof Error && error.name === "EncryptedPDFError") ||
      /encrypt/iu.test(errorMessage(error))
    ) {
      throw new PdfError(
        "This PDF is protected. Save a copy without a password or restrictions and send that."
      );
    }

    throw new PdfError("This file does not read as a PDF.");
  }

  if (doc.isEncrypted) {
    throw new PdfError(
      "This PDF is protected. Save a copy without a password or restrictions and send that."
    );
  }

  const pageCount = doc.getPageCount();

  if (!pageCount) {
    throw new PdfError("This PDF has no pages.");
  }

  return { pageCount };
};

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Whether `bytes` is a PNG a PDF can take, at most 2000 by 1000 pixels: what a signature is checked by. */
export const isSignaturePng = async (bytes: Uint8Array): Promise<boolean> => {
  if (bytes.length < 64 || PNG_MAGIC.some((b, i) => bytes[i] !== b)) {
    return false;
  }

  try {
    const probe = await PDFDocument.create();
    const image = await probe.embedPng(bytes);

    return (
      image.width > 0 &&
      image.height > 0 &&
      image.width <= 2000 &&
      image.height <= 1000
    );
  } catch {
    return false;
  }
};

/** One step on the certificate. */
export interface CertificateEvent {
  at: string;
  what: string;
  who: string;
  ip: string | null;
}

export interface Certificate {
  appName: string;
  requestId: string;
  documentName: string;
  pageCount: number;
  originalSha256: string;
  sentBy: string;
  sentAt: string;
  signers: {
    role: string;
    name: string;
    email: string;
    signedAt: string;
    how: string;
    ip: string | null;
    userAgent: string | null;
    signature: Uint8Array;
  }[];
  events: CertificateEvent[];
}

export interface SignedPdfInput {
  original: Uint8Array;
  fields: SigningField[];
  values: SigningValues;
  /** Each party's signature, a PNG. */
  signatures: { customer: Uint8Array; rivi: Uint8Array };
  certificate: Certificate;
}

const INK = rgb(0.06, 0.09, 0.2);
const MUTED = rgb(0.38, 0.4, 0.45);
const RULE = rgb(0.85, 0.86, 0.88);

/** Turns a point by `r` degrees, counter-clockwise as PDF space turns. */
const turn = (x: number, y: number, r: number): [number, number] => {
  const a = (r * Math.PI) / 180;

  return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
};

/**
 * A field's box on its page: `at(lx, ly)` is a point in the box's own frame (points from its bottom left, x along
 * its text) on the unrotated page, `width` and `height` its size in points, `rotate` how anything drawn in it turns.
 */
const boxOn = (page: PDFPage, f: SigningField) => {
  const crop = page.getCropBox();
  const r = (((page.getRotation().angle ?? 0) % 360) + 360) % 360;
  const W = crop.width;
  const H = crop.height;
  const quarter = r === 90 || r === 270;
  // The page as shown is H wide and W tall when it is turned a quarter.
  const shownW = quarter ? H : W;
  const shownH = quarter ? W : H;

  // A point of the shown page (fractions from its top left) on the unrotated page.
  const toPage = (u: number, v: number): [number, number] => {
    if (r === 90) {
      return [crop.x + v * W, crop.y + u * H];
    }

    if (r === 180) {
      return [crop.x + W - u * W, crop.y + v * H];
    }

    if (r === 270) {
      return [crop.x + W - v * W, crop.y + H - u * H];
    }

    return [crop.x + u * W, crop.y + H - v * H];
  };

  const [ox, oy] = toPage(f.x, f.y + f.h);

  return {
    width: f.w * shownW,
    height: f.h * shownH,
    rotate: degrees(r),
    at(lx: number, ly: number): [number, number] {
      const [dx, dy] = turn(lx, ly, r);

      return [ox + dx, oy + dy];
    },
  };
};

/** Text the standard fonts can write: anything outside WinAnsi becomes "?". */
const writable = (font: PDFFont, text: string): string => {
  let out = "";

  for (const ch of text.replaceAll(/[\r\n\t]+/gu, " ")) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += "?";
    }
  }

  return out;
};

const drawFieldText = (
  page: PDFPage,
  f: SigningField,
  font: PDFFont,
  raw: string
) => {
  const box = boxOn(page, f);
  const text = writable(font, raw);
  let size = Math.min(box.height * 0.7, 14);

  while (size > 5 && font.widthOfTextAtSize(text, size) > box.width - 2) {
    size -= 0.25;
  }

  // A text too long at the smallest size is cut where it leaves the box.
  let shown = text;

  while (shown && font.widthOfTextAtSize(shown, size) > box.width - 2) {
    shown = shown.slice(0, -1);
  }

  const [x, y] = box.at(1, (box.height - size) / 2 + size * 0.22);
  page.drawText(shown, { x, y, size, font, color: INK, rotate: box.rotate });
};

const drawCheck = (page: PDFPage, f: SigningField) => {
  const box = boxOn(page, f);
  const s = Math.min(box.width, box.height);
  const left = (box.width - s) / 2;
  const bottom = (box.height - s) / 2;

  const point = (fx: number, fy: number) => {
    const [x, y] = box.at(left + fx * s, bottom + fy * s);

    return { x, y };
  };

  const thickness = Math.max(1, s * 0.12);
  page.drawLine({
    start: point(0.15, 0.5),
    end: point(0.4, 0.2),
    thickness,
    color: INK,
  });
  page.drawLine({
    start: point(0.4, 0.2),
    end: point(0.88, 0.85),
    thickness,
    color: INK,
  });
};

const drawSignature = (page: PDFPage, f: SigningField, image: PDFImage) => {
  const box = boxOn(page, f);
  const scale = Math.min(box.width / image.width, box.height / image.height);
  const w = image.width * scale;
  const h = image.height * scale;
  const [x, y] = box.at((box.width - w) / 2, (box.height - h) / 2);
  page.drawImage(image, { x, y, width: w, height: h, rotate: box.rotate });
};

const A4: [number, number] = [595.28, 841.89];

const MARGIN = 56;

/** `text` broken into lines no wider than `width`, on spaces where it can and anywhere where it must. */
const wrap = (
  font: PDFFont,
  text: string,
  size: number,
  width: number
): string[] => {
  const lines: string[] = [];

  for (const para of writable(font, text).split(/\n/u)) {
    let line = "";

    for (const word of para.split(" ")) {
      const next = line ? `${line} ${word}` : word;

      if (font.widthOfTextAtSize(next, size) <= width) {
        line = next;
        continue;
      }

      if (line) {
        lines.push(line);
      }

      line = word;

      while (font.widthOfTextAtSize(line, size) > width) {
        let cut = line.length - 1;

        while (
          cut > 1 &&
          font.widthOfTextAtSize(line.slice(0, cut), size) > width
        ) {
          cut -= 1;
        }

        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }

    lines.push(line);
  }

  return lines;
};

const utc = (iso: string) => `${iso.slice(0, 19).replace("T", " ")} UTC`;

const certificatePages = async (doc: PDFDocument, c: Certificate) => {
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const width = A4[0] - MARGIN * 2;
  let page = doc.addPage(A4);
  let y = A4[1] - MARGIN;

  const room = (needed: number) => {
    if (y - needed >= MARGIN) {
      return;
    }

    page = doc.addPage(A4);
    y = A4[1] - MARGIN;
  };

  const lines = (
    text: string,
    opts: {
      font?: PDFFont;
      size?: number;
      color?: typeof INK;
      x?: number;
      w?: number;
    } = {}
  ) => {
    const font = opts.font ?? regular;
    const size = opts.size ?? 9.5;

    for (const line of wrap(font, text, size, opts.w ?? width)) {
      room(size + 4);
      y -= size + 3;
      page.drawText(line, {
        x: opts.x ?? MARGIN,
        y,
        size,
        font,
        color: opts.color ?? INK,
      });
    }
  };

  const gap = (h: number) => {
    y -= h;
  };

  const rule = () => {
    room(10);
    y -= 6;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: MARGIN + width, y },
      thickness: 0.5,
      color: RULE,
    });
    y -= 4;
  };

  // A row of two columns starts on a page with room for both first lines; `y` is compared across columns only
  // while the right one stayed on that page.
  const pair = (label: string, value: string, font = regular) => {
    room(14);
    const top = y;
    const start = page;
    lines(label, { color: MUTED, size: 8.5, w: 120 });
    const below = y;
    y = top;
    lines(value, {
      font,
      x: MARGIN + 130,
      w: width - 130,
      size: font === mono ? 8.5 : 9.5,
    });

    if (page === start) {
      y = Math.min(y, below);
    }

    gap(3);
  };

  lines("Signing certificate", { font: bold, size: 16 });
  gap(2);
  lines(`Issued by ${c.appName} when the last signature was given.`, {
    color: MUTED,
    size: 9,
  });
  rule();
  pair("Document", c.documentName);
  pair("Pages", `${c.pageCount} (and this certificate)`);
  pair("Request", c.requestId, mono);
  pair("Original SHA-256", c.originalSha256, mono);
  pair("Sent by", c.sentBy);
  pair("Sent", utc(c.sentAt));

  const images = await Promise.all(
    c.signers.map((s) => doc.embedPng(s.signature))
  );

  for (const [index, s] of c.signers.entries()) {
    rule();
    lines(s.role, { font: bold, size: 11 });
    gap(2);
    const image = defined(images[index], "the embedded signature");
    const scale = Math.min(180 / image.width, 50 / image.height);
    room(image.height * scale + 8);
    y -= image.height * scale + 4;
    page.drawImage(image, {
      x: MARGIN,
      y,
      width: image.width * scale,
      height: image.height * scale,
    });
    gap(4);
    pair("Name", s.name);
    pair("Email", s.email);
    pair("Signed", utc(s.signedAt));
    pair("How", s.how);

    if (s.ip) {
      pair("IP address", s.ip);
    }

    if (s.userAgent) {
      pair("Browser", s.userAgent.slice(0, 300));
    }
  }

  rule();
  lines("What happened", { font: bold, size: 11 });
  gap(2);

  for (const e of c.events) {
    room(13);
    const top = y;
    const start = page;
    lines(utc(e.at), { size: 8.5, color: MUTED, w: 130 });
    const below = y;
    y = top;
    lines(`${e.what}: ${e.who}${e.ip ? ` (${e.ip})` : ""}`, {
      size: 8.5,
      x: MARGIN + 140,
      w: width - 140,
    });

    if (page === start) {
      y = Math.min(y, below);
    }

    gap(2);
  }

  rule();
  lines(
    `This document was signed with simple electronic signatures. Each signer was identified as described above; the customer confirmed their email address with a one-time code mailed to it. The SHA-256 of this signed copy is kept by ${c.appName} with request ${c.requestId}, so a copy can be checked against it.`,
    { size: 8, color: MUTED }
  );
};

/* ---------- the original's own form ---------- */

/** The annotation flags that keep a field off the screen (PDF 32000-1, 12.5.3): Hidden and NoView. */
const HIDDEN = 2;
const NO_VIEW = 32;

const hasFlag = (flags: number, flag: number): boolean =>
  Math.floor(flags / flag) % 2 === 1;

/** A PDF array of numbers as numbers; anything else reads as missing. */
const numbersOf = (value: PDFObject | undefined): number[] | null => {
  if (!(value instanceof PDFArray)) {
    return null;
  }

  const numbers = value
    .asArray()
    .map((n) => (n instanceof PDFNumber ? n.asNumber() : Number.NaN));

  return numbers.every(Number.isFinite) ? numbers : null;
};

/** A rectangle in points: where its lower left corner is, and its size. */
interface RectBox {
  left: number;
  bottom: number;
  width: number;
  height: number;
}

/** A PDF rectangle (`[x1 y1 x2 y2]`, either corner first) as a box; anything else reads as missing. */
const rectBox = (rect: number[] | null): RectBox | null => {
  if (rect?.length !== 4) {
    return null;
  }

  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = rect;

  return {
    left: Math.min(x1, x2),
    bottom: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
};

const IDENTITY = [1, 0, 0, 1, 0, 0];

/** The box around `box` turned by the matrix `m` (`[a b c d e f]`), as a form's appearance is by its `/Matrix`. */
const turned = (box: RectBox, m: number[]): RectBox | null => {
  if (m.length !== 6) {
    return null;
  }

  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = m;
  const xs: number[] = [];
  const ys: number[] = [];

  for (const x of [box.left, box.left + box.width]) {
    for (const y of [box.bottom, box.bottom + box.height]) {
      xs.push(a * x + c * y + e);
      ys.push(b * x + d * y + f);
    }
  }

  return rectBox([
    Math.min(...xs),
    Math.min(...ys),
    Math.max(...xs),
    Math.max(...ys),
  ]);
};

/** A field's look as it stands: its normal appearance, or the one for its state (a box ticked or not). */
const appearanceOf = (doc: PDFDocument, widget: PDFDict): PDFRef | null => {
  const appearances = widget.lookup(PDFName.of("AP"));

  if (!(appearances instanceof PDFDict)) {
    return null;
  }

  let normal = appearances.get(PDFName.of("N"));
  const states = appearances.lookup(PDFName.of("N"));

  if (states instanceof PDFDict) {
    const state = widget.lookup(PDFName.of("AS"));
    normal = state instanceof PDFName ? states.get(state) : undefined;
  }

  return normal instanceof PDFRef &&
    doc.context.lookup(normal) instanceof PDFStream
    ? normal
    : null;
};

/**
 * Where an appearance goes on its page (PDF 32000-1, 12.5.5): its bounding box, turned by its own matrix, fitted
 * onto the field's rectangle. Answers the matrix to draw it with, or null for a field with nothing to show.
 */
const placement = (stream: PDFStream, rect: number[]) => {
  const box = rectBox(numbersOf(stream.dict.lookup(PDFName.of("BBox"))));

  const shown =
    box &&
    turned(
      box,
      numbersOf(stream.dict.lookup(PDFName.of("Matrix"))) ?? IDENTITY
    );

  const field = rectBox(rect);

  if (!(shown && field)) {
    return null;
  }

  const sx = field.width / shown.width;
  const sy = field.height / shown.height;

  if (!(Number.isFinite(sx) && Number.isFinite(sy) && sx > 0 && sy > 0)) {
    return null;
  }

  return [
    sx,
    0,
    0,
    sy,
    field.left - shown.left * sx,
    field.bottom - shown.bottom * sy,
  ] as const;
};

/** A form field painted into its page as a viewer shows it, unless it is hidden. */
const paintField = (doc: PDFDocument, page: PDFPage, widget: PDFDict) => {
  const flags = widget.lookup(PDFName.of("F"));

  if (
    flags instanceof PDFNumber &&
    (hasFlag(flags.asNumber(), HIDDEN) || hasFlag(flags.asNumber(), NO_VIEW))
  ) {
    return;
  }

  const ref = appearanceOf(doc, widget);
  const rect = numbersOf(widget.lookup(PDFName.of("Rect")));
  const stream = ref ? doc.context.lookup(ref) : null;

  if (!(ref && rect && stream instanceof PDFStream)) {
    return;
  }

  const matrix = placement(stream, rect);

  if (!matrix) {
    return;
  }

  const name = page.node.newXObject("FormField", ref);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(...matrix),
    drawObject(name),
    popGraphicsState()
  );
};

/**
 * A fillable original's form, painted into its pages and taken out. A viewer draws a form's fields over the page, so
 * the values drawn into it sat under them: a form's grey boxes hid every text and date, and only signatures, where its
 * signature fields draw nothing, showed. A live form would also let anyone type over the signed copy. Each field shows
 * as it did on the signing pages, where pdf.js draws it; one without a look of its own (a form that leaves it to the
 * viewer) gets one from pdf-lib first.
 */
const flattenForm = (doc: PDFDocument, font: PDFFont) => {
  if (!doc.catalog.has(PDFName.of("AcroForm"))) {
    return;
  }

  try {
    doc.getForm().updateFieldAppearances(font);
  } catch {
    // A field pdf-lib cannot draw keeps the look it has, or shows nothing, as it would have in many viewers.
  }

  for (const page of doc.getPages()) {
    const annots = page.node.lookup(PDFName.of("Annots"));

    if (!(annots instanceof PDFArray)) {
      continue;
    }

    const kept = annots.asArray().filter((entry) => {
      const annot = doc.context.lookup(entry);

      if (
        !(annot instanceof PDFDict) ||
        annot.lookup(PDFName.of("Subtype")) !== PDFName.of("Widget")
      ) {
        return true;
      }

      paintField(doc, page, annot);

      return false;
    });

    page.node.set(PDFName.of("Annots"), doc.context.obj(kept));
  }

  doc.catalog.delete(PDFName.of("AcroForm"));
};

/** The signed copy: the original's form flattened, the fields drawn over it, and the certificate after its last page. */
export const signedPdf = async (input: SignedPdfInput): Promise<Uint8Array> => {
  const doc = await PDFDocument.load(input.original, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // Before the fields, so they are drawn over the form's own.
  flattenForm(doc, font);

  const images = {
    customer: await doc.embedPng(input.signatures.customer),
    rivi: await doc.embedPng(input.signatures.rivi),
  };

  const pages = doc.getPages();

  for (const f of input.fields) {
    const page = pages[f.page];

    if (!page) {
      continue;
    }

    if (f.kind === "signature") {
      drawSignature(page, f, images[f.party]);
    } else if (f.kind === "checkbox") {
      if (input.values[f.id] === "yes") {
        drawCheck(page, f);
      }
    } else {
      const value = input.values[f.id];

      if (value) {
        drawFieldText(page, f, font, value);
      }
    }
  }

  await certificatePages(doc, input.certificate);
  doc.setProducer(input.certificate.appName);
  doc.setModificationDate(new Date());

  return doc.save();
};

/* ---------- the certificate ---------- */
