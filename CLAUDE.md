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
the docs site. Core `src/` is eight modules — each directory's
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
  vx-otel/              # @vzn/vx-otel — otel() telemetry plugin (OTLP JSON, no SDK)
  vx-reapi/             # @vzn/vx-reapi — Bazel Remote Execution API plugin
                        # (remote cache over ActionCache + CAS; remote execution later)
apps/docs/              # Astro Starlight docs site (imports docs/)
bench/                  # synthetic-workspace generator + benchmark runner
docs/                   # source of truth: architecture, caching, cli, execution,
                        # schema, flows, optimizations, comparison, modules/<name>.md,
                        # design/ (proposals + archive/ for superseded ones, and
                        # decision-log-archive.md — the full history)
.claude/agents/         # subagent definitions
vx.workspace.ts         # declares otel() + the local executor and cache plugins
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

## Never stop — run cycles (standing owner directive, 2026-07-27)

**"Continue on cycles, never stop."** Work is CONTINUOUS, not request-driven.
There is no state in which this project is "done" and waiting for input; a
finished wave is the start of the next one, and **the plugin architecture
and `@vzn/vx-reapi` are the named default subject** when nothing more urgent
is open (owner, 2026-08-23, replacing vx cloud — which was removed in full
that day).

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

**For the plugin/REAPI arc specifically**, rotate across: the three seams
themselves (`executor`, `cache`, `telemetry` — a seam that only core's own
plugin can satisfy is not a seam), the cache-key derivation and the
stale-hit class it guards, `@vzn/vx-reapi`'s wire (digests, the Merkle
input tree, `FindMissingBlobs` upload minimality), the scheduler's
admission and placement, and the docs that describe all of it. A feature is
not done until its docs land in the same wave — that is the 2026-07-16
directive, and it survived the cloud removal.

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
  a type error. Run `bun src/bin.ts run ci` from the ROOT (oxlint inside a
  package reports phantom errors — ignore patterns are root-relative;
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
- **Scratchpad hygiene.** Use the session scratchpad dir, never a bare `/tmp`
  path (a stale sibling-session file once overwrote live work), and never let
  a `cd` persist across a compound command whose later steps use relative
  paths.
- **A feature is not done until its docs land in the same wave.**
- **Correct entries IN PLACE.** An entry that turns out wrong gets corrected,
  never quietly dropped. Never write a plausible cause you have not proven.

### Live invariants

- **Versions** (verify in source before quoting): `CACHE_VERSION`
  `vx-cache-v26`, core `SCHEMA_VERSION` `v24`, `TELEMETRY_SCHEMA_VERSION` 2,
  `LOG_WIRE_VERSION` 1.
- **When to bump `CACHE_VERSION`:** only when STORED BYTES are wrong under an
  UNCHANGED key (v25/v26 both were). A key-derivation fix whose old key was
  already WRONG is self-healing — it misses once, re-runs, re-caches, and can
  never serve a wrong hit — so it does NOT bump. Say which case applies in
  every entry.
- **Key derivation:** xxh3, seed-chained per part (`xxh3(part, prevDigest)`),
  `\0` part delimiters, git blob OIDs for tracked-clean files (zero reads),
  PURE-INPUT transitive hashing (upstream INPUT keys, never output content —
  early cutoff was reverted in v22), plus the project's `package.json` bytes
  and the workspace fingerprint. `exec.resources` and `exec.remote` are
  STRIPPED — both are pure PLACEMENT (tuning a reservation, or pinning a task
  to this machine, never busts a cache); `timeout`/`retries` are deliberately NOT.
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
  cache error degrades to a MISS; a never-fail plugin must still WARN (a
  silently discarded ingest shipped once).
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
  shared `hasFlakeSignal` on the core façade.
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
  seams, `@vzn/vx-reapi` ships the Bazel AC/CAS wire, Turbo interop is a
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
- **The macOS sandbox suites are load-flaky as a CLASS.** Two different tests
  failed in two consecutive full-suite runs on Bun 1.4.0 —
  `sandbox-runtime` "still denies an undeclared read through a symlinked
  workspace root" (zero `sandboxViolationLines` where a denial should name
  `token.txt`) and `verify` "proves a task whose declared inputs are
  complete" — and BOTH pass in isolation, 3/3 on re-run. Same family as the
  recorded `--verify=inputs`-on-macOS defect: sandbox-exec behaviour under
  concurrent load. Invisible in CI (ubuntu-only), which is the same blind spot
  the darwin-job item covers. Worth root-causing rather than retrying, because
  the symptom is a violation-reporting path reporting NO violations — which is
  indistinguishable from "the sandbox allowed it".
