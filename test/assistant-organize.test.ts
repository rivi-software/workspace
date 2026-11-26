import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { assistantMessages, assistantUndos, threads } from "~/db/schema";
import type { User } from "~/db/schema";
import { canUndo, isToolPart, stepView } from "~/lib/assistant/assistant";
import type { Json } from "~/lib/assistant/assistant";
import { undoStep } from "~/lib/assistant/chat.server";
import { stringOrNull } from "~/lib/guards";
import { ingestInboundEmail } from "~/lib/mail/ingest.server";
import { createLabel } from "~/lib/mail/labels.server";
import { labelsForThreads } from "~/lib/mail/mailbox.server";
import { applyThreadAction } from "~/lib/mail/threads.server";

import { ask, promptOf, toolPart } from "./assistant-turn";
import { db, defined, mail, mailbox, sorted } from "./fixtures";

const AMS = "Europe/Amsterdam";
const done = [{ text: "Done." }] as const;

/** A conversation in the person's inbox, by its subject. */
const arrived = async (user: User, subject: string) => {
  const r = await ingestInboundEmail(
    env,
    null,
    mail({ to: [{ email: user.email, name: null }], subject }),
    user.email
  );

  if (r.status !== "stored") {
    throw new Error(r.status);
  }

  return r.threadId;
};

/** Where a conversation sits and how it is marked. */
const stateOf = async (id: string) => {
  const t = defined(
    await db.query.threads.findFirst({ where: eq(threads.id, id) }),
    "the thread"
  );

  return [t.folder, t.starred, t.unreadCount, t.snoozedUntil] as const;
};

/** The folder a conversation sits in. */
const folderOf = async (id: string) => {
  const [folder] = await stateOf(id);

  return folder;
};

/** Until when a conversation is snoozed. */
const snoozeOf = async (id: string) => {
  const state = await stateOf(id);

  return state[3];
};

/** The line of a done `organize_mail` step with this output. */
const stepLine = (output: { [key: string]: Json }) =>
  stepView({
    type: "tool-organize_mail",
    toolCallId: "1",
    state: "output-available",
    output,
  }).label;

/** One call of `organize_mail` in a turn of its own, with what it answered and where its step is stored. */
const organize = async (
  user: User,
  input: { [key: string]: Json },
  conversationId?: string
) => {
  const turn = await ask(
    user,
    "Organise it.",
    [{ tool: "organize_mail", input }, ...done],
    { timeZone: AMS, conversationId }
  );

  const part = defined(toolPart(turn.last.parts, "organize_mail"), "the step");

  return {
    turn,
    part,
    output: part.output,
    step: {
      conversationId: turn.conversationId,
      messageId: turn.last.id,
      toolCallId: part.toolCallId,
    },
  };
};

