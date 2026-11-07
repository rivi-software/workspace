import { describe, expect, it } from "vitest";

import {
  describeFilter,
  filterMatches,
  parseFilterActions,
  parseFilterConditions,
} from "~/lib/mail/filters";
import { parsePreferences } from "~/lib/mail/preferences";
import { snoozePresets } from "~/lib/mail/snooze";
import {
  parseListUnsubscribe,
  mailtoParts,
  parseJsonUnsubscribe,
} from "~/lib/mail/unsubscribe";
import {
  htmlToText,
  MAX_DEPTH,
  MAX_TEXT,
  quoteHtmlForForward,
  quoteHtmlForReply,
  withSignatureHtml,
} from "~/lib/text";

describe("a text reading of HTML", () => {
  it("keeps paragraphs, breaks, lists, quotes and links as a mail client writes them", () => {
    const html = `<div><p>Hi <b>Jane</b>,</p><p>Two things:</p><ul><li>one</li><li>two &amp; <a href="https://x.co/a">the link</a></li></ul>
      <p>See <a href="https://x.co/">https://x.co/</a> too.</p><blockquote>Earlier<br>lines</blockquote></div>`;

    expect(htmlToText(html)).toBe(
      "Hi Jane,\n\nTwo things:\n\n- one\n- two & the link <https://x.co/a>\n\nSee https://x.co/ too.\n\n> Earlier\n> lines"
    );
  });

  it("drops styles and scripts, decodes references and keeps the signature delimiter's space", () => {
    const html = `<style>p{color:red}</style><script>x()</script><p>caf&eacute; &ndash; ok&nbsp;!</p><div class="rivi_signature">-- <br>Sam</div>`;
    expect(htmlToText(html)).toBe("café – ok !\n\n-- \nSam");
  });

  it("drops the doctype, an XML declaration and Outlook's conditional markers", () => {
    const html = `<?xml version="1.0" encoding="utf-8"?>
      <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional //EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
      <html><head><title>News</title></head><body><![if !mso]><p>Hello there</p><![endif]></body></html>`;

    expect(htmlToText(html)).toBe("Hello there");
  });

  it("nests quotes and numbers ordered lists", () => {
    expect(
      htmlToText(
        "<ol><li>a</li><li>b</li></ol><blockquote><blockquote>deep</blockquote></blockquote>"
      )
    ).toBe("1. a\n2. b\n\n> > deep");
  });

  it("reads a quote or list nested past the limit at the limit, and closes it where the markup does", () => {
    const html = `${"<blockquote>".repeat(MAX_DEPTH + 8)}deep${"</blockquote>".repeat(MAX_DEPTH + 8)}<p>after</p>`;
    expect(htmlToText(html)).toBe(`${"> ".repeat(MAX_DEPTH)}deep\n\nafter`);
    expect(htmlToText(`${"<ul>".repeat(MAX_DEPTH + 8)}<li>item</li>`)).toBe(
      `${"  ".repeat(MAX_DEPTH)}- item`
    );
  });

  it("does not blow a compact message of nested quotes up into megabytes of `>` (#2699)", () => {
    // 34 kB of markup: every line two thousand quotes deep, which read 8 million characters before the limits.
    const nested = `${"<blockquote>".repeat(2000)}${"a<br>".repeat(2000)}`;
    const text = htmlToText(nested);
    expect(text.length).toBeLessThan(200_000);
    expect(
      text.split("\n").every((l) => l === `${"> ".repeat(MAX_DEPTH)}a`)
    ).toBeTruthy();
    // Within the depth limit the lines still add up; the reading stops at the budget.
    const long = `${"<blockquote>".repeat(MAX_DEPTH)}${"a<br>".repeat(100_000)}`;
    const read = htmlToText(long);
    expect(read.length).toBeLessThanOrEqual(MAX_TEXT);
    expect(read.length).toBeGreaterThan(MAX_TEXT - 100);
  });
});

