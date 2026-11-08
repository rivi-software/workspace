# Contributing

Thanks for helping. Contributions are welcome from anyone: a bug report, a fix, a test, a clearer page of the docs, a feature. This page is the short version; [AGENTS.md](AGENTS.md) has the gotchas and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) the design.

Everyone who takes part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Questions, bugs and ideas

[Open an issue](https://github.com/rivi-software/workspace/issues/new/choose), after a look through the [existing ones](https://github.com/rivi-software/workspace/issues?q=is%3Aissue).

- **A bug.** The commit you run and where (`pnpm run dev`, or your own deploy, and the browser for a page), what you expected and what happened instead, and the steps from a fresh `pnpm run setup`. Leave out anything from a real mailbox: addresses, messages, files.
- **An idea or a question.** What you are trying to do, and what gets in the way today.
- **A vulnerability.** Never in a public issue: [SECURITY.md](SECURITY.md) says how to report one privately.

## Before you start

A typo, a broken link, a clearer sentence, or a bug fix with a test can go straight to a pull request. Anything bigger starts with an issue: a new feature, a change to a flow or to the Workspace API, a new table, a new dependency or a new binding. Wait for a maintainer to agree on the approach there before you write it.

Issues labeled [`good first issue`](https://github.com/rivi-software/workspace/labels/good%20first%20issue) or [`help wanted`](https://github.com/rivi-software/workspace/labels/help%20wanted) are ready to take. Say in the issue that you are on it, so nobody else starts the same work.

## Setup

Node 24 (`.node-version`) and pnpm 12 (`packageManager` in `package.json`; `corepack enable` installs it). Fork the repository and clone your fork, then:

```sh
cp .dev.vars.local.example .dev.vars   # local settings: example.com mailboxes, the mock Assistant, no PostHog
pnpm install
pnpm run setup                   # the local D1 migrations and the seed
pnpm run dev                     # http://localhost:5174, admin@example.com / password
```

## Checks

`pnpm run verify` is the gate a pull request has to pass: the typecheck, Oxlint, the check that `migrations/` matches `app/db/schema.ts`, Oxfmt, the Vitest suite (inside workerd), the production build, a dry-run deploy and the bundle check (`workers-bundle-check.config.ts`). `pnpm run format` fixes formatting and `pnpm run fix` applies the lint autofixes; `pnpm install` sets up a pre-commit hook (`lefthook.yml`) that runs `pnpm run fix` over the staged files (`LEFTHOOK=0 git commit` skips it), and `.vscode/` recommends the Oxc extension, which formats and fixes on save. CI runs the same checks, then the smoke test against the build. Semgrep comments new findings on the pull request, and RIVI Bot reviews it once a maintainer adds the `rivi-bot:review` label.

## Pull requests

- One change per pull request, with a test for what changed: the Vitest suite runs the real Worker in workerd with a fresh database; a test signs people in through `sessionFor` (`test/fixtures.ts`). A change a test cannot see (a page) gets a step in `scripts/smoke.mjs`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org): `feat(mail): …`, `fix(drive): …`, `docs: …`, `test: …`, `chore(deps): …`. Scopes are the modules: `mail`, `drive`, `assistant`, `calendar`, `tasks`, `auth`, `api`, `ci`.
- Update the docs with the change: a new endpoint gets a row in `docs/API.md` and a case in `test/api.test.ts`; a new table a line in `docs/ARCHITECTURE.md`; a new term a line in `GLOSSARY.md`.
- Plain English in names, comments and docs. A comment says why, not what.

## The migration rule

A schema change goes through Drizzle, never by hand: edit `app/db/schema.ts`, run `pnpm run db:generate`, and commit the new file under `migrations/` with its `meta/` snapshot. `pnpm run contracts:check` fails a pull request whose schema and migrations differ. Read the generated SQL before you commit it: drizzle-kit writes an added column's `REFERENCES` without its `ON DELETE` action, so add it by hand. Never edit a migration that has been deployed; write the next one. `db:generate` records each new migration's hash in `migrations/JOURNAL.json`, and `contracts:check` fails once a recorded one changes. A migration that has run on no database yet (your own branch's) can still change: delete its entry from the journal and run `pnpm exec d1-migrations journal` again. Dropping a column takes two releases (the schema without the column first, the drop after), because the running Worker still names it in every select until the deploy lands.

## Security

Report a vulnerability privately, as [SECURITY.md](SECURITY.md) says, never in an issue.

## For maintainers

- **CI runs.** Read the diff before you approve a CI run for a first-time contributor. CI runs the pull request's own code: its install, tests, build and scripts. It gets a read-only token and no secrets, but nothing should run that nobody has read. Look hardest at `.github/`, `scripts/`, the `scripts` in `package.json`, and `allowBuilds` in `pnpm-workspace.yaml`.
- **Secrets.** No workflow runs a fork's code with secrets. RIVI Bot's workflow runs on `pull_request_target` with them, from `main`, and runs nothing it checks out; Deploy runs only on a push to `main`. Keep it that way: a workflow that needs a secret never checks out a pull request and runs it.
- **Reviews.** RIVI Bot reviews an outside pull request only once you add the `rivi-bot:review` label: read it first, since Claude reads everything in it. Its review is advice; a maintainer still approves and merges.
- **Small fixes.** When a pull request lacks only a Conventional Commits title or a line of docs, fix it yourself rather than sending the contributor round again.
