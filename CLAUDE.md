# `@vzn/vx` — project memory for Claude

A monorepo task runner for pnpm workspaces. Bun-only (≥ 1.3). Pre-alpha.
**You are the project owner.** Maintain it, push it forward, ship.

## Project identity in one paragraph

`@vzn/vx` is a content-addressed cache + task scheduler for pnpm
workspaces. Authors write per-package `vx.config.ts` files; the CLI
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

Bun workspaces monorepo: the root `"."` member is core `@vzn/vx`
(load-bearing — without it the root vx.config.ts stops being a
project); `packages/*` are the integration packages; `apps/docs` is
the docs site; `packages/cloud/ui` is a nested member (explicit root
`workspaces` entry). Core `src/` is eight modules — each directory's
`index.ts` is its contract; cross-module imports go through it only
(enforced by `tests/module-boundaries.test.ts`) — plus four root
files. Core never imports a sibling `@vzn/vx-*`; packages import core
only via the bare `@vzn/vx` specifier (`tests/package-boundaries.test.ts`,
symlinked by `scripts/link-self.ts` postinstall). Full dependency
matrix in `docs/architecture.md`.

```
src/
  bin.ts                # shebang; wires process.argv -> cli run
  index.ts              # public package façade (~80 exports, snapshot-pinned)
  version.ts            # VERSION constant (cycle-free leaf)
  config.ts             # public schema (ProjectConfig, TaskConfig, WorkspaceConfig, Plugin)
  cli/                  # subcommand parsers + presentation
    index.ts            # contract: dispatcher + test-facing re-exports
    run.ts              # `vx run` parser, scope resolver, picker
    watch.ts            # `vx watch` re-run loop
    cache.ts            # `vx cache prune` + duration/size parsers
    lock.ts             # `vx lock` / `--check` (freeze + audit vx-lock.json)
    migrate.ts          # `vx migrate` — detection, TS emission, overwrite guard
    migrate-turbo.ts    # turbo.json → vx.config.ts mapping (+ vx-preset.ts globals)
    migrate-nx.ts       # nx project-graph.json → vx.config.ts mapping
    show.ts             # `vx show` — live resolved-config introspection
    info.ts             # `vx info` doctor printout (`vx stats` = alias)
    upgrade.ts          # `vx upgrade` — binary self-update (bunfs detection)
    mcp.ts              # `vx mcp` — MCP server for AI agents (stdio)
    mcp-rpc.ts          # internal JSON-RPC methods behind the MCP tools
    backend.ts          # RunBackend resolution (core = localBackend only)
    help.ts             # help text
    format.ts           # shared formatters (formatBytes, …)
    plan-format.ts      # --dry / --graph plan → text / JSON / DOT
  orchestrator/         # run composition
    index.ts            # contract: run, planRun, options/plan types, Logger
    run.ts              # run() + planRun(): discover → load → graph → schedule
    options.ts          # RunOptions / RunSummary declarations
    prepare.ts          # shared run/planRun setup (+ scoped config loading)
    plan.ts             # --dry / --graph prediction (existence probe, no exec)
    execute-task.ts     # per-task execution (probe/preProbed → spawn → save)
    task-hash.ts        # cache-key derivation (computeTaskHash & co.)
    upstream.ts         # filter upstream hashes for cache key
    resources.ts        # exec.resources → absolute per-task admission costs
    stable-keys.ts      # shared stable-key derivation (prefetch + shortcircuit)
    local-shortcircuit.ts # restore-ahead classify (two-tier scheduler feed)
    remote-prefetch.ts  # background remote GETs (LayeredCache runs only)
    events.ts           # run event bus + serializable WireEvent contract
    plugin.ts           # VxPlugin interface + installPlugins
    plugin-host.ts      # capability consultation (executor/cache/backend) + eventSink wiring + teardown
    missing-plugin.ts   # MISSING_PLUGIN_HINT — the lines a workspace with no executor/cache must add
    telemetry.ts        # canonical telemetry contract (SCHEMA_VERSION, records)
    telemetry-host.ts   # sink consultation (zero sinks = zero cost)
    protocol.ts / wire.ts # delegation wire contract + JSON-RPC envelope
    wire-render.ts      # WireEvent → Logger (delegated-run rendering)
    worker-exec.ts      # agent-side execution primitive
    metrics.ts          # analytics SQL layer (/v1/* + vx mcp read through it)
    history.ts / predict.ts # opt-in predictive scheduling (experimental)
    run-context.ts      # git/CI/host capture (≤1 spawn per run)
    run-state.ts        # reduced run aggregate for live surfaces
    run-report.ts       # --report=markdown table
    run-artifacts.ts    # --summarize JSON + --profile trace writers
    devframe-surface.ts # devframe channel/state definition (type-only dep)
    logger.ts           # default logger + framed-output/colors/summary/tally
    status-line.ts / framed-output.ts / summary.ts / tally.ts / colors.ts
  workspace/            # discovery + selection
    index.ts workspace.ts project-loader.ts package-graph.ts
    filter.ts affected.ts nested-dirs.ts fingerprint.ts
    lockfile.ts         # vx-lock.json freeze/trust/audit
  graph/                # task graph + scheduling
    index.ts task-graph.ts dependency-spec.ts
    scheduler.ts        # two-tier parallel topo executor (exec + restore queues,
                        # 2-D resource admission over exec.resources)
  cache/                # local cache + the RemoteCacheLayer seam
    index.ts cache.ts layered-cache.ts chained-cache.ts inputs.ts tar.ts
    cas-backend.ts / digest.ts # pluggable CAS seam (internal, artifact-store roadmap)
  exec/                 # per-task execution primitives
    index.ts runner.ts env.ts sandbox-runtime.ts executor.ts
  plugins/              # core-provided plugins, each isolated: imports core ONLY via '@vzn/vx',
    local-executor/     # published as @vzn/vx/plugins/local-executor — liftable into a package unchanged
    local-cache/        # published as @vzn/vx/plugins/local-cache
  util/                 # tiny shared helpers
    index.ts paths.ts hash.ts ulid.ts errors.ts
packages/
  cloud/                # @vzn/vx-cloud — the self-hosted CI platform + its plugin
    src/
      plugin.ts         # cloud() plugin: telemetry/backend/cache capabilities
      environments.ts   # per-user environments.json (connect targets)
      artifact-store.ts # trust-scoped cache artifacts over a BlobBackend
      native-cache.ts   # the vx-native /v1/cache wire client
      protocol-dist.ts  # dist:*/agent:*/coord:* distribution messages (v2)
      task-log-capture.ts / github-{summary,check}.ts / http-body.ts
      auth/             # sessions, tokens, RBAC, CSRF
      db/               # Bun.sql client, migrations, partitions, analytics
      blob/             # BlobBackend seam: local dir + S3 (hand-rolled SigV4)
      dist/             # agent registry, multi-run scheduler, submit, agent loop
      cli/              # vx-cloud dispatcher: server, dispatch (the HTTP host),
                        # agent, connect/env/status, dev, mcp, ui-asset/server
    ui/                 # the dashboard SPA (Solid + UnoCSS + json-render views)
    deploy/             # Dockerfile context + docker-compose stack
  vx-otel/              # @vzn/vx-otel — otel() telemetry plugin (OTLP JSON, no SDK)
apps/docs/              # Astro Starlight docs site (imports docs/)
bench/                  # synthetic-workspace generator + benchmark runner
docs/                   # source of truth: architecture, caching, cli, execution,
                        # schema, flows, optimizations, comparison, modules/<name>.md,
                        # design/ (proposals, the consulting review, and
                        # decision-log-archive.md — the full history)
.claude/agents/         # subagent definitions
vx.workspace.ts         # declares otel() + cloud() plugins (both decline unconfigured)
tsconfig.json / package.json / bun.lock / .oxlintrc.json / .oxfmtrc.json
```

