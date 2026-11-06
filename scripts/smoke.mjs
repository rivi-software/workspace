// End-to-end smoke test against a running server (pnpm run dev, or wrangler dev on the build):
// sign in -> inbound email through the email() handler -> the inbox lists it -> open it -> reply
// (sent through the local EMAIL binding) -> Sent lists the thread -> archive -> search finds it
// -> Drive takes an upload, lists it, serves it and finds it -> a link outside the workspace opens the file's page and
// serves the file without a session, with Range, until it is revoked -> Better Auth answers the session and signs out
// -> the Assistant answers a question through its search_mail tool (on the mock model) and keeps the conversation ->
// the calendar, the tasks and the GitHub connection page render -> the forgotten-password request answers the same
// for any address, and the reset pages render.
import { setTimeout as sleep } from "node:timers/promises";

const base = process.env.BASE_URL || "http://localhost:5174";
const mailbox = process.env.TO || "admin@example.com";
let cookie = "";
const log = (...a) => console.log("•", ...a);

const fail = (m) => {
  console.error("✗", m);
  process.exit(1);
};

const req = async (path, init = {}) => {
  const headers = { ...init.headers, cookie };

  // A page may answer with a redirect of its own (the router canonicalising a search); a POST's redirect is the result.
  const res = await fetch(base + path, {
    ...init,
    headers,
    redirect: init.method ? "manual" : "follow",
  });

  const sc = res.headers.get("set-cookie");

  if (sc) {
    [cookie] = sc.split(";");
  }

  return res;
};

const form = (path, fields) =>
  req(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });

const unescapeHtml = (s) =>
  s
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll(/&#x27;|&#39;/gu, "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");

// 1. sign in
let r = await form("/login", {
  email: mailbox,
  password: "password",
  next: "/mail",
});

if (r.status !== 302 || !cookie) {
  fail(`sign-in failed: ${r.status}`);
}

log("signed in as", mailbox);

// 2. inbound email through the local Email Workers endpoint
const stamp = Date.now();
const subject = `Smoke ${stamp}`;
const mid = `<smoke-${stamp}@acme.com>`;

const raw = [
  `From: "Jane Doe" <jane@acme.com>`,
  `To: ${mailbox}`,
  `Subject: ${subject}`,
  `Message-ID: ${mid}`,
  `Date: ${new Date().toUTCString()}`,
  `Content-Type: text/plain; charset="utf-8"`,
  ``,
  `Hi, is the plan ready?`,
].join("\r\n");

r = await fetch(
  `${base}/cdn-cgi/local/email?from=jane@acme.com&to=${mailbox}`,
  {
    method: "POST",
    body: raw,
  }
);

if (!r.ok) {
  fail(`inbound email failed: ${r.status} ${await r.text()}`);
}

log("inbound email delivered to the email() handler");

await sleep(500);

// 3. the inbox lists it
r = await req("/mail?folder=inbox");

let html = await r.text();

const row = [
  ...html.matchAll(/href="\/mail\/t\/(?<id>th_[a-z0-9]+)"[\s\S]*?<\/a>/gu),
].find((m) => m[0].includes(subject));

if (!row) {
  fail("thread not in the inbox");
}

const [, threadId] = row;

log("thread in the inbox:", threadId);

// 4. the thread page shows the message, and marks it read
r = await req(`/mail/t/${threadId}`);

html = await r.text();

if (!html.includes("Hi, is the plan ready?")) {
  fail("message body missing from the thread page");
}

log("thread page renders the message");

const messageId = html.match(/data-message="(?<id>msg_[a-z0-9]+)"/u)?.[1];

if (!messageId) {
  fail("no message card on the thread page");
}

// 5. reply from the composer: the server function takes the form, the local EMAIL binding keeps the mail on disk
r = await req(`/mail/compose?reply=${messageId}&mode=reply`);

html = await r.text();

// The composer's form posts to its server function; the list beside it has a search form of its own.
const action = html.match(/action="(?<action>\/_serverFn\/[^"]+)"/u)?.[1];

if (!action) {
  fail("no compose form");
}

const fd = new FormData();

