import type { Address } from "~/db/schema";
import { defined } from "~/lib/guards";

import { formatAddress } from "./mail/addresses";
import { decodeEntities, withoutStyles } from "./mail/sanitize";

export const escapeHtml = (s: string): string =>
  s.replaceAll(/[&<>"']/gu, (c) =>
    defined(
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        c
      ],
      "the item"
    )
  );

const BLOCKS = new Set(
  "p div h1 h2 h3 h4 h5 h6 table tr ul ol li blockquote pre hr section article header footer dl dt dd address center figure figcaption".split(
    " "
  )
);

// A blank line around these, as a paragraph reads in plain text; a quote follows its attribution line directly.
const PARAGRAPHS = new Set(
  "p h1 h2 h3 h4 h5 h6 ul ol pre table figure".split(" ")
);

// Every line repeats its quote's `> ` and its list's indent, so nesting multiplies what a message reads as: a `<br>`
// two thousand blockquotes deep was four thousand characters (#2699). Deeper than this reads as this deep, and the
// reading stops at the budget.
export const MAX_DEPTH = 32;
export const MAX_TEXT = 1_000_000;

/**
 * The most HTML `htmlToText` reads: past it, the reading is the part's start. Gmail clips a message at 102 KB, and what
 * the composer sends carries its signature's images as `data:` URIs (`MAX_SIGNATURE_HTML`, 800,000 characters) above
 * the quote, so mail a person wrote stays below it; the bound holds down what a crafted part costs (#3565).
 */
export const MAX_HTML = 2_000_000;

// A tag's name, read from just after its `<`, or after the `/` of an end tag.
const TAG_NAME = /[a-zA-Z][\w:-]*/uy;

// The elements whose content is no text of the message, each with the search for its end tag.
const DROPPED: ReadonlyMap<string, RegExp> = new Map([
  ["style", /<\/style(?![\w:-])/giu],
  ["script", /<\/script(?![\w:-])/giu],
  ["head", /<\/head(?![\w:-])/giu],
  ["title", /<\/title(?![\w:-])/giu],
  ["template", /<\/template(?![\w:-])/giu],
]);

/** Where a tag's reading is: outside an attribute value (0), in a `"…"` one (1) or in a `'…'` one (2). */
type Quote = 0 | 1 | 2;

const QUOTE_OPENS: ReadonlyMap<string, Quote> = new Map([
  ['"', 1],
  ["'", 2],
]);

const QUOTE_CLOSES = ["", '"', "'"] as const;

const quoteAfter = (quote: Quote, c: string): Quote => {
  if (quote) {
    return c === QUOTE_CLOSES[quote] ? 0 : quote;
  }

  return QUOTE_OPENS.get(c) ?? 0;
};

/**
 * What reading an HTML part's markup has learnt so far, so that no search reads the same characters again for the
 * same answer: reading a whole part takes time linear in its length, whatever the markup (#3565).
 */
interface Scan {
  src: string;
  /**
   * For each `Quote`, the positions from which a tag read on in that quote reached the end of the part without its
   * `>`. The quote is all that decides how a tag reads on, so a later tag that comes to one of them in the same quote
   * ends nowhere either and stops there. Made on the first tag without its `>`.
   */
  endless: [Uint8Array, Uint8Array, Uint8Array] | null;
  /** The `DROPPED` elements one was opened without an end tag after it: no later one has one either. */
  unclosed: Set<string>;
  /** False once a `<!--` had no `-->` after it: no later one has either. */
  commentsEnd: boolean;
}

/** A tag, a comment, a doctype or a dropped element in the markup: from its `<` to where the text after it starts. */
interface Markup {
  start: number;
  end: number;
  /** A tag's name in lower case; null for what the reading skips (a comment, a doctype, a dropped element). */
  name: string | null;
  closing: boolean;
  attrs: string;
}

const skipped = (start: number, end: number): Markup => ({
  start,
  end,
  name: null,
  closing: false,
  attrs: "",
});

/** Notes the way a tag read from `from`, outside a quote, to `to` (the end, or a position noted before) without a `>`. */
const markEndless = (scan: Scan, from: number, to: number) => {
  const { src } = scan;
  scan.endless ??= [
    new Uint8Array(src.length),
    new Uint8Array(src.length),
    new Uint8Array(src.length),
  ];
  let quote: Quote = 0;

  for (let i = from; i < to; i += 1) {
    scan.endless[quote][i] = 1;
    quote = quoteAfter(quote, src.charAt(i));
  }
};

