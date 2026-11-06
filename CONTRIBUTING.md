# Contributing

Thanks for helping. This page is the short version; [AGENTS.md](AGENTS.md) has the gotchas and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) the design.

## Setup

Node 24 (`.node-version`) and pnpm 12 (`packageManager` in `package.json`; `corepack enable` installs it).

```sh
cp .dev.vars.local.example .dev.vars   # local settings: example.com mailboxes, the mock Assistant, no PostHog
pnpm install
pnpm run setup                   # the local D1 migrations and the seed
pnpm run dev                     # http://localhost:5174, admin@example.com / password
```

## Checks

`pnpm run verify` is the gate a pull request has to pass: the typecheck, Oxlint, the check that `migrations/` matches `app/db/schema.ts`, Oxfmt, the Vitest suite (inside workerd), the production build, a dry-run deploy and the bundle check (`workers-bundle-check.config.ts`). `pnpm run format` fixes formatting and `pnpm run fix` applies the lint autofixes. CI runs the same checks, then the smoke test against the build. Semgrep comments new findings on the pull request, and RIVI Bot reviews it once a maintainer adds the `rivi-bot:review` label.

## Pull requests

- One change per pull request, with a test for what changed: the Vitest suite runs the real Worker in workerd with a fresh database; a test signs people in through `sessionFor` (`test/fixtures.ts`). A change a test cannot see (a page) gets a step in `scripts/smoke.mjs`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org): `feat(mail): …`, `fix(drive): …`, `docs: …`, `test: …`, `chore(deps): …`. Scopes are the modules: `mail`, `drive`, `assistant`, `calendar`, `tasks`, `auth`, `api`, `ci`.
- Update the docs with the change: a new endpoint gets a row in `docs/API.md` and a case in `test/api.test.ts`; a new table a line in `docs/ARCHITECTURE.md`; a new term a line in `GLOSSARY.md`.
- Plain English in names, comments and docs. A comment says why, not what.

## The migration rule

A schema change goes through Drizzle, never by hand: edit `app/db/schema.ts`, run `pnpm run db:generate`, and commit the new file under `migrations/` with its `meta/` snapshot. `pnpm run contracts:check` fails a pull request whose schema and migrations differ. Read the generated SQL before you commit it: drizzle-kit writes an added column's `REFERENCES` without its `ON DELETE` action, so add it by hand. Never edit a migration that has been deployed; write the next one. `db:generate` records each new migration's hash in `migrations/JOURNAL.json`, and `contracts:check` fails once a recorded one changes. A migration that has run on no database yet (your own branch's) can still change: delete its entry from the journal and run `pnpm exec d1-migrations journal` again. Dropping a column takes two releases (the schema without the column first, the drop after), because the running Worker still names it in every select until the deploy lands.

## Security

Report a vulnerability privately, as [SECURITY.md](SECURITY.md) says, never in an issue.