describe("the assistant organising mail", () => {
  let ann: User;
  let bo: User;
  beforeAll(async () => {
    ann = await mailbox("org-ann", "Ann");
    bo = await mailbox("org-bo", "Bo");
  });

  it("does one of the list's actions to the person's conversations, and only theirs", async () => {
    const [first, second, bos] = [
      await arrived(ann, "Newsletter one"),
      await arrived(ann, "Newsletter two"),
      await arrived(bo, "Bo's own"),
    ];

    const archived = await organize(ann, {
      conversationIds: [first, second, bos, "th_nosuchthing"],
      action: "archive",
    });

    const starred = await organize(ann, {
      conversationIds: [first],
      action: "star",
    });

    const read = await organize(ann, {
      conversationIds: [first, second],
      action: "read",
    });

    expect({
      archived: [
        archived.output.action,
        archived.output.count,
        archived.output.missing,
        archived.output.link,
      ],
      starred: starred.output.count,
      read: read.output.count,
      states: [await stateOf(first), await stateOf(second)],
      // Bo's conversation was named and not touched.
      bos: await stateOf(bos),
    }).toStrictEqual({
      archived: ["archive", 2, 2, "/mail"],
      starred: 1,
      read: 2,
      states: [
        ["archive", true, 0, null],
        ["archive", false, 0, null],
      ],
      bos: ["inbox", false, 1, null],
    });
  });

  it("snoozes until a moment on the person's clock and labels by the label's name", async () => {
    const id = await arrived(ann, "Come back later");
    await createLabel(db, ann.id, { name: "Invoices", color: "green" });

    const snoozed = await organize(ann, {
      conversationIds: [id],
      action: "snooze",
      untilDate: "2031-03-12",
    });

    const labelled = await organize(ann, {
      conversationIds: [id],
      action: "label",
      label: "invoices",
    });

    const refusals = [
      await organize(ann, { conversationIds: [id], action: "snooze" }),
      await organize(ann, {
        conversationIds: [id],
        action: "snooze",
        untilDate: "2020-01-01",
      }),
      await organize(ann, {
        conversationIds: [id],
        action: "label",
        label: "Receipts",
      }),
    ];

    const labels = await labelsForThreads(db, ann.id, [id]);

    expect({
      // 08:00 in Amsterdam in winter is 07:00 in UTC.
      snoozed: [snoozed.output.until, await snoozeOf(id)],
      labelled: labelled.output.label,
      labels: (labels.get(id) ?? []).map((l) => l.name),
      refusals: refusals.map((r) => r.output.error),
    }).toStrictEqual({
      snoozed: ["2031-03-12 08:00", "2031-03-12T07:00:00.000Z"],
      labelled: "Invoices",
      labels: ["Invoices"],
      refusals: [
        "A snooze needs the day the conversations come back.",
        "That moment has passed: choose a later one.",
        "No label is called “Receipts”. The labels are: Invoices.",
      ],
    });
  });

  it("leaves Spam alone, and has no way to delete for good, mute or move into Spam", async () => {
    const id = await arrived(ann, "Win a prize");
    await applyThreadAction(db, env, ann.id, [id], { intent: "spam" });

    const tried = await organize(ann, {
      conversationIds: [id],
      action: "inbox",
    });

    const forbidden = await Promise.all(
      ["delete", "spam", "mute"].map(async (action) => {
        const turn = await ask(
          ann,
          "Do it.",
          [
            {
              tool: "organize_mail",
              input: { conversationIds: [id], action },
            },
            ...done,
          ],
          { timeZone: AMS }
        );

        const part = turn.last.parts.find((p) => isToolPart(p));

        // The tool's input is refused before anything runs.
        return [part?.state, await folderOf(id)];
      })
    );

    expect({
      tried: [tried.output.count, tried.output.inSpam, tried.output.undoId],
      folder: await folderOf(id),
      forbidden,
      line: stepView(tried.part).detail,
    }).toStrictEqual({
      tried: [0, 1, null],
      folder: "spam",
      forbidden: [
        ["output-error", "spam"],
        ["output-error", "spam"],
        ["output-error", "spam"],
      ],
      line: "1 conversation in Spam left alone",
    });
  });

  it("undoes a step once, for the person alone and within ten minutes, and tells the model so", async () => {
    const id = await arrived(ann, "Undo me");

    const archived = await organize(ann, {
      conversationIds: [id],
      action: "archive",
    });

    const at = Date.parse(stringOrNull(archived.output.at) ?? "");
    const after = await folderOf(id);

    const kept = defined(
      await db.query.assistantUndos.findFirst({
        where: eq(
          assistantUndos.id,
          stringOrNull(archived.output.undoId) ?? ""
        ),
      }),
      "the kept undo"
    );

    const byBo = await undoStep(db, env, bo.id, archived.step);

    const late = await undoStep(
      db,
      env,
      ann.id,
      archived.step,
      new Date(at + 11 * 60_000)
    );

    const stillArchived = await folderOf(id);

    // Two tabs at once: one of them undoes it.
    const both = await Promise.all([
      undoStep(db, env, ann.id, archived.step),
      undoStep(db, env, ann.id, archived.step),
    ]);

    const again = await undoStep(db, env, ann.id, archived.step);

    const row = defined(
      await db.query.assistantMessages.findFirst({
        where: eq(assistantMessages.id, archived.step.messageId),
      }),
      "the answer"
    );

    const next = await ask(ann, "And now?", [{ text: "It is back." }], {
      conversationId: archived.step.conversationId,
      timeZone: AMS,
    });

    expect({
      after,
      // The page offers Undo for ten minutes, and the server takes it for as long.
      offered: [
        canUndo(archived.part, at + 9 * 60_000),
        canUndo(archived.part, at + 11 * 60_000),
      ],
      refused: [byBo, late],
      stillArchived,
      both: sorted(both.map((r) => String(r.ok))),
      back: await folderOf(id),
      again,
      // The sealed undo stays on the server: not in what the page was sent, what is stored, or what the model reads.
      sealedLeft: [
        archived.turn.body.includes(kept.undo),
        row.partsJson.includes(kept.undo),
        promptOf(archived.turn.model, 2).includes(kept.undo),
      ],
      // The step reads as undone, to the page and to the model in the turn that follows.
      undone: [
        row.partsJson.includes('"undone":true'),
        promptOf(next.model, 1).includes('"undone":true'),
      ],
    }).toStrictEqual({
      after: "archive",
      offered: [true, false],
      refused: [
        { ok: false, error: "There is nothing to undo here." },
        {
          ok: false,
          error: "It is too late to undo this here. Change it in Mail.",
        },
      ],
      stillArchived: "archive",
      both: ["false", "true"],
      back: "inbox",
      again: { ok: false, error: "There is nothing to undo here." },
      sealedLeft: [false, false, false],
      undone: [true, true],
    });
  });

  it("names each action in its step", () => {
    expect([
      stepLine({ action: "archive", count: 3 }),
      stepLine({ action: "inbox", count: 1 }),
      stepLine({ action: "trash", count: 2 }),
      stepLine({ action: "unstar", count: 1 }),
      stepLine({ action: "unread", count: 2 }),
      stepLine({ action: "snooze", count: 1, until: "2031-03-12 08:00" }),
      stepLine({ action: "unsnooze", count: 1 }),
      stepLine({ action: "label", count: 2, label: "Invoices" }),
      stepLine({ action: "unlabel", count: 1, label: "Invoices" }),
      stepLine({ error: "At most 100 conversations at a time." }),
    ]).toStrictEqual([
      "Archived 3 conversations",
      "Moved 1 conversation to the inbox",
      "Moved 2 conversations to the trash",
      "Took the star off 1 conversation",
      "Marked 2 conversations as unread",
      "Snoozed 1 conversation until 12 March, 08:00",
      "Ended the snooze of 1 conversation",
      "Put the label “Invoices” on 2 conversations",
      "Took the label “Invoices” off 1 conversation",
      "Could not organise the mail",
    ]);
  });
});
