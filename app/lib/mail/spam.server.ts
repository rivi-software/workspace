import {
  and,
  asc,
  desc,
  eq,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";

import type { Database } from "~/db";
import {
  attachments,
  contacts,
  messages,
  senderRules,
  spamTokens as spamTokenRows,
} from "~/db/schema";
import type { Message, SenderRule, Thread, User } from "~/db/schema";

import type { FilterOutcome } from "./filters.server";
import type { ParsedMail } from "./ingest.server";
import {
  LEARN_SPAM_POINTS,
  SPAM_THRESHOLD,
  TOTAL_TOKEN,
  describeSender,
  learntHit,
  senderRuleFor,
  senderRuleOf,
  spamProbability,
  spamRules,
  spamTokens,
} from "./spam";
import type { SpamCheck, TokenCounts } from "./spam";

export class SpamError extends Error {
  override name = "SpamError";
}

/** What the filter made of a message that arrives. */
export interface Judgement {
  spam: boolean;
  /** Why it goes to Spam, kept on the message; null when it does not. */
  check: SpamCheck | null;
  /** What the message teaches the filter: mail from someone the owner writes to is kept, clear spam is spam. */
  learn: "spam" | "ham" | null;
  /** How it was decided, for the logs. */
  verdict:
    | "filter"
    | "blocked"
    | "allowed"
    | "never-spam"
    | "known"
    | "conversation"
    | "score";
  /** The points and the rules that held, for the logs (only a scored message has them). */
  score: number | null;
  rules: string[];
  tokens: string[];
}

/** Whether the owner wrote to this address (`contacts.written_at`). */
const wroteTo = async (
  db: Database,
  userId: string,
  email: string
): Promise<boolean> => {
  const row = await db.query.contacts.findFirst({
    columns: { email: true },
    where: and(
      eq(contacts.userId, userId),
      eq(contacts.email, email.toLowerCase()),
      isNotNull(contacts.writtenAt)
    ),
  });

  return !!row;
};

/** The counts of the given words in the owner's filter; one query, the words as one JSON array. */
const tokenCounts = async (
  db: Database,
  userId: string,
  tokens: string[]
): Promise<Map<string, TokenCounts>> => {
  const rows = await db.all<{ token: string; spam: number; ham: number }>(
    sql`select token, spam, ham from ${spamTokenRows} where user_id = ${userId} and token in (select value from json_each(${JSON.stringify(tokens)}))`
  );

  return new Map(
    rows.map((r) => [r.token, { spam: Number(r.spam), ham: Number(r.ham) }])
  );
};

export const listSenderRules = async (
  db: Database,
  userId: string
): Promise<SenderRule[]> =>
  await db.query.senderRules.findMany({
    where: eq(senderRules.userId, userId),
    orderBy: [asc(senderRules.sender)],
  });

/** The points a message earns: the rules' and the learnt words'. `forged` is a failed DMARC check. */
const scoreMail = async (
  db: Database,
  userId: string,
  p: ParsedMail,
  tokens: Judgement["tokens"],
  context: { forged: boolean; mailDomain: string }
): Promise<Judgement> => {
  const { forged } = context;
  const hits = spamRules(p, { mailDomain: context.mailDomain });
  const ruleScore = hits.reduce((n, h) => n + h.points, 0);
  const counts = await tokenCounts(db, userId, [...tokens, TOTAL_TOKEN]);

  const learnt = learntHit(
    spamProbability(
      tokens,
      counts,
      counts.get(TOTAL_TOKEN) ?? { spam: 0, ham: 0 }
    )
  );

  // A forgery is written to read like the owner's own mail: what the words say counts against it, never for it.
  if (learnt && (learnt.points > 0 || !forged)) {
    hits.push(learnt);
  }

  const score = Math.round(hits.reduce((n, h) => n + h.points, 0) * 10) / 10;
  const isSpam = score >= SPAM_THRESHOLD;

  const reasons = hits
    .filter((h) => h.points > 0)
    .toSorted((a, b) => b.points - a.points)
    .map((h) => h.reason);

  return {
    spam: isSpam,
    check: isSpam
      ? { by: "score", score, rules: hits.map((h) => h.rule), reasons }
      : null,
    // Only what the rules alone call clear spam teaches the filter by itself, or it would teach itself its mistakes.
    learn: ruleScore >= LEARN_SPAM_POINTS ? "spam" : null,
    verdict: "score",
    score,
    rules: hits.map((h) => h.rule),
    tokens,
  };
};

/**
 * Whether a message that arrives is spam. In order: a filter that marks it spam; a sender the owner blocked or
 * allowed (an address before its domain); a filter that never sends it to Spam; someone the owner wrote to; a
 * conversation already in Spam; a conversation the owner took part in; and else the points, the rules' and the
 * learnt words'. Someone the owner knows whose domain failed DMARC is scored like anyone else, and the learnt words
 * cannot take points off such mail: that is a forgery's mark. `thread` is the conversation the message joins.
 */
export const judgeMail = async (
  db: Database,
  user: User,
  p: ParsedMail,
  context: { thread: Thread | null; filter: FilterOutcome; mailDomain: string }
): Promise<Judgement> => {
  const tokens = spamTokens(p);
  const base = { score: null, rules: [], tokens };

  const spam = (
    by: SpamCheck["by"],
    reason: string,
    verdict: Judgement["verdict"]
  ): Judgement => ({
    ...base,
    spam: true,
    check: { by, score: 0, rules: [], reasons: [reason] },
    learn: null,
    verdict,
  });

  const kept = (
    verdict: Judgement["verdict"],
    learn: "ham" | null = "ham"
  ): Judgement => ({
    ...base,
    spam: false,
    check: null,
    learn,
    verdict,
  });

  // A filter is the owner's own word: it decides, and teaches the filter nothing either way.
  if (context.filter.spam) {
    return spam(
      "filter",
      "One of your filters sends mail like this to Spam.",
      "filter"
    );
  }

  const rule = senderRuleFor(await listSenderRules(db, user.id), p.from.email);

  if (rule?.verdict === "block") {
    return spam(
      "blocked",
      `You blocked ${describeSender(rule.sender)}.`,
      "blocked"
    );
  }

  if (rule?.verdict === "allow") {
    return kept("allowed");
  }

  if (context.filter.neverSpam) {
    return kept("never-spam", null);
  }

  const forged = p.signals?.checks?.dmarc === "fail";
  const { thread } = context;

  if (!forged && (await wroteTo(db, user.id, p.from.email))) {
    return kept("known");
  }

  if (thread?.folder === "spam") {
    return spam(
      "conversation",
      "It belongs to a conversation in Spam.",
      "conversation"
    );
  }

  if (!forged && thread && thread.sentCount > 0) {
    return kept("known");
  }

  return await scoreMail(db, user.id, p, tokens, {
    forged,
    mailDomain: context.mailDomain,
  });
};

/* ---------- what the filter learnt ---------- */

/**
 * Add a message's words to the owner's counts (a delta of -1 takes back what it taught before), the message
 * itself to `TOTAL_TOKEN`'s. One statement whatever the number of words: they go in as one JSON array, since D1
 * binds 100 values a query at most.
 */
export const trainTokens = async (
  db: Database,
  userId: string,
  tokens: string[],
  delta: TokenCounts
): Promise<void> => {
  if (!delta.spam && !delta.ham) {
    return;
  }

  const now = new Date().toISOString();
  await db.run(
    sql`insert into ${spamTokenRows} (user_id, token, spam, ham, updated_at)
      select ${userId}, value, ${Math.max(0, delta.spam)}, ${Math.max(0, delta.ham)}, ${now}
      from json_each(${JSON.stringify([...new Set([...tokens, TOTAL_TOKEN])])}) where true
      on conflict (user_id, token) do update set
        spam = max(0, spam + ${delta.spam}), ham = max(0, ham + ${delta.ham}), updated_at = excluded.updated_at`
  );
};

/** A message's words, as the filter counts them, from its row and its files. */
const tokensOf = (
  m: Message,
  files: { filename: string; inline: boolean }[]
): string[] => {
  let replyTo = null;

  try {
    replyTo = m.replyTo ? JSON.parse(m.replyTo) : null;
  } catch {
    // an unreadable Reply-To says nothing
  }

  return spamTokens({
    from: { email: m.fromEmail, name: m.fromName },
    replyTo,
    subject: m.subject,
    text: m.text,
    html: m.html,
    attachments: files,
  });
};

/** How many messages one action teaches the filter at most: the newest of the conversations' mail. */
export const LEARN_BATCH = 50;

/** A message and what it taught the spam filter before a change: what an undo puts back (`restoreLearnt`). */
export type Learnt = [messageId: string, was: "spam" | "ham" | null];

/**
 * Make each message teach the filter what `to` says (spam, kept mail, or nothing), taking back what it taught
 * before. Answers the messages that changed, each with what it taught before.
 */
const relearn = async (
  db: Database,
  userId: string,
  rows: Message[],
  to: (m: Message) => "spam" | "ham" | null
): Promise<Learnt[]> => {
  const changed = rows.filter((m) => to(m) !== m.spamLearned);

  if (!changed.length) {
    return [];
  }

  const files = new Map<string, { filename: string; inline: boolean }[]>();

  for (const f of await db.query.attachments.findMany({
    columns: { messageId: true, filename: true, inline: true },
    where: sql`${attachments.messageId} in (select value from json_each(${JSON.stringify(changed.map((m) => m.id))}))`,
  })) {
    files.set(f.messageId, [...(files.get(f.messageId) ?? []), f]);
  }

  const groups = new Map<"spam" | "ham" | null, string[]>();

  for (const m of changed) {
    const target = to(m);

    const one = (kind: "spam" | "ham") =>
      (target === kind ? 1 : 0) - (m.spamLearned === kind ? 1 : 0);

    // oxlint-disable-next-line eslint/no-await-in-loop -- training and moves run in turn: each writes counts the next one reads
    await trainTokens(db, userId, tokensOf(m, files.get(m.id) ?? []), {
      spam: one("spam"),
      ham: one("ham"),
    });
    groups.set(target, [...(groups.get(target) ?? []), m.id]);
  }

  for (const [target, ids] of groups) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- training and moves run in turn: each writes counts the next one reads
    await db
      .update(messages)
      .set({ spamLearned: target })
      .where(
        sql`${messages.id} in (select value from json_each(${JSON.stringify(ids)}))`
      );
  }

  return changed.map((m) => [m.id, m.spamLearned]);
};

