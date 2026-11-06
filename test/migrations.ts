import type { D1Migration } from "@cloudflare/vitest-plugin";
import { env } from "cloudflare:workers";

const isMigration = (value: unknown): value is D1Migration =>
  typeof value === "object" &&
  value !== null &&
  "name" in value &&
  typeof value.name === "string" &&
  "queries" in value &&
  Array.isArray(value.queries);

/** The migrations vitest.config.ts reads and hands the test worker as the test-only binding `TEST_MIGRATIONS`. */
export const testMigrations = (): D1Migration[] => {
  const migrations = "TEST_MIGRATIONS" in env ? env.TEST_MIGRATIONS : null;

  if (!Array.isArray(migrations) || !migrations.every(isMigration)) {
    throw new TypeError(
      "vitest.config.ts hands the test worker no TEST_MIGRATIONS"
    );
  }

  return migrations;
};