## Workflow

- **Push directly to `main`.** Owner instruction (2026-06-10): no PRs.
  Branch protection is off. Run the full local gate first
  (`bun src/bin.ts run ci`), then push. Keep commits as small and
  focused as the PRs used to be — one coherent change per commit.
- **Commit messages:** imperative present; first line < 72 chars; body
  explains _why_. No co-author lines.
- **Tests must pass.** 250+ tests today. Use `bun test` locally, or
  `bun src/bin.ts run test` to drive it through vx itself. The 21 OS-sandbox
  tests skip without `bwrap`/`socat`/`strace`; set `VX_REQUIRE_SANDBOX=1`
  (CI does) to make an unavailable sandbox a FAILURE instead — a skip
  reports green, and those tests cover the isolation boundary.
- **Format must be clean.** Rewrite via vx: `bun src/bin.ts run
lint.oxfmt.fix`; the check-only gate is `lint.oxfmt` (part of `lint`).
- **Lint+typecheck must be clean.** Run via vx: `bun src/bin.ts run lint`
  — a group fanning out to `lint.oxlint` (oxlint + tsgolint) and
  `lint.oxfmt` (oxfmt --check). No `package.json` scripts — dogfooded
  through vx's own task graph.
- **CI gate:** `bun src/bin.ts run ci` — a group fanning out to `lint`
  (→ `lint.oxlint` + `lint.oxfmt`) and `test`. The four `build.bun.*`
  cross-compiled binaries are built only in `release.yml` (`vx run
build`), not in the CI gate. CI workflow is `.github/workflows/ci.yml`.

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
- **Test fixtures use heredoc strings** for `vx.config.mjs`. The
  indentation inside the heredoc matters for readability but doesn't
  affect parsing.

## Architecture principles

1. **Explicit over magical.** Caching is opt-in. `cache.inputs.files`
   is required when caching is enabled. No hidden globs.
2. **One command per task.** `exec: ExecConfig` is a single command;
   chain in shell (`&&`) or split into tasks via `dependsOn.self`.
3. **Shell is the API.** Commands are strings. No JS-function tasks,
   no executor plugin protocol. A plugin may change WHERE the command
   runs (the `executor` capability), never what it is.
4. **Resolved-config hashing.** The cache key sees the post-evaluation
   config object, so imports and computed values participate.
5. **Cascade through deps.** Upstream cache changes invalidate
   dependents via folded-in upstream hashes.
6. **Project boundaries are hard.** A project's globs never reach into
   another project's dir.
7. **No defaults.** Core applies no plugin on its own — even its executor
   and cache are plugins under `src/plugins/`, declared in
   `vx.workspace.ts` like any third-party one; a workspace that declares
   none fails before any task runs, naming the fix. Users compose always.

## Dashboard product lens (owner directive, 2026-07-10)

**The UI is built from a SINGLE DEV's perspective** — not an
org/manager analytics console. Every surface answers one of the dev's
own questions, in their flow order:

1. **See it run** — spawn/watch live runs (the Runs landing).
2. **Dig into the projects they own** — project drill-ins with their
   tasks and history.
3. **Task analysis: did MY performance improve or decrease?** — per
   task/project over-time trend, not just workspace-wide aggregates.
4. **Identify flaky tests** — confirmed/inferred flakiness with the
   concrete fix.
5. **Easy debug access** — from any failure, ONE click to the run's
   logs and the task's artifacts.

When adding a dashboard feature, ask "which of these five does it
serve, and how many clicks from the dev's entry point?" — a feature
serving none of them is probably org-analytics scope creep.

## Never stop — run cycles (standing owner directive, 2026-07-27)

**"Continue on cycles, never stop."** Work is CONTINUOUS, not request-driven.
There is no state in which this project is "done" and waiting for input; a
finished wave is the start of the next one, and **vx cloud is the named
default subject** when nothing more urgent is open.

The cycle that has repeatedly worked here, in order:

1. **Audit** a surface hostilely — pick one never reviewed, or one a recent
   wave just changed (the 2026-07-26 remote-cache wave found BOTH its HIGHs in
   code the previous wave had just landed; new code is where the bugs are).
2. **Fix** what the audit CONFIRMS by executed reproduction, and record what it
   REFUTES with the probe — the refuted list is half the value, because it is
   what stops the next audit re-treading the ground.
3. **Verify** differentially: every fix fails without itself, gates from the
   repo root, and re-check the load-bearing claims yourself rather than
   relaying an agent's summary.
4. **Record** in the decision log — including corrections to earlier entries.
   An entry that turns out wrong gets CORRECTED IN PLACE, not quietly dropped.
5. **Land** it, then pick the next surface. Do not ask what to do next; say
   what you are doing next.

**For vx cloud specifically**, rotate across: the analytics read queries (they
answer questions about a dev's work and have repeatedly answered them wrongly
— skew, fabricated verdicts, N+1 shapes), the dashboard's client-side
derivations (`ui/src/jr/{data,functions}.ts` — computations that can lie to
the dev without any server bug), the platform/auth/tenancy boundary, the
distributed-execution path, and the five product-lens questions above (a
surface serving none of them is scope creep; a lens question with no surface
is the gap to close). Cloud features are not done until their docs land in the
same wave — that is the 2026-07-16 directive and it still stands.

**Standing quality bar for every cycle:** repro-mandated findings, no
half-finished work behind flags, measurement before optimisation claims, and
the honesty rules — report what failed, correct yourself in place, and never
write a plausible cause into the log that you have not proven.

## Decision log

**The full, unabridged log lives in `docs/design/decision-log-archive.md`**
(2026-05 → 2026-08, ~13.5k lines, newest-first). It was moved out when it
passed 1 MB and stopped being loadable project memory. Grep it by date or
symbol when you need the whole story behind a decision — the measured numbers,
the refuted hypotheses, the probe mistakes. What follows is the distillation:
the rules, the invariants, the open items, and the recent entries.

**Append new entries to the top of "Recent entries" below**, not to the
archive. When this section grows past ~500 lines, distil the oldest entries
into the digest and move their full text to the archive.

### Standing rules, learned the hard way

Method rules that recur across dozens of entries. Violating one has cost real
time every single time.

- **Repro before fix.** A finding is CONFIRMED only by an executed
  reproduction. Record what a probe REFUTES too — the refuted list is half the
  value, because it stops the next audit re-treading the ground.
- **Differential or it didn't happen.** Every fix must FAIL without itself.
  Verify the RESTORE returns to the exact baseline (a restore that doesn't is
  a broken harness, not a result). Keep deliberate CONTROLS that pass BOTH
  ways — without them a fix can degenerate into "refuse everything".
