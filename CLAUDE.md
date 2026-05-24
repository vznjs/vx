# `@vzn/vx` — project memory for Claude

A monorepo task runner for pnpm workspaces. Bun-only (≥ 1.3). Pre-alpha.
**You are the project owner.** Maintain it, push it forward, ship.

## Direction (2026-05 rebuild)

The project was reset on branch `claude/modular-rebuild-tdd-Hldt4` after
the previous codebase got too complex — feature-on-feature, refactor on
refactor, with cross-cutting concerns leaking through every module.
History was kept in git; the working tree was wiped and the rebuild
started over.

### Operating principles for the rebuild

1. **Modules-first.** Each concern lives in `src/<module>/` with its own
   `types.ts` (interface contract), default implementation, collocated
   `*.test.ts` + `*.bench.ts`, and `README.md` describing the contract.
   No back-doors between modules. Anything in module A that wants to
   talk to module B does so through B's `index.ts` public surface.
2. **Pipeline composition.** The CLI wires modules into a pipeline:
   `workspace → config → graph → runner → …`. Each step is replaceable
   — the contract is exported so users can implement their own.
3. **TDD: e2e → unit → code.** Every feature starts with an e2e test
   (real bin, real fixture workspace, real assertions on stdout/exit),
   then unit tests for the module, then the implementation.
4. **Speed from day 1.** Every module has a `*.bench.ts` running under
   mitata. No regressions tolerated unless we're fixing a logic bug.
5. **Minimal schemas.** Each module's surface stays as small as
   possible. Extension modules add fields by reading them off the
   shared config object — they never bloat the base schema.
6. **Fail loud.** No silent degradation, no "best effort" fallbacks.
   Bad input → clear error message + non-zero exit.

## Stack

| Concern | Tool                                                                    |
| ------- | ----------------------------------------------------------------------- |
| Runtime | Bun ≥ 1.3 (no Node fallback)                                            |
| Manager | Bun (`bun install`, `bun.lock`)                                         |
| Tests   | `bun test` (imports `describe`, `it`, `expect` from `bun:test`)         |
| Benches | `mitata` via `src/_bench/harness.ts`                                    |
| Lint    | `oxlint --type-aware --type-check`                                      |
| Format  | `oxfmt` (`.oxfmtrc.json`)                                               |
| Build   | None. TS source ships as the entry; `bin: src/bin.ts` runs via shebang. |

## Repository layout (current — rebuild PR 1)

```
src/
  bin.ts                  # shebang entry
  index.ts                # public re-exports for embedders
  _bench/                 # shared mitata harness
  _testkit/               # shared test fixture helpers (underscore = internal)
  workspace/              # project discovery
    types.ts              # Workspace + Project + Discover interface
    discover.ts           # default discovery impl
    find-root.ts          # walk-up to locate workspace root
    *.test.ts             # collocated unit tests
    discover.bench.ts
    README.md             # contract + replacement guide
    index.ts
  config/                 # vx.config.ts loading + base-schema validation
    types.ts              # ProjectConfig, TaskConfig, defineProject
    load.ts
    load.test.ts
    load.bench.ts
    README.md
    index.ts
  graph/                  # task DAG construction
    types.ts              # TaskGraph, TaskNode, BuildGraph interface
    dependency-spec.ts    # parser for "name" / "^name" / "pkg#task" / wildcards
    build.ts              # graph assembly + cycle check + topo sort
    format.ts             # text / json / dot renderers
    *.test.ts
    build.bench.ts
    README.md
    index.ts
  cli/                    # argv parser + subcommand dispatcher
    parse.ts              # pure argv parser
    cli.ts                # entry: runCli(argv, opts)
    graph-cmd.ts          # `vx graph` subcommand
    *.test.ts
    README.md
    index.ts
tests/
  e2e/                    # spawns the real bin against real fixtures
    graph-cli.test.ts
.github/workflows/
  ci.yml                  # bun install → format-check → lint → test
package.json              # devDeps only: @types/bun, mitata, oxfmt, oxlint, oxlint-tsgolint
tsconfig.json
.oxlintrc.json
.oxfmtrc.json
CLAUDE.md
README.md
LICENSE
install.sh
```

