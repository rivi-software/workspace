import { installPostHogForTests } from "@rivi-software/posthog-tanstack-start/server";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { User } from "~/db/schema";
import type { Json } from "~/lib/assistant/assistant";
import { answerChat } from "~/lib/assistant/chat.server";
import { ingestInboundEmail } from "~/lib/mail/ingest.server";

import { db, mail, mailbox } from "./fixtures";

/** What the PostHog client was given to send. */
const sent: {
  event: string;
  distinctId?: string;
  properties: Record<string, Json>;
}[] = [];

// What a correspondent wrote, which the Assistant's search reads back.
const SUBJECT = "Quarterly figures for Breeze";
const BODY = "Revenue grew 14 percent; the board meets on Thursday.";

// The properties PostHog keeps for 30 days: the only ones that may hold a word of the person's mail.
const CONTENT = new Set([
  "$ai_input",
  "$ai_output",
  "$ai_output_choices",
  "$ai_input_state",
  "$ai_output_state",
]);

/** The properties that hold `needle`, across the events sent since the test began. */
const holding = (needle: string) =>
  sent.flatMap(({ properties }) =>
    Object.entries(properties).flatMap(([key, value]) =>
      JSON.stringify(value)?.includes(needle) ? [key] : []
    )
  );

/** A question to the Assistant, its answer read to the end and its turn stored, with the text switch as given. */
const ask = async (user: User, text: string, switchOn: boolean) => {
  // SAFETY: test-only: the var is typed as `wrangler.jsonc`'s literal, and the module reads it as any string.
  const withSwitch = {
    ...env,
    AI_TEXT_ANALYTICS: switchOn ? "on" : "off",
  } as Env;

  const answer = await answerChat(withSwitch, db, user, {
    conversationId: null,
    message: { role: "user", parts: [{ type: "text", text }] },
  });

  await answer.response.text();
  await answer.done;

  return answer.conversationId;
};

describe("the Assistant in PostHog AI observability", () => {
  let ann: User;

  beforeAll(async () => {
    installPostHogForTests({
      captureImmediate: ({ event, distinctId, properties = {} }) => {
        // SAFETY: the AI events are built from JSON values (`@rivi/ai-telemetry`), which the client sends as they are.
        sent.push({
          event,
          distinctId,
          properties: properties as Record<string, Json>,
        });

        return Promise.resolve();
      },
      captureExceptionImmediate: () => Promise.resolve(),
    });

    ann = await mailbox("tel", "Tess");

    const r = await ingestInboundEmail(
      env,
      null,
      mail({
        to: [{ email: ann.email, name: null }],
        subject: SUBJECT,
        text: BODY,
      }),
      ann.email
    );

    if (r.status !== "stored") {
      throw new Error(r.status);
    }
  });

  beforeEach(() => {
    sent.length = 0;
  });

  afterAll(() => installPostHogForTests(null));

  it("reports a turn as one trace on the person: each step's generation and the search under the step that called it", async () => {
    const conversationId = await ask(
      ann,
      "search my mail for Quarterly",
      false
    );

    const trace = sent.find((e) => e.event === "$ai_trace")?.properties;

    const [first, second] = sent.flatMap((e) =>
      e.event === "$ai_generation" ? [e.properties] : []
    );

    const search = sent.find((e) => e.event === "$ai_span")?.properties;

    expect(
      sent.map((e) => [e.event, e.properties.$ai_span_name])
    ).toStrictEqual([
      ["$ai_generation", "assistant"],
      ["$ai_span", "search_mail"],
      ["$ai_generation", "assistant"],
      ["$ai_trace", "assistant"],
    ]);
    expect([
      first?.$ai_parent_id,
      second?.$ai_parent_id,
      search?.$ai_parent_id,
    ]).toStrictEqual([
      trace?.$ai_trace_id,
      trace?.$ai_trace_id,
      first?.$ai_span_id,
    ]);
    expect(
      new Set(
        sent.map((e) => [e.distinctId, e.properties.$ai_session_id].join(","))
      )
    ).toStrictEqual(new Set([`${ann.id},${conversationId}`]));
  });

  it("leaves without a word of the mail while the switch is off", async () => {
    await ask(ann, "search my mail for Quarterly", false);

    expect([
      ...holding(SUBJECT),
      ...holding(BODY),
      ...holding("Quarterly"),
    ]).toStrictEqual([]);
  });

  it("carries the question, the steps and the search's result where it is on, only in the properties kept 30 days", async () => {
    await ask(ann, "search my mail for Quarterly", true);

    const trace = sent.find((e) => e.event === "$ai_trace")?.properties;

    expect(holding(SUBJECT).length).toBeGreaterThan(0);
    expect(
      [...holding(SUBJECT), ...holding("Quarterly")].filter(
        (key) => !CONTENT.has(key)
      )
    ).toStrictEqual([]);
    expect(trace?.$ai_input_state).toBe("search my mail for Quarterly");
    expect(trace?.$ai_output_state).toContain("search_mail answered");
  });
});