- **A mutation must be verified to have changed the file** before its result
  means anything. A SURVIVING mutation means the TEST is wrong at least as
  often as the claim.
- **A probe that reaches the wrong code path fails identically to one that
  reaches the right path and finds nothing.** Assert the precondition, not
  just the outcome. When a fix appears not to work, first check the probe is
  exercising a configuration the code supports.
- **Assert the exact expected set, not the absence of one string** — a leak
  that arrives mangled sails past `not.toContain(...)`.
- **A skip is a silent PASS.** Coverage an unrelated infra change can delete
  under a green check is not coverage. Gate it on an env var CI sets
  (`VX_REQUIRE_SANDBOX`, `VX_REQUIRE_BROWSER`) so unavailable = FAILURE in CI.
- **`bun test` passing is NOT the gate.** It is transpile-only and cannot see
  a type error. Run `bun src/bin.ts run ci` from the ROOT (oxlint inside
  `packages/cloud` reports phantom errors — ignore patterns are root-relative;
  per-file `oxfmt --check <file>` gives FALSE passes — only dir mode applies
  the config). Never pipe a gate command through `tail` — it masks the exit
  code. Re-run the full gate AFTER the last edit, CLAUDE.md included.
- **Confirm the REAL CI conclusion after pushing.** "The local gate passed" is
  not "CI is green" — a stale `lint.oxlint` cache hit has shipped a red main.
- **Before concluding anything from where a CI log ends, check where a PASSING
  run's log ends.** Truncation is not evidence of a killed process.
- **A red main is not always your diff.** Read the failing TEST NAME and the
  ACTUAL error before filing it as a known flake; three entries mislabelled a
  real Postgres deadlock as a contention flake by reading only the summary.
- **Measure, don't assert.** Interleave A/B arms (ordering bias against a
  colder workspace once produced a phantom 11% regression), take min-of-N,
  and run the "before" arm from an IMMUTABLE `git worktree` — never a stash or
  checkout, which another agent or a reset can mutate underneath you.
- **A fact measured on one box is a fact about that box** until a second one
  agrees. Fixtures built on platform-dependent side effects fail loudly
  elsewhere; that is what the precondition assertion is for.
- **A memo of a resource that can DIE must check liveness.** Recorded three
  times: the shared browser handle, the negative-TTL capability probe, the
  session/token caches.
- **When a wave fixes a CLASS rather than a line, grep the class in the same
  wave.** Centralisations that missed one call site: `splitTaskId`, `clampInt`,
  `parseDecimalInt`, `WORKSPACE_FINGERPRINT_FILES`, the 401-only auth check,
  the argv flag-value parser. The copies agree until they don't.
- **A comment claiming a guarantee the code does not have** is its own defect
  class (four waves running). De-claim it or implement it.
- **A refusal breaks a working build**, so refuse only what is PROVABLE, and
  ship a false-positive control test with every refusal.
- **Stale build artifacts make a passing check prove nothing.** Rebuild
  `packages/cloud/ui/dist` before believing any visual/browser result — a
  branch sync rewrites the UI source, so dist goes stale on every sync.
- **Scratchpad hygiene.** Use the session scratchpad dir, never a bare `/tmp`
  path (a stale sibling-session file once overwrote live work), and never let
  a `cd` persist across a compound command whose later steps use relative
  paths.
- **Cloud features are not done until their docs land in the same wave.**
- **Correct entries IN PLACE.** An entry that turns out wrong gets corrected,
  never quietly dropped. Never write a plausible cause you have not proven.

### Live invariants

- **Versions** (verify in source before quoting): `CACHE_VERSION`
  `vx-cache-v26`, core `SCHEMA_VERSION` `v24`, `TELEMETRY_SCHEMA_VERSION` 2,
  `DIST_PROTOCOL_VERSION` 2, `/v1/meta cacheWire` 2, `TASK_WIRE_VERSION` 1,
  `ENVIRONMENTS_VERSION` 1, cloud migrations through `0009`.
- **When to bump `CACHE_VERSION`:** only when STORED BYTES are wrong under an
  UNCHANGED key (v25/v26 both were). A key-derivation fix whose old key was
  already WRONG is self-healing — it misses once, re-runs, re-caches, and can
  never serve a wrong hit — so it does NOT bump. Say which case applies in
  every entry.
- **Key derivation:** xxh3, seed-chained per part (`xxh3(part, prevDigest)`),
  `\0` part delimiters, git blob OIDs for tracked-clean files (zero reads),
  PURE-INPUT transitive hashing (upstream INPUT keys, never output content —
  early cutoff was reverted in v22), plus the project's `package.json` bytes
  and the workspace fingerprint. `exec.resources` is STRIPPED (tuning a
  reservation never busts a cache); `timeout`/`retries` are deliberately NOT.
  `description` IS folded, deliberately.
- **Cache correctness is the worst failure class.** A wrong answer here is not
  a degraded answer — it replays stale bytes under a green run. Eight-plus
  entries route through `execute-task.ts`; treat any change there as
  stale-hit-critical.
- **Trust scopes are SERVER-derived from the token**, never a client claim.
  Untrusted (fork-PR) reads `untrusted ∪ trusted` and writes only
  `untrusted/<sub>`; trusted never reads untrusted. Scope prefix is
  `org/<orgId>/ws/<workspaceId|_org>/<tier>[/<sub>]`.
- **Tenant clamp:** every analytics read is `WHERE workspace_id = <resolved>`;
  every index on the four partitioned analytics tables leads with
  `workspace_id` (three documented exemptions, guarded by a test).
- **Observability must never break a run.** Telemetry sinks are crash-isolated
  and deadline-bounded; a throwing sink is disabled for the run; a remote
  cache error degrades to a MISS; the cloud plugin is never-fail but must
  WARN (a silently discarded ingest shipped once).
- **Zero-cost gates:** no telemetry plugin ⇒ no bus subscriber, no summary
  built, no git spawn. `wants` gates `task.log` projection. A declined plugin
  costs nothing. Guard these with tests when touching the host.
- **A skip is a task of the run but not an EXECUTION** — excluded from every
  rate, mean and run count (`EXECUTED_RUNS_SQL` / `EXECUTED_TASK_RUNS_SQL`),
  but INCLUDED in the completeness surfaces (`getRun`, `listRuns`,
  `compareRuns`). A keyless row never answers a cache-key question
  (`KEYED_RUNS_SQL`).
- **Flakiness = nondeterminism in the OUTCOME only** — a within-run retry
  (`flakyConfirmed`) or one cache key that both failed and succeeded
  (`mixedOutcomeKeys`). Duration spread is context, never evidence. One
  shared `hasFlakeSignal` on the core façade; cloud imports it.
- **Colour vocabularies are three, and they do not mix:** status (verdict),
  identity (`--ident-*`, projects hued / tasks pink — outside the status
  palette so an id can never read as a verdict), and chart series (a closed
  semantic list). `--chart-1..8` is retired.
- **Two clocks must be frozen together** in fixtures: the browser's and the
  server's (`Analytics` takes an optional construction-time `clock`; never an
  env var — that would put a clock override in production reach).

### Rejected non-goals — do NOT re-propose

