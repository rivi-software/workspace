// Posts a raw RFC 5322 email to the local Email Workers endpoint exposed by `pnpm dev` (port 5174) or `wrangler dev` (8787).
//   pnpm run email:simulate "Subject" "Body"            TO=sam@example.com FROM=bob@globex.io IN_REPLY_TO="<id>"
const base = process.env.BASE_URL || "http://localhost:5174";
const to = process.env.TO || "admin@example.com";
const from = process.env.FROM || "jane@acme.com";
const subject = process.argv[2] || "Lunch on Friday?";

const body =
  process.argv[3] ||
  "Hi,\n\nAre you free for lunch on Friday? The new place on the corner has opened.\n\nJane";

const inReplyTo = process.env.IN_REPLY_TO;
const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@acme.com>`;

const raw = [
  `From: "Jane Doe" <${from}>`,
  `To: ${to}`,
  `Subject: ${subject}`,
  `Message-ID: ${messageId}`,
  inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
  `Date: ${new Date().toUTCString()}`,
  `Content-Type: text/plain; charset="utf-8"`,
  ``,
  body,
]
  .filter((l) => l !== null)
  .join("\r\n");

const res = await fetch(
  `${base}/cdn-cgi/local/email?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  { method: "POST", body: raw }
);

console.log(`${res.status} ${await res.text()}`);

console.log("Message-ID:", messageId);
