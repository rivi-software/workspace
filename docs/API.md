# The Workspace API for other clients

A client that is not the console (a phone app, a script, an integration) reads and changes a person's workspace over a JSON API: `<APP_URL>/api/v1` (`http://localhost:5174/api/v1` against a local workspace). The Worker serves it before TanStack Start (`workers/worker.ts`, `app/lib/api/api.server.ts`), from the same server modules the console's loaders and server functions call, so an endpoint answers what the matching page shows. The console itself never calls it.

## Signing in

The API takes a Better Auth session token as a bearer token (`app/lib/auth.server.ts`, the `bearer` plugin). A client gets one from Better Auth's own endpoints under `/api/auth`, with the person's address and password; the token is the same one the console's session cookie carries, and the session is the same row, 14 days, listed under Settings → Account and ended there, by "Sign out everywhere", by a new password or by a deactivation.

```
client ── POST /api/auth/sign-in/email  {"email":"ada@example.com","password":"…"} ──▶
          200 { "token": "…", "user": { "id", "email", "name", … } }
          set-auth-token: <the session token>
client ── GET /api/v1/me, Authorization: Bearer <token> ──▶ 200
client ── POST /api/auth/sign-out, Authorization: Bearer <token> ──▶ 200: signed out
```

- `POST /api/auth/sign-in/email` answers the session token in the `set-auth-token` response header (and as `token` in the body). Keep it in the client's secure storage; send it as `Authorization: Bearer <token>` on every request.
- An account with an authenticator app answers `200 { "twoFactorRedirect": true }` instead, with a two-factor cookie (`workspace.two_factor`, named `__Secure-workspace.two_factor` where the workspace runs on https). Post the app's six-digit code to `POST /api/auth/two-factor/verify-totp` with `{ "code": "123456" }`, that cookie, and an `Origin` header equal to `APP_URL`'s origin (Better Auth refuses a request that carries cookies without a trusted origin); the answer carries the session token in `set-auth-token`. `POST /api/auth/two-factor/verify-backup-code` takes one of the backup codes the same way. `"trustDevice": true` on either skips the second factor for 30 days on that client, through the cookie the answer sets.
- A passkey sign-in needs a browser (WebAuthn): a client without one signs in with the password.
- Better Auth rate-limits `/api/auth/sign-in/email` (20 a quarter hour per client) and the two-factor endpoints (10); a `429` carries `Retry-After`. A wrong password answers `401`, a deactivated account `403`.
- `GET /api/auth/get-session` with the bearer token answers the session and the person, or `null` once it has ended. `POST /api/auth/sign-out` ends it.
- A deployment's `APP_URL` is the only origin Better Auth trusts; a client sends no `Origin` header, which is fine.

## Conventions

