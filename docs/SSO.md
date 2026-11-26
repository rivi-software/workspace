# Single sign-on

Workspace can be the identity provider of the other apps a team uses: one account (the mailbox on `MAIL_DOMAIN`), one password and one second factor, and every app an admin registers signs people in through it. The protocol is OpenID Connect, the authorization code flow with PKCE, which most apps and Cloudflare Access speak. The code is `app/lib/sso/` (the provider) and `app/lib/duo.server.ts` (Duo); it was ported from the RIVI monorepo's Workspace.

## How it works

```
browser ── GET /login ──▶ the app ── 302 ──▶ workspace.example.com/oauth/authorize?client_id=…&code_challenge=…
                                                  │  no session: /login?next=…, then back here
                                                  ▼
browser ◀── 302 redirect_uri?code=…&state=…&iss=… ◀── a code for this person and app (two minutes, single use)
   │
   ▼
the app ── POST /oauth/token (client secret + code_verifier) ──▶ Workspace ── { id_token, access_token }
the app verifies the ID token against GET /oauth/jwks and starts its own session.
```

- **Issuer**: `APP_URL`. The discovery document is `/.well-known/openid-configuration`; the endpoints are `/oauth/authorize`, `/oauth/token`, `/oauth/jwks`, `/oauth/userinfo` and `/oauth/logout` (`app/lib/sso/paths.ts`), served by the Worker (`workers/worker.ts`) before TanStack Start (`app/lib/sso/provider.server.ts`).
- **Who can sign in**: every active mailbox. The ID token carries `sub` (the person's id), `email`, `email_verified` (always true: the address is on the workspace's own domain), `name`, `auth_time`, `sid` (the Workspace session), `amr` (how they signed in, [below](#second-factor)), `role` (when the app's list gives them one) and the app's `nonce`. A deactivated person gets no token, and a code of theirs stops working at once.
- **Applications** are registered under **Settings → Applications** by an admin (`oauth_clients`): a name, the redirect URIs (matched exactly; https, or http on localhost), optional post-logout redirect URIs, an optional launch URL that puts the app under **Apps** in the account menu, whether PKCE is required (it is, unless the app cannot send a challenge), and **who can sign in**: everyone with an active mailbox, or only the people on the app's list (`oauth_client_members`), each with an optional **role** the app reads from the ID token's `role` claim (what a role means is the app's). Someone not on a listed app's list is sent back with `access_denied`, and Apps shows a person only the apps they may open. The secret (`wss_…`) is shown once, kept as its SHA-256, and can be rotated; the client id is `app_…`. Every app is confidential: the token endpoint takes `client_secret_basic` or `client_secret_post`.
- **Codes and tokens**: a code is kept as its hash in `oauth_codes` with what the token request must repeat and what the ID token needs, expires after two minutes and is deleted when redeemed, which is what makes it single use. ID and access tokens are ES256 JWTs that live an hour; the access token (`typ: at+jwt`) only opens `/oauth/userinfo`. There are no refresh tokens: an app keeps a session of its own and sends the browser through `/oauth/authorize` again when it ends.
- **Keys**: the signing key is made on first use and kept in `oauth_signing_keys` (`app/lib/sso/keys.server.ts`), its private half sealed with `SESSION_SECRET` like every secret at rest. **Rotate signing key** on the Applications tab makes a new one; the retired key stays in the key set for a day, so tokens signed just before still verify. Rotating `SESSION_SECRET` retires the key on its next use and makes a new one.
- **A fresh sign-in on demand**: an app that needs to be sure it is still the same person (a step-up before a destructive action) sends `prompt=login`, or `max_age=<seconds>`; Workspace then asks for the password and the second factor again (`/login?reauth=1`), replaces the old session with a new one whose `auth_time` is now, and comes back. A sign-in less than a minute old satisfies either, so nobody is asked twice. `prompt=none` answers `login_required` instead of showing a page.
- **Signing out**: `/oauth/logout` (the `end_session_endpoint`) ends the Workspace session and sends the browser to a registered post-logout URI (`state` kept) or to `/login`. Signing out of an app does not end the Workspace session unless the app sends the browser there; signing out of Workspace does not end an app's session.
- **Errors**: an unknown client or an unregistered redirect URI ends on an error page (nothing is sent to an address nobody registered); every other problem goes back to the redirect URI as `error` and `error_description`, with `state` and `iss` (RFC 9207).

## Second factor

Every way into Workspace is also the way into the apps that sign in through it, so the second factor protects them all. Which one confirms a sign-in depends on whether Duo is set up:

| | Duo on (the three `DUO_*` secrets set) | Duo off |
| --- | --- | --- |
| Password | Duo's Universal Prompt | The authenticator app (TOTP) of whoever set one up, or a backup code; the password alone for whoever did not |
| Passkey | Signs in on its own | Signs in on its own |
| Duo cannot take sign-ins | The authenticator app of whoever has one; else refused, or the password alone with `DUO_FAIL_OPEN=true` | — |

Each session records how it was signed in (`sessions.amr`, written by the `session.create.before` hook in `app/lib/auth.server.ts`), and the ID token's `amr` ([RFC 8176](https://www.rfc-editor.org/rfc/rfc8176)) says the same, so an app may insist on `mfa`:

| Sign-in | `amr` |
| --- | --- |
| Password, then Duo | `pwd` and what Duo reports (`mfa` with its factor, such as `otp`) |
| Password, then the authenticator app's code or a backup code | `pwd`, `otp`, `mfa` |
| Password on a device the authenticator app trusts (the 30-day checkbox) | `pwd`, `mfa` |
| Password alone | `pwd` |
| Passkey that verified the person (fingerprint, face, PIN) | `pop`, `mfa` |
| Passkey that did not | `pop` |

A session from before `amr` was kept says nothing, and its tokens carry no `amr`.

### Duo

Duo's Universal Prompt (the [Duo OIDC Auth API](https://duo.com/docs/oauthapi), what Duo's Web SDK v4 speaks) is the second step of every password sign-in while Duo is set up. The client is `app/lib/duo/client.ts` (HS512 JWTs with the client secret, no dependencies) and the glue is `app/lib/duo.server.ts`:

```
POST /login (password right) ──▶ Duo health check ──▶ 302 https://api-….duosecurity.com/oauth/v1/authorize?request=<signed JWT: duo_uname, state, nonce>
                                                        + a cookie on /auth/duo sealing { state, nonce, username, userId, next } (five minutes)
Duo ──▶ GET /auth/duo?state=…&duo_code=… ──▶ POST /oauth/v1/token (client assertion) ──▶ the ID token Duo signed: preferred_username, nonce, auth_result, amr
                                                        ──▶ the Better Auth session (amr: pwd + Duo's), the cookie cleared
```

What is checked: Duo's ID token signature with the client secret, its issuer (the token endpoint), audience (the client id), times, that `preferred_username` is the person who typed the password, the nonce of this very challenge, and `auth_result.result` (`allow`). The challenge lives in the sealed cookie, never in KV, so a prompt answered at another edge location still completes; Duo's code is single use and the challenge expires after five minutes. The Duo username is the person's address on `MAIL_DOMAIN`: give each Duo user that username, or add the address as an alias. With Duo on, the workspace checks the password itself (the same hash Better Auth reads), then makes the Better Auth session once Duo has answered (`startSession`), so sign-out, Settings → Account's sessions and the API's bearer token work as for any other sign-in. Better Auth's own password route (`POST /api/auth/sign-in/email`) is closed while Duo is on (`disabledPaths`), so nothing hands out a session on the password alone; an API client then signs in through the browser and reads its session token, or uses a passkey.

**Setting it up** (one Duo application, Workspace's; the apps that sign in through Workspace need none):

1. Duo Admin Panel → Applications → Protect an Application → **Web SDK** → Protect. Note the **Client ID** (20 characters), **Client secret** (40) and **API hostname** (`api-xxxxxxxx.duosecurity.com`).
2. Policy on the application: who may enrol at the first prompt (the new user policy), the allowed methods (Duo Push, passkeys, …), remembered devices if wanted.
3. `wrangler secret put DUO_CLIENT_ID`, `DUO_CLIENT_SECRET` and `DUO_API_HOST` (or fill them in on the Deploy to Cloudflare page). From the next request every password sign-in goes through Duo, and the sign-in button reads "Continue" (with Duo off it reads "Sign in").
4. Decide what happens while Duo is down. Each sign-in starts with Duo's health check; when it fails, someone with an authenticator app is asked for its code instead, and anyone else is refused with "Duo cannot confirm sign-ins right now" (`duo-unavailable`), logged as `duo.unavailable`. Set the var `DUO_FAIL_OPEN` to `true` in `wrangler.jsonc` to let the password alone through for them meanwhile (the session then says `amr: ["pwd"]`).

Nothing is stored about Duo in D1; turning it off is clearing the three secrets, after which the authenticator app and passkeys confirm sign-ins as before. Locally `.dev.vars.local.example` leaves Duo off (its redirect URI would be `http://localhost:5174/auth/duo`); the tests drive it against `fakeDuo` (`test/fake-duo.ts`).

### The authenticator app and passkeys

Without Duo, the second factor is Better Auth's: each person sets up an authenticator app (TOTP, with backup codes) or adds passkeys under Settings → Account, and a password sign-in by someone with an authenticator app continues at `/two-factor`. A passkey signs in on its own, with or without Duo: it is proof of a key the person holds, and two factors when the authenticator verified them, which the session records from the assertion's User Verified flag (`passkeyVerifiedUser`).

## Connecting an application

### Any OpenID Connect app

Discovery at `<APP_URL>/.well-known/openid-configuration`, the authorization code flow, PKCE S256, `client_secret_basic` or `client_secret_post`, ES256 ID tokens. Register the app under **Settings → Applications** with the redirect URI it shows, then give it the client id, the secret and the issuer (`APP_URL`).

Locally the seed registers `app_local_example` (secret `dev-sso-client-secret`, redirect `http://localhost:5175/auth/callback`), which `pnpm run smoke` signs the admin in to.

### Cloudflare Access

Zero Trust → Settings → Authentication → Login methods → **OpenID Connect**:

| Field | Value |
| --- | --- |
| Name | Workspace |
| App ID | the client id from Settings → Applications |
| Client secret | its secret |
| Auth URL | `<APP_URL>/oauth/authorize` |
| Token URL | `<APP_URL>/oauth/token` |
| Certificate URL | `<APP_URL>/oauth/jwks` |
| Proof Key for Code Exchange (PKCE) | on |
| OIDC claims | `email` (and `name`) |
| Scopes | `openid email profile` |

Register the client in Workspace first with the redirect URI Cloudflare shows (`https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`). An Access application registered in Workspace with **Everyone** lets every mailbox through to Access, whose policy decides the rest; with a list, Workspace decides first. Workspace itself cannot sit behind the login method it provides; if it sits behind Access at all, Access must bypass the paths an app's server calls without a browser: `/.well-known/openid-configuration`, `/oauth/token`, `/oauth/jwks` and `/oauth/userinfo`.

## Operations

- **Rotate a client secret** (leaked, or someone who knew it left): Settings → Applications → Rotate secret, then update the app; the old one stops at once.
- **Rotate the signing key**: Settings → Applications → Rotate signing key. Nothing else to do; apps pick up the new key from the key set.
- **Deactivate an application**: its sign-ins stop at the authorization endpoint and its codes at the token endpoint; its registration stays for when it returns.
- **Revoke a person**: deactivate the mailbox under Settings → People (no new tokens; a session an app already holds lasts until that app ends it), or take them off a listed app's list.
- **Someone lost their Duo device**: the Duo admin issues a bypass code or resets the device in the Duo Admin Panel; a passkey of theirs still signs them in.
- **Someone lost their authenticator app or passkey**: an admin resets the second factor or removes the passkeys on their row under Settings → People, as without single sign-on.
- **Local checks**: `pnpm run test` covers the provider end to end (`test/sso.test.ts`) and the Duo step (`test/duo.test.ts`); `pnpm run smoke` signs the seed admin in to the seeded application against a running server.

## Not yet

- Refresh tokens, `client_credentials`, public clients (dynamic registration) and OAuth for APIs (an app calling another app's API as the person, MCP): the monorepo's Workspace has them, built on this.
- Back-channel logout (ending every app's session when the Workspace session ends).
- Requiring a second factor of everyone without Duo: today someone without an authenticator app or passkey signs in with the password alone, and the ID token says so (`amr: ["pwd"]`).
