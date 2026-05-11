# `@vzn/run` — project memory for Claude

A monorepo task runner for pnpm workspaces. Bun-only (≥ 1.3). Pre-alpha.
**You are the project owner.** Maintain it, push it forward, ship.

## Project identity in one paragraph

`@vzn/run` is a content-addressed cache + task scheduler for pnpm
workspaces. Authors write per-package `vzn.config.ts` files; the CLI
discovers projects, builds a task graph from declared `dependsOn`,
hashes inputs deterministically, and executes tasks in topological
order with parallelism. Cache hits replay stored outputs. Pre-alpha.

## Stack

| Concern         | Tool                                                                    |
| --------------- | ----------------------------------------------------------------------- |
| Runtime         | Bun ≥ 1.3 (no Node fallback)                                            |
| Package manager | Bun (`bun install`, `bun.lock`)                                         |
| Test runner     | `bun test` (vitest-compat layer recognizes our `from 'vitest'` imports) |
| Linter          | `oxlint --type-aware --type-check` (real TS diagnostics via `tsgolint`) |
| Formatter       | `oxfmt` (configured via `.oxfmtrc.json`, migrated from prettier)        |
| Build           | None. TS source ships as the entry; `bin: src/bin.ts` runs via shebang. |

Configs:

- `tsconfig.json` — for editor LSP + tsgolint type info. Not invoked by scripts.
- `.oxlintrc.json` — disables `unicorn/no-useless-spread` (we use spread for deliberate snapshots) and `typescript/unbound-method` (test code patterns).
- `.oxfmtrc.json` — prettier-equivalent style (no semi, single quotes, trailing all, 100-col).

## Repository layout

```
src/
  bin.ts            # shebang #!/usr/bin/env bun; wires process.argv -> cli.run
  cli.ts            # argv parser, dispatcher, interactive picker, verbose summary
  orchestrator.ts   # end-to-end: discover → load → graph → schedule → execute
  scheduler.ts      # parallel topo executor
  task-graph.ts     # builds TaskNode DAG from declared dependsOn
  package-graph.ts  # workspace dep graph + transitive deps/dependents
  workspace.ts      # pnpm-workspace.yaml discovery + project listing
  project-loader.ts # jiti-loaded vzn.config.* with moduleCache: false
  filter.ts         # pnpm-style filter DSL (-F)
  cache.ts          # content-addressed cache (key derivation + save/restore)
  runner.ts         # child_process.spawn wrapper + shellQuote
  env.ts            # env composition (allowlist + passThrough + define)
  inputs.ts         # input file glob resolution + project-boundary enforcement
  config.ts         # public schema (ProjectConfig, TaskConfig, …)
  paths.ts          # tiny POSIX-path helper
  index.ts          # public re-exports
docs/
  README.md         # index
  architecture.md   # module map, data flow, design principles
  schema.md         # every config field
  caching.md        # cache key derivation, invalidation table
  execution.md      # what happens during a `vzn run`
  cli.md            # CLI reference (flags, filter DSL, forwarding)
  modules/<name>.md # per-module reference
  design/           # forward-looking proposals
    remote-cache.md # Turbo /v8/artifacts wire-spec adoption (not yet implemented)
.claude/agents/     # subagent definitions
```

## Workflow

- **Branch `main` is protected.** Cannot push directly (HTTP 403). Open
  feature branches, push, create PR, merge fast. No review wait — owner
  has authorized this.
- **PR cadence:** small, focused, reviewable diff per PR.
- **Commit messages:** imperative present; first line < 72 chars; body
  explains _why_. No co-author lines.
- **Tests must pass.** 155+ tests today. Use `bun test src/` locally.
- **Format must be clean.** Use `bun run format`.
- **Lint+typecheck must be clean.** Use `bun run lint`.
- **CI gates:** install → format:check → lint → test, all under Bun.
  CI workflow is `.github/workflows/ci.yml`.

## Conventions

- **No comments restating the code.** Only "why" comments for
  non-obvious decisions, hidden invariants, workarounds for specific
  bugs. Remove a comment if removing it wouldn't confuse a future
  reader.
- **No half-finished implementations** behind feature flags. Either
  ship it or don't write it.
- **Trust internal code.** Validate only at system boundaries (user
  input, external APIs, FS). No defensive error handling for
  impossible cases.
- **Test fixtures use heredoc strings** for `vzn.config.mjs`. The
  indentation inside the heredoc matters for readability but doesn't
  affect parsing.

## Architecture principles

1. **Explicit over magical.** Caching is opt-in. `cache.inputs.files`
   is required when caching is enabled. No hidden globs.
2. **One command per task.** `exec: ExecConfig` is a single command;
   chain in shell (`&&`) or split into tasks via `dependsOn.self`.
3. **Shell is the API.** Commands are strings. No JS-function tasks,
   no executor plugin protocol.
4. **Resolved-config hashing.** The cache key sees the post-evaluation
   config object, so imports and computed values participate.
5. **Cascade through deps.** Upstream cache changes invalidate
   dependents via folded-in upstream hashes.
6. **Project boundaries are hard.** A project's globs never reach into
   another project's dir.

## Decision log

- **2026-05**: Bun runtime + oxc toolchain (oxlint + oxfmt + tsgolint).
  Dropped Node, pnpm, tsc, prettier, vitest. PR #5.
- **2026-05**: Local cache `meta.json` is per-entry filesystem manifest.
  Planned upgrade: NX-style SQLite for metadata + outputs as files on
  disk. **Not yet implemented.**
- **2026-05**: Remote cache wire = Turbo `/v8/artifacts/` spec verbatim.
  Tar interior is ours: `meta.json` + `outputs/` (no Turbo log-file
  mimicry). Design at `docs/design/remote-cache.md`. **Not yet implemented.**
- **2026-05**: Schema reshape — `defineProject({ run: { tasks: {...} } })`.
  `exec` is a single ExecConfig, not an array. CACHE_VERSION bumped to
  `vzn-cache-v9`. PR #3.
- **2026-05**: CLI aligned with vite-task — default scope is cwd
  project, `-r` for all, `-F` for filter DSL, `--` separator, `pkg#task`
  addressing, `--no-cache` (was `--force`), `-v` for verbose. PR #2.

## Active workstreams (prioritized)

1. **v10 local cache** — SQLite metadata + on-disk outputs (NX-style).
   Removes per-entry `meta.json` files, adds LRU eviction by size, run
   history table for stats. Will bump CACHE_VERSION to `v10` and
   replace `src/cache.ts`'s storage.
2. **Remote cache implementation** — HTTP client speaking
   `/v8/artifacts/`. Layered with local via `LayeredCache`. Bearer
   token auth.
3. **Sandboxing** (research-only for now) — bwrap on Linux to enforce
   declared inputs. Off-by-default, opt-in via `--sandbox`. See agent
   archives.
4. **Presets / config-introspection** — NX-style task inference from
   tool configs (`vitest.config.ts`, `tsconfig.json`). Lower priority.

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
(`.claude/agents/developer.md`). Both should read this CLAUDE.md
first.
