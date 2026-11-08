<p align="center">
  <a href="https://rivi.software">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/rivi-workspace-on-dark.svg">
      <img src="assets/rivi-workspace.svg" alt="RIVI Workspace" width="405">
    </picture>
  </a>
</p>

<p align="center">
  Mail, Drive, an Assistant, Calendar and Tasks for a team, in one Cloudflare Worker.<br>
  Open source, from <a href="https://rivi.software">RIVI Software</a>.
</p>

<p align="center">
  <a href="https://github.com/rivi-software/workspace/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/rivi-software/workspace/ci.yml?branch=main&label=CI" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0b6b3a" alt="MIT License"></a>
</p>

<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/rivi-software/workspace"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare"></a>
</p>

<p align="center">
  <a href="#run-locally">Run locally</a>
  ·
  <a href="#deploy">Deploy</a>
  ·
  <a href="#commands">Commands</a>
  ·
  <a href="docs/ARCHITECTURE.md">Architecture</a>
  ·
  <a href="docs/API.md">API</a>
  ·
  <a href="GLOSSARY.md">Glossary</a>
  ·
  <a href="AGENTS.md">AGENTS.md</a>
  ·
  <a href="https://rivi.software">rivi.software</a>
</p>

<br>

Workspace is an open-source workspace that runs on Cloudflare: **Mail** (receiving through Email Routing, sending through Email Sending or Amazon SES; the mailboxes in D1, the raw messages and files in R2), **Drive** (every person's folders and files in R2, shared with colleagues, or outside the workspace by link and invite, with PDFs sent for signatures), an **Assistant** (a chat over your own mail and files, on Workers AI through AI Gateway, or Anthropic), **Calendar** and **Tasks** (events with invited colleagues, to-dos linked with GitHub Issues). One Worker, one D1 database, two R2 buckets and two KV namespaces; a TanStack Start app built with the Cloudflare Vite plugin, sign-in on Better Auth.

## Mail

- **Inbox, Starred, Snoozed, Sent, Scheduled, Drafts, All mail, Spam, Trash and your labels**, with unread counts in the sidebar, pages of 25, 50 or 100 conversations, and a list that refreshes once a minute while the tab is open (with a desktop notification for new mail, if asked for). The trash and the spam folder let go of what has been in them for 30 days, or at once with "Empty".
- **Search** over all mail: words and phrases, `from:`, `to:`, `subject:`, `has:attachment`, `is:unread`, `is:starred`, `is:read`, `is:snoozed`, `in:trash`, `label:`, `before:` and `after:`, any of them negated with `-`.
- **Reading**: the list beside the open conversation on a wide screen (or one at a time, Settings → Mail), messages threaded by their References headers (then by subject and sender), the HTML part shown safely (sandboxed, no scripts, images from the web only on request, or always from the senders you choose, never in Spam), image attachments as thumbnails and the rest as downloads, the quoted text folded, expand or collapse all, previous and next conversation, reply, reply all, forward, print and "Download original" per message, and **Unsubscribe** from a mailing that offers it.
- **Your own copies**: a message to one of your own addresses is one message, in Inbox and Sent, whichever arrives first: the sent copy or the one Email Routing brings back.
- **Spam filter**: mail that looks like spam goes to Spam on arrival, and the conversation says why: what Cloudflare's own checks found (its spam score, SPF, DKIM and DMARC), mail that claims to come from your domain but was sent elsewhere, a program or a web page among the files, a link that shows one site and goes to another, a sender's name that shows another address, and what the filter learnt. **Report spam** and **Not spam** teach a filter of your own (Bayesian, on the words, the sender and the links), which also learns from mail by the people you write to; their mail never goes to Spam. Block a sender or a whole domain from a message's menu, or say one is never spam, under Settings → Mail → Spam.
- **Organising**: select one or many conversations and archive, trash, mark as spam, read, unread, star, snooze, label or mute them, with **Undo** on the toast; **Snooze** puts a conversation out of the inbox until later today, tomorrow, the weekend, next week or a moment of your own; **Mute** keeps its replies out of the inbox; **Labels** (coloured) mark conversations across folders; **Filters** run on every message that arrives and skip the inbox, mark read, star, label, trash, mark it spam or keep it out of Spam; the **vacation responder** answers each person once in four days, between the dates set, never a list or a machine.
- **Compose**: rich text (bold, italic, underline, lists, quotes, links; pasted formatting reduced to that), recipients as chips with suggestions from the people you have written to or heard from, a reply box under the conversation with the original quoted, From among your addresses, Cc and Bcc, attachments up to 20 MB kept on the draft as soon as they are chosen, drafts that save themselves, and a signature picked from yours.
- **Undo send and Send later**: a message waits a few seconds before it leaves (Settings → Mail), with **Undo** on the toast; **Send later** sends it tomorrow morning, tomorrow afternoon, Monday morning or at a moment of your own. A scheduled message waits under **Scheduled** until the cron sends it; **Cancel send** turns it back into a draft, and a send that fails puts it back among the drafts with the reason.
- **Signatures** (Settings → Account): several, with a default for new messages and one for replies and forwards, written in the rich editor with images (a logo) or pasted as HTML from a signature generator. Their images go out as inline attachments, so they show without "Load images".
- **OpenPGP** (Settings → Mail): make a key or import the one you have, and sign or encrypt a message with the switches beside Send (signing every message can be the default). Mail that arrives signed or encrypted, as PGP/MIME or as an inline block, is opened with your key and its signature checked against the sender's key: one you imported, one their earlier mail carried in an Autocrypt header (believed only of mail that passed DKIM for their domain), or one their domain publishes over WKD. Your own key is published over WKD and travels on what you sign ([OpenPGP](#openpgp)). The workspace keeps your private key and opens what is encrypted to you as it arrives, so search, the spam filter and the Assistant read that mail too: it protects mail on its way, not from the workspace.
- **Import** (Settings → Mail): connect your own Microsoft 365 mailbox and its mail comes in, oldest first, a batch a minute in the background: Inbox to the inbox, Sent Items under Sent, your folders and Outlook's categories as labels, flags as stars, read as read; nothing already here is copied twice. The workspace only reads the mailbox ([Microsoft 365 import](#microsoft-365-import)).
- **Keyboard** (`?` lists them):

  | Keys | What they do |
  | --- | --- |
  | `c`, `/`, `?` | Compose, search, the list of shortcuts |
  | `j` `k`, `Enter`, `u` | Next or previous conversation, open it, back to the list |
  | `x`, `* a`, `* n`, `* u` | Select; select all on the page, none, the unread ones |
  | `e`, `#`, `!`, `s`, `b`, `l`, `m` | Archive, trash, spam, star, the snooze menu, the label menu, mute |
  | `I`, `U` | Mark read, mark unread |
  | `r`, `a`, `f`, `;` | Reply, reply all, forward, expand or collapse all |
  | `z` | Undo the last action |
  | `⌘Enter` | Send; `⌘B` `⌘I` `⌘U` `⌘K` are bold, italic, underline and link in the editor |
  | `g i`, `g s`, `g b`, `g t`, `g d`, `g a`, `g p`, `g x` | Inbox, Starred, Snoozed, Sent, Drafts, All mail, Spam, Trash |
  | `g f`, `g c`, `g k`, `g h`, `g ,` | Drive, Calendar, Tasks, the Assistant, Settings |
  | `⌘B`, `⌘J` | Collapse or open the sidebar; the Assistant |

## Drive

- **My Drive**: folders in folders, files in them, a list with each item's kind, owner, time and size, sorted by name, time or size, breadcrumbs above the open folder, and a search over every name you can see. The sidebar shows how much your files take.
- **Upload**: files chosen or dropped on the list, several at once, or a whole folder with its folders made as they were; a file goes whole up to 32 MB and in parts above that, up to 5 GB, with a panel showing each one's progress and a cancel.
- **Files**: a page per file with a preview where the browser can show one (images, audio and video that seek, PDFs, text and code), its details, **Download**, **Open in a new tab**, and the actions below.
- **Organising**: select one or many and **Rename**, **Move**, **Star** or **Trash** them, with **Undo**; the **Trash** keeps things for 30 days, or until **Restore**, **Delete forever** or **Empty trash**; **Recent** lists the files you touched last.
- **Sharing**: a folder or a file of yours with a colleague as **viewer** (read and download) or **editor** (also add, rename, move and trash within it), or with **everyone in the workspace**; a shared folder shares everything in it. **Shared with me** lists what others shared with you.
- **Sharing outside the workspace**: anyone who reaches a file or folder makes a **link** (whoever has it views, after its password when it has one) or **invites an address** (that person confirms with a code mailed to them), to view and, unless downloads are off, download. A link ends after 30 days unless its maker chose another date or none, and stops at once when its maker or the owner stops it. An admin turns all of it off and on under Settings → Drive, which also lists every link and invitation with who made it and how often it was opened.
- **Signatures**: from a PDF's page, **Request signatures** opens an editor: place fields on its pages (a signature, a text, the date signed, a box to tick) for the **customer** or for your organisation, fill in your texts and boxes, name the customer and who signs on your side (you or a colleague), and send. The request goes out from your own mailbox; the customer confirms their address with a code mailed to it, fills in their fields and signs (drawn or typed), or declines with a reason. Then your side signs: tick **Sign automatically** and your saved signature does it the moment the customer has signed; otherwise the signer is mailed and signs on the request's page. The signed copy, with a certificate page that records every step, its time, address and browser, lands in Drive beside the original and is mailed to the customer. **Signatures** in the sidebar lists your requests and what waits for your signature, and keeps your own signature. Sending needs sharing outside the workspace to be on.
- **Keyboard**:

  | Keys | What they do |
  | --- | --- |
  | `g f` | Drive |
  | `n`, `u` | New folder, upload files |
  | `j` `k`, `Enter`, `⌫` | Next or previous row, open it, up a level |
  | `x`, `s`, `r`, `m` | Select, star, rename, move |
  | `#` | Trash, or delete from the trash |
  | `/` | Search |

## Assistant

- **A conversation** at `/assistant` (`⌘J`, or `g h`), the recent ones in the sidebar, each a document of your questions and the assistant's answers with the steps it took in between ("Searched mail for “the plan” · 3 conversations", with a link). Answers stream as they are written; **Stop** cuts one short; a conversation can be deleted for good.
- **What it can do**: search mail in the search box's language over All mail or a folder, read a conversation, search Drive by name or list the recent files, read a text file (plain text, Markdown, CSV, JSON, code, up to 256 KB), and **prepare a draft**: a reply to a conversation or a new message, left in Drafts with a link to the composer. It never sends mail and changes nothing else. **Ask the assistant** in a conversation's menu in Mail opens it with a question about that conversation.
- **The model**: `AI_PROVIDER` in `wrangler.jsonc` names it: `workers-ai` runs `AI_CHAT_MODEL` (Llama 3.3 70B by default) on Workers AI through AI Gateway, `anthropic` a Claude model through the gateway's provider-native endpoint (the gateway holds the key), `mock` a deterministic stand-in for the tests and local development. What the assistant reads to answer goes to that model; the gateway's log is off for every call.

## Calendar and Tasks

- **Calendar** at `/calendar` (`g c`): a **week** of hours or a **month** of days, Monday first, moved by the arrows, `[` and `]`, **Today** (`t`) or the small month in the sidebar. An **event** has a title, a time or whole days, a place, a note, and repeats daily, weekly, monthly or yearly until a day (a weekly 10:00 stays 10:00 across the clock change). Press an empty slot or **New event** (`n`) to add one. **Invite colleagues**: they see the event on their own calendar and **Accept** or **Decline**, and the owner sees who answered what. The calendar also shows your **tasks** on their due day.
- **Tasks** at `/tasks` (`g k`): the open tasks grouped as **Overdue**, **Today**, **Upcoming** and **No date**, a line at the top to add one quickly, and **Done** for what was ticked off in the last year, with **Reopen**. A task has a title, notes, a due day and a priority.
- **GitHub Issues**: under Settings → Tasks a person connects GitHub with a personal access token of their own (fine-grained, Issues: read and write on the repositories they work in; kept encrypted, never shown again). The Tasks page then lists the **open issues assigned to them**, each with **Add to tasks**; a task can also be linked to an issue by `owner/name#123` or its address. Marking such a task done **closes the issue**, reopening it reopens the issue. A GitHub that does not answer leaves the section out; the tasks stay.
- **Keyboard**:

  | Keys | What they do |
  | --- | --- |
  | `g c`, `g k` | Calendar, Tasks |
  | `n` | New event, or new task |
  | `t`, `[`, `]` | Today, previous, next |
  | `w`, `m` | Week view, month view |

## Settings

| Page | What is there |
| --- | --- |
| Settings → Account | Your name, password, passkeys, authenticator app and backup codes, sessions ("Sign out everywhere"), signatures, recovery addresses. |
| Settings → Mail | The reading layout, the undo-send delay, the page size, labels, filters, the spam filter's blocked and allowed senders, the senders whose images always load, your OpenPGP key and the keys of the people you write to, the vacation responder, the Microsoft 365 import. |
| Settings → Drive | Sharing outside the workspace on or off, and every link and invitation with who made it and how often it was opened (admins). |
| Settings → Tasks | The GitHub connection. |
| Settings → People | Mailboxes, aliases, roles, one-time passwords, deactivation, each person's passkeys, authenticator app, recovery addresses and sessions (admins). |

## Sign-in and accounts

Sign-in runs on [Better Auth](https://www.better-auth.com) (`app/lib/auth.server.ts`), served by the Worker at `/api/auth/*`.

- **Accounts**: nobody signs up. An admin creates a mailbox under Settings → People, an address on the mail domain with a name and a one-time password shown once; the first admin comes from `pnpm run admin:create` ([Deploy](#deploy)). Everyone changes their own password, name and signatures under Settings → Account.
- **Password**: at least 12 characters, kept as a PBKDF2 hash. The sign-in form only accepts posts from the workspace's own origin, and stops after 10 failed attempts per client and address for 15 minutes; Better Auth's own rate limits sit on `/api/auth/*` as well.
- **Passkeys**: a sign-in of its own, with Touch ID, Windows Hello, a phone or a security key, added under Settings → Account. A passkey is bound to the workspace's address (`APP_URL`).
- **Authenticator app**: the second factor of a password sign-in. Once set up under Settings → Account, a password sign-in continues on `/two-factor` with the app's six-digit code, or one of the backup codes shown once at setup; "Don't ask again on this browser for 30 days" trusts that browser.
- **Sessions**: 14 days, kept in the database and read on every request. Settings → Account lists your sessions, signs one out, or signs out everywhere at once. A new password, however it is set, and a deactivation end every session of the person at once.
- **Admins** (Settings → People) also reset a person's password to a new one-time password, remove their passkeys, reset their authenticator app (for a lost phone), add aliases, change roles, and deactivate a person (their mail stays, their sign-in stops). `pnpm run admin:create` does the same for a locked-out admin from the command line.
- **Forgotten passwords**: under Settings → Account a person adds up to three personal recovery addresses outside the mail domain, each confirmed from a link mailed to it. **Forgot your password?** on the sign-in page mails a single-use link (30 minutes) to the confirmed ones; choosing a new password there signs out every session. A passkey or authenticator app still confirms the next sign-in.
- **Other clients**: the Workspace API at `/api/v1` takes a Better Auth session token as a bearer token ([docs/API.md](docs/API.md)).

## Run locally

Node 24 and pnpm 12 (`corepack enable` installs the pinned version).

```sh
cp .dev.vars.local.example .dev.vars   # example.com mailboxes, a dev session secret, the mock Assistant, PostHog off
pnpm install
pnpm run setup                   # the local D1 migrations and the seed
pnpm run dev                     # http://localhost:5174
```

The seed has two accounts, **admin@example.com** and **sam@example.com**, both with the password `password`, and `hello@example.com` as an alias of the admin.

- `pnpm run email:simulate "Lunch on Friday?" "Are you free?"` delivers an inbound message to the dev server's `email()` handler (`TO=` and `FROM=` change the envelope).
- Sent mail never leaves the machine: Miniflare writes each message under `.wrangler/tmp/email/`. Set `"remote": true` on the `send_email` binding in `wrangler.jsonc` to send real mail from local dev through your `wrangler login`.
- The cron does not run by itself in dev; `curl "http://localhost:5174/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"` runs it once (snoozes, scheduled messages, a batch of each import).
- The Assistant answers from the mock model (`AI_PROVIDER=mock`): it calls its tools on a few phrasings ("search my mail for lunch", "find files named plan", "read the conversation th_…", "draft a reply to th_… saying …") and echoes anything else. Set `AI_PROVIDER=workers-ai` in `.dev.vars` to talk to the real model; the AI binding is remote even in local dev and needs `wrangler login`.
- `pnpm run smoke` runs the whole flow against a running server (`BASE_URL`, default `http://localhost:5174`).

## Deploy

With the button, or from the command line. Either way the mail domain and the first admin take a step of their own afterwards.

### Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rivi-software/workspace)

The [button](https://developers.cloudflare.com/workers/platform/deploy-buttons/) copies this repository to your GitHub or GitLab account, creates the database, the two KV namespaces and the two buckets, writes their ids into the copy's `wrangler.jsonc`, builds and deploys the Worker, and deploys again on every push to the copy (Workers Builds). Its page asks for:

| Field | What to enter |
| --- | --- |
| Git account, project name | Where the copy goes, and the Worker's name. |
| The KV namespaces | Different names for the two: `workspace-kv` for `KV` and `workspace-previous-assets` for `PREVIOUS_ASSETS`. |
| The database and the buckets | The names it suggests, unless the account already runs a workspace: then it selects that workspace's `workspace-db`, `workspace-mail` and `workspace-drive`, and a second workspace needs **new** ones of its own. |
| `SESSION_SECRET` | The output of `openssl rand -base64 48`. The other secrets stay empty unless you send through [Amazon SES](#amazon-ses) or use the [Microsoft 365 import](#microsoft-365-import). |
| `APP_URL` | The Worker's address: `https://<project name>.<your subdomain>.workers.dev` (the subdomain is on **Workers & Pages**), or a custom domain. |
| `MAIL_DOMAIN` | The domain the mailboxes are on; it must be a zone on the same account. The other variables are in the table of step 3 below. |
| Build and deploy commands | Keep `pnpm run build` and `pnpm run deploy` (step 6 below says what it does), and turn **preview builds** off: the workspace runs at one address, `APP_URL`. |

Then clone the copy, run `pnpm install` and `wrangler login`, and continue with the mail domain (step 4 below) and the first admin (step 7). A later change to `wrangler.jsonc` in the copy, such as `addresses` or a custom domain in `routes`, deploys with the push that makes it.

### From the command line

1. `wrangler login` (an account with Workers, D1, KV, R2 and Email Routing).
2. Create the resources and paste their ids into `wrangler.jsonc` (`database_id`, the two KV `id`s; the buckets are bound by name):

   ```sh
   wrangler d1 create workspace-db
   wrangler kv namespace create workspace-kv
   wrangler kv namespace create workspace-previous-assets
   wrangler r2 bucket create workspace-mail
   wrangler r2 bucket create workspace-drive
   ```

   `wrangler deploy` fails on a binding whose bucket does not exist, so the buckets come first. The AI binding needs nothing made: AI Gateway creates the `default` gateway on the first call.

3. Settings in `wrangler.jsonc` (`vars`):

   | Setting | Value |
   | --- | --- |
   | `APP_NAME` | What the pages, the mails and the passkeys call the workspace. |
   | `APP_URL` | The Worker's address, with scheme: the origin of every link in a mail, of every passkey and of the sign-in forms. A custom domain through `routes` (`"routes": [{ "pattern": "workspace.example.com", "custom_domain": true }]`; Wrangler creates the DNS record and certificate on deploy), or the Worker's workers.dev address with `"workers_dev": true`. One origin either way; preview URLs stay off. |
   | `MAIL_DOMAIN` | The domain every mailbox is an address on. |
   | `SES_REGION` | Amazon SES's region, when SES sends ([Amazon SES](#amazon-ses)). |
   | `AI_PROVIDER`, `AI_GATEWAY_ID`, `AI_CHAT_MODEL` | The Assistant's model ([Assistant](#assistant)). `mock` runs the workspace without a model. |
   | `AI_TEXT_ANALYTICS` | `on` sends the Assistant's prompts and answers to PostHog AI observability beside the counts; anything else sends counts only ([PostHog](#posthog)). |
   | `POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST` | PostHog, optional; an empty token keeps it off. |

4. The mail domain:
   - **Email Routing** (inbound): onboard `MAIL_DOMAIN` in the Cloudflare dashboard (Email Routing holds the MX records; turn **Subaddressing** on so `+tags` work). Then list in `addresses` the mailbox addresses, or the catch-all `*@<MAIL_DOMAIN>`: Wrangler creates a rule per entry on every deploy that delivers the address to the Worker's `email()` handler ([Email Routing](#email-routing)).
   - **Email Sending** (outbound through the `send_email` binding): onboard the domain in Email Service → Email Sending (DKIM, SPF and DMARC records). Or send through Amazon SES ([Amazon SES](#amazon-ses)); the binding then stands in whenever SES refuses a message.

5. Secrets, with `wrangler secret put <NAME>`:

   | Secret | Needed | What for |
   | --- | --- | --- |
   | `SESSION_SECRET` | yes | Signs the session cookies, the file links and every sealed value. A long random value: `openssl rand -base64 48`. Rotating it signs everyone out and voids the sealed tokens (a running import, the GitHub connections). |
   | `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY` | optional | Amazon SES ([Amazon SES](#amazon-ses)). |
   | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID` | optional | The Microsoft 365 import ([Microsoft 365 import](#microsoft-365-import)). |

   `AI_PROVIDER=anthropic` needs no secret in the Worker: the AI Gateway holds the Anthropic key (BYOK, in the gateway's settings).

6. `pnpm run build`, then `pnpm run deploy`: the D1 migrations on the remote database, the build's client files into the `PREVIOUS_ASSETS` namespace, so a tab open on an earlier build can still load its chunks for seven days (`@rivi-software/cloudflare-deploy`), then `wrangler deploy`. Workers Builds runs the same two commands for a deploy made with the button.
7. The first admin: `pnpm run admin:create --remote --email you@<MAIL_DOMAIN> --name "You"` prints a one-time password. Sign in, change it under Settings → Account, then add the team under Settings → People. The same command resets a locked-out admin (a new password, every session ended, the authenticator app reset).

### Email Routing

Inbound mail only reaches the Worker through an Email Routing rule, and Wrangler owns the rules for the entries in `addresses`: it creates or updates them on every deploy. Two ways to route the mail:

- **Literal addresses**: list every mailbox (`"ada@example.com"`), and deploy when one is added. Nothing else changes.
- **The catch-all** `"*@example.com"`: every address without a rule of its own reaches the Worker, which delivers to the mailbox or alias and refuses the rest, so the sender gets a bounce.

A rule or the catch-all made in the dashboard for the same address is a destructive change Wrangler applies only after an interactive yes, so a CI deploy fails until it is freed in the dashboard first. A `+tag` reaches the address before the plus. The raw message is kept as `.eml` in the `workspace-mail` bucket.

### Amazon SES

Outbound mail goes through [`@rivi-software/workers-mail`](https://github.com/rivi-software/tools/tree/main/packages/workers-mail#readme): Amazon SES once the Worker holds `SES_ACCESS_KEY_ID` and `SES_SECRET_ACCESS_KEY` (`SES_REGION` is a var), and the Email Service `send_email` binding until then and whenever SES refuses a message. For SES, verify `MAIL_DOMAIN` as an identity in `SES_REGION`, make an IAM user with `ses:SendEmail` on that identity, and put its access key in the two secrets. The `Message-ID` the provider gives a message is its own, so replies and the copy that comes back to the sender thread on it.

### OpenPGP

Each person's key lives in D1 with its private half sealed under `SESSION_SECRET` (AES-GCM, as the other secrets at rest), so the Worker signs and opens mail without asking for a passphrase. Rotating `SESSION_SECRET` loses every private key: export yours from Settings → Mail first, and import it again after.

- **Sending**: signed or encrypted mail goes out as PGP/MIME (RFC 3156), written out in full by the Worker and sent raw through `@rivi-software/workers-mail`'s `sendRawMail`. Through SES it carries an `Autocrypt` header with the sender's key; Email Service refuses that header, so through the binding it goes without, one copy per recipient (its raw API takes one envelope recipient), and each copy gets its own `Message-ID` from Email Service. A reply from anyone but the first recipient may then thread by subject rather than by `In-Reply-To`.
- **Publishing (WKD)**: the Worker serves each active person's key at `/.well-known/openpgpkey/…`, by the advanced method (`openpgpkey.<MAIL_DOMAIN>`) and the direct one (`<MAIL_DOMAIN>` itself). For other mail clients to find the keys, route `openpgpkey.<MAIL_DOMAIN>/.well-known/openpgpkey/*` to the Worker (a route in `wrangler.jsonc`, with a proxied DNS record for the name), or `<MAIL_DOMAIN>/.well-known/openpgpkey/*` when nothing else serves the bare domain. A request names the address in `?l=`, as GnuPG, Thunderbird and OpenPGP.js send it.
- **Looking up**: a key for a correspondent is the one the person imported, one an Autocrypt header of their mail carried, or one their domain publishes over WKD (a miss is remembered in KV for a day). Encrypting to someone with none is refused, never sent in the clear.

### Microsoft 365 import

A person imports their own Microsoft 365 mailbox through Microsoft Graph: OAuth 2.0 with PKCE as themselves (delegated `Mail.Read`, `User.Read` and `offline_access`, read-only), then the cron copies each message's original MIME. Off until the workspace is registered with Microsoft, once, by an admin of the Microsoft 365 tenant:

1. [Microsoft Entra admin center](https://entra.microsoft.com) → **App registrations** → **New registration**: a name, *Accounts in this organizational directory only*, a redirect URI of type **Web**: `<APP_URL>/api/import/microsoft/callback` (add `http://localhost:5174/api/import/microsoft/callback` for local development).
2. **API permissions** → Microsoft Graph → **Delegated**: `Mail.Read`, `User.Read`, `offline_access`. Grant admin consent for the organisation, or each person consents for their own mailbox on connecting.
3. **Certificates & secrets** → a new client secret; note its expiry.
4. The Worker's secrets: `MICROSOFT_CLIENT_ID` (the Application (client) ID), `MICROSOFT_CLIENT_SECRET` and `MICROSOFT_TENANT_ID` (the Directory (tenant) ID; empty lets any work account connect).

Settings → Mail → Import then shows **Connect Microsoft 365**.

### PostHog

Optional. With `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST` set in `wrangler.jsonc`, the browser reports errors only (no autocapture, pageviews, replay or heatmaps: a page here shows a person's mail), through [`@rivi-software/posthog-tanstack-start`](https://github.com/rivi-software/tools/tree/main/packages/posthog-tanstack-start#readme), with every address stripped of its query and fragment. The Worker reports server errors, and the Assistant's calls to PostHog AI observability (`app/lib/ai-telemetry/`): a turn is a trace on the person, each step a generation and each tool a span, with the prompts and answers only when `AI_TEXT_ANALYTICS` is `on`. Set `POSTHOG_PERSONAL_API_KEY` in the build's environment to upload source maps. An empty token keeps all of it off, as `.dev.vars.local.example` does for local development and CI.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm run dev` | `wrangler types`, then the Vite dev server on http://localhost:5174 with every binding in Miniflare. |
| `pnpm run build` | `wrangler types`, then the production build into `dist/`. |
| `pnpm run build:check` | `wrangler deploy --dry-run` of the build, then `workers-bundle-check`: no source map the assets would serve, no value shaped like a secret, no forbidden marker in the Worker (`workers-bundle-check.config.ts`). |
| `pnpm run preview` | The build, served by `vite preview`. |
| `pnpm run check` | `wrangler types`, then the TypeScript project build (`tsc -b`). |
| `pnpm run lint`, `pnpm run fix` | `wrangler types`, then Oxlint with the rules that read the types; the autofixes and Oxfmt, which the pre-commit hook runs over the staged files. |
| `pnpm run format`, `pnpm run format:check` | Oxfmt; the check CI runs. |
| `pnpm run contracts:check` | Fails when `migrations/` does not match `app/db/schema.ts`, or a recorded migration no longer matches its hash in `migrations/JOURNAL.json`. |
| `pnpm run verify:static` | `check`, `lint`, `contracts:check` and `format:check`. |
| `pnpm run verify` | `verify:static`, then `test`, `build` and `build:check`: the full gate. |
| `pnpm run test` | Vitest inside workerd, with the migrations applied to a fresh database. |
| `pnpm run types` | `wrangler types` alone (`worker-configuration.d.ts`). |
| `pnpm run db:generate` | A new migration from `app/db/schema.ts` (drizzle-kit), recorded in `migrations/JOURNAL.json`. |
| `pnpm run db:migrate`, `pnpm run db:migrate:remote` | Apply the migrations to the local, or the remote, D1 database. |
| `pnpm run db:seed` | The seed (`seed/seed.sql`, rendered with a real password hash) into the local database. |
| `pnpm run db:reset` | Drop the local state, migrate and seed again. |
| `pnpm run setup` | `db:migrate` and `db:seed`. |
| `pnpm run admin:create` | Create or reset an admin: `--remote` or `--local`, `--email`, `--name`, optionally `--password` (12+ characters; else one is generated and printed). |
| `pnpm run smoke` | The end-to-end smoke test against a running server (`BASE_URL`). |
| `pnpm run email:simulate` | Deliver an inbound message to the dev server (`"Subject" "Body"`, `TO=`, `FROM=`, `IN_REPLY_TO=`). |
| `pnpm run deploy` | The remote migrations, `deploy:assets`, then `wrangler deploy`, of the build `pnpm run build` made. |
| `pnpm run deploy:assets` | Copy the build's client files into the `PREVIOUS_ASSETS` namespace. |
| `pnpm run deploy:production` | The same as `deploy`. |
| `pnpm run deploy:production:dry-run` | `wrangler deploy --dry-run`. |
| `pnpm run clean` | Remove the build, the generated types and the rendered seed. |

## CI

GitHub Actions workflows:

- **CI** (`.github/workflows/ci.yml`), on every pull request and push to `main`: `pnpm install --frozen-lockfile`, `pnpm run verify:static`, `pnpm run test`, `pnpm run build` and `pnpm run build:check` (with the bundle check); then a smoke job that migrates and seeds a local database, serves the build with `wrangler dev --local` and runs `pnpm run smoke` against it. Nothing in it reaches Cloudflare.
- **Deploy** (`.github/workflows/deploy.yml`), on a push to `main` and by hand from the Actions tab: install, build, the guards (`scripts/deploy-checks.mjs before`: a run on `main` only, no placeholder id left in `wrangler.jsonc`; and the bundle check), `pnpm run db:migrate:remote`, `pnpm run deploy:assets`, `wrangler deploy`, then `scripts/deploy-checks.mjs after`, which waits for `APP_URL` to answer `/api/health`. It runs only while the repository variable `DEPLOYMENTS_ENABLED` is `true`, in the `production` environment, with the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The token needs **Workers Scripts: Edit**, **D1: Edit**, **Workers KV Storage: Edit**, **Workers R2 Storage: Edit**, **Email Routing Addresses: Edit** on the account and **Email Routing Rules: Edit** on the zone (and, for a custom domain, **Workers Routes: Edit** and **DNS: Edit** on it).

- **Semgrep** (`.github/workflows/semgrep.yml`), on every pull request: the Semgrep Registry's default, TypeScript and React rules, metrics off, on what the pull request adds; [`@rivi-software/semgrep-github-report`](https://github.com/rivi-software/tools/tree/main/packages/semgrep-github-report#readme) keeps one comment with the findings up to date (the job summary for a pull request from a fork). Findings never fail the check. Run it by hand for a scan of the whole repository.
- **rivi-bot** (`.github/workflows/rivi-bot.yml`): [RIVI Bot](https://github.com/rivi-software/tools/tree/main/rivi-bot#readme) reviews a pull request by someone with write access when it opens and after every push, and any other once a maintainer adds the `rivi-bot:review` label; someone with write access asks it to describe, triage, fix or answer with a comment to `@rivi-bot`. `.github/rivi-bot.yml` on `main` says what it does. It needs the secret `ANTHROPIC_REVIEW_API_KEY`, and posts as the [RIVI Bot](https://github.com/apps/rivi-bot) App, whose client ID the workflow names, with the secret `AUTOMATION_APP_PRIVATE_KEY`, a private key of that App (else as `github-actions`). It runs in `rivi-software/workspace` only: a fork that wants it names itself in the job's `if`, adds the secrets, and puts its own App's client ID in `app-client-id`.

`.github/dependabot.yml` asks for weekly updates of the npm packages and the actions (pinned by commit), each release once it is a week old; minor and patch updates come grouped, a major on its own.

## Architecture

One Worker (`workers/app.ts`) with `fetch`, `email` and `scheduled` handlers: `createWorker` (`workers/worker.ts`) serves earlier builds' assets, Better Auth at `/api/auth/*` and the API at `/api/v1/*` itself, everything else through TanStack Start, and puts the security headers on every answer; the cron runs every minute. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the layout, the data model and the flows; [docs/API.md](docs/API.md) the Workspace API for other clients; [GLOSSARY.md](GLOSSARY.md) the words.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md): setup, `pnpm run verify`, conventional commits, pull requests with tests, and the migration rule. Security problems go through [SECURITY.md](SECURITY.md), never an issue.

## License

[MIT](LICENSE). Copyright © 2026 RIVI Software. The deploy helpers `@rivi-software/cloudflare-deploy`, `@rivi-software/deploy-watch`, `@rivi-software/workers-mail` and `@rivi-software/posthog-tanstack-start` are MIT too, from [github.com/rivi-software/tools](https://github.com/rivi-software/tools).

<br>

<p align="center">
  <a href="https://rivi.software">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/rivi-mark-on-dark.svg">
      <img src="assets/rivi-mark.svg" alt="RIVI Software" width="36" height="36">
    </picture>
  </a>
</p>

<p align="center">
  <sub>RIVI Workspace is made by <a href="https://rivi.software">RIVI Software</a>, which builds software for radio stations.</sub>
</p>