- The GHA job-summary plugin and the PR check-run integration went with the
  cloud removal (2026-08-23). Core's `--report=markdown` / `--report-file`
  still produce the table; the automatic-on-every-run plugin and the Checks
  API surface need `@vzn/vx-github`.

### Recent entries (2026-08)

- **2026-08-23 (sixth wave) — the Bun http2 limit is PEER-DEPENDENT, not a
  number; `chunkBytes` became a real escape hatch.** Owner asked to check
  Bun's issues and code for the actual limit. The tracker has the mechanism
  and it is largely FIXED: **#26915** (closed 2026-03-01, "client ignores
  `initialWindowSize` and never sends `WINDOW_UPDATE` — streams stall at
  65 535") and **#30342** (closed 2026-07-24, the same class from the SEND
  side, reported through `@grpc/grpc-js`: a body over 65 535 hangs when "the
  peer sends a connection-level `WINDOW_UPDATE` followed by a `SETTINGS` frame
  that increases `SETTINGS_INITIAL_WINDOW_SIZE`"). Maintainer's root cause:
  `handleSettingsFrame()` gated the per-stream window update on the
  CONNECTION-level `remoteWindowSize`, so the per-stream update was skipped and
  queued DATA hung forever; **fixed by #31584** (merged 2026-06-18) by applying
  the RFC 7540 §6.9.2 delta to every stream. **That fix is why 1.4.0's ceiling
  ROSE (~64 KB → ~216 KB) instead of the hang vanishing** — which explains the
  version-dependence measured in the previous wave. **The decisive new
  finding:** holding the client shape constant and changing ONLY the peer, the
  identical "4 MB in 256 KB writes" pattern HANGS against bazel-remote (Go
  gRPC, BDP window growth) and COMPLETES against a `node:http2` server at both
  64 KB and 256 KB initial windows. So the ceiling is a property of the peer's
  flow-control behaviour, and **there is no server-independent safe size above
  65 535** — the RFC default initial window every peer must honour with no
  `WINDOW_UPDATE` at all. 128 KB is MEASURED safe against bazel-remote and
  stays the shipped default per the owner's call; it is UNVERIFIED against
  NativeLink (Rust/tonic), BuildBuddy and Buildbarn. Shipped
  `reapi({ chunkBytes })` + `SAFE_CHUNK_BYTES = 65535` so a deployment that
  wedges can drop without waiting for a release, validated at construction (a
  bad chunk size does not error at the wire — it makes a malformed or infinite
  write loop), and exercised END-TO-END against the real server at both values
  rather than left as a field nobody proved routes anywhere. **Exact 1.4.0
  boundary, binary-searched: 220 928 bytes works / 221 056 hangs**, and the
  hang is PERMANENT — re-verified over a 120-second budget specifically
  because Bun **#39796** (OPEN) describes a ~28 s inbound-frame stall on 1.4.0
  that recovers, and my original probes used a 25 s timeout. That could have
  made a recoverable stall look like a hang; it did not, but the check was
  owed. NativeLink could not be tested — `ghcr.io/tracemachina/nativelink` did
  not resolve — so the multi-server claim is honestly scoped to the two peers
  actually measured.

