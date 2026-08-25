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

- **A v27 restore holds the decompressed artifact AND a copy of every entry
  at once** — `Bun.Archive.files()` returns File objects owning their bytes,
  where the previous hand-rolled reader returned zero-copy views into the tar.
  Measured on a 150 MB incompressible artifact in a fresh process: peak RSS
  575 → 683 MB (+19%) and 74 → 95 ms (+28%); at ≤ 12 MB the two paths are
  indistinguishable. Not binding the decompressed bytes to an outliving local
  was tried and REFUTED (no change), so the cost is structural. Peak is
  ~4.5× artifact size against a 2 GiB decompression ceiling that bounds the
  input, not the multiplier. A streaming read would fix it, but the only
  streaming surface (`extract()`) neither preserves mtime nor strips the
  namespace prefix, which is why it was not used.

- ~~`vx run --verify=inputs` on macOS reports a false `undeclared-inputs` for
  the project's own ancestor directories and prints raw sandbox-exec log
  lines instead of paths~~ — **CLOSED 2026-08-24 (twenty-fifth wave)**: the
  call is made — ancestor-directory traversal is NOT an input. Denials on
  exact ancestor-or-self DIRECTORY paths of the task's cwd are filtered at
  the source (realpath'd); file reads inside ancestors still report; verify
  extracts the bare trailing path from macOS lines. Both directions pinned.
- ~~CI is `ubuntu-latest` only~~ — **CLOSED 2026-08-24**: a `core-darwin`
  job runs the full core suite on `macos-latest`. Deliberately WITHOUT
  `VX_REQUIRE_SANDBOX` (the macOS sandbox suites are the recorded load-flaky
  class; the security boundary stays enforced on the linux job). The
  promotion question was ASSESSED 2026-08-25 and split: full
  `VX_REQUIRE_SANDBOX` on darwin stays REFUSED — the suites' pins assert
  on violation LINES, the lossy-by-OS channel (~5% measured), so they
  would flake at the OS's loss rate regardless of runner stability — but
  the enforcement CANARY was promoted from data-only to a GATE (220/220
  enforced across 11 runs; a single `not_enforced` now reds the darwin
  job, a fully-erroring harness too; reporting loss stays tolerated).
  Full-suite un-gating needs the pins rewritten to assert on artifacts,
  not lines.
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
  artifact bytes in RAM; `drainUploads()` has no timeout of its own and is
  deliberately outside the throw-path `finally`. SHARPENED 2026-08-25: for
  the reapi layer the wedge concern is CLOSED by construction — `put` is
  findMissingBlobs + writeBlob + updateActionResult, all deadline-bounded
  (the eighteenth-wave gRPC deadlines), so a full drain is finite
  (~pending/4 × 3 calls × deadline worst-case). The unbounded-hang risk
  remains only for a THIRD-PARTY `RemoteCacheLayer` whose `put` carries no
  deadline — a plugin-author responsibility the extensibility guide should
  name if a second remote plugin ever appears.
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

- **2026-08-25 (fifty-second wave) — `src/graph/` audited: SEVEN
  hypotheses, seven refutations, no code change.** The `dependsOn`
  micro-syntax turns user strings into edges, and a mis-parsed spec
  builds the wrong graph silently, so it earns a pass on stakes. All
  refuted by reading the code against a specific failure and confirming
  the guard: (1) cycles hang the scheduler — no, `detectCycle` runs at
  build time and both a cross-project cycle and a same-project
  self-cycle are already pinned; (2) `^name` wraps back into the
  declaring project on a package-graph cycle (legal in PMs) — no, the
  frontier seeds `visited` with the origin, pinned for both the plain
  and pattern forms; (3) `pkg#pattern` is documented as rejected but
  the parser accepts it — the BUILDER rejects it, and more thoroughly
  than documented (it checks the project half too, so `pkg*#build`
  fails); (4) parser edge cases (empty spec, `!` with no body, bare
  `^`, `^`+`#`, empty halves of `pkg#task`) — every one a named error;
  (5) the frontier's holder-ness differs between the plain and pattern
  branches, so `--excludeDependencies` would make a walk pass THROUGH a
  real holder and over-connect — no: `addNode` returns null only when
  the task is UNDECLARED (`skipAll` returns the node), so both branches
  are declaration-based, exactly as the comment claims; (6) the
  `skipNames` filter is applied in the pattern branch only — no, it is
  checked before the kind dispatch and re-applied per expanded name,
  which the comment states and the code does; (7) a self-dependency
  becomes an instant self-cycle — the same-project pattern expansion
  skips the declaring task by name. Second module in a row to close
  with no defect (after `src/workspace/`'s 3-clean/1-defect), and the
  defects that do surface now come from code written THIS WEEK rather
  than from the mature core — a real signal about where to point the
  rotation, not a reason to keep sweeping settled modules.

- **2026-08-25 (fifty-first wave) — `project-loader.ts`: the last
  unaudited workspace file, and it yielded a real one — a typo INSIDE
  `exec.persistent` was silently accepted.** The loader is otherwise
  the best-validated surface in the tree: unknown keys are rejected at
  the task, `exec`, `cache`, `cache.inputs`, `cache.outputs`, `sandbox`,
  `sandbox.network` and `resources` levels, `EXEC_FIELDS` matches
  `ExecConfig` exactly (checked field by field — a list that OMITS a
  real field is the inverse defect, a refusal that breaks a working
  config), and `..` path segments are refused in output globs with the
  data-loss reasoning written down. CONFIRMED by probe: `persistent`
  was the one nested object with no unknown-key check, so
  `persistent: { readWhen: 'up' }` loaded fine — `readyWhen` stays
  undefined and the task reports ready the moment it SPAWNS instead of
  when its server listens. The quiet kind of failure: dependents start
  too early and fail in a way that points at the user's code rather
  than their config, and the existing tests covered the typo one level
  UP (`persistant`) but not one level down. Fixed with the same
  `assertKnownFields` every sibling uses; pinned with a false-positive
  CONTROL (both legal shapes — `{readyWhen}` and `{}` — still load),
  because a refusal that breaks a working config is worse than the typo
  it catches. Differential kills exactly the new pin. The module audit
  closes 3 clean / 1 defect, and the defect was in the file that reads
  user input — which is where the standing rule says to validate.

- **2026-08-25 (fiftieth wave) — `fingerprint.ts` audited: CLEAN, and the
  alarming-looking ABSENCE is pinned as deliberate.** Highest-stakes file
  left in `src/workspace/` — it folds into every cache key, so a miss is
  the stale-hit class. The hash itself holds up: seed-chained
  `name\0` then bytes per file in declaration order, so content cannot
  migrate between files; absent ≠ empty (an empty lockfile still folds
  its name and an empty-bytes hash); creating OR deleting a lockfile
  moves it; and `--affected` is already driven off the same exported
  constant, with a test asserting the two surfaces move together rather
  than agreeing by coincidence. The finding is what is NOT hashed:
  `vx.workspace.{ts,mts,js,mjs}` is absent from the list, which reads
  like an oversight and is the opposite. Everything a `WorkspaceConfig`
  can declare — `concurrency`, `cacheDir`, `timeout`, `predictive`, the
  plugin list — is placement, storage or observability, never what a
  command produces (architecture principle #3: a plugin may change WHERE
  a task runs, never what it runs). Folding it in would also do active
  harm: a laptop declaring the local plugins and a CI runner declaring
  `reapi()` would compute different fingerprints and share not one cache
  entry — precisely the split the rejected `NODE_OPTIONS` non-goal
  describes. Both the reasoning and a pin now sit at the exclusion
  (config churn must NOT move the hash, with a lockfile control proving
  the assertion is not a dead hash); the differential — adding
  `vx.workspace.mjs` to the list — fails exactly that pin. Third
  consecutive workspace file to close clean, which is a real signal
  about this module rather than three coincidences.

- **2026-08-25 (forty-ninth wave) — `filter.ts` audited: four hypotheses
  REFUTED, one undocumented form documented.** The selection DSL decides
  what runs, and a filter mistake never fails loudly — it silently runs
  the wrong set — so it earns a pass on stakes alone. REFUTED, each by
  executed probe: (1) the classic path-prefix spill (`./packages/app`
  also selecting `./packages/app-extra`) — already closed by matching on
  `dir + path.sep`, now PINNED because the failure it prevents is silent
  over-selection, which reports nothing wrong; (2) a trailing slash from
  shell tab-completion selecting nothing — `path.resolve` normalises it;
  (3) the `{dir}` brace form drifting from `./dir` — identical;
  (4) `[<since>]` resolving empty being misreported as a typo — the CLI
  passes an `onNoMatch` that deliberately skips git selectors, with the
  reason written at the call site. The one finding: `--filter .` selects
  EVERY package (it resolves to the workspace root, consistent with the
  documented "relative to workspace root" rule) — but it was absent from
  the syntax table, and a pnpm user typing it expects "the package I am
  standing in". Over-selection is the safe direction, so this is a docs
  fix, not a behaviour change: the table now carries `.` with its real
  meaning spelled out, and the pin nails all four path shapes so none
  can drift. Differential: dropping the `path.sep` guard fails exactly
  the spill pin.

- **2026-08-25 (forty-eighth wave) — `src/workspace/` audited: the
  `--affected` machinery is CLEAN, and the one gap is a documentation
  gap on the sharpest CI question it answers.** First dedicated pass
  over the module. `affected.ts` turns out to be one of the
  best-defended files in the tree — every hazard I went looking for was
  already closed and commented with the defect that taught it:
  `--no-renames` (a cross-project `git mv` would otherwise surface only
  the destination), `--relative` (a workspace nested under the git root
  otherwise yields paths that match no project), `-z` (C-quoted
  non-ASCII names resolve to no project while input hashing sees the
  real name), untracked files unioned in, `vx-lock.json` excluded, and
  fingerprint-file changes widening to EVERY project — that last one
  derived from `WORKSPACE_FINGERPRINT_FILES` so the two surfaces cannot
  drift. Nothing to fix. The real finding is one level up: `--affected`
  selects CHANGED projects only, never their dependents (Turbo's
  `[<base>]` semantics, and the right default), while the CI question
  users actually ask — "did I break anything downstream?" — needs
  `--filter '...[main]'`. The filter table documented `...` and the
  `--affected` section documented the base, but nothing connected them,
  and the task graph cannot close the gap because `dependsOn` pulls
  DEPENDENCIES, never dependents. Docs now say so with both commands
  side by side. Also pinned: `...[<since>]` expanding affected to
  transitive dependents — the suffix form `[main]...` (dependencies) was
  covered, the prefix form (dependents) was not, which is exactly the
  direction that matters for not shipping broken downstream code.

- **2026-08-25 (forty-seventh wave) — the `--download=none` headline
  claim PROVEN live, end to end, instead of audited a fifth time.** Four
  audit waves had already run over the deferral machinery and the signal
  was thinning, so the higher-value gap was the one nobody had closed:
  phase 1's consumable claim ("a CI job runs `--download=none` against a
  REAPI cluster and moves zero output bytes") was design intent, pinned
  only at the executor-unit level. `vx-run-e2e` now drives a real
  `run()` against NativeLink across three runs of one workspace: the
  deferred run succeeds with `outputs: 'deferred'` and the declared
  output ABSENT from the submitter's disk; an eager re-run of the same
  key picks the bytes up through the exec-record short-circuit; the
  third run is a plain local `cache-hit`, proving convergence leaves an
  ordinary entry. That single test exercises deferral, lazy pickup, the
  phase-3 record path and the convergence save together — the seams
  between the phases, which every previous pin tested in isolation. The
  design doc's claim is relabelled MEASURED rather than intended.
  Method note worth keeping: the decision to stop auditing and start
  verifying was the right call at the point where three consecutive
  probes each found something smaller than the last — a thinning-signal
  read is itself a finding, and the answer to it is to go prove the
  headline rather than keep grinding the same surface.

- **2026-08-25 (forty-sixth wave) — RED MAIN, and it WAS my diff: the
  hardlink fix opened a concurrent-restore window; extraction now writes
  through a rename.** A docs-only commit went red on darwin
  `core tests`, which by the standing rule means read the failing TEST
  and the ACTUAL error before calling it a flake. Both were decisive:
  `two parallel extracts of the same payload` failing with
  `ENOENT: chmod` at `archive.ts:307` — one extract's `unlink` removing
  the file between the OTHER extract's write and its chmod. That window
  is one the twenty-seventh wave's hardlink fix opened by widening
  `unlink` from symlinks-only to any non-directory. MEASURED, three
  arms, 400 iterations each: symlink-only (pre-hardlink) 0/400 twice,
  unlink-any 3/400 twice, write-to-temp-then-rename 0/400. Fix: write
  beside the target, apply mode+mtime to the TEMP, `rename` into place.
  rename(2) replaces the destination's directory ENTRY without following
  it, so it is link-safe (the hardlink pin still fails without it —
  verified) AND gap-free (the target is never absent), and metadata
  lands before the file is visible. A failed write unlinks its temp so a
  stray `.vx-tmp-*` can never be swept into the next artifact.
  **Two honesty notes.** (1) Mid-investigation I doubted my own causal
  claim, reasoning that a fresh dest dir means no unlink runs — wrong:
  the SECOND extract still finds the first's file and unlinks it. The
  three-arm measurement settled it rather than the argument. (2) The
  in-suite pin is weak and says so: it did not reproduce the pre-fix
  failure in 3 x 400 local rounds even after being tightened twice
  (interleaving, iteration count), while one loaded CI round did. The
  differential of record is the standalone probe, not the test — writing
  the opposite into the test comment would have been the
  claims-a-guarantee-it-does-not-have defect in its purest form.
  **CLASS SWEEP (same wave, per the standing rule).** Every other
  file-replacement site in `src/`: `cache.ts`'s artifact write was
  ALREADY temp+rename — and its comment records this exact lesson, that
  a pre-rm "opened a race window where writer B could delete writer A's
  just-renamed file BEFORE A's subsequent stat, producing a spurious
  ENOENT". The knowledge was in the tree; the sibling module simply did
  not inherit it when the hardlink defense was written, which is the
  same shape as the twenty-seventh wave's inherited-port finding read
  backwards: a port carries the original's bugs, and a fresh write
  misses the original's fixes. `lockfile.ts` and `run-artifacts.ts` are
  single-writer, user-invoked paths — benign. One LATENT instance
  remains, unreachable: `cas-backend.ts`'s `put` is a bare `Bun.write`,
  but that module has no consumer (the download-policy design judged it
  not-the-foundation and left it unused), so it stays an audit/delete
  candidate rather than a fix — changing dead code buys risk, not
  safety.

- **2026-08-25 (forty-fifth wave) — the `--download` guide lands (the
  docs-in-the-same-wave rule, honoured late), and the vx-github
  `--dry` hypothesis is REFUTED by construction.** Two items, one of
  each kind. (1) DOCS DEBT, self-caught: `--download` shipped across
  four waves documented only in `cli.md`'s flag reference — the place a
  REAPI user would actually look, `guides/remote-execution.md`, never
  mentioned it. That violates the standing "a feature is not done until
  its docs land in the same wave" directive, and the honest reading is
  that the rule was met in letter (a flag table entry) and missed in
  substance. The guide now carries the whole story: what deferral buys,
  the two spellings, lazy materialisation + convergence, and the three
  refusals (never moves a key, never defers what a key could observe,
  `--verify` forces `all`) plus the repeat-run record short-circuit.
  (2) REFUTED, cheaply and worth recording so nobody re-treads it: the
  sharpest hypothesis against the new Checks API surface was that a
  `--dry` planning run would POST a COMPLETED check-run for a build that
  never happened. It cannot — the plan path builds no telemetry source
  and never emits a run summary, so `onRunSummary` is never called and
  the sink's own "no summary ⇒ no POST" guard is the second line of
  defence (already pinned). Read-the-code refutation, no probe needed,
  because the absence is structural rather than conditional.

- **2026-08-25 (forty-fourth wave) — deferral × failure paths: one
  under-report CONFIRMED and fixed, `--continue` propagation REFUTED as
  broken, and a test of mine that was wrong before the code was.** Two
  angles left over from the deferral rotation. (1) CONFIRMED: the
  summary's "left outputs remote" list filtered by the `inflight` map,
  but entries are cleared only on SUCCESS — so a producer whose fetch
  FAILED was hidden from the very line that tells a user their tree is
  not current. Exactly backwards: that is the case the line exists for.
  `pending()` is now simply the surviving entries; differential kills
  the pin. (2) REFUTED: `--continue=never` propagates a materialisation
  failure like any other — the synthetic consumer failure flows through
  the ordinary outcome path, trips the global fail-fast, and leaves the
  queued sibling skipped. Worth the wave because the FIRST version of
  that pin failed and the code was right: with both consumers in flight
  at once they BOTH legitimately fail (fail-fast stops queued dispatch;
  in-flight work finishes), so the assertion proved nothing until it
  pinned `concurrency: 1` the way the scheduler's own fail-fast pins
  do. A red pin is a claim about the TEST at least as often as about
  the code — recorded again because it cost a cycle to re-derive.
  Also checked and deliberately left alone: `outputs: 'deferred'` is
  telemetry-only and absent from `vx last`'s persisted history (the
  `where` precedent); persisting it would be a schema change for a
  field the run summary already reports live.

- **2026-08-25 (forty-third wave) — `--verify` × deferral was a VACUOUS
  PROOF; the design's own claim was true of one mode out of three.** The
  doc asserted "`--verify` runs pin all placement local, so nothing
  defers under a proof". Code says otherwise: `placeTasks` takes
  `verify?.inputs === true` — determinism and fingerprint modes leave
  placement alone. CONFIRMED by executed probe: under
  `--verify --download=none` the task deferred and the verdict came back
  `no-outputs` — the n/a bucket — for a task that DECLARES outputs and
  was simply never examined. Not a stale hit; a misreported proof, which
  for the feature whose entire purpose is proving cache correctness is
  the failure that matters. Same class as the eleventh-wave residual the
  twenty-fifth wave closed for `remote:'only'`, arriving through a
  different door. Fix: any verify mode forces `--download=all`, with a
  status line when it overrides an explicit flag — deferral is transfer
  tuning, a verify run is a rare deliberate correctness run, so eager
  wins. Probe → fix → the probe re-run showing `proven-deterministic`
  instead of `no-outputs` → pin → differential (reverting the override
  fails exactly the pin). The transferable lesson: a design doc's
  cross-feature claim ("X already handles this") is a HYPOTHESIS about
  code, not a fact — this one was written by an architect reading the
  same tree and was still wrong by two modes out of three.

- **2026-08-25 (forty-second wave) — hostile pass on my OWN deferral
  machinery: the eligibility gate had a runtime-command hole, confirmed
  and closed.** New-code rule applied to the code I wrote three waves
  ago, from the angle the implementation never considered. Both the
  design's rule and my prefix refinement examined `inputs.files` /
  `inputs.workspaceFiles` only — but `cache.inputs.runtime` is a SHELL
  command whose reads cannot be bounded, and its stdout is folded into
  the key. CONFIRMED by executed probe: a consumer declaring
  `runtime: 'cat out/gen.txt'` left its producer marked deferrable, so
  that consumer's key would have moved with a transfer flag. Deferral
  makes the class SHARPER than it was, which is the part worth
  recording: skipping the output clean is exactly what leaves a stale
  prior build for a runtime command to sample — the feature's own
  never-clean behaviour feeds the hazard. Fix: any run declaring a
  runtime or workspaceRuntime input defers nothing, blunt and
  deliberately so (no analysis separates `node -v` from
  `cat dist/version.txt` — the same reason auto-input inference is a
  standing non-goal). Pinned both ways with an explicit false-positive
  CONTROL (a run with no runtime inputs still defers), so the fix cannot
  degenerate into "refuse everything"; differential kills exactly the
  new pin. Doc corrected in place for the second time — the gate has now
  been wrong twice in opposite directions (too coarse to be useful, then
  too narrow to be sound), which is the honest shape of a correctness
  gate written against a spec rather than against the config surface.

- **2026-08-25 (forty-first wave) — `--download` phase 3: the exec-record
  short-circuit widens, and the existing chain test immediately caught a
  null it exposed.** Plugin-only. The record short-circuit fired for
  `remote: 'only'` alone; it now fires for ANY remote task whose key has
  a record — which is the deferred producer's steady state, since
  deferral writes no local entry and vx's own probe therefore misses on
  every later run. A hit skips the Merkle build, the upload pass and
  `Execute`; the record's blobs are checked with `FindMissingBlobs`
  first (AC and CAS evict independently, so a record outliving its blobs
  falls through to a real execution rather than "succeeding" with
  nothing), stdout replays from a new `stdout_digest` (additive under
  the unchanged `vx-reapi-exec-v1` sentinel — an old record replays
  empty, never wrong bytes), and the run's download mode still decides
  whether the outputs land. The `refresh`/`--force` guard is preserved,
  as the design review demanded. **The bug the widening exposed:**
  `getActionResult` hands back `null` for an absent `stdout_digest`
  where `Execute` leaves it `undefined`, and the shared stream reader
  guarded only `undefined` — so it dereferenced null and crashed the
  whole execute call. Caught by the node_modules chain test on the first
  live run, fixed at the shared helper so both call sites are covered.
  A textbook argument for keeping the older e2e pins around: the new
  pin passed while the old one failed. Differential: reverting the guard
  to `remoteOnly` fails exactly the new short-circuit pin; full reapi
  suite 78/0 live.

- **2026-08-25 (fortieth wave) — `--download=toplevel` ships: phase 2,
  small by construction as designed.** One clause in the plan-time
  decision function (requested tasks stay eager, everything else defers)
  plus the widened union through RunOptions/CLI/help/docs. The design's
  claim that this phase would be small held up exactly — the decision
  function was the right seam, and nothing in the registry,
  materialisation or convergence paths moved. Two pins: requested-eager
  /intermediate-deferred, and `toplevel` still honouring the eligibility
  gate (a requested task is eager because it was ASKED for, an
  ineligible intermediate because it MUST be — the two reasons are
  distinguishable in `downgrades`). Differential kills exactly the
  requested-eager pin. One correctness detail worth the line: the
  eligibility gate now runs for `toplevel` as well as `none` (it was
  gated on `policy === 'none'`), since `toplevel` defers intermediates
  and therefore needs the same key-observability protection.

- **2026-08-25 (thirty-ninth wave) — `--download` phase 1 ships:
  deferred outputs end to end, and the design's own eligibility rule
  corrected because it was INERT.** The first consumable slice of the
  deferred arc: `RunOptions.download`/`--download=all|none`, a
  plan-time per-task `eager|deferred|never` mode, the eligibility gate,
  `ExecuteRequest.download` + the `disk`/`deferred` result
  discriminator, the run-scoped `DeferredOutputs` registry with lazy
  materialisation and convergence, reapi honouring it, and the summary
  naming what stayed remote. `--download=all` is byte-identical to
  before (2604/0 with no existing test touched). **The correction that
  mattered:** §4.3 as written marked a producer ineligible whenever any
  sibling read its project — true of every real workspace (`test` reads
  `src/**`, `build` writes `dist/**`), so `--download=none` would have
  deferred NOTHING and the phase's consumable claim would have been
  false. Shipped gate compares glob STATIC PREFIXES instead: same
  conservatism where it matters (leading wildcard ⇒ `.` ⇒ everything,
  no declared `files` ⇒ whole project, `workspaceFiles` either side ⇒
  ineligible), but `src/**` vs `dist/**` is correctly disjoint. Doc
  corrected in place. Five differentials, each failing exactly its pin
  (save-skip, clean-skip, the materialise call, the memo, the
  convergence save); eligibility pinned BOTH ways including the
  false-positive control; live e2e against NativeLink asserts the
  ARTIFACT (out.txt absent after execute, present after
  `materialize()`), not a call count. Also centralised `staticPrefix`
  into `util/paths.ts` rather than copying it — the gate and the
  sandbox baseline now share one owner. Harness lesson repeated
  verbatim from the twentieth wave: the live pin first failed in 15 ms
  because it was appended into a describe whose helper is `req3`, not
  `request` — a fail that fast is a harness fail.

- **2026-08-25 (thirty-eighth wave) — `bun test --isolate` for the packages
  job: proposed, measured against REAL servers, REFUTED — it makes the http2
  stall MORE likely, not less.** The `packages` job runs ONE BUN PROCESS PER
  TEST FILE in a shell loop, and `--isolate` (fresh globalThis + closed
  resources per file, Bun 1.4) is the obvious way to delete that loop. The
  previous entry parked it as unverifiable locally; it is not — the
  bazel-remote and NativeLink containers from the REAPI spike run on this
  box, so the whole matrix was measured with `VX_REQUIRE_REAPI` and
  `VX_REQUIRE_REAPI_EXEC` both set. Six interleaved rounds, 92 tests
  passing in every single run: plain one-process **0/6** stalls (8.2–8.3 s),
  per-file loop **1/6** (9.0 s, one 39.0 s), `--isolate` **3/6**
  (8.5–8.9 s, three at 38.7–38.8 s). Cumulative across the session:
  isolate ≈ 6 stalls / 11 runs, plain ≈ 1 / 9, per-file ≈ 1 / 6.
  **The stall was IDENTIFIED, not inferred:** a JUnit reporter run pins it
  to exactly ONE test taking 30.07 s instead of ~0.1 s, and on the two
  occasions it was captured that test was a MULTI-CHUNK ByteStream write
  ("round-trips a multi-chunk artifact at default 128 KB", then "stores and
  restores an artifact larger than one chunk, byte-identical") — i.e. the
  recorded Bun `node:http2` multi-message stall (oven-sh/bun#39796), hitting
  the 30 s gRPC deadline and recovering through the adaptive downgrade, so
  the test PASSES and only the clock shows it. Mechanism for why isolation
  is worse, hypothesis not proof: a fresh realm per file means a fresh gRPC
  client and http2 session per file, so the suite pays the session-setup
  race nine times instead of once. **Two corrections to the record fall out
  of this.** (1) The stall was believed CI-only ("the whole suite in one
  process timed out at 90 s on this runner") — it reproduces on a fast idle
  laptop, sporadically, which is what a peer-dependent race looks like.
  (2) On THIS box the shared-process shape is the most stable of the three,
  which does not overturn the CI observation (2-core shared runner, several
  30 s stalls would blow the 90 s job timeout) but does mean the loop's
  stated rationale — "the stall compounds with accumulated gRPC sessions in
  a single process" — is not what the local numbers show. The loop stays,
  now for a measured reason rather than an assumed one, and `ci.yml` carries
  the refutation so the next reader does not re-propose it. No code changed;
  a gate change that makes the guarded failure MORE likely is not a
  simplification.

- **2026-08-25 (thirty-seventh wave) — the `--download`/deferred-outputs
  design lands, and it retires the "CAS-shaped local cache" phrase with
  a cost-out.** Architect-drafted, hostilely reviewed, in
  `docs/design/download-policy-cas-cache-2026-08.md`. The headline: the
  deferred arc needs NO local-cache reshape — the REAPI CAS plus the
  already-shipped exec record (`execDigestFor(vxKey)` → per-file
  digests) IS the durable representation of a deferred task's outputs,
  so deferral becomes a run-scoped registry + a widened plugin read.
  CACHE_VERSION and SCHEMA_VERSION stand still; per-file local CAS is
  REJECTED with a cost table (mandatory bump a week after v27, sha256
  on the hot save path, GC + wire redesign vs unmeasured dedup wins);
  `cas-backend.ts`/`digest.ts` judged not-the-foundation and stay
  unused (audit candidate). Load-bearing calls: `--download` is a
  RunOption only, never folded (stripped by construction, pin
  demanded); eligibility reuses the stable-keys observability relation
  as a silent DOWNGRADE to eager, never a refusal; `deferred` = no
  save, no rows, no clean, with `materialize()` called only by core,
  memoised, before locally-placed missing consumers, converging through
  ordinary `Cache.save` so no third storage state ever persists;
  CAS-evicted materialisation fails the CONSUMER loudly. Review drew
  blood twice: a `SCHEMA_VERSION` v22-for-v24 slip, and §6's widened
  exec-record short-circuit missing the tenth-wave `refresh` guard —
  both corrected in the doc. Four phases, each independently
  consumable; phase 1 (`all|none` end to end) is the named first slice.
  Implementation is the next arc, not this wave. Canaries #13–15 banked
  (19/1/0 ×3): cumulative n=300, reporting loss 4.7%, non-enforcement
  0/300.

- **2026-08-25 (thirty-sixth wave) — the bench was silently broken by the
  no-defaults reframe; fixed, and the post-v27 warm paths measured
  healthy.** `bun bench/run.ts` failed on every invocation: the synthetic
  workspace generator predates 2026-08-22's plugins-only contract and
  emitted no `vx.workspace.*`, so every benched run died on the
  missing-plugin hint — for three days, invisibly, because benches are
  not in CI (the skip-is-silent-pass class, bench flavor). The harness
  also SWALLOWED the evidence: it printed the child's stderr, but the
  hint goes to stdout — the manual repro found it in one step. Fix:
  `generate.ts` writes a `vx.workspace.mjs` declaring the local plugins
  by absolute path (the tests-helper shape; `@vzn/vx` does not resolve
  from a tmp dir), with a comment naming this exact failure as the
  tripwire. Then the measurement the fix unblocked, this darwin box,
  median of 3: 50 projects — cold 174 ms, warm-skip 87 ms, warm-restore
  100 ms; 100 projects — 270 / 104 / 125 ms. Warm-restore ~15-20% over
  warm-skip: no sign of a v27 restore regression at bench artifact sizes,
  consistent with the recorded "a wash below ~12 MB". The committed
  RESULTS.md (Linux, 2026-07-03) is deliberately NOT regenerated from
  this host — a fact measured on one box is a fact about that box.

- **2026-08-25 (thirty-fifth wave) — placement × failure-propagation
  audited: clean by construction, now pinned across the boundary.** The
  question: does `--continue=never`'s fail-fast trip cross placement —
  a POOLED failure stopping LOCAL dispatch and the inverse? By code,
  yes: `failFastTripped` is global and placement is admission-only after
  placement time. But the guarantee lived in structure, not in a test
  (the comment-vs-code lesson's milder sibling: correctness by an
  invariant nobody pinned). Two discriminating pins: local slot busy
  while a pooled task fails → the queued local task dequeues after the
  trip and skips (and the inverse with a capacity-1 pool); in-flight
  work still finishes both ways. Differential: scoping the trip to
  non-pooled outcomes fails exactly the pooled-failure pin; restore
  44/0. The rest of the cross was verified already covered: dependents
  of a failed pooled task skip via the placement-agnostic outcome path,
  a failing (non-rejecting) pooled task releases its slot through the
  same completion arm the fourth-wave reject pins cover, and
  `--continue=always` admission ignores failure everywhere by the shared
  predicate. Canary #12 banked from the gate's first gating run: 20/0/0;
  cumulative n=240, reporting loss 4.6%, non-enforcement zero.

- **2026-08-25 (thirty-fourth wave) — `vx prune` ships: the workspace
  subset for Docker builds, comparison gap #10.** Target + transitive
  workspace deps off the existing `buildPackageGraph` (dependencies /
  dev / peer / optional, workspace members only), root manifests, any
  `vx.workspace.*`, `.npmrc`/`.nvmrc`, and the lockfile; `--docker`
  splits `json/` (manifests only — the cacheable install layer) from
  `full/`. Two deliberate calls, both documented in the command header:
  (1) `pnpm-workspace.yaml` is REWRITTEN to the exact subset dirs — the
  original glob would match dirs absent from the subset and break
  installs; (2) the lockfile is copied UNPRUNED — every package manager
  tolerates a superset, a wrongly-pruned lockfile is worse than a big
  correct one, and per-format pruning (Turbo ships a crate per format)
  is out of phase 1 by the no-half-finished rule, recorded as the
  phase-2 candidate. Tail-eating guards: the out dir may not be/contain
  the workspace root nor sit inside a copied package (cp would recurse
  into its own output). Pinned e2e via bin.ts: closure exactness
  (`other` excluded), node_modules exclusion, yaml rewrite content,
  docker split shapes, leaf-project prune, unknown-project suggestion,
  the inside-a-package refusal; parser units for both flag spellings.

- **2026-08-25 (thirty-third wave) — the darwin promotion call, made on
  the canary's evidence: the enforcement canary GATES, full
  `VX_REQUIRE_SANDBOX` stays refused, and the gate helper sheds a
  refuted claim.** The named follow-up condition ("once the runners
  prove stable") was assessed against n=220: enforcement is 220/220 —
  but reporting loss is 5% and STRUCTURAL (lossy-by-OS), and the gated
  suites' leaky-task pins assert on violation LINES, the lossy channel
  itself, so promoting the flag would buy a ~5%-flaky darwin job, not
  coverage. Split instead: the canary — which classifies by ARTIFACT
  (out.txt content), immune to reporting loss — is promoted from
  data-only (`continue-on-error`) to a gating step: one `not_enforced`
  iteration reds the job, as does a fully-erroring harness (an
  all-RUN_ERROR canary proves nothing and must not read green);
  `enforced_unreported` stays tolerated and keeps accumulating as data.
  Differential: a forced NOT_ENFORCED classification exits 1, healthy
  exits 0. Also fixed while there: `sandbox-gate.ts`'s comment still
  asserted the REFUTED non-enforcement reading (the comment-outlives-
  its-correction defect class) — rewritten to the corrected account,
  including the un-gate condition (pins rewritten to assert on
  artifacts, not lines).

- **2026-08-25 (thirty-second wave) — `vx last` ships: last-run replay,
  comparison gap #12 closed the wave after its value was re-assessed.**
  The previous wave's comparison-doc correction noted the deleted
  dashboard had been this gap's answer; `vx last` is the CLI surface
  that replaces it. Bare = the most recent run's summary (verdict,
  command, timing, branch @ sha, CI, counts, then the per-task table —
  status/id/duration/key, failures first); `vx last <runId>` replays a
  specific run; `--list[=N]` prints recent run ids; `--format json`
  emits `{invocation, tasks}`. Entirely read-only over the existing
  metrics layer (`listInvocations`/`getInvocation`/`getRun`) — zero new
  SQL, no config evaluation, no cache probe; the verb slots beside
  `vx why` (same DB-reading grammar, same parser conventions including
  why's flag-name-first lesson). Pinned e2e via bin.ts subprocesses:
  replay content, --list round-trip (the listed id replays), a FAILED
  run with failures first, JSON shape, unknown-id fails loud pointing
  at --list; parser units cover both flag spellings and every rejection
  message.

- **2026-08-25 (thirty-first wave) — `--output-logs hash-only` ships
  (Turbo parity, gap #7), and the comparison doc sheds its dead cloud
  references.** The fourth output mode: one line per task — outcome
  word, task id, cache key — with zero log output; `discardsOutput` now
  covers it (the buffers the mode promises never to print are not
  buffered, same reasoning as `none`). Pinned with the
  exact-expected-set rule (a mangled leak sails past `not.toContain`):
  success/hit/failure/skip lines byte-exact, build output asserted
  absent by the same equality; parse pins cover both flag spellings and
  the typo message naming all four modes. While sourcing the next arc
  from docs/comparison.md, two stale cloud references surfaced and are
  corrected: gap #1 still advertised the removed platform's S3 blob
  backend (now points at the archived design doc), and gap #12 claimed
  the dashboard covers last-run replay — the dashboard is GONE, which
  RAISES #12's value: a CLI `--last-details` over the local metrics
  layer is now the only candidate surface, noted as such. Also skipped
  deliberately: a github()+otel() two-sink composition pin — the host's
  fan-out/isolation/budget behavior is already pinned in
  telemetry-lifecycle, and each package has its own real-run() proof;
  a joint pin would add ceremony, not coverage.

- **2026-08-25 (thirtieth wave) — `TaskOutcome.where` ships: worker
  attribution end to end; the outputs discriminator deliberately stays
  unshipped.** Roadmap item 4 split by the no-half-finished rule: the
  `disk`/`cache`/`deferred` discriminator has no consumer until the
  `--download` + CAS-shaped-local-cache arc, so shipping the enum now
  would be dead schema — recorded in the design doc instead. The
  consumable slice: `ExecuteResult.where` (executor-reported placement
  label; absent = this host) → `TaskOutcome.where` → telemetry `task.end`
  - summary rows → OTel `vx.task.where`. The reapi executor sets it from
    `ExecutedActionMetadata.worker` (the value it already warned with);
    deliberately NOT persisted to the analytics store. Pins: the otel
    losslessness tripwire did its job (adding the field broke the
    `Required<…>` fixture until the span mapping existed — the exact
    failure mode it was built to force); a spy-executor run() pin asserts
    both telemetry surfaces carry `worker-7`; differential (dropping the
    outcome copy) fails exactly that pin; live exec-e2e asserts a REAL
    NativeLink worker id arrives (9/0). Docs updated in the same wave
    (executor module + design doc §5 flipped from "not shipped").

- **2026-08-25 (twenty-ninth wave) — the Checks API check-run ships:
  roadmap item 5 complete.** The second half of `@vzn/vx-github`: with
  `GITHUB_TOKEN` + `GITHUB_REPOSITORY` + `GITHUB_SHA` present, `flush()`
  also POSTs one COMPLETED check-run on the built commit — conclusion
  from `exitOk`, output.summary = the same job-summary markdown, clamped
  to the API's 65 535-char cap with a visible truncation tell. Failure
  posture per the invariant: a non-2xx POST warns (403 names the missing
  `checks: write` permission) and never throws; activation without the
  env silently skips by default, warns under explicit `checks: true`,
  and `checks: false` opts out. Transport is an injected `fetchFn` (the
  otel `post` seam pattern), so all five pins run offline — payload
  shape, clamp, one-POST flush through the injected transport, the
  never-throw 403 path, and both activation modes. Hazard caught while
  wiring: the EXISTING summary tests would have POSTed to the real API
  when run ON an Actions runner (the env is ambient there — the recorded
  GITHUB\_\* leakage class); every summary-only fixture now pins
  `checks: false`. Also banked canaries #9–11 (20/0/0, 18/2/0, 18/2/0):
  cumulative n=220, reporting loss 5.0%, non-enforcement still ZERO —
  0/220 puts the upper 95% bound near 1.3%.

- **2026-08-24 (twenty-eighth wave) — CAS downloads were UNVERIFIED;
  confirmed with a lying stub server, fixed with negotiated-function
  re-hashing.** The zstd/compressed-blobs audit found the sharp edge one
  layer down: neither `readBlob` nor `batchReadBlobs` checked that the
  bytes a remote returned actually hash to the digest they were requested
  under, and `Cache.ingest` writes whatever arrives — so a corrupt or
  poisoned remote's bytes would land in the local content-addressed store
  under a trusted name and be served forever under a green hit (the worst
  failure class; Bazel's client verifies downloads, ours did not).
  CONFIRMED offline with a grpc-js stub CAS that answers every read with
  wrong-but-right-length bytes: both paths accepted them at HEAD (the
  failing pins are the executed repro AND the differential — fix absent =
  fail, fix present = pass, both observed). Fix: `assertBlobIntegrity` on
  every read path after decompression — length always, content re-hash
  via the same `digestWith(negotiated fn)` helper every upload already
  uses (a function this build cannot compute also could never have
  negotiated). A refusal surfaces as an error the LayeredCache already
  degrades to a MISS — the invariant holds instead of being bypassed.
  False-positive control at two scales: an honest stub passes both paths,
  and the full live e2e matrix stayed green against real bazel-remote +
  NativeLink (26 tests: compressed paths, node_modules chain, real
  `run()`). README documents the read-side mirror. The audit note for the
  rotation: the compression code itself was CLEAN (per-response
  compressor honored, resource names correct, commit checks sound) — the
  finding was in what the path DIDN'T do, which is where a wire audit
  should look first.

- **2026-08-24 (twenty-seventh wave) — the v27 archive container audited:
  one CONFIRMED clobber (hardlinks), the author's unexecuted probes
  executed, and the memory question answered with a worse number than
  predicted.** Cross-session audit of vx-eb's Bun.Archive wave (new-code
  rule; stored-bytes is the worst class), building on their probe ledger
  rather than re-treading it — their measured refutations (truncation
  throws, names come back raw, non-regular entries omitted) were taken as
  given and held. CONFIRMED: the extract-target link defense unlinked
  SYMLINKS only, and `Bun.write` truncates a pre-planted HARDLINK's shared
  inode in place — the artifact bytes were written THROUGH
  `ln <victim> <dest>/out.txt`, replacing the victim's content (executed
  probe; the identical threat model the symlink branch already documents,
  minus the link-shaped tell). PROVENANCE (vx-eb's correction, verified
  against `5b2ae3c:src/cache/tar.ts:415`): the gap is INHERITED — the
  symlink-only line was ported verbatim from the old tar reader, where it
  survived every prior audit. A counterexample to the new-code rule worth
  its own sentence: a faithful port carries the original's bugs at full
  strength, so the audit trigger is code that MOVED, not only code that
  is new. Fix: unlink ANY existing non-directory
  target before writing — breaks every link shape at once, recreates a
  plain file, and a directory still fails the write fail-closed.
  Differential: reverting to symlink-only fails exactly the hardlink pin;
  cache surfaces 176/0. EXECUTED-REFUTED (their pointer #2): a corrupt
  sidecar throws out of `readArtifact` and cache.ts wraps every
  non-security throw in `CorruptArtifactError` → the re-run path; pinned.
  REFUTED-BY-PRECONDITION: the `mode !== 0` chmod-skip sentinel is
  unreachable — a mode-0 output cannot be PACKED (`Bun.file().bytes()`
  gets EACCES), so no artifact can carry mode 0 (the probe found this by
  failing at pack, not extract). MEASURED (their pointer #1) by BOTH
  sessions in parallel, one answer: my isolated read+extract of a 256 MB
  artifact peaked at ~1043 MB RSS (~4× the bytes); their old-vs-new arms
  at 150 MB (e954cbe) put it at 575 → 683 MB (+19%, restore +28%),
  refuted the obvious lifetime fix by measurement, and corrected their
  own "restore is a wash" claim in place — a wash only below ~12 MB. One
  characteristic, recorded from both angles: `files()` copies coexist
  with the decompressed tar, streaming `extract()` is unusable (no
  mtime, no prefix strip), the 2 GiB ceiling bounds input not
  multiplier, and typical artifacts are MBs. Residual noted, not fixed: an epoch-mtime output
  (`mtimeMs === 0`) skips utimes and re-restores every warm run — perf
  echo of the closed isOutputsCurrent item, unreachable in practice.

- **2026-08-24 (twenty-sixth wave) — `@vzn/vx-github` ships: the job-summary
  telemetry plugin, roadmap item 5's first half.** A new workspace package
  contributing one observe-only sink through the telemetry seam — the
  seam's second real consumer after vx-otel, which is what the rotation
  demands of a seam. `github()` declines outside GitHub Actions (no
  `GITHUB_STEP_SUMMARY`, no cost — otel's decline pattern), streams nothing
  (`wants: []`), stashes the `RunSummaryRecord` and renders + appends in
  `flush()`: verdict headline, stats line, failures called out above the
  per-task table, a Verify column only when verdicts exist,
  `escapeMarkdownCell` from the façade (exported for exactly this consumer
  after the cloud summary shipped unescaped once). Pinned: render units
  (pipe-hostile names included), decline/activation, the prompt-return
  contract (no I/O in onRunSummary), and a composition proof through a real
  `run()` fixture. The Checks API PR check-run is the deliberate second
  half, named in the README roadmap. Also: architecture.md's package table
  had gone stale (vx-reapi never got a row) — both rows added.

- **2026-08-24 (twenty-fifth wave) — remote-only tasks report as
  unverifiable; the ancestor-traversal false positive closed; and a
  two-agent commit collision worth its process line.** (1) The
  eleventh-wave residual: a `remote:'only'` task under a verify proof
  no-ops locally and was silently unverified. New verdict
  `unverifiable-remote-only` — n/a in the tally, a ⚠ line naming the
  reason, emitted only when a proof was requested; control-pinned (a plain
  run carries no verdict), differential kills exactly the pin. (2) The
  settle window UNMASKED the recorded false-`undeclared-inputs` item: with
  clean verify exits now waiting for the lossy log, macOS's
  `deny file-read-data` records for the task's own ANCESTOR DIRECTORIES —
  cwd-reaching traversal, no content — fired ~1/3 per clean run. Owner
  call closing the item: traversal is not an input. Filter at the source,
  exact ancestor-or-self dirs of cwd only, realpath'd; leaky-file control
  5/5, clean task 10/10 from ~1/3; the settle poll counts FILTERED
  emptiness so noise can't end the window early; verify path extraction
  learned the macOS bare-path line shape. (3) PROCESS: commit `188c8ee`
  contains BOTH my verify wave and vx-eb's concurrent Bun.Archive/v27
  wave — my `git add <paths>` + bare `git commit` committed the whole
  INDEX, including the other session's by-path staging, and pushed before
  their commit landed. Nothing lost, history stays (a reset would now be
  a force-push of main). The discipline adopted by both sessions:
  `git commit -- <pathspec>`, which ignores the rest of the index by
  construction. Their wave's content is theirs to log. Canary #7 banked:
  18/2/0; cumulative n=140, reporting loss 4.3%, non-enforcement zero.

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
  158 → 11 ms (~14×); artifact grows ~7 compressed bytes per output for
  the sidecar. **Restore CORRECTED after the fact, by my own follow-up
  measurement:** "a wash" holds only at the sizes I first measured
  (≤ 12 MB — 0.27 / 0.55 / 2.16 / 33 ms, indistinguishable). On a 150 MB
  INCOMPRESSIBLE artifact, restored in a fresh process so the pack phase
  cannot confound it, the new path is SLOWER and HEAVIER: 74 → 95 ms
  (+28%) and peak RSS 575 → 683 MB (+19%), reproduced twice per arm
  within 1 MB. Cause is structural, not a bug: the old reader handed out
  zero-copy VIEWS into the decompressed tar, while `Bun.Archive.files()`
  hands back File objects owning COPIES, so both live at once. The
  obvious fix — not binding the decompressed bytes to a local that
  outlives `readArtifact`, which the old reader could never do — was
  implemented, measured, and REFUTED (682.8 → 681.9 MB, i.e. nothing),
  so it was reverted rather than shipped with a comment claiming a
  benefit it does not deliver. Accepted trade, recorded as an open item:
  peak is ~4.5× artifact size where it was ~3.8×, and the 2 GiB
  decompression ceiling bounds the input, not the multiplier.
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
  now. **Process note, recorded because it cost real confusion:** this
  change set LANDED INSIDE commit `188c8ee`, whose message describes only the
  concurrent verify/sandbox wave — a peer session committed the shared INDEX
  while these files were staged by pathspec, and the commit was pushed before
  a split was possible. Nothing was lost and the tree is correct; the rule
  that follows is that concurrent sessions commit by EXPLICIT PATHSPEC
  (`git commit <paths>`), never a bare `git commit` that sweeps whatever is
  staged.

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
  change — left as a candidate. **CORRECTED 2026-08-25 (thirty-eighth wave):
  that candidate is REFUTED — `--isolate` makes the stall the loop exists for
  MORE frequent, measured against real servers.** Also noted: `bun install` under 1.4 relinked
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
