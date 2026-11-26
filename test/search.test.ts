import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { searchEntries, searchState } from "~/db/schema";
import type { User } from "~/db/schema";
import { stepView } from "~/lib/assistant/assistant";
import type { Json } from "~/lib/assistant/assistant";
import {
  finishUpload,
  removeShare,
  setShare,
  startUpload,
} from "~/lib/drive/drive.server";
import { ingestInboundEmail } from "~/lib/mail/ingest.server";
import { deleteThreadForever } from "~/lib/mail/mailbox.server";
import { applyThreadAction } from "~/lib/mail/threads.server";
import { nearest } from "~/lib/search/index.server";
import { indexForSearch, MAIL_BATCH } from "~/lib/search/indexer.server";

import { ask, isObject, toolPart } from "./assistant-turn";
import { db, defined, mail, mailbox, sorted } from "./fixtures";
import { fakeSearchIndex } from "./search-index";
import { stubEnv } from "./stub-env";

/** A conversation in the person's inbox, last heard from at `date`. */
const arrived = async (
  user: User,
  subject: string,
  text: string,
  date = new Date().toISOString()
) => {
  const r = await ingestInboundEmail(
    env,
    null,
    mail({ to: [{ email: user.email, name: null }], subject, text, date }),
    user.email
  );

  if (r.status !== "stored") {
    throw new Error(r.status);
  }

  return r.threadId;
};

/** A text file in the person's Drive. */
const inDrive = async (userId: string, name: string, text: string) => {
  const bytes = new TextEncoder().encode(text);

  const { node } = await startUpload(db, env, userId, {
    parentId: null,
    name,
    size: bytes.byteLength,
    contentType: "text/plain",
    multipart: false,
  });

  await env.DRIVE.put(defined(node.r2Key), bytes, {
    httpMetadata: { contentType: "text/plain" },
  });

  return finishUpload(env, db, userId, node.id);
};

/** The indexer run until a run reads nothing more, a minute apart from `from`; answers the moment after the last. */
const settle = async (over: Env, from: Date): Promise<Date> => {
  let at = from;

  for (let run = 0; run < 40; run += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- the cron's runs come one after the other
    const done = await indexForSearch(over, db, at);
    at = new Date(at.getTime() + 60_000);

    if (!done?.indexed && !done?.removed) {
      return at;
    }
  }

  throw new Error("The indexer never came to rest.");
};

/** One search by the assistant in a turn of its own, and the titles it answered with how each was found. */
const search = async (
  user: User,
  tool: "search_mail" | "search_drive",
  input: { [key: string]: Json },
  over: Env
) => {
  const turn = await ask(
    user,
    "Find it.",
    [{ tool, input }, { text: "Found." }],
    {
      env: over,
    }
  );

  const part = defined(toolPart(turn.last.parts, tool), "the step");
  const rows = part.output[tool === "search_mail" ? "conversations" : "items"];

  return {
    part,
    note: part.output.note,
    found: (Array.isArray(rows) ? rows.filter(isObject) : []).map((row) => [
      row.subject ?? row.name,
      row.foundBy,
    ]),
  };
};