- **2026-08-23 (fifth wave) — `@vzn/vx-reapi` phase 1 SHIPPED: a remote cache
  on any Bazel REAPI server, at 128 KB chunks by owner decision.** Owner call
  after the spike: use 128 KB, not the 64 KB I had argued for. 128 KB works on
  Bun 1.4.0 and HANGS on 1.3.x, and `package.json` declared `bun >= 1.3` — so
  the decision was taken WITH a version gate rather than argued against:
  `engines.bun` is now `>=1.4` and `assertBunSupportsChunking()` throws a named
  error at client construction on anything older. The failure being guarded is
  a HANG, which gives a user nothing to act on, so a startup refusal is
  strictly better than the alternative. **The mapping, and why the ActionCache
  is needed at all:** a CAS digest is the sha256 of the CONTENT, so it cannot
  be derived from a vx key before the bytes exist — `has(key)` could never
  answer. The AC supplies the indirection: a SYNTHETIC action digest
  `sha256("vx-reapi-v1\0" + key)` addresses an ActionResult whose one output
  file points at the artifact blob in CAS (the Gradle/sccache convention for
  reusing an AC as a key/value store). The `vx-reapi-v1` prefix does two jobs —
  it keeps vx keys out of the address space of real Bazel action digests on a
  shared server, and it makes a future mapping change MISS cleanly rather than
  read bytes written under different rules. `durationMs` rides `stdout_raw`,
  and the read path accepts `stdout_digest` too because bazel-remote
  normalises inline stdout into CAS (spike finding, §14). **Zero core change:**
  the plugin fills the existing `RemoteCacheLayer` seam (`has`/`get`/`put`) and
  composes through core's `LayeredCache`, so read-through, hydrate-on-hit,
  background upload drain and degrade-to-miss are all core's, unmodified.
  Declines with no endpoint, so it is safe to leave declared. **Verified
  against a LIVE bazel-remote, not a mock:** 16 tests green including a 1 MB
  artifact spanning 8 ByteStream messages restored byte-identical, an unknown
  key as a MISS not an error, a re-put skipping the upload via
  `FindMissingBlobs` while still refreshing the entry, and — the one worth
  keeping — an AC entry pointing at an evicted blob reading as a MISS rather
  than crashing, since the two stores prune independently and a dangling entry
  is an ordinary state. **Differential on the load-bearing constant:** setting
  `CHUNK_BYTES` to 512 KB FAILS the multi-chunk round-trip; restoring 128 KB
  returns 16/16. The constant is proven, not asserted. **Gating, per "a skip is
  a silent PASS":** the round-trip suite skips without
  `VX_REAPI_TEST_ENDPOINT`, but `VX_REQUIRE_REAPI=1` turns an absent endpoint
  into a FAILURE — verified in both directions. **A gap this wave closed
  incidentally: `packages/*/tests/` ran NOWHERE in CI.** The root `test` task
  is anchored to `./tests/`, and the only job that ran package suites was the
  cloud one, deleted earlier today — so `vx-otel`'s 44 tests had been unguarded
  since. A new `packages` CI job runs both plugin suites, with bazel-remote as
  a service container so the REAPI round-trip gates a push. Docs landed in the
  same wave (package README + the remote-caching guide), per the standing rule.
  NOT shipped: remote EXECUTION (the `executor` capability) — phase 2.

