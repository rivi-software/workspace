import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { contacts, messages, threads } from "~/db/schema";
import type { User } from "~/db/schema";
import { saveFilter } from "~/lib/mail/filters.server";
import {
  handleInboundEmail,
  ingestInboundEmail,
} from "~/lib/mail/ingest.server";
import { loadThread } from "~/lib/mail/mailbox.server";
import { saveVacation } from "~/lib/mail/preferences.server";
import { sendMail } from "~/lib/mail/send.server";
import {
  MIN_LEARNT,
  SPAM_THRESHOLD,
  baseDomain,
  deceptiveLinks,
  learntHit,
  parseAuthenticationResults,
  receivedChecks,
  senderRuleFor,
  senderRuleOf,
  spamProbability,
  spamRules,
  spamTokens,
} from "~/lib/mail/spam";
import type {
  ReceivedChecks,
  SpamInput,
  SpamSignals,
  TokenCounts,
} from "~/lib/mail/spam";
import {
  SpamError,
  learntTotals,
  pruneSpamTokens,
  removeSenderRule,
  setSenderRule,
  trainTokens,
} from "~/lib/mail/spam.server";
import {
  applyThreadAction,
  blockConversation,
  undoThreadAction,
} from "~/lib/mail/threads.server";

import {
  db,
  defined,
  forwardable,
  mail,
  mailbox,
  rawMail,
  recordingEmail,
  rejection,
} from "./fixtures";

const domain = env.MAIL_DOMAIN;

const CLEAN: ReceivedChecks = {
  score: 0,
  spf: "pass",
  dkim: "pass",
  dkimDomains: ["acme.com"],
  dmarc: "pass",
};

const signals = (
  checks: Partial<ReceivedChecks> | null,
  more: Partial<SpamSignals> = {}
) =>
  ({
    checks: checks ? { ...CLEAN, ...checks } : null,
    noDate: false,
    noMessageId: false,
    bulk: false,
    ...more,
  }) satisfies SpamSignals;

const badSignals = () => signals({ score: 5, dmarc: "fail" });

const fileNamed = (filename: string, inline = false) => ({ filename, inline });

const trainingTokens = (text: string, from: string) =>
  spamTokens({
    from: { email: from, name: null },
    replyTo: null,
    subject: "",
    text,
    html: null,
    attachments: [],
  });

const input = (over: Partial<SpamInput> = {}): SpamInput => ({
  from: { email: "jane@acme.com", name: "Jane Doe" },
  replyTo: null,
  to: [{ email: `rik@${domain}`, name: null }],
  cc: [],
  subject: "Lunch on Friday?",
  text: "Are you free?",
  html: null,
  date: new Date().toISOString(),
  attachments: [],
  signals: signals({}),
  ...over,
});

const rules = (over: Partial<SpamInput> = {}) =>
  spamRules(input(over), { mailDomain: domain }).map((h) => h.rule);

describe("what Cloudflare's MX found", () => {
  it("reads an Authentication-Results header, comments and the HELO check aside", () => {
    const r = parseAuthenticationResults(
      "mx.cloudflare.net; dkim=pass (2048-bit key) header.d=acme.com header.s=s1 header.b=abc; dmarc=pass header.from=acme.com policy.dmarc=none; spf=none (mx.cloudflare.net: no SPF for helo) smtp.helo=mail.acme.com; spf=pass (mx.cloudflare.net: domain of jane@acme.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=jane@acme.com; arc=none smtp.remote-ip=1.2.3.4"
    );

    expect(r.authservId).toBe("mx.cloudflare.net");
    expect(r.results.map((x) => `${x.method}=${x.result}`)).toStrictEqual([
      "dkim=pass",
      "dmarc=pass",
      "spf=none",
      "spf=pass",
      "arc=none",
    ]);

    const checks = receivedChecks([
      { key: "x-cf-spamh-score", value: "2" },
      {
        key: "authentication-results",
        value:
          "mx.cloudflare.net; dkim=fail header.d=x.io; dkim=pass header.d=Acme.com; dmarc=fail header.from=acme.com; spf=none smtp.helo=a.b; spf=softfail smtp.mailfrom=jane@acme.com",
      },
      {
        key: "received",
        value: "from mail.acme.com by mx.cloudflare.net with ESMTPS",
      },
      { key: "from", value: "jane@acme.com" },
    ]);

    expect(checks).toStrictEqual({
      score: 2,
      spf: "softfail",
      dkim: "pass",
      dkimDomains: ["acme.com"],
      dmarc: "fail",
    });
  });

  it("trusts only the receiving block: never a header another server or the sender wrote", () => {
    // A forged verdict below the sender's own server's Received line.
    expect(
      receivedChecks([
        { key: "received", value: "from bot by mail.spam.io; Mon, 1 Jan 2026" },
        {
          key: "authentication-results",
          value: "mx.cloudflare.net; dmarc=pass",
        },
        { key: "x-cf-spamh-score", value: "0" },
      ])
    ).toBeNull();
    // Cloudflare's own comes first; the forged one under it is ignored.
    expect(
      receivedChecks([
        {
          key: "authentication-results",
          value: "mx.cloudflare.net; dmarc=fail spf=fail",
        },
        { key: "received", value: "from bot by mx.cloudflare.net" },
        {
          key: "authentication-results",
          value: "mx.cloudflare.net; dmarc=pass",
        },
      ])?.dmarc
    ).toBe("fail");
    // Another server's verdicts say nothing about this hop.
    expect(
      receivedChecks([
        { key: "authentication-results", value: "mx.google.com; dmarc=fail" },
      ])
    ).toBeNull();
    expect(
      receivedChecks([{ key: "x-cf-spamh-score", value: "9" }])?.score
    ).toBe(5);
  });
});