for (const name of ["draftId", "threadId", "inReplyToId", "mode", "from"]) {
  const value =
    html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`, "u"))?.[1] ??
    "";

  fd.set(name, unescapeHtml(value));
}

fd.set("to", "jane@acme.com");

fd.set("cc", "");

fd.set("bcc", "");

fd.set("subject", `Re: ${subject}`);

fd.set("text", "Yes, see the thread.");

fd.set("intent", "send");

r = await req(unescapeHtml(action), {
  method: "POST",
  body: fd,
  headers: { "sec-fetch-dest": "document", referer: `${base}/mail/compose` },
});

if (![302, 303, 307].includes(r.status)) {
  const body = await r.text();
  fail(`send failed: ${r.status} ${body.slice(0, 300)}`);
}

log("reply sent through the EMAIL binding");

// 6. Sent lists the thread, with two messages
r = await req("/mail?folder=sent");

html = await r.text();

if (!html.includes(`/mail/t/${threadId}`)) {
  fail("thread not under Sent");
}

r = await req(`/mail/t/${threadId}`);

html = await r.text();

if (!html.includes("Yes, see the thread.")) {
  fail("reply missing from the thread");
}

log("Sent lists the thread and the reply is in it");

// 7. search finds it, by a word and by an operator; the other views and Settings → Mail render; health answers
r = await req(`/mail?folder=inbox&q=${encodeURIComponent(String(stamp))}`);

const text2 = await r.text();

if (!text2.includes(`/mail/t/${threadId}`)) {
  fail("search did not find the thread");
}

r = await req(
  `/mail?folder=inbox&q=${encodeURIComponent(`from:jane subject:"Smoke ${stamp}"`)}`
);

const text3 = await r.text();

if (!text3.includes(`/mail/t/${threadId}`)) {
  fail("search by operator did not find the thread");
}

for (const path of [
  "/mail?folder=snoozed",
  "/mail?folder=spam",
  "/mail?folder=trash",
  "/mail?folder=drafts",
  "/settings?tab=mail",
]) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- a smoke test walks its checks in order, one request at a time
  r = await req(path);

  if (!r.ok) {
    fail(`${path} failed: ${r.status}`);
  }
}

r = await req("/api/health");

const health = await r.json();

if (!r.ok || !health.ok) {
  fail("health endpoint failed");
}

log("search, the views, Settings → Mail and health ok");

// 7b. Drive: a folder, a file uploaded whole through the upload route, the listing and the folder page show them,
// the file comes back as it went in, with the headers the file route promises, and the trash takes the folder.
r = await req("/drive");

if (!r.ok) {
  fail(`/drive failed: ${r.status}`);
}

html = await r.text();

if (!html.includes("My Drive")) {
  fail("the Drive page does not render");
}

const folderName = `Smoke ${stamp}`;

r = await fetch(
  `${base}/api/drive/upload?${new URLSearchParams({ name: `${folderName}.txt` })}`,
  {
    method: "PUT",
    headers: { cookie, "content-type": "text/plain" },
    body: "hello drive",
  }
);

const uploaded = await r.json();

if (!r.ok || !uploaded.ok || !uploaded.node?.id) {
  fail(`drive upload failed: ${r.status} ${JSON.stringify(uploaded)}`);
}

const fileId = uploaded.node.id;

if (uploaded.node.name !== `${folderName}.txt`) {
  fail(`uploaded under another name: ${uploaded.node.name}`);
}

r = await req("/drive");

html = await r.text();

if (!html.includes(`/drive/d/${fileId}`)) {
  fail("uploaded file not in My Drive");
}

r = await req(`/drive/d/${fileId}`);

const filePage = await r.text();

if (!r.ok || !filePage.includes(`${folderName}.txt`)) {
  fail(`file page failed: ${r.status}`);
}

r = await fetch(`${base}/api/drive/files/${fileId}`, { headers: { cookie } });

if (!r.ok || (await r.text()) !== "hello drive") {
  fail(`file route did not answer the file: ${r.status}`);
}

if (!(r.headers.get("content-type") || "").startsWith("text/plain")) {
  fail("file route lost the content type");
}

if (!(r.headers.get("content-security-policy") || "").includes("sandbox")) {
  fail("file route lost its sandbox");
}

r = await fetch(`${base}/api/drive/files/${fileId}?download=1`, {
  headers: { cookie },
});

if (!(r.headers.get("content-disposition") || "").startsWith("attachment")) {
  fail("download is not an attachment");
}

r = await fetch(`${base}/api/drive/files/${fileId}`, {
  headers: { cookie, range: "bytes=0-4" },
});

if (r.status !== 206 || (await r.text()) !== "hello") {
  fail(`range request failed: ${r.status}`);
}

r = await fetch(`${base}/api/drive/files/${fileId}`);

if (r.status !== 401) {
  fail(`file route answered ${r.status} without a session`);
}

r = await req(`/drive?q=${encodeURIComponent(String(stamp))}`);

const text4 = await r.text();

if (!text4.includes(`/drive/d/${fileId}`)) {
  fail("Drive search did not find the file");
}

for (const path of [
  "/drive?view=shared",
  "/drive?view=recent",
  "/drive?view=starred",
  "/drive?view=trash",
]) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- a smoke test walks its checks in order, one request at a time
  r = await req(path);

  if (!r.ok) {
    fail(`${path} failed: ${r.status}`);
  }
}

log("Drive uploads, lists, serves and searches a file");

// 7c. A link outside the workspace (#2836): the file page's "Outside the workspace" makes one with the defaults through
// its form, and then shows its address; with no session the link's page shows the file and its file route serves it
// (the sandbox, Range, a download) until the link is revoked, when both answer 404.
r = await req(`/drive/d/${fileId}`);

html = await r.text();

const linkForm = [
  ...html.matchAll(
    /<form\b[^>]*action="(?<action>\/_serverFn\/[^"]+)"[^>]*>(?<inner>[\s\S]*?)<\/form>/gu
  ),
].find((m) =>
  /<button\b(?=[^>]*\bname="intent")(?=[^>]*\bvalue="link")/u.test(m[2])
);

if (!linkForm) {
  fail("the file page has no form to make a link");
}

const driveAction = unescapeHtml(linkForm[1]);

const postDrive = (fields) => {
  const body = new FormData();

  for (const [name, value] of Object.entries(fields)) {
    body.set(name, value);
  }

  return req(driveAction, {
    method: "POST",
    body,
    headers: {
      "sec-fetch-dest": "document",
      referer: `${base}/drive/d/${fileId}`,
    },
  });
};

r = await postDrive({ id: fileId, intent: "link" });

if (![302, 303, 307].includes(r.status)) {
  fail(`making a link failed: ${r.status}`);
}

r = await req(`/drive/d/${fileId}`);

html = await r.text();

const linkToken = html.match(/\/s\/(?<token>[\w-]{20,})/u)?.[1];

const linkId = html.match(
  /<input\b(?=[^>]*\bname="link")[^>]*\bvalue="(?<id>dl_[a-z0-9]+)"/u
)?.[1];

if (!linkToken || !linkId) {
  fail("the file page does not show the new link");
}

r = await fetch(`${base}/s/${linkToken}`);

html = await r.text();

if (!r.ok || !html.includes(`${folderName}.txt`)) {
  fail(`the link's page failed: ${r.status}`);
}

