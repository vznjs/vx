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

| Concern         | Tool                                                                       |
| --------------- | -------------------------------------------------------------------------- |
| Runtime         | Bun ≥ 1.3 (no Node fallback)                                               |
| Package manager | Bun (`bun install`, `bun.lock`)                                            |
| Test runner     | `bun test` (tests import `describe`, `it`, `expect`, `vi` from `bun:test`) |
| Linter          | `oxlint --type-aware --type-check` (real TS diagnostics via `tsgolint`)    |
| Formatter       | `oxfmt` (configured via `.oxfmtrc.json`, migrated from prettier)           |
| Build           | None. TS source ships as the entry; `bin: src/bin.ts` runs via shebang.    |

Configs:

- `tsconfig.json` — for editor LSP + tsgolint type info. Not invoked by scripts.
- `.oxlintrc.json` — disables `unicorn/no-useless-spread` (we use spread for deliberate snapshots), `typescript/unbound-method` (test code patterns), and `typescript/await-thenable` (bun:test's `expect(...).rejects.toThrow()` is awaitable at runtime but typed as `void`).
- `.oxfmtrc.json` — prettier-equivalent style (no semi, single quotes, trailing all, 100-col).

## Repository layout

Bun-workspace monorepo. Root holds shared dev tooling (oxlint, oxfmt,
@types/bun); each package owns its own code, tests, deps.

```
packages/
  run/              # @vzn/run — CLI, cache, scheduler, orchestrator
    src/
      bin.ts            # shebang; wires process.argv -> cli.run
      cli.ts            # argv parser, dispatcher, interactive picker
      orchestrator.ts   # discover → load → graph → schedule → execute
      scheduler.ts      # parallel topo executor
      task-graph.ts     # builds TaskNode DAG from declared dependsOn
      package-graph.ts  # workspace dep graph
      workspace.ts      # pnpm-workspace.yaml discovery
      project-loader.ts # jiti-loaded vzn.config.* (moduleCache: false)
      filter.ts         # pnpm-style filter DSL (-F)
      cache.ts          # content-addressed cache (key + save/restore)
      runner.ts         # Bun.spawn wrapper + shellQuote
      env.ts            # env composition
      inputs.ts         # glob resolution + project-boundary enforcement
      config.ts         # public schema (ProjectConfig, TaskConfig, …)
      paths.ts          # tiny POSIX-path helper
      dashboard.ts      # legacy: API server (to move to @vzn/dashboard)
      dashboard-ui/     # legacy: static UI (to be replaced)
      index.ts          # public re-exports
    tsconfig.json
    package.json
apps/
  dashboard/        # coming PR #26 — Vite + Solid + UnoCSS app, not a published package
docs/
  README.md         # index
  architecture.md   # module map, data flow, design principles
  schema.md         # every config field
  caching.md        # cache key derivation, invalidation table
  execution.md      # what happens during a `vzn run`
  cli.md            # CLI reference (flags, filter DSL, forwarding)
  modules/<name>.md # per-module reference
  design/           # forward-looking proposals
.claude/agents/     # subagent definitions
package.json        # workspace root (Bun workspaces, "packages/*")
bun.lock
.oxlintrc.json      # lint config (shared across packages)
.oxfmtrc.json       # format config (shared)
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

- **2026-05**: Re-monorepo'd the project. Root `package.json` is a
  Bun-workspaces manifest (`"workspaces": ["packages/*", "apps/*"]`);
  current `src/` moved into `packages/run/src/`. Set up to host
  `apps/dashboard/` (Vite + Solid + UnoCSS) alongside `packages/run/`
  per user direction — the dashboard server + UI is being pulled
  out of `@vzn/run` so it can be a proper component-based app with
  a build step. Convention: `packages/*` is published libs,
  `apps/*` is end-user applications. PR #25.
- **2026-05**: Dashboard PR 6/10 — Tasks + Runs UI pages. Tasks
  ranks `(project, task)` pairs by average wall-clock duration
  (cache-hits excluded so the ranking reflects work actually
  done). Runs is a reverse-chronological list of `vzn run`
  invocations grouped by `run_id`; rows link to `#/runs/:id`
  which lands in PR #25. Added parametrized static-serving test
  asserting each page module exports the expected `render*`
  function. PR #24.
- **2026-05**: Dashboard PR 5/10 — static UI bundle. `src/dashboard-ui/`
  ships vanilla HTML + ESM + a tiny hash router with no build step.
  `dashboard.ts` now serves non-`/api/*` paths from disk with a
  no-store cache policy; unknown non-asset paths fall through to
  `index.html` so the SPA's `#/overview`, `#/cache`, … hash routes
  resolve correctly. Two pages this PR: Overview (cards + recent
  runs) + Cache (entries table). PR #24 adds Tasks + Runs; PR #25
  adds Run detail + flamegraph. 7 new static-serving tests. Default
  port also accepts `0` for kernel-assigned. PR #23.
- **2026-05**: Dashboard PR 4/10 — `vzn dashboard` subcommand +
  `src/dashboard.ts` HTTP server. Bun.serve()-based, opens
  `cache.db` read-only, exposes `/api/health`, `/api/overview`,
  `/api/runs`, `/api/runs/:id`, `/api/tasks/slowest`,
  `/api/cache/entries`. JSON wire shape designed so PR #26's
  Cloudflare Worker can be a drop-in replacement. bigints
  (wallclock ns) serialized as strings. Default bind
  `127.0.0.1:4280`; `--host 0.0.0.0` opts into LAN exposure.
  14 dashboard tests + full module docs. PR #22.
- **2026-05**: Test harness migrated from `from 'vitest'` to `from
'bun:test'`. vitest was a stale pnpm symlink locally — never in
  `bun.lock` — so CI's `bun install --frozen-lockfile` couldn't
  resolve it for tsgolint. `bun:test` re-exports `vi` as a compat
  alias so the `vi.spyOn(...)` patterns in `cli.test.ts` keep
  working. Also disabled `typescript/await-thenable` in oxlint
  (`bun:test`'s `.rejects.toThrow()` is awaitable at runtime but
  typed as `void`). PR #21.
- **2026-05**: `isSandboxSupported()` now functionally probes
  bwrap (one-time, memoized): Ubuntu 24.04+ (the new GitHub
  Actions ubuntu-latest baseline) restricts unprivileged user
  namespaces via AppArmor by default, so the binary is installed
  but namespace-creating invocations exit non-zero. Sandbox tests
  `describe.skipIf` cleanly when the kernel blocks. PR #21.
- **2026-05**: Dashboard PR 3/10 — orchestrator generates a ULID
  `runId` at the top of `run()` shared by every task in the
  invocation, plus an `hrtime.bigint()` anchor for per-task spans.
  `TaskOutcome` carries `wallclockStartNs` / `wallclockEndNs` (ns
  relative to run t=0). `recordRun()` now writes `run_id` + spans
  into the v11 columns. Hand-rolled `src/ulid.ts` (Crockford
  base32, 48-bit ms + 80-bit random) — no new dep. PR #21.
- **2026-05**: Dashboard PR 2/10 — `runner.ts` and `sandbox.ts`
  switched to `Bun.spawn` so we get `resourceUsage()` (cpuTime,
  maxRSS) per child. `RunResult` gains optional `cpuMs` +
  `peakRssBytes`. `TaskOutcome` propagates them. Orchestrator passes
  them through to `cache.recordRun()` plus `cacheHit` (derived from
  status). The v11 columns from PR #19 are now populated for every
  task. PR #20.
- **2026-05**: Cache schema v11 — analytics columns added to the
  `runs` table (`run_id` ULID, `cpu_ms`, `peak_rss_bytes`,
  `wallclock_start/end_ns` hrtime spans, `cache_hit`,
  `bytes_uploaded/downloaded`). All nullable; producer PRs populate
  them later. `CACHE_VERSION` → `vzn-cache-v11`. First PR of the
  dashboard 10-PR sequence (`docs/design/dashboard.md`). PR #19.
- **2026-05**: `CacheLayer` interface extracted in `src/cache.ts`. Both
  `Cache` and `LayeredCache` `implements CacheLayer`. Orchestrator's
  `cache` field types as `CacheLayer` (was the brittle `Cache |
LayeredCache` union). `SaveArgs` exported as `Parameters<CacheLayer['save']>[0]`
  so callers don't redeclare the shape. PR #18.
- **2026-05**: P1 bug bundle from Agent A's real-world test. Adds
  `PRAGMA busy_timeout = 5000` (concurrent `vzn run` no longer crashes
  with SQLITE_BUSY), scopes `forwardArgs` to user-requested task nodes
  (no longer leaks into `dependsOn`-pulled deps; no longer pollutes
  their cache keys), returns `ok: false` when no project declares the
  requested task (CI scripts surface typos), adds runtime validation
  of `TaskConfig` shape in `project-loader.ts`, introduces a
  `UserError` class so user-input failures print a clean message
  instead of a full stack. Also renames the stale `nxt:` log prefix
  to `vzn:`. PR #17.
- **2026-05**: Sandbox shipped (v1). `src/sandbox.ts` with bwrap on
  Linux + sandbox-exec on macOS. `vzn run --sandbox` opts in. Declared
  `cache.inputs.files` are bind-mounted read-only; project dir is
  read-write; everything else is invisible (ENOENT). Fail-loud when
  the helper binary is missing — silent fall-through would defeat the
  contract. Windows is unsupported. Design at
  `docs/design/sandbox.md`. PR #15.
- **2026-05**: Remote cache shipped. `RemoteCache` HTTP client (PR #10)
  speaks the Turbo `/v8/artifacts/` wire verbatim. `cache-archive`
  (PR #12) handles tar.gz pack/unpack via system `tar`. `LayeredCache`
  (PR #13) composes local + remote: read-through (local → remote →
  hydrate local), write-through (local sync, remote fire-and-forget).
  Wired into orchestrator via env vars: `VZN_REMOTE_CACHE_URL` +
  `VZN_REMOTE_CACHE_TOKEN` (plus optional `_TEAM_ID`, `_SLUG`,
  `_TIMEOUT_MS`). Compatible with `ducktors/turborepo-remote-cache`,
  `Fox32/openturbo-remote-cache`, Vercel hosted cache.
- **2026-05**: `vzn cache prune` CLI command. Supports `--older-than
<duration>` (TTL eviction) and `--max-size <bytes>` (LRU eviction
  until under cap). Both can combine. Uses `entries.accessed_at` and
  `entries.size_bytes` from the v10 schema. PR #9.
- **2026-05**: `vzn stats` CLI command — surfaces v10 cache stats
  (entry count, total size, runs/hits last 24h). PR #8.
- **2026-05**: Local cache v10 — SQLite metadata index (`cache.db`),
  on-disk outputs at `<hash>/`, separate `logs/<hash>.{stdout,stderr}`
  log files. Adds `runs` table for run history (drives future `vzn stats`).
  CACHE_VERSION → `vzn-cache-v10`. Per-entry `meta.json` is gone. PR #7.
- **2026-05**: Project memory + agents — `CLAUDE.md` + architect /
  developer subagents under `.claude/agents/`. PR #6.
- **2026-05**: Bun runtime + oxc toolchain (oxlint + oxfmt + tsgolint).
  Dropped Node, pnpm, tsc, prettier, vitest. PR #5.
- **2026-05**: Remote cache wire = Turbo `/v8/artifacts/` spec verbatim,
  but tar interior is ours (`meta.json` + `outputs/`, no Turbo log-file
  mimicry). Design at `docs/design/remote-cache.md`. **Not yet implemented.**
- **2026-05**: Schema reshape — `defineProject({ run: { tasks: {...} } })`.
  `exec` is a single ExecConfig, not an array. CACHE_VERSION → `v9`.
  PR #3.
- **2026-05**: CLI aligned with vite-task — default scope is cwd
  project, `-r` for all, `-F` for filter DSL, `--` separator, `pkg#task`
  addressing, `--no-cache` (was `--force`), `-v` for verbose. PR #2.

## Active workstreams (prioritized)

1. **Architecture doc refresh + per-module docs for remote-cache
   subsystem.** `docs/architecture.md` doesn't mention the
   remote-cache trio (RemoteCache + cache-archive + LayeredCache) or
   sandbox.ts. New contributors miss half the story. Add a `cache/`
   cluster to the module map; create
   `docs/modules/{remote-cache,cache-archive,layered-cache,sandbox}.md`.
2. **CacheLayer interface refactor.** `cache: Cache | LayeredCache`
   union is brittle; extract a `CacheLayer` interface, type
   orchestrator's `cache` field to it. Shared types in a small module.
3. **Split `orchestrator.ts` and `cli.ts`.** Both are > 400 LOC with
   mixed concerns. See refactor audit findings in conversation.
4. **Presets / config-introspection** — NX-style task inference from
   tool configs (`vitest.config.ts`, `tsconfig.json`).
5. **Workspace config loading** — `defineWorkspace({...})` is exported
   but the config file is never loaded. Either wire it up or remove
   the dead exports.
6. **Pre-signed URL auth + HMAC signing** (`x-artifact-tag`) for the
   remote cache. v2 features per `docs/design/remote-cache.md`.

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
