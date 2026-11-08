import { describe, expect, it } from "vitest";

import {
  INPUT_LIMIT,
  REDACTED,
  TEXT_LIMIT,
  bounded,
  chatInput,
  chatOutput,
  maskCredentials,
} from "~/lib/ai-telemetry/text";

import { stringMatching } from "./fixtures";

// Fake credentials, put together here so no scanner reads a whole key in the source.
const ANTHROPIC_KEY = [
  "sk",
  "ant",
  "api03",
  "abcdefghijklmnopqrstuvwxyz0123",
].join("-");

const STRIPE_KEY = ["rk", "live", "51AbCdEfGhIjKlMnOpQrStUv"].join("_");
const GITHUB_TOKEN = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");

const JWT = [
  "eyJhbGciOiJIUzI1NiJ9",
  "eyJzdWIiOiIxMjM0NTYifQ",
  "c2lnbmF0dXJl",
].join(".");

describe(maskCredentials, () => {
  it.each([
    ["an Anthropic key", `key ${ANTHROPIC_KEY} here`, "key [redacted] here"],
    ["a Stripe key", STRIPE_KEY, REDACTED],
    ["a GitHub token", GITHUB_TOKEN, REDACTED],
    ["a PostHog key", "phx_abcdefghijklmnopqrstuvwxyz", REDACTED],
    ["a Supsys API token", "sup_abcdefghijklmnopqrstuvwx", REDACTED],
    ["a Workspace access token", "wsa_abcdefghijklmnopqrstuvwx", REDACTED],
    ["a JWT", JWT, REDACTED],
    [
      "a bearer token",
      "Authorization: Bearer abcdefgh12345678",
      "Authorization: Bearer [redacted]",
    ],
    ["a password", "password: hunter2!x", "password: [redacted]"],
    [
      "an API key in JSON",
      '{"api_key": "abcd1234efgh"}',
      '{"api_key": "[redacted]"}',
    ],
    [
      "a URL's user and password",
      "https://rik:s3cret@example.com/x",
      "https://[redacted]@example.com/x",
    ],
    [
      "a private key",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
      REDACTED,
    ],
  ])("masks %s", (_, text, masked) => {
    expect(maskCredentials(text)).toBe(masked);
    expect(maskCredentials(masked)).toBe(masked);
  });

  it("reads a long text once, so a customer's message cannot stall the Worker", () => {
    const long = [
      "a".repeat(200_000),
      "https://".repeat(5000),
      "eyJ".repeat(5000),
      "password:".repeat(5000),
      `Bearer ${"b".repeat(100_000)}`,
    ].join(" ");

    const started = performance.now();
    maskCredentials(long);

    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("leaves a conversation's words alone", () => {
    const words =
      "My invoice INV-77341 was charged twice; mail marieke@example.nl or call 06-12345678.";

    expect(maskCredentials(words)).toBe(words);
  });
});

describe("bounds", () => {
  it("cuts a string at the limit and says how much is left out", () => {
    const cut = bounded("a".repeat(TEXT_LIMIT + 5));

    expect(cut).toBe(`${"a".repeat(TEXT_LIMIT)}… [5 more characters]`);
  });

  it("lets a long prompt's oldest messages give way, keeping the instructions and the latest question", () => {
    const old = "x".repeat(TEXT_LIMIT);

    const messages = [
      ...Array.from({ length: 20 }, () => ({
        role: "user" as const,
        content: old,
      })),
      { role: "user" as const, content: "And now?" },
    ];

    const input = chatInput("Be brief.", messages);

    expect(JSON.stringify(input).length).toBeLessThanOrEqual(INPUT_LIMIT);
    expect(input[0]).toStrictEqual({ role: "system", content: "Be brief." });
    expect(input[1]).toMatchObject({
      role: "system",
      content: stringMatching(/^\[\d+ earlier messages left out\]$/u),
    });
    expect(input.at(-1)).toStrictEqual({ role: "user", content: "And now?" });
  });
});

describe("messages", () => {
  it("shows a tool loop in the Chat Completions shape, without thinking", () => {
    const input = chatInput(
      [{ role: "system", content: "You help." }],
      [
        {
          role: "user",
          content: [
            { type: "text", text: "Find INV-1" },
            { type: "image", image: "data:", mediaType: "image/png" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "I should look it up." },
            {
              type: "tool-call",
              toolCallId: "c1",
              toolName: "lookup",
              input: { id: "INV-1" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              toolName: "lookup",
              output: { type: "json", value: { paid: true } },
            },
          ],
        },
      ]
    );

    expect(input).toStrictEqual([
      { role: "system", content: "You help." },
      { role: "user", content: "Find INV-1\n[image image/png]" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "lookup", arguments: '{"id":"INV-1"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "c1",
        name: "lookup",
        content: '{"paid":true}',
      },
    ]);
    expect(JSON.stringify(input)).not.toContain("I should look it up");
  });

  it("shows an answer's words and calls", () => {
    // The AI SDK's parts, a reasoning part among them.
    const parts = [
      { type: "reasoning", text: "Hm." },
      { type: "text", text: "Paid." },
    ];

    expect(chatOutput(parts)).toStrictEqual([
      { role: "assistant", content: "Paid." },
    ]);
  });
});
