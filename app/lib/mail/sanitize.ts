import { defined } from "~/lib/guards";

/**
 * The HTML part of a message, made safe to show. Two layers: this sanitiser strips scripts, frames, forms and the
 * attributes that run code or load a page, and `mailDocument` wraps the result in a document with a strict
 * Content-Security-Policy that the viewer shows in a sandboxed iframe (no scripts, no form submission, images only
 * from the sources the reader allowed). Remote images stay in the markup, blocked by the CSP until the reader loads
 * them; `cid:` images are rewritten to the message's own attachment links.
 *
 * The sanitiser reads markup with regular expressions, not as the browser does, so its output is canonical: every
 * tag is written anew, every `<` in text and every `<` or `>` in an attribute is escaped, and no element whose content
 * the browser reads as text (`xmp`, `noembed`, …) is kept. Whatever it failed to read as a tag reaches the browser as
 * text, never as an incomplete tag that the markup around it (a reply's quote) completes (CORE-1302).
 */
import {
  colorsIn,
  darkBackground,
  darkBorder,
  darkText,
  isPaleColor,
  mapColors,
  parseColor,
} from "./colors";

const DROP_WITH_CONTENT = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "noscript",
  "title",
  "template",
  "xml",
  // Every closed style element is lifted out first; one still here is unclosed and would swallow the rest as CSS.
  "style",
]);

const DROP_TAG_ONLY = new Set([
  "meta",
  "link",
  "base",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "html",
  "head",
  // The browser reads what these hold as text and this sanitiser as markup: an attribute it kept could close one.
  "xmp",
  "noembed",
  "noframes",
  "plaintext",
  // SVG animation sets an attribute after this sanitiser checked it: a link's href to `javascript:`.
  "animate",
  "set",
]);

const URL_ATTRS = new Set([
  "href",
  "src",
  "srcset",
  "background",
  "poster",
  "action",
  "formaction",
  "xlink:href",
  "data",
  "ping",
]);

// The body's presentational attributes, which a div does not read: the colours move into its style, the rest goes.
const BODY_DROP = new Set([
  "link",
  "vlink",
  "alink",
  "background",
  "leftmargin",
  "rightmargin",
  "topmargin",
  "bottommargin",
  "marginwidth",
  "marginheight",
]);

export interface SanitizeOptions {
  /** The link for an inline image's Content-ID (without the angle brackets), or null when the message has none. */
  cidUrl: (cid: string) => string | null;
  /** Whether the message is a forward, whose quoted message is its content and never folds. */
  forward?: boolean;
  /**
   * Whether an image may be a `data:` URI (PNG, JPEG, GIF or WebP, base64): a signature's own images, which go out
   * as inline attachments (`inlineDataImages`). Mail that arrives never gets them.
   */
  dataImages?: boolean;
}

const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+=*$/iu;

export interface Sanitized {
  html: string;
  /** Whether the markup loads images from the web, which the CSP blocks until the reader asks for them. */
  remoteImages: boolean;
}

// Comments, CDATA, and what the browser drops as a bogus comment up to the next `>`: a doctype, Outlook's
// `<![if !supportLists]>`, an XML processing instruction. Then a start or end tag.
const TAG =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[!?][^>]*>|<\/?(?<name>[a-zA-Z][\w:-]*)(?<attrs>(?:"[^"]*"|'[^']*'|[^'">])*)\/?>/gu;

const ATTR =
  /(?<name>[^\s=/"'<>]+)(?:\s*=\s*(?:"(?<doubleQuoted>[^"]*)"|'(?<singleQuoted>[^']*)'|(?<unquoted>[^\s"'>]+)))?/gu;

/** A quoted earlier message: where its markup starts and ends in the output, and the element that holds it. */
interface Quote {
  start: number;
  end: number;
  tag: string;
  depth: number;
  toEnd: boolean;
}

