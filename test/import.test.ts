import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { mailImports } from "~/db/schema";
import {
  finishMicrosoftConnect,
  startMicrosoftConnect,
} from "~/lib/mail/import/connect.server";
import {
  ImportError,
  cancelImport,
  latestImport,
  placementFor,
  planFolders,
  runImports,
  startImport,
} from "~/lib/mail/import/import.server";
import {
  GraphError,
  MicrosoftAuthError,
  graphMailSource,
} from "~/lib/mail/import/microsoft.server";
import type {
  MailSource,
  SourceFolder,
  SourceMessage,
} from "~/lib/mail/import/microsoft.server";
import { ingestInboundEmail } from "~/lib/mail/ingest.server";
import { listThreads, loadThread } from "~/lib/mail/mailbox.server";
import { openSecret, sealSecret } from "~/lib/secret-box.server";

import {
  db,
  defined,
  mail,
  mailbox,
  rawMail,
  sessionFor,
  rejection,
  sorted,
} from "./fixtures";

const tokens = {
  accessToken: "at",
  refreshToken: "rt",
  expiresAt: Date.now() + 3_600_000,
};

const folder = (
  id: string,
  path: string,
  over: Partial<SourceFolder> = {}
): SourceFolder => ({
  id,
  name: defined(path.split("/").pop()),
  path,
  parentId: null,
  total: 0,
  wellKnown: null,
  ...over,
});

const FOLDERS: SourceFolder[] = [
  folder("f-inbox", "Inbox", { wellKnown: "inbox", total: 3 }),
  folder("f-clients", "Inbox/Clients", { parentId: "f-inbox" }),
  folder("f-acme", "Inbox/Clients/Acme", { parentId: "f-clients", total: 1 }),
  folder("f-sent", "Sent Items", { wellKnown: "sentitems", total: 1 }),
  folder("f-archive", "Archive", { wellKnown: "archive", total: 2 }),
  folder("f-deleted", "Deleted Items", { wellKnown: "deleteditems", total: 4 }),
  folder("f-old", "Deleted Items/Old", { parentId: "f-deleted", total: 9 }),
  folder("f-junk", "Junk Email", { wellKnown: "junkemail", total: 7 }),
  folder("f-drafts", "Drafts", { wellKnown: "drafts", total: 1 }),
  folder("f-projects", "Projects", { total: 1 }),
];

type Fake = SourceMessage & { raw: string | "gone" | "too-large" | Error };

const message = (
  id: string,
  folderId: string,
  receivedAt: string,
  raw: Fake["raw"],
  over: Partial<SourceMessage> = {}
): Fake => ({
  id,
  folderId,
  receivedAt,
  subject: id,
  read: false,
  flagged: false,
  draft: false,
  categories: [],
  internetMessageId: null,
  raw,
  ...over,
});

/** A mailbox in memory, listed and fetched as Graph does: oldest first, from a received time, an offset passed. */
const fakeSource = (list: Fake[], account = "rik@rivi.media") => {
  const fetched: string[] = [];

  const source: MailSource = {
    account: () => Promise.resolve({ email: account, name: "Rik" }),
    folders: () => Promise.resolve(FOLDERS),
    messages: (after, skip, top) =>
      Promise.resolve(
        sorted(
          list,
          (a, b) =>
            a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id)
        )
          .filter((m) => !after || m.receivedAt >= after)
          .slice(skip, skip + top)
      ),
    mime: (id) => {
      fetched.push(id);
      const m = defined(list.find((x) => x.id === id));

      if (m.raw instanceof Error) {
        return Promise.reject(m.raw);
      }

      if (m.raw === "gone" || m.raw === "too-large") {
        return Promise.resolve(m.raw);
      }

      return Promise.resolve(new TextEncoder().encode(m.raw).buffer);
    },
  };

  return { source, fetched };
};

/** A message's bytes from `mime`, failing the test when the source answers "gone" or "too-large". */
const bytesOf = (mime: ArrayBuffer | string): ArrayBuffer => {
  if (mime instanceof ArrayBuffer) {
    return mime;
  }

  throw new TypeError(`The source answered ${mime}`);
};

