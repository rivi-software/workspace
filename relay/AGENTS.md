# Push relay: agent instructions

The push relay is a Web Push service (RFC 8030) in front of APNs and FCM on one Cloudflare Worker, for Workspace's apps (README; the workspace's side is [docs/PUSH.md](../docs/PUSH.md)). The repository-wide rules are in the root [AGENTS.md](../AGENTS.md); this is a pnpm workspace package of its own (`pnpm-workspace.yaml`).

- `src/relay.ts` is every route (`handleRelay`: `/health`, `/v1/register`, `/v1/push/<sealed>`), `src/endpoint.ts` the sealed endpoint (`sealDevice`, `openDevice`), `src/jwt.ts` the tokens (ES256 to Apple, RS256 to Google, the VAPID check), `src/providers.ts` APNs and FCM, `src/index.ts` the Worker. It is `fetch` and WebCrypto alone, with no dependency, so the tests run in Node and the workspace's tests (`test/push.test.ts`) mount `handleRelay` itself as the fetch the workspace pushes through.
- It stores nothing and must not start to: the endpoint is the device, sealed under `RELAY_SECRET`. A change to what an endpoint seals is a new `VERSION` prefix in `endpoint.ts` that still opens the old one, since every installed app holds endpoints of the old shape until it registers again.
- It never opens, logs or keeps a message, a device token or a workspace's address: the logs carry the platform and the outcome. The payload goes to Apple and Google as the workspace's ciphertext (`wp`).
- Its answers are Web Push's, which the workspace acts on: `404` and `410` make it delete the subscription, so a fault of the relay's own (no keys, Apple refusing the provider token) must never answer either; it is `502` or `503`.
- Every call out goes through the `fetch` in `RelayOptions`; a test passes Apple and Google in memory (`gateways` in `tests/relay.test.ts`) and nothing reaches the network. The provider tokens are cached per isolate (`apnsTokens`, `fcmTokens`): Apple refuses a token renewed more often than every 20 minutes.

## Commands

From this directory: `pnpm run check`, `pnpm run lint`, `pnpm run test`, `pnpm run verify` (the three and `wrangler deploy --dry-run`, which CI runs), `pnpm run dev`, `pnpm run deploy`.
