## What & why

<!-- Describe what this PR does AND why it's the right change. "Add X" is not enough —
explain the motivation, the tradeoff you made, and why this approach over alternatives. -->

## How tested

- [ ] `pnpm install && pnpm -r build` (TypeScript packages build clean)
- [ ] `npx tsc --noEmit` (no type errors)
- [ ] `pnpm -r test` (all package test suites pass)
- [ ] Runner tests: `for t in runner/test/*.test.mjs; do node "$t"; done && for t in runner/test/*.test.sh; do bash "$t"; done`
- [ ] Manual smoke test (describe what you ran and what you saw):

## Safety note

Does this PR touch any of the following? If yes, describe the impact carefully.

- [ ] `runner/safety-hook.mjs` or the crew-side classifier mirror — **flag mandatory**
- [ ] The server-side review/merge gate (`packages/dispatch`)
- [ ] Worktree isolation or the GAFFER_WRITE_ROOTS boundary
- [ ] Autonomy flags (`DISPATCH_ALLOW_AGENT_APPROVE`, `MERGE_ON_AGENT_REVIEW`, `MEMORY_AUTO_APPROVE`)

<!-- If none of the above apply, delete this section. -->

## Checklist

- [ ] CI is green (build + typecheck + `pnpm -r test` + runner tests)
- [ ] Docs updated if behavior changed (README, quickstart, ONBOARDING, ARCHITECTURE)
- [ ] No secrets, tokens, or credentials in the diff
- [ ] CHANGELOG entry added under `## [Unreleased]` if this is a user-facing change
- [ ] `runner/safety-hook.mjs` is not weakened (classifier is at least as strict as before)