const run = (source: MailSource, maxMessages = 500) =>
  runImports(env, db, {
    source: () => Promise.resolve(source),
    maxMessages,
    budgetMs: 20_000,
  });

describe("where an Outlook folder's mail goes", () => {
  it("keeps Inbox, Sent Items and Archive, labels the rest, and leaves the bin, junk and drafts behind", () => {
    expect(planFolders(FOLDERS)).toStrictEqual({
      "f-inbox": { path: "Inbox", kind: "inbox", label: null },
      "f-clients": { path: "Inbox/Clients", kind: "label", label: "Clients" },
      "f-acme": {
        path: "Inbox/Clients/Acme",
        kind: "label",
        label: "Clients/Acme",
      },
      "f-sent": { path: "Sent Items", kind: "sent", label: null },
      "f-archive": { path: "Archive", kind: "archive", label: null },
      "f-deleted": { path: "Deleted Items", kind: "skip", label: null },
      "f-old": { path: "Deleted Items/Old", kind: "skip", label: null },
      "f-junk": { path: "Junk Email", kind: "skip", label: null },
      "f-drafts": { path: "Drafts", kind: "skip", label: null },
      "f-projects": { path: "Projects", kind: "label", label: "Projects" },
    });
  });

  it("places a message by its folder and marks; a draft or one in the bin stays behind", () => {
    const plan = planFolders(FOLDERS);

    const m = message("x", "f-acme", "2024-01-01T00:00:00Z", "", {
      flagged: true,
      categories: ["Red category"],
    });

    expect(placementFor(m, plan)).toStrictEqual({
      folder: "archive",
      sent: false,
      read: false,
      starred: true,
      labels: ["Clients/Acme", "Red category"],
    });
    expect({
      placementFor: placementFor({ ...m, folderId: "f-sent" }, plan),
      placementFor2: placementFor({ ...m, folderId: "f-inbox" }, plan),
    }).toMatchObject({
      placementFor: {
        sent: true,
        read: true,
      },
      placementFor2: {
        folder: "inbox",
      },
    });
    expect({
      placementFor: placementFor({ ...m, folderId: "f-old" }, plan),
      placementFor2: placementFor(
        { ...m, folderId: "f-inbox", draft: true },
        plan
      ),
    }).toStrictEqual({ placementFor: null, placementFor2: null });
    // A folder made after the import started: the archive.
    expect(placementFor({ ...m, folderId: "f-new" }, plan)).toMatchObject({
      folder: "archive",
    });
  });
});