const NAMED_REFS = new Map(
  Object.entries({
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: "\u00A0",
    Tab: "\t",
    NewLine: "\n",
    colon: ":",
    // The ones a text reading of a message meets most (`htmlToText`).
    ndash: "–",
    mdash: "—",
    hellip: "…",
    rsquo: "’",
    lsquo: "‘",
    rdquo: "”",
    ldquo: "“",
    copy: "©",
    reg: "®",
    trade: "™",
    euro: "€",
    pound: "£",
    bull: "•",
    middot: "·",
    laquo: "«",
    raquo: "»",
    shy: "",
    zwnj: "",
    zwj: "",
    // Latin-1 letters, as newsletters still write them.
    aacute: "á",
    agrave: "à",
    acirc: "â",
    auml: "ä",
    atilde: "ã",
    aring: "å",
    aelig: "æ",
    eacute: "é",
    egrave: "è",
    ecirc: "ê",
    euml: "ë",
    iacute: "í",
    igrave: "ì",
    icirc: "î",
    iuml: "ï",
    oacute: "ó",
    ograve: "ò",
    ocirc: "ô",
    ouml: "ö",
    otilde: "õ",
    oslash: "ø",
    uacute: "ú",
    ugrave: "ù",
    ucirc: "û",
    uuml: "ü",
    yacute: "ý",
    yuml: "ÿ",
    ccedil: "ç",
    ntilde: "ñ",
    szlig: "ß",
    Aacute: "Á",
    Agrave: "À",
    Acirc: "Â",
    Auml: "Ä",
    Atilde: "Ã",
    Aring: "Å",
    AElig: "Æ",
    Eacute: "É",
    Egrave: "È",
    Ecirc: "Ê",
    Euml: "Ë",
    Iacute: "Í",
    Igrave: "Ì",
    Icirc: "Î",
    Iuml: "Ï",
    Oacute: "Ó",
    Ograve: "Ò",
    Ocirc: "Ô",
    Ouml: "Ö",
    Otilde: "Õ",
    Oslash: "Ø",
    Uacute: "Ú",
    Ugrave: "Ù",
    Ucirc: "Û",
    Uuml: "Ü",
    Yacute: "Ý",
    Ccedil: "Ç",
    Ntilde: "Ñ",
  })
);

/**
 * Character references as the browser reads them in an attribute: numeric ones with or without the semicolon, and the
 * named ones that matter to a URL's scheme or a style. Any other named reference is left as written.
 */