- **2026-08-23 (fourth wave) — the mandated gRPC-on-Bun spike: a real Bun
  defect, a one-constant workaround, and a wrong conclusion I had to correct
  within the hour.** Ran against a real `bazel-remote` container, as the
  design's §9/§11 required "before any core change". **Result: the risk is
  RETIRED. `@grpc/grpc-js` works on Bun — no new dependency, no custom
  transport, no proxy, no external binary — provided each ByteStream message
  carries at most 64 KB.** 12 MB uploads in 192 × 64 KB chunks at 88 MB/s.
  **CORRECTION, recorded in place per the standing rule:** my first write-up
  of this spike concluded "phase 1 is not shippable as designed" and offered
  four unpalatable options (wait upstream / ship size-capped / abandon REAPI
  portability / park the arc). That was WRONG in its consequence and it was
  pushed before it was wrong-proofed. The owner rejected all four options and
  said find another way — which was right, and finding it took three more
  probes. The underlying defect is real and reproduces exactly as first
  described; the error was inferring that it blocked phase 1. **The defect,
  characterised properly:** Bun's `node:http2` hangs when a request carries
  MORE THAN ONE message and any single message exceeds ~64 KB — the HTTP/2
  default stream flow-control window (65535); it appears not to process the
  `WINDOW_UPDATE` needed to keep sending. A lone message of any size is fine
  (the stream ends immediately and Bun flushes it), which is exactly why the
  early probes looked self-contradictory: 1×3 MB worked, 2×100 B worked,
  3×1 MB hung. **The variable is per-message SIZE, not total bytes and not
  message count** — 64 KB × 192 = 12 MB works while 128 KB × 4 = 512 KB hangs.
  **Ruled out, each by an executed probe rather than by reasoning:** not
  grpc-js (hand-rolled gRPC framing over raw `node:http2` hangs identically);
  not the backpressure handling (a no-`drain` version hangs the same); not
  multiple `write()` calls (concatenating every frame into ONE write hangs
  too); not `subarray` byteOffset handling (copying each chunk changes
  nothing); not the server (Node 24 succeeds against the same container at
  every chunk size); and not a version regression — 1.3.14 and 1.4.0 both
  exhibit it. **Upgrading Bun does NOT fix it, it MOVES the threshold:** on
  1.3.14 the safe ceiling is ~64 KB, on 1.4.0 it is between 192 and 256 KB.
  That is precisely why the constant stays at 64 KB rather than "the largest
  that works today" — the safe value is not something a future Bun is obliged
  to preserve, and exceeding it does not error, it HANGS. Worth an upstream
  report; vx is not blocked on it. (Local Bun was upgraded 1.3.14 → 1.4.0 in
  this wave so the dev runtime matches CI's `bun-version: latest`; the whole
  suite is green on it.)
  **Also verified working on Bun:** proto-loader parses the full REAPI set in
  28 ms and builds all four service clients; every unary call round-trips
  bytes verified identical; server-streaming `ByteStream.Read` returns 2 MB in
  32 chunks intact; a MISS is gRPC code 5 NOT*FOUND (the degrade-to-miss
  signal); an oversized unary call is refused cleanly (code 8, `larger than
max 12582997 vs 4194304`) rather than truncated. **TWO FALSE PASSES, both
  caught by the standing rules:** (a) "2 MB ByteStream write succeeded" was
  really the server short-circuiting a blob the previous line had already
  uploaded — re-run with a blob it had never seen, it hung (\_assert the
  precondition, not just the outcome*); (b) port 9092 was already bound by an
  unrelated local service, so the first container never started and the probe
  would have talked to something else entirely. **A third finding, directly in
  phase 1's path:** bazel-remote REWRITES `stdout_raw` into a CAS blob and
  returns `stdout_digest`, verified to genuinely store the blob (precondition:
  absent; after: present, byte-identical) rather than leaving a dangling
  reference — so a portable client must accept EITHER form on read, and vx's
  cached entry carries stdout. **For the implementation:** `CHUNK_BYTES =
64 * 1024` belongs in the ByteStream writer with a comment pointing at
  `docs/design/plugin-executor-reapi-2026-08.md` §14, and it needs a test that
  fails if someone "optimises" it upward — a larger chunk does not error, it
  HANGS, which is the worst way to find out. **Method lesson for me:** I
  published a blocking conclusion from a probe matrix that had an unexplained
  inconsistency in it (1×3 MB worked while 3×1 MB hung). The inconsistency was
  the finding. Resolve contradictions in the data BEFORE drawing the
  conclusion, not after someone pushes back.

