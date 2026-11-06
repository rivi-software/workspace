# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it in one of two ways:

1. Open a **private security advisory** on GitHub: the repository's **Security** tab, then **Report a vulnerability**. Only the maintainers see it until a fix is out.
2. Email the address the organisation that deploys this workspace publishes in `public/.well-known/security.txt` (served at `/.well-known/security.txt`). The file in this repository names `security@example.com`; replace it with your own address before you deploy.

Say what you found, where (a path, a module, a request), how to reproduce it and what it lets an attacker do. You will get an acknowledgement within five working days and a fix, or a reason why there is none, as soon as we have one. Please give us time to ship the fix before you publish.

## Security design

What the workspace does to keep a person's mail and files theirs. The details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the code named here.

| Area | Design |
| --- | --- |
| Accounts | Nobody signs up. Admins create mailboxes with a one-time password (`app/lib/users.server.ts`, `scripts/create-admin.mjs`). Passwords are PBKDF2-SHA256 hashes (100,000 iterations) in the `accounts` table, at least 12 characters (`app/lib/auth.server.ts`). |
| Sign-in | Better Auth (`app/lib/auth.server.ts`). The password form accepts same-origin posts only (`sameOriginPost`), is throttled per client and address (10 failures in 15 minutes, in KV) and sits behind Better Auth's own rate limits on `/api/auth/*`. Passkeys (WebAuthn) are bound to `APP_URL`'s origin. An authenticator app (TOTP, with backup codes) can be the second factor of a password sign-in; a trusted browser skips it for 30 days. |
| Sessions | Rows in D1 (`sessions`), 14 days, read on every request (no cookie cache), so "Sign out everywhere", a new password, an admin's reset or a deactivation ends a session at once. The session cookie is `HttpOnly`; the API takes the same token as a bearer token. |
| Forgotten passwords | Reset links go to personal recovery addresses the person confirmed first. A link is single use, lives 30 minutes, is stored as its SHA-256 and carries its token in the URL fragment, which no request or log holds (`app/lib/recovery.server.ts`). |
| Mail | The HTML part of a message is sanitised (`app/lib/mail/sanitize.ts`) and shown in a sandboxed iframe whose document carries a Content-Security-Policy: no scripts, no forms, no frames, images from the web only when the reader asks. A spam filter judges mail on arrival. |
| Files | A message's files are served from signed links (HMAC under `SESSION_SECRET`, six hours) with a `sandbox` CSP of their own; Drive's files to the session that may reach them, through one gate (`app/lib/drive/access.server.ts`). |
| Links outside the workspace | Tokens are stored as their SHA-256, looked up by hash, throttled per client, and their pass cookies are scoped to `/s/`. A link stops when it is revoked, expires, or its maker loses access. |
| Headers | Every answer gets `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'` unless it sets a frame rule of its own, and HSTS over HTTPS (`workers/worker.ts`). |
| Secrets at rest | A Microsoft 365 import's tokens and a person's GitHub token are encrypted with AES-GCM under a key derived from `SESSION_SECRET` (`app/lib/secret-box.server.ts`). Rotating the secret voids them, and every session. |
| Telemetry | PostHog is off unless `POSTHOG_PROJECT_TOKEN` is set; with it, the browser reports errors only, every address stripped of its query and fragment. Cloudflare's Workers Logs keep each request's full URL, which is why no page puts a secret in a query string. |
