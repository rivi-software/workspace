import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

import { testMigrations } from "./migrations";

await applyD1Migrations(env.DB, testMigrations());
