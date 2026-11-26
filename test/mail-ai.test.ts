import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import type { User } from "~/db/schema";
import {
  MAX_INSTRUCTION_CHARS,
  draftMessage,
  summarizeConversation,
} from "~/lib/assistant/mail-ai.server";
import { assistantReady } from "~/lib/assistant/provider.server";
import { ingestInboundEmail } from "~/lib/mail/ingest.server";

import { db, defined, mail, mailbox } from "./fixtures";
import { scriptedModel } from "./scripted-model";

const AMS = "Europe/Amsterdam";

/** A conversation in the person's inbox: Jane's question above the mail she quotes. */
const question = async (user: User) => {
  const r = await ingestInboundEmail(
    env,
    null,
    mail({
      to: [{ email: user.email, name: null }],
      from: { email: "jane@wavelength.fm", name: "Jane Wave" },
      subject: "Night show on the backup stream",
      text: "Can the night show run from the backup stream on 3 December?\n\nOn Monday Bo wrote:\n> the earlier mail",
      date: "2026-11-16T23:30:00.000Z",
    }),
    user.email
  );

  if (r.status !== "stored") {
    throw new Error(r.status);
  }

  return r.threadId;
};

/** What a scripted model was given on its only call: its system prompt, the prompt and the provider's options. */
const given = (model: ReturnType<typeof scriptedModel>) => {
  const call = defined(model.doStreamCalls[0], "the call");

  return {
    prompt: JSON.stringify(call.prompt),
    options: call.providerOptions,
  };
};

/** A model no test should reach: its one answer would show in what the call returned. */
const never = () => scriptedModel([{ text: "Never asked." }]);

/** Whether a Worker with these vars and this binding has a model to ask. */
const ready = (over: { AI_PROVIDER: string; AI?: Ai }) => {
  // SAFETY: test-only: the vars are typed as `wrangler.jsonc`'s literals, and the generated `Env` always declares the binding.
  const laid = { ...env, ...over } as Env;

  return assistantReady(laid);
};