describe("importing a Microsoft 365 mailbox", () => {
  it("copies the mailbox oldest first, threaded and placed as Outlook had it", async () => {
    const observed: unknown[] = [];
    const observedSubsets: unknown[] = [];

    const user = await mailbox("imke", "Imke");
    // Already delivered here before the import: not copied twice.
    await ingestInboundEmail(
      env,
      null,
      mail({
        messageId: "<known@acme.com>",
        to: [{ email: user.email, name: null }],
      }),
      user.email
    );

    const { source, fetched } = fakeSource([
      message(
        "m1",
        "f-inbox",
        "2024-01-01T09:00:00Z",
        rawMail({
          from: '"Jane" <jane@acme.com>',
          to: "imke@rivi.media",
          subject: "Budget",
          messageId: "<a1@acme.com>",
          body: "Can we talk budget?",
          date: new Date("2024-01-01T09:00:00Z"),
        }),
        { internetMessageId: "<a1@acme.com>" }
      ),
      message(
        "m2",
        "f-sent",
        "2024-01-02T10:00:00Z",
        rawMail({
          from: '"Imke" <imke@rivi.media>',
          to: "jane@acme.com",
          subject: "Re: Budget",
          messageId: "<b2@rivi.media>",
          inReplyTo: "<a1@acme.com>",
          body: "Sure, Tuesday.",
          date: new Date("2024-01-02T10:00:00Z"),
        }),
        { internetMessageId: "<b2@rivi.media>", read: true }
      ),
      message(
        "m3",
        "f-acme",
        "2024-02-01T08:00:00Z",
        rawMail({
          from: "ops@acme.com",
          to: "imke@rivi.media",
          subject: "Invoice",
          messageId: "<c3@acme.com>",
          date: new Date("2024-02-01T08:00:00Z"),
        }),
        {
          internetMessageId: "<c3@acme.com>",
          read: true,
          flagged: true,
          categories: ["Red category"],
        }
      ),
      message(
        "m4",
        "f-deleted",
        "2024-02-02T08:00:00Z",
        rawMail({ subject: "Binned" })
      ),
      message(
        "m5",
        "f-drafts",
        "2024-02-03T08:00:00Z",
        rawMail({ subject: "Half" }),
        {
          draft: true,
        }
      ),
      message("m6", "f-archive", "2024-02-04T08:00:00Z", "too-large", {
        subject: "Huge scan",
      }),
      message(
        "m7",
        "f-archive",
        "2024-02-05T08:00:00Z",
        rawMail({ messageId: "<known@acme.com>" }),
        {
          internetMessageId: "<known@acme.com>",
        }
      ),
      message("m8", "f-projects", "2024-02-06T08:00:00Z", "gone"),
    ]);

    const started = await startImport(env, db, user, tokens, source);
    observedSubsets.push(started);
    observed.push(
      await openSecret(env, "mail-import-tokens", started.tokensSealed),
      (await rejection(startImport(env, db, user, tokens, source))) instanceof
        ImportError
    );

    observedSubsets.push(await run(source));
    // The bin, the draft and the known message were never fetched.
    observed.push(fetched);
    const done = defined(await latestImport(db, user.id));
    observedSubsets.push(done);
    observed.push(JSON.parse(done.leftOutJson));

    // The reply from Sent Items is the owner's, in the same conversation, which is in the inbox.
    const [budget] = await listThreads(db, user.id, {
      folder: "inbox",
      q: "subject:Budget",
    });

    const conversation = defined(
      await loadThread(db, env, user.id, defined(budget).id)
    );

    observedSubsets.push(conversation.thread);
    observed.push(conversation.messages);

    // The folder and the category became labels; the flag a star; the folder's mail is archived.
    const [invoice] = await listThreads(db, user.id, { folder: "starred" });
    observedSubsets.push(invoice);

    const invoiceThread = defined(
      await loadThread(db, env, user.id, defined(invoice).id)
    );

    observed.push(sorted(invoiceThread.labels.map((l) => l.name)));

    expect(observed).toStrictEqual([
      // openSecret(env, "mail-import-tokens", started.tokensSealed)
      JSON.stringify(tokens),
      // (await rejection(startImport(env, db, user, tokens, source))) instanceof ImportError
      true,
      // fetched
      ["m1", "m2", "m3", "m6", "m8"],
      // JSON.parse(done.leftOutJson)
      [
        {
          subject: "Huge scan",
          date: "2024-02-04T08:00:00Z",
          reason: "larger than 25 MB",
        },
      ],
      // conversation.messages
      [
        expect.objectContaining({
          messageId: "<a1@acme.com>",
          direction: "inbound",
          read: false,
          date: "2024-01-01T09:00:00.000Z",
          hasRaw: true,
        }),
        expect.objectContaining({
          messageId: "<b2@rivi.media>",
          direction: "outbound",
          deliveryStatus: "sent",
          read: true,
          hasRaw: true,
        }),
      ],
      // invoiceThread.labels.map((l) => l.name).sort()
      ["Clients/Acme", "Red category"],
    ]);

    // Run again: the import is over, nothing more happens.
    observedSubsets.push(await run(source));

    expect(observedSubsets).toMatchObject([
      // started
      {
        status: "running",
        account: "rik@rivi.media",
        total: 8,
      },
      // run(source)
      {
        batches: 1,
        imported: 3,
      },
      // done
      {
        status: "done",
        imported: 3,
        duplicates: 1,
        leftOut: 1,
        tokensSealed: null,
        leaseUntil: null,
      },
      // conversation.thread
      {
        folder: "inbox",
        messageCount: 2,
        sentCount: 1,
        unreadCount: 1,
        lastMessageAt: "2024-01-02T10:00:00.000Z",
      },
      // invoice
      {
        subject: "Invoice",
        folder: "archive",
        unreadCount: 0,
      },
      // run(source)
      { batches: 0 },
    ]);
  });

  it("adds only what is new when the same mailbox is imported again", async () => {
    const user = await mailbox("jorn");

    const list = [
      message(
        "n1",
        "f-inbox",
        "2024-03-01T09:00:00Z",
        rawMail({ messageId: "<n1@x.com>", subject: "One" }),
        {
          internetMessageId: "<n1@x.com>",
        }
      ),
    ];

    const first = fakeSource(list);
    await startImport(env, db, user, tokens, first.source);
    await run(first.source);
    list.push(
      message(
        "n2",
        "f-inbox",
        "2024-03-02T09:00:00Z",
        rawMail({ messageId: "<n2@x.com>", subject: "Two" }),
        {
          internetMessageId: "<n2@x.com>",
        }
      )
    );
    const second = fakeSource(list);
    await startImport(env, db, user, tokens, second.source);
    await run(second.source);
    expect(second.fetched).toStrictEqual(["n2"]);
    await expect(latestImport(db, user.id)).resolves.toMatchObject({
      imported: 1,
      duplicates: 1,
    });
  });

  it("gets through more messages at one moment than a page holds", async () => {
    const user = await mailbox("kees");
    const at = "2024-04-01T12:00:00Z";

    const list = Array.from({ length: 60 }, (_, i) =>
      message(
        `t${String(i).padStart(2, "0")}`,
        "f-archive",
        at,
        rawMail({ messageId: `<t${i}@x.com>` })
      )
    );

    const { source, fetched } = fakeSource(list);
    await startImport(env, db, user, tokens, source);
    // Two batches of 40: the cursor holds its place inside the one moment.
    await run(source, 40);
    expect(fetched).toHaveLength(40);
    await run(source, 40);
    expect(new Set(fetched).size).toBe(60);
    await expect(latestImport(db, user.id)).resolves.toMatchObject({
      status: "done",
      imported: 60,
    });
  });

  it("stops for good when Microsoft refuses, and waits when it asks for a pause", async () => {
    const refused = await mailbox("lot");
    const { source } = fakeSource([]);
    await startImport(env, db, refused, tokens, source);
    await run({
      ...source,
      messages: () =>
        Promise.reject(
          new MicrosoftAuthError(
            "Microsoft refused access to the mailbox: token expired"
          )
        ),
    });
    await expect(latestImport(db, refused.id)).resolves.toMatchObject({
      status: "failed",
      lastError: "Microsoft refused access to the mailbox: token expired",
      tokensSealed: null,
    });

    const paused = await mailbox("maud");
    await startImport(env, db, paused, tokens, source);
    await run({
      ...source,
      messages: () =>
        Promise.reject(new GraphError("Too many requests", 429, 120)),
    });
    const row = defined(await latestImport(db, paused.id));
    expect(row).toMatchObject({
      status: "running",
      lastError: "Too many requests",
    });
    expect(Date.parse(defined(row.leaseUntil))).toBeGreaterThan(
      Date.now() + 100_000
    );
  });

  it("tries a message that fails a few times, then leaves it out and goes on", async () => {
    const user = await mailbox("noor");

    const { source } = fakeSource([
      message(
        "bad",
        "f-inbox",
        "2024-05-01T00:00:00Z",
        new Error("D1 hiccup"),
        {
          subject: "Bad one",
        }
      ),
      message(
        "good",
        "f-inbox",
        "2024-05-02T00:00:00Z",
        rawMail({ messageId: "<good@x.com>" })
      ),
    ]);

    const started = await startImport(env, db, user, tokens, source);

    const failOnce = async (i: number) => {
      await run(source);
      await expect(latestImport(db, user.id)).resolves.toMatchObject({
        imported: 0,
        attempts: i + 1,
        lastError: "D1 hiccup",
      });
      // The batch let go of the import: the next minute picks it up.
      await db
        .update(mailImports)
        .set({ leaseUntil: null })
        .where(eq(mailImports.id, started.id));
    };

    for (let i = 0; i < 2; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each run counts an attempt on the import's row, which the next run reads
      await failOnce(i);
    }

    await run(source);
    const row = defined(await latestImport(db, user.id));
    expect(row).toMatchObject({
      status: "done",
      imported: 1,
      leftOut: 1,
      attempts: 0,
    });
    expect(JSON.parse(row.leftOutJson)).toMatchObject([
      { subject: "Bad one", reason: "could not be copied" },
    ]);
  });

  it("stops when cancelled, keeping what it copied", async () => {
    const user = await mailbox("olaf");
    const { source } = fakeSource([]);
    const started = await startImport(env, db, user, tokens, source);
    await expect(
      cancelImport(db, "someone-else", started.id)
    ).resolves.toBeFalsy();
    await expect(cancelImport(db, user.id, started.id)).resolves.toBeTruthy();
    await expect(latestImport(db, user.id)).resolves.toMatchObject({
      status: "cancelled",
      tokensSealed: null,
    });
    await expect(cancelImport(db, user.id, started.id)).resolves.toBeFalsy();
  });
});

