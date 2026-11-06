import { describe, expect, it } from "vitest";

import {
  normalizeMessageId,
  normalizeSubject,
  quoteForReply,
  replyRecipients,
  replySubject,
  splitReferences,
} from "~/lib/mail/threading";

describe("threading", () => {
  it("normalises ids and references", () => {
    expect(normalizeMessageId("abc@x")).toBe("<abc@x>");
    expect(normalizeMessageId(" <abc@x> ")).toBe("<abc@x>");
    expect(normalizeMessageId("")).toBeNull();
    expect(splitReferences("<a@x>  b@y\n<c@z>")).toStrictEqual([
      "<a@x>",
      "<b@y>",
      "<c@z>",
    ]);
  });

  it("strips reply and forward prefixes in several languages", () => {
    expect(normalizeSubject("Re: RE: Fwd: AW: Doorst: Hello  world")).toBe(
      "hello world"
    );
    expect(normalizeSubject("Re[2]: Hello")).toBe("hello");
    expect(replySubject("Hello")).toBe("Re: Hello");
    expect(replySubject("RE: Hello")).toBe("RE: Hello");
  });

  it("quotes the original with an attribution line", () => {
    const quoted = quoteForReply({
      date: "2026-10-24T10:00:00.000Z",
      from: { email: "jane@acme.com", name: "Jane" },
      to: [],
      cc: [],
      subject: "Hi",
      text: "First line\n> already quoted",
    });

    expect(quoted.split("\n")[0]).toMatch(
      /^On .*Jane <jane@acme.com> wrote:$/u
    );
    expect(quoted).toContain("\n> First line\n>> already quoted");
  });

  it("picks the reply recipients and leaves the owner's own addresses out", () => {
    const own = new Set(["rik@rivi.software", "hello@rivi.software"]);

    const message = {
      from: { email: "jane@acme.com", name: "Jane" },
      replyTo: null,
      to: [
        { email: "hello@rivi.software", name: null },
        { email: "bob@globex.io", name: null },
      ],
      cc: [{ email: "pat@initech.net", name: null }],
    };

    expect(replyRecipients(message, own, false)).toStrictEqual({
      to: [message.from],
      cc: [],
    });
    expect(replyRecipients(message, own, true)).toStrictEqual({
      to: [message.from, { email: "bob@globex.io", name: null }],
      cc: [{ email: "pat@initech.net", name: null }],
    });

    // Reply-To wins over From; a reply to the owner's own mail goes to its recipients.
    const withReplyTo = {
      ...message,
      replyTo: { email: "list@acme.com", name: null },
    };

    expect(replyRecipients(withReplyTo, own, false).to).toStrictEqual([
      { email: "list@acme.com", name: null },
    ]);

    const mine = {
      ...message,
      from: { email: "rik@rivi.software", name: "Rik" },
    };

    expect(replyRecipients(mine, own, false).to).toStrictEqual([
      { email: "bob@globex.io", name: null },
    ]);
  });
});
