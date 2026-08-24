# `@vzn/vx` — project memory for Claude

A monorepo task runner for pnpm workspaces. Bun-only (≥ 1.4). Pre-alpha.
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
| Runtime         | Bun ≥ 1.4 (no Node fallback; `Bun.Archive` is a hard dependency)           |
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
    index.ts cache.ts layered-cache.ts chained-cache.ts inputs.ts archive.ts
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
  `vx-cache-v27`, core `SCHEMA_VERSION` `v24`, `TELEMETRY_SCHEMA_VERSION` 2,
  `LOG_WIRE_VERSION` 1.
- **When to bump `CACHE_VERSION`:** when STORED BYTES are wrong under an
  UNCHANGED key (v25/v26 both were), or when the artifact CONTAINER changes so
  an old artifact would restore wrong rather than miss (v27). A key-derivation fix whose old key was
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
- ~~CI is `ubuntu-latest` only~~ — **CLOSED 2026-08-24**: a `core-darwin`
  job runs the full core suite on `macos-latest`. Deliberately WITHOUT
  `VX_REQUIRE_SANDBOX` (the macOS sandbox suites are the recorded load-flaky
  class; the security boundary stays enforced on the linux job) — promoting
  the flag there is the follow-up once the runners prove stable.
- `--info` and `--cache-local` are byte-identical tokens (56 189 248), so a
  blue line is ambiguous between "informational" and "cache". Changing a token
  value moves the visual baselines — a design call.