/**
 * Teach the filter that the mail others sent in these conversations is spam ("Report spam") or not ("Not spam").
 * A message it learnt the other way before is taken back first; one it learnt this way already is left alone.
 * Answers each message it changed with what that message taught before.
 */
export const learnThreads = async (
  db: Database,
  userId: string,
  threadIds: string[],
  as: "spam" | "ham"
): Promise<Learnt[]> => {
  if (!threadIds.length) {
    return [];
  }

  const rows = await db.query.messages.findMany({
    where: and(
      eq(messages.userId, userId),
      eq(messages.direction, "inbound"),
      sql`${messages.threadId} in (select value from json_each(${JSON.stringify(threadIds)}))`,
      or(isNull(messages.spamLearned), ne(messages.spamLearned, as))
    ),
    orderBy: [desc(messages.date)],
    limit: LEARN_BATCH,
  });

  return relearn(db, userId, rows, () => as);
};

/** Put back what messages taught the filter before a change: one it had not learnt is unlearnt. */
export const restoreLearnt = async (
  db: Database,
  userId: string,
  learnt: Learnt[]
): Promise<void> => {
  if (!learnt.length) {
    return;
  }

  const was = new Map(learnt);

  const rows = await db.query.messages.findMany({
    where: and(
      eq(messages.userId, userId),
      sql`${messages.id} in (select value from json_each(${JSON.stringify([...was.keys()])}))`
    ),
  });

  await relearn(db, userId, rows, (m) => was.get(m.id) ?? null);
};

