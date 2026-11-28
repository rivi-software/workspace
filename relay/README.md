# Push relay

A push relay for Workspace's apps: a Web Push service ([RFC 8030](https://www.rfc-editor.org/rfc/rfc8030)) in front of Apple's APNs and Google's FCM, on one Cloudflare Worker. A workspace with `PUSH_RELAY_URL` set to a relay's address tells its people's apps about new mail through it. [docs/PUSH.md](../docs/PUSH.md) explains why a relay exists and what the workspace and an app do on their side.

- **It cannot read what it carries.** The workspace encrypts every message for the app's own key ([RFC 8291](https://www.rfc-editor.org/rfc/rfc8291)), and the relay passes the ciphertext to Apple or Google unopened.
- **It stores nothing.** There is no database. An endpoint is the device itself (platform, device token, Apple environment and the workspace's VAPID key), sealed with AES-GCM under `RELAY_SECRET`.
- **An endpoint pushes for one workspace.** A push must carry a [VAPID](https://www.rfc-editor.org/rfc/rfc8292) token signed by the key sealed into its endpoint, for this relay's address, good for at most a day.
- **It logs outcomes, not people.** Each push logs its platform and outcome, never the token, the workspace or the message.

## Routes

| Method and path | Request | Answer |
| --- | --- | --- |
| `GET /health` | | `{ ok: true, platforms: ("apns" \| "fcm")[] }`: the platforms the relay holds keys for |
| `POST /v1/register` | JSON `{ platform: "apns" \| "fcm", token, environment?: "production" \| "development", applicationServerKey }`: the device token, Apple's environment (`development` for a development build's token; default `production`) and the workspace's VAPID public key from its `GET /api/v1/push` | `201 { endpoint }`. `400` for a platform it has no keys for, a malformed token or key. `429` past `REGISTER_LIMIT`. |
| `POST /v1/push/<sealed>` | Web Push: `Authorization: vapid t=<jwt>, k=<key>`, `Content-Encoding: aes128gcm`, `TTL`, optional `Urgency` and `Topic`, the encrypted message as the body (at most 2,800 bytes, so its base64 fits APNs' 4 KB) | `201` handed on. `401` unsigned or a bad token, `403` another workspace's key, `404` an endpoint it did not seal (or sealed under another secret), `410` a device Apple or Google forgot, `413`, `415`, `429` past `PUSH_LIMIT` or when the gateway slows the device down, `502` refused, `503` not reached. |

Apple gets an alert push with `mutable-content: 1`, the placeholder `ALERT_TITLE` and `ALERT_BODY`, and the ciphertext in `wp`. The app's Notification Service Extension opens `wp` and replaces the alert. `Urgency` `very-low` or `low` becomes priority 5, anything else 10; `Topic` becomes `apns-collapse-id`; `TTL` becomes `apns-expiration`. Google gets a data message with `wp` in `data`, `HIGH` or `NORMAL` priority, the `TTL`, and `Topic` as its `collapse_key`.

## Deploy

1. `cd relay`, then pick its address in `wrangler.jsonc`: a custom domain under `routes`, or the workers.dev address. Put that address in `RELAY_URL`, since every endpoint it gives out is under it and a workspace's VAPID token must name it.
2. Set the secrets with `wrangler secret put <NAME>` (`.dev.vars.example` lists them):
   - `RELAY_SECRET`, required: at least 32 characters (`openssl rand -base64 48`). Changing it forgets every device until its app registers again.
   - For iPhones: `APNS_KEY_ID`, `APNS_TEAM_ID` and `APNS_PRIVATE_KEY` (the `.p8` key from developer.apple.com → Certificates, Identifiers & Profiles → Keys, with Apple Push Notifications service on), and the var `APNS_TOPIC`, the app's bundle id.
   - For Android: `FCM_SERVICE_ACCOUNT`, the JSON key of a Google service account that may send messages for the app's Firebase project (Firebase Cloud Messaging API Admin).
3. `pnpm run deploy`, then check `GET /health` names the platforms you set up.
4. In each workspace whose people use the app, set `PUSH_RELAY_URL` to the relay's address and deploy it.

The rate limits in `wrangler.jsonc` (`PUSH_LIMIT`, 120 pushes a minute per endpoint, and `REGISTER_LIMIT`, 30 registrations a minute per client address) are a brake on a stolen endpoint or a busy client. Their `namespace_id`s only need to be unique on the account.

APNs takes HTTP/2 only. A deployed Worker reaches it, because Cloudflare's network speaks HTTP/2 to Apple on its behalf, but `wrangler dev` without `--remote` cannot. Try a real push with `wrangler dev --remote` or on the deployed relay. The tests never reach Apple or Google.

## Commands

From this directory:

- `pnpm run dev`: the relay on http://localhost:8787 (`.dev.vars` for its secrets).
- `pnpm run check`, `pnpm run lint`, `pnpm run test` (Vitest in Node, with Apple and Google in memory), `pnpm run verify` (all three, then `wrangler deploy --dry-run`). CI runs `verify`.
- `pnpm run deploy`.