- ~~`isOutputsCurrent` compares size+mode+second-mtime~~ — **STALE, corrected
  2026-08-24 by probe**: the check compares at MILLISECOND precision with a
  restore-time re-sync, and a same-size same-second different-ms edit IS
  caught (now pinned in `cache-baseline.test.ts`). The remaining residual is
  a same-size edit with a FORGED identical mtime (`touch -r`) — pinned as
  the accepted trade (git's index makes the same one); closing it would cost
  a content hash per output on every warm hit.
- `LayeredCache` in-memory pack path (`--cache=local:,remote:rw`) still holds
  artifact bytes in RAM; `drainUploads()` has no timeout and is deliberately
  outside the throw-path `finally` (awaiting a wedged remote would turn a
  failing run into a hanging one).
- Task-log caps count CHARS, not memory (~36× overhead at 1-char chunks);
  when failures alone exceed the run budget the OLDEST failure is stubbed
  first (usually the root cause).
- **macOS sandbox violation REPORTING is lossy-by-OS under load — measured,
  partially mitigated, residual unfixable client-side.** Root-cause hunt
  (2026-08-24): ~430 runs/arm under full-suite load, every failure the same
  mode — denial ENFORCED (r.ok false), violation lines EMPTY. A bounded
  settle-poll on the async SRT store (fail-exit + empty store only) halves
  the loss, 5.0% → 2.2% (22/442 vs 9/413, z≈2.2; arms run sequentially, not
  interleaved — noted). The residual survives a full 1 s window: those
  unified-log records were DROPPED under pressure, not delayed, and no poll
  recovers a record that never arrived. So local flake ~2% remains on
  loaded runs; darwin-CI is class-gated. The round-two "non-enforcement"
  reading was CORRECTED 2026-08-24: `ok=true` on that fixture is ambiguous
  (it swallows the read error), a discriminating probe classifies every
  observed false pass as reporting loss with enforcement intact, and the
  canary (n=100) has never seen `not_enforced`. The hunt is therefore for
  reporting loss only; the settle window now also covers clean-exit
  verify tasks (`settleOnCleanExit`), which that shape previously never
  got.
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

- **2026-08-24 (twenty-fourth wave) — the cache artifact container moves to
  `Bun.Archive`; CACHE_VERSION → v27; a stale "we benchmarked this and said
  no" note corrected in place.** Bun 1.4 landed `Bun.Archive` (libarchive),
  and the tar layer was the largest hand-rolled thing in the tree: a 480-line
  header parser (ustar prefix joins, GNU `L` longnames, PAX skipping,
  AppleDouble filtering, typeflag rejection) plus a `tar` SUBPROCESS on the
  save path — the one that needed a per-host `--format=gnu` vs `--format=gnutar`
  probe because bsdtar refuses GNU tar's spelling, which had already broken
  EVERY save on macOS once. All of it is gone; `src/cache/archive.ts` is
  pack + read + extract and the containment checks libarchive cannot make for
  us. **What libarchive does not carry is per-entry metadata in EITHER
  direction** — its writer takes `{name: bytes}` and its reader returns
  regular files only, no mode — so mode and MILLISECOND mtime ride a
  `.vx-meta.json` sidecar written from one stat per output at pack time.
  That is not a workaround, it is a strict improvement on two axes: the
  save path no longer needs its second stat pass to refine tar's
  seconds-precision mtimes, and a REMOTE-INGESTED entry now indexes the
  producer's millisecond values, which tar headers made impossible (pinned).
  Packing also no longer STAGES a copy of every output byte into a temp
  tree just so an external `tar` could see it under the right name.
  **Measured** on the real `Cache.save`/`restoreOutputs` paths, min-of-N,
  arms interleaved against a `git worktree` of the previous commit: pack
  1 file 6.15 → 0.32 ms, 20 files 11.9 → 0.65 ms, 300 files / 12 MB
  158 → 11 ms (~14×); restore a wash (0.27 / 2.16 / 33 ms, unchanged);
  artifact grows ~7 compressed bytes per output for the sidecar.
  **The correction:** `docs/optimizations.md` #12 recorded "kept the
  hand-rolled tar — `Bun.Archive` is 15–400× slower for our artifact shape
  (KB–MB, flat trees)". On Bun 1.4 that is false in both directions and the
  row is rewritten in place with today's numbers. A benchmark verdict has an
  expiry date when its subject is a runtime API under active development —
  re-measure before quoting an old "we evaluated this" as a reason not to.
  **Behaviour changes, all pinned:** a symlink/hardlink/device entry is no
  longer THROWN on, it is invisible to the reader and therefore
  unmaterialisable (stronger, but the pin had to move from the throw to the
  outcome); directory records are not surfaced, which changes nothing because
  declared outputs are globbed FILES; the AppleDouble `._*` filter is dropped
  with the tar subprocess that used to generate the records. **The bump is
  mandatory, not self-healing:** a v26 artifact has no sidecar, so a v27
  reader would restore its outputs mode-0644/mtime-now — wrong on disk rather
  than a miss. Full suite 2569/1, the one failure being the recorded macOS
  `--verify=inputs` ancestor-directory defect, REPRODUCED 3/3 on the unchanged
  worktree — differential, so not this change. Fixture lesson worth keeping:
  the artifact-roundtrip "hollow artifact" test built its fixture by spawning
  `tar --format=gnu`, which on macOS FAILS — so on darwin it wrote an EMPTY
  archive and passed for the wrong reason. It builds the archive in-process
  now.

- **2026-08-24 — Bun 1.4 floor: `>=1.4` everywhere, `@types/bun` 1.4, and the
  isolated linker arrived with it.** `Bun.Archive` is a hard dependency now,
  so the engines fields, `packageManager` and the three `@types/bun` pins all
  move to 1.4. Two Bun 1.4 features EVALUATED and NOT adopted, recorded so the
  next pass does not re-litigate them: (1) **`bun test --isolate` does fix the
  cwd-leak class** `tests/setup.ts` exists for — proven with a two-file probe
  (a file that `chdir`s and never restores; the next file sees the original
  cwd under `--isolate` and the leaked one without it) — but the core suite
  does NOT finish under it: killed at >20 min against a 140 s baseline, while
  a 4-file subset shows no overhead at all (426 vs 432 ms). Something in the
  suite wedges under isolation; unbisected, so the preload guard stays and
  this is the open item. (2) The `packages` CI job's **one-bun-process-per-file
  loop** is the obvious `--isolate` candidate (fresh globalThis + closed
  resources per file is exactly why the loop exists), but it cannot be verified
  locally without the REAPI servers and an unverified change to a gate is not a
  change — left as a candidate. Also noted: `bun install` under 1.4 relinked
  this workspace with the ISOLATED linker (`node_modules/.bun` store +
  symlinks, 8 top-level entries). Type-aware lint still resolves `bun-types`
  through the store — verified by planting a deliberate `TS2322` and watching
  `oxlint --type-aware --type-check` catch it, i.e. the gate is not vacuous.

- **2026-08-24 (twenty-third wave) — stable-keys audited: ALL CLEAN,
  three escape routes each refuted with the code that closes them.** The
  derivation feeding both remote-prefetch and the restore-tier classify —
  a wrong "stable" verdict is stale-hit-adjacent — got its first dedicated
  hostile pass. REFUTED #1 (the sharpest): a `cache.inputs.runtime`
  command reading a SIBLING project's outputs (`cat ../lib/dist/v.txt`)
  escapes all three stability clauses — but walking the third-state
  scenario to the end shows the upstream-key fold SUBSUMES the stale
  classify-time reading under the same determinism assumption pure-input
  hashing already makes: a hit under the wrong-keyed entry can only occur
  in a state where the entry's content is what a fresh execution would
  produce anyway. The class degrades to one spurious miss per upstream
  change, converging — never a stale hit. Runtime commands are run-level
  environment readings BY DESIGN (memoized per project+command for the
  whole run); caching.md now says so and tells users to declare a
  producer's output as an input instead of sampling it. REFUTED #2: the
  runtime memo cannot alias across projects — keyed `projectDir + '\0' +
command`, documented at the declaration. REFUTED #3: a parent project's
  `outputs.files` cannot write into a NESTED child project where the
  producer-project analysis would miss it — `resolveOutputs` excludes
  nested-project dirs (boundary enforced on outputs, not just inputs).
  Fourth consecutive surface to close clean or comment-pin-only: the
  audit rotation stays signal-driven. Canary #6 banked: 19/1/0;
  cumulative n=120, reporting loss 3.3%, non-enforcement still zero.

- **2026-08-24 (twenty-second wave) — the "non-enforcement" mode was a
  MISREAD of an ambiguous signal; the verify=inputs false pass is plain
  reporting loss, and the settle window now covers the clean-exit shape
  that was silently exempt.** A full-suite gate flake led into it: the
  `--verify=inputs` leaky-task test failed with `r.ok === true` even in
  ISOLATION. That fixture swallows its read error and exits 0, so
  `ok === true` cannot distinguish "read succeeded" (non-enforcement)
  from "denial enforced, violation record lost" (the known lossy unified
  log) — and the eighth wave had inferred NON-ENFORCEMENT from exactly
  this signal on CI. The discriminating probe reads the OUTPUT: 30
  standalone verify runs, every false pass came back with the fallback
  bytes, never the secret — denial ENFORCED, record LOST, 1/30 at idle.
  Same machine, same minutes, the canary (which reads out.txt, not ok)
  scored 20/20 enforced. So the eighth-wave claim is corrected IN PLACE,
  the open item's hunt narrows to reporting loss only, and the mechanism
  for the elevated rate on THIS shape is structural: the ninth wave's
  settle-poll gates on a FAIL exit, and a leaky-but-swallowing task
  exits 0 — the one case where an empty store is read as PROOF got no
  settle window at all. Fix: `ExecuteSandbox.settleOnCleanExit`, set
  exactly when the sandbox is verify-forced (a user sandbox's warm path
  stays free), plumbed through the local executor to `runSandboxed`,
  which now pays the window on `exitCode !== 0 || settleOnCleanExit`.
  Pinned twice: plumbing (a non-remote spy captures `true` under
  verify.inputs, `false` under a user sandbox — cross-platform) and
  behavior (darwin: a clean flagged run pays the FULL deterministic
  1 s window, ≥700 ms over its unflagged twin — relative bound, so load
  can't flake it). Honesty ledger: the plumbing pin failed ONCE on its
  first-ever execution (`plain.ok` false, mode uncaptured) and 0/40
  since with a diagnostic dump armed — recorded, not explained. The
  residual stays: a record the OS dropped is unrecoverable client-side;
  cli.md now tells verify users that Linux is the authoritative proof
  under load. The meta-lesson is the probe rule again, in its sharpest
  form yet: `ok=true` reached the wrong conclusion because the FIXTURE
  swallows the discriminating evidence — assert on the artifact
  (out.txt), not the verdict, when the verdict conflates modes.

- **2026-08-24 (twenty-first wave) — pool × resources audited: correct by
  code, previously guaranteed only by comment; now pinned with a
  discriminating overlap probe.** The question nobody had pinned: does a
  pooled (remote-executor) task's `exec.resources` reservation charge the
  LOCAL 2-D admission budget? It must not — the reservation describes the
  machine that RUNS the task, and charging it locally would let an
  over-budget remote task solo-clamp the submitter (idling every local
  worker while the work executes elsewhere). The code is right:
  `scheduler.costOf` zero-costs pooled tasks exactly as it does
  restore-tier ones, and the one real scheduler call site passes `poolOf`
  and `resourceCosts` together. But the guarantee lived in a comment with
  no test — the recorded defect class. The pin uses the discriminating
  shape: a pooled task with cpu:100 on budget 2 must OVERLAP in-flight
  local resource holders, because solo-clamp and axis-holding are mutually
  exclusive by construction — any charging regression makes the overlap
  impossible. Differential: dropping the `poolOf` arm from `costOf` fails
  exactly the new pin (85 ms, deterministic); restore 42/0. Also verified
  while in there: `resolveResourceCosts` is pure (over-budget is legal by
  design, no clamp/throw an oversized remote declaration could trip), and
  the second `resourceCosts` mention in run.ts is footer display, not a
  second scheduler. Canary #5 banked: 20/0/0; cumulative n=100, reporting
  loss 3%, non-enforcement still unobserved.

- **2026-08-24 (twentieth wave) — the glob→output_paths audit: both
  hypotheses REFUTED by live probe, and the two load-bearing behaviors are
  now pinned e2e.** Target: `globToOutputPath`/`outputPathSets`, the wire
  mapping deciding what a REAPI worker captures — untested against reality
  since the decoder wave. Hypothesis A (a first-segment wildcard maps to
  `''`, which the spec sanctions only for the DEPRECATED
  output_directories field — a v2.1 server might reject it or the capture
  might be pathological): REFUTED on NativeLink — `''` on `output_paths`
  is honored as whole-working-directory capture, undeclared siblings and
  inputs included. Judged CORRECT-BY-NECESSITY, not a defect: REAPI has no
  glob wire, `''` is the only spelling that cannot lose the match, whole-
  tree materialisation is exactly what a LOCAL run leaves on disk (parity,
  not pollution), and the cache stays narrow because save re-globs the
  declared patterns from disk. Residual costs recorded: input files are
  rewritten byte-identical (mtime churn → next run's git index re-stat),
  and a stricter third-party worker may reject the gray-area spelling —
  documented in the remote-execution guide with "prefer a literal first
  segment". Hypothesis B (`outputs.workspaceFiles` rebase to `../…` paths
  a worker might refuse, silently dropping workspace outputs): REFUTED —
  the parent-relative path round-trips and materialisation resolves it to
  the workspace root. Both behaviors pinned in `exec-e2e.test.ts` (9/0
  live). Probe-harness slip worth the line: the pins were first appended
  into a DIFFERENT describe than the helper they called (`request` vs
  `req3`) and failed in 13 ms with a ReferenceError — a fail that fast is
  a harness fail, read the error name before the hypothesis. Canary #4
  banked from the chained-cache push: 20/0/0; cumulative n=80, reporting
  loss 3.75%, non-enforcement still unobserved.

- **2026-08-24 (nineteenth wave) — ChainedCache audit: the headline
  hypothesis refuted, two real defects confirmed by failing pins.** Audit
  target chosen by the new-code rule: the 2026-08-23 chained-cache wave.
  REFUTED: the "LayeredCache runs only" gates on remote-prefetch and the
  short-circuit do NOT break under ChainedCache — both key on the layer's
  own `hasRemote` (run.ts even documents why not `instanceof`), and
  ChainedCache derives it from any layer. CONFIRMED #1 (waste): two layers
  wrapping the SAME local handle — `reapi({endpoint:A}), reapi({endpoint:B})`
  is in-tree-reachable today — packed and wrote every miss artifact TWICE
  (`Cache.save` never short-circuits, deliberately: `--force` must rewrite).
  Fix: `ChainedCache.save` passes `skipLocalWrite` to layers whose `local`
  an earlier layer already saved; the guard lives in ONE place (`Cache.save`
  returns early) — my first cut also honored it in `LayeredCache` and the
  differential caught the redundancy: the mutation SURVIVED because the
  second guard covered it, which is the two-owners smell, so the redundant
  copy was removed and the differential re-run against the real owner. Both
  remotes still receive the artifact (pinned). CONFIRMED #2 (a lost remote
  hit): `remoteHasMany` returned a PARTIAL union — one layer answering and
  a sibling that cannot batch (`hasMany` absent: an older serve) yielded a
  non-null result the caller treats as authoritative for the whole chain,
  so its complement was broadcast via `markRemoteAbsent` and the non-batch
  layer's inflight map was poisoned `false` for hashes its remote HAS: the
  later lazy `get` skipped a REAL remote hit and the task re-executed. Not
  a stale hit (outputs stay correct) — a silently lost hit. Fix: each
  answering layer gets its OWN complement marked (also sparing it per-hash
  GETs for hashes only a sibling holds), and the union is returned only
  when every remote layer answered; partial = `null` = the caller's
  per-hash fallback, where answered layers short-circuit via their marks.
  Probe-harness lesson re-learned: my first poison pin called
  `markRemoteAbsent` UNguarded where the real caller only marks on
  non-null — the pin must mirror the caller's exact sequence — and the
  stub returned `{bytes, meta}` where the contract says `{body,
durationMs}` (transpile-only bun test cannot see that; the failing
  assertion looked like the fix not working when it was the harness).
  Differentials: guard removal fails exactly the pack pin; partial-union
  mutation fails exactly the poison pin; both restores verified 10/0.
  No CACHE_VERSION bump: stored bytes were never wrong — one defect wrote
  the same bytes twice, the other failed to read bytes that were there.
  Doc updated in the same wave (`docs/modules/chained-cache.md`).

- **2026-08-24 (eighteenth wave) — SpliceBlob proven live; the "blocked"
  label was half wrong and is corrected.** The log carried Split/Splice as
  "unexercised e2e — blocked on a server advertising them". Re-reading the
  original capabilities dump: bazel-remote advertises
  `splice_blob_support=true` — only SPLIT is absent. The assembly direction
  was therefore testable all along against the server CI already runs, and
  now is: chunks uploaded separately, the WHOLE blob asserted absent from
  CAS (precondition, not assumption), `SpliceBlob` assembles it
  server-side, presence + byte-identical readback verified. The e2e is
  capability-gated (`caps.spliceBlobSupport`) so it stays honest if a
  different server is wired in; `SplitBlob` remains genuinely blocked and
  keeps its label. The lesson is the mirror of the stale `isOutputsCurrent`
  item: a blocked-list overstating its blocks hides work exactly like an
  open-list overstating its defects hides fixes — re-read the EVIDENCE
  behind a label before trusting the label, including labels you wrote
  yourself the same day. Canary #3 also banked: 20/0/0; cumulative n=60,
  reporting-loss 5%, non-enforcement still unobserved.

- **2026-08-24 (seventeenth wave) — history/predict audited: ALL CLEAN, and
  one false alarm worth its lesson.** The surface feeding `--dry` ETAs and
  predictive scheduling, least-recently audited survivor of the old
  architecture. The false alarm: line 95 applies `EXECUTED_RUNS_SQL` to the
  whole history CTE while line 102 counts cache hits inside it — which
  would zero the hit-rate if the predicate excluded hits. It does not:
  `EXECUTED_RUNS_SQL` is literally `status <> 'skipped'`, hits pass, and
  the design comment above the query documents exactly that split
  (percentiles over executed successes only; rates over all non-skipped
  rows). READ THE PREDICATE BEFORE THE INDICTMENT — the name suggests more
  exclusion than it performs, deliberately. `predict.ts`: pure
  critical-path fold, the hits-not-modeled-as-zero choice documented with
  its rationale, median-then-constant fallback. Verdict for the rotation:
  three consecutive surfaces now close with one class-fix or clean
  refutations — audit density has caught up with change velocity, and the
  standing posture shifts to SIGNAL-DRIVEN: canary accumulation (n=40,
  reporting-loss confirmed on runners at ~7.5%, non-enforcement
  unobserved), CI, and upstream Bun releases are the triggers; the next
  hostile pass rides the next substantive change.

- **2026-08-24 (sixteenth wave) — the rest of the metrics audit: refutations,
  recorded so the next audit does not re-tread.** After the LIKE-class fix,
  the remaining suspicious shapes in `metrics.ts` were each read to a
  verdict. REFUTED: the three cache-savings AVG subqueries (the r24/rAll
  twins + the per-project copy) have NOT drifted — identical inner
  constraints (`cache_hit` null-or-zero + `status='success'`), the
  SUM-ignores-NULLs semantics deliberate and documented in place, the outer
  `IS NOT NULL` variants equivalent under SUM; three consistent copies of
  one decision, with the statuses inside them now guarded by the widened
  tripwire, so no refactor is warranted. VERIFIED CORRECT by reading: the
  unguarded `FROM runs` sites at 471/522/550 all carry explicit status
  filters that exclude skips and hits; 87 and 1103 are the completeness
  surfaces the invariant explicitly allows unfiltered. The metrics surface
  is now audited end to end this arc: one confirmed class (7 prefix
  matches, fixed by derivation), everything else refuted or
  verified-by-design.

- **2026-08-24 (fifteenth wave) — the status-prefix drift class survived in
  CORE: seven `LIKE 'cache-hit%'` copies, one of them inside the flakiness
  signal; killed by derivation and a widened tripwire that immediately
  out-audited the audit.** The metrics surface (feeds `vx mcp` — wrong
  answers there mislead AI agents silently) had six SQL prefix-matches on
  the hit statuses, the exact class the 2026-08-05 wave eradicated from the
  since-deleted cloud analytics. They survived because that sweep grepped
  `startsWith`, not SQL `LIKE` — "when a wave fixes a CLASS, grep the class"
  failed on a SPELLING of the class. Right answers today (the prefix
  happens to match exactly {cache-hit, cache-hit-remote}); drift by
  construction tomorrow (any future status sharing the prefix silently
  counts as a hit). Fixed the sanctioned way: `HIT_STATUSES` derived from
  `TASK_STATUSES.filter(isCacheHit)` beside the existing PASS derivation,
  all six sites now `status IN ${HIT_STATUSES}`. **The tripwire extension
  earned its keep before the commit existed:** widening the
  no-inline-enumeration scan to also flag `LIKE 'cache-hit%'` /
  `startsWith('cache-hit')` immediately failed on a SEVENTH copy my
  metrics-only sweep had missed — in `failure-mode.ts`, inside
  `mixedOutcomeKeys`, the flakiness signal itself. That live catch doubles
  as the differential (the widened scan demonstrably discriminates on a
  real offender, not a synthetic mutation). failure-mode now derives its
  own list from the same predicate; both derivations are pinned. Canary
  datapoint #2 also recorded this run: 18/2/0 at n=20 — runner reporting
  loss ~7.5% cumulative, non-enforcement still unobserved.

- **2026-08-24 (fourteenth wave) — a sandbox-enforcement CANARY now runs on
  every darwin CI pass, turning the unexplained non-enforcement mode into a
  data feed.** The mode (an undeclared read SUCCEEDING under the sandbox —
  seen once on a darwin runner, never locally) cannot be chased without
  observations, and the class gate that protects main also silenced the only
  source of them. The canary is data collection, not a gate: 20 leaky-task
  executions through the REAL `run()` path per darwin job, each classified
  ENFORCED_REPORTED / ENFORCED_UNREPORTED / NOT_ENFORCED / RUN_ERROR, a
  greppable `[canary] SUMMARY` line, environment dumped on any
  NOT_ENFORCED hit, `continue-on-error` + unconditional exit 0. **The
  harness lesson that shaped it:** the first draft hand-assembled
  `runSandboxed` baselines and reported NOT_ENFORCED 12/12 at IDLE — on the
  same machine where the real suites pass 27/0, i.e. when everything fails
  the harness is wrong, again. The canary therefore drives the exact
  production path (fixture workspace + `run()` + `sandbox: {}`), and its
  rewritten form reads 6/6 ENFORCED_REPORTED at idle. From here, every
  darwin CI log accumulates ~20 observations; the hunt resumes when
  `not_enforced=` goes non-zero with a uname and outcome attached instead
  of a mystery. **First runner datapoint (same day, run on `03b6865`):**
  `enforced_reported=19 enforced_unreported=1 not_enforced=0` — the
  REPORTING-loss mode reproduced on GH's runner at 1/20, consistent with
  the local post-settle-poll 2.2%, confirming the canary measures the real
  phenomenon on real runners; the non-enforcement mode did not appear at
  n=20, as expected for a rare event.

- **2026-08-24 (thirteenth wave) — main red on a DOCKER HUB 500, not our
  diff; the NativeLink step hardened against registries having bad days.**
  `plugin packages` failed on the refutation commit (which touched only
  core tests and CLAUDE.md) with ZERO test failures in the log — the
  standing rule's "read where the log actually ends" found the busybox base
  pull dying on `auth.docker.io` returning 500 inside the NativeLink rehost
  step. External infra, but a job that gates main must not depend on
  Docker Hub's uptime OR its unauthenticated rate limits from shared
  runners. Fix: the base image moves to AWS's mirror of the Docker Official
  Images (`public.ecr.aws/docker/library/busybox:musl` — pull verified
  locally before pushing), and the build wraps in a bounded 3-attempt
  retry so a residual blip warns instead of redding a push. The GHCR
  NativeLink pull and the bazel-remote service container stay as-is — the
  latter is Hub-hosted with no official mirror, accepted and noted.

- **2026-08-24 (twelfth wave) — the `isOutputsCurrent` open item was STALE;
  refuted by probe, both directions pinned.** The item claimed
  "size+mode+second-mtime, so a same-size same-second different-content
  output can skip a restore" — but the code compares at MILLISECOND
  precision with a restore-time re-sync, and the probe shows a same-second
  different-ms same-size edit IS caught. Someone closed the gap and the
  item never followed; an open-items list that overstates known defects
  costs audits exactly like one that understates them. The genuine residual
  was CONFIRMED by the same probe: a same-size edit under a FORGED
  identical mtime passes with wrong bytes on disk — the documented trade of
  every mtime-based skip check (git's index accepts the same), and closing
  it would cost a per-output content hash on every warm hit. Both
  directions are now pinned in `cache-baseline.test.ts`: the ms-sensitivity
  pin (with its same-second precondition ASSERTED, not assumed) so the
  closed gap cannot silently reopen, and the forged-mtime blind spot pinned
  as accepted-by-design so a future content-hash change has to update the
  contract deliberately. No code change — the finding IS the correction.

- **2026-08-24 (eleventh wave) — `--verify=inputs` × remote execution was a
  VACUOUS PASS; verify now pins placement local.** The undefined interaction
  nobody had thought through: `verify=inputs` proves input-completeness by
  forcing the OS sandbox onto the exec — but a remote executor has no
  sandbox (the reapi executor contains zero references to `req.sandbox`),
  so a remotely-executed task reported zero violations and the verify
  GREEN-LIT it, leaky or not. A false pass over the exact property the flag
  exists to prove, confirmed by code-flow before any probe (the executor
  ignores the baselines by construction — no run needed to establish it).
  Fix at the right layer: PLACEMENT — a `verify.inputs` run pins every task
  local (`placeTasks(…, pinAllLocal)`), because the verify is a local proof
  procedure by definition; determinism and fingerprint modes are untouched
  (no sandbox involved, and a remote determinism re-run arguably proves
  MORE). Pinned with a control-first e2e: without verify the greedy remote
  spy takes the task (proving the pin is the flag's doing), with
  `verify.inputs` the spy is never offered anything; the assertion is
  placement-level rather than sandbox-level so the pin is immune to the
  macOS reporting lossiness. Differential: dropping the `pinAllLocal`
  argument fails exactly the new pin; verify suite 58/0 after restore. The
  remote-execution guide gained the sentence. Remaining in this family,
  recorded: a remote-only task under `verify.inputs` noops locally and is
  therefore silently UNVERIFIED rather than reported as unverifiable —
  low stakes (it also never executes locally by definition) but worth a
  verify-report surface eventually.

- **2026-08-24 (tenth wave) — the remote-execution GUIDE ships, closing the
  docs gap the arc left.** `remote: 'only'`, install-as-action, worker-image
  requirements and the reliability behaviour existed only in schema.md and
  the package README — not where someone setting up remote execution would
  look. New `guides/remote-execution.md` on the docs site, sidebar entry
  after Remote caching, cross-linked from it. Content held to the
  proven-behaviour standard: every claim in it was verified live this
  session (the distroless `/bin/sh` trap with its misleading ENOENT, the
  placement rules and `--dry` labels, the worker→CAS→worker chain, the
  local-disk-is-truth coherence rule, the 128→64 KB downgrade, deadline
  degradation, `WaitExecution` re-attach, stage surfacing). Astro build
  clean, page present in dist, cross-link resolves.

- **2026-08-24 (ninth wave) — the sandbox-reporting flake ROOT-CAUSED and
  measured: lossy unified-log delivery, halved by a settle-poll, residual
  unfixable client-side.** The local repro made this tractable where the CI
  modes were not. Mechanism read from the code first: macOS violations come
  from SRT's store, which a monitor feeds ASYNCHRONOUSLY from the macOS
  unified log — reading it right after child exit races log delivery.
  Hypothesis-fix: a bounded settle-poll (10 × 100 ms), gated to exactly the
  suspicious case (darwin + fail exit + empty store), so clean runs pay
  nothing. THEN the statistics, not a single run: ~430 iterations per arm of
  the flaky test looping against a full-suite load. Pre-fix 22/442 (5.0%),
  post-fix 9/413 (2.2%) — halved, z≈2.2. Honest caveats recorded: arms ran
  sequentially rather than interleaved, and the residual 2.2% SURVIVED the
  entire 1 s window — those records were DROPPED by the unified log under
  pressure, not delayed, so no client-side poll can recover them. Every one
  of the 31 captured failures was the same mode: denial ENFORCED, reporting
  empty — the security boundary held in all of them. The fix ships with the
  measured numbers in its comment; the open item is rewritten from "flaky
  tests" to the true statement: macOS violation reporting is lossy-by-OS
  under load, ~2% residual on loaded local runs, darwin-CI class-gated, and
  the CI-only NON-enforcement mode (round two's ok=true) remains unexplained
  and never locally reproduced.

- **2026-08-24 (eighth wave) — darwin round two: the sandbox flake is a
  CLASS and now gated as one; and it is worse than reported — it is
  NON-ENFORCEMENT.** Round two failed exactly ONE test (2569/1), a
  DIFFERENT one from round one: `--verify=all reports undeclared-inputs for
a leaky task` came back `r.ok === true` — which this entry originally
  read as "the undeclared read SUCCEEDED; the sandbox did not enforce at
  all". **CORRECTED 2026-08-24 (twenty-second wave): that inference was
  unsound.** The leaky fixture SWALLOWS its read error and exits 0, so
  `r.ok === true` is exactly what plain REPORTING LOSS produces too — the
  verify reads an empty violation store as `proven-complete`. A
  discriminating local probe (out.txt content: the secret vs the fallback)
  classified every observed false pass as denial-ENFORCED-report-LOST;
  genuine non-enforcement has never been observed anywhere (canary
  n=100). Two consecutive darwin runs, two different tests, one mechanism:
  sandbox-exec on loaded macOS runners probes healthy and then misbehaves.
  Per-test `skipIf` is whack-a-mole (any enforcement-asserting test can be
  next), so the gate moved into `sandboxAvailable()` itself — on darwin CI
  without an explicit `VX_REQUIRE_SANDBOX`, the sandbox is treated as
  unavailable AS A CLASS, warning with the reason; the round-one per-test
  skip is subsumed and removed. REQUIRE stays an explicit opt-in that
  bypasses the gate (someone armed enough to set it on darwin owns the
  flake). Verified in both directions: CI=1 on darwin skips the 19 gated
  tests and still runs the 8 non-sandbox ones; without CI all 27 run.
  Coverage unchanged where it is trustworthy: linux CI (bwrap, REQUIRE=1)
  and darwin-local. The open item sharpened accordingly: the root-cause
  hunt is now for intermittent NON-ENFORCEMENT, which upgrades its priority
  — a sandbox that silently stops enforcing under load is a security-
  boundary reliability question, not a test-noise question, though vx's
  production posture is unchanged (per-task sandboxing is opt-in and the
  --verify=inputs failure mode is a false PASS of the verify, never a
  wrong build output).

- **2026-08-24 (seventh wave) — the darwin job earned its keep ON ITS FIRST
  RUN: red with three failures, none a product defect, all three the exact
  classes it exists to surface.** (1+2) Both `captureGitContext` failures
  were TEST-ENV LEAKAGE the linux job could never see: the linux `ci` job
  runs the suite THROUGH vx, whose isolated child env strips `GITHUB_*`, so
  the two tests that omit the env argument read an empty environment there —
  while the darwin job runs `bun test` raw, `GITHUB_REF_NAME=main` reached
  the CI-recovery ladder, and "a non-git directory" answered branch `main`.
  The tests were depending on the ABSENCE of ambient env rather than
  controlling it; both now pass an explicit `{}` like their siblings always
  did, verified under a simulated CI env both ways (the darwin run itself
  was the executed repro of the failure). (3) The third was the recorded
  macOS sandbox load-flake, which runs on darwin because sandbox-exec exists
  there — the "unavailable skips" mitigation never applied. Resolved with a
  darwin-CI-ONLY `skipIf`, commented as the open item it is: coverage
  remains on linux CI (bwrap, REQUIRE=1) and on darwin locally; main's
  signal cannot absorb a known 1-in-N flake, and the un-skip condition is
  the root-cause fix. The meta-point for the log: a first CI run on a new
  platform is a PROBE of the test suite as much as of the product — two of
  three "failures" were the suite's own hermeticity debts, findable only by
  an environment nobody had run it in.

- **2026-08-24 (sixth wave) — the darwin CI job ships, closing the oldest
  structural open item.** Three macOS-only defects reached main unseen on the
  ubuntu-only matrix (the 2026-08-22 trio: bsdtar vs `--format=gnu` breaking
  every cache save, the `/tmp`→`/private/tmp` symlinked-base containment
  refusing every restore, `close()` leaking on `SQLITE_IOERR_VNODE`), and
  this session added a fourth macOS-class item (the sandbox load-flakes).
  `core-darwin` runs the IDENTICAL suite invocation the `test` task runs, on
  `macos-latest`, guarding the platform-divergence classes: tar formats,
  fs/symlink semantics, SQLite behaviour. The one deliberate scope cut, made
  for main-health rather than cost: NO `VX_REQUIRE_SANDBOX` on darwin — the
  macOS sandbox suites are the recorded load-flaky class and would import
  that flake straight into main, while the sandbox SECURITY boundary is
  already enforced by the linux job; an unavailable sandbox skips here, and
  promoting the flag is the follow-up once the runners prove stable. The
  first darwin run is itself the experiment — if it surfaces a new macOS
  divergence, that is the job doing its work on day one.

- **2026-08-24 (fifth wave) — dual-store coherence: the graft priority was
  BACKWARDS; local disk is truth.** The audit target was reapi's cache and
  executor holding state for the same key in TWO stores (the artifact
  mapping and the execution record). The divergence scenario is real: two
  machines racing a NONDETERMINISTIC miss leave the stores holding results
  of DIFFERENT executions under one pure-input key (the key cannot
  distinguish them — that is what pure-input hashing means), after which a
  third machine restores one execution's artifact to disk while the shipped
  graft-first rule fed the OTHER execution's bytes to its workers: vx
  disagreeing with itself on a single machine. FIXED by inverting the
  priority: an upstream whose outputs are materialised locally uses LOCAL
  DISK, and the execution-record graft applies only to outputs that exist
  nowhere locally (the remote-only install case — which keeps the whole
  worker→CAS→worker win, since those have no local copy by design). The
  coherence pin plants a DIVERGENT record whose content IS in the CAS — so
  a wrongly-consulted graft SUCCEEDS with wrong bytes rather than failing,
  which is what makes it a coherence probe and not an eviction probe — and
  asserts the worker reads the local bytes. Differential: reverting to
  graft-first reads `remote-divergent` where `local-truth` was expected;
  restore green. Consequence for the eviction guard: the graft branch now
  runs only when NOTHING is local, so an evicted record there is a REAL
  loss with nothing to demote to — the warn now says the outputs are gone
  everywhere and names the remedy (re-run / --force) instead of pretending
  a fallback exists. Side benefit: one fewer `GetActionResult` round trip
  per locally-present upstream. 7/7 exec e2e green live against
  NativeLink.

- **2026-08-24 (fourth wave) — pool-slot leak hypothesis REFUTED; the pool's
  failure path gains its first coverage.** The audit target: whether the
  scheduler's `leave()` releases a pooled executor's slot when `execute`
  rejects mid-flight — a leak would not fail anything, the run would just
  quietly lose remote parallelism and, with enough failures, wedge. Three
  probes, all green against the REAL scheduler: six pooled tasks with half
  rejecting complete 6/6 with peak concurrency exactly at capacity; pool and
  local slots do not cross-starve (a slow pooled task never blocks the one
  local worker, and vice versa); and the sharpest shape — the pool FILLED
  with two rejecting occupants and a third task parked behind them — admits
  and succeeds. So the release path is symmetric and the hypothesis is
  REFUTED; the probes stay as permanent pins because the pool feature had
  ZERO failure-path coverage. Discrimination proven by mutation: neutering
  the rejection-path `leave()` (line-exact, after a first mutation attempt
  silently failed to apply and had to be caught — a mutation must be
  VERIFIED to have changed the file before its result means anything)
  wedges exactly the parked-behind-failures probe at its timeout; restore
  41/0. One harness slip caught by its own failure: the probes' success
  helper referenced a function that did not exist in that file, so every
  execute rejected and the first run showed 6/6 failed — read as "the
  scheduler fails everything" it would have been a phantom bug; the
  ReferenceError in the count mismatch was the tell.

- **2026-08-24 (third wave) — main went RED on a 128 KB chunk stall; the
  "boundary" was a RACE all along; fixed with adaptive downgrade.** The
  `plugin packages` job failed on a commit that did not touch the package:
  the multi-chunk cache round-trip hit `DEADLINE_EXCEEDED after 30.000s` —
  yesterday's deadline doing exactly its job, converting the silent Bun
  http2 stall into a diagnosable error, with bazel-remote's log confirming
  the client stopped sending mid-stream. **Version theory REFUTED first:**
  CI ran the identical Bun build (`34cbb9a40`) that passed 128 KB hundreds
  of times locally and twice on the same runner. The correct conclusion is
  worse and is written back into the README and design doc §14 IN PLACE: my
  binary-searched "220 928 works / 221 056 hangs" boundary was a race
  probability dressed as a line — a binary search over a timing race yields
  a crisp threshold that is really where the failure odds cross the sample
  size. Only ≤ 65 535 (the RFC default initial window) has never been
  observed hanging, anywhere. **Fix: adaptive downgrade, keeping the
  owner's 128 KB decision as the fast path** — `writeBlob` catches
  `DEADLINE_EXCEEDED` on a MULTI-message write and retries once at
  `SAFE_CHUNK_BYTES`, warned through the plugin's `ctx.warn`; the rare
  stall now costs one deadline instead of failing the task. The
  false-positive CONTROL caught a real over-broad first cut: a 1 KB body
  "downgraded" too, because the condition tested chunk SIZE rather than
  whether the write was actually multi-message — a single-message write
  never exercised inter-message flow control, so its deadline is the
  server's problem and re-chunking cannot help (`wire.length > chunk`
  added). Pinned both ways against the wedge: a multi-chunk write shows two
  deadline waits + the downgrade warn and still surfaces code 4; a
  single-chunk write deadlines ONCE with no warn. The compounding lesson:
  this is the SECOND claim about this defect corrected within a day (first
  "CI stays green one-process", now "128 KB is safe") — for a timing race,
  treat every "measured safe" as "not yet observed failing", and write it
  that way the first time.

- **2026-08-24 (second wave) — the `--dry` `@noop` label pinned in both
  directions.** Anti-drift, not a bug hunt: `remote: 'only'` gave placement a
  THIRD state and the plan surface rendered it unpinned. Two e2e pins: a
  remote executor that DECLINES the 'only' task yields `@noop` while its
  sibling shows the remote executor's name in the SAME plan (all label
  states in one fixture); a remote executor that ACCEPTS it shows the pool's
  name — noop must not leak onto tasks that will run. Mutation check: making
  the label fall through to the placed executor's name kills exactly the
  noop pin (a `--dry` that names the local executor for a task that will not
  run anywhere is promising an execution that never happens). Docs:
  plan-format.md now defines `@noop`.

- **2026-08-24 — misbehaving-remote audit: a WEDGED server hung every run at
  its first cache probe; fixed with cache-path gRPC deadlines.** The rotation
  said exercise the reapi cache composition against a remote that misbehaves
  rather than one that is down. CONFIRMED by executed probe: a TCP listener
  that accepts and never speaks wedged `ReapiRemoteCache.has()` FOREVER — no
  deadline existed anywhere in the wire, so the standing invariant "a remote
  cache error degrades to a MISS" was vacuous (the error never happens when
  the call never returns), and every task's probe would hang the run. A DOWN
  server was always fine (instant UNAVAILABLE → degrade) — which is exactly
  why this class survives testing against healthy-or-absent servers. Fix:
  `callTimeoutMs` (default 30 s) as a gRPC deadline on EVERY cache-path call
  — all unary RPCs plus ByteStream read/write — but deliberately NOT on
  `Execute`/`WaitExecution` (queueing behind a busy pool is legitimate and
  unbounded; a wedged server still cannot reach Execute because the bounded
  `GetCapabilities` runs first and fails). `DEADLINE_EXCEEDED` stays
  non-retryable, so a wedge costs ONE deadline, not deadline × retries.
  Pinned three ways in `tests/wedged.test.ts` (offline — a Bun.listen
  silent socket, no docker): the raw rejection with code 4 inside the bound;
  the invariant END-TO-END at the plugin boundary (reapi()'s layer over a
  wedged remote answers `null` + warns, inside 5 s, instead of hanging);
  and a DOWN server as the false-positive CONTROL (still fast, passes both
  ways). Differential: neutering `bounded()` fails exactly the two wedge
  pins, control unaffected, restore 3/0. **A probe mistake worth keeping:**
  the first post-fix probe still "hung" — its 10 s observation window was
  shorter than the 30 s default deadline it was observing. Size the probe
  window to the bound being tested, or the fix looks broken. **Two process
  notes from the same session:** an edit script that inserts by line number
  must do ALL insertions in one descending pass — mixing ranges corrupted
  offsets and the asserts caught it before the write; and the previous
  wave's CI claim ("one-process suite stays green on native amd64") was
  DISPROVEN within the hour and corrected in place — the packages job now
  runs one bun process per test file, the shape the evidence supports, and
  went green on `964ce96`.

**The 2026-08-22 → 08-23 arc (executor seam → cloud removal → full REAPI),
distilled.** Full text in the archive. The owner reframed the project twice in
36 hours: core must be buildable-upon through PLUGINS alone (no defaults —
even core's executor and cache are declared plugins), and vx-cloud was then
REMOVED IN FULL (~76k lines: the platform, the dashboard, and core's
whole-run `backend` seam — wrong-grained because it moved the scheduler
server-side). What replaced it: the per-task `executor` capability with
placement decided before scheduling (`exec.remote: false | 'only'`,
persistent-dependency pinning, executor `capacity` as scheduler pools), and
`@vzn/vx-reapi` — all 14 REAPI RPCs with digest negotiation, zstd, resume,
re-attach, RequestMetadata — proven LIVE against bazel-remote (cache) and a
busybox-rehosted NativeLink (execution; the official image is distroless, no
`/bin/sh`). node_modules solved via install-as-action + worker→CAS→worker
chaining. The recurring hazards, each caught by its own rule: hand-rolled
protobuf FIELD NUMBERS from memory parse garbage confidently (byte-pin both
encode AND decode against a reference); the Bun http2 multi-message stall is
a PEER-DEPENDENT RACE, not a boundary (a binary search over a timing race
yields a threshold that is really your sample size; ship 128 KB chunks +
DEADLINE_EXCEEDED downgrade to 65 535); `exec.remote` must be STRIPPED from
the key like `resources`; and two "measured safe" claims about the same
defect were corrected in place within a day — write "not yet observed
failing" the first time.

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
