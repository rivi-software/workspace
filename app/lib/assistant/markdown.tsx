import { useRouter } from "@tanstack/react-router";
import { Fragment } from "react";
import type { ReactNode } from "react";

import { defined } from "~/lib/guards";

/**
 * The assistant's Markdown as React nodes: paragraphs, headings, lists, quotes, code, tables, and inline emphasis,
 * code and links. Never HTML: a model's answer goes through no `innerHTML`. A link opens only on http(s), mailto
 * or a path on this site (the tools' links), which the router takes.
 */

type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; level: number; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[]; start: number }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string; lang: string }
  | { kind: "table"; rows: string[][] }
  | { kind: "hr" };

const LIST = /^\s{0,3}(?:[-*•]|(?<number>\d+)[.)])\s+(?<text>.*)$/u;

/** One block read from the lines, and the line after it; `block` is null when what was read says nothing. */
interface Read {
  block: Block | null;
  next: number;
}

const readFence = (lines: string[], start: number, lang: string): Read => {
  const code: string[] = [];
  let i = start + 1;

  while (i < lines.length && !/^\s{0,3}```/u.test(lines[i])) {
    code.push(lines[i]);
    i += 1;
  }

  return { block: { kind: "code", text: code.join("\n"), lang }, next: i + 1 };
};

const readList = (
  lines: string[],
  start: number,
  item: RegExpMatchArray
): Read => {
  const ordered = item[1] !== undefined;
  const items: string[] = [];
  let i = start;

  while (i < lines.length) {
    const m = lines[i].match(LIST);

    if (m && (m[1] !== undefined) === ordered) {
      items.push(m[2]);
      i += 1;
      continue;
    }

    // A line indented under the item continues it.
    if (items.length && /^\s{2,}\S/u.test(lines[i]) && !LIST.test(lines[i])) {
      items[items.length - 1] += ` ${lines[i].trim()}`;
      i += 1;
      continue;
    }

    break;
  }

  return {
    block: ordered
      ? { kind: "ol", items, start: Number(item[1]) || 1 }
      : { kind: "ul", items },
    next: i,
  };
};

const readQuote = (lines: string[], start: number): Read => {
  const quoted: string[] = [];
  let i = start;

  while (i < lines.length && /^\s{0,3}>/u.test(lines[i])) {
    quoted.push(lines[i].replace(/^\s{0,3}>\s?/u, ""));
    i += 1;
  }

  return { block: { kind: "quote", text: quoted.join("\n") }, next: i };
};

const readTable = (lines: string[], start: number): Read => {
  const rows: string[][] = [];
  let i = start;

  while (i < lines.length && /^\s*\|.*\|\s*$/u.test(lines[i])) {
    const cells = lines[i]
      .trim()
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());

    // The separator row under the header says nothing.
    if (!cells.every((c) => /^:?-{2,}:?$/u.test(c) || c === "")) {
      rows.push(cells);
    }

    i += 1;
  }

  return { block: rows.length ? { kind: "table", rows } : null, next: i };
};

/** The block that starts at line `i`, when it is a fence, heading, rule, list, quote or table; null for a paragraph's line. */
const readBlock = (lines: string[], i: number): Read | null => {
  const line = lines[i];
  const fence = line.match(/^\s{0,3}```\s*(?<lang>\S*)/u);

  if (fence) {
    return readFence(lines, i, fence[1]);
  }

  const heading = line.match(
    /^\s{0,3}(?<hashes>#{1,6})\s+(?<text>.*?)\s*#*\s*$/u
  );

  if (heading) {
    return {
      block: { kind: "h", level: heading[1].length, text: heading[2] },
      next: i + 1,
    };
  }

  if (/^\s{0,3}(?<mark>[-*_])(?:\s*\k<mark>){2,}\s*$/u.test(line)) {
    return { block: { kind: "hr" }, next: i + 1 };
  }

  const item = line.match(LIST);

  if (item) {
    return readList(lines, i, item);
  }

  if (/^\s{0,3}>/u.test(line)) {
    return readQuote(lines, i);
  }

  return /^\s*\|.*\|\s*$/u.test(line) ? readTable(lines, i) : null;
};

export const parseMarkdown = (source: string): Block[] => {
  const lines = source.replaceAll(/\r\n?/gu, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  let i = 0;

  const flushParagraph = () => {
    const text = para.join("\n").trim();
    para = [];

    if (text) {
      blocks.push({ kind: "p", text });
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const read = readBlock(lines, i);

    if (read) {
      flushParagraph();

      if (read.block) {
        blocks.push(read.block);
      }

      i = read.next;
    } else if (line.trim()) {
      para.push(line);
      i += 1;
    } else {
      flushParagraph();
      i += 1;
    }
  }

  flushParagraph();

  return blocks;
};

/* ---------- inline ---------- */

const INLINE =
  /(?<code>`[^`\n]+`)|(?<strong>\*\*[^*\n]+\*\*)|(?<strongUnderscore>__[^_\n]+__)|(?<em>\*[^*\n]+\*)|(?<emUnderscore>\b_[^_\n]+_\b)|(?<link>\[[^\]\n]+\]\([^)\s]+\))|(?<url>https?:\/\/[^\s<>)]+)/gu;

/** Whether a link's target is one the page may open: the web, mail, or a path here. */
export const safeHref = (href: string): string | null => {
  const h = href.trim();

  if (/^https?:\/\//iu.test(h) || /^mailto:/iu.test(h)) {
    return h;
  }

  if (/^\/(?!\/)/u.test(h)) {
    return h;
  }

  return null;
};

/** A newline inside a paragraph is a line break, as the models write lists of facts. */
const softBreaks = (text: string, key: number): ReactNode => {
  const lines = text.split("\n");

  if (lines.length === 1) {
    return <Fragment key={key}>{text}</Fragment>;
  }

  return (
    <Fragment key={key}>
      {lines.map((l, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {l}
        </Fragment>
      ))}
    </Fragment>
  );
};

const MarkdownLink = ({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) => {
  const router = useRouter();
  const safe = safeHref(href);

  if (!safe) {
    return children;
  }

  const internal = safe.startsWith("/");

  return (
    <a
      href={safe}
      className="text-accent hover:text-accent-hover underline underline-offset-2"
      target={internal ? undefined : "_blank"}
      rel={internal ? undefined : "noopener noreferrer"}
      onClick={
        internal
          ? (e) => {
              if (
                e.metaKey ||
                e.ctrlKey ||
                e.shiftKey ||
                e.altKey ||
                e.button !== 0
              ) {
                return;
              }

              e.preventDefault();
              void router.navigate({ href: safe });
            }
          : undefined
      }
    >
      {children}
    </a>
  );
};

const inline = (text: string): ReactNode[] => {
  const out: ReactNode[] = [];
  let last = 0;

  // `matchAll` scans with its own copy of the expression: the recursive calls for emphasis and link labels below
  // would otherwise reset the shared `lastIndex` and send this loop back to the same match, forever.
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) {
      out.push(softBreaks(text.slice(last, m.index), out.length));
    }

    const [raw] = m;

    if (m[1]) {
      out.push(
        <code
          key={out.length}
          className="bg-hover rounded-[4px] px-1 py-px font-mono text-[0.92em]"
        >
          {raw.slice(1, -1)}
        </code>
      );
    } else if (m[2] || m[3]) {
      out.push(
        <strong key={out.length} className="font-semibold">
          {inline(raw.slice(2, -2))}
        </strong>
      );
    } else if (m[4] || m[5]) {
      out.push(<em key={out.length}>{inline(raw.slice(1, -1))}</em>);
    } else if (m[6]) {
      const link = defined(
        raw.match(/^\[(?<label>[^\]]+)\]\((?<href>[^)]+)\)$/u),
        "the result of match"
      );

      out.push(
        <MarkdownLink key={out.length} href={link[2]}>
          {inline(link[1])}
        </MarkdownLink>
      );
    } else if (m[7]) {
      // A closing bracket or a full stop at the end belongs to the sentence, not the address.
      const trimmed = raw.replace(/[.,;:!?]+$/u, "");
      out.push(
        <MarkdownLink key={out.length} href={trimmed}>
          {trimmed}
        </MarkdownLink>
      );

      if (trimmed.length < raw.length) {
        out.push(raw.slice(trimmed.length));
      }
    }

    last = m.index + raw.length;
  }

  if (last < text.length) {
    out.push(softBreaks(text.slice(last), out.length));
  }

  return out;
};

/* ---------- blocks ---------- */

const DEFAULT_HEADING_CLASS = "text-base font-medium";

const HEADING_CLASS = new Map([
  [1, "text-md font-semibold"],
  [2, "text-md font-medium"],
  [3, DEFAULT_HEADING_CLASS],
]);

const Blocks = ({ blocks }: { blocks: Block[] }) => (
  <>
    {blocks.map((b, i) => {
      const key = i;

      switch (b.kind) {
        case "p": {
          return (
            <p key={key} className="mb-2 last:mb-0">
              {inline(b.text)}
            </p>
          );
        }

        case "h": {
          return (
            <p
              key={key}
              className={`mt-3 mb-1 first:mt-0 ${HEADING_CLASS.get(b.level) ?? DEFAULT_HEADING_CLASS}`}
            >
              {inline(b.text)}
            </p>
          );
        }

        case "ul": {
          return (
            <ul key={key} className="mb-2 list-disc space-y-0.5 pl-5 last:mb-0">
              {b.items.map((item, j) => (
                <li key={j}>{inline(item)}</li>
              ))}
            </ul>
          );
        }

        case "ol": {
          return (
            <ol
              key={key}
              start={b.start}
              className="mb-2 list-decimal space-y-0.5 pl-5 last:mb-0"
            >
              {b.items.map((item, j) => (
                <li key={j}>{inline(item)}</li>
              ))}
            </ol>
          );
        }

        case "quote": {
          return (
            <blockquote
              key={key}
              className="border-line-strong text-muted mb-2 border-l-2 pl-3 last:mb-0"
            >
              <Blocks blocks={parseMarkdown(b.text)} />
            </blockquote>
          );
        }

        case "code": {
          return (
            <pre
              key={key}
              className="border-line bg-sidebar mb-2 overflow-x-auto rounded-md border p-3 font-mono text-xs leading-4 last:mb-0"
            >
              <code>{b.text}</code>
            </pre>
          );
        }

        case "table": {
          return (
            <div key={key} className="mb-2 overflow-x-auto last:mb-0">
              <table className="w-full border-collapse text-sm">
                <tbody>
                  {b.rows.map((row, r) => (
                    <tr key={r} className="border-line border-b last:border-0">
                      {row.map((cell, c) =>
                        r === 0 ? (
                          <th
                            key={c}
                            className="text-muted py-1 pr-3 text-left font-medium"
                          >
                            {inline(cell)}
                          </th>
                        ) : (
                          <td key={c} className="py-1 pr-3 align-top">
                            {inline(cell)}
                          </td>
                        )
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        case "hr": {
          return <hr key={key} className="border-line my-3" />;
        }

        default: {
          return null;
        }
      }
    })}
  </>
);

/** The assistant's text, rendered. */
export const Markdown = ({
  text,
  className,
}: {
  text: string;
  className?: string;
}) => (
  <div className={className}>
    <Blocks blocks={parseMarkdown(text)} />
  </div>
);
