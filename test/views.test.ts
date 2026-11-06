import { env } from "cloudflare:workers";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { threadLabels, threads } from "~/db/schema";
import type { Thread } from "~/db/schema";
import { fileMessage } from "~/lib/mail/filing.server";
import { FOLDERS, PLACES } from "~/lib/mail/folders";
import { createLabel } from "~/lib/mail/labels.server";
import { conditionSql, labelsForThreads } from "~/lib/mail/mailbox.server";
import { applyThreadAction } from "~/lib/mail/threads.server";
import {
  COUNTED,
  THREAD_INTENTS,
  afterEffect,
  intentEffect,
  leavesView,
  matches,
  viewCondition,
} from "~/lib/mail/views";
import type { Cond, ThreadAction, View, ViewedThread } from "~/lib/mail/views";

import { db, defined, mail, mailbox, sorted } from "./fixtures";

const inbox: View = { folder: "inbox", label: null, q: "" };

const thread: ViewedThread = {
  folder: "inbox",
  snoozedUntil: null,
  starred: false,
  sent: false,
  unread: false,
  labels: [],
};

/** A conversation's row as the views read it. */
const viewed = (
  t: Thread,
  labels: readonly { id: string }[] = []
): ViewedThread => ({
  folder: t.folder,
  snoozedUntil: t.snoozedUntil,
  starred: t.starred,
  sent: t.sentCount > 0,
  unread: t.unreadCount > 0,
  labels: labels.map((l) => ({ id: l.id })),
});

describe("one definition of the views", () => {
  it("reads every view and count the same in JS as in SQL, on every kind of conversation", async () => {
    const user = await mailbox("tabea");
    const label = await createLabel(db, user.id, { name: "Table" });
    // Every combination of what the views read. The fixtures are the record itself, so they go in as rows.
    const fixtures: (ViewedThread & { id: string })[] = [];

    for (const folder of PLACES) {
      for (const snoozedUntil of [null, "2030-01-01T08:00:00.000Z"]) {
        for (const starred of [false, true]) {
          for (const sent of [false, true]) {
            for (const unread of [false, true]) {
              for (const labelled of [false, true]) {
                fixtures.push({
                  id: `th_table_${fixtures.length}`,
                  folder,
                  snoozedUntil,
                  starred,
                  sent,
                  unread,
                  labels: labelled ? [{ id: label.id }] : [],
                });
              }
            }
          }
        }
      }
    }

    await db.run(
      sql`insert into ${threads} (id, user_id, subject, folder, snoozed_until, starred, sent_count, unread_count)
        select json_extract(value, '$.id'), ${user.id}, 'Table', json_extract(value, '$.folder'),
          json_extract(value, '$.snoozedUntil'), json_extract(value, '$.starred'),
          json_extract(value, '$.sent'), json_extract(value, '$.unread')
        from json_each(${JSON.stringify(fixtures.map((t) => ({ ...t, starred: +t.starred, sent: +t.sent, unread: +t.unread })))})`
    );
    await db.run(
      sql`insert into ${threadLabels} (thread_id, label_id, user_id)
        select value, ${label.id}, ${user.id} from json_each(${JSON.stringify(fixtures.flatMap((t) => (t.labels.length ? [t.id] : [])))})`
    );

    const conditions: [string, Cond][] = [
      ...FOLDERS.map((f): [string, Cond] => [f, viewCondition(f)]),
      ["anywhere", viewCondition("anywhere")],
      ["a label", viewCondition("archive", label.id)],
      ...Object.entries(COUNTED),
    ];

    await Promise.all(
      conditions.map(async ([name, cond]) => {
        const inSql = await db
          .select({ id: threads.id })
          .from(threads)
          .where(and(eq(threads.userId, user.id), conditionSql(cond, user.id)));

        const inJs = fixtures.flatMap((t) => (matches(cond, t) ? [t.id] : []));
        expect({ ids: sorted(inSql.map((r) => r.id)), name }).toStrictEqual({
          ids: sorted(inJs),
          name,
        });
      })
    );
  });

  it("leaves each conversation as the intent's effect says, on the server as on the client", async () => {
    const user = await mailbox("tilo");
    const label = await createLabel(db, user.id, { name: "Effect" });
    const until = new Date(Date.now() + 3 * 3_600_000).toISOString();

    const actions: ThreadAction[] = THREAD_INTENTS.filter(
      (i) => i !== "delete"
    ).map((intent) => ({
      intent,
      until: intent === "snooze" ? until : null,
      labelId: intent === "label" || intent === "unlabel" ? label.id : null,
    }));

    const starts = ["inbox", "snoozed", "archive", "spam", "trash"] as const;

    // Each pair files a conversation of its own and acts on that one alone.
    await Promise.all(
      actions.flatMap((action) =>
        starts.map(async (start) => {
          const filed = await fileMessage(env, db, user, {
            policy: "arrival",
            mail: mail({ subject: `${action.intent} from ${start}` }),
            raw: null,
            place: () => ({
              folder: start === "snoozed" ? "inbox" : start,
              // Half start with the label, so labelling adds it and unlabelling takes it off.
              labelIds:
                start === "archive" || start === "trash" ? [] : [label.id],
            }),
          });

          const id = filed.threadId;

          if (start === "snoozed") {
            await applyThreadAction(db, env, user.id, [id], {
              intent: "snooze",
              until: new Date(Date.now() + 3_600_000).toISOString(),
            });
          }

          const read = async () => {
            const row = defined(
              await db.query.threads.findFirst({
                where: eq(threads.id, id),
              })
            );

            const labels = await labelsForThreads(db, user.id, [id]);

            return viewed(row, labels.get(id) ?? []);
          };

          const predicted = afterEffect(await read(), intentEffect(action));
          await applyThreadAction(db, env, user.id, [id], action);
          await expect(read()).resolves.toStrictEqual(predicted);
        })
      )
    );
  });
});