/** How many messages the owner's filter learnt as spam and as kept mail. */
export const learntTotals = async (
  db: Database,
  userId: string
): Promise<TokenCounts> => {
  const row = await db.query.spamTokens.findFirst({
    where: and(
      eq(spamTokenRows.userId, userId),
      eq(spamTokenRows.token, TOTAL_TOKEN)
    ),
  });

  return { spam: row?.spam ?? 0, ham: row?.ham ?? 0 };
};

/**
 * Forget the words that say nothing: counted nowhere any more, or once and not seen for 120 days. Run with the
 * trash's pruning, every few hours per person.
 */
export const pruneSpamTokens = async (
  db: Database,
  userId: string
): Promise<void> => {
  const cutoff = new Date(Date.now() - 120 * 86_400_000).toISOString();
  await db
    .delete(spamTokenRows)
    .where(
      and(
        eq(spamTokenRows.userId, userId),
        ne(spamTokenRows.token, TOTAL_TOKEN),
        or(
          sql`${spamTokenRows.spam} + ${spamTokenRows.ham} <= 0`,
          sql`${spamTokenRows.spam} + ${spamTokenRows.ham} <= 1 and ${spamTokenRows.updatedAt} < ${cutoff}`
        )
      )
    );
};

/* ---------- blocked and allowed senders ---------- */

export const MAX_SENDER_RULES = 500;

/** Block or allow a sender (an address or a domain, as typed); a sender blocked before and now allowed switches. */
export const setSenderRule = async (
  db: Database,
  userId: string,
  input: string,
  verdict: "block" | "allow"
): Promise<string> => {
  const sender = senderRuleOf(input);

  if (!sender) {
    throw new SpamError(
      "Give an address (jane@acme.com) or a domain (acme.com)."
    );
  }

  const existing = await db.query.senderRules.findFirst({
    where: and(eq(senderRules.userId, userId), eq(senderRules.sender, sender)),
  });

  if (!existing) {
    const [row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(senderRules)
      .where(eq(senderRules.userId, userId));

    if (Number(row?.n ?? 0) >= MAX_SENDER_RULES) {
      throw new SpamError(
        `You can block or allow ${MAX_SENDER_RULES} senders at most.`
      );
    }
  }

  await db
    .insert(senderRules)
    .values({ userId, sender, verdict })
    .onConflictDoUpdate({
      target: [senderRules.userId, senderRules.sender],
      set: { verdict },
    });

  return sender;
};

export const removeSenderRule = async (
  db: Database,
  userId: string,
  sender: string
) => {
  await db
    .delete(senderRules)
    .where(
      and(
        eq(senderRules.userId, userId),
        eq(senderRules.sender, sender.toLowerCase())
      )
    );
};