export const decodeEntities = (value: string): string =>
  value.replaceAll(
    /&(?:#(?<numeric>x[0-9a-f]+|\d+);?|(?<name>[a-z]+);)/giu,
    (ref, num?: string, named?: string) => {
      if (named !== undefined) {
        return (
          NAMED_REFS.get(named) ?? NAMED_REFS.get(named.toLowerCase()) ?? ref
        );
      }

      const digits = defined(num, "the num");

      const code =
        digits[0].toLowerCase() === "x"
          ? Number.parseInt(digits.slice(1), 16)
          : Number(digits);

      return code > 0 &&
        code <= 0x10_ff_ff &&
        (code < 0xd8_00 || code > 0xdf_ff)
        ? String.fromCodePoint(code)
        : "\uFFFD";
    }
  );

/**
 * A URL attribute as the browser reads it, so its scheme is checked on what will run: character references decoded
 * (`&#106;avascript:`), tabs and newlines removed (`java\tscript:`), leading spaces and control characters trimmed.
 */
const urlAsRead = (value: string): string => {
  const url = decodeEntities(value).replaceAll(/[\t\n\r]/gu, "");
  let i = 0;

  while (i < url.length && (url.codePointAt(i) ?? 0) <= 0x20) {
    i += 1;
  }

  return url.slice(i);
};

/**
 * Styles keep their layout; what could run code or reach the web in old engines goes. A `<` becomes CSS's own escape
 * for it, so no `</style` in the sender's CSS ends the style element early.
 */
const sanitizeCss = (css: string): string =>
  css
    .replaceAll("<", "\\3c ")
    .replaceAll(/expression\s*\([^)]*\)/giu, "")
    .replaceAll(/behavior\s*:[^;]*;?/giu, "")
    .replaceAll(/-moz-binding\s*:[^;]*;?/giu, "")
    .replaceAll(/@import[^;]*;?/giu, "")
    .replaceAll(
      /url\(\s*(?:['"]?)\s*(?:javascript|vbscript|data):[^)]*\)/giu,
      "none"
    );

/** An attribute that never survives: an event handler, a form's target, a link's own `target` and `rel`. */
const dropsAttribute = (tag: string, name: string): boolean => {
  if (
    name.startsWith("on") ||
    name === "srcdoc" ||
    name === "formaction" ||
    name === "action"
  ) {
    return true;
  }

  // Every link opens a new tab; a target of the sender's own would load the page inside the frame.
  return (
    (tag === "a" || tag === "area") && (name === "target" || name === "rel")
  );
};

/** The URL schemes a link or an image may carry. */
const SAFE_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

/** A `cid:` link to an attachment or a `data:` image, as it is kept; null when it goes. */
const embeddedUrl = (
  scheme: "cid" | "data",
  tag: string,
  name: string,
  url: string,
  options: SanitizeOptions
): string | null => {
  if (scheme === "cid") {
    const link =
      name === "src" || name === "background"
        ? options.cidUrl(url.slice(4).replaceAll(/^<|>$/gu, ""))
        : null;

    return link || null;
  }

  const data = url.replaceAll(/\s+/gu, "");
  const image = tag === "img" && name === "src" && options.dataImages;

  return image && DATA_IMAGE.test(data) ? data : null;
};

/**
 * A URL attribute's value as it is kept, and whether it loads a remote image; null when the attribute goes. The
 * scheme is read as the browser reads it (`urlAsRead`).
 */
const urlAttribute = (
  tag: string,
  name: string,
  value: string,
  options: SanitizeOptions
): { value: string; remoteImage: boolean } | null => {
  const url = urlAsRead(value);

  const scheme = url
    .match(/^(?<scheme>[a-z][a-z0-9+.-]*):/iu)?.[1]
    ?.toLowerCase();

  if (scheme === "cid" || scheme === "data") {
    const embedded = embeddedUrl(scheme, tag, name, url, options);

    return embedded === null ? null : { value: embedded, remoteImage: false };
  }

  // Responsive candidates would bypass the single-URL check below.
  if (name === "srcset") {
    return null;
  }

  // javascript:, vbscript:, data:, file:, …
  if (scheme && !SAFE_SCHEMES.has(scheme)) {
    return null;
  }

  if (
    (name === "src" || name === "background" || name === "poster") &&
    scheme
  ) {
    return { value, remoteImage: true };
  }

  // A relative image would resolve against our own origin.
  if (!scheme && url && (name === "src" || name === "background")) {
    return null;
  }

  return { value, remoteImage: false };
};

const sanitizeAttributes = (
  tag: string,
  attrs: string,
  options: SanitizeOptions
) => {
  const kept: Attr[] = [];
  let remoteImage = false;
  ATTR.lastIndex = 0;

  for (let m = ATTR.exec(attrs); m; m = ATTR.exec(attrs)) {
    const name = m[1].toLowerCase();
    let value = m[2] ?? m[3] ?? m[4] ?? "";

    if (dropsAttribute(tag, name)) {
      continue;
    }

    if (name === "style") {
      // Checked as the browser reads it: character references decoded first.
      value = sanitizeCss(decodeEntities(value));
    } else if (URL_ATTRS.has(name)) {
      const checked = urlAttribute(tag, name, value, options);

      if (!checked) {
        continue;
      }

      ({ value } = checked);
      remoteImage ||= checked.remoteImage;
    }

    kept.push([
      name,
      value === "" && m[2] === undefined && m[3] === undefined ? null : value,
    ]);
  }

  if (tag === "img" && !kept.some(([n]) => n === "alt")) {
    kept.push(["alt", ""]);
  }

  return { attrs: kept, remoteImage };
};

/** The body's attributes for the div that takes its place: `bgcolor` and `text` as CSS in front of its own style. */
const bodyAttributes = (attrs: Attr[]): Attr[] => {
  const css: string[] = [];
  const rest: Attr[] = [];
  let style = "";

  for (const [name, value] of attrs) {
    if (name === "bgcolor" || name === "text") {
      if (value && /^[#\w(),.%\s]+$/u.test(value)) {
        css.push(
          `${name === "bgcolor" ? "background-color" : "color"}:${value.trim()}`
        );
      }
    } else if (name === "style") {
      style = value ?? "";
    } else if (!BODY_DROP.has(name)) {
      rest.push([name, value]);
    }
  }

  const merged = [...css, style].filter((s) => s.trim()).join(";");

  return merged ? [["style", merged], ...rest] : rest;
};

const readAttr = (attrs: string, wanted: string): string | null => {
  ATTR.lastIndex = 0;

  for (let m = ATTR.exec(attrs); m; m = ATTR.exec(attrs)) {
    if (m[1].toLowerCase() === wanted) {
      return decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
    }
  }

  return null;
};

/** The colour schemes a `<meta name="color-scheme">` (or Apple's `supported-color-schemes`) declares. */
const colorSchemeMeta = (attrs: string): string | null => {
  const name = readAttr(attrs, "name")?.toLowerCase();

  if (name !== "color-scheme" && name !== "supported-color-schemes") {
    return null;
  }

  const content = readAttr(attrs, "content")?.trim().toLowerCase() ?? "";

  return /^[a-z]+(?:\s+[a-z]+)*$/u.test(content) ? content : null;
};

/**
 * Where a mail client put the earlier messages under a reply: Gmail and Yahoo wrap them in an element (our own
 * outgoing mail too, as Gmail does), Apple Mail and Thunderbird cite them in a blockquote, and Outlook marks where
 * they start and runs them to the end of the message.
 */
const quoteKind = (tag: string, attrs: string): "element" | "rest" | null => {
  if (tag === "blockquote") {
    return readAttr(attrs, "type")?.toLowerCase() === "cite" ? "element" : null;
  }

  if (tag !== "div") {
    return null;
  }

  if (
    /(?:^|\s)(?:gmail_quote|yahoo_quoted)(?:\s|$)/u.test(
      readAttr(attrs, "class") ?? ""
    )
  ) {
    return "element";
  }

  const id = readAttr(attrs, "id");

  return id === "appendonsend" || id === "divRplyFwdMsg" ? "rest" : null;
};

const visibleText = (html: string): string =>
  html
    .replaceAll(/<style[\s\S]*?<\/style>/giu, "")
    .replaceAll(/<[^>]*>/gu, " ")
    .replaceAll(/&nbsp;|&#160;|\u00A0/giu, " ");

const shows = (html: string): boolean =>
  /\S/u.test(visibleText(html)) || /<img\b/iu.test(html);

/**
 * Whether a quote folds: it closes the message, or only a signature follows it (a reply written between quotes keeps
 * them all in view); something comes before it; and it does not open with a forward's header (Gmail and Apple Mail
 * write one; Outlook's forward looks like its reply, so the caller tells from the subject).
 */
const foldable = (html: string, q: Quote): boolean => {
  const after = html.slice(q.end);

  if (shows(after) && !/^\s*--\s/u.test(visibleText(after))) {
    return false;
  }

  if (!shows(html.slice(0, q.start))) {
    return false;
  }

  return !/^\s*(?:-{2,}\s*(?:forwarded|original) message|begin forwarded message)/iu.test(
    visibleText(html.slice(q.start, q.end))
  );
};

const BREAK = /<br\b[^>]*>/giu;

/** Where the markup stops showing anything: after its last text or image, only tags and spacing follow. */
const blankFrom = (html: string): number => {
  const tags = new RegExp(TAG.source, "gu");
  let from = 0;
  let last = 0;

  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    if (/\S/u.test(visibleText(html.slice(last, m.index)))) {
      from = m.index;
    }

    last = m.index + m[0].length;

    if (/^<img\b/iu.test(m[0])) {
      from = last;
    }
  }

  return /\S/u.test(visibleText(html.slice(last))) ? html.length : from;
};

/** Where the markup starts showing something: its first text or image; up to there, only tags and spacing. */
const blankUntil = (html: string): number => {
  const tags = new RegExp(TAG.source, "gu");
  let last = 0;

  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    if (/\S/u.test(visibleText(html.slice(last, m.index)))) {
      return last;
    }

    if (/^<img\b/iu.test(m[0])) {
      return m.index;
    }

    last = m.index + m[0].length;
  }

  return /\S/u.test(visibleText(html.slice(last))) ? last : html.length;
};

const TAG_OPEN = /</gu;

const escapeText = (text: string): string =>
  // Text between the tags read is already markup text, references and all. A `<` in it is one the tags missed: a
  // tag cut off at the end, or one whose quotes do not pair up, which the browser would still read as a tag.
  text.replaceAll(TAG_OPEN, "&lt;");

const ATTR_ESCAPES = new Map([
  ['"', "&quot;"],
  ["<", "&lt;"],
  [">", "&gt;"],
]);

/**
 * One pass: a `&` that does not start a reference the attribute already holds, and the three characters that
 * would close the value or open a tag. What it writes is never read again.
 */
const escapeAttr = (value: string): string =>
  value.replaceAll(
    /&(?!(?:amp|lt|gt|quot|#\d+|#x[0-9a-f]+);)|["<>]/giu,
    (c) => ATTR_ESCAPES.get(c) ?? "&amp;"
  );

/** What the sanitiser has written and read so far. */
interface SanitizeState {
  out: string;
  last: number;
  remoteImages: boolean;
  skipUntil: string | null;
  quote: Quote | null;
  lastQuote: Quote | null;
}

/** A tag inside a dropped element: only its closing tag ends the drop. */
const skipTag = (
  state: SanitizeState,
  raw: string,
  name: string | undefined,
  index: number
) => {
  if (raw.startsWith("</") && name?.toLowerCase() === state.skipUntil) {
    state.skipUntil = null;
    state.last = index + raw.length;
  }
};

/** A closing tag, written anew; it may end the quoted earlier message. */
const closeTag = (state: SanitizeState, tag: string, as: string) => {
  const { quote } = state;
  state.out += `</${as}>`;

  if (quote && !quote.toEnd && tag === quote.tag) {
    quote.depth -= 1;

    if (quote.depth === 0) {
      quote.end = state.out.length;
      state.lastQuote = quote;
      state.quote = null;
    }
  }
};

/** An opening tag, written anew with the attributes that may stay; it may start the quoted earlier message. */
const openTag = (
  state: SanitizeState,
  tag: string,
  as: string,
  raw: string,
  attrs: string,
  options: SanitizeOptions
) => {
  if (!state.quote) {
    const kind = quoteKind(tag, attrs);

    if (kind) {
      state.quote = {
        start: state.out.length,
        end: -1,
        tag,
        depth: 0,
        toEnd: kind === "rest",
      };
    }
  }

  const { quote } = state;

  if (quote && !quote.toEnd && tag === quote.tag) {
    quote.depth += 1;
  }

  const kept = sanitizeAttributes(tag, attrs, options);
  state.remoteImages ||= kept.remoteImage;
  const list = tag === "body" ? bodyAttributes(kept.attrs) : kept.attrs;

  if (tag === "a" || tag === "area") {
    list.push(["target", "_blank"], ["rel", "noopener noreferrer"]);
  }

  const text = list
    .map(([n, v]) => (v === null ? n : `${n}="${escapeAttr(v)}"`))
    .join(" ");

  state.out += `<${as}${text ? ` ${text}` : ""}${raw.endsWith("/>") ? " /" : ""}>`;
};

/** The quoted earlier message folded away under "Show quoted text", the blank lines around it with it. */
const foldQuote = (out: string, { start, end }: Quote): string => {
  // The blank lines clients leave around a quote go with it, so the fold sits under the reply as in plain text.
  const cut = blankFrom(out.slice(0, start));
  const resume = end + blankUntil(out.slice(end));

  return `${
    out.slice(0, cut) + out.slice(cut, start).replaceAll(BREAK, "")
  }<details class="rivi-quote"><summary><span class="rivi-show">Show quoted text</span><span class="rivi-hide">Hide quoted text</span></summary>${out.slice(
    start,
    end
  )}</details>${out
    .slice(end, resume)
    .replaceAll(BREAK, "")}${out.slice(resume)}`;
};

export const sanitizeHtml = (
  input: string,
  options: SanitizeOptions
): Sanitized => {
  const styles: string[] = [];

  // Style blocks are kept (inline styles are allowed by the CSP), the rest of the head goes.
  const html = input.replaceAll(
    /<style\b[^>]*>(?<css>[\s\S]*?)<\/style>/giu,
    (_, css: string) => {
      styles.push(sanitizeCss(css));

      return "";
    }
  );

  const state: SanitizeState = {
    out: "",
    last: 0,
    remoteImages: false,
    skipUntil: null,
    quote: null,
    lastQuote: null,
  };

  TAG.lastIndex = 0;

  for (let m = TAG.exec(html); m; m = TAG.exec(html)) {
    const [raw, name, attrs = ""] = m;

    if (state.skipUntil) {
      // Inside a dropped element: wait for its closing tag.
      skipTag(state, raw, name, m.index);
      continue;
    }

    state.out += escapeText(html.slice(state.last, m.index));
    state.last = m.index + raw.length;

    if (!name) {
      // A comment, a doctype or CDATA.
      continue;
    }

    const tag = name.toLowerCase();
    const closing = raw.startsWith("</");

    if (DROP_WITH_CONTENT.has(tag)) {
      if (!closing && !raw.endsWith("/>")) {
        state.skipUntil = tag;
      }

      continue;
    }

    if (tag === "meta" && !closing) {
      // The sender's word on dark mode, which `mailDocument` reads from the CSS.
      const scheme = colorSchemeMeta(attrs);

      if (scheme) {
        styles.push(`:root{color-scheme:${scheme}}`);
      }
    }

    if (DROP_TAG_ONLY.has(tag)) {
      continue;
    }

    // The body becomes a div, so its background and text colour stay with the message.
    const as = tag === "body" ? "div" : tag;

    if (closing) {
      closeTag(state, tag, as);
    } else {
      openTag(state, tag, as, raw, attrs, options);
    }
  }

  if (!state.skipUntil) {
    state.out += escapeText(html.slice(state.last));
  }

  if (state.quote) {
    // Outlook's quote runs to the end; an element nobody closed ends there too.
    state.quote.end = state.out.length;
    state.lastQuote = state.quote;
  }

  const { lastQuote } = state;

  const folded =
    lastQuote && !options.forward && foldable(state.out, lastQuote)
      ? foldQuote(state.out, lastQuote)
      : state.out;

  const styleTag = styles.length ? `<style>${styles.join("\n")}</style>` : "";

  return { html: styleTag + folded, remoteImages: state.remoteImages };
};

type Attr = [name: string, value: string | null];

/**
 * How a message reads on the reader's surface. A light reading shows it as sent. A dark one adapts the message's
 * colours, and the message's own dark-mode CSS, when it has some, goes over them: what that CSS forgot is still
 * readable. A designed message (background images, or backgrounds of its own darker than a tint) without dark-mode CSS
 * stays light, as sent, on a light sheet, as Apple Mail does, because adapting a design breaks its images. Declaring
 * `color-scheme: light dark` is no dark mode: many templates declare it and keep their dark text. `swapped` is the
 * reader's switch for one message: a dark reading turns light, and a designed message is adapted after all. `sheet`
 * is a plain message read light in the dark theme, which needs a margin of its own on its white sheet.
 */
export interface MailReading {
  dark: boolean;
  sheet: boolean;
}

const BACKGROUND = /^background(?:-color|-image)?$/u;

// Elements that run inside a line: a background on one is a highlight, not the design of the message.
const INLINE = new Set(
  "a abbr b bdi bdo big cite code data dfn em font i kbd label mark q s samp small span strike strong sub sup time tt u var".split(
    " "
  )
);

/**
 * The CSS of sanitised markup, rewritten: the style element, every style attribute and the colour attributes. It reads
 * the sanitiser's own output, whose attribute values are always double-quoted with every `"` inside escaped.
 */
const restyle = (html: string, visit: StyleVisitor): string => {
  const tags = new RegExp(TAG.source, "gu");
  let out = "";
  let last = 0;

  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    const [raw, name, attrs] = m;
    out += html.slice(last, m.index);
    last = m.index + raw.length;
    const tag = name?.toLowerCase();

    if (!tag || raw.startsWith("</")) {
      out += raw;
      continue;
    }

    if (tag === "style") {
      const close = html.indexOf("</style>", last);
      const end = close === -1 ? html.length : close;
      out += raw + visit.sheet(html.slice(last, end));
      last = end;
      tags.lastIndex = end;
      continue;
    }

    out += attrs
      ? `<${name}${attrs.replaceAll(
          /(?<space>\s)(?<attr>style|bgcolor|color|background)="(?<value>[^"]*)"/giu,
          (_, space: string, attr: string, value: string) => {
            const a = attr.toLowerCase();
            const decoded = decodeEntities(value);

            const next =
              a === "style"
                ? visit.inline(decoded, tag)
                : visit.attr(a, decoded, tag);

            return `${space}${attr}="${escapeAttr(next)}"`;
          }
        )}>`
      : raw;
  }

  return out + html.slice(last);
};

const DARK_QUERY = /@media[^{]*prefers-color-scheme\s*:\s*dark[^{]*\{/giu;

/** Where the style sheet's `prefers-color-scheme: dark` queries start and end. */
const darkQueries = (css: string): [number, number][] => {
  const found: [number, number][] = [];
  const open = new RegExp(DARK_QUERY.source, "giu");

  for (let m = open.exec(css); m; m = open.exec(css)) {
    let depth = 1;
    let i = m.index + m[0].length;

    for (; i < css.length && depth > 0; i += 1) {
      if (css[i] === "{") {
        depth += 1;
      } else if (css[i] === "}") {
        depth -= 1;
      }
    }

    found.push([m.index, i]);
    open.lastIndex = i;
  }

  return found;
};

/** Each `property: value` of a declaration list, rewritten by `fn`: null keeps it, an empty string drops it. */
const mapDeclarations = (
  css: string,
  fn: (prop: string, value: string) => string | null
): string =>
  css.replaceAll(
    /(?<before>^|[;{\s])(?<prop>[-a-z]+)(?<colon>\s*:\s*)(?<value>[^;{}]*)/giu,
    (all, before: string, prop: string, colon: string, value: string) => {
      const next = fn(prop.toLowerCase(), value);

      if (next === null) {
        return all;
      }

      return next === "" ? before : before + prop + colon + next;
    }
  );

/**
 * Each declaration of a rule set's blocks (the selectors are never touched), told whether its rule sits in a
 * `prefers-color-scheme: dark` query.
 */
const mapRules = (
  css: string,
  fn: (prop: string, value: string, darkRule: boolean) => string | null
): string => {
  const dark = darkQueries(css);

  return css.replaceAll(
    /\{(?<block>[^{}]*)\}/gu,
    (_, block: string, at: number) => {
      const darkRule = dark.some(([from, to]) => at > from && at < to);

      return `{${mapDeclarations(block, (prop, value) => fn(prop, value, darkRule))}}`;
    }
  );
};

/**
 * Whether the message brings its own dark mode (rules for `prefers-color-scheme: dark`), and whether it is designed:
 * a background image, or a background colour on a block darker than a tint of the page.
 */
const readPalette = (html: string): Palette => {
  const p: Palette = { darkReady: false, designed: false };

  const read =
    (inline: boolean) =>
    (prop: string, value: string, darkRule = false): string => {
      if (darkRule || !BACKGROUND.test(prop)) {
        return value;
      }

      if (/(?:url|gradient)\(/iu.test(value)) {
        p.designed = true;
      } else if (!inline && colorsIn(value).some((c) => !isPaleColor(c))) {
        p.designed = true;
      }

      return value;
    };

  restyle(html, {
    sheet: (css) => {
      if (/prefers-color-scheme\s*:\s*dark/iu.test(css)) {
        p.darkReady = true;
      }

      mapRules(css, read(false));

      return css;
    },
    inline: (css, tag) => {
      mapDeclarations(css, read(INLINE.has(tag)));

      return css;
    },
    attr: (name, value, tag) => {
      const c = name === "bgcolor" ? parseColor(value) : null;

      if (name === "background" || (c && !INLINE.has(tag) && !isPaleColor(c))) {
        p.designed = true;
      }

      return value;
    },
  });

  return p;
};

export const mailReading = (
  html: string,
  options: { dark: boolean; swapped?: boolean }
): MailReading => {
  if (!options.dark) {
    return { dark: false, sheet: false };
  }

  const palette = readPalette(html);
  const dark = palette.darkReady || !palette.designed;

  if (options.swapped ? dark : !dark) {
    return { dark: false, sheet: !palette.designed };
  }

  return { dark: true, sheet: false };
};

export interface MailDocumentOptions {
  /** The origin of this app, so the attachment links the sanitiser wrote are allowed as image sources. */
  origin: string;
  /** Whether the reader asked for the images from the web. */
  loadRemoteImages: boolean;
  /** The reading from `mailReading`. */
  reading: MailReading;
  /**
   * Whether the document names a viewport (the phone app's web view, which would otherwise lay a page out at 980
   * CSS pixels and shrink it); the console's frame takes its width from the page and needs none.
   */
  viewport?: boolean;
}

const SURFACES = {
  light: {
    text: "#1f2023",
    muted: "#5f636c",
    line: "#d4d4d9",
    link: "#0a7f43",
    chip: "rgba(31, 32, 35, 0.055)",
    chipHover: "rgba(31, 32, 35, 0.09)",
    page: "#ffffff",
  },
  dark: {
    text: "#e6e7ea",
    muted: "#9a9ea7",
    line: "#37393f",
    link: "#3be08a",
    chip: "rgba(230, 231, 234, 0.05)",
    chipHover: "rgba(230, 231, 234, 0.08)",
    // The card shows through, so the message sits on the console's own surface.
    page: "transparent",
  },
};

const TEXT_COLOR =
  /^(?:color|caret-color|text-decoration(?:-color)?|text-emphasis(?:-color)?|-webkit-text-fill-color)$/u;

const BORDER =
  /^(?:border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-color)?|outline(?:-color)?|column-rule(?:-color)?)$/u;

const PREFERS_SCHEME =
  /\(\s*prefers-color-scheme\s*:\s*(?<scheme>dark|light)\s*\)/giu;

const VIEWPORT_HEIGHT = /\d[sld]?v(?:h|b|min|max)\b/iu;

/** The sanitised markup as a complete document for a sandboxed iframe, its CSP in a meta tag. */
export const mailDocument = (
  html: string,
  options: MailDocumentOptions
): string => {
  const img = options.loadRemoteImages
    ? `img-src ${options.origin} https: http: data:`
    : `img-src ${options.origin} data:`;

  const csp = `default-src 'none'; ${img}; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'`;
  const { dark, sheet } = options.reading;
  const scheme = dark ? "dark" : "light";
  const s = SURFACES[scheme];

  // The document's scheme is ours, so the message's own `color-scheme` goes, and its dark-mode rules follow the
  // reading rather than the system (an iframe's prefers-color-scheme follows the OS in some browsers). A height in
  // viewport units goes too: in the frame it is the frame's height, which the viewer sets to the content's, so
  // `min-height:100vh` would grow the frame without end.
  const declaration = (
    prop: string,
    value: string,
    darkRule = false
  ): string | null => {
    if (prop === "color-scheme" || prop === "supported-color-schemes") {
      return "";
    }

    if (VIEWPORT_HEIGHT.test(value.replaceAll(/url\([^)]*\)/giu, ""))) {
      return "";
    }

    // The sender's dark-mode rules are written for a dark surface already.
    if (!dark || darkRule) {
      return null;
    }

    if (TEXT_COLOR.test(prop)) {
      return mapColors(value, darkText);
    }

    if (BACKGROUND.test(prop)) {
      return mapColors(value, darkBackground);
    }

    if (BORDER.test(prop)) {
      return mapColors(value, darkBorder);
    }

    return null;
  };

  const body = restyle(html, {
    sheet: (css) =>
      mapRules(css, declaration).replaceAll(
        PREFERS_SCHEME,
        (_, wanted: string) =>
          wanted.toLowerCase() === scheme ? "(min-width:0)" : "(max-width:0)"
      ),
    inline: (css) => mapDeclarations(css, declaration),
    attr: (name, value) => {
      if (!dark) {
        return value;
      }

      if (name === "bgcolor") {
        return mapColors(value, darkBackground);
      }

      if (name === "color") {
        return mapColors(value, darkText);
      }

      return value;
    },
  });

  const viewport = options.viewport
    ? '<meta name="viewport" content="width=device-width, initial-scale=1">'
    : "";

  return `<!doctype html><html><head><meta charset="utf-8">${viewport}<meta http-equiv="Content-Security-Policy" content="${csp}"><style>
html{color-scheme:${scheme};color:${s.text};background:${s.page}${sheet ? ";padding:12px 16px" : ""}}
html,body{height:auto!important;min-height:0!important}
body{margin:0;padding:0 1px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;overflow-wrap:break-word}
img{max-width:100%;height:auto}
blockquote{margin:0 0 0 .5em;padding-left:.8em;border-left:2px solid ${s.line};color:${s.muted}}
hr{border:0;border-top:1px solid ${s.line}}
pre{white-space:pre-wrap}
a{color:${s.link}}
.rivi-quote{margin-top:12px}
.rivi-quote>summary{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;background:${s.chip};color:${s.muted};font-size:11px;line-height:16px;cursor:pointer;list-style:none;user-select:none}
.rivi-quote>summary::-webkit-details-marker{display:none}
.rivi-quote>summary:hover{background:${s.chipHover};color:${s.text}}
.rivi-quote>summary:focus-visible{outline:2px solid ${s.link};outline-offset:2px}
.rivi-quote[open]>summary{margin-bottom:8px}
.rivi-quote[open] .rivi-show,.rivi-quote:not([open]) .rivi-hide{display:none}
</style></head><body>${body}</body></html>`;
};

interface Palette {
  darkReady: boolean;
  designed: boolean;
}

interface StyleVisitor {
  /** The text of the style element. */
  sheet: (css: string) => string;
  /** A style attribute, decoded. */
  inline: (css: string, tag: string) => string;
  /** A `bgcolor`, `color` or `background` attribute, decoded. */
  attr: (name: string, value: string, tag: string) => string;
}
