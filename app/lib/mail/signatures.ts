/**
 * HTML signatures, shared by the editor in Settings, the server that saves them and the send that carries them. A
 * signature's images live in its markup as `data:` URIs: nothing to host (the console needs a session,
 * so no recipient could load a link to it), and on every send they become inline attachments (`cid:`), which mail
 * clients show without asking to load images.
 */
import { newId } from "../ids";
import { sanitizeHtml, withoutStyles } from "./sanitize";

/** The largest image a signature takes: a logo or a portrait, not a photo. */
export const MAX_SIGNATURE_IMAGE_BYTES = 256 * 1024;

/** The largest a signature's markup may be, its images included. */
export const MAX_SIGNATURE_HTML = 800_000;

/** The image types a signature takes, as the sanitiser lets a `data:` image through. */
export const SIGNATURE_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

/**
 * A signature's markup made safe to keep and to send: the sanitiser for mail that arrives (no script, no form, no
 * handler, no unsafe URL), nothing folded, the style blocks dropped (a client keeps inline styles only), and the
 * signature's own `data:` images kept.
 */
export const sanitizeSignatureHtml = (html: string): string =>
  withoutStyles(
    sanitizeHtml(html, {
      cidUrl: () => null,
      forward: true,
      dataImages: true,
    }).html
  ).trim();

export interface InlineImage {
  contentId: string;
  filename: string;
  contentType: string;
  /** The image as base64, as the `data:` URI held it. */
  base64: string;
}

/** Markup whose `data:` images became attachments. */
export interface InlinedHtml {
  html: string;
  images: InlineImage[];
}

const DATA_IMAGE_SRC =
  /(?<before><img\b[^>]*?\ssrc=")data:image\/(?<subtype>png|jpeg|gif|webp);base64,(?<base64>[a-z0-9+/]+=*)(?<after>")/giu;

/**
 * The `data:` images in a message's HTML as inline attachments: each `src` becomes a `cid:` reference, and an image
 * that appears twice goes once. Expects sanitised markup (every attribute value double-quoted).
 */
export const inlineDataImages = (html: string, domain: string): InlinedHtml => {
  const images: InlineImage[] = [];
  const seen = new Map<string, string>();

  const out = html.replaceAll(
    DATA_IMAGE_SRC,
    (_, before: string, subtype: string, base64: string, after: string) => {
      const key = `${subtype}:${base64}`;
      let contentId = seen.get(key);

      if (!contentId) {
        const n = images.length + 1;
        contentId = `sig${n}.${newId()}@${domain}`;
        seen.set(key, contentId);
        images.push({
          contentId,
          filename: `image${n}.${subtype.toLowerCase() === "jpeg" ? "jpg" : subtype.toLowerCase()}`,
          contentType: `image/${subtype.toLowerCase()}`,
          base64,
        });
      }

      return `${before}cid:${contentId}${after}`;
    }
  );

  return { html: out, images };
};

/** How many bytes a base64 string decodes to. */
export const base64Bytes = (base64: string): number => {
  const pad = base64.endsWith("==") ? 2 : Number(base64.endsWith("="));

  return Math.floor((base64.length * 3) / 4) - pad;
};
