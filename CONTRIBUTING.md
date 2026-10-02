# Contributing

vx is pre-alpha and moves fast; the shape of a good change is stable.

## Start here

```sh
git clone https://github.com/vznjs/vx && cd vx
bun install
bun packages/vx/src/bin.ts run ci --all   # the gate: lint, every test, the docs build
```

Needs Bun ≥ 1.4, git and Node (vx-migrate's `nx-exec` tests run it, as
Nx runs executors). On Linux the sandboxed tasks also need
`bubblewrap`, `socat` and `ripgrep` (`apt install bubblewrap socat
ripgrep`); macOS has its sandbox built in. If the gate refuses your git
config (`core.checkStat=minimal` or `core.trustctime=false`), run it with
`GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1`.

Something to work on: the ordered list in
[`STATUS.md` § Next](packages/vx/docs/STATUS.md#next-ordered).

## The shape of a change

- **Bun ≥ 1.4 only.** No build step: `bun packages/vx/src/bin.ts` runs
  the CLI from source. Node runs only what is Node's own: `nx-exec` and
  the npm launcher.
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
- **Commits and PR titles:** Conventional Commits (`fix(cache): …`),
  first line under 72 characters, body says why. One coherent change per
  commit. CI checks a PR's title and each of its commits
  (`packages/vx/scripts/conventional.ts`).
- **Plugins** are `definePlugin(import.meta, hooks)` on the documented
  seams (`packages/vx/docs/design/pipeline-2026-09.md`); core names no
  plugin and ships no technology plugin — those are the community's.

Security problems go through `SECURITY.md`, not the issue tracker.
