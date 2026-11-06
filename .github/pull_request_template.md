<!--
The title follows Conventional Commits, scoped to the module: fix(mail): …, feat(drive): …
CONTRIBUTING.md has what a pull request needs: https://github.com/rivi-software/workspace/blob/main/CONTRIBUTING.md
-->

## Summary

<!-- What changes, and why. Link the issue it closes: Closes #123 -->

## Evidence

<!-- How you know it works: the tests you added or ran, what you tried in `pnpm run dev`, before and after. -->

## Checklist

- [ ] `pnpm run verify` passes
- [ ] Changed behaviour has a test (or a step in `scripts/smoke.mjs` for a page)
- [ ] A schema change is `app/db/schema.ts` plus `pnpm run db:generate`, with no recorded migration edited
- [ ] The docs say what changed: `AGENTS.md`, `docs/API.md` and `test/api.test.ts` for an endpoint, `docs/ARCHITECTURE.md` for a table, `GLOSSARY.md` for a term
