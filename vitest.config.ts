import path from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { unstable_readConfig } from "wrangler";

export default defineConfig({
  resolve: { alias: { "~": path.resolve(import.meta.dirname, "app") } },
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(
        path.join(import.meta.dirname, "migrations")
      );

      // The plugin lays a developer's `.dev.vars` over these `vars` (a localhost APP_URL); pinning them keeps the
      // tests on the values of `wrangler.jsonc`, as in CI, which has no `.dev.vars`.
      // SAFETY: wrangler's declarations name types it does not ship, so its config reads as `any`; the `vars` of
      // `wrangler.jsonc` are strings.
      const { vars } = unstable_readConfig({
        config: path.join(import.meta.dirname, "wrangler.jsonc"),
      }) as { vars: Record<string, string> };

      return {
        main: "./test/worker-entry.ts",
        remoteBindings: false,
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          compatibilityDate: "2026-10-19",
          bindings: {
            ...vars,
            TEST_MIGRATIONS: migrations,
            SESSION_SECRET: "test-secret-with-at-least-32-characters!!",
            // Mail goes through the recording binding, never Amazon SES, whatever `.dev.vars` holds.
            SES_ACCESS_KEY_ID: "",
            SES_SECRET_ACCESS_KEY: "",
            // The Assistant's tests run on the mock model; nothing calls Workers AI.
            AI_PROVIDER: "mock",
            // An empty PostHog token keeps the tests from sending exceptions anywhere.
            POSTHOG_PROJECT_TOKEN: "",
          },
        },
      };
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    // Vitest's on-disk module cache hands a runner every cached module of a file's graph in one message, and workerd
    // closes a WebSocket on a message over 1 MiB: with Better Auth's module graph warm, that snapshot overflowed and
    // a runner died on its way up ("Worker exited unexpectedly", close code 1009). Off, the modules come one by one.
    fsModuleCache: false,
    // Some tests file a hundred messages through D1 or run a whole import: on CI they take up to 4.7 seconds, and on a
    // runner busy with the other files they went past the 5-second default.
    testTimeout: 20_000,
  },
});