describe("the rules", () => {
  it("leave ordinary mail alone", () => {
    expect(spamRules(input(), { mailDomain: domain })).toStrictEqual([]);
    expect(
      spamRules(input({ signals: null }), { mailDomain: domain })
    ).toStrictEqual([]);
  });

  it("score Cloudflare's rating and failed checks, and our own domain claimed from outside hardest", () => {
    const hits = spamRules(
      input({ signals: signals({ score: 4, dmarc: "fail" }) }),
      {
        mailDomain: domain,
      }
    );

    expect(hits.map((h) => [h.rule, h.points])).toStrictEqual([
      ["cloudflare-score", 3.6],
      ["dmarc-fail", 3],
    ]);

    const spoof = spamRules(
      input({
        from: { email: `ceo@${domain}`, name: "The CEO" },
        signals: signals({ dmarc: "fail", dkim: "none", spf: "fail" }),
      }),
      { mailDomain: domain }
    );

    expect(spoof.map((h) => h.rule)).toStrictEqual(["own-domain", "spf-fail"]);
    expect(spoof.reduce((n, h) => n + h.points, 0)).toBeGreaterThanOrEqual(
      SPAM_THRESHOLD
    );
    expect(spoof[0].reason).toBe(
      `It claims to come from ${domain} but was sent from elsewhere.`
    );
  });

  it("catch programs, macros and web pages among the files, never an inline image", () => {
    expect(
      rules({ attachments: [fileNamed("invoice.pdf.exe")] })
    ).toStrictEqual(["program"]);
    expect(rules({ attachments: [fileNamed("Budget.XLSM")] })).toStrictEqual([
      "macro",
    ]);
    expect(rules({ attachments: [fileNamed("statement.html")] })).toStrictEqual(
      ["page-file"]
    );
    expect(
      rules({
        attachments: [fileNamed("logo.svg", true), fileNamed("report.pdf")],
      })
    ).toStrictEqual([]);
  });

  it("catch a link that shows one site and goes to another, softer in list mail", () => {
    const html = `<p>Sign in at <a href="https://login.evil.io/x">https://www.paypal.com/signin</a></p>`;
    expect(deceptiveLinks(html)).toStrictEqual([
      { shown: "www.paypal.com", goes: "login.evil.io" },
    ]);
    // The same site, a tracker's subdomain, or a link that shows words: nothing.
    expect(
      deceptiveLinks(
        `<a href="https://click.acme.com/r/1">www.acme.com</a><a href="https://evil.io">Read more</a><a href="https://x.co.uk/a">https://shop.x.co.uk</a>`
      )
    ).toStrictEqual([]);

    const hit = (bulk: boolean) =>
      spamRules(input({ html, signals: signals({}, { bulk }) }), {
        mailDomain: domain,
      }).find((h) => h.rule === "deceptive-link")?.points;

    expect(hit(false)).toBe(2.5);
    expect(hit(true)).toBe(1);
    expect(
      rules({ text: "Go to http://192.168.10.4/login now" })
    ).toStrictEqual(["ip-link"]);
  });

  it("catch a name that shows another address, a reply to a free mailbox, a shouted subject", () => {
    expect({
      rules: rules({
        from: { email: "x@evil.io", name: "support@paypal.com" },
      }),
      rules2: rules({
        from: { email: "jane@acme.com", name: "jane@acme.com" },
      }),
      rules3: rules({
        replyTo: { email: "agent.claims@gmail.com", name: null },
      }),
      rules4: rules({
        replyTo: { email: "help@support.acme.com", name: null },
      }),
      rules5: rules({ subject: "YOU HAVE WON A PRIZE TODAY" }),
      rules6: rules({ subject: "OK, ASAP" }),
      rules7: rules({
        signals: signals({}, { noDate: true, noMessageId: true }),
        to: [],
      }),
    }).toStrictEqual({
      rules: ["name-address"],
      rules2: [],
      rules3: ["reply-elsewhere"],
      rules4: [],
      rules5: ["shouting"],
      rules6: [],
      rules7: ["no-message-id", "no-date", "no-recipient"],
    });
  });

  it("name a host by what its owner registered", () => {
    expect(baseDomain("click.mail.acme.com")).toBe("acme.com");
    expect(baseDomain("shop.acme.co.uk")).toBe("acme.co.uk");
    expect(baseDomain("mail.abc.io")).toBe("abc.io");
  });
});