describe("the connection's secrets", () => {
  it("opens only what was sealed for the same purpose under the same secret", async () => {
    const sealed = await sealSecret(env, "mail-import-tokens", "refresh-me");
    expect(sealed).not.toContain("refresh-me");
    await expect(openSecret(env, "mail-import-tokens", sealed)).resolves.toBe(
      "refresh-me"
    );
    await expect(openSecret(env, "something-else", sealed)).resolves.toBeNull();
    await expect(
      openSecret(
        { ...env, SESSION_SECRET: "rotated" },
        "mail-import-tokens",
        sealed
      )
    ).resolves.toBeNull();
    await expect(
      openSecret(env, "mail-import-tokens", "v1.garbage")
    ).resolves.toBeNull();
  });
});

/** A Graph that answers from a table of paths, and records what was asked. */
const fakeGraph = (answers: Record<string, () => Response>) => {
  const asked: { url: string; auth: string | null }[] = [];

  const fetcher: typeof fetch = (input, init) => {
    const url = String(input);
    asked.push({
      url,
      auth: new Headers(init?.headers).get("authorization"),
    });
    const path = url.replace("https://graph.microsoft.com/v1.0", "");
    const key = Object.keys(answers).find((k) => path.startsWith(k));

    return Promise.resolve(
      key
        ? answers[key]()
        : Response.json({ error: { message: "Not found" } }, { status: 404 })
    );
  };

  return { asked, fetcher };
};