- **Named inputs / target defaults / `globalInputs` / `globalEnv`** — TS
  configs compose; a shared preset imported and spread IS the mechanism. A
  schema field would duplicate the language.
- **Auto-input inference (fspy/strace tracing)** — explicit inputs are a
  correctness principle, not a gap. `--verify=inputs` PROVES the declared set
  instead of guessing it.
- **Folding `NODE_OPTIONS` (or the ESSENTIAL_ENV allowlist) into the key** —
  it would split a laptop from a CI runner over output-neutral tuning and
  gut remote-cache hit rate. `cache.inputs.env` is the explicit answer.
- **Lookahead / idle-insertion scheduling** — measured: `remCP` already ties
  or wins on every structured shape; the naive "prefer a shorter task" is an
  SPT bias that REGRESSES makespan (Graham anomaly). Predictive stays OPT-IN
  (`loadFor` is ~280 ms on a large warm cache — more than the whole warm run).
- **Transparent config eval cache** — needs a purity heuristic; `vx lock`
  (explicit user action) is the sound version.
- **CI-platform scope** — triggers, hosted runners, secrets, marketplace, a
  DSL. vx is the portable execution+cache+pool LAYER you run INSIDE any CI
  provider. (Run TRIGGERS reverse a standing non-goal — owner decision only.)
- **Turbo remote-cache wire in core** — dropped 2026-07-10; core ships the
  seams, `@vzn/vx-cloud` ships the native wire, Turbo interop is a
  third-party plugin recipe.
- **Speculative façade widening** — measured 2026-07-30: there is no fourth
  util symbol worth exporting. Widen on demonstrated need only.
- **Intra-task sharding, mDNS agent discovery, managed fleet controller,
  input-shipping a dirty tree** — the task is the unit of distribution.

### Open items (recorded, NOT fixed)

- `vx run --verify=inputs` on macOS reports a false `undeclared-inputs` for
  the project's own ancestor directories and prints raw sandbox-exec log lines
  instead of paths. Needs a call on whether directory traversal is an input.
- **CI is `ubuntu-latest` only.** Three macOS-only defects reached main
  unseen (tar format, symlinked-base containment, `close()` on an unlinked
  DB). A darwin job — even a subset — is the structural fix.
- `vx-cloud connect` has no `--pr-token` flag; the fork-PR tier is
  hand-editable in `environments.json` only. Feature decision, not a defect.
- Read routes (`/v1/agents`, the analytics reads) answer ANY verb. Not
  exploitable (no `Allow-Credentials`; `SameSite=Lax`), just sloppy.
- `--info` and `--cache-local` are byte-identical tokens (56 189 248), so a
  blue line is ambiguous between "informational" and "cache". Changing a token
  value moves the visual baselines — a design call.
- `isOutputsCurrent` compares size+mode+second-mtime, so a same-size,
  same-second, different-content output can skip a restore. Wants a per-output
  content hash.
- `LayeredCache` in-memory pack path (`--cache=local:,remote:rw`) still holds
  artifact bytes in RAM; `drainUploads()` has no timeout and is deliberately
  outside the throw-path `finally` (awaiting a wedged remote would turn a
  failing run into a hanging one).
- Task-log caps count CHARS, not memory (~36× overhead at 1-char chunks);
  when failures alone exceed the run budget the OLDEST failure is stubbed
  first (usually the root cause).
- Distributed: all-agents-leave waits indefinitely; a submitter socket that
  submits TWICE orphans the first submission; the prune-vs-agent sub-scope
  asymmetry for an untrusted token used outside a PR (read from source, NOT
  reproduced).
- The `visual` and `ui-perf` browser suites are host-pinned and skip in CI
  (pixel baselines are font-set dependent; wall-clock FPS measures the
  runner). Arming them needs a containerised capture / measured runner
  baseline.

### Recent entries (2026-08)

- **2026-08-23 — core's execution and cache became plugins a workspace
  DECLARES; a per-task `executor` capability landed; declared cache layers
  chain.** Owner decisions: core must not be specific to vx-cloud OR REAPI
  — every scenario reachable by plugins, core as slim as possible — and
  **no defaults**: nothing is applied unless declared, users compose always. The one wrong-grained seam was `backend` (whole-run
  delegation: it moved the scheduler server-side and dragged cache restore,
  logging and telemetry with it). `executor` is per task: `execute-task`
  builds one fully-resolved `ExecuteRequest` per attempt and
  `selectExecutor` hands it to the first contributed executor that accepts;
  `vx/local-executor` (= the old `runCommand`/`runSandboxed` call) and
  `vx/local-cache` live in `src/plugins/<name>/`, import core ONLY via the
  bare `'@vzn/vx'` specifier (pinned by both boundary tests), are published
  as subpath exports, and are declared like any other plugin — a workspace
  with no executor or no cache plugin fails before any task runs with
  `MISSING_PLUGIN_HINT`, so there is NO hidden fallback and "a plugin can
  replace any part" is pinned rather than promised. (A first cut appended
  them via `withBuiltins`; the owner rejected that as a default and it was
  removed before landing.) Lists, not winners: every executor is consulted
  in order per task; every declared cache layer is CHAINED (`ChainedCache`:
  lookup walks, save reaches all, the first owns the run index, restore goes
  to the layer that answered) and a layer wrapping the local handle
  subsumes the bare local one — which is exactly what lets
  `[cloud(), localCachePlugin()]` work with zero cloud edits. `backend` is untouched: `@vzn/vx-cloud` compiles and runs
  with zero edits, and the COMPAT pin proves a backend-contributing plugin
  delegates the whole run with executors never consulted. Persistent tasks
  never reach an executor (local by construction). Differential: forcing
  the local executor fails exactly the two e2e pins that observe a plugin
  executor. A Task 6 finding worth keeping: `TaskOutcome.restored` is
  false when the on-disk outputs already match the artifact, so the e2e
  pin asserts `status: 'cache-hit'`, not `restored`. Cost of no-defaults,
  measured not estimated: 50-odd test fixtures and this repo's own
  `vx.workspace.ts` had to declare the two plugins (`tests/helpers/local-workspace.ts`
  is the one place fixtures get it); `vx migrate` now emits the file. No
  CACHE_VERSION/SCHEMA bump — requests, keys and artifacts are byte-identical. Design:
  `docs/design/plugin-executor-reapi-2026-08.md`; plan:
  `docs/superpowers/plans/2026-08-22-executor-seam-builtin-plugins.md`.
  **`ExecuteRequest.inputs` SHIPPED the same day** — and inputs are NOT
  only files: `TaskInputs` carries every kind the key folds, WITH values
  (files + git-blob digests, declared env values, runtime/workspaceRuntime
  command output, upstream task ids + keys, package.json/config digests,
  the workspace fingerprint), built by `describeTaskInputs` from the SAME
  resolution as the key (miss path only; the hit path pays nothing; the
  Tier-3 `entry_inputs` capture now rides this one fold instead of a
  post-exec second one). Never persisted — env/runtime values may be
  secrets. Pinned e2e by a spy executor asserting every field; differential:
  dropping `env` fails it. NOT in this wave (follow-up plans): `exec.remote`
  placement, executor capacity in the scheduler, the `'cache'`/`'deferred'`
  output kinds, the REAPI plugin.