/** The `>` at or after `from` that ends a tag, the first outside a quoted attribute value, or -1 without one. */
const tagEnd = (scan: Scan, from: number): number => {
  const { src } = scan;
  let quote: Quote = 0;
  let i = from;

  for (; i < src.length && !scan.endless?.[quote][i]; i += 1) {
    const c = src.charAt(i);

    if (!quote && c === ">") {
      return i;
    }

    quote = quoteAfter(quote, c);
  }

  markEndless(scan, from, i);

  return -1;
};

/** Where a dropped element whose content starts at `from` ends after its end tag, or -1 when it has none. */
const droppedEnd = (scan: Scan, name: string, from: number): number => {
  const end = DROPPED.get(name);

  if (!end || scan.unclosed.has(name)) {
    return -1;
  }

  end.lastIndex = from;
  const m = end.exec(scan.src);

  if (!m) {
    scan.unclosed.add(name);

    return -1;
  }

  const gt = scan.src.indexOf(">", m.index + m[0].length);

  return gt === -1 ? scan.src.length : gt + 1;
};

/**
 * A comment at `lt` to its `-->`; the doctype, `<?xml …?>` and Outlook's `<![if !mso]>`, what HTML reads as a bogus
 * comment, and a comment without its `-->` to the first `>`. Null when no `>` follows, and then no markup does.
 */
const commentAt = (scan: Scan, lt: number): Markup | null => {
  const { src } = scan;

  if (scan.commentsEnd && src.startsWith("<!--", lt)) {
    const close = src.indexOf("-->", lt + 4);

    if (close !== -1) {
      return skipped(lt, close + 3);
    }

    scan.commentsEnd = false;
  }

  const gt = src.indexOf(">", lt + 2);

  return gt === -1 ? null : skipped(lt, gt + 1);
};

/**
 * A tag at `lt` to the first `>` outside a quoted attribute value, a `DROPPED` element through its end tag, or null
 * when the `<` is text: no letter starts a name after it, or no `>` ends the tag.
 */
const tagAt = (scan: Scan, lt: number): Markup | null => {
  const { src } = scan;
  const closing = src.charAt(lt + 1) === "/";
  TAG_NAME.lastIndex = lt + (closing ? 2 : 1);
  const read = TAG_NAME.exec(src)?.[0];

  if (!read) {
    return null;
  }

  const after = TAG_NAME.lastIndex;
  const gt = tagEnd(scan, after);

  if (gt === -1) {
    return null;
  }

  const name = read.toLowerCase();
  const end = closing ? -1 : droppedEnd(scan, name, gt + 1);

  if (end !== -1) {
    return skipped(lt, end);
  }

  return { start: lt, end: gt + 1, name, closing, attrs: src.slice(after, gt) };
};

/** The first markup at or after `from`, or null when the rest of the part is text. */
const nextMarkup = (scan: Scan, from: number): Markup | null => {
  const { src } = scan;

  for (
    let lt = src.indexOf("<", from);
    lt !== -1;
    lt = src.indexOf("<", lt + 1)
  ) {
    const next = src.charAt(lt + 1);

    if (next === "!" || next === "?") {
      return commentAt(scan, lt);
    }

    const tag = tagAt(scan, lt);

    if (tag) {
      return tag;
    }
  }

  return null;
};

