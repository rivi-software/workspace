/**
 * The markup of an HTML part as `sanitizeHtml` reads it, found by one pass that reads forward and remembers what it
 * found missing, so reading a whole part takes time linear in its length, whatever the markup (#3591). It reads what
 * a regular expression read before it, alternative by alternative, at each `<`:
 *
 * - a comment, `<!--` to the first `-->` after it;
 * - CDATA, `<![CDATA[` to the first `]]>` after it;
 * - what the browser drops as a bogus comment, `<!` or `<?` to the first `>` (a doctype, `<?xml …?>`, Outlook's
 *   `<![if !supportLists]>`, and a comment or CDATA whose end never comes);
 * - a start or end tag, its name (`[a-zA-Z][\w:-]*`) and then everything to the first `>` outside a quoted value.
 *
 * Any other `<` is text, and so is one whose `>` never comes. The expression searched again, from every `<`, for a
 * `-->`, `]]>` or `>` that was not there: a message of openings without their close took time quadratic in its size.
 */

/** A comment, CDATA, a bogus comment or a tag: from its `<` to where the text after it starts. */
export interface Markup {
  start: number;
  end: number;
  /** A tag's name in lower case; null for what is no tag (a comment, CDATA, a doctype). */
  name: string | null;
  closing: boolean;
  /** Whether a start tag ends `/>`. */
  selfClosing: boolean;
  /** What stands between a tag's name and its `>`, a self-closing `/` included, as written. */
  attrs: string;
}

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

// A tag's name, read from just after its `<`, or after the `/` of an end tag.
const TAG_NAME = /[a-zA-Z][\w:-]*/uy;

/** One part's markup being read, and what the reading found missing, so that no search reads the same characters again. */
export interface Scan {
  src: string;
  /**
   * For each `Quote`, the positions from which a tag read on in that quote reached the end of the part without its
   * `>`. The quote is all that decides how a tag reads on, so a later tag that comes to one of them in the same quote
   * ends nowhere either and stops there. Made on the first tag without its `>`.
   */
  endless: [Uint8Array, Uint8Array, Uint8Array] | null;
  /** From here on no `-->` follows: a comment opened there or later reads as a bogus comment. */
  noCommentEnd: number;
  /** From here on no `]]>` follows: CDATA opened there or later reads as a bogus comment. */
  noCdataEnd: number;
}

/** A reading of `src`'s markup, for `nextMarkup`: one per part, so that what it finds missing serves every later call. */
export const markupScan = (src: string): Scan => ({
  src,
  endless: null,
  noCommentEnd: src.length,
  noCdataEnd: src.length,
});

const skipped = (start: number, end: number): Markup => ({
  start,
  end,
  name: null,
  closing: false,
  selfClosing: false,
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

/** Where the first `close` at or after `from` ends, or -1, noting in `scan[missing]` from where none follows. */
const endOf = (
  scan: Scan,
  close: string,
  from: number,
  missing: "noCommentEnd" | "noCdataEnd"
): number => {
  if (from >= scan[missing]) {
    return -1;
  }

  const at = scan.src.indexOf(close, from);

  if (at === -1) {
    scan[missing] = from;

    return -1;
  }

  return at + close.length;
};

/** A comment, CDATA or a bogus comment at `lt`; null when no `>` follows, and then no markup does. */
const commentAt = (scan: Scan, lt: number): Markup | null => {
  const { src } = scan;
  let end = -1;

  if (src.startsWith("<!--", lt)) {
    end = endOf(scan, "-->", lt + 4, "noCommentEnd");
  } else if (src.startsWith("<![CDATA[", lt)) {
    end = endOf(scan, "]]>", lt + 9, "noCdataEnd");
  }

  if (end !== -1) {
    return skipped(lt, end);
  }

  const gt = src.indexOf(">", lt + 2);

  return gt === -1 ? null : skipped(lt, gt + 1);
};

/** A start or end tag at `lt`, or null when the `<` is text: no letter starts a name after it, or no `>` ends it. */
const tagAt = (scan: Scan, lt: number): Markup | null => {
  const { src } = scan;
  const closing = src.charAt(lt + 1) === "/";
  TAG_NAME.lastIndex = lt + (closing ? 2 : 1);
  const name = TAG_NAME.exec(src)?.[0];

  if (!name) {
    return null;
  }

  const after = TAG_NAME.lastIndex;
  const gt = tagEnd(scan, after);

  if (gt === -1) {
    return null;
  }

  return {
    start: lt,
    end: gt + 1,
    name: name.toLowerCase(),
    closing,
    selfClosing: !closing && src.charAt(gt - 1) === "/",
    attrs: src.slice(after, gt),
  };
};

/** The first markup at or after `from`, or null when the rest of the part is text. */
export const nextMarkup = (scan: Scan, from: number): Markup | null => {
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