- Every request carries `Authorization: Bearer <session token>` (a browser session cookie is taken too). A request without a usable token is `401` with `WWW-Authenticate: Bearer realm="Workspace API"` when it sent none, and `WWW-Authenticate: Bearer error="invalid_token"` when it sent one that has ended. There are no scopes: every session may read and write, as the person may in the console.
- Requests and answers are JSON (`Content-Type: application/json`), except where a row says otherwise. An error is `{ "ok": false, "error": "<words for the person>" }` with its status: `400` for a mistake the person can correct (the server module's own words), `404` for something that is not theirs, `405` for a path that takes another method, `413`, `415`, `500`. A write that succeeds answers `{ "ok": true, … }`.
- A moment is an ISO 8601 string in UTC (`2026-11-06T09:30:00.000Z`); a day is `YYYY-MM-DD` in the reader's zone. Ids are opaque strings.
- `Address` is `{ "email": string, "name": string | null }`. `LabelRef` is `{ "id", "name", "color" }` with `color` one of `gray`, `red`, `orange`, `amber`, `green`, `teal`, `blue`, `violet`, `pink`.
- Every answer is `Cache-Control: no-store`, but a file's bytes.

## Endpoints

### The person

| Method and path | Answer |
| --- | --- |
| `GET /me` | `{ user: { id, name, email, role: "admin" \| "member" }, appName, counts, labels: LabelRef[], preferences: { layout, undoSendSeconds, pageSize }, driveUsed: bytes, github: { connected }, colleagues: [{ id, name, email }], suggestions: string[] }`. `counts` is `{ inboxUnread, spamUnread, snoozed, drafts, scheduled, labels: { <labelId>: unread } }`; `suggestions` are the Assistant's opening questions. |

### Mail

| Method and path | Request | Answer |
| --- | --- | --- |
| `GET /mail/threads` | `?folder=inbox\|starred\|snoozed\|sent\|scheduled\|drafts\|archive\|spam\|trash` (default `inbox`), `?label=<id>` (a label's conversations; `folder` is then ignored), `?q=` (the search box's language: `from:`, `to:`, `subject:`, `has:attachment`, `is:unread`, `in:anywhere`, `label:`, `before:`, `after:`), `?page=1`, `?pageSize=25\|50\|100` (default: the person's preference) | `{ folder, q, page, pageSize, total, label: LabelRef \| null, threads: ListRow[], drafts: DraftRow[] }`. `drafts` is filled for `drafts` and `scheduled` and `threads` for every other folder. |
| `GET /mail/threads/:id` | `?keepUnread=1` leaves the conversation unread; without it, opening reads it | `{ thread: ThreadView, labels: LabelRef[], messages: MessageView[] }` oldest message first |
| `GET /mail/messages/:id/document` | `?appearance=light\|dark` (default `light`), `?images=1` loads the images from the web (otherwise only inline files show) | `text/html`: the message's HTML part, sanitised as the console shows it (a reply's quote folded under "Show quoted text", a forward's left open), as a complete document with its own CSP, for a web view. `404` for a message without an HTML part. |
| `POST /mail/threads/actions` | `{ ids: string[], intent, until?, labelId? }` with `intent` one of `star`, `unstar`, `archive`, `trash`, `spam`, `inbox`, `read`, `unread`, `delete` (for good, from the trash or Spam), `mute`, `unmute`, `snooze` (with `until`, a moment), `unsnooze`, `label`, `unlabel` (with `labelId`) | `{ ok: true, intent, count, undo: string \| null }` |
| `POST /mail/undo` | `{ undo }` from an action | `{ ok: true }` |
| `POST /mail/read-all` | `{ folder?, label?, q? }` as a list request | `{ ok: true }` |
| `POST /mail/folders/:folder/empty` | `trash` or `spam` | `{ ok: true, count }` |
| `GET /mail/compose` | `?reply=<messageId>&mode=reply\|all\|forward`, or `?draft=<draftId>`, or `?to=<address>`, or nothing for a blank message | `ComposeData` |
| `POST /mail/send` | `{ from, to, cc, bcc, subject, text, inReplyToId?, signatureId?, draftId?, files?: [{ filename, contentType, base64 }] }`; `to`, `cc` and `bcc` are typed lists (`Ada <ada@acme.com>, bob@acme.com`); `from` one of `ComposeData.froms`; `draftId` deletes the draft once sent; the files together at most 20 MB | `{ ok: true, threadId }` |
| `POST /mail/drafts` | `{ id?, threadId?, inReplyToId?, mode: "new" \| "reply" \| "forward", from, to, cc, bcc, subject, text, signatureId? }` | `{ ok: true, draftId, savedAt }` |
| `DELETE /mail/drafts/:id` | | `{ ok: true }` |
| `GET /mail/contacts` | `?q=` | `{ contacts: Address[] }` (at most 8, most used first) |
| `POST /mail/labels` | `{ name, color? }` | `{ ok: true, label: LabelRef }` |

```ts
interface ListRow {
  id: string; subject: string; snippet: string;
  people: string;            // "Ada Lovelace, Bob", or "me"
  count: number;             // messages in the conversation
  unread: boolean; starred: boolean; hasAttachments: boolean; muted: boolean;
  sent: boolean;             // the person wrote in it
  lastMessageAt: string; snoozedUntil: string | null;
  folder: "inbox" | "archive" | "spam" | "trash";
  labels: LabelRef[];
}
interface DraftRow { id: string; to: string; subject: string; snippet: string; updatedAt: string; scheduledAt: string | null; sendError: string | null }
interface ThreadView {
  id: string; subject: string; folder: "inbox" | "archive" | "spam" | "trash";
  starred: boolean; muted: boolean; snoozedUntil: string | null;
  messageCount: number; unreadCount: number; lastMessageAt: string; participants: Address[];
}
interface MessageView {
  id: string; direction: "inbound" | "outbound";
  from: Address; to: Address[]; cc: Address[]; bcc: Address[]; replyTo: Address | null;
  subject: string;
  text: string;              // the plain text, always
  hasHtml: boolean;          // the document endpoint answers for it
  remoteImages: boolean;     // the HTML loads images from the web, held back until ?images=1
  loadImages: boolean;       // load them at once (?images=1): the person always loads this sender's, and it is not in Spam
  date: string; read: boolean;
  deliveryStatus: "received" | "sent" | "failed"; deliveryError: string | null;
  spam: boolean;             // the spam filter put it in Spam when it arrived
  attachments: [{ id: string; filename: string; contentType: string; size: number; inline: boolean; contentId: string | null; url: string }];
}
// `url` is a signed link (six hours) that needs no token: GET it for the bytes, `&download=1` as an attachment.
interface ComposeData {
  froms: Address[];
  signatures: [{ id: string; name: string; text: string; html: string | null }];
  prefill: { draftId: string | null; threadId: string | null; inReplyToId: string | null; mode: "new" | "reply" | "forward";
             from: string; to: string; cc: string; bcc: string; subject: string; text: string; html: string; signatureId: string | null;
             files: [{ id: string; filename: string; contentType: string; size: number }] };
  undoSendSeconds: number;
}
// A reply's or forward's `prefill.html` keeps the original's images from the web in `data-held-src`, `data-held-background`,
// `data-held-poster` and `data-held-style` (and leaves out an `svg`) unless opening the original loads them, so a view of it
// loads nothing; the console's composer sends them back out as they were.
```

### Drive

| Method and path | Request | Answer |
| --- | --- | --- |
| `GET /drive` | `?folder=<id>` lists a folder; else `?view=mine\|shared\|recent\|starred\|trash` (default `mine`, the person's root); `?q=` searches by name instead; `?sort=name\|updated\|size&dir=asc\|desc` | `{ view, q, folder: FolderView \| null, crumbs: [{ id, name }], rows: DriveRow[], canWrite, used: bytes }` |
| `GET /drive/nodes/:id` | | `{ node: DriveRow, crumbs, preview: "image" \| "audio" \| "video" \| "pdf" \| "text" \| "code" \| null, shares: [{ person: { id, name } \| null, role }] }` |
| `GET /drive/files/:id` | `?download=1` as an attachment; `Range` for media | the file's bytes with its `Content-Type`, `Content-Disposition` and `ETag` |
| `PUT /drive/upload` | `?folder=<id>&name=<name>`, the file as the body with `Content-Type` and `Content-Length` (at most 32 MB) | `{ ok: true, node: DriveRow }` |
| `POST /drive/upload` | `{ intent: "start", folder, name, size, type }` for a larger file | `{ ok: true, id, uploadId, partSize }` |
| `PUT /drive/upload` | `?id=<node>&part=<n>`, one part as the body (`partSize` bytes, the last one smaller) | `{ ok: true, part: { partNumber, etag } }` |
| `POST /drive/upload` | `{ intent: "finish", id, parts: [{ partNumber, etag }] }`, or `{ intent: "abort", id }` | `{ ok: true, node }` or `{ ok: true }` |
| `POST /drive/folders` | `{ parentId: string \| null, name }` | `{ ok: true, node: DriveRow }` |
| `POST /drive/nodes/:id/rename` | `{ name }` | `{ ok: true, node: DriveRow }` |
| `POST /drive/nodes/star` | `{ ids, on: boolean }` | `{ ok: true, count }` |
| `POST /drive/nodes/trash` | `{ ids }` | `{ ok: true, count }` |
| `POST /drive/nodes/restore` | `{ ids }` | `{ ok: true, count }` |
| `POST /drive/nodes/delete` | `{ ids }` (for good, from the trash) | `{ ok: true, count }` |
| `POST /drive/nodes/move` | `{ ids, targetId: string \| null }` | `{ ok: true, count }` |
| `POST /drive/trash/empty` | | `{ ok: true, count }` |

```ts
interface DriveRow {
  id: string; kind: "folder" | "file"; name: string; contentType: string; size: number;
  updatedAt: string; createdAt: string; trashedAt: string | null;
  starred: boolean; shared: boolean; linked: boolean;
  role: "owner" | "editor" | "viewer"; owner: { id: string; name: string }; parentId: string | null;
}
interface FolderView { id: string; name: string; role: DriveRow["role"]; owner: { id: string; name: string }; starred: boolean; shared: boolean; linked: boolean }
```

### Calendar

| Method and path | Request | Answer |
| --- | --- | --- |
| `GET /calendar` | `?from=YYYY-MM-DD&to=YYYY-MM-DD` (`to` excluded; at most 64 days; ask a day of leeway each side of what is shown, since the reader's zone moves a UTC day) | `{ from, to, events: EventOccurrence[], tasks: TaskRow[], colleagues: [{ id, name, email }] }` |
| `POST /calendar/events` | `EventInput` | `{ ok: true, event: EventView }` |
| `PUT /calendar/events/:id` | `EventInput` | `{ ok: true, event: EventView }` |
| `DELETE /calendar/events/:id` | | `{ ok: true }` |
| `POST /calendar/events/:id/respond` | `{ status: "accepted" \| "declined" }` | `{ ok: true, event: EventView }` |

```ts
interface EventInput {
  title: string; description?: string; location?: string;
  startsAt: string; endsAt: string;     // moments; an all-day event's the UTC midnights of its first day and the day after its last
  allDay: boolean; timeZone?: string;   // the zone it was made in (IANA), the reader's by default
  repeat?: "none" | "daily" | "weekly" | "monthly" | "yearly"; repeatUntil?: string | null;
  attendees?: string[];                 // colleagues' ids
}
interface EventView {
  id: string; owner: { id: string; name: string }; mine: boolean;
  title: string; description: string; location: string;
  startsAt: string; endsAt: string; allDay: boolean; timeZone: string;
  repeat: EventInput["repeat"]; repeatUntil: string | null;
  attendees: [{ id: string; name: string; status: "needs-action" | "accepted" | "declined" }];
  myStatus: "needs-action" | "accepted" | "declined" | null; updatedAt: string;
}
type EventOccurrence = EventView & { key: string; start: string; end: string };  // one time a repeating event happens
```

### Tasks

| Method and path | Request | Answer |
| --- | --- | --- |
| `GET /tasks` | `?view=open\|done` (default `open`) | `{ view, tasks: TaskRow[], github: { connected, issues: Issue[] \| null } }`; `issues` is null while GitHub does not answer or is not connected |
| `POST /tasks` | `{ title, notes?, dueOn?: day \| null, priority?: "low" \| "normal" \| "high" }` | `{ ok: true, task: TaskRow }` |
| `PUT /tasks/:id` | the same fields, each optional | `{ ok: true, task: TaskRow }` |
| `DELETE /tasks/:id` | | `{ ok: true }` |
| `POST /tasks/:id/done` | `{ done: boolean }`; a task made from an issue closes or reopens it first | `{ ok: true, task, github: "closed" \| "reopened" \| "unlinked" \| "not-connected" }`, or `{ ok: false, error }` when GitHub refused (the task stays as it was) |
| `POST /tasks/from-issue` | `{ repo: "owner/name", number }` | `{ ok: true, task, existed }` |

```ts
interface TaskRow {
  id: string; title: string; notes: string; status: "open" | "done"; priority: "low" | "normal" | "high";
  dueOn: string | null; completedAt: string | null;
  github: { repo: string; number: number; url: string; title: string | null; state: "open" | "closed" | null; syncedAt: string | null } | null;
  updatedAt: string; createdAt: string;
}
interface Issue { repo: string; number: number; title: string; url: string; state: "open" | "closed"; updatedAt: string; labels: string[] }
```

### Assistant

| Method and path | Request | Answer |
| --- | --- | --- |
| `GET /assistant/conversations` | | `{ conversations: [{ id, title, updatedAt }], suggestions: string[] }` newest first |
| `GET /assistant/conversations/:id` | | `{ conversation: { id, title, updatedAt }, messages: [{ id, role: "user" \| "assistant", parts: Part[] }] }` oldest first |
| `DELETE /assistant/conversations/:id` | | `{ ok: true }` |
| `POST /assistant/chat` | `{ conversationId: string \| null, message: { role: "user", parts: [{ type: "text", text }] } }` | `text/event-stream`: the answer as it comes (below) |

A stored `Part` is `{ type: "text", text }`, `{ type: "step-start" }`, or a tool's step `{ type: "tool-<name>", toolCallId, state: "output-available", input, output }` with `<name>` one of `search_mail`, `read_conversation`, `search_drive`, `read_file`, `create_draft`. The answer's text is Markdown, with links on paths of the console (`/mail/t/<id>`, `/drive/d/<id>`); a client shows the step as "Searched mail", "Read a conversation", "Searched Drive", "Read a file", "Prepared a draft".

The chat answers the AI SDK's UI message stream, server-sent events each with a JSON object, ending in `data: [DONE]`:

```
data: {"type":"start","messageId":"am_…","messageMetadata":{"conversationId":"ac_…"}}
data: {"type":"start-step"}
data: {"type":"tool-input-start","toolCallId":"call_1","toolName":"search_mail"}
data: {"type":"tool-input-available","toolCallId":"call_1","toolName":"search_mail","input":{"query":"invoice"}}
data: {"type":"tool-output-available","toolCallId":"call_1","output":{…}}
data: {"type":"finish-step"}
data: {"type":"start-step"}
data: {"type":"text-start","id":"t1"}
data: {"type":"text-delta","id":"t1","delta":"Three conversations "}
data: {"type":"text-delta","id":"t1","delta":"mention an invoice…"}
data: {"type":"text-end","id":"t1"}
data: {"type":"finish-step"}
data: {"type":"finish"}
data: [DONE]
```

`start` names the conversation (a new one's id when the request named none); `error` carries `errorText`. An error before the stream starts is a JSON problem with its status (`400` for an empty or too long question, `404` for a conversation that is not the person's).

## In this repository

- `app/lib/api/api.server.ts` is the entry: the bearer token (`getSessionUser`), the person, the routes, the JSON answers and the problems; one module per section beside it (`me`, `mail`, `drive`, `calendar`, `tasks`, `assistant`), each a list of routes over the server modules the console's loaders call.
- `test/api.test.ts` signs in as a client does (`POST /api/auth/sign-in/email`, the token from `set-auth-token`) and calls every section through `SELF.fetch` with it as a bearer token; `test/sessions.test.ts` covers what ends a session.
- A new endpoint: a route in its section's module, a row above, and a test.
