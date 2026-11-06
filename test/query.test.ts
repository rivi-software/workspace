import { describe, expect, it } from "vitest";

import { parseQuery, queryDate, queryWords } from "~/lib/mail/query";

describe("the search language", () => {
  it("reads words, phrases and operators, negated with a minus", () => {
    expect(
      parseQuery('budget from:jane -label:done subject:"the plan" is:unread')
    ).toStrictEqual([
      { field: "text", value: "budget", negated: false },
      { field: "from", value: "jane", negated: false },
      { field: "label", value: "done", negated: true },
      { field: "subject", value: "the plan", negated: false },
      { field: "is", value: "unread", negated: false },
    ]);
  });

  it("treats an unknown field as text, so `re:plan` finds what it says", () => {
    expect(parseQuery("re:plan -x")).toStrictEqual([
      { field: "text", value: "re:plan", negated: false },
      { field: "text", value: "x", negated: true },
    ]);
  });

  it("drops an operator with nothing after it and keeps a quoted phrase as one term", () => {
    expect(parseQuery('from: "two words"')).toStrictEqual([
      { field: "text", value: "two words", negated: false },
    ]);
  });

  it("reads a before:/after: date as the start of that day in UTC, or nothing", () => {
    expect(queryDate("2026-10-01")).toBe("2026-10-01T00:00:00.000Z");
    expect(queryDate("2026-1-5")).toBe("2026-01-05T00:00:00.000Z");
    expect(queryDate("yesterday")).toBeNull();
  });

  it("writes the terms back as a query", () => {
    expect(queryWords(parseQuery('budget -from:jane subject:"the plan"'))).toBe(
      'budget -from:jane subject:"the plan"'
    );
  });
});
