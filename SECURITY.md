# Security

This policy covers the code in this repository: the Worker, the console, the scripts and the workflows that test and deploy them. A workspace someone deploys from it is theirs; see [Running your own workspace](#running-your-own-workspace).

## Reporting a vulnerability

Report it privately, in either of two ways:

- [Report a vulnerability](https://github.com/rivi-software/workspace/security/advisories/new) on GitHub, which opens a draft advisory only you and the maintainers see.
- Email **[oss-cybersecurity@rivi.software](mailto:oss-cybersecurity@rivi.software)**.

Do not open a public issue, pull request or discussion about it, and do not publish it before a fix is out.

Include what you can of:

- The commit you tested, and where it ran: `pnpm run dev`, `wrangler dev`, or a deployment of your own
- What an attacker can do with it, and what they need first: an account in the workspace, an admin's, a shared link, a message they send
- How to reproduce it: steps, a request, a message or file, or a failing test
- A fix, if you have one in mind
- The name to credit, or that you would rather not be credited

Send one report per issue. If you are not sure whether something is a vulnerability, or whether it is in scope, report it anyway.

## What happens next

- We acknowledge your report within 3 working days.
- Within 10 working days, we tell you whether we can reproduce it, how serious we think it is and what we will do about it.
- We keep you posted until it is fixed, and agree with you when it goes public. We aim to land a fix within 90 days of your report, and sooner for a serious one.
- With the fix, we publish a [GitHub security advisory](https://github.com/rivi-software/workspace/security/advisories), with a CVE where one applies, and credit you unless you would rather not be.

There is no bug bounty.

## Supported versions

The workspace has no releases: `main` is the only version, and a fix lands there. A deployment gets it by deploying `main` again (README, Deploy). To hear of a fix, watch the repository for security alerts (**Watch** → **Custom** → **Security alerts**).

## Scope

In scope, for example:

- A way for someone to read or change another person's mail, files, events, tasks or Assistant conversations, or to act as them: through the console, the Workspace API (`/api/v1`), a shared link or a signing request.
- A way to sign in without the password, the passkey or the second factor, to keep a session that should have ended, or to use a reset link, a code or a link outside the workspace beyond its limits.
- Script that runs in the console from a message, a file, a signature or a shared page, or a message's HTML or images that get past the sandboxed frame.
- A way to make the Assistant do more than the README says: send mail, change anything but a draft, or read what the person cannot reach.
- A forged signature that the workspace shows as good, or mail that goes out in the clear when it was meant to be encrypted.
- A secret that leaks from the Worker, the build, a log or a page.
- A way to run code, read a secret or deploy through this repository's workflows, for example from a pull request from a fork.

Out of scope:

- A deployment that departs from the README, or a problem in someone's own deployment that is not in this code: report it to whoever runs it (see below).
- The workspace reading mail encrypted to its people. It keeps their private keys and opens that mail on arrival, by design: OpenPGP here protects mail on its way, not from the workspace (README, OpenPGP).
- Text in a message or a file that steers what the Assistant says, as long as it can do no more than the README allows.
- An attack that first needs a workspace admin's account, or access to the Cloudflare account the workspace runs in: an admin can already reset any person's password.
- A vulnerability in Cloudflare, Better Auth, OpenPGP.js or another dependency that this code does not expose. Report it upstream; if this code exposes it, tell us.
- Scanner output, a missing header or a version number on show, without a way to exploit it.

## Testing

Test against a workspace of your own: `pnpm run dev` (CONTRIBUTING.md, Setup), or a deployment on your own Cloudflare account.

- Never test against a workspace you do not run, or send test mail to addresses that are not yours.
- Do not open pull requests or issues here to try an attack on the workflows. Reproduce it in a fork, with your own secrets.
- Do not access, change or delete data that is not yours, and stop once you have shown the problem.
- No denial of service, spam or social engineering of maintainers.

## Safe harbor

If you research and report a vulnerability in good faith and follow this policy, we consider your research authorized, we will not take legal action against you over it, and if someone else does, we will make it known that you acted within this policy.

## Running your own workspace

A deployment answers for itself: its accounts, its settings, its mail domain and its data are its own, and the maintainers cannot see them.

- Put your own address in `public/.well-known/security.txt` (served at `/.well-known/security.txt`) before you deploy, and a new `Expires` date. The file here names `security@example.com`.
- Keep `SESSION_SECRET` secret and long: it signs every link and seals every secret at rest, so whoever holds it holds the workspace. Rotating it signs everyone out and loses the OpenPGP private keys and the tokens kept sealed (README, OpenPGP).
- Deploy `main` again when an advisory says a fix is out.

## Security design

What the workspace does to keep a person's mail and files theirs. The details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the code named here.

| Area | Design |
| --- | --- |
| Accounts | Nobody signs up. Admins create mailboxes with a one-time password (`app/lib/users.server.ts`, `scripts/create-admin.mjs`). Passwords are PBKDF2-SHA256 hashes (100,000 iterations) in the `accounts` table, at least 12 characters (`app/lib/auth.server.ts`). |
| Sign-in | Better Auth (`app/lib/auth.server.ts`). The password form accepts same-origin posts only (`sameOriginPost`), is throttled per client and address (10 failures in 15 minutes, in KV) and sits behind Better Auth's own rate limits on `/api/auth/*`. Passkeys (WebAuthn) are bound to `APP_URL`'s origin. An authenticator app (TOTP, with backup codes) can be the second factor of a password sign-in; a trusted browser skips it for 30 days. |
| Sessions | Rows in D1 (`sessions`), 14 days, read on every request (no cookie cache), so "Sign out everywhere", a new password, an admin's reset or a deactivation ends a session at once. The session cookie is `HttpOnly`; the API takes the same token as a bearer token. |
| Forgotten passwords | Reset links go to personal recovery addresses the person confirmed first. A link is single use, lives 30 minutes, is stored as its SHA-256 and carries its token in the URL fragment, which no request or log holds (`app/lib/recovery.server.ts`). A new password (the person's own, an admin's or a reset), a deactivation or removing a confirmed recovery address voids every link mailed before (`revoke` in `app/lib/auth.server.ts`). |
| Mail | The HTML part of a message is sanitised (`app/lib/mail/sanitize.ts`) and shown in a sandboxed iframe whose document carries a Content-Security-Policy: no scripts, no forms, no frames, images from the web only when the reader asks. A spam filter judges mail on arrival. |
| OpenPGP | Each person's private key is sealed with AES-GCM under a key derived from `SESSION_SECRET`, so the Worker signs and opens mail without a passphrase; encrypted mail is opened on arrival and kept opened, so it is not end-to-end. A signature is checked against the sender's key alone (a colleague's for the workspace's own domain; else one the person imported, one an Autocrypt header taught from mail that passed DMARC or DKIM, or one the sender's domain publishes over WKD), never against a key the message carries. Encrypting to someone without a key is refused, never sent in the clear (`app/lib/mail/pgp/`). |
| Files | A message's files are served from signed links (HMAC under `SESSION_SECRET`, six hours) with a `sandbox` CSP of their own; Drive's files to the session that may reach them, through one gate (`app/lib/drive/access.server.ts`). |
| Links outside the workspace | Tokens are stored as their SHA-256, looked up by hash, throttled per client, and their pass cookies are scoped to `/s/`. A link stops when it is revoked, expires, or its maker loses access. |
| Signing requests | The customer opens a request with its link and a six-digit code mailed to them: 10 minutes, 5 tries, each taken in one conditional update before the code is compared (`app/lib/drive/visitor.server.ts`). Signing is one conditional update on the request's status, so of two posts one wins, and a fillable PDF's form is flattened before the fields are drawn, so nobody can type over a signed copy. |
| Assistant | Its tools reach only what the person may reach, through the same gates as the pages, and write nothing but a draft: it never sends mail (`app/lib/assistant/tools.server.ts`). What it reads goes to the model `AI_PROVIDER` names, through AI Gateway with the gateway's log off. Its answers are rendered as React nodes, never as HTML, and a link opens only on http(s), mailto or a path on this site. |
| Headers | Every answer gets `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'` unless it sets a frame rule of its own, and HSTS over HTTPS (`workers/worker.ts`). |
| Secrets at rest | A Microsoft 365 import's tokens, a person's GitHub token and OpenPGP private keys are encrypted with AES-GCM under a key derived from `SESSION_SECRET` (`app/lib/secret-box.server.ts`). Rotating the secret voids them, and every session. |
| Telemetry | PostHog is off unless `POSTHOG_PROJECT_TOKEN` is set; with it, the browser reports errors only, every address stripped of its query and fragment. Cloudflare's Workers Logs keep each request's full URL, which is why no page puts a secret in a query string. |