describe("the rich composer's quoting", () => {
  it("quotes the original's markup under an attribution, styles dropped, or its text as paragraphs", () => {
    const base = {
      date: "2026-10-20T10:00:00.000Z",
      from: { email: "jane@acme.com", name: "Jane" },
      to: [{ email: "rik@rivi.software", name: null }],
      cc: [],
      subject: "Plan",
      text: "Line one\n\nLine two",
    };

    const fromHtml = quoteHtmlForReply({
      ...base,
      html: "<style>p{}</style><p>Hello</p>",
    });

    expect({
      fromHtml: fromHtml.includes('class="gmail_quote"'),
      fromHtml2: fromHtml.includes(
        'Jane &lt;<a href="mailto:jane@acme.com">jane@acme.com</a>&gt; wrote:'
      ),
      fromHtml3: fromHtml.includes("<blockquote"),
      fromHtml4: fromHtml.includes("<p>Hello</p>"),
    }).toStrictEqual({
      fromHtml: true,
      fromHtml2: true,
      fromHtml3: true,
      fromHtml4: true,
    });
    expect(fromHtml).not.toContain("<style>");
    const fromText = quoteHtmlForReply(base);
    expect(fromText).toContain('<p style="margin:0 0 16px">Line one</p>');
    const forward = quoteHtmlForForward(base);
    expect({
      forward: forward.includes("---------- Forwarded message ---------"),
      forward2: forward.includes("Subject: Plan"),
    }).toStrictEqual({ forward: true, forward2: true });
  });

  it("puts the signature above the quote, after the delimiter", () => {
    const signed = withSignatureHtml(
      '<div>Thanks</div><div class="gmail_quote">old</div>',
      {
        text: "Sam\nRIVI",
        html: null,
      }
    );

    expect(signed).toBe(
      '<div>Thanks</div><br><div class="rivi_signature">-- <br>Sam<br>RIVI</div><br><div class="gmail_quote">old</div>'
    );
    expect(
      withSignatureHtml("<div>Hi</div>", { text: "Sam", html: null })
    ).toBe('<div>Hi</div><br><div class="rivi_signature">-- <br>Sam</div>');
  });

  it("puts an HTML signature's own markup in, not its text", () => {
    expect(
      withSignatureHtml("<div>Hi</div>", {
        text: "Sam",
        html: "<b>Sam</b> · <i>RIVI</i>",
      })
    ).toBe(
      '<div>Hi</div><br><div class="rivi_signature">-- <br><b>Sam</b> · <i>RIVI</i></div>'
    );
  });
});

describe("List-Unsubscribe", () => {
  it("reads the web link and the mail address, and whether one click does it", () => {
    expect(
      parseListUnsubscribe(
        "<mailto:leave@list.example?subject=unsub>, <https://list.example/u?id=1>",
        "List-Unsubscribe=One-Click"
      )
    ).toStrictEqual({
      http: "https://list.example/u?id=1",
      mailto: "mailto:leave@list.example?subject=unsub",
      oneClick: true,
    });
    expect(parseListUnsubscribe("<https://a.example/x>", null)).toStrictEqual({
      http: "https://a.example/x",
      mailto: null,
      oneClick: false,
    });
    expect(parseListUnsubscribe("nothing here", null)).toBeNull();
    expect(parseListUnsubscribe(null, "List-Unsubscribe=One-Click")).toBeNull();
  });

  it("reads a mailto's address and subject, and what was kept as JSON", () => {
    expect(
      mailtoParts("mailto:leave@list.example?subject=Please%20stop&body=bye")
    ).toStrictEqual({
      to: "leave@list.example",
      subject: "Please stop",
      body: "bye",
    });
    expect(mailtoParts("mailto:nobody")).toBeNull();
    expect(
      parseJsonUnsubscribe('{"http":"javascript:alert(1)","mailto":null}')
    ).toBeNull();
    expect(
      parseJsonUnsubscribe('{"http":"https://a.example","oneClick":true}')
    ).toStrictEqual({
      http: "https://a.example",
      mailto: null,
      oneClick: true,
    });
  });
});