describe("the search by meaning", () => {
  let ann: User;
  let bo: User;
  beforeAll(async () => {
    ann = await mailbox("search-ann", "Ann");
    bo = await mailbox("search-bo", "Bo");
  });

  it("does nothing where the Worker has no index", async () => {
    await expect(indexForSearch(env, db)).resolves.toBeNull();
  });

  it("has no index while AI_FEATURES is off, so the cron embeds nothing", async () => {
    const index = fakeSearchIndex();

    await expect(
      indexForSearch(stubEnv({ ...index.env, AI_FEATURES: "off" }), db)
    ).resolves.toBeNull();
  });

  it("indexes what there is, newest first, then what arrives, and reads a conversation again only when it changed", async () => {
    const index = fakeSearchIndex();
    const start = new Date(Date.now() - 10 * 60_000);

    // History from before the index began: more than one batch of it.
    const old = [];

    for (let i = 0; i < MAIL_BATCH + 2; i += 1) {
      old.push(
        // oxlint-disable-next-line eslint/no-await-in-loop -- the fixtures arrive in order
        await arrived(
          ann,
          `History ${i}`,
          "An old exchange about studio rental.",
          new Date(start.getTime() - (i + 1) * 3_600_000).toISOString()
        )
      );
    }

    const first = await indexForSearch(index.env, db, start);
    const afterFirst = index.puts.map((p) => p.id);
    let at = await settle(index.env, new Date(start.getTime() + 60_000));
    const afterHistory = index.puts.length;

    // New mail, after the index began.
    const fresh = await arrived(ann, "Fresh question", "About the aerial.");
    at = await settle(index.env, at);
    const afterFresh = index.puts.length;

    // Nothing changed: nothing is read again.
    at = await settle(index.env, at);
    const quiet = index.puts.length;

    // A reply in the fresh conversation changes it.
    const again = await ingestInboundEmail(
      env,
      null,
      mail({
        to: [{ email: ann.email, name: null }],
        subject: "Re: Fresh question",
        text: "And the mast.",
        date: new Date(Date.now() + 1000).toISOString(),
        inReplyTo: null,
        references: [],
      }),
      ann.email
    );

    await settle(index.env, at);

    const rested = await db.query.searchState.findFirst({
      where: eq(searchState.key, "mail.back.rested"),
    });

    expect({
      // The first run takes a batch of the newest history.
      first: [first?.indexed, afterFirst.toSorted()],
      history: afterHistory,
      fresh: index.puts.slice(afterHistory, afterFresh).map((p) => p.id),
      quiet: quiet === afterFresh,
      again: again.status,
      held: index.ids().length >= MAIL_BATCH + 3,
      owner: [...new Set(index.puts.map((p) => `${p.kind}:${p.owner}`))],
      // Having been through everything, the walk into the past rests.
      rested: Boolean(rested),
    }).toStrictEqual({
      first: [MAIL_BATCH, old.slice(0, MAIL_BATCH).toSorted()],
      history: MAIL_BATCH + 2,
      fresh: [fresh],
      quiet: true,
      again: "stored",
      held: true,
      owner: [`mail:${ann.id}`],
      rested: true,
    });
  });

  it("finds a person's own mail by what it is about, read back through the mailbox, beside the words", async () => {
    const index = fakeSearchIndex();
    const start = new Date(Date.now() - 60_000);
    await indexForSearch(index.env, db, start);

    const dispute = await arrived(
      ann,
      "Invoice 2291",
      "We do not agree with the amount Broadcast Partners charged for the transmitter."
    );

    await arrived(ann, "Lunch on Friday", "Shall we eat at the harbour?");

    const trashed = await arrived(
      ann,
      "Old transmitter quarrel",
      "The transmitter charge was wrong last year too."
    );

    const bos = await arrived(
      bo,
      "Bo's transmitter invoice",
      "The transmitter invoice for Bo, charged twice."
    );

    await settle(index.env, new Date(start.getTime() + 60_000));
    await applyThreadAction(db, env, ann.id, [trashed], { intent: "trash" });

    const about = "the transmitter charged amount we dispute";

    const [mine, both, theirs, without] = [
      await search(ann, "search_mail", { about }, index.env),
      await search(ann, "search_mail", { about, query: "harbour" }, index.env),
      await search(bo, "search_mail", { about }, index.env),
      // A Worker without an index searches the words, and says so.
      await search(ann, "search_mail", { about: "Invoice" }, env),
    ];

    // A question by meaning that nothing in the mailbox is about answers nothing, not the newest mail.
    const nothing = await search(
      ann,
      "search_mail",
      { about: "zebra crossing regulations" },
      index.env
    );

    expect({
      // The trashed one is in the index still, and the mailbox does not answer it; Bo's is under Bo.
      indexed: [dispute, trashed, bos].every((id) => index.ids().includes(id)),
      mine: mine.found,
      both: both.found,
      theirs: theirs.found,
      without: [without.found, without.note],
      nothing: [nothing.found, nothing.note],
      line: stepView(mine.part).label,
    }).toStrictEqual({
      indexed: true,
      mine: [["Invoice 2291", "meaning"]],
      both: [
        ["Invoice 2291", "meaning"],
        ["Lunch on Friday", "words"],
      ],
      theirs: [["Bo's transmitter invoice", "meaning"]],
      without: [
        [["Invoice 2291", "words"]],
        "The search by meaning is not available here, so this searched the words.",
      ],
      nothing: [[], undefined],
      line: "Searched mail about “the transmitter charged amount we dispute”",
    });
  });

  it("finds files by their contents, a colleague's only while it is shared", async () => {
    const index = fakeSearchIndex();
    const start = new Date(Date.now() - 60_000);
    await indexForSearch(index.env, db, start);

    await inDrive(
      ann.id,
      "notes.txt",
      "The aerial on the mast needs new guy wires."
    );

    const shared = await inDrive(
      bo.id,
      "survey.txt",
      "Mast survey: the guy wires are corroded."
    );

    await inDrive(
      bo.id,
      "private.txt",
      "Bo's own notes on the mast and its guy wires."
    );
    await setShare(db, bo.id, shared.id, ann.id, "viewer");
    await settle(index.env, new Date(start.getTime() + 60_000));

    const about = "guy wires on the mast";
    const whileShared = await search(ann, "search_drive", { about }, index.env);

    await removeShare(db, bo.id, shared.id, ann.id);
    const after = await search(ann, "search_drive", { about }, index.env);

    expect({
      whileShared: sorted(whileShared.found),
      after: after.found,
      line: stepView(whileShared.part).label,
    }).toStrictEqual({
      whileShared: [
        ["notes.txt", "meaning"],
        ["survey.txt", "meaning"],
      ],
      after: [["notes.txt", "meaning"]],
      line: "Searched Drive about “guy wires on the mast”",
    });
  });

  it("looks among ten sharing colleagues at most, and says how many it left out", async () => {
    const index = fakeSearchIndex();
    const carol = await mailbox("search-carol", "Carol");

    // Twelve colleagues each share a file with Carol: two more than a search asks the index about.
    for (let i = 0; i < 12; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the fixtures are made one after the other
      const colleague = await mailbox(`search-sharer-${i}`, `Sharer ${i}`);

      // oxlint-disable-next-line eslint/no-await-in-loop -- as above
      const file = await inDrive(
        colleague.id,
        `rota-${i}.txt`,
        "The rota for the outside broadcast van."
      );

      // oxlint-disable-next-line eslint/no-await-in-loop -- as above
      await setShare(db, colleague.id, file.id, carol.id, "viewer");
    }

    const about = "outside broadcast van rota";
    const some = await search(carol, "search_drive", { about }, index.env);

    // With one colleague sharing, nobody is left out and nothing is said.
    const dan = await mailbox("search-dan", "Dan");
    const only = await mailbox("search-only", "Only");
    const one = await inDrive(only.id, "single.txt", "A single shared note.");
    await setShare(db, only.id, one.id, dan.id, "viewer");

    const all = await search(
      dan,
      "search_drive",
      { about: "single shared note" },
      index.env
    );

    expect([some.note, all.note]).toStrictEqual([
      "Files shared by 2 more colleagues were not searched by meaning: search those by name.",
      undefined,
    ]);
  });

  it("searches by words, and says so, when the index fails", async () => {
    const index = fakeSearchIndex();

    // SAFETY: test-only: the fake's own index with a `find` that fails, as Vectorize or the embedding model can.
    const failing = {
      ...index.env,
      SEARCH_INDEX: {
        ...index.index,
        find: () => Promise.reject(new Error("The index is down.")),
      },
    } as Env;

    await arrived(
      ann,
      "Gantry inspection",
      "The yearly inspection of the gantry."
    );
    await inDrive(ann.id, "gantry.txt", "Notes on the gantry.");

    const [mailFound, filesFound] = [
      await search(ann, "search_mail", { about: "gantry" }, failing),
      await search(ann, "search_drive", { about: "gantry" }, failing),
    ];

    expect({
      mail: [mailFound.found, mailFound.note],
      files: [filesFound.found, filesFound.note],
    }).toStrictEqual({
      mail: [
        [["Gantry inspection", "words"]],
        "The search by meaning is not available here, so this searched the words.",
      ],
      files: [
        [["gantry.txt", "name"]],
        "The search by meaning is not available here, so this searched the names.",
      ],
    });
  });

  it("counts a match only when it is near enough, nearest first", () => {
    expect(
      nearest(
        [
          { id: "far", score: 0.49 },
          { id: "near", score: 0.61 },
          { id: "edge", score: 0.5 },
          { id: "nearest", score: 0.74 },
        ],
        2
      )
    ).toStrictEqual([
      { id: "nearest", score: 0.74 },
      { id: "near", score: 0.61 },
    ]);

    // A question about nothing in the mailbox tops at about 0.32: nothing is found.
    expect(nearest([{ id: "unrelated", score: 0.32 }], 10)).toStrictEqual([]);
  });

  it("takes the vector of what is deleted for good out of the index", async () => {
    const index = fakeSearchIndex();
    const start = new Date(Date.now() - 60_000);
    await indexForSearch(index.env, db, start);
    const id = await arrived(ann, "To be deleted", "Gone soon.");
    const at = await settle(index.env, new Date(start.getTime() + 60_000));
    const held = index.ids().includes(id);

    await applyThreadAction(db, env, ann.id, [id], { intent: "trash" });
    await deleteThreadForever(db, env, ann.id, id);
    await settle(index.env, at);

    const entry = await db.query.searchEntries.findFirst({
      where: eq(searchEntries.id, id),
    });

    expect({
      held,
      removed: index.removed.includes(id),
      stillHeld: index.ids().includes(id),
      entry: entry ?? null,
    }).toStrictEqual({
      held: true,
      removed: true,
      stillHeld: false,
      entry: null,
    });
  });
});
