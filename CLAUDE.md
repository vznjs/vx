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
    last.ts             # `vx last` — replay a recorded run's summary (read-only)
    prune.ts            # `vx prune` — workspace subset for Docker (Turbo parity)
    why.ts              # `vx why` — cache-key change explainability
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
    download-policy.ts  # --download modes + the deferral eligibility gate
    deferred-outputs.ts # deferred-output registry + lazy materialise/converge
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
  vx-github/            # @vzn/vx-github — GitHub Actions job-summary telemetry plugin
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
- **The local gate does NOT cover `packages/*`.** Root `test` is scoped
  to `./tests` on purpose (a bare `bun test` recurses into every
  member), and no package declares a vx config, so a green
  `bun src/bin.ts run ci` says nothing about a plugin change. CI's
  separate `plugin packages` job is what gates those — it runs
  vx-otel and vx-github as plain `bun test`, and vx-reapi ONE PROCESS
  PER FILE (the documented `node:http2` stall, oven-sh/bun#39796).
  After touching `packages/*`, run that package's suite yourself; for
  vx-reapi mirror the per-file loop with `VX_REAPI_TEST_ENDPOINT` /
  `VX_REAPI_EXEC_ENDPOINT` set, or it proves nothing.

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

**EXTENDED 2026-08-26 (owner):** _"please do not stop. ever. audit things, if
you run out add more tests, try to simplify the core. Make sure the core is
flexible, and plugins dictate functionality."_ So when nothing is obviously
broken, the priority order is: **audit** a surface hostilely → **add tests**
(an invariant a comment or README promises but nothing pins is the best
candidate; coverage gaps are work, not the absence of it) → **SIMPLIFY CORE**
(look for what core does that a plugin should, code left over from a removed
feature, and seams wider than they need to be). The bias while doing all
three: core stays FLEXIBLE and small, PLUGINS dictate functionality. When a
change could live in core or behind a seam, it belongs behind the seam; when
core grows a special case for one consumer, the seam is too narrow rather than
core needing the branch.
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

- **A v27 restore holds the decompressed artifact AND a copy of every entry
  at once** — `Bun.Archive.files()` returns File objects owning their bytes,
  where the previous hand-rolled reader returned zero-copy views into the tar.
  Measured on a 150 MB incompressible artifact in a fresh process: peak RSS
  575 → 683 MB (+19%) and 74 → 95 ms (+28%); at ≤ 12 MB the two paths are
  indistinguishable. Not binding the decompressed bytes to an outliving local
  was tried and REFUTED (no change), so the cost is structural. Peak is
  ~4.5× artifact size against a 2 GiB decompression ceiling that bounds the
  input, not the multiplier. A streaming read would fix it. RE-CHECKED
  2026-08-25 against Bun 1.4.0, and the blocker is now narrower than
  recorded: `ArchiveExtractOptions` exposes ONLY `glob`, so there is still
  no prefix strip — but mtime is no longer a reason, and the reason it is
  not is sharper than first recorded: `Bun.Archive.write(path, data)`
  takes in-memory `ArchiveInput` and has NO way to archive a file FROM
  DISK carrying its metadata, so mode and mtime cannot ride this
  container even in principle. That is why v27 puts them in the
  `.vx-meta.json` sidecar and applies them after extraction, and why a
  streaming restore loses nothing by not preserving them. (My first
  measurement here — "extract() writes an extraction-time mtime" — was a
  true observation with the wrong implied cause: the archive never
  carried one.) All three facts are now PINNED as a tripwire in
  `tests/bun-archive-capabilities.test.ts`, including a negative
  assertion on a strip option, so when Bun gains prefix stripping the
  suite FAILS and this item closes on evidence rather than being
  re-measured from scratch. The candidate design is therefore extract-then-
  rename: stream `outputs/**` to a temp dir on the SAME filesystem, then
  rename each file into the project dir applying the sidecar's metadata —
  bounded memory, at the cost of an extra rename per output. NOT
  implemented and NOT claimed faster; it trades a JS-side copy for a
  syscall and has to be measured against the current path before it means
  anything.

- ~~`vx run --verify=inputs` on macOS reports a false `undeclared-inputs` for
  the project's own ancestor directories and prints raw sandbox-exec log
  lines instead of paths~~ — **CLOSED 2026-08-24 (twenty-fifth wave)**: the
  call is made — ancestor-directory traversal is NOT an input. Denials on
  exact ancestor-or-self DIRECTORY paths of the task's cwd are filtered at
  the source (realpath'd); file reads inside ancestors still report; verify
  extracts the bare trailing path from macOS lines. Both directions pinned.
- ~~CI is `ubuntu-latest` only~~ — **CLOSED 2026-08-24**: a `core-darwin`
  job runs the full core suite on `macos-latest`. Deliberately WITHOUT
  `VX_REQUIRE_SANDBOX`. The enforcement CANARY gates the darwin job
  (340/340 enforced across 17 runs; one `not_enforced` reds it), and the
  suites themselves were UN-GATED there on 2026-08-25 once their
  enforcement pins were confirmed/rewritten to assert on ARTIFACTS —
  28 sandbox-runtime tests recovered on darwin CI. Only pins whose
  PRODUCT is the report (the `undeclared-inputs` verdict; a line naming
  a file) are still withheld, via `sandboxReportingReliable`. Full
  `VX_REQUIRE_SANDBOX` on darwin stays refused: it would make the lossy
  reporting channel a merge gate.
- ~~`--info` and `--cache-local` are byte-identical tokens~~ — **MOOT
  2026-08-25**: those were the dashboard's CSS custom properties, deleted
  with vx-cloud on 2026-08-23. The item outlived the code it described;
  nothing in the tree defines either token.
- ~~`isOutputsCurrent` compares size+mode+second-mtime~~ — **STALE, corrected
  2026-08-24 by probe**: the check compares at MILLISECOND precision with a
  restore-time re-sync, and a same-size same-second different-ms edit IS
  caught (now pinned in `cache-baseline.test.ts`). The remaining residual is
  a same-size edit with a FORGED identical mtime (`touch -r`) — pinned as
  the accepted trade (git's index makes the same one); closing it would cost
  a content hash per output on every warm hit.
- `LayeredCache` in-memory pack path (`--cache=local:,remote:rw`) still holds
  artifact bytes in RAM; `drainUploads()` has no timeout of its own and is
  deliberately outside the throw-path `finally`. SHARPENED 2026-08-25: for
  the reapi layer the wedge concern is CLOSED by construction — `put` is
  findMissingBlobs + writeBlob + updateActionResult, all deadline-bounded
  (the eighteenth-wave gRPC deadlines), so a full drain is finite
  (~pending/4 × 3 calls × deadline worst-case). The unbounded-hang risk
  remains only for a THIRD-PARTY `RemoteCacheLayer` whose `put` carries no
  deadline — a plugin-author responsibility the extensibility guide should
  name if a second remote plugin ever appears.
- ~~Task-log caps count CHARS, not memory; when failures alone exceed the
  run budget the OLDEST failure is stubbed first~~ — **BOTH CLOSED
  2026-08-25.** The failed tier evicts NEWEST-first so the root cause
  survives longest (successes keep oldest-first), and the RUN budget now
  charges ~24 char-equivalents per retained chunk, so it tracks memory
  rather than character count. MEASURED on Bun 1.4: 1M chars costs ~1.4 MB
  as one chunk and ~30 MB as 1M one-char chunks, so the old 4 MiB char
  budget could hold ~80 MB. The per-task TAIL cap stays a pure char count
  deliberately — it bounds what a reader is shown, a different question
  from what the process holds.
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
- ~~The macOS sandbox suites are load-flaky as a CLASS~~ — **RESOLVED
  2026-08-25**, and both named tests with it. It WAS root-caused (lossy
  async unified-log delivery, not sandbox misbehaviour — see the reporting
  item above): `sandbox-runtime`'s symlinked-root test now asserts the
  ARTIFACT and only checks the violation line where reporting is reliable,
  and `verify`'s clean-task false positive was the ancestor-traversal
  defect, closed at the source. "Invisible in CI (ubuntu-only)" is also
  stale — the darwin job ships, runs the suite, and gates on the
  enforcement canary.
- ~~The GHA job-summary plugin and the PR check-run integration went with
  the cloud removal~~ — **SHIPPED 2026-08-25** as `@vzn/vx-github`: both
  halves (the job summary and the Checks API check-run), declining at zero
  cost outside GitHub Actions.

### Recent entries (2026-08)

- **2026-08-26 (fifth wave) — three MORE dead queries, hidden from my own
  reachability pass by COMMENTS.** Re-ran the analysis repo-wide and it
  contradicted the wave I had just landed: `getHitRateSplit`,
  `getTaskDetail` and `getRunHeatmap` showed no consumer, yet my closure
  had marked them LIVE. The closure searched each root's body TEXT for
  other function names, so a mention in prose counted as a call —
  `getTaskDetail` and `getRunHeatmap` appear ONLY inside comments
  ("still show on `getTaskDetail.recent`", "clamped like every sibling
  window (getRunHeatmap, periodStats)"), and `getHitRateSplit` appeared
  nowhere but its own definition. A regex over source cannot tell a call
  from a sentence, and the failure is silent in the safe direction, which
  is why it survived. Deleted them with `HitRateSplit`, `TaskDetail`,
  `HeatmapCell`, `CompareTaskRow`, `TaskMover`, `PeriodStats` and
  `MAX_WINDOW_DAYS`, plus their tests and façade entries: another 304
  lines, `metrics.ts` now 888 (from 2101 this morning, −58%). Core suite
  2733/0, lint clean. The repo-wide sweep that found them also produced
  87 "unconsumed" exports, and MOST of that list is wrong for a reason
  worth recording before the next pass trusts it: it excluded every
  `index.ts`, but `src/cli/index.ts` is the DISPATCHER, not a barrel, so
  every `*Cmd` looked dead. A barrel is a file with no function bodies —
  that is the test to apply, not the filename.

- **2026-08-26 (fourth wave) — the cloud's analytics layer removed: 15
  queries, ~2200 lines net, and THREE wrong answers from my own dead-code
  analysis before the right one.** Owner directive to simplify core, and
  a direct instruction to finish removing vx cloud. `packages/cloud` was
  already gone from git — what remained locally was one untracked build
  artifact, now deleted — so the real remnant was `metrics.ts`, the
  `/v1/*` query layer the deleted dashboard read. FOUND BY REACHABILITY,
  and the analysis was wrong three times first, each failure looking
  exactly like a result: (1) excluding `metrics.ts` from the consumer
  search hid INTRA-FILE callers, so `listRuns` looked dead when `getRun`
  calls it; (2) filtering "files ending in index.ts" silently dropped
  real consumers; (3) including `apps/` counted `apps/docs/dist/**` BUILD
  OUTPUT and doc copies as code callers, which made all 28 look live.
  The version that holds: roots = referenced by real `.ts` under `src/`
  or `packages/*/src`, excluding the two pure re-export indexes and the
  file itself; then transitive closure. 9 roots, 13 live, 15
  unreachable. DELETED those 15 with their types, private helpers, tests
  and façade entries. The scripted deletion did real damage twice and
  the TESTS caught both: brace-matching from the first `{` cut mid-
  function (the first `{` is inside an object-typed PARAMETER), and a
  line-level prune ate the `.map((s) => \`'${s}'\`)`out of`HIT_STATUSES`, which emitted statuses UNQUOTED and produced
`SQLiteError: no such column: cache`in`getHistory`— a kept
function. Both repaired against the pre-edit copy; the suite is what
found them, which is the argument for the suite. Two pins moved rather
than being deleted: the façade snapshot lost its 15 entries, and the
status-vocabulary tripwire asserted a`PASS_STATUSES`constant that no
longer needs to exist, so it now asserts the PROPERTY it was really
guarding — no SQL status list is retyped — which is strictly stronger
than naming one constant. Core suite 2736/0 before, same after minus
the deleted tests; packages 45/14/5. Docs in the same wave:`docs/modules/metrics.md`rewritten to say what the layer is now and
why it shrank,`docs/modules/index.md` corrected, and the five cloud
  DESIGN docs deleted. Deliberately kept: design docs that merely MENTION
  the cloud while being about something else (one of them is the live
  REAPI roadmap), and the decision-log archive — rewriting those would
  falsify the record rather than remove a product.

- **2026-08-26 (third wave) — the crash-isolation claim I had leaned on
  twice was TRUE, and auditing it anyway found two defects beside it.**
  I had justified "warn, do not throw" in vx-github and the never-fail
  contract in vx-otel by quoting CLAUDE.md's "sinks are crash-isolated
  and deadline-bounded" rather than reading it. Verified: `emitSummary`
  and `onRecord` catch per sink and disable it, `flush` catches per sink
  and is wrapped in `settleWithin`, and the comment there explains the
  stake better than the invariant does — `bin.ts` is
  `process.exit(await run(...))`, so a flush that never settles drains
  the event loop with no exit code pending and a FAILED run reports
  green. The claim holds. TWO defects beside it, both the asymmetry
  class. (1) `disabled` was consulted by `onRecord` and `onRunSummary`
  and IGNORED by `flush`, so a sink whose state was bad enough to throw
  was still asked to write its output — from a buffer incomplete by
  construction, since it stopped being fed the moment it was disabled.
  An export that looks like a run with fewer tasks is worse than no
  export. The doc comment promised "skipped for the rest of the run"
  twice; flush is part of the run. (2) The disable was SILENT — no warn
  — against the standing invariant that a never-fail path must still
  WARN, recorded after "a silently discarded ingest shipped once".
  Telemetry vanished with no signal. Both fixed: one `disable()` helper
  that warns once naming the sink and the hook, `flush` honouring the
  set, and a flush failure now reported too rather than swallowed.
  Written test-first with a CONTROL (disabling one sink must not cost a
  healthy sibling its flush); both differentials fail exactly that pin.
  PRECONDITION checked rather than assumed, because `warn` is optional
  on `createTelemetrySource`: `telemetry-host.ts:86` does pass
  `ctx.warn`, so the new message is live in real runs and not just in
  tests. The zero-cost gate was already pinned
  (`telemetry-lifecycle.test.ts:338`), so nothing to add there.

- **2026-08-26 (second wave) — the vx-github classes carried to the
  sibling plugin: one CONFIRMED, one REFUTED.** Audited `@vzn/vx-otel`
  against a stated thesis rather than by general sweep, which is what
  made it quick. CONFIRMED, the empty-vs-undefined asymmetry: `??` falls
  through only on null/undefined, so `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=''`
  — what a workflow writing `${{ secrets.X }}` produces when the secret
  is unset — sailed past the `tracesUrl === undefined` guard and built a
  sink that POSTed to the empty string on every run. The BASE endpoint
  was safe purely by accident (a falsy `base` skips `joinSignal`), which
  is exactly what hid it: the common path declined correctly, so the
  decline looked tested. `OTEL_SERVICE_NAME=''` had the same shape,
  yielding an empty service name instead of `vx`. One `present()` helper
  now normalises every option and env read, whitespace-only included (a
  stray here-doc newline), so they cannot disagree. REFUTED, the coupled
  outputs: vx-otel ships traces, metrics and logs through
  `Promise.all`, and `send()` catches per signal and warns, so one
  failing signal neither blocks the others nor rejects `flush` — the
  design vx-github only got yesterday, arrived at independently here.
  Worth recording as the contrast: the same seam, two plugins, and the
  older one had the better failure shape. Shipped alongside a diagnostic
  the refutation exposed — with three CONCURRENT exports each caught on
  its own, a bare `export failed` cannot distinguish a down collector
  from one misconfigured signal endpoint, so the warning now names the
  URL. All three written test-first; each differential fails exactly its
  own pin; suite 45/0.

- **2026-08-26 — `@vzn/vx-github` audited: two defects, both found by
  reading for ASYMMETRY, both test-first per the new directive.** The
  newest package in the tree, and its Checks API half is the least
  exercised code here by construction — this repo's CI puts no
  `GITHUB_TOKEN` in the environment, so that path has never run against
  anything real. Audited with injected transports only; nothing was
  POSTed to the live API. (1) `resolveCheckRunEnv` treated the three
  required vars UNALIKE: `GITHUB_TOKEN` was rejected when empty, but
  `GITHUB_REPOSITORY` and `GITHUB_SHA` only when undefined. An empty
  repository built a POST to `/repos//check-runs` and an empty sha sent
  `head_sha: ''` — a 404 or 422 warning where a clean decline was
  intended. The existing test covered the token's empty case and neither
  of the others, which is how the asymmetry survived. (2) `flush()`
  awaited the summary write BEFORE the check-run POST with nothing
  between them, so a failed write (a full runner disk) took the check run
  with it. That is the exact coupling the package's own doc comment
  disclaims in the other direction — "the plugin declines the check (not
  the whole sink) without one, so the summary still works token-less" —
  and the check is the MORE visible artifact, since it lands on the PR.
  Now the write is try/caught and reported, the sink carries its own
  `warn` (which also removed the duplicate warn threaded through the
  check object), and the POST proceeds either way; reported rather than
  thrown, because a telemetry sink may never break a run. Both were
  written as FAILING TESTS FIRST and both differentials fail exactly
  their own pin; package suite 14/0. Not pursued, recorded so the next
  pass can weigh it: the footer escapes `summary.run.command` and then
  wraps it in backticks, so a command containing a pipe would render a
  literal backslash — the escape is right for the TABLE cells above it
  and cosmetic-only here.

- **2026-08-25 (eleventh wave) — OWNER DIRECTIVE: a probe that confirms a
  thesis becomes a TEST, not a log entry.** "When you are testing
  something write an actual test if not overly expensive to confirm your
  thesis and have it for the future." Fair, and today gave three probes
  that proved something and then evaporated. Landed the two worth
  keeping. (1) `tests/bun-archive-capabilities.test.ts` — a TRIPWIRE on
  the Bun API the v27 container sits on, since the open item's blocker is
  a CAPABILITY claim about a dependency, exactly the kind that rots
  silently. It asserts that `extract()` does NOT honour a strip option
  (so when Bun gains prefix stripping the suite FAILS and the item closes
  on evidence), that `glob: 'outputs/**'` does select just the subtree,
  and that an extracted file lands 0644. Writing it CORRECTED the item:
  `Bun.Archive.write(path, data)` takes in-memory `ArchiveInput` and has
  no way to archive a file FROM DISK with its metadata, so mode and mtime
  cannot ride this container even in principle — which is a sharper
  reason for the sidecar than what I recorded, and it means my earlier
  "extract() writes an extraction-time mtime" was a true observation with
  the wrong implied cause (the archive never carried one). The probe
  behind that line was itself wrong twice — `Bun.Archive.write` treated
  my array of paths as CONTENT, producing an archive with one entry
  named `"0"`, which is what sent me to the type definitions. (2) The
  `bun install` behaviour justifying prune's manifest rewrite is now an
  end-to-end pin: the emitted subset INSTALLS (exit 0), and the same
  subset with the manifest reverted to naming an absent member FAILS with
  `packages/unrelated` in stderr. Cheap — the whole prune file runs in
  ~400 ms — and it pins BUN's semantics, so if bun ever stops caring the
  rewrite can be reconsidered on evidence. Differential fails both pins.
  DELIBERATELY NOT LANDED, and named rather than dropped silently: the
  grpc-js subchannel-pooling measurement (20 clients → 1 connection). It
  needs `lsof`, whose output differs across platforms and which renders
  port 9092 as a service name, and it counts live connections — timing
  dependent. A flaky test asserting a pooling detail of a third-party
  library is worth less than the sentence recording it.

- **2026-08-25 (tenth wave) — the plugin's own wiring came back CLEAN on
  both hypotheses, and got its first test file.** Closing the REAPI
  rotation on `index.ts`. Hypothesis one, a connection leak: `cache()`
  builds a `ReapiRemoteCache` (and a gRPC client) that NOTHING closes —
  `RemoteCacheLayer` declares no `close()` hook, `LayeredCache.close()`
  closes only the LOCAL handle, and the plugin's `teardown()` released
  only the executor client. `vx watch` installs and tears down plugins
  once per re-run, so it looked like one connection per save. REFUTED by
  measurement: 20 unclosed clients share ONE established connection,
  because @grpc/grpc-js pools subchannels per target. The probe was
  wrong twice before it was right — `lsof` renders port 9092 as the
  service name `XmlIpcRegSvc`, so the first filter counted zero and
  would have "confirmed" no leak for entirely the wrong reason; `-P`
  fixed it. Hypothesis two, a bad failure mode for an unreachable
  endpoint: also REFUTED at the level that matters — core's `safe()`
  wrapper turns a throwing capability factory into a `UserError` naming
  plugin and hook, and ABORTS deliberately ("an executor is
  load-bearing, not observational"). SHIPPED anyway, both small and both
  pinned: `teardown()` now closes the cache client (hygiene, and the
  comment says plainly that it is hygiene rather than a measured fix,
  since pooling hides it), and an unreachable endpoint reports the
  ENDPOINT plus a remedy instead of a bare `14 UNAVAILABLE … Resolution
note:` — the cause is kept inside the new message. The real gap was
  coverage: `index.ts` had NO test file, and the invariant both the code
  comment and the README promise — "a declared-but-unconfigured plugin
  costs nothing and must never fail a run" — was pinned nowhere. Five
  tests now: silent decline with no endpoint (asserting the exact empty
  warning list, since a warning on every run of every unconfigured
  workspace is noise a user cannot act on), the env-only endpoint path
  as the control that the decline test is not passing vacuously,
  `execute` staying OFF unless asked, the teardown close, and the
  message. Differentials run separately; each mutation fails exactly its
  own pin; live matrix 105/0. And once more, in the same wave that
  records the rule: `bun test` reported 5/5 on a test file carrying TWO
  lint errors (`no-floating-promises` on `teardown?.()`, and `.then` on
  a capability typed `Promise<TaskExecutor | undefined> | TaskExecutor`,
  which may return synchronously). The root gate caught both. After
  rewriting the test to satisfy them I RE-RAN the differential rather
  than assuming the earlier one still held — the assertion had moved.

- **2026-08-25 (ninth wave) — the remote cache's existence probe promised
  artifacts that were gone, on one server and not the other.** Hostile
  pass on `ReapiRemoteCache`, the half of the package whose executor gave
  up two defects earlier today. `has()` was one `GetActionResult` and
  nothing else, so an AC entry outliving its CAS blob — the state the
  file's own comment calls "an ordinary state, not a fault" — read as a
  HIT. MEASURED against both live servers rather than reasoned about,
  and they DISAGREE: bazel-remote validates an ActionResult's referenced
  blobs and answers `has -> false`, NativeLink serves the dangling entry
  and answers `has -> true`. Both answer `get -> null`, so the two calls
  contradicted each other on NativeLink. Blast radius is exactly one
  surface — `cache.has()` reaches only `plan.ts`, so `--dry` / `--graph`
  would predict `cache hit (remote)` for a task that then executes; the
  restore tier is local-only and cannot be mis-scheduled by it. FIXED by
  checking the artifact with `findMissingBlobs`, the same pattern this
  package already uses for upstream records: one extra round trip, and
  only for a PREDICTED HIT, since a miss still short-circuits in one
  call. THE TEST PLACEMENT IS THE INTERESTING PART: the natural home is
  the cache suite, which CI runs against bazel-remote — where the server
  hides the entry and the assertion passes with or without the fix. A
  vacuous pin. It lives in the exec suite instead, against NativeLink,
  which is the only endpoint where the client's own check is observable;
  the differential confirms it (mutation fails exactly that pin there).
  Shipped with a control in the same test so the probe cannot degenerate
  into "never hit". REFUTED while in there, so the next pass does not
  re-tread: (1) `digestOf` hardcodes sha256 and that is CONSISTENT —
  `negotiate()` deliberately pins SHA256 unless a caller opts in, and the
  plugin never does; (2) the cache client never calls `negotiate()`, so
  it never enables zstd, which costs nothing because the artifact is
  already `.tar.zst`; (3) `remoteHasMany` is absent for a real reason —
  REAPI has no batch ActionCache read, so it could not be implemented
  more cheaply than N calls.

- **2026-08-25 (eighth wave) — `vx why` called a cache HIT a re-run, and
  blamed a flag that could not have applied.** Found by running the verb
  on real data instead of reading it: `vx why test` reported
  `status cache-hit · cache hit` and then the verdict "cache key
  unchanged — re-run with the same key (likely --no-cache or
  unrelated)". Nothing re-ran; the run was SERVED. A verb whose entire
  question is "why did this re-run?" answering it wrong about its own
  headline case is worth more than its size. The note ignored
  `cache_hit` entirely, so all three endings of an unchanged key
  collapsed into one sentence. Now three, and the third one refuses to
  guess: served from cache (nothing re-ran) · re-executed on the same
  key (`--no-cache` / `--force`, or something outside the key) · no
  recorded cache outcome, so whether it re-ran is UNKNOWN. Pinned all
  three in one loop; differential restores the single note and fails
  exactly that pin. Swept for the old wording across `.ts` and `.md` —
  no other consumer; `docs/cli.md` documents the three endings now.
  TWO process lessons, both earned the hard way in this one wave.
  (1) `bun test` passed 96/0 with a `TS2375` in the test I had just
  written (`exactOptionalPropertyTypes` rejects assigning
  `boolean | undefined` to an optional prop) — the standing "bun test is
  NOT the gate" rule, caught by `oxlint --type-aware` from the root, and
  the fixture lesson under it: `mkRun` DEFAULTS `cacheHit` to `false`,
  so persisting NULL means DELETING the key, not assigning `undefined`.
  My first pin failed for that reason and I nearly read it as the code
  being wrong. (2) When the gate went red I had grepped its output down
  to a summary and lost the failing task name — the exact mistake the
  standing rule warns about. `vx last --list` and `vx last <runId>`
  recovered it from the run history: `lint.oxlint`, failing under the
  SAME hash in both red runs, i.e. deterministic and mine, not the
  timing-sensitive persistent-task test that happened to be visible in
  the scrollback. Today's own replay command debugging today's own red
  gate is the best argument for it I could have written.

- **2026-08-25 (seventh wave) — audited my OWN channel from the previous
  wave and found the completeness claim I had just written was false.**
  New code is where the bugs are, including when it is an hour old.
  CONFIRMED by probe: when the workspace ROOT is itself a project — the
  `"."` member this repo calls load-bearing — the config-import walk
  loses transitivity entirely, because the root project's directory IS
  the whole workspace, so every `shared/**` file is "owned" and the
  descent rule stops at the first hop. Same fixture, two shapes: root a
  project → editing `shared/deep.mjs` selects NOTHING downstream; root
  not a project → selects `app`. Following that thread showed the class
  is not special to the root at all: the boundary stop under-selects at
  ANY project boundary, which is exactly what my own control #6 pinned
  as intended one wave earlier. So `docs/modules/affected.md` shipped
  the sentence "every channel here may over-select safely but must not
  under-select" — a guarantee the code does not have, written by me, in
  the same wave that broke it. That is the recurring class for the
  fourth time today, and this time I authored it. DE-CLAIMED and
  replaced with a precise statement of what is missed, plus a
  "Where this stops" section documenting both cases. NOT closed, and the
  reason is measured rather than asserted: full descent from
  `apps/docs/vx.config.ts` reaches 78 files in 15 ms, so scan time is
  not the obstacle — the obstacle is that an arbitrary project's SOURCE
  TREE becomes the walk's bound, and every edit inside it would select
  the importing project. Both under-selections are now PINNED as tests
  (the root-is-a-project pair: one hop still selects, two hops
  deliberately do not), so a future descent-rule change fails loudly and
  has to move the docs with it. Also checked, since it would have
  softened the finding: `--affected` does NOT propagate to dependents —
  that is opt-in via `...<pattern>` — so the package graph does not
  rescue the missed project.

- **2026-08-25 (sixth wave) — `--affected` was blind to config import
  closures; closed with a third selection channel.** CONFIRMED by probe
  before anything was designed: a workspace where
  `packages/app/vx.config.mjs` imports `../../shared/flag.mjs` and builds
  its command from it — editing that file moved the resolved command
  `echo one` → `echo two` (so the KEY moves), while
  `affectedProjects` returned the EMPTY set. That violates the rule
  `affected.ts` states verbatim for lockfiles four lines above the bug:
  "input hashing sees it, so `--affected` must too." In CI this is a
  silent green — `vx run build --affected` runs nothing after a shared
  preset changes. Designed via the architect subagent, which corrected my
  framing on the load-bearing point: **the class is wider than orphans.**
  This repo's `apps/docs/vx.config.ts` imports `../../src/index.ts`,
  a file OWNED by another project, so it is never an orphan and the
  existing `workspaceGlobOwners` seam could never see it; an orphan-only
  fix would have closed my probe and left the real case live. It also
  refuted the constraint I handed it: import-graph tracking is NOT
  infeasible — the `project-loader.ts` note is about runtime `import()`,
  while `Bun.Transpiler.scanImports` + `Bun.resolveSync` answer it
  statically, and `import type` is correctly erased. Shipped as
  `src/workspace/config-imports.ts`: relative specifiers only, reverse
  edges, one BFS from the changed set, and the rule that makes it
  affordable — **descend only through files owned by NO project**, so a
  config reaching into another project records the edge and stops
  instead of dragging that project's whole source tree in. Rejected on
  the way: "any orphan ⇒ everything" (a README edit rebuilds the world)
  and the extension heuristic (this repo's `bench/` and `scripts/` are
  the counterexample). 3 pins + 5 CONTROLS, and the controls are the
  half that matters, since selection is never hashed so over-selecting
  looks exactly like a pass: an unimported root-level `.mjs` selects the
  EXACT empty set, a sibling orphan selects nothing, and editing
  `packages/lib/internal.mjs` selects `lib` but NOT the app whose config
  imports `lib/preset.mjs` — the pin that fails if someone later
  "improves" this into full transitivity. Differential both directions:
  disabling the channel fails exactly the 3 pins and leaves all 5
  controls passing. MEASURED, min-of-5: 0.36 ms on this repo, 9.1 ms at
  100 configs, 87 ms at 1000 — and 80 ms at 1000 with NO imports at all,
  so the cost is reading the config files, not resolving the closure
  (full config EVALUATION, which selection avoids, is ~200 ms there).
  Two process notes. The realpath hazard the design flagged bit
  immediately: my first benchmark passed a raw `/var/…` root against
  `resolveSync`'s `/private/var/…` output and measured 0-of-1000
  selected — a probe reaching the wrong path, caught only because I
  asserted the SELECTED COUNT and not just the timing. The fix was to
  move the realpath INSIDE the module so there is one owner and the
  misuse is unrepresentable. And `oxlint --type-aware` caught a
  `string | null` narrowing lost inside a closure that `bun test` had
  transpiled away happily — the standing "bun test is not the gate"
  rule, earning itself again. `docs/modules/affected.md` was ALREADY
  stale (its `AffectedArgs` predated `workspaceGlobOwners`, and step 3
  still described the sort-by-directory-length pass the ancestor walk
  replaced) and is corrected in place in the same wave.

- **2026-08-25 (fifth wave) — my own refusals were reporting as "internal
  error in <task>"; classified as `UserError`.** Followed my two new
  throws through to what a user actually SEES, which the earlier waves
  never did. `scheduler.ts:700-705` splits exactly this: a `UserError`
  prints `[vx] <task>: <message>`, anything else prints
  `[vx] internal error in <task>: …` — and its own comment says a
  UserError "is a config/input failure … not a vx bug — report it
  plainly, never as an 'internal error'". An evicted remote blob is the
  environment, not a vx defect, and the message already carries the
  `--force` remedy, so telling the user to file a bug is the wrong
  reading of a correct refusal. Six throws in the REAPI executor are now
  `UserError` (both eviction refusals, the declared-output refusal, the
  server-reported execution failures, the missing ActionResult); ONE
  stays a plain Error and now says why in place — a host that routes an
  undescribed task to the executor violated core's placement contract,
  which IS a vx bug and should read as one. Verified first that the
  composition is sound at all: `execute()` rejecting is caught by the
  scheduler's rejection arm (`.then(f, g)`, deliberately not
  `.then(f).catch(g)`, so a release cannot run twice) and converted into
  a `failed` outcome with exit 1 — a refusal fails ONE task, it does not
  abort the run. Pinned by instance, not message; differential reverts
  one throw and fails exactly that pin; live matrix 99/0. `UserError` was
  already on the public façade (`src/index.ts:19`), so this needed no
  widening — a plugin can classify its own errors today.

- **2026-08-25 (fourth wave) — `vx prune` rewrote the pnpm workspace file
  but not `package.json`'s `workspaces`, so the emitted context would not
  install.** Same command, second pass: prune already knew a membership
  list naming absent dirs breaks installs — that is why it rewrites
  `pnpm-workspace.yaml` — but bun, npm and yarn read membership from
  `package.json`, which was copied VERBATIM. MEASURED rather than
  assumed, because the two shapes differ: a GLOB matching nothing is
  tolerated (`packages/*` with `b` absent installs fine), while an
  EXPLICIT entry the subset lacks is fatal — `bun install` prints
  `error: Workspace not found "packages/b"` and exits 1, before anything
  is installed. So the Docker context prune exists to produce could not
  be built at all for any workspace that lists members by path. Fix
  mirrors the yaml treatment: rewrite `workspaces` to the subset dirs,
  handling both the array and the `{ packages: [...] }` (yarn) form,
  preserving a `"."` entry (it names the root package, whose manifest is
  copied) and carrying the rest of the manifest through. An unparseable
  manifest falls back to a verbatim copy rather than losing it — reading
  a user's file is a boundary. Pinned: the absent member is dropped, the
  three subset dirs are present, and the manifest's other fields survive;
  differential disables the rewrite and fails exactly that pin, restore
  9/0. Lesson worth the line: I nearly asserted "npm tolerates a missing
  member" from memory — the two forms behave differently and only the
  executed check distinguishes them.

- **2026-08-25 (third wave) — `vx prune` emitted a subset that cannot
  run, and its own header promised the opposite.** New-code rotation
  again (prune shipped yesterday). Its header said "the subset must be
  runnable by vx inside the container"; REPRODUCED on this repo that it
  is not — `vx prune @vzn/vx-docs` produced a one-package subset, and
  running vx inside it dies at `Cannot find module '../../src/index.ts'`.
  Two independent causes, and they want opposite treatments. (1) The
  workspace config's imports are invisible to the PACKAGE graph: this
  repo's `vx.workspace.ts` names `@vzn/vx-otel` and `@vzn/vx-github`,
  which are workspace packages that no target depends on, so they were
  never copied — and the workspace config loads before any task, so
  their absence is fatal, not degraded. That one is fixable and now is:
  a static scan adds config-imported workspace packages (plus their dep
  closure) to the subset. (2) A relative import escaping its own package
  (`../../src/index.ts`) reaches a file no subset short of the whole tree
  contains, and the workspace ROOT package cannot be copied into a subset
  because it IS the workspace. Those are NOT fixable, so they warn at
  prune time — a message the user reads now beats a module-not-found
  inside a docker build — and the header is de-claimed to match, which is
  the third instance today of the "comment claiming a guarantee the code
  does not have" class. Pins: the config-named package IS carried, an
  unrelated workspace package is NOT (the over-inclusion control), the
  escape is reported, and a package whose config stays inside itself is
  not named. Differentials run separately, each mutation failing exactly
  its own pin; restore 8/0. The scan is deliberately static (`from '…'`,
  `import '…'`, `import('…')`) and documented as blind to computed
  specifiers rather than sold as complete. REFUTED while here: a config
  that fails to load does NOT exit 0 — `vx show` and `vx run` both exit 1
  on an unresolvable config import, so the broken subset is loud, not a
  silent green. Also fixed: the uncopyable-root warning fired once per
  matching specifier (three times for `@vzn/vx` + its two plugin
  subpaths) and is now deduplicated.

- **2026-08-25 (second wave) — the same fail-open on the OUTPUT side:
  an unfetchable declared output was skipped, not refused.** Straight
  application of the "grep the class in the same wave" rule to the wave
  that had just landed: `materialiseOutputs` warned and `continue`d on a
  blob it could not read, and `materialiseTree` did it in four more places
  (missing Tree blob, no root directory, missing tree file, child absent
  from the Tree blob) — the first of which materialises NOTHING and still
  returns. Core's contract is that once an executor returns the declared
  outputs are on disk, because `save` then tars whatever it finds, so each
  of those is a HOLE cached under a key claiming a complete build. Same
  worst class as the upstream graft, reached from the opposite direction.
  REPRODUCED before fixing, with a stub CAS that has lost the blob: the
  literal-capture case RESOLVED instead of rejecting (the executor's
  gRPC-free half is unit-testable once `materialiseOutputs` is exported,
  which follows the existing `globToOutputPath`/`outputPathSets`
  precedent). The rule shipped is deliberately NOT "throw on any missing
  blob", because that would over-refuse: a glob with a wildcard FIRST
  segment has no REAPI spelling and is sent as `''`, whole-working-
  directory capture, so the worker returns inputs and undeclared siblings
  too and a missing blob among THOSE is not this task's hole. Under a
  literal capture the server returned only what `output_paths` named, so
  every returned file IS declared and an unfetchable one fails the task.
  Testing `globToOutputPath(g) === ''` on the declared globs answers this
  without any path-relativity reasoning — which matters, because
  `materialiseOutputs` is called with cwd-relative paths on the fresh path
  and WORKSPACE-relative ones on the record-replay path, and a prefix-
  matching rule (the first design considered) would have been subtly wrong
  in one of them. RESIDUAL, deliberate and documented: a genuinely
  declared output missing under a `''` capture still only warns.
  Three-way pin — refusal, present-blob control, whole-tree control;
  differential disables the refusal and fails exactly the refusal pin;
  live matrix 98/0 against bazel-remote + NativeLink. Also confirmed
  while in there and NOT changed: `DeferredOutputs.materializeOne`
  memoises a FAILED fetch for the whole run, so every other consumer of
  that producer fails too and `exec.retries` never re-attempts it —
  fail-closed, consistent, and the error names the remedy, so it stays.

- **2026-08-25 — the REAPI upstream graft failed OPEN on an evicted
  dependency: confirmed with a two-arm live repro, fixed by refusing, and
  the stale comment that hid it traced to a precedence inversion.** Audit
  target was the newest code (the `--download` deferral arc); the deferral
  registry itself came back CLEAN and the trail led one layer down, into
  the chaining code deferral depends on. CONFIRMED against live NativeLink:
  two arms, same consumer command, same declared `dependsOn`, differing
  only in whether the upstream's blob is in the CAS — blob present
  `exit=0 stdout="REAL"`, blob evicted `exit=0 stdout="absent"`. The
  evicted arm SUCCEEDS with a silently different answer, and vx caches a
  successful task's outputs under its vx key, so a build computed WITHOUT
  its dependency's bytes lands under a key asserting they were present.
  Worst failure class. PROVENANCE: `3f1a9e1` added the eviction check when
  the record was consulted FIRST and `record === null` fell back to
  `localUpstreamPaths` — demotion was real then. `046d934` (dual-store
  coherence, "local disk is truth") inverted the order, which made the
  branch terminal by construction (`up.outputs` is empty there or we would
  have taken the local path) and orphaned the comment still promising a
  demotion "instead of shipping an action that cannot execute". Two
  comments in one function contradicted each other; the inner one was
  right. The recurring class again — and this time the stale comment
  concealed a real fail-open, so de-claiming was never the whole fix.
  FIX: both eviction branches (the FindMissingBlobs gap and the tree-blob
  read race) throw and name the upstream, matching what core's own
  `DeferredOutputs.materializeFor` already does for the identical
  epistemics — which upstream bytes a command reads is unknowable, that is
  what `dependsOn` declares. Refusal is PROVABLE (the declared outputs
  exist nowhere), and `findMissingBlobs([])` short-circuits so a
  zero-output upstream cannot false-positive. The old pin asserted
  `exitCode === 0` on a `cat … || echo absent` fixture: it pinned that the
  SYMPTOM was tolerable, not that the behavior was right, and its own
  fixture was the demonstration of the hazard. It is replaced by a
  control+refusal pair in one test. Differential: mutation back to
  warn+continue fails exactly the new pin in 154 ms (a real assertion
  failure, not a timeout); restore 11/0; full package matrix 95/0 live,
  otel 44/0, github 13/0, root gate clean. NO CACHE_VERSION bump, and the
  reasoning is not the usual one: stored bytes were never wrong under an
  unchanged key by DERIVATION — the defect let an execution that should
  have been refused proceed. An entry poisoned during an eviction window
  before this fix can still persist and cannot be identified post hoc;
  `--force` on the affected task is the remedy. A global key bump would
  invalidate every correct entry to chase a state that needs a remote
  executor plus an AC/CAS eviction skew.
  REFUTED along the way, so the next audit does not re-tread: (1) a stale
  on-disk `dist/` cannot masquerade as "materialised" and steal precedence
  from the graft — `up.outputs` is derived from `loadOutputFilesBatch`,
  which is HASH-KEYED and local-SQLite-only by design ("they describe the
  state on this machine's filesystem"), so a deferred task, which writes
  no local rows, always yields the empty list; (2) a remotely-executed
  consumer of a deferred upstream is not starved by the skipped
  materialisation — the CAS graft is the designed path and eviction is now
  fail-closed; (3) the deferral eligibility gate's scope really is
  key-observation only, and the execution channel is a different one, which
  is why reading the gate did not find this.
  HARNESS LESSON, and it cost the most time: `await expect(p).rejects
.toThrow()` around the refusal reproduced a 30.00 s DEADLINE_EXCEEDED
  5/5, where awaiting the same promise directly settles in ~2 ms 3/3. That
  is the signature of the `node:http2` inbound-frame stall ci.yml already
  documents (oven-sh/bun#39796, the reason the packages job runs one
  process per file). I nearly filed a phantom transport defect against a
  client that was fine: the failure LOOKED like a wedge, and only
  instrumenting inside `execute()` showed it stalling on a plain
  `getActionResult` miss that the test itself had just made four times in
  1 ms each. Mechanism not established (binding the promise first does not
  help; integrity.test.ts uses `rejects` on the same client without
  stalling), so the comment records the observation and not a cause.
  Docs in the same wave: the vx-reapi README gained the upstream-eviction
  paragraph (the self-key path falls THROUGH to execution, the upstream
  path REFUSES — opposite answers, and the asymmetry is the point), and
  the root README's feature inventory picked up `vx why` / `vx last` /
  `vx prune`, which had shipped without reaching the front door.

- **2026-08-25 (seventy-fourth wave) — `actions/checkout` v4 → v7 across
  all four workflows, after checking what actually exists.** Every CI run
  has been printing "Node.js 20 is deprecated … actions/checkout@v4
  forced to run on Node.js 24", which I kept reading past while grepping
  for other things. Queried the API rather than guessing a version, and
  the pins were further behind than assumed: checkout is at **v7**,
  setup-node v7, the pages pair v5 — this repo sat on v4/v4/v3/v4. Read
  the v5–v7 release notes before jumping three majors: v6 adds Node 24
  support and moves credential persistence to a separate file, v7 blocks
  fork-PR checkout for `pull_request_target` / `workflow_run` and goes
  ESM. Neither touches a plain checkout, and this repo's triggers are
  push / pull_request / workflow_dispatch / release — none of the two v7
  restricts — so the jump is safe HERE for a reason, not by optimism.
  All six usages are plain (only release.yml passes `ref:`), so no
  default was being relied on. DELIBERATELY LEFT: `setup-node@v4` (npm
  publish with OIDC, exercised only on release — a bump I cannot verify
  before it matters) and the `upload-pages-artifact@v3` /
  `deploy-pages@v4` PAIR, which must move together and gates the docs
  site. Neither is in the deprecation warning; both are follow-ups with
  named reasons rather than a silent skip. Also learned while reading:
  `ci.yml` already has `workflow_dispatch` with the comment "manual
  re-run without a push — for distinguishing runner-infra flakes from
  real regressions" — which is exactly the tool I should have reached for
  during today's two darwin e2e flakes instead of pushing a commit.

- **2026-08-25 (seventy-third wave) — dogfooding CONFIRMED end to end,
  and a CI-log grep rule learned twice in one day.** The corrected
  in-step assertion passed on the first run, so the loop that took four
  waves is closed with evidence rather than assumption: the plugin ships,
  is declared in `vx.workspace.ts`, activates on a real runner, writes
  the job summary, no longer duplicates core's report, and a future
  decline now fails the build instead of producing a blank page. Darwin
  went green too — the `vx watch` SIGINT flake did not recur, leaving
  that pattern at two isolated e2e timeouts rather than a trend.
  **The method rule**, needed twice today before it stuck: GitHub prints
  a step's `run:` script into the log before executing it, so grepping a
  CI log for the text of an error message finds the ECHO whether or not
  it fired. First it made a passing test name (`a sink that keeps
throwing > is disabled…`) look like a sink warning; then it reported
  "summary-check errors: 2" on a job that emitted zero. The discriminator
  is `##[error]` (or `##[warning]`) — GitHub's own runtime annotation
  prefix, which the echoed script cannot contain because the echo is
  wrapped in colour codes. Grep for the ANNOTATION, not the message.

- **2026-08-25 (seventy-second wave) — my own verification step was
  wrong, not the plugin: `$GITHUB_STEP_SUMMARY` is PER-STEP.** The
  self-check added last wave failed on its first run with "job summary
  is empty — did @vzn/vx-github decline?", which read as a real
  dogfooding failure. It was not. The runner gives EACH `run:` step its
  own summary file and concatenates them at the end, so the plugin wrote
  the `vx run ci` step's file and my separate verification step tested a
  fresh empty one — an assertion that could never pass, on a file
  nothing had written. Reproduced locally in the opposite direction
  first (`run ci` with `GITHUB_STEP_SUMMARY` set wrote 307 bytes), which
  is what made the environment difference the suspect rather than the
  plugin. The check now lives INSIDE the vx step: capture vx's exit
  code, assert the summary either way — a failing run is when it matters
  most, since it carries the failure callout — then re-raise the code so
  it stays the gate. Simulated locally including the re-raise before
  pushing, and the workflow re-parsed with `Bun.YAML` (7 steps now, the
  check folded in). The lesson sharpens last wave's own: asserting on
  the ARTIFACT rather than the wiring is right, but only if you have the
  artifact's SCOPE right — I asserted on the correct file name in the
  wrong process. Also observed, not fixed: darwin failed the same run on
  `vx watch e2e … exits on SIGINT` (45 s, a timeout), a second
  load-sensitive e2e flake there in consecutive runs after the
  many-commits one — a pattern worth watching rather than dismissing.

- **2026-08-25 (seventy-first wave) — the dogfooded summary now VERIFIES
  itself, because the failure it could hide is invisible.** Removing
  `--report-file` left the job summary owned entirely by a PLUGIN, and a
  plugin that declines writes nothing. That failure mode is worse than
  the duplication it replaced and strictly harder to see: GitHub does
  not expose step summaries through the REST API, so a missing one
  cannot be checked from outside, and a green run looks identical either
  way. Added a step that asserts `$GITHUB_STEP_SUMMARY` is non-empty and
  contains `vx run`, with `if: always()` — a FAILING run is when the
  summary matters most (it carries the failure callout) and is also
  exactly the path a decline would hide behind an already-red job. The
  workflow was parsed with `Bun.YAML` before pushing rather than trusted
  to indentation: 8 steps, the new one last, `if: always()` intact.
  The general shape, which is the third instance today: when a change
  moves a user-visible artifact from one producer to another, the
  producer swap is verifiable and the ARTIFACT is not — so add the
  assertion on the artifact, not on the wiring.

- **2026-08-25 (seventieth wave) — dogfooding the GHA plugin DUPLICATED
  the job summary, caught by reading the CI log instead of trusting the
  green.** The previous wave declared `github()` and CI passed, which
  proved nothing about what the page LOOKS like. Reading the runner log
  for evidence the sink wrote cleanly turned up the step's actual
  command: `bun src/bin.ts run ci --report-file="$GITHUB_STEP_SUMMARY"`
  — core's manual report was ALREADY writing that exact file, so the
  plugin's summary appended a SECOND table to the same page. Nothing
  failed; the artifact was just wrong, which is the class a green check
  cannot see. The flag is removed with the reasoning recorded at the
  step: the plugin owns that surface now, while core's
  `--report=markdown` / `--report-file` remain for workspaces that want
  the table without declaring a plugin — the two were never meant to run
  together. A grep lesson too: my "sink warnings" search matched
  `sink .*(threw|disabled|failed)` and reported 1 hit, which turned out
  to be a passing TEST NAME (`a sink that keeps throwing > is disabled
after its first throw`). A pattern loose enough to match test titles
  will always find something in a log that prints every test name —
  read the hit before believing the count.

- **2026-08-25 (sixty-ninth wave) — the repo dogfoods `@vzn/vx-github`,
  and the un-gated sandbox suite survived a second loaded darwin run.**
  The plugin shipped this morning had never run in a real Actions
  environment — every test injects its transport. `vx.workspace.ts` now
  declares `github()` alongside `otel()`, which costs nothing and proves
  something on every CI run: on a runner `GITHUB_STEP_SUMMARY` exists so
  the sink activates and writes the summary; on a laptop it declines.
  Checked BOTH halves before landing rather than reasoning about them —
  a local run stays silent, and a run with `GITHUB_STEP_SUMMARY` pointed
  at a temp file produced 234 bytes of correct markdown (verdict
  headline, stats line, task table). The Checks API half stays dormant
  deliberately: this workflow puts no `GITHUB_TOKEN` in the environment,
  so the plugin skips the check-run rather than guessing, which is its
  documented default and keeps the change free of new permissions and
  outward-facing calls. Also banked: canary #19 (19/1/0, cumulative
  n=380, non-enforcement 0/380) and the precondition that the un-gated
  sandbox suite RAN on darwin under load a second time — 19 test lines,
  on a job that had been red for an unrelated fixture reason, which is
  about as loaded as that runner gets.

- **2026-08-25 (sixty-eighth wave) — RED MAIN on a DOCS-ONLY commit, and
  this time it genuinely was not the diff: git itself failed to write an
  object.** The darwin job went red on the log-compaction commit, which
  touches two markdown files. The rule says read the failing test and the
  ACTUAL error before calling it a flake, and both were decisive:
  `affectedProjects > handles many commits…` died at
  `git commit -q -a -m b-32` with `unable to create temporary file:
Invalid argument` / `fatal: failed to write commit object` — the
  FILESYSTEM refusing git's object write on the 32nd of 50 fixture
  commits, with vx not in the picture at all. Not the sandbox suite I
  un-gated the wave before (its first real-load run stayed green), and
  not the canary. This test has a recorded history of CI reds — its own
  comments narrate the fourth one — and prior hardening improved its
  DIAGNOSTICS, which is exactly why this failure was legible in one
  read. Mitigation kept narrow: ONE retry, only on the setup loop, with
  the observed git error quoted at the site. Retrying fixture setup
  cannot mask a defect in the code under test, because the behaviour is
  asserted after the loop and a second failure still throws with git's
  own message. What was NOT done: no blanket retry in the shared `git()`
  helper (its failures elsewhere are meaningful), and no reduction of
  the commit count (50 is the number that exercises the recursion/arg
  limit the test exists for).

- **2026-08-25 (sixty-seventh wave) — the JSON plan had the same hole as
  the text plan, one surface over.** Having just built the `--dry` text
  surface, I ran the OTHER two. `formatPlanJson` enumerates its fields
  by hand — id, project, task, hash, cacheStatus, deps, p50Ms, executor,
  description — so `PlannedTask.download` did not appear there for free,
  and neither did `downloadDowngrades`. The machine-readable surface, the
  one a CI job actually parses to ask "did `--download=none` defer
  anything, and if not why", was silent about the entire feature. Both
  fields added, with the enumeration's deliberateness noted at the site
  (the plan's internal shape is not the wire — which is exactly why the
  field had to be added by hand, and why the next one will too).
  `--graph`/DOT was checked and deliberately NOT extended: it draws
  dependency structure with cache-status colour, and a transfer decision
  is not structure — the text and JSON surfaces carry it. Pinned both
  fields; the differential kills the per-task one. THIRD consecutive
  wave where my own test was wrong before the code was: this time the
  per-task assertion used `reader`, which the fixture's fake remote
  executor does not accept, so it was eager BY PLACEMENT and the
  assertion would have proven nothing. Reading the fixture's `accepts`
  before choosing a subject is the habit that was missing.

- **2026-08-25 (sixty-sixth wave) — the `--dry` surface phase 1 CLAIMED
  was never built; `--download` was invisible until now.** Same technique
  that caught the `toplevel` group bug — check a real invocation instead
  of re-reading the code — turned on my own completion claim. The design
  scoped "the `--dry`/summary/telemetry surfaces"; I built the summary
  line and the telemetry field and shipped calling it done.
  `download.modeOf` appeared in exactly ONE place, run.ts's executor
  args: `plan.ts` and `plan-format.ts` had never heard of it, so
  `--dry --download=none` printed the same text as a plain plan and the
  eligibility gate — which SILENTLY keeps producers eager — was
  unobservable. A user asking why nothing defers had nothing to read.
  Built now: `PlannedTask.download` (attached only when deferred, since
  an eager task is the default and saying so on every line says
  nothing), `RunPlan.downloadDowngrades`, placement resolved in the plan
  path regardless of executor COUNT (labels need a choice to report,
  modes do not), and a plan footer naming up to three refusals. Pinned
  end to end through `planRun` + `formatPlanText`. Two process notes:
  the pin's second half failed first and the CODE was right — I put the
  reading task outside the requested set, and the gate deliberately asks
  whether any key IN THIS RUN could observe the producer, the cross-run
  residual I had written into the design and then tripped over from the
  other side; and the commit that carried this shipped WITHOUT its log
  entry, because a docs anchor assert aborted the same script before
  either write — the abort-before-write habit protected the file but not
  the sequencing, so the entry lands in the follow-up.

- **2026-08-25 (sixty-fifth wave) — `--download=toplevel` brought home
  NOTHING when the target was a group; the mode's whole point, defeated
  by one missing flag.** Hostile pass on phase 2/3, the last code from
  this session without one. CONFIRMED by probe: the `toplevel` clause
  keyed on `n.requested === true`, but a requested GROUP has no outputs
  of its own — `markSurfacedDeps` marks the real tasks it chains as
  `surfaced`, never `requested`. So `vx run ci --download=toplevel`,
  with `ci` a group over build+test, deferred every task that actually
  produces something and materialised the group's nothing. The mode
  exists precisely to bring asked-for outputs home, so it failed at its
  one job for the most ordinary CI invocation there is. The fix is
  `requested || surfaced`, which is not a new idea in this tree: run.ts
  already pairs exactly those two flags when deciding which persistent
  children to keep alive in the foreground, and I wrote the clause
  without looking for the precedent. Pinned WITH a control in the same
  test — a plain intermediate still defers — so the fix cannot degenerate
  into "everything eager"; differential kills exactly that pin. Phase 3
  was probed in the same pass and REFUTED on four counts: the record's
  workspace-relative paths materialise correctly through
  `cwd: workspaceRoot` for files, symlinks AND tree digests; a record
  written under one download mode is honoured under the other; the
  `capture.stdout === false` contract is respected on the replay path;
  and `--force` still bypasses via `refresh`.

- **2026-08-25 (sixty-fourth wave) — hostile pass on the log-budget change
  I shipped two waves ago: REFUTED, and the invariant that could have
  broken silently is now pinned.** New-code rule turned on my own newest
  code. The sharp risk in switching the budget from a char count to
  `chars + chunks × 24` is not the formula, it is SYMMETRY: every charge
  must be released with the identical cost, and the two paths that mutate
  an entry AFTER charging it — a task finishing twice (the defensive
  replacement) and an entry stubbed by eviction then taken — are exactly
  where a mismatch would hide. Drift there is silent and cumulative: a
  long run ends up bounding something other than what it reports, with no
  symptom until memory. Probed both paths directly: `retainedChars`
  returns to exactly 0 after replace+take and after evict+take-all. The
  ordering happens to be right by construction (eviction releases BEFORE
  it zeroes `chunks`), which is precisely the kind of accident worth
  pinning before someone reorders two lines. Added `budgetUsed()` for the
  assertion and a test covering both paths; differential — releasing
  `e.chars` where the charge was `budgetCost(...)` — fails it. Process
  note: the first differential attempt asserted on an expression that
  appears at TWO release sites, so it aborted before writing and the tree
  was untouched; re-anchoring on the preceding `delete` line made it
  unique. The abort-before-write habit is why that cost one command
  instead of a confusing green.

- **2026-08-25 (sixty-third wave) — the OPEN-ITEMS list had removal rot of
  its own: three of its entries were already dead.** Reaching for the last
  "actionable" item — the `--info` / `--cache-local` token collision —
  found no such tokens anywhere in the tree: they were the DASHBOARD's CSS
  custom properties, deleted with vx-cloud on 2026-08-23. The item had
  outlived the code it described by two days and would have cost the next
  session a cycle, as it nearly cost me one. Sweeping the rest of the list
  on that suspicion found two more: "the macOS sandbox suites are
  load-flaky as a CLASS" names two specific tests, BOTH since fixed (the
  symlinked-root pin is artifact-based now, and the clean-task false
  positive was the ancestor-traversal defect closed at source), asks for
  root-causing that HAPPENED (lossy unified-log delivery), and calls the
  problem "invisible in CI (ubuntu-only)" when the darwin job now runs the
  suite and gates on the canary; and the GHA job-summary/Checks-API item
  was satisfied in full by `@vzn/vx-github` earlier today. All three
  closed in the file's strikethrough-with-date convention rather than
  deleted, so the record of what was true still reads. The lesson
  generalises the removal-sweep theme one level up: I swept the docs, the
  source comments and the capability validation after the cloud removal,
  but not the WORK QUEUE — and a stale entry there is worse than stale
  prose, because prose merely misinforms a reader while a stale open item
  actively recruits effort. Sweep the list whenever a removal lands or a
  named gap ships.

- **2026-08-25 (sixty-second wave) — the log budget now tracks MEMORY, not
  characters; the open item closes in full.** MEASURED first, because the
  recorded "~36× overhead at 1-char chunks" was an estimate nobody had
  executed: on Bun 1.4, 1 000 000 chars costs ~1.4 MB of marginal RSS
  arriving as ONE chunk and ~30 MB arriving as 1 000 000 one-char chunks
  (15.4 vs 44.3 MB process RSS). So the 4 MiB char budget could be
  holding ~80 MB — the cap was measuring the wrong quantity, which is
  what the open item said. Fix chosen for its blast radius: the RUN
  budget charges `chars + chunks × 24` instead of restructuring the hot
  append path, which is deliberately zero-copy (a cache-hit replay is
  one array push). Chunky output is untouched — one 128 KiB chunk pays
  24 on 131 072 — while a task emitting a byte at a time is charged for
  the strings it actually creates. The per-task TAIL cap stays a pure
  char count ON PURPOSE: it bounds what a READER is shown, which is a
  different question from what the process HOLDS, and conflating them
  would shorten visible tails for chunky output to solve a memory
  problem chunky output does not have. Pinned with two buffers holding
  IDENTICAL content where only the fragmentation differs — the
  fragmented one must evict first — and the differential (overhead 0)
  fails exactly that pin. Considered and rejected: coalescing small
  chunks into blocks (correct, but it adds state to the hot path and
  ropes would blunt the win) and capping chunk COUNT (destroys the
  head-eviction granularity that keeps a tail readable).

- **2026-08-25 (sixty-first wave) — the task-log budget stubbed the ROOT
  CAUSE first; the failed tier now evicts newest-first.** Half of a
  recorded open item, closed. When failures alone exceed the run log
  budget, `evictToBudget` sorted successes-then-`seq` ascending — oldest
  first — inside BOTH tiers. For successes that is right (none is more
  interesting, so recency wins). For failures it is exactly backwards:
  the FIRST failure is usually the root cause and the later ones its
  cascade, so a hard-failing run reliably dropped the one log a user
  needs and kept forty copies of the consequence. The tiebreak is now
  status-dependent — failures newest-first, successes oldest-first —
  with the reasoning at the comparator. The pin that encoded the old
  behaviour was UPDATED, not deleted: it now asserts the first failure
  survives and the newest is stubbed, plus that the stubbed one still
  ships with `truncatedHeadChars` set, because "evicted" and "printed
  nothing" must stay distinguishable (a sibling test pins that property
  and needed its example id moved for the same reason). Differential:
  restoring the uniform `a.seq - b.seq` fails exactly the new pin. The
  open item's OTHER half — caps count chars, not memory, ~36× off at
  1-char chunks — is untouched and stays recorded; it is a sizing
  question, not a wrong-answer one.

- **2026-08-25 (sixtieth wave) — the darwin un-gate CONFIRMED under real
  load, and a self-correction: the CAS backend was never dead code.**
  (1) The first darwin CI run with the recovered suite is green, and the
  PRECONDITION was checked rather than assumed — 19 `sandbox-runtime >`
  lines in the job log prove the suite ran, 5 skips job-wide are exactly
  the verify reporting block, 2616/0 overall, canary #18 20/0/0
  (cumulative n=360, non-enforcement still zero). One green run under
  load is a datapoint, not proof, but the flaky assertions are no longer
  on that path by construction. (2) The class sweep two waves ago
  recorded `cas-backend.ts`'s bare `Bun.write` as latent-and-unreachable
  because "the module has no consumer". WRONG, and the error is
  instructive: I inherited that judgement from the download-policy
  design, which said the module is not the foundation for THAT arc — a
  much narrower claim than "nothing reaches it". `Cache.contentBackend()`
  is public, exported from the cache index, and has its own integration
  test, so any embedder can call `put()` concurrently and a reader can
  observe a half-written blob under a content-addressed name that
  promises complete bytes. Fixed with the same temp+rename `cache.ts`
  and the archive extractor use, and pinned DETERMINISTICALLY this time
  (a reader polling during a 512 KB write: 3/3 mutant failures, versus
  the archive race's probabilistic 3/400). Lesson worth the line:
  "unused by the arc I am designing" and "unreachable" are different
  claims, and I promoted one into the other without checking the
  exports.

- **2026-08-25 (fifty-ninth wave) — darwin CI un-gated: 28 sandbox tests
  recovered by splitting ENFORCEMENT from REPORTING.** The condition I
  recorded when refusing the flag promotion ("un-gate if the pins are
  ever rewritten to assert on artifacts, not lines") turned out to be
  nearly met already — reading the suite, its enforcement pins assert
  `r.ok === false`, `status === 'failed'`, and `existsSync(escaped.txt)
=== false`: artifact-based, immune to a dropped log record. Exactly ONE
  pin asserted line CONTENT, and verify's input-completeness block is
  verdict-driven, which is the report itself. So the class gate was
  withholding 27 reporting-independent tests to protect 6 that need it.
  Split: `sandboxAvailable` no longer skips darwin CI wholesale, and a
  new `sandboxReportingReliable` withholds only what the lossy channel
  can move. The line pin now asserts the ARTIFACT unconditionally (the
  task failed AND out.txt never appeared) and the line only where
  reporting is reliable — strictly more coverage than before, since the
  artifact half never ran on darwin at all. Verified by simulating the
  environment (`CI=1` on darwin): sandbox-runtime 28 pass / 0 skip where
  the whole suite used to vanish, verify 24 pass / 5 skip. The general
  lesson: enforcement and reporting are different properties with
  different reliability, and a gate that conflates them pays for the
  weaker one everywhere. The canary proved that distinction empirically
  (340/340 on the artifact-based question) before it was used to
  redesign the gate.

- **2026-08-25 (fifty-eighth wave) — `runner.ts` closes `src/exec/`
  clean, and the module-doc debt from my own week's work is paid.**
  Sharpest hypothesis on the runner: every command runs as `sh -c`, so a
  timeout SIGTERM would kill the shell and ORPHAN the real work.
  REFUTED, and the treatment is better than the hypothesis — `execWrap`
  prepends `exec ` for a single external command so the shell is
  REPLACED, leaving no intermediate to orphan (which also makes
  `resourceUsage` measure the program rather than the shell), with a
  guarded fallback for compound commands, builtins and
  `FOO=bar cmd` forms, and the residual named honestly in the comment:
  compound-command grandchildren still orphan on a hard kill, "the
  residual limit every non-cgroup runner shares". Being wrong in the
  over-cautious direction costs nothing, and `tests/runner.test.ts`
  already pins the classifier. With env.ts and the heavily-audited
  sandbox-runtime, that closes exec/. THE ACTUAL DEBT was mine: the repo
  keeps a per-file doc for 67 modules — `stable-keys.md`,
  `local-shortcircuit.md` — and the two orchestrator files I shipped
  today, `download-policy.ts` and `deferred-outputs.ts`, had none. I
  documented the FEATURE thoroughly (cli reference, the remote-execution
  guide, the design doc, the log) and skipped the MODULE docs, which is
  the same rule failing at a different altitude. Both written to the
  house shape (purpose / public surface / invariants / tests), including
  the four ways to be deferral-ineligible and the convergence sequence,
  and both indexed in `docs/modules/README.md`.

- **2026-08-25 (fifty-seventh wave) — `env.ts` audited: the isolation and
  the key trade are both RIGHT and well documented; the doc's copy of the
  allowlist was not, and is now pinned.** The hypothesis worth testing on
  a task's environment is the stale-hit one: `CI` is in the essential
  allowlist (so a task SEES it) but allowlist values are never folded
  into a key, which means a build whose OUTPUT depends on `CI` could hit
  across environments. REFUTED as a defect and better than refuted as
  documentation: schema.md already names `CI` / `FORCE_COLOR` / `TERM`
  with their exact mechanism (stdout bytes, which vx caches and
  replays), plus `NODE_OPTIONS` and `LC_ALL`/`LANG`, explains WHY they
  are excluded (a laptop and a CI runner could never share a remote
  entry) and shows the fix (`cache.inputs.env`). Isolation itself is
  real: only the allowlist + `passThrough` + `define` reach a child, so
  ambient `GITHUB_*` cannot leak into a task. The finding is the
  two-copies class one layer over: the doc ENUMERATES the code
  constant, and the copy had drifted — `USER`, `LOGNAME`, `TEMP` and
  `TMP` are passed to every task and were named nowhere. For a reader
  asking "what does my build script actually see?" — a security-shaped
  question — an incomplete list answers wrongly. `ESSENTIAL_ENV` is now
  exported and a doc-parity test asserts every entry appears in that
  paragraph, joining the schema-doc-drift suite that already guards the
  validation-error table; the differential (dropping one name from the
  doc) fails exactly the new pin.

- **2026-08-25 (fifty-sixth wave) — the backend sweep FINISHED, after
  catching myself claiming a sweep I had not done.** Checking `eventSink`
  (the trilogy's third removal candidate) established it is live and
  merely deprecated — plugin-host still subscribes it, so no defect —
  but the same grep surfaced `plugin-host.ts`'s own header still naming
  `backend`. That should have been caught one wave earlier: the previous
  sweep ran a filtered grep and I read `head -5` of it, fixed those, and
  wrote "sweep" in the commit message. Reading the head of a filtered
  list is sampling, not sweeping, and the word in the message was
  therefore wrong. Done properly this time: twelve more live references
  corrected across `src/index.ts`, `plugin.ts`, `plugin-host.ts`,
  `telemetry.ts`, `run.ts` and three module docs, including a
  capability-table ROW for `backend(ctx)` in `docs/modules/plugin.md`
  that still described "whole-run delegation; when contributed,
  executors are not consulted" — a documented capability that cannot be
  contributed and would now be refused. Deliberately NOT touched:
  `docs/design/*` (point-in-time proposals — rewriting them would
  falsify the record), and the comments that explain the removal rather
  than assume the seam (`run-report.ts`'s note on why its shape lives
  where it does is exactly right). Verified complete by re-running the
  grep with every intentional survivor excluded and reading the WHOLE
  output.

- **2026-08-25 (fifty-fifth wave) — the same sweep applied to the removed
  BACKEND seam found a real defect, not just doc-rot: a `backend`-only
  plugin validated and was then silently ignored.** The cloud sweep's
  discipline pointed at the other 2026-08-23 removal. Ground truth
  first: `VxPlugin` has no `backend` member and nothing in the
  orchestrator consults `.backend` — the seam is gone. But
  `project-loader`'s capability list still contained `'backend'`, so a
  plugin declaring ONLY that capability — a third-party one written
  against the pre-removal API, or a user following an old doc — passed
  the "must contribute at least one capability" check and then did
  NOTHING, with no error and no warning. That is precisely the no-op
  authoring mistake the check exists to catch, arriving through the
  door the check itself left open. Now refused BY NAME, with the
  message pointing at `executor` as the replacement; false-positive
  CONTROL pins that cache/executor/telemetry plugins still load, and the
  differential kills exactly the new pin. `config.ts`'s structural
  `Plugin` also still declared `backend?()` (and was missing
  `executor?()` — the same drift in both directions), now corrected.
  Six stale doc sites fixed alongside, including a DANGLING link to a
  `cli-backend.md` that no longer exists. The wave's own lesson is in
  its three test failures: the zero-cost gate built its fixture from a
  `backend`-only plugin, and the schema doc-drift test pinned the error
  message's exact capability list — both went red the moment the loader
  changed, which is the tripwires working, and both needed updating
  rather than reverting.

- **2026-08-25 (fifty-fourth wave) — doc-rot sweep for the removed
  cloud: three stale references pointing at a product that no longer
  exists.** Cheaper than another module audit and more user-facing: the
  cloud removal was 2026-08-23, I had already found two stale refs in
  `comparison.md` by accident during the hash-only wave, and an accident
  is not a sweep. Grepping every doc for `dashboard` / `vx-cloud`
  separated two populations. Most hits are GENERIC and correct — "a
  dashboard or an HTTP surface" as a hypothetical plugin consumer is
  exactly right now that a dashboard is a plugin story. Three were
  claims about something that exists: the comparison table's run-history
  row offered "a self-hosted dashboard" as vx's answer (now `vx last`,
  which is the answer that shipped for that gap), the divergence note
  said "the browsable surface IS the self-hosted dashboard" (now: `vx
last` for replay, browsable is a telemetry-plugin story, with the
  removal dated), and `vx why`'s docs AND its source header both cited
  "the dashboard's 'Why did this re-run?' card" as a sibling surface.
  That last one is the tell worth keeping: the same stale sentence sat
  in a doc and in a code comment, so a reader checking the source
  against the docs would have found them agreeing — and both wrong.
  Two copies of a claim are how they stay wrong together, which is the
  same failure mode as two copies of a rule disagreeing, arrived at from
  the other side.

- **2026-08-25 (fifty-third wave) — deferral × `--continue=always`
  REFUTED and pinned: the two features were built three waves apart and
  had never met.** The specific worry: registration happens only on a
  ZERO exit, so a FAILED deferred producer leaves no registry entry —
  and `always` is the one mode that runs the dependent anyway. If
  `materializeFor` had assumed an entry exists for every dep it walks
  (the registry's own `run()` does use a non-null assertion), the
  dependent would have thrown out of the registry instead of failing on
  its own missing input. It does not: the walk filters on
  `entries.has(dep)` before ever calling `run`, so the assertion is
  guarded by construction. Executed: producer `failed`, dependent RAN
  and `failed` on its own, `materialized` empty, no hang. Pinned,
  because "correct by construction" is exactly the claim that rots when
  a fourth feature arrives — and the fixture gained a failing-producer
  mode that the next deferral wave can reuse. Method note: the edit
  script asserted against a `g.__vxDownload` anchor that oxfmt had
  reflowed to multi-line since I wrote it, and aborted before writing —
  the same stale-anchor failure as the archive.ts comment tail two waves
  ago. Stepwise edits with a labelled assert per hunk named the missing
  one in one run instead of three.

**The 2026-08-25 arc (waves 39–52): `--download` shipped and hardened, the
core modules audited.** Full text in the archive. SHIPPED: phases 1–3 of the
deferred-outputs arc — `--download=all|toplevel|none`, the plan-time mode
decision, the eligibility gate, the `DeferredOutputs` registry with lazy
materialisation converging to an ordinary cache entry, and the exec-record
short-circuit that makes repeat deferred runs skip Merkle/upload/Execute —
proven END TO END against a live NativeLink across three runs (deferred →
eager pickup → local hit). THE DESIGN NEEDED THREE CORRECTIONS, all found by
executing rather than reading: its eligibility rule was INERT as written
(same-project readers force everything eager — the shipped gate compares glob
static prefixes), it ignored `cache.inputs.runtime` entirely (a shell
command's reads cannot be bounded, so such a run defers nothing), and its
claim that "`--verify` pins placement local" held for `inputs` ONLY, so a
determinism proof silently reported `no-outputs` for deferred tasks — a
vacuous proof. RED MAIN, mine: the v27 hardlink fix opened a
concurrent-restore window (`ENOENT: chmod`, measured 3/400) — extraction now
writes through a rename, and the class sweep found `cache.ts` had recorded
that exact lesson years-equivalent earlier. MODULES: `src/workspace/` closed
3-clean/1-defect (`exec.persistent` accepted unknown keys, so a `readWhen`
typo made a server "ready" the moment it spawned) and `src/graph/` closed on
seven refutations. Also: the `--affected` docs now say it excludes dependents
and point at `...[base]`. [grep the archive: 2026-08-25 thirty-ninth wave …
fifty-second wave]

**The 2026-08-24 → 08-25 arc (waves 19–38): the REAPI wire hardened, the
plugin packages completed, and the deferred-outputs design.** Full text in
the archive. CORRECTNESS, in the worst-failure-class order: CAS downloads
were UNVERIFIED — a lying stub server proved either read path would write a
poisoned remote's bytes into the local store under a trusted name, fixed by
re-hashing every download with the negotiated digest function (Bazel's client
always did; ours did not). The v27 archive container was audited across two
sessions and gave up a hardlink clobber whose provenance was INHERITED from
the old tar reader — a faithful port carries the original's bugs, so the
audit trigger is code that MOVED, not only code that is new. ChainedCache
double-packed shared-local saves and returned a PARTIAL batch-probe union
that poisoned a sibling layer's inflight map (a lost hit, not a stale one).
stable-keys, pool × resources, glob→output_paths and the exec-record
short-circuit all closed clean or comment-pin-only. SHIPPED: `@vzn/vx-github`
(job summary + the Checks API check-run, roadmap item 5 complete),
`TaskOutcome.where`, `--output-logs hash-only`, `vx last`, `vx prune`, and
the darwin enforcement canary PROMOTED from data-only to a gate (220/220
enforced) while full `VX_REQUIRE_SANDBOX` stayed refused — the suites' pins
assert on the lossy violation-line channel, so promoting it buys flake, not
coverage. REFUTED and recorded: `bun test --isolate` for the packages job
makes the http2 stall MORE likely; the `--verify=inputs` "non-enforcement"
mode was a MISREAD of an ambiguous signal (reporting loss with enforcement
intact); the bench had been silently broken for three days by the
no-defaults reframe. The arc closes with the `--download`/deferred-outputs
DESIGN — which retired the roadmap's "CAS-shaped local cache" with a
cost-out, since the REAPI CAS plus the exec record already IS the deferred
entry. [grep the archive: 2026-08-24 nineteenth wave … 2026-08-25
thirty-eighth wave]

**The 2026-08-24 audit storm (waves 1–18), distilled.** Full text in the
archive under "waves 1–18". One day, eighteen cycles, three arcs. RELIABILITY:
a wedged (accepts-and-never-speaks) remote hung every run — gRPC deadlines on
every cache-path call, wedge = one deadline not deadline×retries; the 128 KB
"boundary" was re-proven a RACE on identical Bun builds and got the adaptive
DEADLINE*EXCEEDED→65 535 downgrade (multi-message writes only, both ways
pinned); a Docker Hub 500 moved the NativeLink base to the ECR mirror with
bounded retries. DARWIN: the CI job shipped and earned its keep immediately
(two test-env-hermeticity debts only darwin could see, GITHUB*\* leakage),
round two's flake was class-gated in `sandboxAvailable()`, and the
enforcement canary began accumulating datapoints; the reporting flake was
root-caused to lossy async unified-log delivery — settle-poll halves it
5.0%→2.2%, residual DROPPED not delayed. CORRECTNESS: dual-store coherence
inverted to LOCAL DISK IS TRUTH (graft only when nothing is local; divergent
records pinned); `--verify=inputs` × remote execution was a vacuous pass —
verify now pins ALL placement local (control-first e2e); the
`isOutputsCurrent` open item was refuted stale (ms-precision, both directions
pinned); the SQL `LIKE 'cache-hit%'` spelling of the status-prefix drift
class survived in core 7× including inside the flakiness signal — killed by
derivation, and the widened tripwire out-audited the audit by catching the
seventh copy live. Also: pool-slot leak refuted (failure-path pins), `@noop`
pinned both directions, the remote-execution guide shipped, metrics +
history/predict audited clean, SpliceBlob proven live against bazel-remote
(the "blocked" label was half wrong and corrected). [grep the archive:
2026-08-24 first wave … eighteenth wave]

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
