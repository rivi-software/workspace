/**
 * Require `migrations/` to match `app/db/schema.ts`: `drizzle-kit generate` must report no
 * schema change and leave the directory untouched. drizzle-kit exits 0 even when it cannot ask
 * about a rename without a TTY, so the exit code alone proves nothing. `pnpm run contracts:check`;
 * CI runs it with the static checks.
 */
import { execFileSync, spawnSync } from "node:child_process";

const generate = spawnSync("pnpm", ["exec", "drizzle-kit", "generate"], {
  encoding: "utf-8",
  env: { ...process.env, CI: "1" },
});

const output = `${generate.stdout}${generate.stderr}`;

process.stdout.write(output);

// Files drizzle-kit wrote or changed: unstaged edits and untracked files (the second status
// column), not files already staged for a commit.
const dirty = execFileSync(
  "git",
  ["status", "--porcelain", "--untracked-files=all", "--", "migrations"],
  { encoding: "utf-8" }
)
  .split("\n")
  .filter((line) => line.length > 1 && line[1] !== " ")
  .join("\n");

if (generate.status !== 0 || !output.includes("No schema changes") || dirty) {
  console.error(
    "app/db/schema.ts differs from the migrations. Run `pnpm run db:generate` and commit the result."
  );

  if (dirty) {
    console.error(dirty);
  }

  process.exit(1);
}

console.log("migrations match app/db/schema.ts");