## Module status

| Module        |  Shipped   | Owns                                                          |
| ------------- | :--------: | ------------------------------------------------------------- |
| workspace     |     ✅     | Discover projects from disk; find workspace root from a path. |
| config        |     ✅     | Load + validate `vx.config.{ts,mts,js,mjs}`.                  |
| graph         |     ✅     | Build DAG; parse dependency micro-syntax; topo sort; format.  |
| cli           | ✅ partial | `vx graph` subcommand. `vx run`, `vx ls`, `vx watch` pending. |
| runner        |     ⏳     | Spawn tasks. Next module up.                                  |
| scheduler     |     ⏳     | Parallel topo executor consuming the graph.                   |
| logger        |     ⏳     | Structured + framed terminal output.                          |
| package-graph |     ⏳     | Workspace dep edges from package.json (enables `^name` deps). |
| cache         |     ⏳     | Content-addressed cache (later, as a separate concern).       |
| watcher       |     ⏳     | `vx watch` — FS-driven re-runs.                               |

Cache, sandbox, remote-cache, etc. are deliberately deferred — the
previous build coupled them too tightly to the runner. They will come
back as standalone modules that the CLI composes around the runner,
not inside it.

## Workflow

- **Branch `main` is protected.** Push to feature branch, open PR, merge.
- **Tests must pass.** Currently 93 tests / 9 files. Run via `bun test`.
- **Format must be clean.** `bun x oxfmt --check .`
- **Lint+typecheck must be clean.** `bun x oxlint --type-aware --type-check`
- **CI gates:** install → format:check → lint → test.

## Conventions

- **No comments restating the code.** Only "why" comments for
  non-obvious decisions or hidden invariants.
- **No half-finished implementations.** Ship it or don't write it.
- **Trust internal code.** Validate only at system boundaries.
- **Tests collocated.** `src/<module>/foo.test.ts` next to `foo.ts`.
  e2e tests live under `tests/e2e/`.
- **Underscored folders (`_bench/`, `_testkit/`) are internal-only.**
  Not part of the public API; never re-exported from `src/index.ts`.

## Active workstreams (prioritized)

1. **Runner module.** Spawn the resolved graph's nodes via `Bun.spawn`,
   respecting topo order. Add `vx run [tasks...]` subcommand. E2E TDD
   first against a fixture workspace that asserts on stdout + exit code.
2. **Scheduler module.** Parallel topo executor consuming the runner.
   Concurrency cap, ready-set bookkeeping, deterministic priority.
3. **Logger module.** Structured + framed output. Replaces ad-hoc
   process.stdout writes scattered in the orchestrator.
4. **package-graph module.** Reads each project's package.json deps,
   intersects with workspace names, exposes a `Map<projectName,
projectName[]>` graph. Unblocks `^name` `dependsOn` resolution.
5. **Cache module.** Content-addressed local cache. Pure standalone
   module — the runner consumes it via an interface, doesn't depend on
   its implementation.

## Recent decisions

- **2026-05** Project reset. Old codebase (~7000 LOC, 28 test files,
  multiple cross-cutting features) deleted in favor of a modular
  rebuild on branch `claude/modular-rebuild-tdd-Hldt4`. First PR ships
  workspace + config + graph + cli with `vx graph` working end-to-end.
  93 tests across 9 files; full pipeline runs in <500ms on the
  collocated suite. Benchmarks shipped from day 1 via mitata.

## Operating directive (to you, Claude)

You own this project. The user has delegated full maintenance. Each
turn:

1. Identify the next valuable thing.
2. Do it (branch → push → PR → merge).
3. Update this doc when decisions are made.
4. Never end a turn with "what next?" — instead, state what you're
   doing next.

When uncertain about a non-trivial architectural call, use the
**architect** subagent (`.claude/agents/architect.md`). When you have
a design and need to implement, use the **developer** subagent
(`.claude/agents/developer.md`).