describe("the learnt words", () => {
  const spammy = "cheap pills discount pharmacy viagra order now limited offer";

  const hammy =
    "budget meeting agenda thursday minutes quarterly planning review";

  const counts = new Map<string, TokenCounts>();

  const learn = (text: string, kind: "spam" | "ham") => {
    for (const t of spamTokens({
      from: {
        email: kind === "spam" ? "deals@pills.biz" : "jane@acme.com",
        name: null,
      },
      replyTo: null,
      subject: "",
      text,
      html: null,
      attachments: [],
    })) {
      const c = counts.get(t) ?? { spam: 0, ham: 0 };
      c[kind] += 1;
      counts.set(t, c);
    }
  };

  for (let i = 0; i < MIN_LEARNT; i += 1) {
    learn(spammy, "spam");
    learn(hammy, "ham");
  }

  const totals = { spam: MIN_LEARNT, ham: MIN_LEARNT };

  const p = (text: string, from = "someone@new.io") =>
    spamProbability(
      spamTokens({
        from: { email: from, name: null },
        replyTo: null,
        subject: "",
        text,
        html: null,
        attachments: [],
      }),
      counts,
      totals
    );

  it("keep a word once per message, the sender's and the subject's apart", () => {
    expect(
      spamTokens({
        from: { email: "jane@acme.com", name: null },
        replyTo: { email: "x@gmail.com", name: null },
        subject: "Offer offer",
        text: "Hello hello 2026 a b, see https://www.shop.acme.co.uk/x",
        html: null,
        attachments: [{ filename: "a.PDF", inline: false }],
      })
    ).toStrictEqual([
      "from:jane@acme.com",
      "from@acme.com",
      "reply@gmail.com",
      "subject:offer",
      "file:pdf",
      "url:acme.co.uk",
      "hello",
      "see",
      "https",
      "www",
      "shop",
      "acme",
    ]);
  });

  it("say nothing before they learnt enough, then tell spam from kept mail", () => {
    expect(
      spamProbability(["x"], counts, { spam: MIN_LEARNT - 1, ham: 50 })
    ).toBeNull();
    expect(p(`${spammy} today`)).toBeGreaterThan(0.98);
    expect(p(`${hammy} today`)).toBeLessThan(0.02);
    expect({
      "nothing anyone said before": p("nothing anyone said before"),
      points: learntHit(0.99)?.points,
      points2: learntHit(0.01)?.points,
      learntHit: learntHit(0.5),
    }).toStrictEqual({
      "nothing anyone said before": 0.5,
      points: 5,
      points2: -4,
      learntHit: null,
    });
  });
});

