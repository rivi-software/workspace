/**
 * A Drive file's bytes as a response, the same for the session's file route (`/api/drive/files/$id`) and a link's
 * (`/s/$token/file/$nodeId`): whoever asks has been through the gate already. Shown inline when the browser can (an
 * image, audio, video, a PDF, plain text), else, and always with `download`, as an attachment. Media seeks with Range
 * requests and a repeat visit revalidates on the ETag. The response is sandboxed by its own CSP, so a file never runs
 * script against this origin; a PDF may be framed by this origin's pages (`frame-ancestors 'self'`), nothing else may.
 */
import type { DriveNode } from "~/db/schema";

import { servesInline } from "./drive";

export interface ServeOptions {
  /** `?download=1`: an attachment, whatever the type. */
  download: boolean;
  /** Inline even where the type would download (a link that does not allow downloads shows what it can). */
  inline?: boolean;
  cacheControl: string;
  /** Headers of the caller's own (a link's `Referrer-Policy`, `X-Robots-Tag`). */
  headers?: Record<string, string>;
}

/** The file's response, or null when its object is not in the bucket. */
export const fileResponse = async (
  request: Request,
  bucket: R2Bucket,
  file: { node: DriveNode; key: string },
  options: ServeOptions
): Promise<Response | null> => {
  const { node } = file;
  const ranged = request.headers.has("range");

  const object = await bucket.get(file.key, {
    range: ranged ? request.headers : undefined,
    onlyIf: request.headers,
  });

  if (!object) {
    return null;
  }

  const inline =
    options.inline || (!options.download && servesInline(node.contentType));

  const pdf = node.contentType.toLowerCase() === "application/pdf";
  const filename = node.name.replaceAll(/["\r\n]/gu, "_");

  const headers = new Headers({
    "Content-Type": node.contentType,
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(node.name)}`,
    "Cache-Control": options.cacheControl,
    "Accept-Ranges": "bytes",
    ETag: object.httpEtag,
    "X-Content-Type-Options": "nosniff",
    // A PDF is shown by the browser's viewer, framed by the file page; everything else is sandboxed outright.
    "Content-Security-Policy": pdf
      ? "default-src 'none'; frame-ancestors 'self'"
      : "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "X-Frame-Options": pdf ? "SAMEORIGIN" : "DENY",
    ...options.headers,
  });

  if (!("body" in object)) {
    return new Response(null, { status: 304, headers });
  }

  // Only for a request that asked: a local bucket reports the whole object as a range on every read.
  if (ranged && object.range && "offset" in object.range) {
    const offset = object.range.offset ?? 0;
    const length = object.range.length ?? object.size - offset;
    headers.set(
      "Content-Range",
      `bytes ${offset}-${offset + length - 1}/${object.size}`
    );
    headers.set("Content-Length", String(length));

    return new Response(object.body, { status: 206, headers });
  }

  headers.set("Content-Length", String(object.size));

  return new Response(object.body, { headers });
};
