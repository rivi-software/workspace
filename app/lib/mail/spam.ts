/**
 * The spam filter: what a message that arrives is scored on, and the words it learnt from, in a plain module so
 * the tests can judge a message without a mailbox and the thread page can say why one is in Spam. `spam.server.ts`
 * adds what the mailbox knows (blocked and allowed senders, the people the owner writes to, what it learnt from
 * "Report spam" and "Not spam") and decides.
 *
 * A message is spam at `SPAM_THRESHOLD` points or more: the rules below (Cloudflare's own score and checks, our
 * domain claimed from outside, a program attached, a link that shows one address and goes to another, …) plus what
 * the person's own verdicts taught a Bayesian filter (Robinson's chi-square combining, as SpamBayes does).
 */
import type { Address } from "~/db/schema";
import { defined, numberOr, parseJsonObject, stringList } from "~/lib/guards";

import { isValidEmail } from "./addresses";
import { decodeEntities } from "./sanitize";

/** Points at which a message goes to Spam. */
export const SPAM_THRESHOLD = 5;

/** Points from the rules alone (the learnt words left out) at which a message also teaches the filter spam. */
export const LEARN_SPAM_POINTS = 8;

/** The host whose `Authentication-Results` Cloudflare's Email Routing writes; a sender can write the name too. */
export const CLOUDFLARE_MX = "mx.cloudflare.net";

/** What Cloudflare's MX found when it took the message in. */
export interface ReceivedChecks {
  /** `X-CF-SpamH-Score`: 0 (clean) to 5 (spam), Cloudflare's look at the headers and the text; null when absent. */
  score: number | null;
  /** SPF for the envelope sender (`smtp.mailfrom`): pass, fail, softfail, neutral, none, temperror, permerror. */
  spf: string | null;
  /** "pass" when any DKIM signature verified, else the first result. */
  dkim: string | null;
  /** The domains (`header.d`) whose DKIM signatures verified. */
  dkimDomains: string[];
  dmarc: string | null;
}

/** What the headers say about a message beyond its addresses and text. */
export interface SpamSignals {
  /** Null when Cloudflare's MX left nothing we can trust (a local delivery, an import). */
  checks: ReceivedChecks | null;
  noDate: boolean;
  noMessageId: boolean;
  /** List or bulk mail (`List-Id`, `List-Unsubscribe`): its links go through trackers and its names through lists. */
  bulk: boolean;
}

interface Header {
  key: string;
  value: string;
}

/** One result of an `Authentication-Results` header: `dkim=pass header.d=acme.com` as its method, result and properties. */
export interface AuthResult {
  method: string;
  result: string;
  props: Record<string, string>;
}

const stripComments = (value: string): string => {
  let out = "";
  let depth = 0;
  let quoted = false;

  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];

    if (ch === "\\" && i + 1 < value.length) {
      if (!depth) {
        out += ch + value[i + 1];
      }

      i += 1;
      continue;
    }

    if (ch === '"' && !depth) {
      quoted = !quoted;
    }

    if (!quoted && ch === "(") {
      depth += 1;
    } else if (!quoted && ch === ")" && depth) {
      depth -= 1;
    } else if (!depth) {
      out += ch;
    }
  }

  return out;
};

export interface ParsedAuthenticationResults {
  authservId: string;
  results: AuthResult[];
}

/** An `Authentication-Results` header (RFC 8601): who wrote it, and each method's result, comments dropped. */
export const parseAuthenticationResults = (
  value: string
): ParsedAuthenticationResults => {
  const [head = "", ...parts] = stripComments(value).split(";");
  const results: AuthResult[] = [];

  for (const part of parts) {
    const words = part.trim().split(/\s+/u).filter(Boolean);
    const m = words[0]?.match(/^(?<method>[a-z0-9-]+)=(?<result>[a-z]+)$/iu);

    if (!m) {
      continue;
    }

    const props: Record<string, string> = {};

    for (const w of words.slice(1)) {
      const p = w.match(/^(?<prop>[a-z]+\.[a-z0-9-]+)=(?<value>.+)$/iu);

      if (p) {
        props[p[1].toLowerCase()] = p[2].replaceAll(/^"|"$/gu, "");
      }
    }

    results.push({
      method: m[1].toLowerCase(),
      result: m[2].toLowerCase(),
      props,
    });
  }

  return {
    authservId: head.trim().split(/\s+/u)[0]?.toLowerCase() ?? "",
    results,
  };
};