- **2026-08-23 (third wave) — vx cloud REMOVED IN FULL, and core's whole-run
  `backend` seam with it.** Owner directive, mid-session: "Remove vx cloud in
  full. We now focus on modular architecture plugins and reapi." Two scoping
  calls were the owner's, not mine: `backend` goes too (it was cloud's only
  consumer, and the design doc §6 already scheduled its deletion for the day
  cloud's dist half retired), and the cloud design docs MOVE to
  `docs/design/archive/` rather than being deleted — they are the record of
  what was explored and why. **What went:** `packages/cloud` (204 files,
  ~48k lines of TS — server, auth/RBAC, Postgres analytics, S3 blob backend,
  the dashboard SPA, the distributed-execution controller and agent loop, the
  `cloud()` plugin), core's `protocol.ts` / `wire.ts` / `wire-render.ts` /
  `cli/backend.ts`, the `backend` capability + `BackendContext` +
  `resolveBackend`, and 21 façade exports (the JSON-RPC envelope, the
  `RunRequest`/`RunResult` mappers, `createWireRenderer`). Net
  **+4,830 / −75,835 across 309 files.** **What core is now:** three seams —
  `executor` (where ONE task's command runs), `cache`, `telemetry` — none
  applied by default, and a run ALWAYS executes in the `vx run` process.
  `cli/run.ts` calls `run()` directly where it used to resolve a backend.
  That property is the whole argument: `backend` moved the SCHEDULER
  server-side, which is what forced cache restore, output materialisation,
  task logging and telemetry to be re-implemented there and made a
  distributed run permanently telemetry-blind. **Salvage, not deletion, for
  one type:** `RunResult` moved to `run-report.ts`, its only remaining
  consumer, so `--report=markdown` still works. **Tests:** 4 wire-only suites
  deleted (`protocol-map`, `wire`, `wire-render`, `wire-roundtrip`); 10 more
  had seam-only cases surgically removed and their core coverage kept; the
  `options-resolve` serialization-boundary block went with the mappers it
  tested. Two CROSS-PACKAGE tripwires in core (`status-vocabulary`,
  `failure-mode`) read cloud SOURCE to prove one definition stayed one
  definition — their cloud halves are gone, their core halves kept, and the
  reason each pin exists is preserved in its comment. **A real casualty,
  recorded not hidden:** the GHA job-summary telemetry plugin and the PR
  Checks-API integration lived in `packages/cloud`. Core's
  `--report=markdown` / `--report-file` still produce the table (the manual
  `$GITHUB_STEP_SUMMARY` recipe is intact), but the automatic-on-every-run
  plugin and the check run need `@vzn/vx-github`. Both `guides/ci.md`
  sections now say exactly that rather than describing a feature that no
  longer exists. **Also removed:** the `docker.yml` and
  `vx-distributed-ci.yml` workflows, the `cloud` CI job (which had been RED
  since `9fb3390` — see below), the `build.cloud.*` and `build.ui` tasks, the
  `vx-cloud` half of `build-npm.ts` and `npm.yml` (10 published packages → 5),
  the `packages/cloud/ui` workspace member, and the `vx-cloud` bin link in
  `link-self.ts`. `build.bun.*` had a stale `dependsOn: ['build.ui']` — core
  has not embedded the SPA since the split, verified by grep before cutting.
  **Found on the way in, and it is a process finding:** `vx-cloud tests
(postgres)` had been red on main since `9fb3390`, two commits before my
  own, because the no-defaults wave (`c0d85d5`) swept core's 38 test fixtures
  to declare `localExecutorPlugin()`/`localCachePlugin()` and never touched
  `packages/cloud/tests/`. 21 failures, all `MISSING_PLUGIN_HINT` from
  `resolveCache`. It stayed invisible because the LOCAL gate
  (`bun src/bin.ts run ci`) does not run the cloud suite — it needs Postgres —
  so a green local gate and a red main were fully compatible. The standing
  rule already says "confirm the REAL CI conclusion after pushing"; this is
  the second time it has been the thing that mattered. Moot now, but the
  lesson is not: **a gate that cannot run locally will go red unnoticed.**
  **Verification:** `bun src/bin.ts run lint` green from the root (oxlint
  type-aware + oxfmt), full suite green, the docs site builds and a grep over
  `apps/docs/dist/` finds ZERO remaining `/vx/cloud/` links (the landing
  page's cloud feature card became the REAPI remote-cache card). `bun install`
  reproduces cleanly with the workspace member gone. No CACHE_VERSION or
  SCHEMA bump: nothing about key derivation, stored bytes or the telemetry
  record shape changed.

- **2026-08-23 (second wave) — placement and executor pools shipped, and the
  new `exec.remote` field was BUSTING THE CACHE KEY.** Continuation of the
  same day's executor-seam wave, working follow-ups 2 and 3 from
  `docs/superpowers/plans/2026-08-22-executor-seam-builtin-plugins.md`.
  **Placement** is decided ONCE per task, before scheduling (`placeTasks` in
  `run.ts`): `selectExecutor` now takes a `TaskPlacement`, not an
  `ExecuteRequest`, because the scheduler has to know a task's pool before
  the first attempt exists. A task is `pinnedLocal` when it is persistent,
  transitively depends on a persistent one (a worker cannot reach a port on
  the submitter), or declares `exec.remote: false`; a `remote: true`
  executor is never offered such a task, and only then does `accepts()`
  decide. **Pools:** an executor declaring `capacity` gets its own admission
  counter — its tasks occupy that pool instead of local worker slots and
  reserve ZERO local resources (work on another machine spends none of this
  machine's CPU/RAM), so `--concurrency 1` still keeps a 6-wide pool full
  (pinned). With no pooled executor the gate is the byte-identical legacy
  `active < concurrency` check, including the O(1) early-out. Restore-tier
  work stays local by construction — a restore is a tar extract on this
  disk. **The defect I found auditing the wave: `exec.remote` was FOLDED
  INTO THE CACHE KEY.** Repro before fix — two configs differing only in
  `remote` hashed differently (`cd3a01e2…` vs `724a7833…`). It is placement,
  not content: the entire contract of a remote executor is that the same
  command over the same inputs yields the same bytes, so a key that moved
  with placement would split a laptop from a worker pool over nothing and
  gut the remote hit rate — the identical argument that strips
  `exec.resources`. `hashableConfig` now strips both. NO CACHE_VERSION bump:
  a config declaring neither field takes the unchanged fast path and
  stringifies byte-identically, and `remote` had never shipped, so no stored
  key was ever derived from it. Differential: of the 2 new
  `task-hash-derive` pins, exactly 1 fails without the strip; the other is a
  CONTROL (with `remote` declared on both sides, a differing sibling
  `timeout` must still move the key) that passes both ways — the guard
  against a strip that is too wide. **`--dry` now
  names the placed executor per task**, because `exec.remote` was otherwise
  INVISIBLE: nothing in a run's output says where a task went, so a
  mis-declared pin reads exactly like a correct one. It renders as
  `@<executor-name>`, NOT a `local`/`remote` word — that output already
  spends both on the cache tier ("2 cache hits (1 local, 1 remote)") and a
  second vocabulary on the same line would be ambiguous. Attached only when
  the workspace declares more than one executor (with one, every line says
  the same thing); resolving the executors at plan time is the same
  plugin-factory call `prepareRun` already makes for the cache capability, and
  a throwing factory costs the label, never the plan. **A landmine removed on
  the way:** `run.ts` was passing `executors[executors.length - 1]` as the
  executor for any task without a placement (groups, persistents). Harmless
  today — both dispatch before `args.executor` is read — but with
  `[localExecutorPlugin(), reapi()]` that fallback is the REMOTE one, so a
  refactor routing a persistent task through the exec path would have shipped
  a localhost server to a worker. It is now an `UNPLACED_EXECUTOR` that
  THROWS. **`TaskInputs.upstream` gained each dependency's declared
  `outputs`** (workspace-relative, from the local index in one batched
  SELECT; empty for a non-cacheable upstream) and `ExecuteRequest` gained the
  task's own declared output globs — what an input-shipping executor needs to
  build the input root and to know what to bring back. **NOT shipped, and
  deliberately:** `exec.remote: 'only'` (the design's inverse pin) — it has
  real local behaviour (skip the task, never clean or restore its outputs
  here) and with no input-shipping executor in existence a user who declared
  it would get a silently skipped task; widening the type is additive when
  the REAPI plugin lands. `TaskOutcome.where` likewise waits for an executor
  that can report a worker. Both recorded in the design doc §5 rather than
  left as a gap between design and code. Gate: `bun src/bin.ts run lint`
  green from the root; full suite green. One pre-existing load flake
  (`cli.test.ts` "root-subdir change re-runs" times out at 45 s under full-suite
  load, passes in 0.4 s in isolation) — present in the baseline run too, not
  from this diff. The `@vzn/vx-reapi` scaffold and its `bun.lock` entry stay
  UNCOMMITTED: that is phase 1 of the design and lands with its own gRPC
  spike, not bundled here.

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

**OWNER DIRECTIVE 2026-08-23 — vx cloud is REMOVED IN FULL.** The
self-hosted platform (`packages/cloud`, ~48k lines), core's whole-run
`backend` capability and everything that existed only to serve it
(`protocol.ts`, `wire.ts`, `wire-render.ts`, `cli/backend.ts`, the
JSON-RPC envelope, the `RunRequest`/`RunResult` mappers) are gone. The
focus is now **modular plugin architecture + `@vzn/vx-reapi`**. Superseded
design docs live in `docs/design/archive/`; the code is in git history.

Core's contract is now exactly three seams — `executor` (where ONE task's
command runs), `cache` (where artifacts live), `telemetry` (where run
records go) — none of them applied by default. A run always executes in
the `vx run` process; the scheduler never leaves. That is the property
the removed `backend` seam destroyed and the reason it went.

The near-term roadmap is `docs/design/plugin-executor-reapi-2026-08.md`:

1. **`@vzn/vx-reapi` phase 1 — remote cache over AC/CAS.** The `cache`
   capability only, zero core change. Doubles as the mandated
   gRPC-on-Bun spike (`@grpc/grpc-js` vs Connect-ES over `node:http2`)
   against a local bazel-remote and NativeLink. The scaffold (protos +
   manifest) is already in `packages/vx-reapi`.
2. **`@vzn/vx-reapi` phase 2 — remote execution.** `Execute` →
   `Operation` stream, the Merkle input tree built from
   `ExecuteRequest.inputs`, an `(path, size, mtime_ns)` digest cache,
   pnpm slicing, and the `install`-as-an-action recipe.
3. **`exec.remote: 'only'`** — the inverse pin. Deliberately deferred
   until phase 2 gives it a purpose (a schema field whose only effect is
   "silently skip locally" is a footgun without a remote executor).
4. **`ExecuteResult.outputs` discriminator** (`disk`/`cache`/`deferred`)
   - `--download=all|toplevel|none`, and `TaskOutcome.where` so telemetry
     can attribute a task to a worker.
5. **`@vzn/vx-github`** — salvage the GHA job summary + the Checks API
   PR check run, which went with the cloud package. A telemetry plugin
   needing only `GITHUB_TOKEN` + `checks: write`; no server. Core's
   `--report=markdown` / `--report-file` still cover the manual path.
6. **A darwin CI job.** Three macOS-only defects reached main unseen
   (tar format, symlinked-base containment, `close()` on an unlinked DB).
   `ubuntu-latest`-only is the structural cause.

Longer-horizon core gaps stay sourced from `docs/comparison.md`.

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
  magical"), not a gap; traced inputs aren't derivable before execution.
  Declared `cache.inputs.files` + `runtime`/`workspaceFiles` stay the only
  input surface.
- **Rebuilding a first-party platform** — the dashboard, accounts, RBAC,
  Postgres analytics and distributed-execution controller were removed on
  2026-08-23 by owner decision. Anything wanting them builds on the
  `telemetry` and `executor` seams, out of process.

## Operating directive (to you, Claude)

You own this project. The owner has delegated full maintenance. Each turn:

1. Identify the next valuable thing.
2. Do it (run the full local gate, then push directly to `main` — see
   "Workflow"; no PRs).
3. Record the decision here when one is made.
4. Never end a turn with "what next?" — say what you are doing next.

**Run cycles continuously** — see "Never stop — run cycles" above for the
audit → fix → verify → record → land loop and the plugin/REAPI rotation. A landed
commit is the start of the next cycle, never a stopping point.

When uncertain about a non-trivial architectural call, use the **architect**
subagent (`.claude/agents/architect.md`). When you have a design and need to
implement, use the **developer** subagent (`.claude/agents/developer.md`).
Both should read this CLAUDE.md first.