describe("AI in Mail", () => {
  let ann: User;
  let bo: User;
  let threadId: string;
  beforeAll(async () => {
    ann = await mailbox("mailai-ann", "Ann");
    bo = await mailbox("mailai-bo", "Bo");
    threadId = await question(ann);
  });

  /** A summary as the page reads it: its text, or that its stream errored. */
  const read = async (model: ReturnType<typeof scriptedModel>) => {
    const summary = defined(
      await summarizeConversation(env, db, ann, model, {
        threadId,
        timeZone: AMS,
      }),
      "the summary"
    );

    try {
      return { text: await summary.text() };
    } catch {
      return "errored";
    }
  };

  it("summarizes a conversation of the person's own, from each message's own words, as the model writes it", async () => {
    const model = scriptedModel([{ text: "- Jane asks about 3 December." }]);

    const summary = defined(
      await summarizeConversation(env, db, ann, model, {
        threadId,
        timeZone: AMS,
      }),
      "the summary"
    );

    const text = await summary.text();
    const seen = given(model);

    const stranger = await summarizeConversation(env, db, bo, never(), {
      threadId,
      timeZone: AMS,
    });

    expect({
      text,
      type: summary.headers.get("content-type"),
      kept: summary.headers.get("cache-control"),
      reads: [
        seen.prompt.includes("Can the night show run from the backup stream"),
        seen.prompt.includes("Jane Wave <jane@wavelength.fm>"),
        // The moment is the reader's: half past midnight on the 17th in Amsterdam.
        seen.prompt.includes(
          "Received on Tuesday 17 November 2026 at 00:30, Europe/Amsterdam time"
        ),
        seen.prompt.includes(`for Ann (${ann.email})`),
      ],
      // The quoted earlier mail is no part of what Jane wrote.
      quoted: seen.prompt.includes("the earlier mail"),
      // A person waits on it: a Claude model is asked for little thinking.
      options: seen.options,
      stranger,
    }).toStrictEqual({
      text: "- Jane asks about 3 December.",
      type: "text/plain; charset=utf-8",
      kept: "no-store",
      reads: [true, true, true, true],
      quoted: false,
      options: { anthropic: { effort: "low" } },
      stranger: null,
    });
  });

  it("errors a summary's stream when the model fails, before its first word or after some, rather than ending it", async () => {
    expect([
      await read(scriptedModel([{ error: new Error("The model is down.") }])),
      await read(
        scriptedModel([
          {
            error: new Error("The model broke off."),
            midway: true,
            text: "- Jane asks",
          },
        ])
      ),
    ]).toStrictEqual(["errored", "errored"]);
  });

  it("drafts a reply from the conversation and what the person asks, and a new message from their words alone", async () => {
    const replying = scriptedModel([{ text: "  Hi Jane,\n\nYes, it can.  " }]);

    const reply = await draftMessage(env, db, ann, replying, {
      threadId,
      instruction: "Say yes, from 02:00.",
      to: "Jane Wave <jane@wavelength.fm>",
      cc: "Bo <bo@wavelength.fm>",
      timeZone: AMS,
    });

    const plain = scriptedModel([{ text: "Hi Jane,\n\nI will check." }]);

    const unprompted = await draftMessage(env, db, ann, plain, {
      threadId,
      instruction: "",
      timeZone: AMS,
    });

    const fresh = scriptedModel([{ text: "Hi Joris,\n\nSee you Friday." }]);

    const written = await draftMessage(env, db, ann, fresh, {
      threadId: null,
      instruction: "Confirm Friday's meeting.",
      to: "Joris <joris@acme.com>",
      subject: "Friday",
      timeZone: AMS,
    });

    expect({
      reply,
      asked: [
        given(replying).prompt.includes("Say yes, from 02:00."),
        given(replying).prompt.includes("Can the night show run"),
        given(replying).prompt.includes("their reply in the conversation"),
        // The greeting follows whom the composer sends it to, a reply all's Cc too.
        given(replying).prompt.includes(
          "Recipients of the reply: To: Jane Wave <jane@wavelength.fm>; Cc: Bo <bo@wavelength.fm>."
        ),
      ],
      unprompted: [
        unprompted,
        given(plain).prompt.includes("gave no instruction"),
      ],
      written,
      fresh: [
        given(fresh).prompt.includes(
          "A new message to Joris <joris@acme.com>, subject “Friday”."
        ),
        given(fresh).prompt.includes("Can the night show run"),
      ],
    }).toStrictEqual({
      reply: { ok: true, text: "Hi Jane,\n\nYes, it can." },
      asked: [true, true, true, true],
      unprompted: [{ ok: true, text: "Hi Jane,\n\nI will check." }, true],
      written: { ok: true, text: "Hi Joris,\n\nSee you Friday." },
      fresh: [true, false],
    });
  });

  it("drafts nothing for a stranger's conversation, an empty request, too long a one, or a model that fails or says nothing", async () => {
    const silent = scriptedModel([{ text: "   " }]);
    const down = scriptedModel([{ error: new Error("The model is down.") }]);

    const base = { threadId, instruction: "Say yes.", timeZone: AMS };

    expect([
      await draftMessage(env, db, bo, never(), base),
      await draftMessage(env, db, ann, never(), {
        threadId: null,
        instruction: "  ",
        timeZone: AMS,
      }),
      await draftMessage(env, db, ann, never(), {
        ...base,
        instruction: "x".repeat(MAX_INSTRUCTION_CHARS + 1),
      }),
      await draftMessage(env, db, ann, silent, base),
      await draftMessage(env, db, ann, down, base),
    ]).toStrictEqual([
      { ok: false, error: "No such conversation in this mailbox." },
      { ok: false, error: "Say what the message should say first." },
      {
        ok: false,
        error: "Say what it should say in at most 2000 characters.",
      },
      { ok: false, error: "The draft could not be written. Try again." },
      { ok: false, error: "The draft could not be written. Try again." },
    ]);
  });

  it("offers itself only where the Worker has a model: the dev model, or a provider with its AI binding", () => {
    // SAFETY: test-only: asking whether a binding is there reaches nothing of it.
    const binding = {} as Ai;

    expect([
      ready({ AI_PROVIDER: "mock", AI: undefined }),
      ready({ AI_PROVIDER: "anthropic", AI: binding }),
      ready({ AI_PROVIDER: "anthropic", AI: undefined }),
      ready({ AI_PROVIDER: "workers-ai", AI: undefined }),
    ]).toStrictEqual([true, true, false, false]);
  });
});
