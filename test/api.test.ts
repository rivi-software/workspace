import { SELF } from "cloudflare:test";
// The Workspace API for native clients (#3569, docs/API.md): the app on a phone signs in with the person's password
// through Better Auth (`POST /api/auth/sign-in/email`), keeps the session token it answers, and reads and changes
// the person's mail, files, calendar, tasks and conversations with the Assistant over `/api/v1` with it as a bearer
// token.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import type { User } from "~/db/schema";
import { revoke } from "~/lib/auth.server";
import { isJsonObject, stringOrNull } from "~/lib/guards";
import { ingestInboundEmail } from "~/lib/mail/ingest.server";
import { addDraftFiles } from "~/lib/mail/send.server";

import { createWorker } from "../workers/worker";
import {
  PASSWORD,
  db,
  defined,
  mail,
  mailbox,
  recordingEmail,
} from "./fixtures";
import type { Json } from "./fixtures";

const issuer = env.APP_URL.replace(/\/+$/u, "");
const api = `${issuer}/api/v1`;

/** A JSON value's object, or an empty one; its members are read by name. */
const obj = (value: Json | undefined): { [key: string]: Json } =>
  isJsonObject(value) && !Array.isArray(value) ? value : {};

/** A JSON value's list, or an empty one. */
const list = (value: Json | undefined): Json[] =>
  Array.isArray(value) ? value : [];

const str = (value: Json | undefined): string => stringOrNull(value) ?? "";

/**
 * The app's sign-in: the person's password, posted as JSON to Better Auth from the workspace's own origin, answers the
 * session token in the `set-auth-token` header (the `bearer` plugin), which every call then carries.
 */
