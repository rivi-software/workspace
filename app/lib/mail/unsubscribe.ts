import { parseJsonObject, stringOrNull } from "~/lib/guards";

/**
 * The ways out of a mailing a sender names (RFC 2369 `List-Unsubscribe`, RFC 8058 `List-Unsubscribe-Post`): a web
 * link, a mail address, and whether the link takes the one-click POST that needs no page. Parsed on ingest, kept on
 * the message as JSON, shown as an "Unsubscribe" button on the message.
 */
export interface Unsubscribe {
  http: string | null;
  mailto: string | null;
  /** The https link accepts `List-Unsubscribe=One-Click` posted to it, so the Worker can do it for the reader. */
  oneClick: boolean;
}

export const parseListUnsubscribe = (
  header: string | null | undefined,
  post: string | null | undefined
): Unsubscribe | null => {
  if (!header) {
    return null;
  }

  let http: string | null = null;
  let mailto: string | null = null;

  for (const m of header.matchAll(/<(?<url>[^>]+)>/gu)) {
    const url = m[1].trim();

    if (!http && /^https?:\/\//iu.test(url)) {
      http = url;
    } else if (!mailto && /^mailto:/iu.test(url)) {
      mailto = url;
    }
  }

  if (!http && !mailto) {
    return null;
  }

  const oneClick = !!http && /List-Unsubscribe=One-Click/iu.test(post ?? "");

  return { http, mailto, oneClick };
};

export const parseJsonUnsubscribe = (
  json: string | null | undefined
): Unsubscribe | null => {
  if (!json) {
    return null;
  }

  const raw = parseJsonObject(json);
  const link = stringOrNull(raw.http);
  const address = stringOrNull(raw.mailto);
  const http = link && /^https?:\/\//iu.test(link) ? link : null;
  const mailto = address && /^mailto:/iu.test(address) ? address : null;

  if (!http && !mailto) {
    return null;
  }

  return { http, mailto, oneClick: !!http && raw.oneClick === true };
};

/** The address and subject a `mailto:` unsubscribe link asks for. */
export const mailtoParts = (
  mailto: string
): { to: string; subject: string; body: string } | null => {
  const m = mailto.match(/^mailto:(?<address>[^?]+)(?:\?(?<query>.*))?$/iu);

  if (!m) {
    return null;
  }

  const params = new URLSearchParams(m[2] ?? "");
  const to = decodeURIComponent(m[1]).trim().toLowerCase();

  if (!to.includes("@")) {
    return null;
  }

  return {
    to,
    subject: params.get("subject")?.trim() || "Unsubscribe",
    body: params.get("body")?.trim() || "",
  };
};
