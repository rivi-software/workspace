import { describe, expect, it } from "vitest";

import {
  canonicalAddress,
  formatAddress,
  isValidEmail,
  parseAddress,
  parseAddressList,
} from "~/lib/mail/addresses";

describe("addresses", () => {
  it("parses a name with an address, an address alone, and lower-cases the address", () => {
    expect(parseAddress('"Jane Doe" <Jane@Acme.com>')).toStrictEqual({
      email: "jane@acme.com",
      name: "Jane Doe",
    });
    expect(parseAddress("Jane Doe <jane@acme.com>")).toStrictEqual({
      email: "jane@acme.com",
      name: "Jane Doe",
    });
    expect(parseAddress(" JANE@acme.com ")).toStrictEqual({
      email: "jane@acme.com",
      name: null,
    });
  });

  it("splits a typed list on commas, semicolons and newlines, keeps quoted commas, drops duplicates and reports the rest", () => {
    const { addresses, invalid } = parseAddressList(
      '"Doe, Jane" <jane@acme.com>; bob@globex.io\nbob@globex.io, not-an-address, <pat@initech.net>'
    );

    expect(addresses).toStrictEqual([
      { email: "jane@acme.com", name: "Doe, Jane" },
      { email: "bob@globex.io", name: null },
      { email: "pat@initech.net", name: null },
    ]);
    expect(invalid).toStrictEqual(["not-an-address"]);
  });

  it("reads a typed list in linear time and refuses an address longer than SMTP carries", () => {
    // A name of spaces with no address after it, and a domain of dots that fails at its end: each took seconds,
    // in the parser and in the address check (CORE-1294).
    const name = `a${" ".repeat(30_000)}x`;
    const domain = `a@${".".repeat(30_000)}@`;
    const started = performance.now();

    const { addresses, invalid } = parseAddressList(
      `${name}; ${domain}; Jane <jane@acme.com>`
    );

    expect({
      value: performance.now() - started < 1000,
      addresses,
      invalid,
    }).toStrictEqual({
      value: true,
      addresses: [{ email: "jane@acme.com", name: "Jane" }],
      invalid: [name, domain],
    });

    const longest = `${"a".repeat(64)}@${"b".repeat(186)}.cc`;
    expect({
      longest: longest.length,
      isValidEmail: isValidEmail(longest),
      isValidEmail2: isValidEmail(`a${longest}`),
    }).toStrictEqual({
      longest: 254,
      isValidEmail: true,
      isValidEmail2: false,
    });
  });

  it("formats a name with the quotes it needs", () => {
    expect(formatAddress({ email: "jane@acme.com", name: "Jane Doe" })).toBe(
      "Jane Doe <jane@acme.com>"
    );
    expect(formatAddress({ email: "jane@acme.com", name: "Doe, Jane" })).toBe(
      '"Doe, Jane" <jane@acme.com>'
    );
    expect(formatAddress({ email: "jane@acme.com", name: null })).toBe(
      "jane@acme.com"
    );
  });

  it("delivers a plus-tagged address to the mailbox before the plus", () => {
    expect(canonicalAddress("Rik+newsletters@RIVI.software")).toBe(
      "rik@rivi.software"
    );
    expect(canonicalAddress("rik@rivi.software")).toBe("rik@rivi.software");
  });
});
