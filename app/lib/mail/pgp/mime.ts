/**
 * The MIME OpenPGP needs, read and written here rather than through postal-mime: a signature covers a part's exact
 * bytes (RFC 3156 §5), which a parser that decodes everything cannot hand back, and a signed or encrypted message is
 * written out in full before it is sent. Text is kept one character per byte (`byteString`), so a part cut out by its
 * offsets turns back into the bytes it was. Every reader walks its input once, with `indexOf`, never a regular
 * expression that searches again from each start (#3591).
 */
import type { Address } from "~/db/schema";

export const CRLF = "\r\n";

/** Bytes as a string of one character per byte (not Latin-1 decoding, which maps 0x80 to 0x9f elsewhere). */
export const byteString = (bytes: Uint8Array): string => {
  let out = "";

  for (let i = 0; i < bytes.length; i += 0x80_00) {
    out += String.fromCodePoint(...bytes.subarray(i, i + 0x80_00));
  }

  return out;
};

/** The bytes a `byteString` holds. */
export const stringBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(s.length);

  for (let i = 0; i < s.length; i += 1) {
    // One character per byte by construction; the remainder keeps a stray wider character from overflowing.
    out[i] = (s.codePointAt(i) ?? 0) % 256;
  }

  return out;
};

export interface Header {
  /** Lower-cased. */
  name: string;
  /** Unfolded, trimmed. */
  value: string;
}

/** A MIME entity cut at its first empty line: the header block as written, its headers read, and the body. */
export interface Entity {
  head: string;
  headers: Header[];
  body: string;
}

/** Where a line ends, before its line break, and where the next one starts. */
interface Line {
  end: number;
  next: number;
}

/** The line that starts at `from`, ended by CRLF or a bare LF. */
const lineAt = (s: string, from: number): Line => {
  const lf = s.indexOf("\n", from);

  if (lf === -1) {
    return { end: s.length, next: s.length };
  }

  return { end: lf > from && s[lf - 1] === "\r" ? lf - 1 : lf, next: lf + 1 };
};

const readHeaders = (head: string): Header[] => {
  const headers: Header[] = [];
  let at = 0;

  while (at < head.length) {
    const { end, next } = lineAt(head, at);
    const line = head.slice(at, end);
    at = next;

    const last = headers.at(-1);

    // A line that starts with white space goes on with the header above it (RFC 5322 §2.2.3).
    if ((line.startsWith(" ") || line.startsWith("\t")) && last) {
      last.value = `${last.value} ${line.trim()}`;
      continue;
    }

    const colon = line.indexOf(":");

    if (colon > 0) {
      headers.push({
        name: line.slice(0, colon).trim().toLowerCase(),
        value: line.slice(colon + 1).trim(),
      });
    }
  }

  return headers;
};

/** An entity's header block and body; an entity with no empty line is all header. */
export const splitEntity = (s: string): Entity => {
  let at = 0;

  while (at < s.length) {
    const { end, next } = lineAt(s, at);

    if (end === at) {
      return {
        head: s.slice(0, at),
        headers: readHeaders(s.slice(0, at)),
        body: s.slice(next),
      };
    }

    at = next;
  }

  return { head: s, headers: readHeaders(s), body: "" };
};

/** A header block without the headers named (lower-cased), each with its folded lines; the rest as written. */
export const withoutHeaders = (
  head: string,
  names: readonly string[]
): string => {
  let out = "";
  let dropping = false;
  let at = 0;

  while (at < head.length) {
    const { next } = lineAt(head, at);
    const line = head.slice(at, next);
    at = next;

    if (!(line.startsWith(" ") || line.startsWith("\t"))) {
      const colon = line.indexOf(":");
      dropping =
        colon > 0 && names.includes(line.slice(0, colon).trim().toLowerCase());
    }

    if (!dropping) {
      out += line;
    }
  }

  return out;
};

export const headerValue = (headers: Header[], name: string): string | null =>
  headers.find((h) => h.name === name)?.value ?? null;

export interface ContentType {
  /** `type/subtype`, lower-cased; `text/plain` when the header is missing (RFC 2045 §5.2). */
  mediaType: string;
  /** Parameter names lower-cased, values unquoted. */
  params: Record<string, string>;
}