- **2026-08-22 — vx was BROKEN ON macOS: every cache save failed, turning a
  task that succeeded into a failed run.** Found by running the gate after a
  docs commit — `[vx] internal error: save: tar exited 1: Can't use format gnu:
No such format 'gnu'`. `packArtifact` hardcodes `--format=gnu`, GNU tar's
  spelling; bsdtar — the macOS default — calls the same format `gnutar` and
  REFUSES `gnu`. Shipped in the v25 artifact wave, whose own comment names
  "BSD tar, the macOS default" as the reason it avoids PAX — so macOS was
  reasoned about and never RUN. **CI is `ubuntu-latest` only**, which is why
  three independent macOS defects have accumulated unseen. **Blast radius
  measured, not estimated: 2445 pass / 211 fail at HEAD → 2654 / 2 with the
  fix** (`bun test ./tests/`, same box, back to back). Not merely "no
  caching": `save` THROWS, so `vx run lint` exits 1 with both tools reporting
  success — the exact failure mode the v25 comment warned about for ustar,
  reintroduced by the fix for it, one platform over. **The fix is a probe, not
  a platform check:** `resolveTarFormat()` reads `tar --version` ONCE per
  process, lazily (a warm all-hit run never packs, so it pays nothing), maps
  bsdtar/libarchive → `gnutar` and everything else → `gnu`, and keeps `gnu`
  when the probe is unreadable. Probing beats `process.platform === 'darwin'`
  because a mac with GNU tar on PATH is then DETECTED rather than assumed.
  **Format choice measured through the real reader** over a fixture with a
  140-byte path component and a >100-byte path: `gnutar` round-trips both with
  modes intact and no PAX junk; `ustar` silently DROPS the long-component
  entry (bsdtar exits 0 — GNU tar exits 2, which is what v25 recorded); `pax`
  produces headers `parseTarHeaders` cannot parse at all (0 entries). So the
  two formats are the same bytes and only the flag spelling differs.
  **A SECOND macOS defect, found because the first one was masking it:**
  `extractOutputs`' symlinked-parent containment memoized the UN-resolved path
  when `realpath(base)` failed — and the base often does not exist yet, since
  the workspace-outputs anchor is created lazily (the code comment two lines
  below says so). Once the first entry's `mkdir` created it, a real ancestor
  (`/private/tmp/...`) was compared against a symlinked base (`/tmp/...`) and
  EVERY entry was refused with a bogus `TarSecurityError` — and `restoreOutputs`
  THROWS rather than degrading, so a cache hit failed the run. macOS makes this
  the DEFAULT shape (`/tmp` → `/private/tmp`); the pin builds the symlink
  explicitly so it discriminates on Linux too. **My first version of that pin
  was NOT discriminating and passing it proved nothing** — with only a file
  entry, nothing below the base exists when the gate runs, so the comparison
  never happens. It needed the DIRECTORY entry a real `tar -cf` always emits;
  with it, reverting the fix fails exactly 1. **A THIRD, bundled because the
  guard was asymmetric:** `close()` wraps the retention prune in try/catch
  ("best-effort; never block closing the handle") and left `flushAccessed()`
  beside it bare — so a throw there ALSO skipped `db.close()`, leaking the
  handle. Reachable when the cache dir is removed under a live handle: macOS
  answers `SQLITE_IOERR_VNODE` where Linux writes on. Pinned honestly as a
  test that is a real guard on macOS and a control on Linux. **Differentials,
  each isolating its own fix, every restore verified back to baseline:**
  hardcoding `gnu` fails 5 of 5 artifact-roundtrip; reverting the base
  resolution fails exactly 1; removing the close guard fails exactly 1. The
  format-mapping unit tests and the "resolves to a name the LOCAL tar accepts"
  probe run everywhere — that last one is the pin that would have caught the
  original bug on whichever host got it wrong, rather than only on the
  author's. **A process mistake of mine:** I ran `git checkout src/cache/cache.ts`
  to undo a mutation and reverted the WHOLE file including the real fix —
  caught only because I check the restore against a known baseline (95/0).
  NO CACHE_VERSION/SCHEMA/wire bump: on macOS nothing was ever stored, so
  there are no wrong bytes to invalidate, and on Linux the resolved flag,
  the resolved base and the guarded close are all byte-identical to before.
  **RECORDED, NOT FIXED — a fourth macOS defect, reproduced and diagnosed:**
  `vx run --verify=inputs` reports a FALSE `undeclared-inputs` on macOS for
  reads of the project's own ancestor DIRECTORIES (`.../packages`,
  `.../packages/a`), failing the run on a task whose inputs are complete —
  and it prints the RAW sandbox-exec violation lines (`node(54734) deny(1)
file-read-data /…`) where the Linux strace parser extracts clean paths, so
  the remediation says "add them to cache.inputs.files" about a string nobody
  can add. Unreachable from this diff (it is the sandbox layer) and invisible
  in full-suite runs, where the sandbox probe fails under load and the whole
  block SKIPS — it only fails in isolation, which is its own finding. Fixing
  it is a semantics call about whether directory traversal counts as an input,
  so it gets its own wave rather than a hunch inside a fix wave.

- **2026-08-20 — workspace pick had no tie-break.** `resolveReadWorkspace`
  (default workspace) and `workspacesForOrg` (the switcher) both ordered by
  `last_seen_at DESC` with NO secondary key; a frozen fixture clock made the
  tie real. Measured STABLE across 12 executions (seq scan, insertion order) —
  so an UNSPECIFIED ordering, not an observed flap, and written up that way.
  Both take `slug` as the secondary key (`UNIQUE(org_id, slug)` ⇒ total order
  within an org), which buys the invariant that the default workspace IS the
  switcher's first row. Two sibling fixtures pinned the same epoch and froze
  neither clock; `workspace-context` now STEPS its clock to each ingest's
  timestamp, because "most recently active" is unanswerable at a frozen
  instant. Differential 2 of 3 new pins; the third is a control that passes
  both ways. No bump.
- **2026-08-20 — the docs screenshots had a ~7-day EXPIRY.** `visual.test.ts`
  froze the BROWSER clock at a fixed epoch while 21 windowed analytics reads
  used the SERVER's real `Date.now()`; measured at 31.2 days of drift the
  published dashboard rendered `RUNS 0 · CACHE HIT RATE 0%`. Refreshing was
  the WRONG move (re-freezes today's staleness, and the baselines ARE the docs
  images). Fixed with ONE seam: `Analytics` takes an optional construction-time
  `clock`; `bootPlatform({ clock })` threads it; the fixture freezes both
  clocks on the same instant. With it, previously-failing shots PASS against
  their EXISTING baselines and three others move toward MORE content. Only the
  three that changed content were committed. Pinned in CI via
  `analytics-read.test.ts` (visual is host-pinned and skips there).
- **2026-08-20 — Bun 1.4.0 made `Glob.scan` follow symlinked dirs, and
  `vx run` started DELETING files outside the project.** Caught by this repo's
  own tripwire test, which had predicted it verbatim. `cache/inputs.ts`
  containment was LEXICAL; with `dist -> ../victim`, `cleanOutputs` deleted
  the file outside the project (it runs before every miss-exec AND every
  hit-restore). Fixed by resolving the DIRECTORY chain (one syscall per
  directory, not per file; `rm` on a symlinked FILE unlinks the link, never
  the target) and requiring the realpath to stay under the project's realpath;
  an unresolvable directory is REFUSED. Swept as a class:
  `resolveWorkspaceOutputs` had NO containment at all. Local Bun 1.3.11 is
  blind to the whole class (49/0) — `bun-version: latest` in CI is what caught
  it. Cost measured: +3.0 ms at 5000 outputs. No bump (restores 1.3.11
  semantics on 1.4.0).