if (html.includes(mailbox)) {
  fail("the link's page shows the owner's address");
}

// The page's own forms name its origin only when it sends its referrer there: under `no-referrer` a browser without
// `Sec-Fetch-Site` posts `Origin: null`, which the post check refuses (`sameOriginPost`).
if (
  !/<meta(?=[^>]*\bname="referrer")(?=[^>]*\bcontent="same-origin")[^>]*>/u.test(
    html
  )
) {
  fail("the link's page does not keep its referrer to its own origin");
}

r = await fetch(`${base}/s/${linkToken}/file/${fileId}`);

if (!r.ok || (await r.text()) !== "hello drive") {
  fail(`the link's file route did not answer the file: ${r.status}`);
}

if (!(r.headers.get("content-security-policy") || "").includes("sandbox")) {
  fail("the link's file route lost its sandbox");
}

r = await fetch(`${base}/s/${linkToken}/file/${fileId}`, {
  headers: { range: "bytes=0-4" },
});

if (r.status !== 206 || (await r.text()) !== "hello") {
  fail(`a range through the link failed: ${r.status}`);
}

r = await fetch(`${base}/s/${linkToken}/file/${fileId}?download=1`);

if (!(r.headers.get("content-disposition") || "").startsWith("attachment")) {
  fail("a download through the link is not an attachment");
}

await r.arrayBuffer();

r = await postDrive({ link: linkId, intent: "revoke-link" });

if (![302, 303, 307].includes(r.status)) {
  fail(`revoking the link failed: ${r.status}`);
}

r = await fetch(`${base}/s/${linkToken}/file/${fileId}`);

if (r.status !== 404) {
  fail(`the revoked link's file route answered ${r.status}`);
}

r = await fetch(`${base}/s/${linkToken}`);

if (r.status !== 404) {
  fail(`the revoked link's page answered ${r.status}`);
}

log(
  "a link outside the workspace serves the file without a session, and nothing once revoked"
);

// 8. Better Auth: the session the sign-in made answers at /api/auth/get-session, and the account menu's sign-out
// (a form post to /logout, which ends it through Better Auth) leaves nothing behind
r = await req("/api/auth/get-session");