describe("blocked and allowed senders", () => {
  it("read an address or a domain as typed, and let an address decide before its domain", () => {
    expect({
      " Jane <Jane@Acme.com> ": senderRuleOf(" Jane <Jane@Acme.com> "),
      "@acme.com": senderRuleOf("@acme.com"),
      "Acme.com": senderRuleOf("Acme.com"),
      "not an address": senderRuleOf("not an address"),
    }).toStrictEqual({
      " Jane <Jane@Acme.com> ": "jane@acme.com",
      "@acme.com": "@acme.com",
      "Acme.com": "@acme.com",
      "not an address": null,
    });

    const list = [
      { sender: "@acme.com", verdict: "block" },
      { sender: "@mail.acme.com", verdict: "allow" },
      { sender: "ok@acme.com", verdict: "allow" },
    ];

    expect({
      sender: senderRuleFor(list, "ok@acme.com")?.sender,
      sender2: senderRuleFor(list, "x@mail.acme.com")?.sender,
      sender3: senderRuleFor(list, "x@eu.acme.com")?.sender,
      senderRuleFor: senderRuleFor(list, "x@notacme.com"),
    }).toStrictEqual({
      sender: "ok@acme.com",
      sender2: "@mail.acme.com",
      sender3: "@acme.com",
      senderRuleFor: null,
    });
  });

  it("read a sender in linear time, an address in angles with text around it too", () => {
    // A run of `<` that no `>` closes: the unanchored `/<([^>]+)>/` took 2.4 s on 40,000 of them (#2730).
    const started = performance.now();
    expect(senderRuleOf("<".repeat(40_000))).toBeNull();
    expect(performance.now() - started).toBeLessThan(100);
    expect(senderRuleOf("Jane <jane@acme.com> extra")).toBe("jane@acme.com");
    expect(senderRuleOf("<> Jane <jane@acme.com>")).toBe("jane@acme.com");
    expect(senderRuleOf("Jane <jane@acme.com")).toBeNull();
  });
});