describe("Microsoft Graph", () => {
  it("lists the folders with their paths and which well-known folder each is", async () => {
    const { fetcher } = fakeGraph({
      "/me/mailFolders/inbox?": () => Response.json({ id: "A" }),
      "/me/mailFolders/sentitems?": () => Response.json({ id: "B" }),
      "/me/mailFolders?": () =>
        Response.json({
          value: [
            {
              id: "A",
              displayName: "Inbox",
              childFolderCount: 1,
              totalItemCount: 5,
            },
            {
              id: "B",
              displayName: "Sent Items",
              childFolderCount: 0,
              totalItemCount: 2,
            },
          ],
        }),
      "/me/mailFolders/A/childFolders?": () =>
        Response.json({
          value: [
            {
              id: "C",
              displayName: "Clients",
              childFolderCount: 0,
              totalItemCount: 1,
            },
          ],
        }),
    });

    const folders = await graphMailSource(
      () => Promise.resolve("token"),
      fetcher
    ).folders();

    expect(folders).toStrictEqual([
      {
        id: "A",
        name: "Inbox",
        path: "Inbox",
        parentId: null,
        total: 5,
        wellKnown: "inbox",
      },
      {
        id: "C",
        name: "Clients",
        path: "Inbox/Clients",
        parentId: "A",
        total: 1,
        wellKnown: null,
      },
      {
        id: "B",
        name: "Sent Items",
        path: "Sent Items",
        parentId: null,
        total: 2,
        wellKnown: "sentitems",
      },
    ]);
  });

  it("lists messages oldest first from a received time, and stops at a message too large", async () => {
    const { asked, fetcher } = fakeGraph({
      "/me/messages?": () =>
        Response.json({
          value: [
            {
              id: "m1",
              parentFolderId: "A",
              receivedDateTime: "2024-01-01T00:00:00Z",
              subject: "Hi",
              isRead: true,
              isDraft: false,
              flag: { flagStatus: "flagged" },
              categories: ["Blue"],
              internetMessageId: "<m1@x>",
            },
          ],
        }),
      "/me/messages/big/$value": () =>
        new Response("x".repeat(10), {
          headers: { "content-length": "999999999" },
        }),
      "/me/messages/m1/$value": () => new Response("Subject: Hi\r\n\r\nBody"),
    });

    const source = graphMailSource(() => Promise.resolve("token-1"), fetcher);
    expect({
      "2024-01-01T00:00:00Z": await source.messages(
        "2024-01-01T00:00:00Z",
        50,
        50
      ),
      auth: asked[0].auth,
      url: asked[0].url.includes("$orderby=receivedDateTime%20asc"),
      url2: asked[0].url.includes(
        "$filter=receivedDateTime%20ge%202024-01-01T00%3A00%3A00Z"
      ),
      url3: asked[0].url.includes("$skip=50"),
      big: await source.mime("big", 1000),
      gone: await source.mime("gone", 1000),
      decode: new TextDecoder().decode(bytesOf(await source.mime("m1", 1000))),
    }).toStrictEqual({
      "2024-01-01T00:00:00Z": [
        {
          id: "m1",
          folderId: "A",
          receivedAt: "2024-01-01T00:00:00Z",
          subject: "Hi",
          read: true,
          flagged: true,
          draft: false,
          categories: ["Blue"],
          internetMessageId: "<m1@x>",
        },
      ],
      auth: "Bearer token-1",
      url: true,
      url2: true,
      url3: true,
      big: "too-large",
      gone: "gone",
      decode: "Subject: Hi\r\n\r\nBody",
    });
  });

  it("tells a refused connection from a busy Microsoft", async () => {
    const refused = graphMailSource(
      () => Promise.resolve("t"),
      fakeGraph({
        "/me?": () =>
          Response.json(
            { error: { message: "Token expired" } },
            { status: 401 }
          ),
      }).fetcher
    );

    await expect(refused.account()).rejects.toThrow(MicrosoftAuthError);

    const busy = graphMailSource(
      () => Promise.resolve("t"),
      fakeGraph({
        "/me/messages?": () =>
          Response.json(
            { error: { message: "Slow down" } },
            { status: 429, headers: { "retry-after": "30" } }
          ),
      }).fetcher
    );

    await expect(busy.messages(null, 0, 50)).rejects.toMatchObject({
      status: 429,
      retryAfter: 30,
    });
  });
});