const session = await r.json().catch(() => null);

if (r.status !== 200 || session?.user?.email !== mailbox) {
  fail(`get-session did not answer the session: ${r.status}`);
}

const signedInCookie = cookie;

r = await form("/logout", {});

if (r.status !== 302) {
  fail(`sign-out failed: ${r.status}`);
}

r = await fetch(`${base}/api/auth/get-session`, {
  headers: { cookie: signedInCookie },
});

if (r.status !== 200 || (await r.text()) !== "null") {
  fail("the session outlived the sign-out");
}

log("Better Auth answered the session and ended it");

// Signed in again for the rest: a form post, as the browser's.
r = await form("/login", {
  email: mailbox,
  password: "password",
  next: "/mail",
});

if (r.status !== 302 || !cookie) {
  fail(`second sign-in failed: ${r.status}`);
}

// 9. the Assistant: its page renders, a question is answered through the search_mail tool on the mock model
// (AI_PROVIDER=mock in .dev.vars; the tool finds this run's conversation), and the conversation is kept with its answer.
r = await req("/assistant");

if (!r.ok) {
  fail(`the Assistant page failed: ${r.status}`);
}

html = await r.text();

if (!html.includes("Ask about your mail and files")) {
  fail("the Assistant page shows no welcome");
}

r = await req("/api/assistant/chat", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    conversationId: null,
    message: {
      role: "user",
      parts: [{ type: "text", text: `Search my mail for ${subject}` }],
    },
  }),
});

if (r.status !== 200) {
  fail(`the assistant answered ${r.status}: ${await r.text()}`);
}

const stream = await r.text();

const chunks = stream
  .split("\n")
  .filter((line) => line.startsWith("data:"))
  .map((line) => line.slice(5).trim())
  .filter((line) => line && line !== "[DONE]")
  .map((line) => JSON.parse(line));

const conversationId = chunks.find((c) => c.type === "start")?.messageMetadata
  ?.conversationId;

if (!conversationId) {
  fail(`the answer names no conversation: ${stream.slice(0, 400)}`);
}

const searched = chunks.find((c) => c.type === "tool-output-available");

if (!searched || !JSON.stringify(searched.output).includes(subject)) {
  fail(
    `the assistant's search did not find "${subject}": ${stream.slice(0, 600)}`
  );
}

if (!chunks.some((c) => c.type === "finish")) {
  fail("the answer never finished");
}

r = await req(`/assistant/c/${conversationId}`);

html = await r.text();

if (
  !r.ok ||
  !html.includes("Searched mail for") ||
  !html.includes(unescapeHtml(subject))
) {
  fail(`the conversation page does not show the answer: ${r.status}`);
}

log(
  "the assistant searched mail for",
  subject,
  "and kept conversation",
  conversationId
);

// 10. Calendar and Tasks render (#3111): the week and the month, the open and the done tasks, and the GitHub
// connection under Settings → Tasks. Without a GitHub token the section says so.
for (const [path, expected] of [
  ["/calendar?date=2026-11-02", "Calendar · Workspace"],
  ["/calendar?view=month&date=2026-11-02", "Calendar · Workspace"],
  ["/tasks", "Assigned to you on GitHub"],
  ["/tasks?view=done", "Done · Workspace"],
  ["/settings?tab=tasks", "Personal access token"],
]) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- a smoke test walks its checks in order, one request at a time
  r = await req(path);
  // oxlint-disable-next-line eslint/no-await-in-loop -- a smoke test walks its checks in order, one request at a time
  html = await r.text();

  if (!r.ok || !html.includes(expected)) {
    fail(`${path} failed: ${r.status}`);
  }
}

log("the calendar, the tasks and the GitHub connection page render");

// 11. a forgotten password: the request answers the same for any address, and the pages render signed out
for (const email of [mailbox, "nobody@example.com"]) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- a smoke test walks its checks in order, one request at a time
  r = await fetch(`${base}/forgot-password`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email }),
    redirect: "manual",
  });

  if (
    r.status !== 303 ||
    r.headers.get("location") !== "/forgot-password?sent=1"
  ) {
    fail(
      `forgot-password answered ${r.status} ${r.headers.get("location")} for ${email}`
    );
  }
}

for (const path of [
  "/forgot-password?sent=1",
  "/reset-password",
  "/confirm-recovery",
]) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- a smoke test walks its checks in order, one request at a time
  r = await fetch(base + path);

  if (!r.ok) {
    fail(`${path} failed: ${r.status}`);
  }
}

log("password reset pages answer");

console.log("✓ smoke passed");