- **2026-08-20 — the categorical ramp WAS the status palette.** `paletteFor`
  hashed a project name onto `chart-1..8`; read against the token table SEVEN
  of eight steps were byte-identical to another token and FIVE to a semantic
  one (`chart-3` IS `--success`, `chart-4` IS `--warn`), so 25.4% of names
  rendered an IDENTITY dot as a VERDICT. A sweep miss of this repo's own
  2026-07-25 wave, which introduced `ident-0..5` for exactly this reason and
  repointed one file. Fixed by DELETING the mechanism (`paletteFor` gone,
  `colorOf` falls through to `identFor`, `--chart-1..8` retired from tokens,
  theme and safelist) — a ramp nobody can hash onto is the only version that
  cannot be missed a third time. TWO guards: a source guard (no retired map,
  closed chart-series vocabulary) and a REAL-Chromium guard reading
  `getComputedStyle` off rendered dots (a token in the map but absent from
  built CSS renders as no colour at all — no source read can catch that).
- **2026-08-19 — the OTLP receiver read a batched export as ONE run.** Audit
  of code merged minutes earlier. `decodeTraceRequest` flattened every
  `resourceSpans`, took the FIRST `vx.run` span as the header and attributed
  EVERY task span to it — with a collector (the configuration the docs
  advertise) one run gained another's tasks and a second run VANISHED, across
  WORKSPACES under an org-wide token. Invisible to the wave's own tests
  because they drove the exporter directly, which always emits one complete
  run per POST. Fixes: the trace id is the run boundary (`groupByTrace`), and
  task spans became SELF-DESCRIBING (`cicd.pipeline.run.id`, `vx.workspace.id`,
  and the load-bearing `vx.task.run_started_at`, without which a stranded task
  computes a different idempotency key and stores twice). A rootless group now
  takes the existing incremental `ingestTask` path. Response shape honestly
  changed to `{ok, runs, stored, tasks}`. Two shipped doc sentences became
  FALSE and were corrected in the same wave.
- **2026-08-19 — OTel became a REAL wire in both directions.** The design
  question was answered first: OTLP is the EXPORT + a RECEIVER, not core's
  internal contract (making it the contract would hardcode a vendor spec into
  core and the two audiences differ — a tracing backend wants spans, cloud
  wants a lossless idempotent per-run record). Measured gap: the exporter was
  dropping `workspaceId`, `defaultBranch`, `outputFp`, the wallclock offsets
  and every run tally. Four load-bearing encodings: ns offsets as int64
  STRINGS, run start/end ALSO as ms attributes (a partition key), verify path
  lists as JSON arrays (a comma is a legal filename byte), and the fingerprint
  map allowed not to survive (detection keys on the fixed-width tree digest).
  Logs are one record per TASK. `TaskLogBuffer` MOVED INTO CORE rather than
  reimplemented. Cloud's receiver decodes into the SAME records and calls the
  SAME `Analytics.ingest*`, so retries dedupe for free; it duplicates the
  attribute keys DELIBERATELY (a wire only one package can write is not a
  public wire) and is differentially guarded against the real exporter.
- **2026-08-05 (×14) — a wave of thin-surface audits**, selected by
  lines-per-assertion. Highlights: the task-detail cache-key card told EVERY
  platform user to re-run a task forever (`explainCacheKey` is a stub; fixed
  by the `capsCacheMissing` split, with the run-it-once hint kept for a
  colocated serve as the control); browser CI enabled for the two behavioural
  suites via `VX_REQUIRE_BROWSER`; the browser flake root-caused —
  `sharedBrowser` memoized a launch promise with NO liveness check, so ONE
  browser death was permanent for the whole `bun test` process (30/0 in 70 s
  where it had been 12 pass / 6 fail in 624 s); `vx-cloud connect` rebuilt the
  persisted entry from THIS invocation's flags, so a token rotation silently
  turned OFF ambient distribution and destroyed the flagless `prToken`; the
  connection DOCTOR told a correct fork PR its setup was broken (it read
  `token` where every other rung reads `token ?? prToken`) and asked the agent
  registry for `session=local` while agents registered under `gh-<id>-<attempt>`;
  the GHA PR page derived `executed = taskCount - hitCount`, counting SKIPS —
  "5 executed" for a run that executed 2, worst on exactly the red runs someone
  opens it to read; a second `vx dev` silently STOLE the first one's socket
  (Bun rebinds a unix socket with no EADDRINUSE — measured, not assumed);
  `vx watch` re-ran itself forever (~3.7 cycles/s) for anyone who relocated
  `cacheDir` outside `.vx`; the OS sandbox was unusable behind a SYMLINKED
  workspace root and its strace detector dropped every denial split across two
  lines; flakiness was inferred from DURATION spread (a badge that refuted
  itself: "inferred from a 0% failure rate"); and the 21 "skipped" sandbox
  tests were found to cover the SECURITY boundary with nothing making an
  absent sandbox fail CI.
- **2026-08-04 (×9) — audits + the recorded-not-fixed backlog worked
  test-first.** A workspace-anchored OUTPUT landing in a consumer's project
  dir was classified STABLE and restore-tiered ahead of its regenerating
  upstream — a real stale hit (the entry's value is that the CAUSE was got
  wrong twice on the way; the decisive check was applying the fix: 0/10 stale
  with, 2/10 without). `plugin-host` said nothing when a plugin's LAST chance
  to ship records was missed (a hung flush was silent while a rejected one
  warned) and re-entered a throwing sink forever. Every detached checkout
  recorded a branch literally named `HEAD`, collapsing every PR into one
  scope. A config typo armed a 30-second timer that killed a LATER watch
  cycle. The analytics router 500'd on a NUL byte and filtered on an empty
  string where every sibling ignored one. `--affected` finally sees a
  `cache.inputs.workspaceFiles` change (the ORDERING problem solved by asking
  only about ORPHAN paths, lock-first, with the zero-cost gate PINNED). Test
  suites stopped re-deriving the same admin account: `seededTemplate` clones a
  seeded database, 697 ms → 139 ms.

### Earlier history (2026-05 → 2026-07) — thematic digest

One paragraph per arc. Dates in brackets are the grep key into
`docs/design/decision-log-archive.md`.