describe("the spam filter on delivery", () => {
  let user: User;
  beforeAll(async () => {
    user = await mailbox("sam", "Sam Spamless");
  });

  const deliver = async (over: Parameters<typeof mail>[0] = {}) => {
    const r = await ingestInboundEmail(
      env,
      null,
      mail({ to: [{ email: user.email, name: null }], ...over }),
      user.email
    );

    if (r.status !== "stored") {
      throw new Error(r.status);
    }

    const thread = defined(
      await db.query.threads.findFirst({
        where: eq(threads.id, r.threadId),
      })
    );

    const message = defined(
      await db.query.messages.findFirst({
        where: eq(messages.id, r.messageId),
      })
    );

    return { ...r, thread, message };
  };

  it("files spam in Spam with its reasons, and keeps its sender out of the contacts", async () => {
    const r = await deliver({
      from: { email: "winner@lottery.biz", name: null },
      subject: "Claim your prize",
      signals: badSignals(),
    });

    expect({ judgement: r.judgement, thread: r.thread }).toMatchObject({
      judgement: {
        spam: true,
        verdict: "score",
        score: 7.5,
      },
      thread: { folder: "spam" },
    });
    expect({
      trashedAt: Boolean(r.thread.trashedAt),
      parse: JSON.parse(defined(r.message.spamJson)),
    }).toStrictEqual({
      trashedAt: true,
      parse: {
        by: "score",
        score: 7.5,
        rules: ["cloudflare-score", "dmarc-fail"],
        reasons: [
          "Cloudflare's spam check rated it 5 out of 5.",
          "lottery.biz did not vouch for it: its DMARC check failed.",
        ],
      },
    });
    // 7.5 from the rules is below what teaches the filter on its own.
    expect(r.message.spamLearned).toBeNull();

    const contact = await db.query.contacts.findFirst({
      where: and(
        eq(contacts.userId, user.id),
        eq(contacts.email, "winner@lottery.biz")
      ),
    });

    expect(contact).toBeUndefined();
    const loaded = await loadThread(db, env, user.id, r.threadId);
    expect(loaded?.messages[0].spam?.by).toBe("score");
  });

  it("learns clear spam by itself, and leaves ordinary mail in the inbox", async () => {
    const r = await deliver({
      from: { email: "invoice@billing-dept.ru", name: null },
      signals: badSignals(),
      attachments: [
        {
          filename: "invoice.exe",
          mimeType: "application/octet-stream",
          content: new Uint8Array([77, 90]),
          contentId: null,
          inline: false,
        },
      ],
    });

    const learnt = await learntTotals(db, user.id);

    expect({
      spam: r.judgement.spam,
      spamLearned: r.message.spamLearned,
      spam2: learnt.spam,
    }).toStrictEqual({ spam: true, spamLearned: "spam", spam2: 1 });

    const fine = await deliver({
      from: { email: "pat@initech.net", name: "Pat" },
    });

    expect(fine.judgement).toMatchObject({
      spam: false,
      verdict: "score",
      score: 0,
    });
    expect({
      folder: fine.thread.folder,
      spamJson: fine.message.spamJson,
    }).toStrictEqual({ folder: "inbox", spamJson: null });
  });

  it("never holds back someone the owner wrote to, unless their domain's DMARC failed", async () => {
    const { env: sending } = recordingEmail();
    await sendMail(sending, db, user, {
      from: user.email,
      to: [{ email: "lee@partner.org", name: "Lee" }],
      cc: [],
      bcc: [],
      subject: "Contract",
      text: "Here it is.",
      files: [],
    });

    const contact = await db.query.contacts.findFirst({
      where: and(
        eq(contacts.userId, user.id),
        eq(contacts.email, "lee@partner.org")
      ),
    });

    expect(contact?.writtenAt).toBeTruthy();

    const known = await deliver({
      from: { email: "lee@partner.org", name: "Lee" },
      subject: "Totally different",
      signals: signals({ score: 5 }),
    });

    expect(known.judgement).toMatchObject({ spam: false, verdict: "known" });
    expect(known.message.spamLearned).toBe("ham");

    const forged = await deliver({
      from: { email: "lee@partner.org", name: "Lee" },
      subject: "Urgent wire",
      signals: badSignals(),
    });

    expect(forged.judgement).toMatchObject({ spam: true, verdict: "score" });
  });

  it("blocks and allows senders, an address before its domain, and lets a filter keep mail out of Spam", async () => {
    const observed: unknown[] = [];

    observed.push(
      (await rejection(
        setSenderRule(db, user.id, "nonsense", "block")
      )) instanceof SpamError,
      await setSenderRule(db, user.id, "@pushy.biz", "block")
    );
    await setSenderRule(db, user.id, "Ann <ann@pushy.biz>", "allow");

    const blocked = await deliver({
      from: { email: "bob@eu.pushy.biz", name: null },
    });

    observed.push(blocked.thread.folder);
    expect(JSON.parse(defined(blocked.message.spamJson))).toMatchObject({
      by: "blocked",
      reasons: ["You blocked everyone at pushy.biz."],
    });

    const allowed = await deliver({
      from: { email: "ann@pushy.biz", name: null },
      signals: badSignals(),
    });

    expect(allowed.judgement).toMatchObject({
      spam: false,
      verdict: "allowed",
    });
    await removeSenderRule(db, user.id, "@pushy.biz");

    const { thread } = await deliver({
      from: { email: "bob@pushy.biz", name: null },
    });

    observed.push(thread.folder);

    await saveFilter(db, user.id, {
      conditions: { from: "alerts@monitor.io" },
      actions: { neverSpam: true },
    });

    const alert = await deliver({
      from: { email: "alerts@monitor.io", name: null },
      signals: badSignals(),
    });

    expect(alert.judgement).toMatchObject({
      spam: false,
      verdict: "never-spam",
    });
    observed.push(alert.message.spamLearned);

    expect(observed).toStrictEqual([
      // (await rejection(setSenderRule(db, user.id, "nonsense", "block"))) instanceof SpamError
      true,
      // setSenderRule(db, user.id, "@pushy.biz", "block")
      "@pushy.biz",
      // blocked.thread.folder
      "spam",
      // thread.folder
      "inbox",
      // alert.message.spamLearned
      null,
    ]);
  });

  it("keeps a conversation in Spam when its sender writes again", async () => {
    const first = await deliver({
      from: { email: "seo@ranks.top", name: null },
      subject: "Rank #1 on Google",
    });

    await applyThreadAction(db, env, user.id, [first.threadId], {
      intent: "spam",
    });

    const again = await deliver({
      from: { email: "seo@ranks.top", name: null },
      subject: "Re: Rank #1 on Google",
    });

    expect(again.threadId).toBe(first.threadId);
    expect(again.judgement.verdict).toBe("conversation");
    expect(again.thread.folder).toBe("spam");
  });

  it("learns from Report spam and Not spam, taking back what a message taught before", async () => {
    const observed: unknown[] = [];

    const before = await learntTotals(db, user.id);

    const a = await deliver({
      from: { email: "promo@deals.shop", name: null },
      text: "big sale",
    });

    await applyThreadAction(db, env, user.id, [a.threadId], { intent: "spam" });

    const marked = await db.query.messages.findFirst({
      where: eq(messages.id, a.messageId),
    });

    observed.push({
      spamLearned: marked?.spamLearned,
      learntTotals: await learntTotals(db, user.id),
    });
    // Reporting it again teaches nothing new.
    await applyThreadAction(db, env, user.id, [a.threadId], { intent: "spam" });
    const { spam } = await learntTotals(db, user.id);
    observed.push(spam);

    // Not spam takes it out of Spam and moves what it taught to the other side.
    const { undo } = await applyThreadAction(db, env, user.id, [a.threadId], {
      intent: "inbox",
    });

    observed.push(await learntTotals(db, user.id));

    const words = await db.all<{ spam: number; ham: number }>(
      `select spam, ham from spam_tokens where user_id = '${user.id}' and token = 'from:promo@deals.shop'`
    );

    observed.push(words);
    // Undo puts it back in Spam and takes back what Not spam taught: it is spam as reported, once.
    await undoThreadAction(db, env, user.id, defined(undo));
    observed.push(await learntTotals(db, user.id));

    // The trash teaches nothing.
    const b = await deliver({
      from: { email: "promo@deals.shop", name: null },
    });

    await applyThreadAction(db, env, user.id, [b.threadId], {
      intent: "trash",
    });

    const message = await db.query.messages.findFirst({
      where: eq(messages.id, b.messageId),
    });

    observed.push(message?.spamLearned);

    expect(observed).toStrictEqual([
      // { spamLearned: marked?.spamLearned, learntTotals: await learntTotals(db, user.id), }
      {
        spamLearned: "spam",
        learntTotals: {
          spam: before.spam + 1,
          ham: before.ham,
        },
      },
      // spam
      before.spam + 1,
      // learntTotals(db, user.id)
      {
        spam: before.spam,
        ham: before.ham + 1,
      },
      // words
      [{ spam: 0, ham: 1 }],
      // learntTotals(db, user.id)
      {
        spam: before.spam + 1,
        ham: before.ham,
      },
      // message?.spamLearned
      null,
    ]);
  });

  it("takes back what Not spam taught when it is undone, for mail it never learnt before", async () => {
    const before = await learntTotals(db, user.id);

    const r = await deliver({
      from: { email: "offers@coupons.example", name: null },
      subject: "Coupons inside",
      signals: badSignals(),
    });

    expect({
      folder: r.thread.folder,
      spamLearned: r.message.spamLearned,
    }).toStrictEqual({ folder: "spam", spamLearned: null });

    const { undo } = await applyThreadAction(db, env, user.id, [r.threadId], {
      intent: "inbox",
    });

    await expect(learntTotals(db, user.id)).resolves.toStrictEqual({
      spam: before.spam,
      ham: before.ham + 1,
    });
    await undoThreadAction(db, env, user.id, defined(undo));
    // Back in Spam since it arrived, and nothing learnt: it was never reported.
    await expect(learntTotals(db, user.id)).resolves.toStrictEqual(before);
    const loaded = defined(await loadThread(db, env, user.id, r.threadId));
    expect(loaded.thread).toMatchObject({
      folder: "spam",
      trashedAt: r.thread.trashedAt,
    });

    const message = await db.query.messages.findFirst({
      where: eq(messages.id, r.messageId),
    });

    expect(message?.spamLearned).toBeNull();
  });

  it("learns a blocked sender's conversation as spam when blocking moves it there", async () => {
    const before = await learntTotals(db, user.id);

    const r = await deliver({
      from: { email: "pest@nag.example", name: null },
      subject: "Again",
    });

    const sender = await setSenderRule(
      db,
      user.id,
      "pest@nag.example",
      "block"
    );

    await expect(
      blockConversation(db, user.id, r.threadId, sender)
    ).resolves.toBeTruthy();
    const thread = await loadThread(db, env, user.id, r.threadId);
    expect(thread?.thread.folder).toBe("spam");
    await expect(learntTotals(db, user.id)).resolves.toStrictEqual({
      spam: before.spam + 1,
      ham: before.ham,
    });
  });

  it("sends mail that reads like learnt spam to Spam once it learnt enough", async () => {
    const observed: unknown[] = [];

    const reader = await mailbox("bea", "Bea Bayes");

    // `trainTokens` adds to each word's counts in one statement, so the lessons may arrive in any order.
    await Promise.all(
      Array.from({ length: MIN_LEARNT }, async (_, i) => {
        await trainTokens(
          db,
          reader.id,
          trainingTokens(
            `crypto airdrop wallet bonus claim ${i}x`,
            `drop${i}@coins.xyz`
          ),
          { spam: 1, ham: 0 }
        );
        await trainTokens(
          db,
          reader.id,
          trainingTokens(
            `playlist schedule studio broadcast ${i}y`,
            "jane@acme.com"
          ),
          { spam: 0, ham: 1 }
        );
      })
    );

    observed.push(await learntTotals(db, reader.id));

    const r = await ingestInboundEmail(
      env,
      null,
      mail({
        from: { email: "new@coins.xyz", name: null },
        to: [{ email: reader.email, name: null }],
        text: "Claim your crypto airdrop bonus: connect your wallet",
      }),
      reader.email
    );

    if (r.status !== "stored") {
      throw new Error(r.status);
    }

    expect(r.judgement).toMatchObject({
      spam: true,
      rules: ["learnt"],
      score: 5,
    });

    const kept = await ingestInboundEmail(
      env,
      null,
      mail({
        from: { email: "max@acme.com", name: null },
        to: [{ email: reader.email, name: null }],
        text: "The studio schedule for the broadcast playlist",
      }),
      reader.email
    );

    expect(kept.status === "stored" && kept.judgement).toMatchObject({
      spam: false,
      score: -4,
    });

    // A forgery that reads like the owner's mail gets no points off for it.
    const forged = await ingestInboundEmail(
      env,
      null,
      mail({
        from: { email: `boss@${domain}`, name: "The Boss" },
        to: [{ email: reader.email, name: null }],
        text: "The studio schedule for the broadcast playlist",
        signals: signals({ dmarc: "fail" }),
      }),
      reader.email
    );

    expect(forged.status === "stored" && forged.judgement).toMatchObject({
      spam: true,
      score: 6,
      rules: ["own-domain"],
    });
    // Words seen once and long ago, or counted nowhere any more, are forgotten.
    await db.run(
      `update spam_tokens set updated_at = '2000-01-01T00:00:00.000Z' where user_id = '${reader.id}'`
    );
    await pruneSpamTokens(db, reader.id);
    observed.push(await learntTotals(db, reader.id));

    const left = await db.all<{ n: number }>(
      `select count(*) as n from spam_tokens where user_id = '${reader.id}' and token = 'from:drop1@coins.xyz'`
    );

    observed.push(left);

    expect(observed).toStrictEqual([
      // learntTotals(db, reader.id)
      {
        spam: MIN_LEARNT,
        ham: MIN_LEARNT,
      },
      // learntTotals(db, reader.id)
      {
        spam: MIN_LEARNT,
        ham: MIN_LEARNT,
      },
      // left
      [{ n: 0 }],
    ]);
  });

  it("reads Cloudflare's headers on a raw message, and answers spam with no vacation reply", async () => {
    const vic = await mailbox("vera", "Vera Away");
    await saveVacation(db, vic.id, {
      on: true,
      subject: "",
      text: "Away.",
      from: null,
      until: null,
    });
    const { sent, env: sending } = recordingEmail();

    const raw = rawMail({
      from: `"IT Desk" <it@${domain}>`,
      to: vic.email,
      subject: "Your password expires today",
      received: [
        "X-CF-SpamH-Score: 3",
        `Authentication-Results: mx.cloudflare.net; dkim=none; dmarc=fail header.from=${domain} policy.dmarc=none; spf=fail smtp.mailfrom=it@${domain}`,
        "Received: from bot.example (bot.example [203.0.113.9]) by mx.cloudflare.net with ESMTP",
      ],
    });

    const spam = forwardable(raw, `it@${domain}`, vic.email);
    const result = await handleInboundEmail(spam.message, sending);
    expect(result.status === "stored" && result.judgement).toMatchObject({
      spam: true,
      rules: ["cloudflare-score", "own-domain", "spf-fail"],
    });
    expect(sent).toStrictEqual([]);

    const ok = forwardable(
      rawMail({ to: vic.email, subject: "Hi Vera" }),
      "jane@acme.com",
      vic.email
    );

    await handleInboundEmail(ok.message, sending);
    expect(sent).toHaveLength(1);
  });
});