/** A Content-Type value: its media type and parameters, quoted strings and their escapes read in one pass. */
export const parseContentType = (value: string | null): ContentType => {
  if (!value) {
    return { mediaType: "text/plain", params: {} };
  }

  const semi = value.indexOf(";");

  const mediaType = (semi === -1 ? value : value.slice(0, semi))
    .trim()
    .toLowerCase();

  const params: Record<string, string> = {};
  let at = semi === -1 ? value.length : semi + 1;

  while (at < value.length) {
    const eq = value.indexOf("=", at);

    if (eq === -1) {
      break;
    }

    const name = value.slice(at, eq).trim().toLowerCase();
    let i = eq + 1;

    while (value[i] === " " || value[i] === "\t") {
      i += 1;
    }

    let param = "";

    if (value[i] === '"') {
      i += 1;

      while (i < value.length && value[i] !== '"') {
        if (value[i] === "\\" && i + 1 < value.length) {
          i += 1;
        }

        param += value[i];
        i += 1;
      }
    } else {
      const end = value.indexOf(";", i);
      param = value.slice(i, end === -1 ? value.length : end).trim();
    }

    // The next parameter starts after the `;` that follows this one's value (after its closing quote, if quoted).
    const next = value.indexOf(";", i);
    at = next === -1 ? value.length : next + 1;

    if (name) {
      params[name] = param;
    }
  }

  return { mediaType, params };
};

export const contentTypeOf = (headers: Header[]): ContentType =>
  parseContentType(headerValue(headers, "content-type"));

/**
 * The body parts of a multipart body, each exactly as written: from the line after its delimiter to the line break
 * before the next, which belongs to the delimiter (RFC 2046 §5.1.1). The preamble and the epilogue are left out; a
 * body that never closes ends its last part at its end.
 */
export const multipartParts = (body: string, boundary: string): string[] => {
  const delimiter = `--${boundary}`;
  const parts: string[] = [];
  let start = -1;
  let at = 0;

  while (at < body.length) {
    const { end, next } = lineAt(body, at);

    if (body.startsWith(delimiter, at)) {
      const rest = body.slice(at + delimiter.length, end);
      const closing = rest.startsWith("--");
      // Transport padding: white space may follow a delimiter.
      const tail = closing ? rest.slice(2) : rest;

      if (tail.trim() === "") {
        if (start !== -1) {
          const breakBefore = at >= 2 && body[at - 2] === "\r" ? 2 : 1;
          parts.push(body.slice(start, Math.max(start, at - breakBefore)));
        }

        if (closing) {
          return parts;
        }

        start = next;
      }
    }

    at = next;
  }

  if (start !== -1 && start < body.length) {
    parts.push(body.slice(start));
  }

  return parts;
};

/** Every line break made CRLF, as a signature over MIME is computed (RFC 3156 §5). */
export const canonicalLineEnds = (s: string): string => {
  let out = "";
  let at = 0;

  while (at < s.length) {
    const { end, next } = lineAt(s, at);
    out += s.slice(at, end);

    if (next > end) {
      out += CRLF;
    }

    at = next;
  }

  return out;
};

const QP_HEX = "0123456789ABCDEFabcdef";

/** A quoted-printable body as the bytes it stands for (RFC 2045 §6.7), soft line breaks taken out. */
const decodeQuotedPrintable = (s: string): string => {
  let out = "";

  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];

    if (c !== "=") {
      out += c;
      continue;
    }

    if (s[i + 1] === "\r" && s[i + 2] === "\n") {
      i += 2;
    } else if (s[i + 1] === "\n") {
      i += 1;
    } else if (
      QP_HEX.includes(s[i + 1] ?? "x") &&
      QP_HEX.includes(s[i + 2] ?? "x")
    ) {
      out += String.fromCodePoint(Number.parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out += c;
    }
  }

  return out;
};

/** A part's body as the bytes it stands for, by its Content-Transfer-Encoding. */
export const decodedBody = (entity: Entity): string => {
  const encoding = (
    headerValue(entity.headers, "content-transfer-encoding") ?? "7bit"
  ).toLowerCase();

  if (encoding === "base64") {
    try {
      return atob(entity.body.replaceAll(/[^A-Za-z0-9+/=]/gu, ""));
    } catch {
      return "";
    }
  }

  return encoding === "quoted-printable"
    ? decodeQuotedPrintable(entity.body)
    : entity.body;
};

// ---------- writing ----------

/** A header value with no line break in it: whatever a person typed into a subject or a name stays on its line. */
const oneLine = (value: string): string => value.replaceAll(/[\r\n]+/gu, " ");

const isPrintableAscii = (s: string): boolean => {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.codePointAt(i) ?? 0;

    if (c < 0x20 || c > 0x7e) {
      return false;
    }
  }

  return true;
};

const utf8Base64 = (s: string): string =>
  btoa(byteString(new TextEncoder().encode(s)));

/**
 * Text that is not plain ASCII as RFC 2047 encoded words, each at most 75 characters and cut between characters, never
 * inside one; plain ASCII as it is.
 */
export const encodedWords = (text: string): string => {
  const value = oneLine(text);

  if (isPrintableAscii(value)) {
    return value;
  }

  const words: string[] = [];
  let chunk = "";

  for (const char of value) {
    // 45 bytes of UTF-8 make 60 characters of base64, which with `=?UTF-8?B?` and `?=` is 72.
    if (new TextEncoder().encode(chunk + char).length > 45) {
      words.push(`=?UTF-8?B?${utf8Base64(chunk)}?=`);
      chunk = "";
    }

    chunk += char;
  }

  if (chunk) {
    words.push(`=?UTF-8?B?${utf8Base64(chunk)}?=`);
  }

  return words.join(" ");
};