describe("what an action takes out of the view", () => {
  it("takes a conversation out of the inbox when it is archived, trashed, reported, snoozed or muted", () => {
    for (const intent of [
      "archive",
      "trash",
      "spam",
      "mute",
      "delete",
    ] as const) {
      expect(leavesView(inbox, thread, { intent })).toBeTruthy();
    }

    expect(
      leavesView(inbox, thread, {
        intent: "snooze",
        until: "2026-11-01T08:00:00.000Z",
      })
    ).toBeTruthy();

    for (const intent of ["read", "unread", "star", "unmute"] as const) {
      expect(leavesView(inbox, thread, { intent })).toBeFalsy();
    }
  });

  it("keeps an archived conversation in All mail and a starred one in Starred, but not once trashed", () => {
    const all: View = { folder: "archive", label: null, q: "" };
    expect(leavesView(all, thread, { intent: "archive" })).toBeFalsy();
    expect(leavesView(all, thread, { intent: "trash" })).toBeTruthy();
    const starred: View = { folder: "starred", label: null, q: "" };
    const star = { ...thread, starred: true };
    expect(leavesView(starred, star, { intent: "archive" })).toBeFalsy();
    expect(leavesView(starred, star, { intent: "unstar" })).toBeTruthy();
    expect(leavesView(starred, star, { intent: "spam" })).toBeTruthy();
  });

  it("takes a conversation out of the trash or spam when it goes anywhere else", () => {
    const trash: View = { folder: "trash", label: null, q: "" };
    const trashed = { ...thread, folder: "trash" as const };
    expect(leavesView(trash, trashed, { intent: "inbox" })).toBeTruthy();
    expect(leavesView(trash, trashed, { intent: "delete" })).toBeTruthy();
    expect(leavesView(trash, trashed, { intent: "star" })).toBeFalsy();
  });

  it("keeps a conversation the owner wrote in under Sent until it goes to the trash or Spam", () => {
    const sent: View = { folder: "sent", label: null, q: "" };
    const wrote = { ...thread, sent: true };
    expect(leavesView(sent, wrote, { intent: "archive" })).toBeFalsy();
    expect(leavesView(sent, wrote, { intent: "trash" })).toBeTruthy();
    expect(leavesView(sent, wrote, { intent: "spam" })).toBeTruthy();
  });

  it("takes a conversation out of a label's view when it loses the label or goes to the trash", () => {
    const view: View = { folder: "archive", label: { id: "lbl_a" }, q: "" };
    const labelled = { ...thread, labels: [{ id: "lbl_a" }] };
    expect(leavesView(view, labelled, { intent: "archive" })).toBeFalsy();
    expect(
      leavesView(view, labelled, { intent: "unlabel", labelId: "lbl_a" })
    ).toBeTruthy();
    expect(
      leavesView(view, labelled, { intent: "unlabel", labelId: "lbl_b" })
    ).toBeFalsy();
    expect(leavesView(view, labelled, { intent: "trash" })).toBeTruthy();
  });

  it("judges a search by where it looks: all mail, or what `in:` names", () => {
    expect(
      leavesView({ ...inbox, q: "budget" }, thread, { intent: "archive" })
    ).toBeFalsy();
    expect(
      leavesView({ ...inbox, q: "budget" }, thread, { intent: "trash" })
    ).toBeTruthy();
    expect(
      leavesView({ ...inbox, q: "budget in:inbox" }, thread, {
        intent: "archive",
      })
    ).toBeTruthy();
    expect(
      leavesView({ ...inbox, q: "in:anywhere" }, thread, { intent: "trash" })
    ).toBeFalsy();
  });
});
