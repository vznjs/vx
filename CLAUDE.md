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
  single-writer, user-invoked paths — benign. One instance was called
  latent-and-unreachable — `cas-backend.ts`'s bare `Bun.write` put —
  on the grounds that the module has no consumer. **CORRECTED
  2026-08-25 (sixtieth wave): it is reachable.** `Cache.contentBackend()`
  is a public method exported from `src/cache/index.ts` with its own
  tests, so an embedder can race it; the design doc's "not the
  foundation for THIS arc" was read as "dead", which it is not. Fixed
  with the same temp+rename and pinned.

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