const signInAsApp = async (user: User): Promise<string> => {
  const res = await SELF.fetch(`${issuer}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      origin: new URL(env.APP_URL).origin,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email: user.email, password: PASSWORD }),
  });

  expect(res.status).toBe(200);

  return defined(res.headers.get("set-auth-token"), `token for ${user.email}`);
};

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** A call of the API with the token, JSON in and out. */
const call = async (
  token: string,
  method: string,
  path: string,
  body?: Json,
  fetchFn: typeof fetch = (input, init) => SELF.fetch(input, init)
) => {
  const headers: Record<string, string> = bearer(token);

  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }

  const res = await fetchFn(`${api}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const type = res.headers.get("content-type") ?? "";

  const data: Json = type.includes("application/json")
    ? await res.json()
    : null;

  return { res, status: res.status, data: obj(data) };
};

/** The Worker with the recording mail binding, so a send never reaches Email Service. */
const workerWithMail = () => {
  const recording = recordingEmail();
  const worker = createWorker(() => new Response("no start", { status: 404 }));

  const fetchFn: typeof fetch = (input, init) =>
    worker.fetch(
      // SAFETY: nothing in the Worker reads `request.cf`; a plain Request stands in for Workers' own.
      new Request(input, init) as Request<unknown, IncomingRequestCfProperties>,
      recording.env
    );

  return { fetchFn, sent: recording.sent };
};

/** The ids of the rows a list answer holds. */
const names = (rows: Json | undefined, key = "name"): Json[] =>
  list(rows).map((row) => obj(row)[key] ?? null);

describe("the Workspace API", () => {
  let user: User;
  let token: string;

  beforeAll(async () => {
    user = await mailbox("phone", "Pia Phone");
    token = await signInAsApp(user);
  });

  it("answers the person, and refuses a request without a token or with a bad one", async () => {
    const me = await call(token, "GET", "/me");

    expect(me.data).toMatchObject({
      user: { id: user.id, name: "Pia Phone", email: user.email },
      appName: env.APP_NAME,
      counts: { inboxUnread: 0 },
      labels: [],
      preferences: { pageSize: 50 },
      github: { connected: false },
      suggestions: [
        "What arrived in my inbox today?",
        "Summarize my unread conversations",
        "Which files did I work on last?",
        "Help me write an email",
      ],
    });

    const none = await SELF.fetch(`${api}/me`);
    const bad = await call("wsa_nothing", "GET", "/me");
    const missing = await call(token, "GET", "/nowhere");
    const method = await call(token, "DELETE", "/me");

    expect({
      me: [me.status, me.res.headers.get("cache-control")],
      none: [none.status, none.headers.get("www-authenticate")],
      bad: [bad.status, bad.res.headers.get("www-authenticate")],
      missing: [missing.status, missing.data],
      method: method.status,
    }).toStrictEqual({
      me: [200, "no-store"],
      none: [401, 'Bearer realm="Workspace API"'],
      bad: [401, 'Bearer error="invalid_token"'],
      missing: [404, { ok: false, error: "No such endpoint." }],
      method: 405,
    });
  });

  it("lists, reads and acts on mail", async () => {
    const arrived = await ingestInboundEmail(
      env,
      null,
      mail({
        subject: "Invoice 42",
        text: "Please find the invoice attached.",
        html: '<p>Please find the <b>invoice</b> attached.</p><img src="https://acme.com/pixel.gif">',
        to: [{ email: user.email, name: null }],
      }),
      user.email
    );

    if (arrived.status !== "stored") {
      throw new Error("not stored");
    }

    const inbox = await call(token, "GET", "/mail/threads?folder=inbox");
    const found = await call(token, "GET", "/mail/threads?q=invoice");
    const missed = await call(token, "GET", "/mail/threads?q=sushi");

    const thread = await call(
      token,
      "GET",
      `/mail/threads/${arrived.threadId}`
    );

    const message = obj(list(thread.data.messages)[0]);
    const read = await call(token, "GET", "/me");

    expect({
      inbox: inbox.data,
      counts: [found.data.total, missed.data.total],
      thread: thread.data,
      unreadAfter: obj(read.data.counts).inboxUnread,
    }).toMatchObject({
      inbox: {
        folder: "inbox",
        page: 1,
        total: 1,
        threads: [
          {
            id: arrived.threadId,
            subject: "Invoice 42",
            people: "Jane Doe",
            unread: true,
            starred: false,
            count: 1,
          },
        ],
      },
      counts: [1, 0],
      thread: {
        thread: { id: arrived.threadId, subject: "Invoice 42", unreadCount: 0 },
        messages: [
          {
            direction: "inbound",
            from: { email: "jane@acme.com", name: "Jane Doe" },
            text: "Please find the invoice attached.",
            hasHtml: true,
            remoteImages: true,
            attachments: [],
          },
        ],
      },
      unreadAfter: 0,
    });

    const document = await SELF.fetch(
      `${api}/mail/messages/${str(message.id)}/document?appearance=dark`,
      { headers: bearer(token) }
    );

    const html = await document.text();

    const noDocument = await SELF.fetch(
      `${api}/mail/messages/nothing/document`,
      { headers: bearer(token) }
    );

    expect({
      status: document.status,
      type: document.headers.get("content-type"),
      csp: document.headers.get("content-security-policy"),
      remote: document.headers.get("x-remote-images"),
      dark: html.includes("color-scheme:dark"),
      body: html.includes("<b>invoice</b>"),
      meta: html.includes('http-equiv="Content-Security-Policy"'),
      viewport: html.includes('name="viewport"'),
      noDocument: noDocument.status,
    }).toStrictEqual({
      status: 200,
      type: "text/html; charset=utf-8",
      csp: "script-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
      remote: "1",
      dark: true,
      body: true,
      meta: true,
      viewport: true,
      noDocument: 404,
    });

    const starred = await call(token, "POST", "/mail/threads/actions", {
      ids: [arrived.threadId],
      intent: "star",
    });

    const inStarred = await call(token, "GET", "/mail/threads?folder=starred");

    const undone = await call(token, "POST", "/mail/undo", {
      undo: starred.data.undo ?? null,
    });

    const afterUndo = await call(token, "GET", "/mail/threads?folder=starred");

    const unknown = await call(token, "POST", "/mail/threads/actions", {
      ids: [arrived.threadId],
      intent: "fly",
    });

    const noIds = await call(token, "POST", "/mail/threads/actions", {
      intent: "star",
    });

    const notJson = await SELF.fetch(`${api}/mail/undo`, {
      method: "POST",
      headers: bearer(token),
      body: "undo=x",
    });

    expect({
      starred: {
        ...starred.data,
        undo: stringOrNull(starred.data.undo) !== null,
      },
      inStarred: inStarred.data.total,
      undone: undone.data,
      afterUndo: afterUndo.data.total,
      unknown: unknown.status,
      noIds: noIds.data,
      notJson: notJson.status,
    }).toStrictEqual({
      starred: { ok: true, intent: "star", count: 1, undo: true },
      inStarred: 1,
      undone: { ok: true },
      afterUndo: 0,
      unknown: 400,
      noIds: { ok: false, error: "Name the conversations." },
      notJson: 415,
    });

    const label = await call(token, "POST", "/mail/labels", {
      name: "Finance",
      color: "green",
    });

    const labelId = str(obj(label.data.label).id);

    await call(token, "POST", "/mail/threads/actions", {
      ids: [arrived.threadId],
      intent: "label",
      labelId,
    });

    const labelled = await call(token, "GET", `/mail/threads?label=${labelId}`);

    await call(token, "POST", "/mail/threads/actions", {
      ids: [arrived.threadId],
      intent: "unread",
    });

    const readAll = await call(token, "POST", "/mail/read-all", {
      folder: "inbox",
    });

    await call(token, "POST", "/mail/threads/actions", {
      ids: [arrived.threadId],
      intent: "trash",
    });

    const emptied = await call(token, "POST", "/mail/folders/trash/empty");
    const notAFolder = await call(token, "POST", "/mail/folders/inbox/empty");
    const gone = await call(token, "GET", `/mail/threads/${arrived.threadId}`);

    expect({
      label: label.data,
      labelled: { total: labelled.data.total, label: labelled.data.label },
      readAll: readAll.data,
      emptied: emptied.data,
      notAFolder: notAFolder.status,
      gone: gone.status,
    }).toMatchObject({
      label: { ok: true, label: { name: "Finance", color: "green" } },
      labelled: { total: 1, label: { name: "Finance" } },
      readAll: { ok: true, count: 1 },
      emptied: { ok: true, count: 1 },
      notAFolder: 400,
      gone: 404,
    });
  });

  it("starts a reply from the original, sends it with a file, and keeps drafts", async () => {
    const arrived = await ingestInboundEmail(
      env,
      null,
      mail({
        subject: "Quote",
        text: "How much for ten?",
        from: { email: "sam@acme.com", name: "Sam Buyer" },
        to: [{ email: user.email, name: null }],
      }),
      user.email
    );

    if (arrived.status !== "stored") {
      throw new Error("not stored");
    }

    const compose = await call(
      token,
      "GET",
      `/mail/compose?reply=${arrived.messageId}&mode=reply`
    );

    const contacts = await call(token, "GET", "/mail/contacts?q=sam");

    expect({
      compose: compose.data,
      quote: str(obj(compose.data.prefill).text).includes("> How much"),
      contacts: contacts.data,
    }).toMatchObject({
      compose: {
        froms: [{ email: user.email }],
        prefill: {
          mode: "reply",
          to: "Sam Buyer <sam@acme.com>",
          subject: "Re: Quote",
          inReplyToId: arrived.messageId,
        },
      },
      quote: true,
      contacts: { contacts: [{ email: "sam@acme.com", name: "Sam Buyer" }] },
    });

    // Sending goes through the recording binding, never Email Service: the Worker takes that env.
    const { fetchFn, sent: outbox } = workerWithMail();

    const sent = await call(
      token,
      "POST",
      "/mail/send",
      {
        to: "Sam Buyer <sam@acme.com>",
        cc: "",
        bcc: "",
        subject: "",
        text: "Two hundred.",
        inReplyToId: arrived.messageId,
        files: [
          {
            filename: "note.txt",
            contentType: "text/plain",
            base64: btoa("hello"),
          },
        ],
      },
      fetchFn
    );

    const replied = await call(
      token,
      "GET",
      `/mail/threads/${arrived.threadId}`
    );

    const last = obj(list(replied.data.messages).at(-1));

    const badAddress = await call(
      token,
      "POST",
      "/mail/send",
      { to: "nobody", text: "x" },
      fetchFn
    );

    const notMine = await call(
      token,
      "POST",
      "/mail/send",
      { from: "other@acme.com", to: "sam@acme.com", text: "x" },
      fetchFn
    );

    expect({
      sent: sent.data,
      outbox: outbox.length,
      last,
      fileLink: str(obj(list(last.attachments)[0]).url).includes("/api/files/"),
      badAddress: badAddress.data,
      notMine: notMine.data,
    }).toMatchObject({
      sent: { ok: true, threadId: arrived.threadId },
      outbox: 1,
      last: {
        direction: "outbound",
        subject: "Re: Quote",
        attachments: [
          { filename: "note.txt", contentType: "text/plain", size: 5 },
        ],
      },
      fileLink: true,
      badAddress: { ok: false, error: "Check these addresses: nobody" },
      notMine: { ok: false, error: "You cannot send as other@acme.com." },
    });

    const draft = await call(token, "POST", "/mail/drafts", {
      mode: "new",
      to: "sam@acme.com",
      subject: "Later",
      text: "Not yet.",
    });

    const drafts = await call(token, "GET", "/mail/threads?folder=drafts");

    const dropped = await call(
      token,
      "DELETE",
      `/mail/drafts/${str(draft.data.draftId)}`
    );

    const noDrafts = await call(token, "GET", "/mail/threads?folder=drafts");

    // A draft the console saved with a file, sent from the phone: the file goes with the message.
    const kept = await call(token, "POST", "/mail/drafts", {
      mode: "new",
      to: "sam@acme.com",
      subject: "With the plan",
      text: "Here it is.",
    });

    const keptId = str(kept.data.draftId);

    const planBytes = new TextEncoder().encode("the plan");
    const plan = new ArrayBuffer(planBytes.byteLength);
    new Uint8Array(plan).set(planBytes);

    await addDraftFiles(db, env, user.id, keptId, [
      { filename: "plan.txt", contentType: "text/plain", content: plan },
    ]);

    const prefilled = await call(token, "GET", `/mail/compose?draft=${keptId}`);

    const sentDraft = await call(
      token,
      "POST",
      "/mail/send",
      {
        to: "sam@acme.com",
        subject: "With the plan",
        text: "Here it is.",
        draftId: keptId,
      },
      fetchFn
    );

    const withPlan = await call(
      token,
      "GET",
      `/mail/threads/${str(sentDraft.data.threadId)}`
    );

    const draftsAfter = await call(token, "GET", "/mail/threads?folder=drafts");

    expect({
      draft: draft.data.ok,
      drafts: drafts.data,
      dropped: dropped.data,
      noDrafts: noDrafts.data.total,
      prefilledFiles: names(obj(prefilled.data.prefill).files, "filename"),
      sentDraft: sentDraft.data.ok,
      sentFiles: names(
        obj(list(withPlan.data.messages)[0]).attachments,
        "filename"
      ),
      draftsAfter: draftsAfter.data.total,
    }).toMatchObject({
      draft: true,
      drafts: {
        folder: "drafts",
        total: 1,
        drafts: [{ id: draft.data.draftId, subject: "Later", to: "sam" }],
      },
      dropped: { ok: true },
      noDrafts: 0,
      prefilledFiles: ["plan.txt"],
      sentDraft: true,
      sentFiles: ["plan.txt"],
      draftsAfter: 0,
    });
  });

  it("browses, uploads, changes and serves files in Drive", async () => {
    const uploaded = await SELF.fetch(`${api}/drive/upload?name=notes.txt`, {
      method: "PUT",
      headers: {
        ...bearer(token),
        "content-type": "text/plain",
        "content-length": "11",
      },
      body: "hello drive",
    });

    const uploadedData: Json = await uploaded.json();
    const fileId = str(obj(obj(uploadedData).node).id);

    const folder = await call(token, "POST", "/drive/folders", {
      parentId: null,
      name: "Reports",
    });

    const folderId = str(obj(folder.data.node).id);
    const root = await call(token, "GET", "/drive");

    const moved = await call(token, "POST", "/drive/nodes/move", {
      ids: [fileId],
      targetId: folderId,
    });

    const inside = await call(token, "GET", `/drive?folder=${folderId}`);

    expect({
      uploaded: [uploaded.status, obj(uploadedData)],
      folder: folder.data,
      root: { ...root.data, rows: names(root.data.rows) },
      moved: moved.data,
      inside: inside.data,
    }).toMatchObject({
      // The whole row, as the app decodes it (docs/API.md `DriveRow`).
      uploaded: [
        200,
        {
          ok: true,
          node: {
            name: "notes.txt",
            size: 11,
            kind: "file",
            role: "owner",
            starred: false,
            parentId: null,
          },
        },
      ],
      folder: {
        ok: true,
        node: {
          kind: "folder",
          name: "Reports",
          role: "owner",
          starred: false,
        },
      },
      root: {
        view: "mine",
        folder: null,
        canWrite: true,
        used: 11,
        rows: ["Reports", "notes.txt"],
      },
      moved: { ok: true, count: 1 },
      inside: {
        folder: { id: folderId, name: "Reports" },
        // The crumbs are the folder's ancestors: none for one at the root.
        crumbs: [],
        rows: [{ id: fileId, parentId: folderId }],
      },
    });

    const renamed = await call(token, "POST", `/drive/nodes/${fileId}/rename`, {
      name: "minutes.txt",
    });

    const starred = await call(token, "POST", "/drive/nodes/star", {
      ids: [fileId],
      on: true,
    });

    const details = await call(token, "GET", `/drive/nodes/${fileId}`);
    const found = await call(token, "GET", "/drive?q=minutes");
    const starredView = await call(token, "GET", "/drive?view=starred");

    expect({
      renamed: renamed.data,
      starred: starred.data,
      details: details.data,
      found: names(found.data.rows),
      starredView: names(starredView.data.rows),
    }).toMatchObject({
      renamed: { ok: true, node: { name: "minutes.txt" } },
      starred: { ok: true, count: 1 },
      details: {
        node: { name: "minutes.txt", starred: true, parentId: folderId },
        crumbs: [{ name: "Reports" }],
        preview: "text",
        shares: [],
      },
      found: ["minutes.txt"],
      starredView: ["minutes.txt"],
    });

    const bytes = await SELF.fetch(`${api}/drive/files/${fileId}`, {
      headers: bearer(token),
    });

    const download = await SELF.fetch(
      `${api}/drive/files/${fileId}?download=1`,
      {
        headers: bearer(token),
      }
    );

    expect({
      status: bytes.status,
      text: await bytes.text(),
      type: bytes.headers.get("content-type"),
      disposition: download.headers.get("content-disposition"),
    }).toStrictEqual({
      status: 200,
      text: "hello drive",
      type: "text/plain",
      disposition: `attachment; filename="minutes.txt"; filename*=UTF-8''minutes.txt`,
    });

    const trashed = await call(token, "POST", "/drive/nodes/trash", {
      ids: [fileId],
    });

    const inTrash = await call(token, "GET", "/drive?view=trash");

    const restored = await call(token, "POST", "/drive/nodes/restore", {
      ids: [fileId],
    });

    await call(token, "POST", "/drive/nodes/trash", { ids: [fileId] });

    const deleted = await call(token, "POST", "/drive/nodes/delete", {
      ids: [fileId],
    });

    const goneFile = await SELF.fetch(`${api}/drive/files/${fileId}`, {
      headers: bearer(token),
    });

    const noFolder = await call(token, "GET", "/drive?folder=nothing");

    const badName = await call(token, "POST", "/drive/folders", {
      parentId: null,
      name: "  ",
    });

    await call(token, "POST", "/drive/nodes/trash", { ids: [folderId] });
    const emptied = await call(token, "POST", "/drive/trash/empty");

    expect({
      trashed: trashed.data,
      inTrash: names(inTrash.data.rows),
      restored: restored.data,
      deleted: deleted.data,
      goneFile: goneFile.status,
      noFolder: noFolder.status,
      badName: badName.status,
      emptied: emptied.data,
    }).toStrictEqual({
      trashed: { ok: true, count: 1 },
      inTrash: ["minutes.txt"],
      restored: { ok: true, count: 1 },
      deleted: { ok: true, count: 1 },
      goneFile: 404,
      noFolder: 404,
      badName: 400,
      emptied: { ok: true, count: 1 },
    });
  });

  it("reads a range of the calendar and keeps the person's own events", async () => {
    const colleague = await mailbox("col", "Cal Colleague");
    const theirs = await signInAsApp(colleague);

    const made = await call(token, "POST", "/calendar/events", {
      title: "Planning",
      startsAt: "2026-11-10T09:00:00.000Z",
      endsAt: "2026-11-10T10:00:00.000Z",
      allDay: false,
      timeZone: "Europe/Amsterdam",
      repeat: "weekly",
      attendees: [colleague.id],
    });

    const eventId = str(obj(made.data.event).id);

    const task = await call(token, "POST", "/tasks", {
      title: "Send the slides",
      dueOn: "2026-11-11",
    });

    const range = await call(
      token,
      "GET",
      "/calendar?from=2026-11-09&to=2026-11-23"
    );

    expect({
      made: made.data,
      range: {
        ...range.data,
        events: names(range.data.events, "start"),
        tasks: names(range.data.tasks, "title"),
        colleagues: names(range.data.colleagues, "id").includes(colleague.id),
      },
    }).toMatchObject({
      made: {
        ok: true,
        event: {
          title: "Planning",
          mine: true,
          repeat: "weekly",
          attendees: [{ id: colleague.id, status: "needs-action" }],
        },
      },
      range: {
        from: "2026-11-09",
        to: "2026-11-23",
        events: ["2026-11-10T09:00:00.000Z", "2026-11-17T09:00:00.000Z"],
        tasks: ["Send the slides"],
        colleagues: true,
      },
    });

    const answered = await call(
      theirs,
      "POST",
      `/calendar/events/${eventId}/respond`,
      { status: "accepted" }
    );

    const notInvited = await call(
      token,
      "POST",
      `/calendar/events/${eventId}/respond`,
      { status: "accepted" }
    );

    const changed = await call(token, "PUT", `/calendar/events/${eventId}`, {
      title: "Planning (moved)",
      startsAt: "2026-11-10T11:00:00.000Z",
      endsAt: "2026-11-10T12:00:00.000Z",
      allDay: false,
      repeat: "none",
    });

    const notTheirs = await call(theirs, "PUT", `/calendar/events/${eventId}`, {
      title: "Mine now",
      startsAt: "2026-11-10T11:00:00.000Z",
      endsAt: "2026-11-10T12:00:00.000Z",
      allDay: false,
    });

    expect({
      answered: answered.data,
      notInvited: notInvited.data,
      changed: changed.data,
      notTheirs: notTheirs.data,
    }).toMatchObject({
      answered: { ok: true, event: { mine: false, myStatus: "accepted" } },
      notInvited: { ok: false, error: "You are not invited to that event." },
      changed: {
        ok: true,
        event: { title: "Planning (moved)", repeat: "none" },
      },
      notTheirs: { ok: false, error: "No such event of yours." },
    });

    const badRange = await call(token, "GET", "/calendar?from=2026-11-09");

    const tooLong = await call(
      token,
      "GET",
      "/calendar?from=2026-01-01&to=2026-12-31"
    );

    const badRepeat = await call(token, "POST", "/calendar/events", {
      title: "x",
      startsAt: "2026-11-10T11:00:00.000Z",
      endsAt: "2026-11-10T12:00:00.000Z",
      allDay: false,
      repeat: "hourly",
    });

    const removed = await call(token, "DELETE", `/calendar/events/${eventId}`);
    const again = await call(token, "DELETE", `/calendar/events/${eventId}`);
    await call(token, "DELETE", `/tasks/${str(obj(task.data.task).id)}`);

    expect([
      badRange.status,
      tooLong.status,
      badRepeat.data,
      removed.data,
      again.status,
    ]).toStrictEqual([
      400,
      400,
      { ok: false, error: "Choose a repeat." },
      { ok: true },
      404,
    ]);
  });

  it("keeps the person's tasks, done and open, with what is theirs elsewhere", async () => {
    const made = await call(token, "POST", "/tasks", {
      title: "  Write the   report ",
      notes: "Two pages.",
      dueOn: "2026-11-12",
      priority: "high",
    });

    const id = str(obj(made.data.task).id);
    const open = await call(token, "GET", "/tasks");

    const changed = await call(token, "PUT", `/tasks/${id}`, {
      priority: "low",
    });

    const done = await call(token, "POST", `/tasks/${id}/done`, { done: true });
    const doneList = await call(token, "GET", "/tasks?view=done");
    const openList = await call(token, "GET", "/tasks");

    expect({
      made: made.data,
      open: open.data,
      changed: changed.data,
      done: done.data,
      doneList: names(doneList.data.tasks, "id"),
      openList: names(openList.data.tasks, "id"),
    }).toMatchObject({
      made: {
        ok: true,
        task: {
          title: "Write the report",
          notes: "Two pages.",
          dueOn: "2026-11-12",
          priority: "high",
          status: "open",
        },
      },
      open: {
        view: "open",
        tasks: [{ id }],
        github: { connected: false, issues: null },
      },
      changed: { ok: true, task: { priority: "low", notes: "Two pages." } },
      done: { ok: true, github: "unlinked", task: { status: "done" } },
      doneList: [id],
      openList: [],
    });

    const untitled = await call(token, "POST", "/tasks", { title: " " });

    const badIssue = await call(token, "POST", "/tasks/from-issue", {
      repo: "",
      number: 1,
    });

    const notMine = await call(token, "DELETE", "/tasks/tk_nothing");
    await call(token, "DELETE", `/tasks/${id}`);

    expect({
      untitled: untitled.data,
      badIssue: badIssue.status,
      notMine: notMine.status,
    }).toMatchObject({
      untitled: { ok: false, error: "A task needs a title." },
      badIssue: 400,
      notMine: 404,
    });
  });

  it("answers the Assistant as a stream and keeps the conversation", async () => {
    const chat = await SELF.fetch(`${api}/assistant/chat`, {
      method: "POST",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: null,
        message: {
          role: "user",
          parts: [{ type: "text", text: "What arrived today?" }],
        },
      }),
    });

    const stream = await chat.text();

    const events = stream
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6));

    const start = obj(JSON.parse(events[0] ?? "null"));
    const conversationId = str(obj(start.messageMetadata).conversationId);

    // The stored answer takes a moment after the stream ends.
    let stored: { [key: string]: Json } = {};

    for (let tries = 0; tries < 30; tries += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the answer is stored after the stream; each try reads what is there now
      const read = await call(
        token,
        "GET",
        `/assistant/conversations/${conversationId}`
      );

      stored = read.data;

      if (list(stored.messages).length === 2) {
        break;
      }

      // oxlint-disable-next-line eslint/no-await-in-loop -- a short wait between tries
      await scheduler.wait(100);
    }

    const conversations = await call(token, "GET", "/assistant/conversations");

    expect({
      status: chat.status,
      type: chat.headers.get("content-type"),
      cache: chat.headers.get("cache-control"),
      startType: start.type,
      hasText: events.some((e) => e.includes('"text-delta"')),
      done: events.at(-1),
      stored,
      conversations: conversations.data,
    }).toMatchObject({
      status: 200,
      type: "text/event-stream",
      cache: "no-store",
      startType: "start",
      hasText: true,
      done: "[DONE]",
      stored: {
        conversation: { id: conversationId },
        messages: [
          {
            role: "user",
            parts: [{ type: "text", text: "What arrived today?" }],
          },
          { role: "assistant" },
        ],
      },
      conversations: {
        conversations: [{ id: conversationId }],
        suggestions: [
          "What arrived in my inbox today?",
          "Summarize my unread conversations",
          "Which files did I work on last?",
          "Help me write an email",
        ],
      },
    });

    const empty = await call(token, "POST", "/assistant/chat", {
      conversationId: null,
      message: { role: "user", parts: [{ type: "text", text: "  " }] },
    });

    const notMine = await call(
      token,
      "GET",
      "/assistant/conversations/ac_nothing"
    );

    const removed = await call(
      token,
      "DELETE",
      `/assistant/conversations/${conversationId}`
    );

    const again = await call(
      token,
      "DELETE",
      `/assistant/conversations/${conversationId}`
    );

    expect([
      empty.status,
      empty.data,
      notMine.status,
      removed.data,
      again.status,
    ]).toStrictEqual([
      400,
      { ok: false, error: "Write a question first." },
      404,
      { ok: true },
      404,
    ]);
  });

  it("ends with the session: after a sign-out everywhere the token gets 401 at its next request", async () => {
    await revoke(db, user.id, "sign-out-everywhere");
    const after = await call(token, "GET", "/me");

    expect(after.status).toBe(401);
  });
});