/**
 * The headers the receiving MX wrote: Cloudflare puts its own on top, so they come before the first `Received`
 * line another server wrote. What a sender wrote comes below, and a forged `Authentication-Results` naming
 * mx.cloudflare.net sits there, under Cloudflare's own.
 */
const receivingBlock = (headers: Header[]): Header[] => {
  const block: Header[] = [];

  for (const h of headers) {
    if (
      h.key === "received" &&
      !/\bby\s+[\w.-]*\.cloudflare\.net\b/iu.test(h.value)
    ) {
      break;
    }

    block.push(h);
  }

  return block;
};

/** Cloudflare's verdicts on a message, from the topmost of its headers; null when it left none. */
export const receivedChecks = (headers: Header[]): ReceivedChecks | null => {
  const block = receivingBlock(headers);

  const ours = block
    .filter((h) => h.key === "authentication-results")
    .map((h) => parseAuthenticationResults(h.value))
    .find((r) => r.authservId === CLOUDFLARE_MX);

  const rawScore = block.find((h) => h.key === "x-cf-spamh-score")?.value;

  // oxlint-disable-next-line unicorn/prefer-number-coercion -- parseFloat reads the number in front of any trailing text; Number would make such a score NaN, which reads as no score
  const parsedScore = Number.parseFloat(rawScore ?? "");

  const score = Number.isFinite(parsedScore)
    ? Math.min(5, Math.max(0, parsedScore))
    : null;

  if (!ours && score === null) {
    return null;
  }

  const results = ours?.results ?? [];
  const of = (method: string) => results.filter((r) => r.method === method);
  // Cloudflare can check the HELO name and the envelope sender; the envelope sender is the one that counts.
  const spf = of("spf").find((r) => r.props["smtp.mailfrom"]) ?? of("spf")[0];
  const dkim = of("dkim");
  const passed = dkim.filter((r) => r.result === "pass");

  return {
    score,
    spf: spf?.result ?? null,
    dkim: passed.length ? "pass" : (dkim[0]?.result ?? null),
    dkimDomains: passed
      .map((r) => (r.props["header.d"] ?? "").toLowerCase())
      .filter(Boolean),
    dmarc: of("dmarc")[0]?.result ?? null,
  };
};

/** What a message's headers say for the filter (postal-mime's list: keys lower-cased, top to bottom). */
export const mailSignals = (headers: Header[]): SpamSignals => {
  const has = (key: string) => headers.some((h) => h.key === key);

  return {
    checks: receivedChecks(headers),
    noDate: !has("date"),
    noMessageId: !has("message-id"),
    bulk: has("list-id") || has("list-unsubscribe"),
  };
};

/* ---------- addresses and links ---------- */

export const domainOf = (email: string): string =>
  email.slice(email.lastIndexOf("@") + 1).toLowerCase();

// The second levels under a country's domain that are no one's own: `acme.co.uk` belongs to acme, not `co.uk`.
const SECOND_LEVEL = new Set(
  "ac co com edu gob gov go ltd me mil ne net nhs nom or org plc sch".split(" ")
);

/** The part of a host its owner registered, near enough without the public suffix list. */
export const baseDomain = (host: string): string => {
  const labels = host.toLowerCase().replace(/\.$/u, "").split(".");

  if (labels.length <= 2) {
    return labels.join(".");
  }

  const [second, top] = labels.slice(-2);

  return labels
    .slice(top.length === 2 && SECOND_LEVEL.has(second) ? -3 : -2)
    .join(".");
};

const sameOwner = (a: string, b: string) => baseDomain(a) === baseDomain(b);

/** The free mailbox providers anyone can make an address at in a minute. */
const FREE_MAIL = new Set(
  "gmail.com googlemail.com outlook.com hotmail.com live.com msn.com yahoo.com ymail.com aol.com icloud.com me.com proton.me protonmail.com gmx.com gmx.net gmx.de mail.com mail.ru yandex.ru yandex.com zoho.com".split(
    " "
  )
);

