# Contributing

vx is pre-alpha and moves fast; the shape of a good change is stable.

- **Bun ≥ 1.4 only.** No Node in the toolchain, no build step: `bun
packages/vx/src/bin.ts` runs the CLI from source.
- **Gate before you push.** From the repo root, `bun packages/vx/src/bin.ts
run ci --all` runs lint (oxlint type-aware + oxfmt), every package's
  tests, and the docs build — the same tasks CI runs, through vx itself.
  `bun test` alone is not the gate: it cannot see a type error.
- **Every fix carries a pin that fails without it.** A test that passes
  with and without the change proves nothing; keep the control that passes
  both ways.
- **A change to the warm path carries a number.** Interleaved A/B against
  an immutable worktree, min and median of N; `packages/vx-bench/` has the
  harnesses.
- **Docs land in the same commit.** `packages/vx/docs/` is the source of
  truth; the site imports it. `packages/vx/docs/STATUS.md` is the living
  handoff — record what shipped and why there.
- **Commits:** imperative present, first line under 72 characters, body
  says why. One coherent change per commit.
- **Plugins** are `definePlugin(import.meta, hooks)` on the documented
  seams (`packages/vx/docs/design/pipeline-2026-09.md`); core names no
  plugin and ships no technology plugin — those are the community's.

Security problems go through `SECURITY.md`, not the issue tracker.