const attrValue = (attrs: string, wanted: string): string | null => {
  const m = attrs.match(
    // `wanted` is an attribute name this module passes (`href`, `alt`), never the message's.
    // nosemgrep: detect-non-literal-regexp
    new RegExp(
      `(?:^|\\s)${wanted}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
      "iu"
    )
  );

  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : null;
};

const normLink = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/^(?:https?:\/\/|mailto:)/u, "")
    .replace(/\/$/u, "");

const sameLink = (text: string, href: string): boolean =>
  normLink(text) === normLink(href);

/** What `htmlToText` has read so far. */
interface Reading {
  lines: string[];
  size: number;
  /** Whether the last line in `lines` reads as blank, or there is none. */
  lastBlank: boolean;
  line: string;
  /**
   * Whether `line` has a character besides white space, and its last character, noted from what is added: V8 keeps a
   * line added to piece by piece as a rope and copies it whole to read its end, so a check of `line` itself after
   * every piece took time quadratic in its length (`</td>a` repeated, #3565).
   */
  lineText: boolean;
  lineEnd: string;
  quote: number;
  pre: number;
  lists: { ordered: boolean; n: number }[];
  href: string | null;
  linkText: string;
}

const quotePrefix = (r: Reading) =>
  r.quote ? `${"> ".repeat(Math.min(r.quote, MAX_DEPTH)).trimEnd()} ` : "";

// One blank line between blocks at most (a quoted blank line is `>`), so the budget counts what is returned.
const blankish = (l: string | undefined) => !(l ?? "").replace(/^[>\s]+/u, "");

const pushLine = (r: Reading, l: string) => {
  if (r.size >= MAX_TEXT) {
    return;
  }

  const blank = blankish(l);

  if (blank && r.lastBlank) {
    return;
  }

  r.lines.push(l.slice(0, MAX_TEXT - r.size));
  r.size += l.length + 1;
  r.lastBlank = blank;
};

/** The line being read starts again, as `s`. */
const startLine = (r: Reading, s = "") => {
  r.line = s;
  r.lineText = /\S/u.test(s);
  r.lineEnd = s.slice(-1);
};

/** Adds `s` to the line being read, read once itself for what `lineText` and `lineEnd` note. */
const addToLine = (r: Reading, s: string) => {
  if (!s) {
    return;
  }

  r.line += s;
  r.lineText ||= /\S/u.test(s);
  r.lineEnd = s.slice(-1);
};

/** `s` without the spaces and tabs at its end, found from the end: `/[ \t]+$/` read a run inside it from each space. */
const trimTrailingSpaces = (s: string): string => {
  let end = s.length;

  while (end > 0 && " \t".includes(s.charAt(end - 1))) {
    end -= 1;
  }

  return s.slice(0, end);
};

const flushLine = (r: Reading) => {
  const body = r.pre || r.line === "-- " ? r.line : trimTrailingSpaces(r.line);

  pushLine(r, body ? quotePrefix(r) + body : quotePrefix(r).trimEnd());
  startLine(r);
};

const blankLine = (r: Reading) => {
  if (r.lineText) {
    flushLine(r);
  }

  pushLine(r, quotePrefix(r).trimEnd());
};

const addText = (r: Reading, raw: string) => {
  let t = decodeEntities(raw);

  if (!r.pre) {
    t = t.replaceAll(/\s+/gu, " ");

    if (!r.line || r.lineEnd === " ") {
      t = t.replace(/^ /u, "");
    }
  }

  if (!t) {
    return;
  }

  addToLine(r, t);

  if (r.href !== null) {
    r.linkText += t;
  }
};

/** A link's start, or its end, where its address follows its text when the two differ. */
const readAnchor = (r: Reading, closing: boolean, attrs: string) => {
  if (closing) {
    if (r.href && r.linkText.trim() && !sameLink(r.linkText, r.href)) {
      addToLine(r, ` <${r.href}>`);
    }

    r.href = null;
  } else {
    const url = attrValue(attrs, "href");
    r.href = url && /^(?:https?:|mailto:)/iu.test(url) ? url : null;
  }

  r.linkText = "";
};

const startListItem = (r: Reading) => {
  const list = r.lists.at(-1);
  let marker = "- ";

  if (list?.ordered) {
    list.n += 1;
    marker = `${list.n}. `;
  }

  startLine(
    r,
    `${"  ".repeat(Math.min(Math.max(0, r.lists.length - 1), MAX_DEPTH))}${marker}`
  );
};

const closeBlock = (r: Reading, tag: string) => {
  if (r.lineText || (r.line && r.pre)) {
    flushLine(r);
  } else {
    startLine(r);
  }

  if (tag === "ul" || tag === "ol") {
    r.lists.pop();
  } else if (tag === "blockquote") {
    r.quote = Math.max(0, r.quote - 1);
  } else if (tag === "pre") {
    r.pre = Math.max(0, r.pre - 1);
  }

  if (PARAGRAPHS.has(tag)) {
    blankLine(r);
  }
};

const openBlock = (r: Reading, tag: string) => {
  if (r.lineText) {
    flushLine(r);
  }

  if (PARAGRAPHS.has(tag)) {
    blankLine(r);
  }

  if (tag === "ul" || tag === "ol") {
    r.lists.push({ ordered: tag === "ol", n: 0 });
  } else if (tag === "li") {
    startListItem(r);
  } else if (tag === "blockquote") {
    r.quote += 1;
  } else if (tag === "pre") {
    r.pre += 1;
  } else if (tag === "hr") {
    pushLine(r, `${quotePrefix(r)}----------`);
  }
};

/** One tag's effect on the reading. */
const readTag = (r: Reading, tag: string, closing: boolean, attrs: string) => {
  if (tag === "br") {
    flushLine(r);
  } else if (tag === "a") {
    readAnchor(r, closing, attrs);
  } else if (tag === "img") {
    const alt = attrValue(attrs, "alt")?.trim();

    if (alt) {
      addText(r, `[${alt}]`);
    }
  } else if (tag === "td" || tag === "th") {
    if (closing && r.line && !/\s/u.test(r.lineEnd)) {
      addToLine(r, "  ");
    }
  } else if (BLOCKS.has(tag)) {
    if (closing) {
      closeBlock(r, tag);
    } else {
      openBlock(r, tag);
    }
  }
};

/**
 * A plain-text reading of an HTML part, as a mail client writes the text alternative: paragraphs apart, `<br>` a
 * line, a list item with its marker, a quoted block with `> ` in front of every line, a link's address after its
 * text when the two differ. For the snippet, for mail that has no text part, and for the text part of what the
 * rich composer sends. At most `MAX_TEXT` characters, the start of the reading when there is more, read from at most
 * `MAX_HTML` characters of markup, in time linear in their length whatever the markup (#3565).
 */
export const htmlToText = (html: string): string => {
  const src = html.length > MAX_HTML ? html.slice(0, MAX_HTML) : html;

  const scan: Scan = {
    src,
    endless: null,
    unclosed: new Set(),
    commentsEnd: true,
  };

  const r: Reading = {
    lines: [],
    size: 0,
    lastBlank: true,
    line: "",
    lineText: false,
    lineEnd: "",
    quote: 0,
    pre: 0,
    lists: [],
    href: null,
    linkText: "",
  };

  let last = 0;

  for (
    let m = nextMarkup(scan, 0);
    m && r.size < MAX_TEXT;
    m = nextMarkup(scan, last)
  ) {
    if (m.start > last) {
      addText(r, src.slice(last, m.start));
    }

    last = m.end;

    if (m.name) {
      readTag(r, m.name, m.closing, m.attrs);
    }
  }

  if (r.size < MAX_TEXT && last < src.length) {
    addText(r, src.slice(last));
  }

  if (r.lineText) {
    flushLine(r);
  }

  // None at the end; `pushLine` keeps one from the start.
  while (r.lines.length && blankish(r.lines.at(-1))) {
    r.lines.pop();
  }

  return r.lines.join("\n");
};

/** Where a reply's quoted original begins: an attribution line (Gmail wraps it over up to three) or the first `>` run. */
export const quoteStart = (lines: string[]): number => {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();

    if (line.startsWith(">")) {
      return i;
    }

    const joined = lines
      .slice(i, i + 3)
      .map((l) => l.trim())
      .join(" ");

    if (
      /^On\s.+\swrote:$/iu.test(line) ||
      (/^On\s.+\swrote:/iu.test(joined) && joined.includes("@"))
    ) {
      return i;
    }

    if (
      /^-{2,}\s*(?:original message|forwarded message)\s*-{2,}$/iu.test(line)
    ) {
      return i;
    }
  }

  return -1;
};

/** The writer's own words: the text above the quoted original and above the `-- ` signature delimiter. */
export const ownText = (text: string): string => {
  const lines = text.replaceAll(/\r\n?/gu, "\n").split("\n");
  let end = quoteStart(lines);

  if (end < 0) {
    end = lines.length;
  }

  const sig = lines.findIndex((l, i) => i < end && l === "-- ");

  if (sig !== -1) {
    end = sig;
  }

  const own = lines.slice(0, end).join("\n").trim();

  return own || text;
};

/** The first line or so of a message, for the list row: what the writer wrote, not their signature or the quote. */
export const snippetOf = (text: string, n = 140): string => {
  const flat = ownText(text).replaceAll(/\s+/gu, " ").trim();

  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

export const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

/**
 * The writer's signature under what they wrote, after the `-- ` delimiter: above the quoted original of a reply or
 * forward, as Gmail and Outlook put it, so the quote can fold away below it.
 */
export const withSignature = (text: string, signature: string): string => {
  const lines = text.replaceAll(/\r\n?/gu, "\n").split("\n");
  const start = quoteStart(lines);
  const own = (start < 0 ? lines : lines.slice(0, start)).join("\n").trimEnd();
  const signed = `${own}\n\n-- \n${signature}`;

  return start < 0
    ? signed
    : `${signed}\n\n${lines.slice(start).join("\n").trimEnd()}`;
};

/** A signature as a message carries it: its text, and its markup when it was written as HTML. */
export interface SignatureParts {
  text: string;
  html: string | null;
}

const unbalanced = (link: string, open: string, close: string) =>
  link.endsWith(close) && link.split(open).length < link.split(close).length;

/** The text split into plain runs and the bare URLs and addresses in it. Sentence punctuation after a URL stays text. */
export const splitLinks = (value: string): LinkPart[] => {
  const parts: LinkPart[] = [];
  let last = 0;

  for (const m of value.matchAll(
    /https?:\/\/[^\s<>"]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/giu
  )) {
    let [link] = m;

    while (
      /[.,;:!?'"]$/u.test(link) ||
      unbalanced(link, "(", ")") ||
      unbalanced(link, "[", "]")
    ) {
      link = link.slice(0, -1);
    }

    if (m.index > last) {
      parts.push({ text: value.slice(last, m.index) });
    }

    parts.push({
      text: link,
      href: link.includes("://") ? link : `mailto:${link}`,
    });
    last = m.index + link.length;
  }

  if (last < value.length) {
    parts.push({ text: value.slice(last) });
  }

  return parts;
};

/** Bare URLs and email addresses become links; the rest is escaped. */
export const linkify = (value: string): string =>
  splitLinks(value)
    .map((p) =>
      p.href
        ? `<a href="${escapeHtml(p.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.text)}</a>`
        : escapeHtml(p.text)
    )
    .join("");

/** The signature as the HTML part carries it: above the quoted original, after `-- `. */
export const withSignatureHtml = (
  html: string,
  signature: SignatureParts
): string => {
  const body =
    signature.html ??
    signature.text
      .replaceAll(/\r\n?/gu, "\n")
      .split("\n")
      .map((l) => linkify(l))
      .join("<br>");

  const block = `<div class="rivi_signature">-- <br>${body}</div>`;
  const at = html.indexOf('<div class="gmail_quote"');

  if (at === -1) {
    return `${html}<br>${block}`;
  }

  return `${html.slice(0, at)}<br>${block}<br>${html.slice(at)}`;
};

/** Whether the rich composer's markup says anything (an empty editor still holds a `<div><br></div>`). */
export const htmlIsBlank = (html: string | null | undefined): boolean => {
  if (!html) {
    return true;
  }

  return !htmlToText(html).trim() && !/<img\b/iu.test(html);
};

/** The container every message we send sits in: a font and size, and no colour, so each client's dark mode reads it. */
export const outgoingHtml = (body: string): string =>
  `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5">${body}</div>`;

/** Lines as paragraphs, each run of `>` lines a blockquote of its own (a `>>` run nests). */
const textBlocks = (lines: string[]): string => {
  let html = "";

  for (let i = 0; i < lines.length;) {
    const quoted = lines[i].startsWith(">");
    const run: string[] = [];

    while (i < lines.length && lines[i].startsWith(">") === quoted) {
      const line = lines[i];
      i += 1;
      run.push(quoted ? line.replace(/^> ?/u, "") : line);
    }

    html += quoted
      ? `<blockquote type="cite" style="margin:0 0 16px .8ex;border-left:1px solid #ccc;padding-left:1ex">${textBlocks(run)}</blockquote>`
      : run
          .join("\n")
          .split(/\n[ \t]*\n/u)
          .map((p) => p.trim())
          .filter(Boolean)
          .map(
            (p) =>
              `<p style="margin:0 0 16px">${linkify(p).replaceAll("\n", "<br>")}</p>`
          )
          .join("");
  }

  return html;
};

/** `textToHtml` without the container, for markup that goes on (an HTML signature) before it is wrapped. */
export const textToHtmlBody = (value: string): string => {
  const lines = value.replaceAll(/\r\n?/gu, "\n").split("\n");
  const start = quoteStart(lines);

  if (start < 0 || !lines.slice(start).some((l) => l.startsWith(">"))) {
    return textBlocks(lines);
  }

  // The attribution and the `>` run under it; a line written after the quote is the writer's again.
  let end = start;

  while (end < lines.length && !lines[end].startsWith(">")) {
    end += 1;
  }

  while (end < lines.length && lines[end].startsWith(">")) {
    end += 1;
  }

  return `${textBlocks(
    lines.slice(0, start)
  )}<div class="gmail_quote">${textBlocks(lines.slice(start, end))}</div>${textBlocks(
    lines.slice(end)
  )}`;
};

/**
 * Text a person typed, as email paragraphs: a blank line starts a paragraph, a newline breaks the line. Linkified and
 * escaped. The quoted original under a reply becomes a blockquote in Gmail's `gmail_quote`, which Gmail and this app
 * fold; a forward stays in view. No text colour is set, so each client's dark mode reads it as its own.
 */
export const textToHtml = (value: string): string =>
  outgoingHtml(textToHtmlBody(value));

export interface Quotable {
  date: string;
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  text: string;
  /** The original's HTML part, sanitised, when it has one. */
  html?: string | null;
}

const longDate = (iso: string): string => {
  const d = new Date(iso);

  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      });
};