const URL_HOST = /\bhttps?:\/\/(?<host>\[[0-9a-f:.]+\]|[^\s/?#:<>"')\]]+)/giu;

const ANCHOR =
  /<a\b[^>]*?\bhref\s*=\s*(?:"(?<doubleQuoted>[^"]*)"|'(?<singleQuoted>[^']*)'|(?<unquoted>[^\s>]+))[^>]*>(?<text>[\s\S]*?)<\/a\s*>/giu;

const IP_HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/iu;

const hostOf = (url: string): string | null => {
  const m = decodeEntities(url)
    .trim()
    .match(/^https?:\/\/(?<host>\[[0-9a-f:.]+\]|[^\s/?#:]+)/iu);

  return m ? m[1].toLowerCase().replace(/\.$/u, "") : null;
};

/** The hosts the message links to: its HTML part's links and the addresses written in its text. */
export const linkHosts = (text: string, html: string | null): string[] => {
  const hosts = new Set<string>();

  for (const m of html?.matchAll(ANCHOR) ?? []) {
    const host = hostOf(m[1] ?? m[2] ?? m[3] ?? "");

    if (host) {
      hosts.add(host);
    }
  }

  for (const m of text.matchAll(URL_HOST)) {
    hosts.add(m[1].toLowerCase().replace(/\.$/u, ""));
  }

  return [...hosts].slice(0, 50);
};

/** Links whose text is an address (`https://bank.com/login`, `www.bank.com`) on another site than they go to. */
export const deceptiveLinks = (
  html: string | null
): { shown: string; goes: string }[] => {
  const out: { shown: string; goes: string }[] = [];

  for (const m of html?.matchAll(ANCHOR) ?? []) {
    const goes = hostOf(m[1] ?? m[2] ?? m[3] ?? "");

    if (!goes) {
      continue;
    }

    const text = decodeEntities(m[4].replaceAll(/<[^>]*>/gu, ""))
      .trim()
      .toLowerCase();

    const shown = text.match(
      /^(?:https?:\/\/|www\.)(?<domain>[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?:[:/?#]\S*)?$/u
    );

    if (shown && !sameOwner(shown[1], goes)) {
      out.push({ shown: shown[1], goes });
    }
  }

  return out;
};

const extension = (filename: string): string => {
  const dot = filename.lastIndexOf(".");

  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
};

// Programs and scripts: mail between people never needs to bring one.
const PROGRAMS = new Set(
  "exe scr pif com bat cmd vbs vbe js jse wsf wsh hta msi msp cpl jar ps1 psm1 lnk reg iso img vhd vhdx appx msix appinstaller application gadget chm inf sct".split(
    " "
  )
);

const MACROS = new Set("docm dotm xlsm xltm xlam pptm potm ppam".split(" "));

// A web page as a file opens in the browser from the disk, out of reach of the mail client's protections.
const PAGES = new Set("html htm shtml xhtml mht mhtml svg".split(" "));

/* ---------- the rules ---------- */

export interface SpamInput {
  from: Address;
  replyTo: Address | null;
  to: Address[];
  cc: Address[];
  subject: string;
  text: string;
  html: string | null;
  /** The Date header as ISO (now, when it had none). */
  date: string;
  attachments: { filename: string; inline: boolean }[];
  signals: SpamSignals | null;
}

/** A rule that held: its name (for the logs), its points, and why in words (for the thread page). */
export interface RuleHit {
  rule: string;
  points: number;
  reason: string;
}

const round = (n: number) => Math.round(n * 10) / 10;

type Hit = (rule: string, points: number, reason: string) => void;

/** What the rules read of a message, worked out once. */
interface RuleContext {
  m: SpamInput;
  bulk: boolean;
  fromDomain: string;
  ownDomain: string;
  now?: number;
}

/** The rules of the authentication checks Cloudflare's MX wrote: its score, DMARC, SPF. */
const authenticationRules = (
  { m, fromDomain, ownDomain }: RuleContext,
  hit: Hit
) => {
  const checks = m.signals?.checks ?? null;

  const claimsOurs =
    fromDomain === ownDomain || fromDomain.endsWith(`.${ownDomain}`);

  if (checks?.score) {
    hit(
      "cloudflare-score",
      checks.score * 0.9,
      `Cloudflare's spam check rated it ${checks.score} out of 5.`
    );
  }

  if (checks?.dmarc === "fail") {
    if (claimsOurs) {
      hit(
        "own-domain",
        6,
        `It claims to come from ${ownDomain} but was sent from elsewhere.`
      );
    } else {
      hit(
        "dmarc-fail",
        3,
        `${fromDomain} did not vouch for it: its DMARC check failed.`
      );
    }
  }

  if (checks?.dkim !== "pass") {
    if (checks?.spf === "fail") {
      hit(
        "spf-fail",
        2,
        `It came from a server ${fromDomain} does not send from, without a valid signature.`
      );
    } else if (checks?.spf === "softfail") {
      hit(
        "spf-softfail",
        1,
        `It came from a server ${fromDomain} does not list as its own.`
      );
    }
  }
};

/** The rules of who the message says it is from and where replies go. */
const senderRules = (
  { m, bulk, fromDomain, ownDomain }: RuleContext,
  hit: Hit
) => {
  const named = m.from.name
    ?.match(/[^\s<>"'()]+@[^\s<>"'()]+\.[a-z]{2,}/iu)?.[0]
    .toLowerCase();

  if (named && named !== m.from.email && !bulk) {
    const ours =
      domainOf(named) === ownDomain ||
      defined(m.from.name, "the name").toLowerCase().includes(ownDomain);

    hit(
      "name-address",
      ours ? 3.5 : 2.5,
      `Its sender's name shows ${named}, but it came from ${m.from.email}.`
    );
  }

  if (m.replyTo && !bulk) {
    const replyDomain = domainOf(m.replyTo.email);

    if (!sameOwner(replyDomain, fromDomain)) {
      const free = FREE_MAIL.has(replyDomain);
      hit(
        "reply-elsewhere",
        free ? 2.5 : 1,
        free
          ? `Replies would go to a free mailbox (${m.replyTo.email}), not to ${fromDomain}.`
          : `Replies would go to ${replyDomain}, not to ${fromDomain}.`
      );
    }
  }
};

/** The rules of the files a message carries. */
const attachmentRules = ({ m }: RuleContext, hit: Hit) => {
  const files = m.attachments.filter((a) => !a.inline);
  const program = files.find((a) => PROGRAMS.has(extension(a.filename)));
  const macro = files.find((a) => MACROS.has(extension(a.filename)));
  const page = files.find((a) => PAGES.has(extension(a.filename)));

  if (program) {
    hit(
      "program",
      5,
      `It carries a program (${program.filename}), which mail should never bring.`
    );
  } else if (macro) {
    hit("macro", 3, `It carries a document with macros (${macro.filename}).`);
  }

  if (page) {
    hit(
      "page-file",
      2.5,
      `It carries a web page as a file (${page.filename}).`
    );
  }
};

/** The rules of the links and the subject. */
const contentRules = ({ m, bulk }: RuleContext, hit: Hit) => {
  const [deceptive] = deceptiveLinks(m.html);

  if (deceptive) {
    hit(
      "deceptive-link",
      bulk ? 1 : 2.5,
      `A link shows ${deceptive.shown} but goes to ${deceptive.goes}.`
    );
  }

  const ip = linkHosts(m.text, m.html).find((h) => IP_HOST.test(h));

  if (ip) {
    hit("ip-link", 2, `A link goes to a bare IP address (${ip}).`);
  }

  const letters = m.subject.match(/\p{L}/gu) ?? [];
  const upper = m.subject.match(/\p{Lu}/gu) ?? [];

  if (letters.length >= 12 && upper.length / letters.length >= 0.8) {
    hit("shouting", 1, "Its subject is in capitals.");
  }
};

/** The rules of what a message's headers lack or get wrong. */
const headerRules = ({ m, bulk, now }: RuleContext, hit: Hit) => {
  if (m.signals?.noMessageId) {
    hit(
      "no-message-id",
      1.5,
      "It came without the Message-ID every mail program writes."
    );
  }

  if (m.signals?.noDate) {
    hit("no-date", 1, "It came without a date.");
  } else if (Date.parse(m.date) > (now ?? Date.now()) + 2 * 86_400_000) {
    hit("future-date", 1.5, "Its date lies in the future.");
  }

  if (!m.to.length && !m.cc.length && !bulk) {
    hit("no-recipient", 1, "It names no recipient.");
  }
};

/** The rules a message meets. `mailDomain` is the team's own domain, which only its own servers may send as. */
export const spamRules = (
  m: SpamInput,
  context: { mailDomain: string; now?: number }
): RuleHit[] => {
  const hits: RuleHit[] = [];

  const hit: Hit = (rule, points, reason) =>
    hits.push({ rule, points: round(points), reason });

  const rules: RuleContext = {
    m,
    bulk: m.signals?.bulk ?? false,
    fromDomain: domainOf(m.from.email),
    ownDomain: context.mailDomain.toLowerCase(),
    now: context.now,
  };

  authenticationRules(rules, hit);
  senderRules(rules, hit);
  attachmentRules(rules, hit);
  contentRules(rules, hit);
  headerRules(rules, hit);

  return hits;
};

/* ---------- what the filter learnt ---------- */

/** A word's count among the messages learnt as spam and as kept mail (ham). */
export interface TokenCounts {
  spam: number;
  ham: number;
}

/** The row whose counts are the messages learnt; no word is this one, for a word never holds a space. */
export const TOTAL_TOKEN = " messages";

/** The words a message contributes at most: the sender's and the subject's first, then the links, then the text. */
export const MAX_TOKENS = 400;

/** The filter says nothing until it learnt this many messages of each kind. */
export const MIN_LEARNT = 10;

export interface TokenSource {
  from: Address;
  replyTo: Address | null;
  subject: string;
  text: string;
  html: string | null;
  attachments: { filename: string; inline: boolean }[];
}

const words = (value: string): string[] => {
  const out: string[] = [];

  for (const raw of value
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{N}'’$€-]*/gu) ?? []) {
    const w = raw.replace(/['’-]+$/u, "");

    if (w.length < 3 || w.length > 24 || /^\d+$/u.test(w)) {
      continue;
    }

    out.push(w);
  }

  return out;
};

/** The words of a message, as the filter counts them: each once, `subject:`, `from:`, `url:` and `file:` apart. */
export const spamTokens = (m: TokenSource): string[] => {
  const out = new Set<string>();

  const add = (t: string) => {
    if (out.size < MAX_TOKENS) {
      out.add(t);
    }
  };

  add(`from:${m.from.email}`);
  add(`from@${domainOf(m.from.email)}`);

  if (m.replyTo && m.replyTo.email !== m.from.email) {
    add(`reply@${domainOf(m.replyTo.email)}`);
  }

  for (const w of words(m.subject)) {
    add(`subject:${w}`);
  }

  for (const a of m.attachments) {
    if (!a.inline) {
      add(`file:${extension(a.filename) || "none"}`);
    }
  }

  for (const host of linkHosts(m.text, m.html)) {
    add(`url:${baseDomain(host)}`);
  }

  for (const w of words(m.text)) {
    add(w);
  }

  return [...out];
};

// SpamBayes' defaults: how much an unknown word leans (not at all) and how strongly; the words that count.
const UNKNOWN_PROB = 0.5;
const UNKNOWN_STRENGTH = 0.45;
const MIN_PROB_STRENGTH = 0.1;
const MAX_CLUES = 150;

/** The chance that a chi-squared value this large or larger comes by chance, for an even number of degrees. */
const chi2Q = (x2: number, v: number): number => {
  const m = x2 / 2;
  let term = Math.exp(-m);
  let sum = term;

  for (let i = 1; i < v / 2; i += 1) {
    term *= m / i;
    sum += term;
  }

  return Math.min(sum, 1);
};

/**
 * How spammy the words read, 0 to 1, from the counts the person's verdicts left (Robinson's chi-square combining);
 * null until the filter learnt `MIN_LEARNT` messages of each kind.
 */
export const spamProbability = (
  tokens: string[],
  counts: Map<string, TokenCounts>,
  totals: TokenCounts
): number | null => {
  if (totals.spam < MIN_LEARNT || totals.ham < MIN_LEARNT) {
    return null;
  }

  const clues: number[] = [];

  for (const t of tokens) {
    const c = counts.get(t);

    if (!c || c.spam + c.ham <= 0) {
      continue;
    }

    const spamRatio = Math.min(1, c.spam / totals.spam);
    const hamRatio = Math.min(1, c.ham / totals.ham);
    const p = spamRatio / (spamRatio + hamRatio);
    const n = c.spam + c.ham;

    const f =
      (UNKNOWN_STRENGTH * UNKNOWN_PROB + n * p) / (UNKNOWN_STRENGTH + n);

    if (Math.abs(f - 0.5) >= MIN_PROB_STRENGTH) {
      clues.push(f);
    }
  }

  if (!clues.length) {
    return 0.5;
  }

  clues.sort((a, b) => Math.abs(b - 0.5) - Math.abs(a - 0.5));
  const used = clues.slice(0, MAX_CLUES);
  let spamLog = 0;
  let hamLog = 0;

  for (const f of used) {
    spamLog += Math.log(1 - f);
    hamLog += Math.log(f);
  }

  const s = 1 - chi2Q(-2 * spamLog, 2 * used.length);
  const h = 1 - chi2Q(-2 * hamLog, 2 * used.length);

  return (s - h + 1) / 2;
};

/** What the learnt words add to the points: up for mail that reads like the person's spam, down for their own. */
export const learntHit = (probability: number | null): RuleHit | null => {
  if (probability === null) {
    return null;
  }

  const spammy = "It reads like the mail you marked as spam.";
  const kept = "It reads like the mail you keep.";

  if (probability >= 0.98) {
    return { rule: "learnt", points: 5, reason: spammy };
  }

  if (probability >= 0.9) {
    return { rule: "learnt", points: 3.5, reason: spammy };
  }

  if (probability >= 0.75) {
    return { rule: "learnt", points: 1.5, reason: spammy };
  }

  if (probability <= 0.02) {
    return { rule: "learnt", points: -4, reason: kept };
  }

  if (probability <= 0.1) {
    return { rule: "learnt", points: -2.5, reason: kept };
  }

  if (probability <= 0.25) {
    return { rule: "learnt", points: -1, reason: kept };
  }

  return null;
};

/* ---------- the verdict a message keeps ---------- */

/** Why a message went to Spam on its own, kept on it as `messages.spam_json` for the thread page. */
export interface SpamCheck {
  /** A filter of the owner's, a sender they blocked, a conversation already in Spam, or the points. */
  by: "filter" | "blocked" | "conversation" | "score";
  /** The points it scored; 0 for a verdict without them. */
  score: number;
  /** The rules that held, for the logs. */
  rules: string[];
  /** Why, in words, the weightiest first. */
  reasons: string[];
}

const SPAM_CHECK_VERDICTS = [
  "filter",
  "blocked",
  "conversation",
  "score",
] as const;

export const parseSpamCheck = (
  json: string | null | undefined
): SpamCheck | null => {
  if (!json) {
    return null;
  }

  const v = parseJsonObject(json);
  const by = SPAM_CHECK_VERDICTS.find((known) => known === v.by);

  if (!by) {
    return null;
  }

  return {
    by,
    score: numberOr(v.score, 0),
    rules: stringList(v.rules),
    reasons: stringList(v.reasons),
  };
};

/**
 * What the first `<…>` with something in it holds, as `/<([^>]+)>/` read it, in one pass: that regex starts again
 * at every `<`, and a run of `<` that no `>` closes took seconds (#2730).
 */
const inAngles = (v: string): string | null => {
  for (
    let open = v.indexOf("<");
    open !== -1;
    open = v.indexOf("<", open + 1)
  ) {
    const close = v.indexOf(">", open + 1);

    if (close === -1) {
      return null;
    }

    if (close > open + 1) {
      return v.slice(open + 1, close);
    }
  }

  return null;
};

/* ---------- blocked and allowed senders ---------- */

/**
 * What a person typed as a sender to block or allow (`Jane <jane@acme.com>`, `jane@acme.com`, `@acme.com` or
 * `acme.com`) as the rule kept: a lower-cased address, or a domain behind its at. Null when it is neither.
 */
export const senderRuleOf = (input: string): string | null => {
  let v = input.trim().toLowerCase();
  const angle = inAngles(v);

  if (angle !== null) {
    v = angle.trim();
  }

  if (v.startsWith("@")) {
    v = v.slice(1);
  } else if (v.includes("@")) {
    return isValidEmail(v) ? v : null;
  }

  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/u.test(v) ? `@${v}` : null;
};

export const senderRuleMatches = (sender: string, email: string): boolean => {
  if (!sender.startsWith("@")) {
    return sender === email.toLowerCase();
  }

  const domain = sender.slice(1);
  const d = domainOf(email);

  return d === domain || d.endsWith(`.${domain}`);
};

/** The rule that decides for an address: its own before its domain's, a nearer domain before a farther one. */
export const senderRuleFor = <T extends { sender: string }>(
  rules: T[],
  email: string
): T | null => {
  let best: T | null = null;

  for (const r of rules) {
    if (!senderRuleMatches(r.sender, email)) {
      continue;
    }

    if (!r.sender.startsWith("@")) {
      return r;
    }

    if (!best || r.sender.length > best.sender.length) {
      best = r;
    }
  }

  return best;
};

/** `jane@acme.com`, or `everyone at acme.com` for a domain's rule. */
export const describeSender = (sender: string): string =>
  sender.startsWith("@") ? `everyone at ${sender.slice(1)}` : sender;