describe("filters", () => {
  const message = {
    from: { email: "billing@acme.com", name: "Acme Billing" },
    to: [{ email: "rik@rivi.software", name: null }],
    cc: [{ email: "team@rivi.software", name: "Team" }],
    subject: "Invoice 42",
    text: "Your invoice is attached. Pay by Friday.",
    hasAttachment: true,
  };

  it("matches on sender, recipient, subject, words and attachments, all together", () => {
    expect({
      filterMatches: filterMatches({ from: "acme.com" }, message),
      filterMatches2: filterMatches({ from: "initech, acme" }, message),
      filterMatches3: filterMatches({ from: "initech" }, message),
      filterMatches4: filterMatches({ to: "team@" }, message),
      filterMatches5: filterMatches({ subject: "invoice" }, message),
      filterMatches6: filterMatches({ words: "pay friday" }, message),
      filterMatches7: filterMatches({ words: "pay monday" }, message),
      filterMatches8: filterMatches({ hasAttachment: true }, message),
      filterMatches9: filterMatches(
        { from: "acme", subject: "receipt" },
        message
      ),
      filterMatches10: filterMatches({}, message),
    }).toStrictEqual({
      filterMatches: true,
      filterMatches2: true,
      filterMatches3: false,
      filterMatches4: true,
      filterMatches5: true,
      filterMatches6: true,
      filterMatches7: false,
      filterMatches8: true,
      filterMatches9: false,
      filterMatches10: false,
    });
  });

  it("reads what was stored and describes a rule", () => {
    const c = parseFilterConditions(
      '{"from":" acme.com ","hasAttachment":true,"to":""}'
    );

    const a = parseFilterActions(
      '{"skipInbox":true,"labelId":"lb_1","spam":"yes"}'
    );

    expect(c).toStrictEqual({ from: "acme.com", hasAttachment: true });
    expect(a).toStrictEqual({ skipInbox: true, labelId: "lb_1" });
    expect(
      describeFilter(c, a, (id) => (id === "lb_1" ? "Finance" : null))
    ).toStrictEqual({
      when: "from acme.com · has an attachment",
      does: "skip the inbox, label Finance",
    });
    expect(parseFilterConditions("not json")).toStrictEqual({});
  });
});

describe("mail preferences", () => {
  it("fills the defaults in and refuses values off the lists", () => {
    expect(parsePreferences(null)).toStrictEqual({
      layout: "split",
      undoSendSeconds: 5,
      pageSize: 50,
      pgpSign: false,
    });
    expect(
      parsePreferences(
        '{"layout":"full","undoSendSeconds":20,"pageSize":25,"pgpSign":true}'
      )
    ).toStrictEqual({
      layout: "full",
      undoSendSeconds: 20,
      pageSize: 25,
      pgpSign: true,
    });
    expect(
      parsePreferences(
        '{"layout":"wide","undoSendSeconds":7,"pageSize":999,"pgpSign":"yes"}'
      )
    ).toStrictEqual({
      layout: "split",
      undoSendSeconds: 5,
      pageSize: 50,
      pgpSign: false,
    });
  });
});

describe("snooze presets", () => {
  it("offers later today, tomorrow morning, the weekend and next week", () => {
    // a Wednesday, local time
    const wednesday = new Date(2026, 9, 21, 10, 0, 0);
    const presets = snoozePresets(wednesday);
    expect({
      presetsMap: presets.map((p) => p.key),
      getHours: presets[0].at.getHours(),
      getDate: presets[1].at.getDate(),
      getHours2: presets[1].at.getHours(),
      getDay: presets[2].at.getDay(),
      getDay2: presets[3].at.getDay(),
      getTime: presets[3].at.getTime() > presets[2].at.getTime(),
    }).toStrictEqual({
      presetsMap: ["later", "tomorrow", "weekend", "week"],
      getHours: 18,
      getDate: 22,
      getHours2: 8,
      getDay: 6,
      getDay2: 1,
      getTime: true,
    });
    const lateSaturday = new Date(2026, 9, 24, 20, 0, 0);
    const late = snoozePresets(lateSaturday);
    expect({
      lateMap: late.map((p) => p.key),
      getHours: late[0].at.getHours(),
      getDate: late[2].at.getDate(),
    }).toStrictEqual({
      lateMap: ["later", "tomorrow", "weekend", "week"],
      getHours: 23,
      getDate: 31,
    });
  });
});
