import { isFolder } from "./folders";
import type { Folder } from "./folders";

/**
 * The search box's language, as Gmail reads it: free words, quoted phrases and `field:value` operators, any of them
 * negated with a `-` in front. `from:jane`, `to:me@x`, `subject:"the plan"`, `has:attachment`, `is:unread`,
 * `is:starred`, `is:read`, `is:snoozed`, `is:muted`, `in:trash`, `label:clients`, `before:2026-10-01`,
 * `after:2026-09-01`. A field nobody knows is searched as text, so `re:plan` finds what it says.
 */

export const QUERY_FIELDS = [
  "from",
  "to",
  "subject",
  "has",
  "is",
  "in",
  "label",
  "before",
  "after",
] as const;

type KnownQueryField = (typeof QUERY_FIELDS)[number];

export type QueryField = KnownQueryField | "text";

const isQueryField = (value: string): value is KnownQueryField =>
  QUERY_FIELDS.some((known) => known === value);

export interface QueryTerm {
  field: QueryField;
  value: string;
  negated: boolean;
}

const TOKEN =
  /(?<minus>-?)(?:(?<rawField>[a-z]+):)?(?:"(?<quoted>[^"]*)"|(?<bare>\S+))/giu;

export const parseQuery = (q: string): QueryTerm[] => {
  const terms: QueryTerm[] = [];
  TOKEN.lastIndex = 0;

  for (let m = TOKEN.exec(q); m; m = TOKEN.exec(q)) {
    const [, minus, rawField, quoted, bare] = m;
    const value = (quoted ?? bare ?? "").trim();
    const field = rawField?.toLowerCase();

    if (field && isQueryField(field)) {
      if (!value) {
        continue;
      }

      terms.push({ field, value, negated: minus === "-" });
      continue;
    }

    // `from:` with nothing after it says nothing; `re:plan` is no operator, so the whole token is the text.
    if (
      !field &&
      /^[a-z]+:$/iu.test(value) &&
      isQueryField(value.slice(0, -1).toLowerCase())
    ) {
      continue;
    }

    const text = field ? `${field}:${value}` : value;

    if (!text) {
      continue;
    }

    terms.push({ field: "text", value: text, negated: minus === "-" });
  }

  return terms;
};

/** A `before:`/`after:` value as the start of that day in UTC, or null for anything that is no date. */
export const queryDate = (value: string): string | null => {
  const m = value.match(/^(?<year>\d{4})-(?<month>\d{1,2})-(?<day>\d{1,2})$/u);

  if (!m) {
    return null;
  }

  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));

  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** The words of a query without its operators, for the "Search results for …" line. */
export const queryWords = (terms: QueryTerm[]): string =>
  terms
    .map((t) => {
      const value = /\s/u.test(t.value) ? `"${t.value}"` : t.value;

      return `${t.negated ? "-" : ""}${t.field === "text" ? "" : `${t.field}:`}${value}`;
    })
    .join(" ");

/**
 * Where a search looks: `in:` when the query says, else the trash or spam folder when the search started there (they
 * hold what nothing else shows), else all mail, as Gmail searches.
 */
export const searchScope = (
  folder: Folder,
  terms: QueryTerm[]
): Folder | "anywhere" => {
  const scoped = terms.find((t) => t.field === "in" && !t.negated);

  if (scoped) {
    const v = scoped.value.toLowerCase();

    if (v === "anywhere" || v === "all" || v === "everywhere") {
      return "anywhere";
    }

    if (v === "all mail" || v === "allmail") {
      return "archive";
    }

    if (isFolder(v)) {
      return v;
    }
  }

  return folder === "trash" || folder === "spam" ? folder : "archive";
};