const signedIn = async (local: string) => {
  const user = await mailbox(local);

  return { user, cookie: await sessionFor(user) };
};

const req = (path: string, cookie: string) =>
  new Request(`${env.APP_URL}${path}`, {
    headers: { cookie },
  });

describe("connecting a Microsoft 365 mailbox", () => {
  const msEnv: Env = {
    ...env,
    APP_URL: env.APP_URL,
    MICROSOFT_CLIENT_ID: "client-1",
    MICROSOFT_CLIENT_SECRET: "secret-1",
    MICROSOFT_TENANT_ID: "tenant-1",
  };

  it("sends the person to Microsoft, and starts the import when they come back with a code", async () => {
    const observed: unknown[] = [];

    const { user, cookie } = await signedIn("pia");

    const start = await startMicrosoftConnect(
      req("/api/import/microsoft/start", cookie),
      msEnv,
      db
    );

    observed.push(start.status);
    const to = new URL(defined(start.headers.get("location")));
    observed.push(`${to.origin}${to.pathname}`);
    expect(Object.fromEntries(to.searchParams)).toMatchObject({
      client_id: "client-1",
      redirect_uri: `${env.APP_URL}/api/import/microsoft/callback`,
      scope: "offline_access User.Read Mail.Read",
      code_challenge_method: "S256",
    });
    const tx = defined(start.headers.get("set-cookie"));
    observed.push(
      /^workspace_ms_import=.+; Path=\/api\/import\/microsoft; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/u.test(
        tx
      )
    );
    const both = `${cookie}; ${tx.split(";")[0]}`;
    const state = defined(to.searchParams.get("state"));

    // Someone else's link, or a wrong state: nothing happens.
    const stranger = await signedIn("quint");

    const wrong = await finishMicrosoftConnect(
      req(
        `/api/import/microsoft/callback?code=c&state=${state}`,
        `${stranger.cookie}; ${tx.split(";")[0]}`
      ),
      msEnv,
      db
    );

    observed.push(wrong.headers.get("location"));

    const declined = await finishMicrosoftConnect(
      req(
        `/api/import/microsoft/callback?error=access_denied&error_description=The+user+declined&state=${state}`,
        both
      ),
      msEnv,
      db
    );

    observed.push(declined.headers.get("location"));

    const tokenCalls: URLSearchParams[] = [];

    const fetcher: typeof fetch = (_url, init) => {
      tokenCalls.push(new URLSearchParams(String(init?.body)));

      return Promise.resolve(
        Response.json({
          access_token: "at-1",
          refresh_token: "rt-1",
          expires_in: 3600,
        })
      );
    };

    const done = await finishMicrosoftConnect(
      req(`/api/import/microsoft/callback?code=the-code&state=${state}`, both),
      msEnv,
      db,
      { fetch: fetcher, source: () => fakeSource([]).source }
    );

    observed.push(
      done.headers.get("location"),
      done.headers
        .get("set-cookie")
        ?.includes("workspace_ms_import=; Path=/api/import/microsoft")
    );
    expect(Object.fromEntries(tokenCalls[0])).toMatchObject({
      grant_type: "authorization_code",
      code: "the-code",
      client_secret: "secret-1",
      redirect_uri: `${env.APP_URL}/api/import/microsoft/callback`,
    });
    observed.push(Boolean(tokenCalls[0].get("code_verifier")));

    expect(observed).toStrictEqual([
      // start.status
      302,
      // `${to.origin}${to.pathname}`
      "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/authorize",
      // /^workspace_ms_import=.+; Path=\/api\/import\/microsoft; HttpOnly; SameSite=Lax; Max-Ag...
      true,
      // wrong.headers.get("location")
      "/settings?tab=mail&connect=expired",
      // declined.headers.get("location")
      "/settings?tab=mail&connect=declined&reason=The+user+declined",
      // done.headers.get("location")
      "/settings?tab=mail&connect=started",
      // done.headers.get("set-cookie").includes("workspace_ms_import=; Path=/api/import/microso...
      true,
      // Boolean(tokenCalls[0].get("code_verifier"))
      true,
    ]);
    await expect(latestImport(db, user.id)).resolves.toMatchObject({
      status: "running",
      account: "rik@rivi.media",
    });
  });

  it("says so when Workspace is not registered with Microsoft", async () => {
    const { cookie } = await signedIn("rob");

    const res = await startMicrosoftConnect(
      req("/api/import/microsoft/start", cookie),
      env,
      db
    );

    expect(res.headers.get("location")).toBe(
      "/settings?tab=mail&connect=unavailable"
    );
  });
});