/** The original's markup for a quote: its own HTML without the style blocks the sanitiser lifted, else its text. */
const quotedBody = (m: Quotable): string => {
  if (m.html?.trim()) {
    return withoutStyles(m.html);
  }

  return textBlocks(m.text.replaceAll(/\r\n?/gu, "\n").trimEnd().split("\n"));
};

/** The quoted original under a reply in the rich composer, in Gmail's grammar: the attribution, then a blockquote. */
export const quoteHtmlForReply = (m: Quotable): string => {
  const who = m.from.name
    ? `${escapeHtml(m.from.name)} &lt;<a href="mailto:${escapeHtml(m.from.email)}">${escapeHtml(m.from.email)}</a>&gt;`
    : `<a href="mailto:${escapeHtml(m.from.email)}">${escapeHtml(m.from.email)}</a>`;

  return `<div class="gmail_quote"><div class="gmail_attr">On ${escapeHtml(longDate(m.date))}, ${who} wrote:</div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${quotedBody(m)}</blockquote></div>`;
};

const row = (label: string, value: string) => `${label}: ${value}<br>`;

/** The original under a forward in the rich composer: the header block, then the message itself, in view. */
export const quoteHtmlForForward = (m: Quotable): string => {
  const head = `---------- Forwarded message ---------<br>${row(
    "From",
    escapeHtml(formatAddress(m.from))
  )}${row("Date", escapeHtml(longDate(m.date)))}${row(
    "Subject",
    escapeHtml(m.subject)
  )}${row(
    "To",
    escapeHtml(m.to.map(formatAddress).join(", "))
  )}${m.cc.length ? row("Cc", escapeHtml(m.cc.map(formatAddress).join(", "))) : ""}`;

  return `<div class="gmail_quote"><div class="gmail_attr">${head}</div><br>${quotedBody(m)}</div>`;
};

export interface LinkPart {
  text: string;
  href?: string;
}

/** Bytes as a short size for the attachment chips. */
export const formatBytes = (n: number): string => {
  if (n < 1024) {
    return `${n} B`;
  }

  if (n < 1024 * 1024) {
    return `${Math.round(n / 1024)} KB`;
  }

  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * Plain text as the markup the rich composer writes: a blank line starts a block, a newline breaks the line. What a
 * draft written for the person (the Assistant's, Mail's "Draft with AI") puts above the quote.
 */
export const textToEditorHtml = (text: string): string =>
  text
    .replaceAll(/\r\n?/gu, "\n")
    .split(/\n[ \t]*\n/u)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(
      (p) => `<div>${linkify(p).replaceAll("\n", "<br>")}</div><div><br></div>`
    )
    .join("");