**Cache & correctness.** v9 resolved-config hashing → v12 folds the project's
`package.json` → v13 unified on-disk entry layout → v14 file enumeration
defers to `git ls-files` (vx hard-requires git; the `ignore` dep dropped) →
v15 SHA-256 → xxh3 → v17 the artifact carries only `stdout` + `outputs/`
(stderr is never cached; only successes are) → v18 `\0` env delimiter → v19
`'^task'` expands to the NEAREST-HOLDER frontier, not transitive deps (Turbo
parity; the transitive reach exploded edge count on dense graphs) → v20 git
blob OIDs, so a clean tree costs zero reads and a file's contribution never
flips across dirty↔clean → v21 early cutoff (fold the upstream's OUTPUT
identity) → **v22 REVERTED it to pure-input transitive hashing** (owner:
"rely only on task input hashes"; output-folding blocked any upfront/batched
probe, and multi-state ping-pong still re-hits) → v23 runtime inputs → v24
`vx-lock.json` globally excluded from inputs and `--affected` → v25 the
artifact tar was stripping the EXECUTABLE BIT and DROPPING any entry whose
name exceeded 100 bytes (`--format=gnu`; both silent, neither self-healing) →
v26 a signal-killed task no longer poisons the cache for its dependents
(`aborted` is not `failed`). SQLite carries the metadata index, run history
and, since Tier 3, `entry_inputs` — the per-component input fingerprint that
powers the "why did this re-run?" diff, written MISS-ONLY so warm runs pay
nothing. [2026-05, 2026-06, 2026-06-28, 2026-07-26]

**Provable cache correctness (`--verify`) — the flagship.** Phase 1
determinism (re-run, content-compare outputs, restore attempt 1 so disk ends
byte-identical to the artifact regardless of verdict), Phase 2
input-completeness via the OS sandbox (`--verify=inputs` forces the declared-
inputs baseline; an undeclared workspace read is `undeclared-inputs` and REDS
the run), Phase 3 the verdict rides telemetry + OTel spans + the GHA job
summary, Phase 4 cross-machine output fingerprints (the one failure class a
single-machine re-run cannot see) plus the cheap `--verify=fingerprint` mode
that costs ~1× exec. Pure `RunOptions` side-channel — never folded into a key,
so a `--verify` run cache-hits a plain run's entry. [2026-07-05, 2026-07-09]

**Execution & scheduling.** Two-tier scheduler: a provably-stable key means a
cache hit is knowable up front, so restore-tier tasks bypass the dep gate and
backfill idle workers while MISSES own the pool. Priority closure moved to
bitsets (10.2 s → 1.27 s on a 1090-package graph); the ready queue is a binary
heap. `exec.resources: {cpus, memory}` is 2-D ADMISSION (never enforcement)
with park-within-tick backfill and a solo-clamp so an over-budget task can
never deadlock. Unified `exec.timeout` (bounds a normal task's run, a
persistent task's readiness wait); `exec.retries` + `--retry`; persistent
tasks via `readyWhen`; SIGINT/SIGTERM forwards to live children and exits
128+signo; a requested persistent task keeps the run in the foreground.
[2026-06, 2026-06-28, 2026-07-04, 2026-07-08]

**Terminal output.** Flow is decided by SELECTION FLAGS only (BROAD iff
`--all`/`--filter`/`--affected`, else FOCUSED); truthy `CI` gets full grouped
output + GHA annotations; `--output-logs` always overrides. One outcome
vocabulary, a two-axis glyph grid (shape = cache axis, colour = task axis), a
fixed-height worker region rewritten in place (not a TUI), failures replayed
as full frames at runEnd above the summary, and stacked state meters in a
footer that renders identically live and final. Groups are transparent folders
that surface their real tasks. [2026-06, 2026-06-15]

**Config, CLI, lockfile, migration.** `defineProject({ tasks })` with a single
`ExecConfig`; `dependsOn` is Turbo/Nx micro-syntax (`name`, `^name`,
`pkg#name`, plus `*`/`!` filters in `cache.inputs.tasks` and `build.*`
patterns); `workspaceFiles` is the documented boundary-IGNORING escape hatch;
`cache.inputs.runtime` folds a command's OUTPUT (correct under `--frozen`,
unlike a TS `execSync` escape hatch). `vx lock` + `--frozen` (runs always
evaluate live unless frozen — byte-hashing a config cannot see its import
closure); `vx migrate` from turbo.json / the Nx project-graph snapshot (TODOs
are always comments, never values); `vx show` / `vx info`; a 4-axis
`CachePolicy` (`--cache=local:r,remote:rw`) where `--force` re-executes but
still WRITES; `vx watch`; `vx upgrade`. [2026-05, 2026-06, 2026-07-05]

**Core/cloud split and the platform pivot.** Plugin extension points
(`backend` / `cache` / `telemetry`, plus a versioned `TelemetryRecord`
contract) → `@vzn/vx-cloud` extracted to `packages/cloud` → the first-party
`cloud()` plugin → Docker/Helm skeleton. Then the owner reversed the companion
model outright: vx-cloud is a **fully independent self-hosted CI platform** —
accounts, RBAC, orgs/workspaces, Postgres as the system of record, S3
REQUIRED, docker-compose deploy, boot REFUSES without full config, and the
casual `serve` verb DELETED. Shipped in five phases (auth → Postgres analytics
→ tenancy-prefixed cache + dist, run delegation deleted → the dashboard as a
session client + the `serve.ts` fold, all four SQLite stores deleted →
compose/image/docs/CI job), each followed by a hostile tenant-boundary review
that came back AIRTIGHT. Core is provider-neutral: it names no plugin, imports
no sibling, and the boundary is test-enforced. [2026-06-27, 2026-07-02,
2026-07-04, 2026-07-11, 2026-07-12]

**Distributed execution (vx agents).** Nx-DTE-equivalent, same-checkout
contract, NO input shipping: the correctness law is that an agent executes
each assignment as a scoped core `run()` of the task WITH its dep closure, so
deps restore as warm remote hits and the agent's saved key equals the full-run
key BY INDUCTION (`excludeDependencies:'all'` is provably wrong and is pinned
in both directions). Sessions key on `{orgId, workspaceId, session}`; commit
is a dispatch-ELIGIBILITY filter, never a refusal; a standing pool multiplexes
CONCURRENT submissions with max-min fair dispatch; LPT duration-aware ordering
from trust-scoped history (main's timings reach a branch, a branch's never
reach main); heartbeat liveness; bounded reconnect with a FRESH agent id; the
controller records the run and tees per-task logs. Ambient mode
(`connect --distribute`) fails SAFE to local; explicit `VX_CLOUD_DISTRIBUTE`
is the CI form (ambient in a fan-out CI is a race — the submitter can win and
silently run local while paid agents idle). [2026-07-03, 2026-07-04,
2026-07-18, 2026-07-30]

**Dashboard.** Four rewrites' worth of history: a vanilla SPA → Solid → a
json-render spec-driven catalog (views are pure JSON in `ui/src/views/`,
components absorb ALL derivation) → a React/astryx rewrite that was PARKED
(`packages/cloud/ui-astryx`, not built) when the platform arc won the tree.
Product lens is THE SINGLE DEV (see the section above). Surfaces built to it:
cache-miss explainability, the critical-path cockpit, run comparison, failure
TRIAGE ("is this failure mine?" — flaky / pre-existing on trunk / new), pinned
"my projects", the "got slower" detector (key-aware: a same-key slowdown is
environment, never changed work), task stability as the same-key margin of
error (which then feeds the delta bands, so a verdict is judged against
MEASURED noise), flakiness trend, per-task logs and artifacts, and an
actionable "suggested fix" on every surfaced problem. Scale correctness was a
real bug class: fetch-a-page-then-`.find()` rendered blank pages and lying
ranks at 1000 projects — every such source became a server-side point lookup.
[2026-06-27, 2026-06-28, 2026-07-08, 2026-07-13, 2026-07-24, 2026-07-26]