/** `Name <address>` for a header: the name quoted when it holds a special, encoded when it is not ASCII. */
export const headerAddress = (a: Address): string => {
  const name = a.name ? oneLine(a.name).trim() : "";

  if (!name) {
    return a.email;
  }

  if (!isPrintableAscii(name)) {
    return `${encodedWords(name)} <${a.email}>`;
  }

  // Atoms and spaces stand as they are; anything else (a dot, a comma, a bracket) needs the quotes.
  if (/^[\w !#$%&'*+/=?^`{|}~-]+$/u.test(name)) {
    return `${name} <${a.email}>`;
  }

  return `"${name.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}" <${a.email}>`;
};

/** A header line folded at its spaces, each line at most 78 characters where the words allow (RFC 5322 §2.2.3). */
export const headerLine = (name: string, value: string): string => {
  const words = oneLine(value).split(" ").filter(Boolean);
  let line = `${name}:`;
  const lines: string[] = [];

  for (const word of words) {
    if (line.length + 1 + word.length > 78 && line.length > name.length + 1) {
      lines.push(line);
      line = ` ${word}`;
    } else {
      line += ` ${word}`;
    }
  }

  lines.push(line);

  return lines.join(CRLF);
};

/** Bytes as base64 in lines of 76 characters (RFC 2045 §6.8). */
export const base64Lines = (bytes: Uint8Array): string => {
  const encoded = btoa(byteString(bytes));
  const lines: string[] = [];

  for (let i = 0; i < encoded.length; i += 76) {
    lines.push(encoded.slice(i, i + 76));
  }

  return lines.join(CRLF);
};

/** A parameter of Content-Type or Content-Disposition: quoted when it is ASCII, RFC 2231 `name*=UTF-8''…` when not. */
const param = (name: string, value: string): string => {
  const v = oneLine(value);

  if (isPrintableAscii(v)) {
    return `${name}="${v.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  }

  const encoded = [...new TextEncoder().encode(v)]
    .map((b) =>
      /[A-Za-z0-9!#$&+.^_`|~-]/u.test(String.fromCodePoint(b))
        ? String.fromCodePoint(b)
        : `%${b.toString(16).toUpperCase().padStart(2, "0")}`
    )
    .join("");

  return `${name}*=UTF-8''${encoded}`;
};

/** A MIME part to write: its header lines (already folded) and its body (already encoded, CRLF line ends). */
export interface Part {
  headers: string[];
  body: string;
}

/** A part as text: its headers, an empty line, its body. */
export const writePart = (part: Part): string =>
  [...part.headers, "", part.body].join(CRLF);

/** A random boundary; `=_` never occurs in base64, so no part written here can hold it. */
export const newBoundary = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(12));

  return `=_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
};

/** A text part in UTF-8, base64-encoded so it stays 7-bit and a signature over it survives any relay (RFC 3156 §3). */
export const textPart = (text: string, subtype: "plain" | "html"): Part => ({
  headers: [
    `Content-Type: text/${subtype}; charset="utf-8"`,
    "Content-Transfer-Encoding: base64",
  ],
  body: base64Lines(new TextEncoder().encode(canonicalLineEnds(text))),
});

/** A file as a part: an attachment, or an inline image its HTML names by Content-ID. */
export const filePart = (file: {
  filename: string;
  contentType: string;
  content: Uint8Array;
  inline?: boolean;
  contentId?: string | null;
}): Part => ({
  headers: [
    `Content-Type: ${oneLine(file.contentType) || "application/octet-stream"}; ${param("name", file.filename)}`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: ${file.inline ? "inline" : "attachment"}; ${param("filename", file.filename)}`,
    ...(file.contentId ? [`Content-ID: <${oneLine(file.contentId)}>`] : []),
  ],
  body: base64Lines(file.content),
});

/** Parts under one multipart Content-Type; `extra` adds parameters (`protocol`, `micalg`, `protected-headers`). */
export const multipart = (
  subtype: string,
  parts: Part[],
  options: { extra?: string; preamble?: string; headers?: string[] } = {}
): Part => {
  const boundary = newBoundary();

  return {
    headers: [
      `Content-Type: multipart/${subtype}; boundary="${boundary}"${options.extra ? `; ${options.extra}` : ""}`,
      ...(options.headers ?? []),
    ],
    body: [
      ...(options.preamble ? [options.preamble] : []),
      ...parts.flatMap((p) => [`--${boundary}`, writePart(p)]),
      `--${boundary}--`,
      "",
    ].join(CRLF),
  };
};

/** A Date header's value, as RFC 5322 writes one. */
export const mailDate = (date: Date): string =>
  date.toUTCString().replace("GMT", "+0000");