**Distribution & release.** `@vzn/vx` and `@vzn/vx-cloud` both publish as
no-Bun standalone binaries via per-platform `optionalDependencies` (the
esbuild model) with a shared Node launcher; npm auth is Trusted Publishing
(OIDC, no token) — ten package names need a publisher configured. The
`vx-cloud` image publishes to GHCR. `install.sh` and all repo scripts were
removed (owner: "no scripts are allowed in repo"); the docs site is Astro
Starlight over `docs/` as the single source of truth, and every feature is
explained by a MECHANISM diagram or a real screenshot — never emulated
terminal output. [2026-07-04, 2026-07-07, 2026-07-09, 2026-07-17]

**Built then deleted / reverted — do not rebuild without a new reason.** The
TUI (six PRs across React, Solid and a hand-patched painter; dropped for
freezing and blank panes — production TUIs hand-roll the cell buffer). The
first dashboard subsystem (deleted with its server, UI and subcommand — the
cache file IS the API, until the platform pivot re-created it properly). The
first sandbox (deleted for Ubuntu 24 AppArmor + the under-declared-inputs
footgun, then revived per-task via `@anthropic-ai/sandbox-runtime`). Upfront
cache classification (regressed warm runs +57% by probing twice). `vx-http`.
The Turbo `/v8` wire and its HMAC signing. HTTP/3 (shipped natively, then
removed wholesale — h2 at an edge proxy is the answer; `Bun.serve` has no h2
server and `node:http2` cannot `allowHTTP1` under Bun). Run delegation and the
serve-side run queue. The local-serve auto-detect and `.vx/serve.json`
advertisement (`vx-cloud connect` is the only wiring). Early cutoff. Helm.
[2026-05 through 2026-07-12]

## Active workstreams (prioritized)

**OWNER DIRECTIVE 2026-07-16 — document EVERY vx Cloud feature:
EXECUTED 2026-07-17** (`a4a5051` + `50dbe57`; see the decision-log
entry). The audit→write→verify program ran to completion: full feature
inventory, all 8 cloud pages audited, a new `cloud/api.md` HTTP API
reference, every identified gap filled, astro build clean + a
zero-broken-links crawl over `dist/`. Keep the standard alive: a new
cloud feature is not DONE until its docs land in the same wave.

The trusted-GET S3 HEAD-skip (backlog (b)) SHIPPED same day —
completed from the stashed WIP, adversarially verified sound (see the
decision-log entry).

Near-term roadmap = the "road to best-CI" ranked table in
`docs/design/ci-platform-2026-07.md` (owner: "Make vx the best CI env
ever… compete with GitHub Actions and Nx Cloud"; the wedge is the
portable execution+cache+pool LAYER inside any CI provider — triggers/
hosted-runners/secrets/DSL/marketplace are permanent non-goals). The
longer-horizon core gaps stay sourced from `docs/comparison.md`.

1. ~~Per-task logs + artifacts in the dashboard~~ — **SHIPPED**
   2026-07-04 (task-logs-2026-07; the dashboard TaskLogs panel).
2. ~~PR/commit summary + checks~~ — **SHIPPED** (the GHA
   `$GITHUB_STEP_SUMMARY` table 2026-07-04; the real check run via the
   Checks API 2026-07-10 — client-side glue, no serve needed: pass
   `GITHUB_TOKEN` to the step + `checks: write`).
3. ~~Task-level retries~~ — **SHIPPED** 2026-07-04 (`exec.retries` +
   `--retry`; `TaskOutcome.attempts` is the flaky-detection feed).
4. ~~Flaky detection → surface + suggestions~~ — **SHIPPED** across
   2026-07-05..25: the Insights flaky card (retry-confirmed ranked above
   inferred, Retried column), the task-detail flaky badge + the
   Recommendations `exec.retries` snippet, key-scoped `mixedOutcomeKeys`,
   and the Flakiness-trend card (first-seen/direction). "Auto-APPLY"
   deliberately stayed a copy-pasteable suggestion — vx never edits a
   user's config.
5. ~~Duration-aware dispatch ordering~~ — **SHIPPED** 2026-07-04
   (LPT; serve-computed `durationHints` from ingest history).
6. ~~Run-level policy to REMOTE agents~~ — **SHIPPED** 2026-07-18. The
   submitter's `--frozen`/`--timeout`/`--retry` now ride every `task:assign`
   as an optional `policy` sub-object (filled by the controller from the
   submission's `RunRequest`, applied per-assignment by the agent), so a
   standalone agent honors THIS run's flags instead of live-evaluating with
   no defaults. Cache stays full-by-design (the artifact transport; each
   agent's own local cache stays on). Additive-optional → clean degradation
   both directions (old agent ignores it = today's live-eval; new agent +
   old serve = its own defaults), so NO DIST_PROTOCOL bump (the
   branch/defaultBranch/context precedent).
7. Core backlog (from `docs/comparison.md`): CLEARED. Blob offload
   (pre-signed URLs): the CLIENT half ships in the native wire —
   `NativeCacheClient` follows one auth-dropping 307/302 on GET; the
   serve-side blob backend (S3/R2) behind that redirect is designed
   (`docs/design/native-cache-wire-2026-07.md` §offload) — build when a
   deployment actually needs it. (The Turbo `--preflight` client from
   `presigned-artifacts-2026-07.md` was deleted with the Turbo wire.)
   (`--continue=<mode>`, `--cache-dir`, and `dependsOn` wildcards are
   SHIPPED.)

**Owner-REJECTED non-goals (do NOT re-propose):**

- **Workspace-level `globalInputs` / `globalEnv` / `globalPassThrough`**
  (owner 2026-07-05: "no global"). TS configs compose — a shared preset
  imported + spread into each config IS the global-inputs mechanism (same
  rationale as the earlier-rejected named-inputs machinery); a schema
  field would duplicate the language. The Turbo-migrate path already emits
  a generated `vx-preset.ts` for this.
- **Auto-input inference (fspy/strace filesystem tracing)** (owner
  2026-07-05: "no auto input"). vx's explicit-inputs contract is a
  correctness principle (Architecture principle #1: "Explicit over
  magical"), not a gap; traced inputs aren't derivable before execution
  (why vite-task has no remote cache). Declared `cache.inputs.files` +
  `runtime`/`workspaceFiles` stay the only input surface.

## Operating directive (to you, Claude)

You own this project. The owner has delegated full maintenance. Each turn:

1. Identify the next valuable thing.
2. Do it (run the full local gate, then push directly to `main` — see
   "Workflow"; no PRs).
3. Record the decision here when one is made.
4. Never end a turn with "what next?" — say what you are doing next.

**Run cycles continuously** — see "Never stop — run cycles" above for the
audit → fix → verify → record → land loop and the vx-cloud rotation. A landed
commit is the start of the next cycle, never a stopping point.

When uncertain about a non-trivial architectural call, use the **architect**
subagent (`.claude/agents/architect.md`). When you have a design and need to
implement, use the **developer** subagent (`.claude/agents/developer.md`).
Both should read this CLAUDE.md first.
