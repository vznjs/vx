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
    plugin-host.ts      # eventSink wiring + end-of-run teardown/flush
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
    index.ts cache.ts layered-cache.ts inputs.ts tar.ts
    cas-backend.ts / digest.ts # pluggable CAS seam (internal, artifact-store roadmap)
  exec/                 # per-task execution primitives
    index.ts runner.ts env.ts sandbox-runtime.ts
  util/                 # tiny shared helpers
    index.ts paths.ts hash.ts ulid.ts errors.ts
packages/
  cloud/                # @vzn/vx-cloud — the client/server service (self-contained)
    src/
      plugin.ts         # cloud() plugin: telemetry/backend/cache capabilities
      environments.ts   # per-user environments.json (connect targets)
      serve-info.ts     # per-user local serve advertisement
      ingest-store.ts   # server-side run history (pushed summaries)
      protocol-dist.ts  # worker:*/coord:* distribution messages
      coordinator-prepare.ts
      cli/              # vx-cloud dispatcher: serve, connect/env/disconnect,
                        # coordinator, worker, dev, backend, ui-asset/server
    ui/                 # the dashboard SPA (Solid + UnoCSS + json-render views)
    deploy/             # Dockerfile context + Helm chart skeleton
  vx-otel/              # @vzn/vx-otel — otel() telemetry plugin (OTLP JSON, no SDK)
apps/docs/              # Astro Starlight docs site (imports docs/)
bench/                  # synthetic-workspace generator + benchmark runner
docs/                   # source of truth: architecture, caching, cli, execution,
                        # schema, flows, optimizations, comparison, modules/<name>.md,
                        # design/ (proposals + the 2026-07 consulting review)
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
  `bun src/bin.ts run test` to drive it through vx itself.
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
   no executor plugin protocol.
4. **Resolved-config hashing.** The cache key sees the post-evaluation
   config object, so imports and computed values participate.
5. **Cascade through deps.** Upstream cache changes invalidate
   dependents via folded-in upstream hashes.
6. **Project boundaries are hard.** A project's globs never reach into
   another project's dir.

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

## Decision log

- **2026-07-10**: **The plugin-driven remote cache SHIPPED — all three
  phases of `docs/design/native-cache-wire-2026-07.md` (`ca85901`,
  `a50a93e`, `aa1797f`, `5cdbe24`)**, executing the same-day owner
  directive below. **Phase A (core seam):** exported `RemoteCacheLayer`
  interface (`has`/`get`/`put`; implementations THROW, `LayeredCache`
  degrades every throw to a miss) + `RunOptions.remoteCache` embedder
  injection that WINS over the plugin `cache` capability (the
  telemetrySinks pattern). **Phase B (the vx-native wire):** the serve's
  ArtifactStore handles `/v1/cache/:hash` (GET/HEAD/PUT) — headers
  `x-vx-duration-ms` (the `.duration` sidecar's wire form) and
  `x-vx-digest` (`xxh3:<hex>` over the artifact bytes, stored as a
  `.digest` sidecar, echoed on GET); PUT STREAMS to the temp file with
  the 512 MiB cap enforced on ACTUAL cumulative bytes mid-stream (a
  chunked/lying body can neither buffer RAM nor spoof the cap);
  immutability 409 checked before the body; trust scopes byte-identical.
  New `packages/cloud/src/native-cache.ts` `NativeCacheClient`: bounded
  downloads (content-length REQUIRED + capped + mid-stream cap), digest
  verification (mismatch throws → miss), ONE-hop 307/302 follow DROPPING
  the bearer cross-origin (the blob-offload seam, client-ready before any
  server implements it), clearable timeouts, 409-as-success on PUT.
  `cloud()` builds it when the connected serve advertises `cacheWire: 1`
  on `/v1/meta`; distributed agents/submitter switched from env wiring to
  explicit `RunOptions.remoteCache` injection (both execute in-process
  scoped `run()`s — no subprocess channel exists; `markAgentProcess`
  keeps the telemetry sentinel). `/v8/artifacts` is DELETED. **Phase C
  (core scrub):** `src/cache/remote-cache.ts` (Turbo client + HMAC +
  preflight) and `orchestrator/remote-cache-setup.ts` (`VX_REMOTE_CACHE_*`
  env hatch) deleted — core carries ZERO HTTP cache code; the façade
  drops `RemoteCache` (boundary snapshot updated); `vx info` drops its
  env-derived remote-cache row; `resolveCacheScope` survives untouched
  (reads `VX_CACHE_SCOPE` + CI PR context — the per-PR partition concept
  is part of the native wire). Turbo interop = the ~20-line third-party
  recipe in the extensibility guide. **Named deviations (deliberate):**
  no server-side digest verify (no 422 — the CLIENT verifies on GET,
  which covers the corruption directions that matter; the server skips a
  hash pass per upload); the serve route is hex-only `[0-9a-f]{16,64}`
  so it can never shadow the named `/v1/cache/*` analytics endpoints
  (pinned by a no-shadowing test); ArtifactStore's byte cap is
  constructor-injectable so the mid-stream 413 is testable without a
  512 MiB body. **Verified end-to-end** (real serve + the real `cloud()`
  env ladder): cold miss → upload (`.tar.zst` + `.duration` + `.digest`
  land in `default/trusted/`), local wipe → `restored-remote` with output
  - stdout replay, GET carries both native headers, tampered artifact →
    digest mismatch → degrades to a MISS and re-executes (never restores
    corrupt bytes), `/v1/meta` advertises `cacheWire: 1`, `/v8` no longer
    routes. Tests: core 1221 pass (orchestrator-remote re-targeted through
    injected stub layers — coverage preserved incl. never-fail-on-500,
    at-most-once GET, planRun HEAD prediction, `local:,remote:rw` in-memory
    pack), cloud 350 pass (+16-test native-client suite incl. raw-TCP
    sizeless refusal + cross-origin auth-drop), lint clean. Docs: cli.md /
    comparison.md / caching / architecture / extensibility (the Turbo
    recipe) / remote-caching guide all speak the native wire; the two dead
    module pages deleted. Remaining designed-not-built: the serve-side blob
    backend (S3/R2) behind the 307 the client already follows.

- **2026-07-10**: **OWNER DIRECTIVE — the remote cache is PLUGIN-DRIVEN;
  Turbo wire compatibility is DROPPED from core** ("I think the remote
  cache should be driven by a plugin. We should drop turbo compatibility,
  and use what make sense for vx cloud. Other could create turbo cache
  plugin"). REVERSES: the 2026-05 "remote cache wire = Turbo
  `/v8/artifacts/` spec verbatim" decision, the 2026-06 Turbo-compatible
  HMAC rationale, and the same-day preflight client (`8fbd2c5`) whose
  premise was Turbo interop. Target state: core keeps ONLY the seams —
  local `Cache`, `LayeredCache` composition, the `CacheLayer` interface,
  and the `cache` plugin capability; the Turbo-wire `RemoteCache` client
  - the `VX_REMOTE_CACHE_*` env wiring LEAVE core. vx-cloud speaks its
    OWN artifact wire designed for vx's needs (trust scopes, integrity,
    streaming — not constrained by Turbo's shape); Turbo interop is a
    THIRD-PARTY plugin story (we document the seam; we don't ship the
    plugin). The presigned-artifacts design's "Turbo verbatim" premise is
    superseded — offload gets designed into the vx-native wire instead.
    Implementation phased behind an architect design
    (`docs/design/native-cache-wire-2026-07.md`).

- **2026-07-10**: \*\*The dashboard's product lens is THE SINGLE DEV
  (standing owner directive — see "Dashboard product lens" section above)
  - the first lens-driven wave SHIPPED (`df76cef`, `e969b92`)**. Owner:
    "the ui should be from single dev perspective. He wants to see it run,
    dig into projects he own, tasks analysis, see if his or improved or
    decreased performance, identify flaky tests give him easy access to
    debug like artifacts of run etc". Audit against the five questions:
    see-it-run ✓ (live Runs), flaky ✓ (badges + Recommendations), but
    "did MY task/project improve or decrease?" existed only
    workspace-wide, and debug evidence took multiple hops. Closed: **(1)**
    `getPeriodComparison` gains `project`/`task` scoping (one shared WHERE
    fragment; `/v1/analysis?project=&task=`), and BOTH entity detail pages
    render a scoped trend tile row (avg exec / failure rate / runs / hit
    rate, this 7d vs prior 7d, signed deltas tinted by direction) — the
    derivation shared with the Insights card via `trendFields()` in
    `ui/jr/data.ts`. **(2)** Task detail gains a **Debug card\*\*: last
    FAILED run deep-linked with `?task=` (captured logs open immediately),
    latest run (deduped when it IS the failed one), latest artifact's
    `/cache/:hash` page (facts + download) — RankList rows are BUTTONS with
    programmatic navigation, so link assertions must click, not query
    `<a>`. Browser-verified (task made 5× slower → `500ms`/`+400ms` amber
    tiles on both pages; the failed-run row lands on
    `/runs/<id>?task=app%23build`; zero page errors). Core 1251, cloud
    331, UI 40, lint clean. When adding dashboard features, check the lens
    section: a feature serving none of the five dev questions is
    org-analytics scope creep.

- **2026-07-10**: **Pre-signed artifact URLs: design + the client half
  SHIPPED (`5ecbc42`, `8fbd2c5`) — and the patterns feature's adversarial
  review closed a repro-confirmed stale-hit trap (`3e2a984`)**. **(1)
  Design** (`docs/design/presigned-artifacts-2026-07.md`, architect):
  adopt Turbo's `--preflight` mechanism VERBATIM (verified against
  `turborepo-api-client/src/lib.rs`: `OPTIONS` + Access-Control-Request-_
  → `Location` + `Access-Control-Allow-Headers` gates whether the bearer
  rides) — the HMAC interop rationale again; a vx-native wire was
  rejected. Phasing: (P1) core client preflight; (P2) cloud-only
  `BlobBackend` (S3/R2, hand-rolled SigV4, NO AWS SDK) with GET offload
  only — PUT keeps proxying so 409-immutability/caps/tag-sidecar stay
  server-enforced; (P3, on-demand only) PUT offload with its
  weakened-immutability residual stated honestly. Trust scopes survive by
  construction (the pre-signed URL binds ONE server-derived scope key).
  **(2) P1 shipped:** `RemoteCacheConfig.preflight` /
  `VX_REMOTE_CACHE_PREFLIGHT` — OPTIONS precedes each GET/PUT/HEAD with
  the intended method + header NAMES; `Location` (absolute or relative)
  becomes the target; bearer kept iff Allow-Headers is `_`or names`authorization`(a query-signed URL rejects a request that ALSO carries
Authorization). Off by default; every existing defense (bounded
download, content-length refusal, zstd checks, HMAC tag verification)
applies unchanged to the redirected body — pinned by a two-origin test
suite (9 tests, incl. unsigned-blob refusal). vx now works against any
Turbo server that offloads to object storage; the comparison gap is
client-closed. **(3) Self-review of the day's two features**
(repro-mandated, same standard as the Opus waves). CONFIRMED + fixed:
**(a) MEDIUM-HIGH — the patterns stale-hit trap.**`cache.inputs.tasks`matched`'build._'`LITERALLY while dependsOn expanded it → the filter
selected ZERO upstream hashes → the dependent DECOUPLED and cache-hit
stale bytes after its upstream changed (executed e2e: served v1 after
v1→v2). Shipping dependsOn patterns COMPLETED the trap (the pairing
used to hard-error). Fix: the task half of every filter form (incl.`pkg#`and negation, unlike dependsOn) shares the`_`-glob matcher;
pinned by 4 units + a real-CLI e2e that fails stale without the fix. NO
CACHE_VERSION bump — a config using a pattern here before was in the
silently-decoupled state; its key changing to fold the matched
upstreams IS the fix. **(b) LOW — duplicate edges** from mixed
exact+pattern (or literal duplicates, pre-existing): scheduling counts
balance (executed), but the upstream hash double-folded on the default
path and DOT printed the edge twice; `node.deps`deduped before the
sort. **(c)** empty`VX_GITHUB_CHECK_NAME`falls through instead of
naming a check`''`(a 422). **Refuted by execution:** edge-order
determinism (sort covers all pattern paths; warm re-run all-hits;`--frozen`green), regex escaping (17 adversarial names) + no-ReDoS,`^pattern` scoped-loading symmetry (prepare loads the full dep closure;
  both forms degrade identically), group surfacing, checks double-post
  (uploaded flag), agent sentinel (a distributed run posts zero checks —
  the documented distributed-ingest gap, not a dupe), endedAt epoch-ms,
  timer cleanup (blackhole API → exactly 5s, then exit). Core 1250 pass
  (+15), cloud 331, lint clean; real CI green on every push.

- **2026-07-10**: **`dependsOn` task-name patterns SHIPPED — `'build.*'` /
  `'^build.*'` (`660d299`)**, closing the last dependsOn gap vs Nx (19.5's
  `build-*`) and pairing with the dotted-namespace convention (`lint:
{ dependsOn: ['lint.*'] }` replaces hand-listing members). Semantics:
  a same-project pattern expands to every OTHER matching task (the
  declaring task never matches itself — instant self-cycle otherwise);
  ZERO matches is legal (a preset-spread pattern needn't match in every
  project — deliberate contrast with the exact-name hard error);
  `'^pattern'` walks the SAME nearest-holder frontier as `'^name'`, where
  a holder = a dep declaring ≥1 matching task and receives edges to ALL
  its matches (holder-ness is about declaration, so a holder stops the
  walk even when every match is `--excludeDependencies`'d; the flag
  filters expanded matches by concrete name). `*` is the sole
  metacharacter (regex-escape everything else — pinned by a test where an
  unescaped `.` would widen the match). Bare `'*'`/`'^*'`/negation stay
  filter-only rejections (message now says "bare wildcards");
  `'pkg#pattern'` rejected with a clear error. `defineProject`'s
  compile-time key check admits `*`-containing strings (they expand at
  graph build, so they can't be key-checked; a bare `'*'` thus
  type-checks but fails loud at runtime, accepted). Helpers
  `isTaskPattern`/`compileTaskPattern` live in `graph/dependency-spec.ts`
  (the parser itself unchanged — a pattern parses as a normal self/deps
  spec whose task happens to contain `*`). NO CACHE_VERSION bump (the
  pattern string rides resolved-config hashing; expansion changes the
  upstream fold only for new-by-definition configs). Tests: 8 graph units
  (expansion, self-exclusion, zero-match, holder-stop + multi-edge,
  sparse bridge, exclude-filter, pkg#pattern reject, dot-escape pin) + 3
  real-CLI e2e (`tests/wildcard-depends.test.ts`). Docs: schema.md
  dependsOn forms + semantics, comparison.md matrix + gap #3 closed. Core
  1235 pass (+11), lint clean. Deliberately NOT dogfooded in the repo's
  own `lint` group — `lint.*` would also match `lint.oxfmt.fix` (the
  rewriting task); the convention needs a non-matching name or an
  exclusion story first.

- **2026-07-10**: **Road-to-best-CI #2 COMPLETED — a real GitHub check run
  on the commit (`2ecfce4`) + the live-refresh wave hardened against failed
  polls (`37bdfbb`)**. **(1) PR checks:** when a `vx run` inside GitHub
  Actions is handed `GITHUB_TOKEN` (the hand-off IS the opt-in — Actions
  never exposes the token to a step by itself; `checks: write` required),
  `CloudIngestSink.flush` now also creates ONE completed check run on the
  commit via the Checks API: conclusion from `exitOk`, the failures-first
  job-summary markdown as the check output (`packages/cloud/src/
github-check.ts`, pure glue over `formatGithubSummary`). For
  `pull_request` events it attaches to the PR's HEAD sha read from
  `GITHUB_EVENT_PATH` — GITHUB_SHA is the synthetic merge commit there and
  a check on it never surfaces on the PR (the dorny/test-reporter
  convention). Knobs: `VX_GITHUB_CHECK=0` disables, `VX_GITHUB_CHECK_NAME`
  names (default: the run's command). Never-fail; a 403 names the missing
  permission. No serve needed — works standalone like the job summary.
  Docs: guides/ci.md "PR checks" section. 11 unit tests + 2 plugin
  activation pins (the decline test now also deletes GITHUB_TOKEN so the
  suite is hermetic inside Actions itself). **(2) Adversarial review of the
  live-refresh/CI-health wave (`a4b3f08`/`dae2f98`)** — the one shipped
  wave that had no hostile pass; three CONFIRMED defects fixed, all hot
  since the 5s tick landed: **(a) CRITICAL wedge** — the Runs `invocations`
  resource was the only UNCAUGHT fetch in the view; one failed poll (serve
  restart, laptop wake) threw an uncaught rejection out of the downstream
  memos and PERMANENTLY froze the history table + CI-health ticks while
  caught siblings kept animating (a frozen view masquerading as live;
  executed repro against solid-js). Fix: catch to null + hold last-good
  rows outside the resource — an outage neither wedges nor blanks.
  **(b)** jsonPage dropped a populated section's data for a tick on a
  transient refetch error (`res.latest` is UNREADABLE while errored — Solid
  re-throws); a per-source last-good map keeps data, only a first-load
  failure shows 'error'. **(c)** the project facet filtered with a stale or
  absent runId set while its resource resolved (unfiltered rows under an
  active chip on deep-link; project A's set applied while switching to B —
  Solid serves the previous value during a source-change refetch); the
  resource value now carries WHICH project it belongs to and the table
  reads as loading until it matches. Plus: a failed `/v1/flakiness` probe
  renders '—', never a confident green "0 flaky". **Verified through a real
  outage/recovery cycle** (Playwright: serve killed mid-poll, restarted on
  the same port): rows kept during the outage, count updates after
  recovery, zero uncaught errors — pre-fix the view froze forever.
  **Refuted by the review (sound):** live.ts timer lifecycle (no leak/
  double-arm/burst; refcounted visibilitychange), Shell LiveIndicator, the
  2s queue poll teardown, runTicks newest-LAST ordering, every tone
  threshold, invocationPassed consistency (core maps exitOk via Boolean).
  **Accepted residuals:** pass-rate "24h" computes over the most recent 200
  invocations (truncated on >200-run days); post-dispose setQueueJobs is a
  harmless signal write. Cloud 330 pass (+12), UI 40 pass, core 1224, lint
  clean.

- **2026-07-10**: **Adversarial review of the analytics wave — two
  repro-confirmed defects fixed, the rest verified sound** (two parallel
  hostile reviewers, repro-mandated, over the day's `getRegressions`/
  `getPeriodComparison` + serve routes + UI derivations; the 2026-07-07/09
  pattern). Both findings CONFIRMED by an executed reproduction. **(1)
  `periodStats` empty-window `null` (`3cbc2e5`):** the aggregate bare-`SUM()`d
  `failures`/`cacheHits`/`executed` but only `COALESCE`d `totalDurationMs` —
  SQLite `SUM()` over ZERO rows returns NULL, and the PREVIOUS window is empty
  for any workspace younger than the window (fresh serve, quiet prior week),
  so `/v1/analysis` shipped `previous.stats.failures = null` where
  `PeriodStats` declares `number` (contract break + a client `.toFixed()`
  throw). Fix: COALESCE all four; pinned by a current-only-window metrics
  test. **(2) Dead regression status dot (`3cbc2e5`):** the "Started failing
  across branches" card's `dots` column bound `_dirReg`, a field
  `regressionRows()` never produced (I described the derivation in-plan but
  omitted it from the Edit), so the dot was permanently faint grey — the
  red-regressed / amber-always-broken urgency cue was lost while the row's
  TEXT still read fine (why the first render-check missed it: it asserted text
  - zero errors, not the dot's COLOR). Fix: emit `_dirReg` (`'slower'`→red /
    `'gone'`→amber via the delta DotMap); browser-verified the two dot colors
    card-scoped. **Bundled:** the regressions latest-per-branch CTE gained a
    `run_id DESC` tiebreaker (a time-ordered UUIDv7) so equal-`started_at` ties
    are deterministic. **Refuted by repro (NOT actioned):** period-window
    overlap/gap/off-by-one (half-open `[from,to)` is clean), the ROW_NUMBER
    latest-per-branch dedup + since-recovered-branch + cache-hit-as-pass, every
    NULL-vs-non-null claim in `getRegressions` (`win.runs` is COUNT, the rest
    `?? 0`-guarded), mover `<minRuns` leakage + `deltaPct` div-by-zero +
    percentile index, and every UI tone/sign/pp derivation (failure-up→bad,
    hit-drop→warn, avg-slower→warn all correct) + `$state` binding + the commit
    facet's prefix match. **Accepted residual:** malformed numeric query params
    (`Number('abc')`→NaN) degrade to an empty response — a codebase-wide
    convention across every metrics route, harmless, unreachable from the
    dashboard. Core 1224 pass (+1), cloud 318 pass, UI 40 pass, lint clean.

- **2026-07-10**: **vx-cloud analytics wave — live dashboard, run filters +
  CI-health, cross-branch regression detection, and period-over-period
  analysis** (owner, four requests across the day: "Improve ui. More
  features" → "detect tasks that started failing across branches … see runs
  per commit branch or all" → "We need advanced analysis and over time
  comparisons"). A coherent analytics thread, all in `@vzn/vx-cloud`; core
  gained only two read-side metrics queries (no schema/CACHE/TELEMETRY bump —
  pure SQL over the existing `runs`/`invocations` tables). **(1) Live +
  filters + CI-health** (UI-only, `a4b3f08`/`dae2f98`/`0f76e18`): every view
  opts into a visibility-aware auto-refresh tick (`ui/src/live.ts`
  `useVisibilityRefresh`, paused while the tab is hidden — re-fetches sources
  on the SAME machinery as a connection switch, `res.latest` kept so a
  refetch never flashes the loading skeleton); the Runs view gained
  URL-persisted result/branch/project facets (`#/runs?result=failed&…`,
  shareable + restore-on-load, clearable chips) and a CI-health strip (last
  ~24 runs as status ticks + pass-rate/flaky/hit-rate/non-hermetic tiles).
  **(2) Cross-branch regressions** (`1329b63` core + this wave's UI):
  `getRegressions` (a task now failing on ≥ `minBranches` distinct branches
  that has a prior success — the "what just broke everywhere?" signal,
  distinct from flaky/nondeterministic; a `ROW_NUMBER() OVER (PARTITION BY
project,task,branch ORDER BY started_at DESC)` CTE takes the latest run per
  branch, so a since-recovered branch is not counted failing; a cache-hit
  counts as a current pass). `GET /v1/regressions?sinceDays=&minBranches=&limit=`;
  an Insights "Started failing across branches" card (red/amber
  regressed-vs-always-broken dot). **(3) Period-over-period analysis**
  (`42c5d8b` core + `94895bc` UI): `getPeriodComparison` splits runs into two
  adjacent equal-length windows (default 7d: this week vs last), aggregates
  each into `PeriodStats` (runs/failures/hits, avg/p50/p95 exec duration,
  failure + hit rates), and ranks `movers` — tasks whose avg executed
  duration shifted most, requiring ≥ `minRuns` (default 3) executions in BOTH
  windows so a mover is a trend not noise. `GET /v1/analysis?window=&minRuns=&limit=`;
  an Insights tile row ("this 7d vs prior 7d" with signed deltas tinted by
  direction) + a "Biggest movers" table (red/green delta dots). **(4) Runs
  per commit** (`95bd5f3`): a commit facet joins the Runs URL-persisted set
  (`#/runs?commit=…`, prefix match so a short SHA selects) — with the branch
  facet + "all", this covers "runs per commit/branch/all". **Derivation
  pattern:** the analytics data sources (`ui/jr/data.ts` `analysisData`/
  `regressionRows`) compute all display fields (signed deltas, per-tile
  tones, mover direction, branch lists) so the pure-JSON views bind plain
  state paths — conditions/formatters can't compute a signed tone. Every new
  metrics query is pinned by a `tests/metrics.test.ts` block AND the
  drift-guard `calls` map + the façade boundary snapshot; the UI filter/
  regression/period derivations are unit-pinned in `functions.test.ts`; the
  serve routes have standalone endpoint tests (`{analysis,regressions}-serve.test.ts`).
  **Browser-verified** (Playwright/chromium against a seeded serve): the
  Insights trending tiles + movers + "Started failing" cards render with
  correct deltas/regressions and ZERO real console errors; the Runs commit
  facet narrows the count and restores from the URL. Core 1223 pass (+9),
  cloud 316 pass (+2), UI 40 pass (+3), lint clean. Dist is a build artifact
  (gitignored, not committed — the 2026-07-05 decision). **UI gotcha logged:**
  `document.body.innerText` reflects CSS `text-transform: uppercase`, so a
  card-title assertion must be case-insensitive (the metric/card labels are
  uppercased in CSS).

- **2026-07-09**: **vx-cloud made ACTIONABLE — every surfaced problem now
  carries its concrete fix** (owner: "Work on better vx cloud"; the
  clearest expression of the standing "one-stop CI shop, butter, compete
  with GHA/Jenkins/Nx Cloud" vision — a CI PRODUCT tells you how to fix a
  problem, not just that it exists). Extends the pattern the hermeticity
  card already established (a rendered remediation hint) to flaky tasks +
  a per-task Recommendations card. **PURE UI** (`packages/cloud/ui`) — ZERO
  core (`src/`) and ZERO serve (`packages/cloud/src/`) change; every
  suggestion derives from data the dashboard already fetches
  (`/v1/flakiness`, `/v1/hermeticity`, the workspace catalog). **(A)
  Insights flaky card** gains a "Suggested fix" column: a CONFIRMED-flaky
  row shows `exec.retries: N` (`N = max(maxAttempts ?? 2, 2)`), inferred-
  only rows blank. **(B) Task-detail Recommendations card** aggregates
  every applicable fix for that task, each a rationale + copy-able snippet:
  flaky→`exec: { retries: N }` (catalog-aware REFINEMENT: if the resolved
  config already declares `retries >= N`, flip to "still flaky — the
  failure is nondeterministic, not transient; investigate / `vx run
--verify`", no snippet); non-hermetic (task in the divergent list)→names
  the platforms + rels and offers `cache.inputs.runtime: ['uname -sm']` or
  fix-the-bug; slow+uncached (catalog-gated: no `cache` block declared +
  p50 > ~1s)→"add a `cache` block so re-runs restore"; a positive "Looks
  healthy ✓" zero-state when none apply. A small declarative `RecList`
  catalog component renders each (icon + title + rationale + snippet).
  Snippets are schema-accurate. Derivations (`suggestedRetriesFor`,
  `withFlakyFix`, `computeRecommendations`) live in `jr/functions.ts`,
  pinned by 16 new unit assertions (retries math, already-declares
  refinement, per-signal + stacked + healthy). Browser-verified 6/6
  against a seeded fixture (flaky→retries snippet, already-retries
  refinement, non-hermetic split-key, slow-uncached add-caching, healthy
  zero-state, Insights column) with ZERO console errors. UI 25 pass, cloud
  299, core 1214, lint clean; dist rebuilt (not committed). Docs: dashboard
  guide synced. Commits `f903f8f`..`de04d1c`. **Not built (owner decision,
  unchanged):** run TRIGGERS (scheduled / on-push / webhook) — the
  cloud-data-model Phase 4, which reverses a standing non-goal; do not
  build unprompted.

- **2026-07-09**: **npm release pipeline hardened — the `sigstore`
  publish crash fixed + the 10-package publish made idempotent** (owner
  pasted a live release failure: `Cannot find module 'sigstore'` from
  `libnpmpublish/lib/provenance.js`). **Root cause (non-obvious):** the
  publish logic was fine — `npm install -g npm@latest` self-upgrading IN
  PLACE from node 22's OLD bundled npm 10.x leaves npm's own dependency
  tree incomplete, so when `libnpmpublish` auto-generates provenance
  (npm does this automatically in an OIDC trusted-publishing CI context,
  token OR OIDC), it can't `require('sigstore')` and dies on the first
  package. **Fix:** `node-version: 22 → 24` — Node 24's BUNDLED npm is
  already ≥ 11.5.1 (trusted-publishing capable), so no fragile in-place
  self-upgrade is needed; the upgrade step is now GUARDED (a `node -e`
  semver check) and self-upgrades ONLY on the unexpected chance the
  bundled npm is < 11.5.1 — avoiding the exact in-place upgrade that
  corrupted sigstore. **Made bulletproof (not just "should work"):** a HARD
  `require.resolve('sigstore', { paths: [<npm root>/npm] })` verify runs
  BEFORE the publish loop — if it can't load, a forced clean reinstall
  repairs it, and if it STILL can't, the job fails fast with a clear
  `::error::` instead of the cryptic mid-publish MODULE_NOT_FOUND. So the
  release either has a working provenance chain or stops loud + early,
  never crashes on package 1. **Bundled hardening:** the publish loop is now
  IDEMPOTENT — a 10-package sequential publish can fail partway (transient
  registry error, or the sigstore abort), and npm 403s on republishing an
  existing version, so a re-run used to abort on the first already-
  published package; each package is now skipped when `npm view
<name>@<version>` shows it already on the registry (name read from each
  dir's package.json — `dirFor` maps `@vzn/vx`→`vx`, `@vzn/vx-cloud`→
  `vx-cloud`, platform pkgs keep their full name), so a re-run COMPLETES
  the set. The platform-first ordering + idempotency compose (a skipped
  `@vzn/vx` still satisfies `@vzn/vx-cloud`'s same-version dep). release.yml
  was already sound (version stamp present, `dist/vx-*` catches both binary
  families). Verified: YAML valid across all four workflows, the semver
  guard correct at every boundary (11.5.0 upgrades, 11.5.1 uses-as-is,
  pre-release suffix handled), the idempotent loop simulated against a fake
  dist tree (already-published skipped, rest publish). **Needs a real CI
  re-run to confirm end-to-end** (the Actions runner env isn't reproducible
  locally); fallback if sigstore somehow persists on Node 24 is
  `--provenance=false` with the NPM_TOKEN path (loses the attestation).
  **Standing owner TODO unchanged:** a Trusted Publisher must be configured
  on npmjs.com for each of the TEN names, OR an `NPM_TOKEN` scope secret set
  (either auth path now works past the sigstore crash).

- **2026-07-09**: **Adversarial review of the day's three shipped features —
  two shipping-blocker bugs + a detection gap fixed, the rest verified sound**
  (three parallel repro-mandated hostile reviewers over the scheduler
  admission `aabb0f3`, the serve surfaces `7d23eca`+`e224ccb`, and the
  fingerprint core `fedfef0`; the 2026-07-07 pattern). Every finding
  CONFIRMED by an executed reproduction or downgraded. **Fixed (one commit):**
  (1) **CRITICAL — scheduler float-residue hang.** Reservation counters are
  FLOAT sums (fractional `cpus`, and percent-of-budget resolves to
  non-representable values — `resolveCpu('10%',3)===0.30000000000000004`), so
  add/release cycles leave ~2.8e-17 residue instead of exact 0. The
  solo-clamp gate was the knife-edge `reserved === 0`, so an over-budget task
  parked FOREVER (active→0, no future tick) — the run HANGS, or worse, exits 0
  silently WITHOUT running a requested task and prints no summary (CI reads
  green). A legal config triggers it; reproduced 3/3. Fix: integer HOLDER
  COUNTS per axis drive the solo-clamp ("axis idle" = `holders === 0`, exact),
  `reserved` SNAPS to exact 0 when an axis's holders hit 0 (kills cross-busy-
  period accumulation), and the within-budget compare gained a relative
  epsilon against exact-fill mis-rounding. (2) **CRITICAL — serve O(N²) DoS
  via `/v1/hermeticity`.** `FpStore.divergence()` nested a row-pair loop over
  ALL reports for a divergent hash (no early exit, no per-hash cap),
  synchronously — freezing the single-threaded serve (32.9s at 40k rows,
  clean quadratic), weaponizable from the LOWEST-privilege principal (an
  untrusted PR token POSTing attacker-chosen hash+trees; the Insights card
  auto-loads the route so other users trip it). Fix: bound the per-hash load
  (`FP_MAX_ROWS_PER_HASH = 64`, most-recent-first — totals stay exact via a
  separate COUNT) + `crossPlatform` early-exit. (3) **Serve ingest body-cap
  spoof.** `/v1/ingest`+`/v1/ingest/logs` capped on `content-length` ONLY, so
  a chunked body (no length) read 0 and bypassed the 32/16 MiB cap into a
  ~513 MiB buffer. Fix: re-check ACTUAL `Buffer.byteLength` after reading
  (mirrors the artifact PUT). (4) **MEDIUM — fingerprint zero-output blind
  spot.** A task that DECLARES outputs but produces zero files shipped NO
  fingerprint (gate keyed on resolved count) — exactly the platform-
  conditional-glob divergence Phase 4 exists to catch (platform A emits N,
  platform B's glob matches nothing → one report, no divergence row). Fix:
  gate the fp on the DECLARATION and ship the empty-tree sentinel; the
  determinism `no-outputs` verdict stays keyed on the resolved count
  (`verifyFp1.size === 0`) so `--verify` behavior is byte-identical. Bundled:
  crash-isolate the scheduler's `onStart`/`onFinish` observer hooks (a
  throwing logger must not wedge scheduling — the double-release path A#3 +
  the "observability never breaks a run" rule), the `--verify=fingerprint`
  status line names the cause on a 0-count (all-hit) run, artifact
  `subScopeOf` rejects `.`/`..`, and the fp-store prune's per-row byte
  accounting corrected (`+64`→`+256`, was undercounting the string columns
  and widening the ceiling). **Refuted by repro (NOT actioned):** the legacy
  scheduler path is byte-identical (300-trial/4015-assertion randomized
  differential vs `aabb0f3^`), park/repush FIFO + solo-clamp semantics +
  key-strip + frozen-lock validation all hold; the artifact trust-scope
  list⊆GET invariant holds across 29 principal/sub-scope combos incl.
  traversal, the provenance join is doubly-safe (parameterized + HASH_RE),
  no cross-workspace capability, zstd-magic can't be confused, server-side
  re-truncation defeats a hostile 10k-entry array, the sink budget doesn't
  mutate the shared summary; and the fingerprint core is sound on every
  Phase-1/2-class surface (raw-bytes truthfulness incl. the persistent
  cross-run memo trap, dir-order/unicode machine-independence, truncation
  honesty at entry #501, execute-once, attempt-1 attribution, strace-level
  zero-cost). **A#2 doc correction:** the design + this log claimed persistent
  reservations are "held for the task's lifetime" — the code releases them at
  READY (the SAFER behavior; lifetime-holding would deadlock a persistent-
  100% + downstream-100% graph). Corrected below + in the design doc. Tests:
  core 1198→1214 (+16), cloud 285→288 (+3); regressions pin the FP hang, the
  throwing-observer non-wedge, the DoS bound, the chunked-bypass 413, the
  zero-output empty-tree, and the `.`/`..` subscope. No bumps anywhere.

- **2026-07-08**: **Resource-aware scheduling: persistent reservations are
  released at READY, not held for the task's lifetime** (correction to the
  2026-07-08 entry below, surfaced by the 2026-07-09 adversarial review). The
  original entry + `docs/design/resource-scheduling-2026-07.md` claimed
  `persistent` + reservation is "HONORED for the task's whole lifetime." The
  implementation cannot: `executePersistentTask` resolves its outcome at
  READY, and the scheduler releases the reservation when that promise settles.
  This is the SAFER behavior — lifetime-holding would deadlock a persistent
  `cpus:'100%'` + a downstream `cpus:'100%'` forever (a permanently-held axis
  never goes idle for the solo-clamp). So a persistent task's reservation
  coordinates admission only UNTIL it signals ready; after that a heavy
  downstream task can co-schedule with the still-running server (advisory, not
  enforcement — consistent with the whole feature). No code change; the docs
  were wrong.

- **2026-07-09**: **`--verify` Phase 4 SHIPPED — cross-machine output-
  fingerprint diff + the cheap `--verify=fingerprint` mode** (the
  flagship's last open phase; design
  `docs/design/verify-cross-machine-2026-07.md`, architect-reviewed, four
  commits `fedfef0`..`58cc5ca`). Two machines reporting DIFFERENT output
  trees for the SAME cache key = a machine-dependent shared remote cache
  (first-writer-wins poisoning of the other platform) — the one failure
  class a single-machine re-run structurally cannot observe; a connected
  serve now names the exact task, key, platforms, and diverging rels.
  **Core:** `OutputFingerprint { tree, fileCount, files≤500, truncated }`
  declared structurally in `graph/scheduler.ts` (the VerifyVerdict
  pattern) on `TaskOutcome.outputFp` + additive-optional on
  `TaskTelemetry` (schema STAYS 2 — the attempts precedent); pure
  `foldFingerprint` in verify.ts (tree digest folds `key\0hash\n` over
  ALL sorted entries — \0 boundaries, the v18 lesson; per-file map is
  DETERMINISTIC truncation, sorted-first-500, so two machines' truncated
  maps stay comparable and detection NEVER depends on the map — the tree
  digest always ships). NEW `--verify=fingerprint`: fp computed in the
  save block at ~1× exec, NO 2× re-run — the mode that makes a
  per-platform per-merge matrix affordable (the architect's key insight:
  with a shared remote cache the second platform HITS — the poisoning
  scenario itself — so useful pairs require `--force` runs, which 2×
  determinism priced out). `--verify`/`=all` attach fp for FREE (fp1
  already exists there); `=inputs` stays fp-free; fingerprint-only hits
  get NO verdict; the no-write-policy guard + the distribution refusal
  both inherit. Wire: additive `fingerprint` on `RunRequest.verify`, no
  bump. The fp primitive is the BUG-1 raw-bytes xxh3 — which incidentally
  made it machine-independent (the memoized OID path would have been
  memo-poisonable AND platform-dependent). **Serve:** sidecar
  `fingerprints.db` per workspace (`fp-store.ts`, own `FP_SCHEMA_VERSION
1` gate — the LogStore pattern; a core-schema table would wipe every
  user's cache.db for a cloud-only feature). **PK `(hash, os, arch,
tree)`**: INSERT OR IGNORE = idempotent re-delivery, one row/platform
  forever for deterministic tasks, and same-platform two-tree rows
  accumulate — surfacing run-to-run nondeterminism WITHOUT the 2× re-run
  as a bonus signal. Platform identity = os+arch (the axis a shared cache
  spans); host is a debugging column, never identity. Extraction inside
  `IngestStore.ingest` after the idempotency gate; caps at every layer
  (500 files/task core, 4 MiB/run in `CloudIngestSink` — cloud-side so
  core stays stateless, serve re-truncation + 32 MiB ingest 413);
  90d/128 MiB pruning. `GET /v1/hermeticity?ws=` computes divergence at
  READ time (`HAVING COUNT(DISTINCT tree) > 1`), names rels via core's
  `diffOutputTrees` (façade export-only widening), flags `crossPlatform`
  vs same-platform + `changedComplete` honesty. **UI:** Insights
  Hermeticity card (zero-state, platform pair, rels in danger tone, task/
  run drill-downs, remediation hint). **Advisory by design** — the serve
  observes completed runs; no run-failing path, telemetry stays
  observe-only; remediation = fix the hermeticity bug OR legitimately
  split the key per platform via `cache.inputs.runtime: ['uname -sm']`.
  NO bumps anywhere: CACHE_VERSION, core SCHEMA, TELEMETRY_SCHEMA_VERSION
  (2), run wire, DIST_PROTOCOL all unchanged; plain-run byte-identity +
  key-stability pinned by tests. Tests: core 1198→1209, cloud 268→285;
  browser-verified 12/12 (crafted linux-x64 vs darwin-arm64 divergence
  renders `dist/app.js` with links; fp-free serve renders the green
  zero-state); real-CLI verified (`--force --verify=fingerprint` exit 0 +
  the fingerprinted-N-trees status line; plain run unchanged). Docs:
  cli.md flag + section with the CI matrix recipe, guides/ci.md,
  dashboard guide. **Bundled dogfooding fix:** `lint.oxlint`/`lint.oxfmt`
  cache inputs stopped at the project boundary while the commands scan
  the whole tree — a cloud-only change rode a stale lint hit; both tasks
  now declare `workspaceFiles: ['packages/*/src/**', 'packages/*/tests/**',
'scripts/**']` (the documented escape hatch; keys change → fresh gate
  run verified green, lock regenerated). With this, all four phases of
  provable cache correctness are shipped; the verify thread is CLOSED
  (remaining nice-to-haves live in the design docs' open questions:
  per-task `cache.verify` opt-out, an MCP hermeticity tool, retention
  tuning).

- **2026-07-08**: **Cloud data-model Phase 2 SHIPPED — entity-page IA +
  `/v1/artifacts` + Artifacts UI + Insights + `/cache/:hash` + `?task=`
  deep links** (completes `docs/design/cloud-data-model-2026-07.md` §4.2 +
  §8-10; six commits `7d23eca`..`db8ed10`). **Server half:**
  `GET /v1/artifacts?limit=` — the `/v8` store made visible.
  `ArtifactStore.list()` walks EXACTLY `readScopes()` (the same scope set
  `has()`/GET resolve against), so the list can never leak wider than a
  fetch could reach: trusted never lists untrusted, an untrusted principal
  lists its own per-PR sub-scope ∪ trusted, and a hash present in both
  scopes lists ONCE with GET-resolution priority (first-scope-wins dedupe).
  Rows carry size/mtime/tier + the `.duration` sidecar; provenance
  (`task: {project, task, runId}`) is a best-effort batched join
  (900-chunked IN-lists, `ORDER BY started_at DESC` + first-wins = most
  recent producer) against the workspace-resolved ingest db — absent for
  workspaces this serve never ingested. NOT workspace-gated (artifacts
  exist on remote serves; sits above the unknown-`?ws=` guard). **UI half
  (all in `packages/cloud/ui`, zero core change):** nav is the
  entity-ordered seven — **Runs · Workspace · Projects · Tasks · Cache ·
  Artifacts · Insights**; `/trends` + `/bottlenecks` DIE as routes
  (redirect to the NEW `/insights`, their views deleted and absorbed:
  trends charts, heatmap, flaky-with-Retried, hit-split, savings,
  time-burners, recent failures — every row links INTO its entity, failures
  deep-link `/runs/:id?task=…`; the prunable-entries table moved here
  rather than being orphaned); `/overview` became the **Workspace** page
  (catalog summary card with `lock`/`live` source badge + stale count,
  identity; analytics moved to Insights; the agent-pool card deliberately
  SKIPPED — §12 open question, needs a sessions-list registry read);
  Projects/Tasks are **catalog∪rollup joined** (never-run projects/tasks
  navigable; no catalog → rollups pass through by reference — the
  capabilities pattern); project detail gains resolved per-task config
  blocks, task detail gains the Config card (the `vx show` payload), a
  flaky badge ("CONFIRMED by within-run retries"), and `/cache/:hash` +
  run deep links; NEW `/artifacts` (hash/size/age/duration/tier/provenance
  links/download) + `/cache/:hash` entity page (producing/restoring runs +
  artifact download; entry FACTS honestly absent on ingest-only serves —
  the standing never-reads-cache.db decision); run detail gains project
  links, a selected-task artifact download, and `?task=` seeding
  (`jr/page.tsx` exposes decoded query params; the card already binds
  `/selectedTask`). ONE shared bearer-fetched `downloadArtifact()` helper
  serves TaskLogs + both new download sites; `fetchArtifacts()` treats an
  older serve's 404 as `null` → honest empty state. **Bonus fix:**
  `taskDetail.json` had always declared a `cacheKey` source that never
  existed in `SOURCES` (the "Cache key" card could never render) — wired to
  the existing `/v1/explain/:taskId`. Tests: +8 server (trust-scoped list
  matrix, dedupe, provenance join present/absent, bearer gate) + 9 join
  units + serve suites; cloud 268 pass, core 1198 pass, lint clean.
  **Browser-verified 47/47** (Playwright against a real 3-project fixture
  with a retry-confirmed flaky task + a `/v8`-stored artifact): nav, all
  three redirects, never-run catalog entries navigable, the flaky
  drill-down, `?task=` pre-opening with the failed log tail, artifact
  downloads from BOTH sites with bytes asserted, palette "Trends" landing
  on `/insights`, zero real console errors. Known accepted noise: 404
  probes for never-run tasks / silent-task logs (API design; SPA renders
  the empty states). Docs: dashboard guide nav synced; `GET /v1/artifacts`
  added to cli.md (it had shipped undocumented). **Phase 3 (optional,
  unbuilt):** disjoint-node-set concurrent runs; **Phase 4 = OWNER
  DECISION** (triggers/webhooks — reverses a standing non-goal; do not
  build unprompted).

- **2026-07-08**: **Resource-aware scheduling SHIPPED — `exec.resources:
{ cpus, memory }` 2-D admission on the two-tier scheduler** (owner: "tasks
  could reserve how many cpu units… Maybe in exec?" → "CPUs should be number
  or percentage same with memory" → "This should work as reserved. If 0 means
  run. By default" → "Resources object is good"; spec
  `docs/design/resource-scheduling-2026-07.md`, all three phases in one
  commit). A task declares CPU units (fractional, or `"<n>%"` of the CPU
  budget = the run's `concurrency`) and/or memory (bytes, `"512MB"`/`"2GB"`
  size strings, or `"<n>%"` of the memory budget = `os.totalmem()` unless
  `--memory <size>` overrides — the documented container caveat: cgroup
  limits don't show in totalmem()); the scheduler packs ready tasks so
  concurrent reservations never exceed either budget, layered ON the count
  limit. **Admission, not enforcement** — nothing is cgrouped/niced/killed.
  **Encoded rules:** zero-never-blocks (0/omitted = exempt from that axis —
  every current config schedules byte-identically, gated on ONE check: an
  empty cost map omits the scheduler fields entirely); backfill via
  park-within-tick (within one synchronous tick `reserved` only increases, so
  a non-fitting head parks for the tick's remainder and repushes with its
  ORIGINAL heap seq — FIFO-among-equals survives exactly, O(R log R));
  solo-clamp (an over-budget reservation admits alone when its axis is idle —
  no deadlock, an idle pool always admits); skip-safety (ONE shared `willSkip`
  predicate in both the parker and the dispatch loop — a doomed task skips
  free, never parks; the spec's named hang risk); restore-tier tasks cost
  ZERO by construction (a restore is a tar extract, and it must never park —
  no parkedRestore list exists). **Key strip:** the whole `resources` object
  is dropped from `hashTaskConfig` before stringify (`hashableConfig`, the
  grouped object makes it a one-key drop) — tuning a reservation NEVER busts
  a cache; a no-declaration config takes the fast path and stringifies
  byte-identically, so **no CACHE_VERSION bump** (a declaring config is by
  definition new). `timeout`/`retries` stay folded (distinct-by-design;
  retro-stripping = CACHE_VERSION bump, deliberately out of scope).
  **Boundary move:** `parseSize` relocated `cli/cache.ts` → `util/size.ts`
  (orchestrator can't import cli; cache.ts re-exports so callers unchanged).
  `ResourceCost`/`ZERO_COST` declared structurally in `graph/scheduler.ts`
  (graph can't import orchestrator — the VerifyVerdict pattern); the pure
  resolver (`orchestrator/resources.ts`: resolveCpu/resolveMem/
  resolveResourceCosts, empty-map-when-nothing-declares) runs ONCE in run.ts
  so the scheduler's inner loop is a plain Map.get. Loader validates form
  (unknown-key reject like sandbox; `"1.5GB"` rejected — parseSize is
  integer-only; percent regex; `persistent`+reservation allowed and honored
  for the task's lifetime). **Display (Phase 2):** `cpu budget N · mem budget
  X GB` on the footer `info` row, ONLY when a task opted in (RunContext
  gains optional cpuBudget/memBudget; Infinity mem = axis off = not shown).
  **Wire (Phase 3):** `RunRequest.memory` + both mappers — per-task
  reservations need no wire field (a delegated run re-resolves configs
  server-side, on the correct machine's RAM; explicit `--memory` wins
  end-to-end). ReadyHeap gained `push(id, seq?)` + `peekSeq()` (repush keeps
  the original seq). Tests +41 (core 1162→1198 + 5 in-suite): scheduler
  admission suite (concurrent-within-budget, serialize-over-budget, memory
  axis, combined-axes, backfill-around-parked-head, solo-clamp,
  zero-runs-beside-clamped-giant, skip-safety-while-budget-held,
  restore-reserves-0, FIFO-after-repush, empty-map-legacy-pin), resolver
  units, loader accept/reject matrix, --memory parse + wire round-trip,
  footer budget-line pins, e2e key-stability (add→tune→still cache-hit) +
  e2e serialization through a real run. Verified with the real CLI: two
  `cpus:'100%'` 300ms tasks ran serialized (617ms total) with the budget
  line rendered; the repo's own runs (nothing declared) show no budget text.
  Turbo/Nx have nothing comparable (flat count concurrency); Bazel local
  resources is the precedent. Docs: schema.md `resources` section, cli.md
  `--memory` row, help text. Core 1198 pass, cloud 250 pass, lint clean.

- **2026-07-08**: **`vx-cloud connect` is the ONLY client↔serve wiring — the
  local-serve auto-detect machinery DELETED** (owner-approved). REVERSES two
  2026-06-28 decisions: "cloud() auto-detects a local vx-cloud serve" and
  "per-user serve advertisement at `$XDG_RUNTIME_DIR/vx-cloud/serve.json`".
  `packages/cloud/src/serve-info.ts` (write/read + `pidAlive`) is GONE and so
  is every consumer path: serve.ts no longer writes/cleans serve.json; the
  `cloud()` connection ladder is now exactly **explicit URL/token (opts + env
  aliases) → active `vx-cloud connect` environment → decline** (the local
  rung, its self-pid guard, and the sink's advertised-socket dial all deleted
  — environments carry no socket, so the ingest POST is TCP-only; the `serve
--socket` LISTENER itself stays, `defaultServeSocketPath` moved into
  cli/serve.ts); `resolveBackend` dropped serve.json delegation discovery
  (and its now-unused `cwd` param — delegation = `connect --delegate` env or
  `VX_SERVICE_URL`); `env ls` lost the synthetic `(local)` row; `vx-cloud
agent`'s URL fallback swapped the advertisement for the connected
  environment (whose token rides only when the environment supplied the
  URL). WHY: one wiring story (local = `vx-cloud serve --ui` then ONE-TIME
  `vx-cloud connect http://localhost:4321` — the deterministic port is what
  makes that stable), and it kills three whole complexity classes:
  advertisement staleness (pid-guard/`pidAlive`/logout-cleared runtime dirs),
  the POST-to-self deadlock guard, and the `VX_CLOUD_SERVE_INFO` pinning
  ceremony EVERY serve-spawning test suite carried (13 files) so test serves
  wouldn't clobber the real per-user file. A serve merely RUNNING can no
  longer capture runs by existence — connecting is consent. Tests: −4
  advertisement pins (plugin auto-detect/stale, socket-dial push, dist
  stale-ad), +1 negative pin (a RUNNING unconnected local serve → telemetry
  AND backend decline); resolveBackend suite rewritten to explicit-URL
  delegation + fail-safe unreachable→local. `vx dev` untouched (its
  per-workspace hub socket is not the serve advertisement). Docs: dashboard
  guide quick start is the two-liner + connect; cli.md serve section swaps
  "Advertisement" for "Connecting" + the 3-rung ladder; distributed-ci drops
  the advertised-serve fallbacks. Design docs stay frozen historical records.
  Cloud 250 pass, core suite + lint green. No CACHE_VERSION/SCHEMA/wire bump
  — client-side wiring only.

- **2026-07-08**: **Cloud data-model Phase 1 — workspace catalog + serve-side
  run queue + ONE unified Runs view** (owner: "Redesign vx cloud around
  workspaces, projects, tasks, runs, cache but from DATA perspective… In runs
  I can navigate dig connect, even when I schedule from UI. And I want to
  trigger MULTIPLE. We should have ONE view for runs. Where I can spawn
  more."; design `docs/design/cloud-data-model-2026-07.md` §6-7, §11).
  **Server half:** core façade widened EXPORT-ONLY (`readLockfile` /
  `LOCKFILE_NAME` / `loadWorkspace` / `loadProjectConfig` /
  `listProjectMetas` — metrics' `listProjects` keeps the bare name — +
  types; boundary snapshot updated; zero behavior, zero hot-path cost).
  `packages/cloud/src/workspace-catalog.ts`: the "access the LOCK" ladder —
  lock-first (zero eval, the frozen configs a `--frozen` run sees) → live
  loader-chain fallback → 404; per-(mtime,size) memo so warm requests are
  stat-only; lock-staleness via the same xxh3 configHash `vx lock` wrote
  (`staleProjects`, never a silent lock/live mix). Three
  `GET /v1/workspace/{projects,projects/:name,tasks}` routes (bearer-gated,
  single-workspace by nature — `?ws=` ignored; derived `group`/`cacheable`/
  `persistent` computed serve-side) + `catalog: true` advertised on
  `/v1/meta`. `run-queue.ts` `RunQueue`: in-memory FIFO, ONE run executing
  at a time — "trigger MULTIPLE" = queue multiple; the solo submit starts
  synchronously (byte-equivalent to the old immediate path). Cloud-owned
  `queue:*` wire (`protocol-queue.ts`, `QUEUE_PROTOCOL_VERSION 1`, the
  `dist:*` precedent — core `protocol.ts` untouched) on the existing run WS:
  submit/cancel in, accepted/update/start/done/refused out; the submitting
  socket IS the stream, so the standard event/result wire follows per
  socket. `GET /v1/runs/queue` for the live section. **BEHAVIOR CHANGE,
  named:** plain `{t:'run'}` CLI delegation rides the SAME queue — two
  concurrent delegations used to execute CONCURRENTLY (racing on output
  cleaning, the pre-existing exposure the 2026-06-27 cockpit forbid never
  closed); they now serialize, and a non-immediate start streams one
  `run:status` "queued behind N run(s)" line the wire renderer already
  prints. Closing a QUEUED job's socket cancels it; a RUNNING job completes
  server-side (stop-watching semantics). `dist:submit` does NOT ride the
  queue (agents execute in their own checkouts — no serve-local output tree
  to race on). Killing a RUNNING run from the UI stays out (core has no
  abort handle). **UI half:** the `/run` cockpit DIES as a route (redirects
  to `/runs`; Home lands on `/runs` unconditionally; old bookmarks keep
  working). `RunConsole.tsx` deleted — its machinery extracted into
  `RunSession.tsx`: `createRunSession(tasks)` is the per-run state factory
  (statuses/timing/logs stores + the WireEvent reducer + the 250ms ticker)
  living OUTSIDE the component tree so events keep landing while a row is
  collapsed, and the `RunSession` component is the live layout (progress,
  graph/flame toggle, critical path + parallelism, per-task facts + logs)
  consuming RunGraph/Flamegraph strictly via existing props (both files
  untouched — they were being modified in parallel). `RunsView.tsx` is THE
  one Runs surface: spawn bar (datalist from `/v1/workspace/tasks` via the
  new `Capabilities.catalog` probe, history-derived fallback; disabled with
  an honest hint when the serve has no colocated workspace — history still
  renders), queued/live section (one WS per submitted job via api.ts
  `queueRun`; live positions, cancel-queued, the running job auto-expands
  inline into its RunSession; FOREIGN jobs — CLI delegations — polled from
  `/v1/runs/queue` at 2s as state-only `cli` rows), history table below
  (the jr `DataTable` consumed DIRECTLY in JSX through a tiny `jrCtx` props
  wrapper — the two-way-catalog path working as designed; the old separate
  "Compare to previous" table merged into a per-row `⇄ compare` link).
  Active jobs + sessions live at MODULE scope so route changes don't drop
  sockets (closing a queued job's socket cancels it server-side).
  `views/runs.json` deleted (+ its now-dead `invocationRows` helper and
  `invocationsAll` source); nav is Runs-first with the Run entry gone.
  api.ts: `fetchCatalogProjects`/`fetchCatalogProject`/`fetchCatalogTasks`,
  `Capabilities.catalog` (probed from `/v1/meta`), `fetchQueue` + `queueRun`.
  **Verified in a real browser** (Playwright/chromium against
  `vx-cloud serve --ui` on a temp fixture): spawn from the UI, a second
  submit holds at `queued · position 1` behind the running job, the running
  job expands inline (DAG + critical path), both complete and flow into the
  refetched history with compare links, `/` + `/run` redirect, a raw
  CLI-delegated WS run renders as a state-only `cli` row, the queue drains,
  ZERO console errors. Cloud 253 pass (queue unit + serve e2e + catalog
  suites landed with the server half), core 1162 pass, lint clean; dist
  rebuilt (build artifact, not committed). **Phase 2 SHIPPED same day** —
  see the entity-model entry above.

- **2026-07-07**: **Adversarial review of the session's nine commits — three
  `--verify` soundness holes fixed, Phase-2→Phase-3 consumer gap closed, debt
  swept** (owner: "review last opus commits make sure we are on track no tech
  debt"). A hostile-review agent verified every finding by repro; the perf work
  was CONFIRMED SOUND (ReadyHeap pinned byte-identical to the old sorted array
  by a 2000-trial randomized differential; topoOrder/affected/db.query
  equivalences checked). **The bugs (all verify-family edges, `a51a3c5`):**
  (1) FALSE `proven-deterministic` at equal size+mtime — `hashOutputTree` used
  `Cache.hashFile`, whose mtime+size memo returned attempt 1's digest for a
  re-run output with equal size/mtime (exactly what mtime-normalizing
  reproducible builds produce); fp1 primed the memo, fp2 read it back. Fix:
  fingerprint raw BYTES via plain xxh3 (fp1/fp2 only compare to each other —
  a proof must not trust a cache). (2) Verify re-run STRAYS survived — the
  post-verify restore never cleaned the declared globs, so a diverging output
  FILENAME left both attempts' files on disk (breaking "disk == cached artifact
  regardless of verdict") and unmarked in the gitFilesCache; now mirrors the
  restoreHit clean→restore→mark sequence exactly. (3) `--verify` + a no-write
  policy (`--no-cache`) silently verified NOTHING and exited green; run() now
  rejects the combination loudly (platform-honesty rule; `--force --verify`
  stays the re-verify-warm recipe). **Consumer gap (`6a942a6`):** Phase 3
  shipped before Phase 2, so `undeclared-inputs`/`proven-complete` never
  reached the consumers — an undeclared-inputs task that REDS the run exported
  an UNSET OTel span and a "✅ success" GHA row with NO Hermeticity line. Both
  consumers now handle them (span ERROR + `vx.task.verify.undeclared` paths
  attr; GHA inline flag + counted "unsafe"). Also: `--verify` now REFUSES
  distribution (falls back local — agents don't run the verify machinery),
  npm.yml header corrected (TEN trusted publishers, vx-cloud no longer
  described as Bun-source), both release workflows get `--concurrency 2` (8
  compiles OOM a 7 GB runner) + release timeout 25 min, the dead gitignored
  `ui/dist` input glob dropped from `build.cloud.*` (the UI cascade rides the
  `build.ui` dependsOn fold — input globs resolve against the GIT file set, so
  a gitignored path is always a dead glob), and the npm launcher's signal exit
  actually implements the 128+signo its comment promised. **NIT accepted, not
  actioned:** `.bun-build` in ALWAYS_IGNORE (04f9abc) took no CACHE_VERSION
  bump despite the v24 precedent — deliberate: the temp files are transient
  (never rest on disk), so no real key changes; worst case is an orphaned
  entry, not a wrong hit. Core 1162 pass, cloud 237 pass, otel 25 pass, lint
  clean.

- **2026-07-07**: **`@vzn/vx-cloud` publishes as a no-Bun standalone binary,
  like `@vzn/vx`** (owner: "Cloud should be published compiled like vx"). REVERSES
  the 2026-07-04 "vx-cloud is a Bun-source package requiring Bun" decision — the
  documented "NEXT high-value" item. The `vx-cloud` CLI now cross-compiles to one
  standalone binary per target (`bun build --compile packages/cloud/src/cli/bin.ts`)
  with **core (`@vzn/vx`) AND the dashboard embedded** (`with { type: 'file' }` +
  the bare `@vzn/vx` import bundles core via the link-self symlink) — verified: the
  compiled binary boots `serve --ui` and serves the SPA (`GET / → 200`) with no Bun.
  Same dual-purpose model as vx: the CLI is a Node **launcher** execing the
  matching `@vzn/vx-cloud-<target>` platform binary (optionalDeps, os/cpu-gated),
  while the **`cloud()` plugin stays importable source** (`@vzn/vx-cloud/plugin`,
  evaluated inside the vx runtime — the package still ships `src` + `ui/dist` +
  keeps `@vzn/vx` as a dep for the plugin path + the Bun source fallback). **ONE
  generalized launcher** (`scripts/npm-launcher.mjs`) now serves BOTH packages —
  it derives the platform-package prefix + binary name from its own `pkg.name`
  (`@vzn/vx` → `vx`, `@vzn/vx-cloud` → `vx-cloud`) and the source-fallback entry
  from a `vxSourceEntry` package.json field (`src/bin.ts` vs `src/cli/bin.ts`).
  `build-npm.ts`: extracted `emitPlatformPackages()` shared by both families;
  `buildCloudPackage` now emits the 4 `@vzn/vx-cloud-<target>` binary packages +
  the launcher-based main package (dropped `engines.bun`, added the launcher +
  optionalDeps + vxSourceEntry). `vx.config.ts`: added a `build.cloud` group + 4
  `build.cloud.<target>` cross-compiles (inputs = root `**/*` for core src PLUS
  `workspaceFiles: [packages/cloud/src/**, packages/cloud/ui/dist/index.html]`
  since the cloud package is a separate project outside the root boundary); `build`
  now fans out to BOTH `build.bun` + `build.cloud` (8 binaries/release). `npm.yml`:
  publishes the 4 new cloud platform packages before `@vzn/vx-cloud` (10 packages
  total). **Verified end-to-end** (linux-x64): built both binaries via the new
  config, assembled the tree, simulated the installed node_modules, ran
  `node launcher.mjs serve --ui` → execs the binary → serves the dashboard, no
  Bun. Docs: self-hosting.md + distributed-ci.md drop the "requires Bun" caveat
  (both CLIs are no-Bun binaries now). **Owner TODO:** trusted publishing now
  covers TEN names (was six) — the 4 `@vzn/vx-cloud-<target>` platform packages
  need seeding + trusted-publisher config too. **CI note:** 8 concurrent
  `--compile --minify --bytecode` may pressure a 7 GB runner; drop to
  `vx run build --concurrency 2` if it OOMs. No core/cloud src change — packaging
  - build config only.

- **2026-07-05**: **Quality sweep — perf O(n)→O(log n), +45 tests, doc-accuracy
  fixes** (owner: "identify places where we miss tests… ensure all cases 100%.
  Identify performance improvements, all O(n)… see if we can do O(1). Review
  docs… no limitations, no todo, all done"). Drove three parallel read-only
  audit agents (perf hot-paths, test-coverage gaps, doc staleness), then acted
  on the ranked findings in three focused commits. **(1) Perf** (`68f9bc6`, no
  behavior change, pinned by existing tests): scheduler ready-queue was two
  sorted arrays (binary-search `splice` insert + `shift` take, both O(R)) →
  O(R²) on a wide ready frontier (the 1000-pkg startup enqueue / a fan-out
  completion); replaced with a **binary max-heap** keyed by (priority DESC,
  enqueue-seq ASC) preserving the EXACT highest-first + FIFO-among-equals
  contract, O(log R) push/pop. `stable-keys.ts topoOrder` used `queue.shift()`
  (O(N²)) → head-pointer walk (O(N+E)), the last shift-based topo in core.
  `cache.ts loadOutputFilesBatch` (≤3×/warm-hit) re-compiled its SQL each call
  via `db.prepare` → `db.query` (caches by SQL text). `affected.ts
projectsContaining` scanned all projects per changed file (O(F·P)) → dir→name
  Map + bottom-up ancestor walk (deepest wins, same semantics, O(F·depth),
  independent of project count). Deliberately SKIPPED the task-hash
  workspaceFiles map-merge (#3) — cache-key-adjacent, memo staleness risk not
  worth a conditional path — and the cold cloud-dist/metrics/predict/filter
  items. **(2) Tests** (`7163db3`, +45, 1113→1158; tests-only + 2 pure helpers
  exported): closed 16 audited gaps in correctness/security-critical code that
  had NO direct test — `filterUpstreamHashes` (new upstream.test.ts: negation/
  ordering/dedup), `parseDependencySpec` throw branches, `computeGroupHash`,
  scheduler `priorities` override, `formatVerifySection` + the `rerun-failed`
  verdict, the remote-cache download-cap defenses (content-length + mid-stream
  `readBodyBounded` abort), `RemoteCache.has()` 503, `zstdContentSize` every
  FCS layout (the bomb oracle), `parseCachePolicy` empty-seg, `isOutputsCurrent`
  mode-mismatch, `parseRunArgs --retry/--timeout` errors + planning mutual-
  exclusion, `defaultAffectedBase` success branch, `transitiveDependents`
  cycle, persistent `forwardArgs`. Exported `readBodyBounded` + `zstdContentSize`
  (pure, security-critical parsers) so a unit test pins them with a tiny cap /
  crafted frames instead of a 512 MiB body — the only src change. **(3) Docs**
  (`ea7619f`): 7 stale "unimplemented/deferred" claims corrected to match
  shipped code — `vx stats` (ships as `vx info` alias), MCP-on-serve (`POST
/mcp` ships), watch config-reload ("(Future)" → shipped), HMAC signing (was
  listed open — shipped), and `globalInputs` reframed in 4 places from
  "deferred/stub" to the owner-REJECTED non-goal it is (TS presets +
  `cache.inputs.workspaceFiles` are the mechanism). The doc audit CONFIRMED the
  CAS-not-rewired + predictive-experimental + vx-cloud-not-on-npm notes are
  accurate (kept). Core 1158 pass, cloud 235 pass, lint clean.

- **2026-07-05**: **Provable cache correctness Phase 2 — `--verify=inputs` /
  `=all` (input-completeness via the sandbox)** (the flagship's second proof;
  the OS sandbox — bwrap+strace — is installed in CI and now this env, so it's
  e2e-verifiable). Determinism (Phase 1) proves outputs are reproducible; this
  proves the OTHER half of cache safety: the declared `cache.inputs` are the
  WHOLE workspace read set. `--verify=inputs` forces every executed cacheable
  task through vx's existing declared-input baseline sandbox (`baseAllowRead` =
  resolved inputs, `baseDenyRead = [workspaceRoot]`) regardless of whether the
  task declared `sandbox: {}`; a read of any undeclared WORKSPACE file is flagged
  `undeclared-inputs` (naming the path, workspace-relative, via the existing
  strace `openat` oracle) and the run FAILS. `--verify=all` runs both proofs,
  input-completeness FIRST (short-circuits the determinism re-run when inputs
  are already wrong). Reads OUTSIDE the workspace (CA certs, `~/.config`) aren't
  flagged — only undeclared reads inside it (the ones that can change a cached
  output). **Key mechanism decision** (`execute-task.ts`): a sandbox forced on
  ONLY by `--verify=inputs` surfaces its violations as the VERDICT (reds the run
  via the `ok` clause, like `nondeterministic`) — it does NOT flip the task's
  own exit code the way a USER-declared `sandbox: {}` violation does
  (`if (userSandbox && violations.length > 0 && code === 0) code = 1`), so the
  task isn't mislabeled failed and the retry loop doesn't pointlessly re-run.
  New verdicts on `VerifyVerdict`: `proven-complete` (inputs OK on an
  inputs-only run), `undeclared-inputs{paths}`. `run.ts` forces sandbox init
  when `verify.inputs` and errors CLEARLY when the sandbox is unavailable (never
  silently "passes" — the design's platform-honesty rule). Pure side-channel —
  NO cache-key/SCHEMA/CACHE_VERSION change (verify is `RunOptions` only). CLI:
  `--verify=inputs`/`=all` (previously rejected as "Phase 2"). **Tests:** parser
  coverage for ALL FOUR `--verify` forms + `--verify-allow` (a gap even for
  Phase 1 — there was zero parser test); pure `undeclaredInputPaths` unit tests
  (bracket extraction, dedup/sort, raw-line fallback); 4 sandbox-gated e2e
  (`describe.skipIf(!probeSandbox().available)` — proven-complete, undeclared-
  inputs names the path + fails run, hit→not-verified, `=all` short-circuit).
  Core 1113 pass, cloud 235 pass, lint clean. Verified with the real CLI
  (clean→proven-complete exit 0; leaky→undeclared-inputs names
  `packages/leaky/secret.txt` exit 1). Docs: cli.md (`--verify=inputs` section +
  flag row), CI guide, comparison.md (both proofs). **STILL-OPEN (Phase 4):**
  cross-machine fingerprint diff (ship Phase-1 `fp1` over telemetry, serve diffs
  by cache key across arches). Deferred Phase-2 extras: per-task `cache.verify?:
boolean` opt-out (+ hash-stripping) and `cache.verify.ignore` globs — the
  run-level `--verify-allow` covers the escape-hatch need today.

- **2026-07-05**: **Provable cache correctness Phase 3 (observability half) —
  the `--verify` verdict rides telemetry, OTel spans, + the GHA job summary**
  (continuing the flagship; the terminal-only verdict now reaches every
  observability surface). Three additive slices, NO schema/CACHE_VERSION bump.
  **(1) Core telemetry contract:** `TaskTelemetry` gains an additive-optional
  `verify?: VerifyVerdict`, projected from the outcome in BOTH the streaming
  `task.end` record (`telemetry.ts`) and the per-run summary's `tasks[]`
  (`run.ts`) — modeled EXACTLY on the `attempts` flaky field: absent for a
  non-verify run, so a v2 consumer is byte-unaffected and
  `TELEMETRY_SCHEMA_VERSION` stays 2. `VerifyVerdict` re-exported from the
  façade (`src/index.ts`) since it's now part of the public `RunSummaryRecord`
  shape. **(2) `@vzn/vx-otel` (first consumer):** a `vx.task.verify` span
  attribute carries the verdict kind; a `nondeterministic`/`allowed` verdict
  lists the diverging paths in `vx.task.verify.changed`; a
  `nondeterministic`/`rerun-failed` verdict maps the span to status ERROR
  (`taskStatusCode` now takes the whole `TaskTelemetry`, not just status) — so
  a task that exited 0 but poisons the cache surfaces as a FAILED span in
  Grafana/Honeycomb/Datadog. Bundled the pre-existing gap: `vx.task.attempts`
  (the retry count never reached the exporter). **(3) GitHub Actions job
  summary** (`packages/cloud/src/github-summary.ts`, pure glue over the
  RunSummaryRecord — no persistence, no serve needed, mirrors the flaky
  treatment): the head gains a `🔒 Hermeticity: N proven · M non-deterministic`
  line (⚠️ icon when M>0), and each non-hermetic task is flagged inline in its
  status cell with the diverging outputs (truncated `+N more`). Silent for
  hits / no-outputs / non-verify runs. **Tests:** telemetry projection pin
  (verify on task.end, absent without --verify), vx-otel (verdict attrs +
  changed + span-ERROR + attempts, +2), github-summary (hermeticity line +
  inline marker + truncation + no-verify-no-line, +3). Core 1088 pass, otel
  24 pass, cloud 235 pass, lint clean. Docs: cli.md anchor referenced from a
  new guides/ci.md "Proving cache correctness" section (the `--force --verify`
  nightly/merge-queue recipe). **STILL-OPEN (design Phase 2 + 4):** input-
  completeness via the sandbox (`--verify=inputs`/`=all`) — blocked from e2e
  here (bwrap/socat not installed in this env); cross-machine fingerprint
  diff. Persisting the verdict in the cloud runs table for a historical
  dashboard "Hermeticity" card is a deferred SCHEMA-bump follow-up (the
  streaming surfaces above cover the actionable CI/observability paths today).

- **2026-07-05**: **Provable cache correctness — `vx run --verify`
  (Phase 1: determinism)** (owner: "I don't wanna copy competitors… what's
  missing but is unlocked by vx architecture? build things on top add even
  more to be ahead"). The flagship differentiator: vx is the only runner
  that PROVES a cache entry safe instead of hoping. Design in
  `docs/design/cache-correctness-2026-07.md` (two proofs: determinism +
  input-completeness — the principled, EXPLICIT inverse of the
  owner-rejected auto-input inference; vx never guesses inputs, it proves
  the declared ones are complete/reproducible and fails loud with the exact
  paths). **Phase 1 shipped:** after an executed cacheable task saves
  attempt 1, `--verify` re-runs it and content-compares outputs (git-blob
  OID per file via the existing `Cache.hashFile` — mtime-independent; NOT
  the artifact bytes, which embed tar mtimes, and NOT `output_files` rows,
  which store only size+mode+mtime). Same bytes ⇒ `proven-deterministic`;
  divergent ⇒ `nondeterministic` naming the changed rels + the run FAILS.
  **Verdicts** (`VerifyVerdict` union, structurally on `TaskOutcome.verify`
  in `graph/scheduler.ts` since graph can't import orchestrator):
  proven-deterministic / nondeterministic(changed) /
  allowed-nondeterministic(changed) / rerun-failed(exitCode) / no-outputs /
  not-verified (cache hit). **Zero-cost & key-stable:** a pure `RunOptions`
  side-channel, NEVER folded into a cache key — a `--verify` run cache-HITS
  a plain run's entry (pinned), so no CACHE_VERSION/SCHEMA bump; a plain run
  attaches no verdict (byte-identical hot path). Only executed + cacheable +
  output-declaring tasks verify (`no-outputs` when none declared, hit ⇒
  `not-verified`). Pair with `--force` to re-execute + verify a warm graph.
  **Mechanism** (`orchestrator/execute-task.ts`): extracted `runAttempt()`
  (function decl) shared by the retry loop AND the verify re-run so they
  can't drift; snapshot `violations` into `finalViolations` BEFORE the
  re-run clobbers it; after the compare, `cache.restoreOutputs` puts attempt
  1's saved bytes back so the on-disk tree ends bit-identical to the cached
  artifact. New `orchestrator/verify.ts` (pure: `outputRefs` keys project
  outputs by rel-to-projectDir + ws outputs by `workspace-outputs/<rel>`;
  `hashOutputTree`; `diffOutputTrees`; `classifyDeterminism`;
  `formatVerifySection`). CLI: `--verify` / `--verify=determinism`
  (`inputs`/`all` rejected as "not available yet — Phase 2"), `--verify-allow
=<pkg#task,…>` (exempts known-nondeterministic → `allowed-nondeterministic`,
  stays green). Wire: `RunRequest.verify` (Set↔array in both mappers). `run.ts`:
  extends the `ok` predicate (nondeterministic/rerun-failed ⇒ not ok), prints
  the Verify summary section via `log.status`. Cost ≈ 2× exec for verified
  tasks — a CI/pre-merge gate, not an every-run default. 7 tests in
  `tests/verify.test.ts` (proven, nondeterministic-names-path-fails-run,
  no-outputs, --verify-allow greens, hit→not-verified + key-stability pin,
  --force verifies warm, plain-run→undefined). Core 1087 pass, cloud 232
  pass, lint clean. Docs: cli.md (`--verify` flag rows + § "Provable cache
  correctness"), comparison.md (LEADS "Where vx is ahead"). **NEXT
  (design Phases 2-4):** input-completeness via the sandbox
  (`--verify=inputs`/`=all` — the `runSandboxed` allowRead=declared-inputs +
  strace/violation-store undeclared-read oracle already exists), a
  dashboard "Hermeticity" card + telemetry field, cross-machine fingerprint
  diff.

- **2026-07-05**: **`--cache-dir <path>` CLI flag + `--continue` doc
  correction** (backlog closeout from `docs/comparison.md`). Two small
  comparison.md gaps closed. **(1) `--cache-dir`:** the workspace
  `defineWorkspace({ cacheDir })` field already redirected the cache; added
  the matching per-run CLI flag. `RunOptions.cacheDir` → `prepare.ts`
  resolves it (`path.resolve(cwd, cacheDir)`) OVER `resolveCacheDir`, so it
  beats the workspace field + the `.vx/cache` default. Per-run knob, NEVER
  folded into a cache key (like `--timeout`/`--retry`); `RunRequest.cacheDir`
  on both wire mappers; parser guards no `--cache=<spec>` collision (char 7
  differs). Tests: parser (space/= forms, no collision, missing-value) + e2e
  (cache lands in the override dir not `.vx/cache`, hits from there, a
  no-override run misses). **(2) `--continue=<mode>` was mislisted as an open
  gap** — it's been fully wired for a while (CLI parse → scheduler
  never/deps-ok/always enforcement → wire → tests → cli.md). Marked shipped
  in comparison.md (gaps list + the CLI-flag-map row now spells the three
  modes) and dropped from the CLAUDE.md backlog. Core 1097 pass, cloud 232
  pass, lint clean.

- **2026-07-05**: **Docs Mermaid diagrams fixed — three independent root
  causes** (owner: "Diagrams in docs are broken"). Every diagram page
  rendered Mermaid's "Syntax error" bomb. Diagnosed by driving the built site
  in a headless browser (Chromium at `/opt/pw-browsers`, playwright at
  `/opt/node22/...`) + parsing each source with Mermaid's own UMD build to get
  the exact grammar error. **(1) `Head.astro` re-render corruption:**
  `renderMermaid` reset each block with `el.innerHTML = source`, which
  re-parsed a `<br/>` in a label into a real `<br>` DOM element — mangling the
  definition Mermaid reads. Switched to `el.textContent = source` so `<br/>`
  stays literal (Mermaid renders it as a line break). This alone fixed the
  flowcharts + state diagrams. **(2) reserved-word node id:**
  `architecture.md` used `graph` as a flowchart NODE ID (`index --> graph`) —
  `graph` is a reserved keyword, Mermaid 11 errors "got 'GRAPH'". Renamed to
  `graphmod["graph"]` (safe id, same label). **(3) semicolon in sequence
  text:** `flows.md` sequence diagrams put `;` in `Note`/message text —
  Mermaid treats `;` as a STATEMENT SEPARATOR, so the note split and the
  parser errored at the next token. Isolated by a parametric parse (`;` fails;
  `<br/>`, `,`, messages all fine). Replaced the three `;` with an em dash /
  removed it. **Gotchas for future diagrams:** never use `graph`/`end`/
  `subgraph`/`class`/`state` as a flowchart node id; never put `;` in
  sequenceDiagram note/message text; `<br/>` in labels is fine as long as the
  render path feeds Mermaid textContent, not innerHTML. Browser-verified: all
  4 diagram pages render 15/15 diagrams, 0 errors. Source-only fix
  (`apps/docs/src/components/Head.astro`, `docs/{architecture,flows}.md`); the
  Pages deploy rebuilds (dist + generated content are gitignored).

- **2026-07-05**: **Dashboard SPA dist is a BUILD ARTIFACT, not committed;
  no doc asks an external user to clone the internal repo** (owner: "make the
  spa not committable … dist should be built during vx cloud build and
  bundled into its package/bin not committed to repo. … do not ask user to
  clone the repo in the docs. Repo is internal"). REVERSES the 2026-06-28
  "commit `packages/cloud/ui/dist/index.html`" decision (which existed so a
  fresh checkout could compile the binary without a SPA build). **(1) dist
  un-committed**: gitignored plus `git rm --cached`; every consumer now builds
  it first — the npm package (`build-npm.ts buildCloudPackage` runs the vite
  build before copying `ui/dist`), the Docker image (a vite-build step before
  the `bun build --compile` that embeds it), and locally `vx run build.ui` (the
  `build.bun.*` tasks already depend on it). The runtime already degraded
  gracefully: `loadUiHtmlPath` try/catches the dynamic `ui-asset` import and
  returns null (API-only serve) when the dist is absent, so from-source dev is
  unaffected. NO runtime UI build anywhere — the serve `GET /` test verifies
  the SPA-routing contract against a tiny fixture HTML (not the real dist), so
  it stays hermetic without building. **Verified end-to-end**: fresh tree (no
  dist) then build SPA then
  `bun build --compile` of the cloud bin then the compiled binary serves the
  embedded dashboard plus `/health`. Cloud 232 pass, lint clean.
  `.dockerignore` no longer whitelists `ui/dist` (built in-image, not copied
  from context). **(2) no clone in docs**: both CLIs publish to npm now, so the
  distributed-CI recipes and the `vx-agent` composite action install via
  `npm i -g @vzn/vx` and `npm i -g @vzn/vx-cloud` (Bun-source, needs setup-bun)
  instead of cloning the repo at a pinned ref plus a bun PATH shim; the
  action's `ref` input (git ref) became `version` (npm dist-tag). The README
  `## Development` clone stays (a contributor path for people with repo access,
  not a user install step).

- **2026-07-05**: **Task timeout defaults — per-task > env > workspace
  precedence** (owner: "per task timeout and workspace timeout and global
  timeout … Per task always precedence then env var then workspace var").
  `exec.timeout` already bounded a single task; added the two run-level
  FALLBACKS for tasks that declare none. Resolution, highest first:
  per-task `exec.timeout` → `--timeout <ms>` / `RunOptions.timeout` →
  `VX_TASK_TIMEOUT` env → workspace `timeout` (`defineWorkspace`). Modeled
  EXACTLY on the `--retry`/`RunOptions.retries` run-level-default precedent:
  `execute-task` resolves `step.timeout ?? args.timeout`; `run.ts` collapses
  env+workspace+option into the single run-level default it threads
  (`taskTimeoutDefault = options.timeout ?? readTaskTimeoutEnv() ??
  workspaceConfig?.timeout`); a malformed `VX_TASK_TIMEOUT` is IGNORED
  (parsed to undefined) so a typo never silently disables a task's own
  limit. **Threaded as an option only — NEVER folded into a cache key** (a
  timed-out task fails and is never cached), so a `--timeout` run cache-hits
  a plain run's entry (pinned by a key-stability test, same as `--retry`).
  Wire: `RunRequest.timeout` in both protocol mappers, so a delegated run
  carries the default (the serve re-resolves its own env+workspace).
  `--timeout` works for `vx watch` too via the shared resolver (a runaway
  task in a watch loop should be bounded). Loader validates `WorkspaceConfig.
timeout` (positive integer ms, mirrors `concurrency`). NO CACHE_VERSION/
  SCHEMA bump. Files: `config.ts` (WorkspaceConfig.timeout), `project-loader.ts`
  (validation), `orchestrator/{options,execute-task,run,protocol}.ts`,
  `cli/{run,help}.ts`. 15 tests in `tests/task-timeout.test.ts` (precedence
  across all four levels, per-task-always-wins BOTH directions, malformed-env
  fallthrough, key stability, `--timeout` parsing + validation, wire
  round-trip, loader validation). Core 1078 pass, cloud 232 pass, lint clean.
  Docs: schema.md (exec.timeout precedence note + WorkspaceConfig.timeout +
  error row), cli.md (`--timeout` flag row).

- **2026-07-05**: **Flaky detection CONFIRMED from within-run retries, not
  just cross-run inference** (road-to-best-CI #5; continuing the retries →
  flaky thread). `getFlakiestTasks` inferred flakiness from cross-run failure
  VARIANCE — it couldn't tell a nondeterministic task from one a later real
  fix greened. A task that FAILED then PASSED within a SINGLE run (identical
  inputs, same commit) is nondeterministic BY DEFINITION — the gold-standard
  signal, and vx gets it FREE from the retry it already ran (Nx Cloud needs
  paid re-runs to observe it). Persisted `attempts` into the `runs` table
  (**SCHEMA v23**, nullable, analytics-only — the cache KEY is unchanged, NO
  CACHE_VERSION bump; threaded through `RunRecord`/`bindRun`/the insert + the
  cloud IngestStore's RunRecord mapping from the pushed summary). `getFlakiest
Tasks` now CONFIRMS directly: a within-run retry surfaces the task even with
  fewer than 3 runs and OUTRANKS every merely-inferred one (`flakyConfirmed`
  / `withinRunRetries` / `maxAttempts` on `FlakyTask`; the rank score puts a
  confirmed flake above any inferred one, then breaks ties by failure rate
  then duration tail). Dashboard: a 'Retried' column (danger tone on a
  non-zero count) on the Flaky tasks card, rebuilt dist. Prereq shipped same
  day: the `attempts` telemetry field (below). Core 190 pass, cloud 232 pass.

- **2026-07-05**: **Retried-then-passed tasks flagged flaky in the GHA job
  summary + the day's red lint gate greened** (road-to-best-CI #4/#5
  completion; continuing the non-stop loop). **(1) `attempts` telemetry
  field.** A task that only goes green after a retry is flaky BY
  DEFINITION, and `TaskOutcome.attempts` already carried the count (set
  only when >1, from the 2026-07-04 retries work) but it dead-ended at the
  outcome — never reached telemetry. Added `attempts?: number` to the
  `TaskTelemetry` contract (`src/orchestrator/telemetry.ts`) and projected
  it from the outcome in BOTH the streaming `task.end` record and the
  per-run `RunSummaryRecord.tasks[]` (`run.ts` summary construction).
  **ADDITIVE — no `TELEMETRY_SCHEMA_VERSION` bump** (stays 2): the field is
  absent for a once-run task, so a v2 consumer that ignores it is
  byte-unaffected (the same additive-optional rule the retries work used
  for `ExecConfig.retries`). Small, justified deviation from the
  zero-core-change streak — pure observe-only telemetry data, no scheduling/
  cache path touched; pinned by a core test driving a real retried run
  through a `telemetrySinks` hook and asserting `attempts: 2` lands in the
  summary. **(2) GHA flaky flag.** `packages/cloud/src/github-summary.ts`
  `statusCell` now renders a retried-then-succeeded task as `✅ success ⚠️
  flaky (N attempts)` — the most actionable place, right on the failed
  build's job page. A single-attempt success is never flagged. **(3) Greened
  the lint gate** — the day's github-summary + task-logs commits had left
  tsgolint (real type checking) RED with 10 errors that `bun test` (transpile-
  only, no checking) never surfaced: `CloudIngestSink`'s options assigned
  `string | undefined` into `exactOptionalPropertyTypes` exact-optional
  fields (build the optional props via conditional spread + guard the
  constructor assignments), and two serve/summary test fixtures carried an
  invalid `RunContextRecord` (`flow: 'full'` isn't a flow; `os`/`arch` are
  non-null `string`) plus an `unknown`-typed `res.json()` access. **Lesson
  logged:** `bun test` passing is NOT the gate — `bun src/bin.ts run
lint.oxlint` (oxlint + tsgolint) type-checks `packages/cloud` too and MUST
  be run before push; the earlier commits skipped it. Core 1061 pass, cloud
  232 pass, lint+oxfmt clean. NEXT on the road-to-best-CI: flaky
  detection → auto-retry SUGGESTIONS surfaced in the dashboard (the
  `getFlakiest`/`failureMode` surface + this new `attempts` signal are both
  live now), then per-request cache policy to remote agents (§13 known-open).

- **2026-07-04**: **Duration-aware dispatch — start the longest task first
  (LPT)** (road-to-best-CI #5). The `DistScheduler` ready queue was FIFO; now
  `nextReady()` returns the historically LONGEST ready task (longest-
  processing-time makespan heuristic, the same Nx Agents uses) so a long pole
  starts as early as possible. **Hint source = THIS serve's ingest history**
  (mean executed-run ms per `project#task`, one grouped `AVG(duration_ms)` scan
  in `taskDurationHints`), NOT the submitter — correct for CI, where the
  submitter is an ephemeral empty runner with no local history.
  `DistSchedulerArgs` gains an optional `durationHints: ReadonlyMap<string,
number>`; serve.ts builds it at `dist:submit`. **No wire change**
  (serve-computed), no core change, no protocol bump. **Byte-identical
  fallback:** no hints (fresh workspace) or all-equal → `nextReady` returns the
  queue head exactly as before (strict `>` keeps queue order on ties); the
  existing single-submission dispatch tests stay green unchanged. Pinned by two
  new tests (LPT reorders longest-first; an empty map stays FIFO). Cloud suite
  231 pass. NEXT: flaky detection surface + optional auto-retry; the
  PR-check-via-API half of #3.

- **2026-07-04**: **GitHub Actions job summary — a per-task result table on the
  job page** (road-to-best-CI #3, first half). A `vx run` inside GitHub Actions
  appends a markdown result table (failures first, with exit codes; cache
  provenance; verdict + stats line) to `$GITHUB_STEP_SUMMARY`, so a red build
  says WHICH task failed on the job page — no log spelunking. **Pure cloud
  glue, zero core change:** `github-summary.ts` `formatGithubSummary(summary)`
  is a self-contained formatter over the `RunSummaryRecord` the telemetry sink
  already holds (NOT core's `formatRunReportMarkdown`, which takes a different
  `RunResult` shape and isn't on the façade — a small cloud-side formatter is
  cleaner than converting). **Works with no serve connected:** the `cloud()`
  telemetry capability now activates when EITHER a connection resolves OR
  `GITHUB_STEP_SUMMARY` is set; the `CloudIngestSink` took an
  options-object constructor with an OPTIONAL `connection` (undefined →
  GHA-summary-only, skips the POSTs; log capture stays off without a serve to
  ship to). A plain local run with neither still declines (zero-cost contract
  held, pinned). Never-fail (write error swallowed + warned), bounded (table
  caps 100 rows + a truncation note). 10 new tests; cloud suite 229 pass.
  Docs: guides/ci.md "GitHub Actions job summary". **Second half still open:**
  a real PR _check_ via the GitHub Checks API (needs a token + checks:write —
  genuine service territory, deferred). NEXT: flaky detection→auto-retry (wire
  `getFlakiestTasks` + the shipped `TaskOutcome.attempts`), duration-aware
  dispatch ordering.

- **2026-07-04**: **Per-task logs + artifacts in the dashboard — road-to-best-CI
  #2 (Nx-Cloud parity: click a failed task, read its output)**. Design in
  `docs/design/task-logs-2026-07.md`; shipped in three committable slices, ALL
  in `@vzn/vx-cloud` — ZERO core change (the boundary check: `git status src/`
  stayed empty across all three). The 2026-06 opt-in `task.log` telemetry
  surface (built, never consumed until now) got its first consumer, so no
  TELEMETRY_SCHEMA/CACHE_VERSION bump. **(1/3) foundation:**
  `task-log-capture.ts` `TaskLogBuffer` (the shared bounded-tail primitive:
  per-task 128 KiB whole-chunk head eviction with no concatenation until drain,
  per-run 4 MiB budget where failed tails are NEVER evicted by successes,
  cache-hit/skipped/aborted dropped, drain orders failures first) +
  `log-store.ts` `LogStore` (a per-workspace `logs.db` sidecar with its OWN v1
  gate — never core's Cache schema; idempotent INSERT-OR-IGNORE, server-side
  re-truncation since the wire is never trusted for caps, zstd over 4 KiB, hash
  resolution for hits, age + byte-ceiling prune throttled 5 min). **(2/3)
  capture + API:** `CloudIngestSink` gains `wants ['task.log','task.end']` ONLY
  when logs enabled (`cloud({ logs })` / `VX_CLOUD_LOGS`; default on when
  connected) — off → `wants` stays `[]` so the source never projects
  task:stdout (the plain-run zero-projection guarantee, pinned); flush ships one
  `POST /v1/ingest/logs` after the summary (empty on an all-hit run). Serve:
  `POST /v1/ingest/logs` (bearer, 16 MiB cap → 413, wire-version gate → 400) +
  `GET /v1/runs/:id/logs/:taskId` (direct row → else cache-hit-by-hash with
  `source:'cache'`+`refRunId` → else 404; `artifactHash` advertised only when
  the requester's principal can fetch it from /v8). Delegated runs captured
  server-side by a per-run sink (no client push, swept after 15 min if a run
  crashes before its summary). **(3/3) UI:** a self-contained `TaskLogs`
  json-render component (own createResource keyed on runId+task, ANSI-stripped
  scrollback, truncation banner, cache-provenance link, bearer-fetched artifact
  download) in the run-detail selected-task card; rebuilt dist. Browser-verified
  end-to-end (SPA reaches the new endpoint 200, workspace-scoped, failed task's
  content present, no console errors beyond the pre-existing `/v1/graph`
  degradation). 36 new tests; cloud suite 221 pass. **Verified GAP surfaced &
  documented:** a distributed (`VX_CLOUD_DISTRIBUTE`) run ingests NO run summary
  anywhere today, so it's absent from run history entirely — that's the
  documented Phase-2 prerequisite for distributed-run log capture (the relay
  point already sees every chunk). Docs: dashboard.md (panel + bounded-storage/
  privacy section + the distributed limit), cli.md serve knobs. NEXT on the
  road-to-best-CI: PR/commit summary + checks (cloud glue over run-report.ts),
  then flaky detection → auto-retry (wire `getFlakiestTasks` + the new
  `TaskOutcome.attempts` onto the retries primitive), then duration-aware
  dispatch ordering.

- **2026-07-04**: **Task-level retries — `exec.retries` + `--retry <n>`**
  (road-to-best-CI #4; the primitive flaky-detection→auto-retry will ride).
  `ExecConfig.retries?: number` = max ADDITIONAL attempts after a failed
  attempt; follows the `exec.timeout` precedent exactly (config-declared →
  participates in resolved-config hashing naturally, distinct key by design;
  absent → byte-identical keys; NO CACHE_VERSION bump, no special hashing
  code). Loader rejects negative/non-integer and `retries`+`persistent`.
  **Semantics** (`execute-task.ts`, the miss path is now a retry loop):
  cleanOutputs re-runs before EVERY attempt (a failed attempt's partial
  outputs can't leak into the next); sandbox violations reset + re-fold per
  attempt; a TIMEOUT kill is a retryable failure but an ABORT
  (SIGINT/SIGTERM teardown, `!timedOut`) returns immediately — a tearing-down
  run never retries; between attempts one
  `vx: retrying <id> (attempt k/n) after exit <code>` line streams via
  taskStderr; the final outcome is the last attempt's, and `cache.save`
  captures the WINNING attempt's stdout + inputComponents only (pinned: a
  post-retry cache hit replays only the winning stdout).
  `TaskOutcome.attempts` set only when >1 (not persisted, not on the wire —
  telemetry-side flaky detection is the future consumer). **Run-level
  default:** `RunOptions.retries` + `--retry <n>` (also `vx watch` via the
  shared resolver); explicit config wins INCLUDING `retries: 0`; threaded as
  an option only, never folded into any hash — pinned by a key-stability test
  (a `--retry` run cache-hits a plain run's entry). Wire: `RunRequest.retries`
  in both protocol mappers. 12 new tests in `tests/retries.test.ts`; core
  1060 pass. Bundled cleanup: the long-dead `effectiveStderr` accumulation in
  execute-task (stderr hasn't been cached since v17) deleted. Docs: schema.md
  `retries` section, cli.md `--retry`. NEXT on this thread: wire
  `getFlakiestTasks` + `attempts` into flaky detection → auto-retry
  suggestions (dashboard), then duration-aware dispatch.

- **2026-07-04**: **Adversarial re-review of the day's shipped waves — the
  turnkey CI recipe's ambient-mode race fixed (+2 smaller fixes)** (owner:
  "review past commits… treat as hostile"). Full-pass review of every commit
  shipped earlier today. **(1) REAL BUG — `vx-distributed-ci.yml` used ambient
  distribution in a fan-out CI:** the run job did `vx-cloud connect
--distribute` + `vx run`, but ambient mode falls back to a SILENT LOCAL run
  when zero remote agents are registered at the instant of submit — and the
  agent matrix starts in PARALLEL with the run job, so whenever the submitter
  wins the setup race the "distributed" run executes locally while N paid
  agent jobs idle to their 15-min timeout. Fixed to EXPLICIT
  `VX_CLOUD_DISTRIBUTE=<agents>` (submits regardless; agents join mid-run;
  unreachable serve = hard error; no-agents = loud warning), which also
  DELETED the run job's entire vx-cloud source-install + connect dance —
  `VX_CLOUD_URL`/`TOKEN` env drive `resolveConnection` directly, so only agent
  jobs need the vx-cloud binary. Guide recipes (GitHub + GitLab) synced, with
  the ambient-vs-explicit rule documented: ambient = a developer's machine
  (never blocks solo), explicit = CI (the workflow provisioned the agents).
  Also corrected the recipe's "vx IS on npm" comment (first publish still
  pending the owner's trusted-publisher setup). **(2)** `dist/submit.ts`'s
  reachability + ambient-capacity probes used `AbortSignal.timeout` — the
  exact not-unref'd-timer pattern the repo banned (plugin.ts documents why);
  a warm ambient no-helpers run would hang up to ~1s at exit. Switched to the
  clearable-timer pattern. **(3)** `environments.json` accepted ANY number for
  `distribute` — a hand-edited `0`/`-1`/`NaN` passed validation and then
  ENABLED ambient (the rung checks `!== undefined && !== false`, not
  truthiness). Tightened to boolean | positive integer at the file boundary,
  pinned by test. **Reviewed and confirmed SOUND:** heartbeat/sweep lifecycle
  (armed on open, cleared on close/stop; serve timers unref'd + cleared on
  stop), the composite action (explicit shells, GITHUB_PATH semantics,
  `--idle-timeout 0` = never), npm.yml (publish order platform→vx→vx-cloud,
  stamp-before-build, dry-run guard on both triggers, paths match build-npm's
  `dirFor`), release.yml tag handling, and the trust scopes (tier is
  server-derived from the token; the client-supplied PR sub-scope only
  partitions WITHIN untrusted — a scope-claiming PR can touch same-tier peers
  only, never trusted; documented residual). Cloud suite 197 pass.

- **2026-07-04**: **Standing shared-pool multi-run scheduler — a session
  multiplexes CONCURRENT submissions across shared agents (DIST_PROTOCOL v1→v2)**
  (owner: "Make vx the best CI env ever that can run both locally and remote.
  Compete with GitHub Actions and Nx Cloud"). Architect design in
  `docs/design/ci-platform-2026-07.md` — two deliverables: **(1) competitive
  positioning** (the wedge = "vx is the portable execution+cache+pool LAYER you
  run _inside_ any CI provider, byte-identically on your laptop — NOT a CI
  platform"; vx should be invoked BY GHA/GitLab, never replace their
  triggers/hosted-runners/secrets/marketplace/DSL — permanent non-goals; a
  ranked road-to-best-CI table with the multi-run scheduler as #1 ship-now, then
  per-task logs, PR checks, retries, flaky→retry, duration-aware dispatch) and
  **(2) the #7 multi-run scheduler design**. **Shipped Phase 1, all in
  `@vzn/vx-cloud` (zero core change, correctness law §6.3 untouched, trust scopes
  untouched, no CACHE_VERSION/SCHEMA bump).** Removes the last §D#7 fence: the
  registry allowed ONE active submission per `{workspaceId, session}`
  (`SessionState.active: ActiveSubmission | null`, a concurrent second submit
  errored); now `active: Map<submissionId, ActiveSubmission>` + a `rotation`
  cursor. **Commit-routing model:** commit is a dispatch-ELIGIBILITY filter,
  never a refusal — the `hello()` commit-mismatch refusal + the `beginSubmission`
  mismatched-agent drop are GONE; a mismatched agent stays registered and simply
  ineligible (a submission whose commit no remote agent holds runs on its own
  self-agent = submitter-local, degrading toward local execution, never a wrong
  hit). **Self-agent ownership:** a `SUBMITTER_LABEL` self-agent is eligible only
  for the submission that owns it (new optional `AgentHello.ownerSubmissionId`),
  so a same-commit peer can't conscript your laptop. **Data model:**
  `RegisteredAgent.inFlight: Set<taskId>` → `Map<submissionId, Set<taskId>>`
  (capacity = `inFlightTotal < capacity`, so one agent holds slots for several
  submissions and death hands each submission back ONLY its own tasks);
  `ActiveSubmission` gains `submissionId`/`nextReady()`/`affinityAgents()`/
  `assign()`. **Fair dispatcher** `dispatchSession(state)`: hand each active
  submission at most one assignment per pass, rotate the start, loop until no
  progress = max-min fair share (a small run is never starved by a huge
  concurrent one; work-conserving). Dispatch is triggered by the scheduler's
  bookkeeping callbacks calling `binding.requestDispatch()` (`= dispatchSession`)
  — the registry no longer dispatches inline. **Drain safety (adversarial
  re-review fix):** `binding.drainIfLast()` drains ONLY this submission's
  ELIGIBLE agents and ONLY when it is the last active submission — one run's
  abort/orphan never kills another's shared agents, AND a self-agent-only run
  (a commit no helper holds) never drains a different-commit standing pool.
  The first cut drained ALL session agents, which would have let one stray
  orphaned feature-branch run kill a main-pinned standing pool; pinned by a
  drainIfLast unit test. The same re-review gated `hello()`'s onAgentJoin on
  the shared `eligible()` predicate (a self-agent join no longer notifies
  non-owner submissions) and replaced the agents-e2e blind 800ms
  hello-settling sleep with a deterministic poll of `/v1/agents` until the
  expected remote agents have registered.
  **DIST_PROTOCOL_VERSION 1→2** (`submissionId` added to `task:assign` +
  `agent:start/stdout/stderr/done` + `dist:submit`; optional `ownerSubmissionId`
  on `agent:hello`; envelope adapters + agent-loop threading updated); an old
  agent hitting a new serve is a clean `agent:refused` naming both versions.
  **`/v1/agents?commit=<sha>`** commit-scopes the ambient remote-capacity probe
  so a feature-branch dev against a `main`-pinned pool reads 0 helpers and stays
  a fast local run. **Single-submission stays byte-identical** — the fair loop
  degenerates to the old greedy dispatch (the one behavior change is
  intentional: a commit-mismatched agent is now ineligible rather than
  refused-and-dropped at pairing). **Files:** `protocol-dist.ts`,
  `dist/{registry,scheduler,submit,agent-loop}.ts`, `cli/serve.ts`. **Tests:**
  `dist-registry.test.ts` (eligibility-not-refusal, concurrent submissions,
  duplicate-submissionId guard, per-submission reassignment, commit-filtered
  capacity), `dist-scheduler.test.ts` (single-submission dispatch/prune/reassign
  kept byte-for-byte via a stub binding whose `requestDispatch` runs the exported
  `dispatchGreedy`), `wire-dist.test.ts` (v2 + `submissionId`/`ownerSubmissionId`
  round-trips), new `dist-multirun.test.ts` (3 adversarial cases through the REAL
  registry + REAL scheduler: same-commit fair sharing, no-remote-eligible → self-
  agent only + warning, shared-agent death re-queues only its owner-submission's
  tasks), `agents-e2e.test.ts` (a real serve + 2 agents + two concurrent
  submitter clones on one session both succeed, no "already active" error). Cloud
  suite 194 pass (+9), core 1048 pass, lint+oxfmt clean. **NEXT (road to
  best-CI):** per-task logs/artifacts in the dashboard (Nx-Cloud parity), PR
  summary + checks (cloud-side glue over `run-report.ts`), task-level retries,
  flaky detection→auto-retry.

- **2026-07-04**: **`@vzn/vx-cloud` publishes to npm — the turnkey CI recipe's
  source-clone collapses to `npm i -g @vzn/vx-cloud`** (continuing the non-stop
  loop; the follow-up #6 surfaced). Unlike `@vzn/vx` (a no-Bun standalone binary
  via per-platform optionalDeps), `@vzn/vx-cloud` publishes as a **Bun-source
  package**: its bin is the Bun-shebang `src/cli/bin.ts`, and `ui-asset.ts`
  embeds the dashboard via a relative `../../ui/dist/index.html` import, so `src`
  - `ui/dist` ship together. It **requires Bun** on the host (CI already provides
    it via setup-bun; the no-Bun serve path stays the ghcr Docker image) and
    depends on `@vzn/vx` at the SAME version so the plugin + CLI's bare `import
'@vzn/vx'` resolves without the dev workspace symlink. Its only external src
    import is `devframe`, which is **type-only** (erased) → no runtime dep beyond
    core. `scripts/build-npm.ts` gained `buildCloudPackage()` (copies src +
    ui/dist + LICENSE + a generated README, writes the package.json with
    `exports {., ./plugin}`, `bin`, `engines.bun`, `dependencies {@vzn/vx}`);
    `npm.yml` publishes it LAST (after `@vzn/vx`, which it depends on).
    **Verified locally:** generated the tree, simulated the installed
    node_modules, ran `bun …/vx-cloud/src/cli/bin.ts --help` (resolves `@vzn/vx`,
    prints help) and `import { cloud } from '@vzn/vx-cloud/plugin'` → `cloud()`
    returns the `vzn/cloud` plugin. **Owner TODO:** the trusted-publisher /
    scope-token now covers SIX names (`@vzn/vx` + 4 platform + `@vzn/vx-cloud`).
    The turnkey recipes keep the source-clone as the pre-first-publish default;
    once a release publishes `@vzn/vx-cloud`, the recipe step becomes
    `npm i -g @vzn/vx-cloud`. No core/cloud runtime change — packaging only.

- **2026-07-04**: **Universal agents Phase 2 — heartbeat liveness, ready-queue
  autoscaling signal, turnkey CI recipes, + a dedup simplification** (owner:
  "Work on all. Non stop. … review code and docs find simplification
  improvements and execute. Then repeat"). Four increments from
  `universal-agents-2026-07.md` §D, all in `@vzn/vx-cloud` (no core change):
  **(#4 heartbeat/liveness)** the registry detected agent death only on WS
  `close`, so a half-open TCP socket (crashed box / partition) stalled its
  in-flight tasks until the OS keep-alive timeout. Now each agent sends
  `agent:heartbeat` every 10s (`AGENT_HEARTBEAT_MS`); the registry tracks
  per-agent `lastSeenAt` (ANY message = liveness, so a busy-but-quiet agent is
  never reaped) and a 15s serve sweep reaps agents silent past 30s
  (`AGENT_STALE_MS`) via the existing idempotent `drop()` → `onAgentLeave`
  reassignment. `agent:heartbeat` is additive (no DIST_PROTOCOL_VERSION bump).
  **Version-skew:** RESOLVED same-day — the sweep only reaps agents with
  `sawHeartbeat === true`, so an OLD agent (predating heartbeats) is never
  falsely reaped for being idle; it's still cleaned up on WS close. A
  partitioned NEW agent heartbeated before it vanished, so it IS reaped. **(#5 ready-queue depth)** the scheduler already tracks a
  ready-but-unassigned queue; exposed `readyDepth()` through `ActiveSubmission`
  so `availableCapacity`/`GET /v1/agents` now report `ready` (non-zero only when
  agent capacity is saturated) — the signal an autoscaler scales UP on.
  **(simplification)** the identical cache-env wiring copy-pasted in
  `cli/agent.ts` + `dist/submit.ts` → one shared `wireAgentCacheEnv` in
  `dist/session.ts` (the design's §C.3 dedup made literal). **(#6 turnkey CI
  recipes)** a `.github/actions/vx-agent` composite action + a
  `vx-distributed-ci.yml` reusable workflow (`uses: vznjs/vx/.github/workflows/
vx-distributed-ci.yml@main`, inputs task/agents/capacity, secrets
  VX_CLOUD_URL/\_TOKEN; a plan→agents-matrix→run fan-out) + a "Turnkey setup"
  section in `guides/distributed-ci.md` (GitHub + GitLab). **Honest gap surfaced:
  `@vzn/vx-cloud` is NOT on npm** (npm.yml ships only `@vzn/vx` + its 4 platform
  binaries; the ghcr image is the SERVE only, no git, can't run an agent), so
  the recipes install the `vx-cloud` CLI from source (git clone at a pinned ref
  - bun + a PATH shim) and note it collapses to `npm i -g @vzn/vx-cloud` once
    published. **NEXT (high-value):** publish `@vzn/vx-cloud` to npm — extend
    build-npm.ts/npm.yml to cross-compile + ship `vx-cloud` standalone binaries
    the same optionalDeps way `vx` uses — which makes the turnkey recipe a genuine
    one-liner. **STILL-OPEN big item:** #7 standing shared-pool multi-run fair
    scheduler (the one-active-submission-per-session Tier-3 ceiling). Cloud suite
    184 pass (+3); docs build 145 pages, 0 broken links.

- **2026-07-04**: **Universal agents/pools — Phase 1: ambient distribution
  makes a connected pool a one-time `connect --distribute`, fails SAFE to
  local** (owner: "Make sure arch is flexible. Devs could spin up agents on
  live environments, and use them for local maybe? … flexible universal
  scalable. Easy to start for small and scale for big. Complete CI solution to
  monorepo"). Architect design in `docs/design/universal-agents-2026-07.md`
  (the universal pool model — serve/agent/submitter roles collapsing by scale;
  the easy-start→scale ladder Tier 0 solo → Tier 4 cloud burst; the streamlining
  - complete-CI gap analysis). **Key finding:** the universal primitive already
    exists — `runAgentLoop` is one loop hosted by both the `agent` verb and the
    submitter's self-registration; local/CI/cloud agents are the SAME binary,
    differing only in where they run + who owns lifecycle. What was missing:
    ambient enablement + fail-safe + a capacity gate. **Phase 1 (shipped, all in
    `@vzn/vx-cloud`, zero core change, no CACHE_VERSION/SCHEMA bump, correctness
    law untouched):** (1) `EnvironmentEntry.distribute?: number | boolean` mirrors
    `delegate` (additive-optional → no ENVIRONMENTS_VERSION bump); `--distribute` /
    `--distribute=<n>` on `vx-cloud connect`, shown in `env ls`. (2)
    `AgentRegistry.availableCapacity(ws, session)` counts total vs REMOTE (non-
    `SUBMITTER_LABEL`) agents/capacity; `SUBMITTER_LABEL` moved to registry.ts
    (re-exported from scheduler.ts) to avoid a cycle. (3) serve `GET /v1/agents?
ws=&session=` returns those counts (behind the bearer; the WS-upgrade path is
    unchanged) — the ambient capacity gate + a future autoscaler read the same
    data. (4) `distributedBackend` gains `mode: 'explicit' | 'ambient'`: explicit
    (`VX_CLOUD_DISTRIBUTE`, unchanged) hard-errors on an unreachable serve;
    ambient probes capacity BEFORE the graph prepare and degrades to a normal
    LOCAL run when the pool is unreachable (warns) OR has zero remote helpers
    (SILENT — the fast solo case). (5) `cloud().backend()` ambient rung: an
    environment connected with `distribute` returns the ambient backend; the env
    read is the SAME `activeEnvironment()` the delegate rung already does (and
    only when `cloud()` is declared), so **no environment connected → decline →
    core's `localBackend`, byte-identical fast path**. Net UX: `vx-cloud connect
<url> --distribute` ONCE, then `vx run` fans out across helper agents when
    present and stays a fast local run when not — `VX_CLOUD_DISTRIBUTE` demoted
    from required-per-run to an explicit escape hatch. **KNOWN-OPEN (design §D,
    NEXT):** agent heartbeat/liveness (half-open TCP agents stall until the OS
    timeout), the standing shared-pool multi-run fair scheduler (the
    one-active-submission-per-session rule is the Tier-3 ceiling; two different
    devs ambient-distributing the same repo share `{repoId, local}` and interfere
    — harmless to correctness), ready-queue-depth for autoscaling, turnkey CI
    composite action. **NON-GOALS:** intra-task sharding (task is the unit),
    mDNS discovery, managed fleet controller, input-shipping a dirty tree. Cloud
    suite 181 pass (+11), core gate green, lint+oxfmt clean.

- **2026-07-04**: **npm distribution — `@vzn/vx` publishes the standalone
  binary via per-platform optionalDependencies (esbuild model)** (owner:
  "prepare publishing of vx binaries through npm wrapper using some 3rd party
  tools for that maybe" → chose **`@vzn/vx` dual-purpose** over a separate
  `@vzn/vx-cli`; `vx` unscoped is TAKEN on npm). Rather than a 3rd-party
  postinstall downloader (`go-npm`/`binary-install` — network-at-install,
  breaks `--ignore-scripts`), used the optionalDependencies pattern
  esbuild/turborepo/biome ship: `@vzn/vx` carries the library source
  (`exports: ./src/index.ts`) PLUS a Node launcher (`bin: launcher.mjs`) that
  execs a prebuilt standalone binary shipped as a per-platform
  optionalDependency (`@vzn/vx-{linux,darwin}-{x64,arm64}`). npm installs only
  the matching-os/cpu package; the launcher `require.resolve`s its binary and
  execs it — so `npm i -g @vzn/vx` gives the `vx` command with **no Bun and no
  install-time download**. Launcher fallback: no platform binary + Bun present
  → `bun src/bin.ts` (source checkout, or an unsupported platform with Bun).
  **Files:** `scripts/npm-launcher.mjs` (published-layout launcher template),
  `scripts/build-npm.ts` (`bun scripts/build-npm.ts <version> [--only=<t>]` →
  assembles `dist/npm/{@vzn/vx-<t>,vx}`; reads sandbox-runtime dep + description
  from root package.json so versions never drift), `.github/workflows/npm.yml`
  (release `published` + `workflow_dispatch`; **stamps the version into
  package.json BEFORE `vx run build`** because `src/version.ts` reads
  `../package.json` which `bun build --compile` inlines — else the binary
  reports 0.0.0; publishes platform pkgs first then main). **Auth = npm
  Trusted Publishing (OIDC), token-less** (owner: "I have npm connected to
  gh"): job has `id-token: write`, upgrades to npm ≥ 11.5.1 (node 22 ships
  10.x), and `npm publish` exchanges the OIDC token for a short-lived
  package-scoped credential + auto-provenance — NO `NPM_TOKEN` secret. **Owner
  must configure a Trusted Publisher on npmjs.com for ALL FIVE package names**
  (`@vzn/vx` + the 4 `@vzn/vx-<target>`), each pointing at this repo +
  `.github/workflows/npm.yml`, else the un-configured ones 403.
  **Verified end-to-end locally** (linux-x64): built
  the binary, generated the tree, simulated the installed node_modules layout,
  ran `node launcher.mjs --version` → execs the binary (`vx 0.0.0`); removed the
  platform pkg → launcher fell back to `bun src/bin.ts` (`vx 0.0.0-test`).
  `dist/` is gitignored (108MB binary + tree never committed). Docs:
  README + docs quickstart lead the install with `npm install -D @vzn/vx`
  (binary, no Bun) beside the curl script. **Owner TODO before first publish:**
  add the `NPM_TOKEN` repo secret (npm automation token with publish rights to
  the `@vzn` scope). The GH-release binaries in `release.yml` have the SAME
  latent version-stamp gap (they'd embed 0.0.0 unless root package.json is
  bumped) — left as a follow-up; npm.yml handles it for the npm path.

- **2026-07-04**: **CI publishes the `vx-cloud` Docker image to GHCR** (owner:
  "Build docker image into GitHub registry on ci"). New
  `.github/workflows/docker.yml` builds `packages/cloud/Dockerfile` (build
  context = repo root) and pushes to `ghcr.io/<owner>/vx-cloud` via
  `docker/build-push-action` + `metadata-action`. Triggers: push to `main`
  (paths-filtered to `src/**`/`packages/cloud/**`/`scripts/**`/manifests) →
  `latest` + `main` + `sha-<short>`; `release: published` → `X.Y.Z` + `X.Y`;
  `pull_request` → BUILD-ONLY (validates the Dockerfile, no push — a fork lacks
  `packages: write` anyway, and the login/push steps are gated on
  `event_name != 'pull_request'`); `workflow_dispatch`. `permissions:
{contents: read, packages: write}`; login uses the built-in `GITHUB_TOKEN`.
  `linux/amd64` single-arch (fast + reliable; the `bun build --compile` step
  is native-arch — multi-arch would need QEMU/OOM risk); GHA layer cache
  (`type=gha,mode=max`); `concurrency` cancels superseded same-ref runs.
  **Deploy docs updated to lead with the pull**: `self-hosting.md`,
  `deploy/README.md`, and `deploy/docker-compose.yml` now reference
  `ghcr.io/vznjs/vx-cloud:latest` (build-from-source kept as the secondary
  option), matching the owner's "devs won't clone — give them a command to
  run" directive. Also dropped a stale "+ Helm topologies" mention (Helm was
  removed for docker-compose earlier). Docker build NOT exercised here (no
  daemon in this env); the first CI run validates the image end-to-end.

- **2026-07-04**: **Core is provider-neutral — every vx-cloud NAME scrubbed
  from core `src/`; docs get a "Core is provider-neutral" section** (owner:
  "Vx cloud should not be bound in anyway to vx… vx core should not have any vs
  cloud refs. Or needs. It should work fully through a plugin and anyone could
  create a new. Make it also as another section in docs"). Core already had NO
  functional vx-cloud dependency (it never imports `@vzn/vx-cloud`, never reads
  a `VX_CLOUD_*` var — only the provider-neutral Turbo-wire `VX_REMOTE_CACHE_*`
  escape hatch; pinned by `tests/package-boundaries.test.ts`). What remained
  was NAMING. Removed it wholesale: **(1) functional CLI** — the `vx serve`/`dev`
  redirect no longer names `@vzn/vx-cloud` or lists the RETIRED
  `coordinator`/`worker` verbs; it prints a neutral "these come from a PLUGIN,
  not core" hint pointing at the plugin guide (core names NO specific package).
  `help.ts`'s "Execution service + dashboard" section became "Extensions
  (plugins)". `tests/cli.test.ts` inverted: asserts the hint mentions "plugin"
  and does NOT contain "vx-cloud". **(2) comments** — a 13-file comment-only
  scrub neutralized every `@vzn/vx-cloud`/`vx-cloud`/`vx Cloud`/"cloud's X"
  mention in `src/` prose (→ "a plugin", "an out-of-process service", "a
  third-party sink", "a distribution plugin"), keeping generic concept words
  (serve/coordinator/agent/dashboard/remote cache) and the design-doc filename
  citations. Zero code/logic/signature changes; oxfmt clean. **(3) gate fix**
  found along the way — `packages/cloud/src/plugin.ts` had a DEAD `cacheUrlOf`
  referencing the removed `opts.cacheUrl` (leftover from the one-connection
  collapse), a type error keeping `lint`/`ci` RED; deleted (no callers).
  **(4) docs** — new hand-authored `apps/docs/src/content/docs/guides/
extensibility.md` ("Core is provider-neutral") LEADS the "Platform &
  extensions" sidebar section: core is only a task runner (offline, no
  service), the three plugin seams (backend/cache/telemetry) with a mermaid
  diagram, `@vzn/vx-cloud` framed as "just a plugin" + a runnable `acmeCache()`
  bring-your-own example, and "the boundary is enforced" (core depends on
  nobody; the arrow only points plugin→core). Full gate green (core 1048
  pass, cloud 170 pass, lint+oxfmt clean); docs site builds 144 pages, 0
  broken links. No CACHE_VERSION/SCHEMA/behavior change — naming + docs only.

- **2026-07-04**: **Cloud simplified to ONE connection; trust follows the
  token** (owner: "Distributed ci setup and work is too complex. Hosting cloud
  should not be required. And if so it should be easier. We have too many env
  vars. Cache should be internal to cloud. Trusted untrusted should be managed
  by which token we use."). Collapsed the three overlapping connection concepts
  (ingest / remote-cache / service — ~15 client env vars) into a single
  `resolveConnection()` in `packages/cloud/src/plugin.ts`: **`VX_CLOUD_URL` +
  `VX_CLOUD_TOKEN` (+ `VX_CLOUD_PR_TOKEN`)** drives ALL THREE rungs (analytics
  ingest, the remote cache `/v8/artifacts`, distributed execution). **Cache is
  internal to the connection** — connect a cloud and the remote cache is
  automatic; `VX_REMOTE_CACHE_*` survives only as the third-party
  (Turbo-server) escape hatch. The pre-consolidation vars (`VX_SERVICE_URL`,
  `VX_REMOTE_CACHE_URL/TOKEN`, `VX_CLOUD_INGEST_*`, `VX_CLOUD_INSIGHTS_*`) stay
  as resolution ALIASES so nothing breaks, but the documented model is one URL
  - one token. **Trust = which token you present**: the server derives the tier
    from the bearer, so the client just carries whichever token it has. REMOVED
    the client-side `VX_CACHE_TRUST` override, the fork-PR autodetect
    (`detectForkPr`), and `resolveCacheTrust` + the `remoteWrite=false` floor — a
    fork PR simply holds only the PR token (repo secrets aren't exposed to
    forks), so "which token" IS the tier, no flag. Dropped `detectForkPr` /
    `resolveCacheTrust` / `CacheTrust` from the core façade (boundary snapshot
    updated). A plain `VX_CLOUD_URL` connection NEVER moves execution: ambient
    delegation stays opt-in via `vx-cloud connect --delegate`, distribution via
    `VX_CLOUD_DISTRIBUTE`. `cloud()` options collapsed to `url`/`token`/`prToken`
    (+ the Turbo tenancy/signing knobs); `serviceUrl`/`cacheUrl`/`cacheToken`/
    `cachePrToken`/`ingestUrl`/`ingestToken` removed as options (env aliases
    remain). Core `wrapWithRemoteCache` simplified the same way
    (`token = VX_REMOTE_CACHE_TOKEN ?? VX_REMOTE_CACHE_PR_TOKEN`). Full gate
    green: core 1047 pass, cloud 169 pass, lint clean.

- **2026-07-04**: **Docs + website refresh for adopters; deploy simplified to
  docker-compose (Helm removed)** (owner: "Update docs and refresh website...
  Devs should not care about building spa... They won't clone the project.
  Command to run and everything. Also many things are not in docs like agents"
  - "Do we need helm? Why not just docker compose?"). The website's platform
    guides had drifted to a RETIRED architecture. Fixed:
    **(1) Deploy simplification.** Removed the entire stale Helm chart
    (`packages/cloud/deploy/helm/` — its coordinator/worker/HPA templates
    invoked verbs RETIRED by distributed-execution-2026-07; the real server is
    ONE `vx-cloud serve` process and agents are per-CI-job, not pods). Replaced
    with `packages/cloud/deploy/docker-compose.yml` + a rewritten
    `deploy/README.md` (docker run / compose, "same image as a one-container
    Deployment" k8s note, no chart). Dockerfile: dropped the coordinator
    `EXPOSE 5180` + retired-role comments; documented the load-bearing Docker
    interaction — a container must bind `0.0.0.0` to be reachable, which (per the
    security wave) REQUIRES a token, so a real deploy sets BOTH `VX_CLOUD_HOST=0.0.0.0`
    and `VX_CLOUD_TOKEN`.
    **(2) Adopter guides rewritten** (3 parallel developer agents, verified
    against source, disjoint files): `guides/distributed-ci.md` (was
    `vx coordinator`/`vx run --worker`/"v22 hash" — now `vx-cloud agent` DTE:
    session-keyed `{workspaceId, session, commitSha}`, `VX_CLOUD_DISTRIBUTE`,
    same-checkout scoped-`run()` law, outputs via the serve's `/v8` store,
    submitter self-registers, fork-PR `--pr-token` variant); `guides/self-hosting.md`
    (was `vx serve` reading `cache.db` + "no auth" + "build the SPA" — now
    `vx-cloud serve` ingest-store-only + token/loopback/Origin auth + embedded
    dashboard + trust scopes + the Docker host+token requirement);
    `guides/dashboard.md` (embedded in the `vx-cloud` binary, fed by the plugin
    push not `cache.db`, real auth + multi-workspace, corrected diagram).
    **(3) Missing/stale coverage.** `guides/mcp.md` gained the serve `POST /mcp`
    HTTP path (dependency-free, behind the bearer) alongside the core `vx mcp`
    stdio; `introduction.md` de-staled (agents = `vx-cloud agent`, serve =
    `vx-cloud serve`, dashboard "nothing to build"); the sidebar labels + the
    source-of-truth `docs/cli.md` serve section got the new `--host` /
    `--pr-token` / `--allow-origin` flags + the loopback/Origin/trust-scope
    semantics. The core quickstart was already install-and-run (untouched). The
    frozen `docs/design/*-2026-06.md` notes are historical records — left as-is.
    Astro site builds clean (143 pages, 0 broken links). No core/runtime change.

- **2026-07-03**: **Security hardening wave + known-limitations resolved**
  (owner: "Do a full security audit... implement all no questions asked. Make
  sure our cache is segregated to avoid CVE pollutions" + "resolve all known
  limitations"). A 15-agent adversarial audit across five surfaces with an
  independent refute pass drove `docs/design/security-review-2026-07.md`
  (durable record: verified findings, refuted findings, accepted residuals).
  Four gate-green commits, all shipped:
  **(1) Known-limitations** (`aacf6c3`): grandchild orphaning — `execWrap()`
  in `exec/runner.ts` exec-prefixes a single external command so `sh -c` is
  REPLACED by the program (a teardown SIGTERM hits the program, not an
  intermediate shell whose death orphaned its child; also makes resourceUsage
  measure the program). Guards: shell control chars, builtins, and `FOO=bar`
  env-assignment forms keep the shell (compound grandchildren still orphan on
  a hard kill — the residual every non-cgroup runner shares). Frozen TTY
  region — `run.ts` `onSignal` calls `log.runEnd?.()` before killing children.
  **(2) Core security** (`431cf89`): (a) `entry_inputs` stored raw secret env
  values / runtime output / argv in its `hash` column (plaintext secrets at
  rest in cache.db) → capture `xxh3hex(v)` digests instead; the diff only
  needs change-detection, cache KEY folds plaintext separately, NO
  CACHE_VERSION bump. (b) zstd-bomb OOM DoS on a remote hit → cap the
  compressed download (bounded streaming read, aborts past 512 MB in
  `remote-cache.ts`) + the decompressed output (parse the zstd frame's
  declared content size, refuse a bomb before allocating; refuse a sizeless
  frame over the untrusted ingest boundary; 2 GiB ceiling in `cache.ts`;
  degrades to a miss). (c) `extractOutputs` followed a symlinked PARENT dir
  (lexical containment) → realpath the parent, require it inside the realpath'd
  base (`tar.ts`).
  **(3) Serve auth** (`5a30d15`): the two CRITICALS. Serve bound 0.0.0.0 with
  no token by default → unauthenticated LAN RCE via the `run` WS. Bind
  127.0.0.1 by default (`--host`/`VX_CLOUD_HOST`); refuse a non-loopback bind
  without a token. Cross-origin WS handshakes weren't Origin-checked → drive-by
  CSWSH→RCE from any page the dev visits. Gate the run/agent WS upgrades + SSE
  streams on the Origin (no-Origin CLI + same-origin pass; other cross-origin
  browser handshakes 403; `--allow-origin`/`VX_CLOUD_ALLOW_ORIGIN` allow-lists
  a hosted dashboard).
  **(4) Cache trust scopes + immutability** (`24af48f`; design
  `cache-trust-scopes-2026-07.md` Phase 1 — the owner's "segregate the cache"
  ask): the artifact store is partitioned by `<bucket>/<tier>`, both
  SERVER-DERIVED from the token (never a client claim). A trusted token
  reads/writes only `trusted/`; an untrusted (`--pr-token`/VX_CLOUD_PR_TOKEN)
  token reads `untrusted ∪ trusted` but writes only `untrusted/` — so a fork-PR
  poison NEVER feeds a trusted build and untrusted can NEVER write trusted,
  regardless of the key it computes (the GitHub-Actions/Nx/Turbo model,
  server-enforced). `authorized()` returns the `Principal`; the run/agent WS,
  `/v8` handler, and dist-prune all route by it. Artifacts are IMMUTABLE (re-PUT
  of an existing hash → 409). Legacy flat store migrates to `default/trusted/`
  on boot. Client `detectForkPr` (GitHub/GitLab, never throws) +
  `resolveCacheTrust` (`VX_CACHE_TRUST` override → fork detect → trusted) pick
  the token + a `remoteWrite=false` floor for a fork PR without a PR token
  (Nx/Turbo "PR is read-only" default). Mirrored in `cloud()`'s cache rung
  (`cachePrToken`, optional `prToken` per environment). **NO CACHE_VERSION
  bump** — the key never changes, solo-dev local cache byte-identical, only the
  server path + which token writes where moves. Core façade +`detectForkPr`/+`resolveCacheTrust`. **Refuted** (not actioned, refute pass
  found the framing wrong): "content-addressed store never verifies content"
  (hash is a cache key, not a content digest); "self-asserted commitSha"
  (accepted Nx-Agents same-checkout model — per-agent creds tracked as future
  multi-tenant hardening). Full core suite green (bar the known-flaky watch
  e2e — cwd race, passes in isolation), cloud 168 pass / 0 fail.

- **2026-07-03**: **vx agents SHIPPED — session-keyed distributed task
  execution (Nx-DTE equivalent) on the connected serve** (`743aa47`;
  design `docs/design/distributed-execution-2026-07.md`, the review Phase
  4-5 was fenced behind; owner: "continue"). **The correctness law
  (§6):** an agent executes each assignment as a scoped core `run()` of
  the exact task WITH its dep closure — deps restore as warm
  `cache-hit-remote` from the serve's artifact store, so the agent's
  saved key equals the full-run key BY INDUCTION. The
  `excludeDependencies:'all'` alternative is provably wrong (dropping
  dep edges empties the upstream-hash fold → artifacts upload under keys
  no full run derives) — pinned by the §6.3 guard test in BOTH
  directions. **Shape:** serve hosts an in-memory session registry
  (`/v1/agents` WS behind the bearer; sessions keyed
  {workspaceId, session}; commitSha enforced at pairing — mismatches
  refused naming both SHAs; 15-min GC); scheduler store-PRUNES stable
  hashes already in the serve's own artifact store (one local stat —
  warm tasks execute NOWHERE) and reassigns on agent death;
  `vx-cloud agent --url <serve>` = same-checkout contract (dirty tree
  refused; session from VX_AGENT_SESSION > CI env > 'local');
  submission = VX_CLOUD_DISTRIBUTE via the cloud() backend rung, and
  the submitter SELF-REGISTERS as a session agent so zero remote agents
  degrades to a loud local run, never a deadlock; hard gates
  (forwardArgs, dirty tree, non-remote cache policy, persistent) fall
  back local with a reason; outputs materialize on the submitter via
  targeted get+cleanOutputs+restoreOutputs. The ephemeral
  `vx-cloud coordinator`/`worker` verbs + core `workerExecute` are
  RETIRED; protocol-dist v1 (assignment = bare taskId, outcomes =
  OutcomeView). Core façade +deriveStableKeys/+captureGitContext/
  +captureWorkspaceIdentity/+cleanOutputs. **Gotcha for the record:**
  the repo's bare `dist` gitignore/lint-ignore silently swallowed the
  new `packages/cloud/src/dist/` module — `!packages/cloud/src/dist`
  negations added to .gitignore/.oxfmtrc/.oxlintrc. Verified by two
  REAL e2e (serve + two agent subprocesses on same-commit clones:
  placement across both, streamed logs, warm re-submission assigns
  nothing, kill-mid-task reassigns). Repo suite 1206 pass / 0 fail. No
  CACHE_VERSION/SCHEMA bump. KNOWN-OPEN (§13): remote agents run
  live-eval + full cache policy (per-request policy = small protocol
  addition); Helm chart still names the retired verbs; cross-run
  queueing/fairness + autoscaling remain non-goals.

- **2026-07-03**: **The connected-server phases shipped — telemetry v2
  workspace identity, multi-workspace serve, delegation self-ingest, MCP
  endpoint, unix socket, artifact store** (owner: "continue until whole my
  vision is finished"; executes dev-flows-ci-agents-2026-07.md §3 + §10 and
  cloud-client-server Phase 2-3). **(1) Telemetry v2** (`9529c78`):
  `TELEMETRY_SCHEMA_VERSION` 1→2; `RunContextRecord` gains
  `workspaceId`/`workspaceName` — id = xxh3 of the NORMALIZED git remote
  from `git config --get remote.origin.url` (NOT `remote get-url`, which
  applies insteadOf rewrites and would split mirrored checkouts; ssh/https
  forms of one repo converge); no remote → salt persisted at
  `.vx/workspace-id`. Captured only when a telemetry consumer exists.
  New `RunOptions.telemetrySinks` (additive observe-only embedder seam;
  undefined = zero cost). **(2) Multi-workspace serve** (`60a501a`):
  IngestStore = one core Cache per workspace at `<dir>/<workspaceId>/` +
  versioned workspaces.json manifest (path-token-validated ids; legacy
  single-store dir migrated on boot WITH the WAL/SHM sidecars — they're
  load-bearing); `?ws=` on every /v1 analytics route (unknown → 404),
  token-gated `/v1/workspaces`, `/v1/meta` count-only field; un-scoped
  default = sole workspace, else genuine 'default', else most-recently-seen
  (a fresh dashboard never opens onto an empty synthetic store). Delegated
  runs SELF-INGEST via an option sink — the audit's "dashboard misses the
  runs the server executed" gap closed. UI workspace switcher (hidden at
  ≤1 workspaces); page loader keyed on origin|token|workspace fixed the
  latent no-refetch-on-origin-switch bug. Cloud tests pin
  VX*CLOUD_SERVE_INFO (test serves no longer clobber the real
  advertisement). **(3) Serve platform** (`bf0a5cc`): `POST /mcp` —
  dependency-free MCP (JSON-RPC 2.0, protocol 2025-03-26) behind the
  bearer, 7 tools as thin adapters over the existing metrics queries (AI
  agents connect to any serve, local or remote); `serve --socket` /
  VX_CLOUD_SOCKET — second unix-socket listener (0600 = the auth; socket
  requests bypass the token; plugin push prefers the advertised socket,
  TCP fallback); `/v8/artifacts/:hash` — the Turbo wire RemoteCache
  already speaks, flat-dir atomic storage + x-artifact-tag sidecar
  (signing verifies end-to-end client-side; serve never holds the key),
  `/v1/meta` advertises `artifacts:true`, and cloud()'s cache capability
  gains the environment rung (lazy one-shot /v1/meta probe, memoized;
  explicit VX_REMOTE_CACHE*\* always wins) — **`vx-cloud connect` is now
  one-URL analytics + remote cache**, the Tier-B CI story. All verified
  live (MCP handshake/tools/401, socket-vs-TCP auth split, artifact
  round-trip, real run e2e miss→upload→wipe→remote-restore). Repo suite
  1192 pass / 0 fail. Zero core changes beyond (1); no
  CACHE_VERSION/SCHEMA bump. KNOWN-OPEN → roadmap: serviceBackend still
  dials TCP only (socket rung for delegation is a natural next
  increment); artifact GETs carry no x-artifact-duration (a .duration
  sidecar is a cheap follow-up); persistent coordinator + vx agents
  (Phase 4-5) remain fenced behind their own design reviews.

- **2026-07-02**: **Full consulting engagement — audit, docs unification,
  client/server architecture, core fixes, UI stabilization** (owner: "review
  all the code from 1st June. Unify whole documentation, document issues,
  arch drifts, propose better changes… vx cloud needs to work like Arcane
  (docker): a client that connects to a server, local or deployed…
  flexible remote and local… redo UI… performance is still the king…
  extensible with plugins like vite", then "many workspaces… CI like nx
  agents… figure out whole dev flows", then "projects run tasks or
  schedule tasks… vx-cloud agent registers with workspace and context id…
  like DTE in NX… Unix socket like docker… AI agents should easily
  connect"). A 7-area parallel audit (git history, top-level docs, module
  docs, core arch, cloud arch, UI/UX, tests; ~100 file:line-evidenced
  findings) drove five shipped waves + three design docs:
  **(1) Consulting report** `docs/design/consulting-review-2026-07.md` —
  issues register (~45 items, ~half fixed in-engagement), drift log, flow
  maps, process findings (the #1 cost driver is same-day build-then-delete
  churn: vx-http 54min, Cytoscape 2h, CF stack 6h, dashboard rewritten 4×
  in one day; `predictive` shipped silently), P0-P3 roadmap.
  **(2) Client/server design** `cloud-client-server-2026-07.md` +
  **environments layer SHIPPED**: docker-context-style per-user
  `environments.json` (NOT Arcane's server-side agent registry — vx's data
  flow is client-push), `vx-cloud connect <url>` / `env ls|use|rm` /
  `disconnect`, resolution ladders (opts > env vars > active environment >
  local serve-info > decline; backend delegates only with explicit
  `delegate: true`), serve `--token` auth (SHA-256 + timingSafeEqual,
  `?token=` for EventSource/WS, `/version` moved behind the token),
  pre-auth `GET /v1/meta` identity, WS bearer, UI token + server badge.
  Zero core changes; zero-overhead decline pinned by tests.
  **(3) Core fixes** (all audit-driven): inflight-join no longer reuses a
  stale preProbed miss (joiner now cache-hits the sibling's artifact);
  plugin `teardown()` + `EventSink.flush()` actually invoked at end-of-run
  (crash-isolated, 3s-bounded) — they were documented API core never
  called; LayeredCache remote PUTs made genuinely fire-and-forget
  (bounded background set + `drainUploads()` before close — save() no
  longer holds a worker slot for the upload RTT); `--dry`/`--graph` on a
  remote cache uses a new `CacheLayer.has` existence probe (local SQL +
  remote HEAD) instead of downloading+ingesting every artifact; prune
  IN-lists chunked at 900; stats counts remote hits; persistent-child
  output buffering stops at ready (heap leak); mcp reports real VERSION;
  `telemetry` added to config's structural Plugin type; false cache.ts
  comments deleted; dead surfaces removed (PreparedRun.history,
  RunOptions.report, CAS exports off the façade — modules stay as the
  artifact-store seam); metrics drift-guard test (every query runs against
  a fresh schema in the gate); IngestStore warns loudly on schema-gate
  history wipe (was silent data loss). Also `shouldShortCircuit` now
  gates off LayeredCache (the documented rule the code missed — the
  awaited classify would put N remote GETs on the critical path). Warm
  perf at parity (paired A/B vs pre-wave baseline: median delta +4ms,
  4/4 split). No CACHE_VERSION/SCHEMA bump anywhere.
  **(4) Docs unified**: every top-level doc reconciled against code
  (caching.md had the wrong hash algo + version; comparison/schema
  advertised owner-REJECTED features; architecture.md predated the
  monorepo split), 20 new `docs/modules/` pages (telemetry, plugin,
  events, stable-keys, local-shortcircuit, metrics, lockfile, mcp, …),
  module index regenerated, this file's repo layout rewritten (was
  missing ~25 shipped files).
  **(5) UI stabilized, NOT rewritten** (5th-rewrite temptation explicitly
  rejected): capabilities signal gates hosted-mode surfaces behind honest
  hints (was fake "no data"); run detail gained the INVOCATION header
  (branch/commit/dirty/CI/tags/policy/workers/command); error+loading
  states everywhere; compare renders negative deltas; cockpit shows
  predicted hit/miss chips on queued cards + solid-store log accumulation
  (no per-chunk record clone); IA: cockpit is home with a colocated
  workspace, hosted lands on Runs, nav Run-first; ~200 LOC dead code
  removed. Verified over Playwright: every route + live run + ingested
  run detail/compare, 0 console errors.
  **(6) Dev-flows + CI design** `dev-flows-ci-agents-2026-07.md`:
  workspace identity as TELEMETRY_SCHEMA_VERSION 2 (stable id from git
  remote; server stores + UI switcher keyed by it — the "many workspaces
  on one serve" keystone), CI tiers (A: env-var ingest works TODAY; B:
  one-URL connect after the serve-hosted artifact store; C: **vx agents**
  = Nx-DTE-style session-keyed distribution on the existing
  coordinator/worker skeleton — same-checkout contract like real Nx
  Agents, NO input shipping, outputs propagate between agents via the
  shared cache, registration keyed {workspaceId, session, commitSha},
  the submitting runner self-registers as an agent so local+remote mix),
  full dev-flow catalog, unified phasing. Addendum (owner refinement):
  run-vs-schedule lands on the existing RunBackend seam (no per-task
  `schedule:` field); unix-socket transport as the hardened local option
  (browser UI keeps TCP); **MCP on the serve** as the AI-agent control
  plane (thin adapter over /v1, Phase 2, independent). KNOWN-OPEN handed
  to the roadmap: workspace identity (next increment), delegation
  self-ingest (needs the one core `RunOptions.telemetrySinks` decision),
  serve-hosted artifact store (Phase 3 — the highest-value remote piece),
  isOutputsCurrent content hash, output-test repin churn, test
  serve-advertisement clobbering (unpinned VX_CLOUD_SERVE_INFO).

- **2026-06-28**: **Stable local cache hits restore AHEAD of their deps —
  two-tier scheduler** (owner saw `@vzn/vx-docs#build` waiting on
  `@vzn/vx-docs#import` though build was a warm hit: "it should know right
  away if it can be used from cache or not… restoration should always run
  first no matter of order. we know right away what can be restored, they
  should not fall into topology" + "prioritize running cache misses though,
  only if required or free workers add cache restores" + "this should be
  actual faster not slower"). `dependsOn` is an ordering gate, so a
  dependent couldn't restore until its upstream finished RUNNING — but a
  STABLE-key task's key is provably independent of any upstream's OUTPUTS,
  so its cache hit is knowable up front and its restore needs none of the
  deps' output. New up-front CLASSIFY (`src/orchestrator/
local-shortcircuit.ts`): derive every stable-key, cacheable, local-read
  task's key (reusing the run's `hashCache` memo) and probe `cache.get`
  ONCE → a `preProbed` map (hits AND stable misses) + a `restoreTier` set
  (confirmed hits). **Two-tier scheduler** (`graph/scheduler.ts`): two
  ready queues — restore-tier tasks are ready IMMEDIATELY (bypass the
  dep-gate, bypass the failed-dep→skip check — their key is dep-success-
  independent) at LOW priority (`restoreReady`); everything else is
  exec-tier, dep-gated, NORMAL priority (`execReady`). `takeReady` drains
  execReady FIRST, so cache MISSES own the worker pool and restores only
  backfill idle capacity — exactly the owner's "misses first, restores
  backfill" rule. **Probe reuse:** `execute-task.ts` consumes `preProbed`
  (extracted `restoreHit`), so the up-front probes ARE the probes execute()
  would have done, hoisted — no double work (the double-probe is what
  tanked the reverted `classify.ts`, +57%). Every task still flows through
  execute() so logger output is unchanged. **Safety:** only stable-key
  tasks classified (`stable-keys.ts` `dependsOnSiblingOutputs` — a same-
  project upstream with declared `outputs.files`, or a `workspaceFiles`
  overlap, makes the key preliminary → unstable → stays lazy/dep-gated); a
  graph declaring `outputs.workspaceFiles` (boundary-ignoring) disables the
  restore tier graph-wide (probe reuse still applies); gated on
  `localRead` + ≥1 dep edge; NOT for LayeredCache runs (remote-prefetch
  owns those); never throws (degrades to the normal schedule). `deriveStableKeys`
  factored out of `remote-prefetch.ts` so the two callers can't drift on
  the stability gate. **No CACHE_VERSION/SCHEMA bump** — key derivation +
  artifact bytes untouched; only WHEN a restore fires changed. **Measured
  (A/B on vs off, git-stash toggle):** mixed workload (a slow uncacheable
  upstream feeding many stable cached downstream tasks — the docs case)
  488ms → 456ms (**−6.6%**); warm all-hit at **parity** (paired/
  interleaved bench cancels VM drift: median delta within noise, 6 reps
  faster / 6 slower — there are no misses to overlap, so parity is the
  ceiling and the hoisted classify costs nothing net). The naive all-ON-
  then-all-OFF bench had shown a phantom +2.9% that was pure machine drift.
  Files: `src/orchestrator/{stable-keys,local-shortcircuit,run,execute-task,
remote-prefetch}.ts`, `src/graph/scheduler.ts`, `src/cache/index.ts`
  (export `CacheEntry`); tests `tests/local-shortcircuit.test.ts` (7 e2e:
  cross-project restore-tier correctness, codegen-consumer stays exec-tier,
  workspace-outputs disables tier, --no-cache no-probe, no-double-probe =
  exactly 2 `Cache.get` for 2 warm tasks, restore-tier hit stable even when
  a dep FAILS, flat graph), `tests/scheduler.test.ts` (+4 two-tier). Design
  `docs/design/local-cache-shortcircuit-2026-06.md`.

- **2026-06-28**: **Run graph redesigned as a staged, Linear-style flow —
  REVERSES the Cytoscape adoption** (owner: "graphs are super ugly, there were
  so nice Linear style now they are shit. they need to simulate stages of runs
  with marked bottlenecks times etc ram cpu"; chose "Staged DAG (columns)" via
  AskUserQuestion). The canvas-rendered Cytoscape graph looked generic and
  off-theme (canvas can't pick up the dashboard's gradients/typography) and
  showed no metrics. Replaced with a CUSTOM DOM + SVG **staged DAG**
  (`components/RunGraph.tsx` rewritten; `cytoscape`/`cytoscape-dagre`/
  `@types/cytoscape` removed — embedded SPA 780 KB → 313 KB / 237 → 85 KB
  gzip). Tasks lay out in left-to-right STAGES (topological waves via
  `run-graph-layout.ts` `layoutStages` — longest-path depth); each stage column
  has a header with its parallel wall-time. The BOTTLENECK (critical path)
  glows amber — cards get a ring + a flame marker, edges thicken. Every card
  shows duration + CPU% + peak RAM (from recorded rows on run-detail; from live
  `task:complete` cpuMs/peakRssBytes in the cockpit — `RunConsole` now captures
  both). Linear polish: gradient cards, status rail, hover lift, mono type;
  scroll-to-pan + a zoom control (no drag — positions are meaningful in a
  staged layout). Groups stay dashed folders (the groups-as-pending fix holds).
  Deterministic fixed-grid layout → edges drawn from computed coords, no DOM
  measurement; status is plain reactive props so live ticks repaint in place.
  **UnoCSS gotcha (again):** status classes are LITERAL strings in a state→class
  map (+ safelisted) so the static extractor emits them — never `border-${x}`.
  Verified e2e over CDP (temp workspace, diamond + two groups): stages, the
  bottleneck glow, CPU/RAM chips, the cache-hit blue overlay on run-detail; 0
  console errors (screenshots confirmed). Core untouched; cloud-dashboard only.

- **2026-06-28**: **Advertise the serve at a per-user (machine-level) path so
  it's found from ANY workspace** (owner: "no serve.json, nothing guarantees vx
  cloud will run from any workspace"). The serve advertisement lived at
  `<workspaceRoot>/.vx/serve.json`, so a `vx run` only discovered the local
  serve when it shared that exact root — no guarantee from another workspace.
  New light `packages/cloud/src/serve-info.ts` (`serveInfoPath` /
  `readServeInfo` / `pidAlive`) puts ONE per-user advertisement at
  `$XDG_RUNTIME_DIR/vx-cloud/serve.json` (else a per-uid temp dir;
  `VX_CLOUD_SERVE_INFO` pins an exact path / used by tests). A `vx run` in any
  workspace now finds it, and the deterministic serve port means there's only
  ever one local serve. Shared by `serve.ts` (writes it), `backend.ts`
  (delegation discovery — was `serveInfoPath(findWorkspaceRoot(cwd))`) and the
  `cloud()` plugin (telemetry push), keeping the lean `@vzn/vx-cloud/plugin`
  import free of the service layer. The plugin push also now ignores a STALE
  advertisement (`pidAlive` false) so a serve that died without cleanup doesn't
  cost every run a swallowed POST. A remote/Docker serve isn't advertised here —
  that uses explicit `VX_CLOUD_INGEST_URL` / `VX_SERVICE_URL`, which always
  wins. Also fixed all 8 oxlint `no-unused-vars` warnings repo-wide (zero
  warnings now).

- **2026-06-28**: **Local serve port is now DETERMINISTIC — same URL across
  restarts, override via `VX_CLOUD_PORT`** (owner: "locally we should use same
  port unless env var specified"). REVERSES the earlier "fall back to an
  ephemeral port when 4321 is taken" rule — that silent fallback was exactly
  what made the dashboard URL move between restarts. Port resolution is now
  `--port` > `VX_CLOUD_PORT` > `DEFAULT_SERVE_PORT` (4321), bound exactly; a
  busy port surfaces a clean error ("free it, or pick another with --port /
  VX_CLOUD_PORT") instead of moving on its own. The stable-default POLICY moved
  to the CLI (`resolveServePort` in `serveCmd`); `startServe` is now
  mechanism-only — it binds exactly the port passed, or an ephemeral one when
  none is (tests / embedders), so test serves never contend for 4321 (no test
  asserted the default was 4321; they read the chosen `server.port`). New
  `VX_CLOUD_PORT` env + help text + `resolveServePort` unit tests
  (default / flag-wins / env-override / empty-env / malformed). The api.ts SPA
  default origin (`http://localhost:4321`) and the deterministic default now
  agree again. Verified: A on default → 4321; a 2nd default serve → clean bind
  error (no move); kill + restart → 4321 again; `VX_CLOUD_PORT=4399` → 4399;
  malformed env → invalid error. Files: `packages/cloud/src/cli/serve.ts`,
  `packages/cloud/src/cli/bin.ts`, `packages/cloud/tests/serve.test.ts`.

- **2026-06-28**: **Run DAG rendered with Cytoscape (interactive) + added to
  run-detail; groups no longer render as "pending"** (owner: "we should have
  run graphs like in run section. the graph is wrong, shows groups as pending.
  use some good library for flows visualization where I can click on items see
  details move around etc"). Replaced the hand-rolled SVG/Sugiyama layout
  (`run-graph-layout.ts`, deleted) with **Cytoscape.js + cytoscape-dagre** —
  a framework-agnostic flow lib (mounts into a div, so it works under Solid)
  with pan/zoom/drag/click built in. ONE reusable `components/RunGraph.tsx`
  primitive drives both surfaces. **Reactivity model that matters:** the
  STRUCTURE (node set + edges) is rebuilt + re-laid-out ONLY when it changes
  (a structure-signature guard short-circuits before `cy.elements().remove()`),
  so live status ticks update per-node color/duration in place via `cy.batch`
  WITHOUT disturbing the user's pan/zoom/drag; selection + critical-path
  classes update in place too. Theme colors are read from the CSS `--token`
  RGB-channel vars at mount (Cytoscape paints to canvas, so it needs real
  rgba(), not UnoCSS classes). **Groups-as-pending fix:** umbrella tasks
  (`isGroup`, no exec) are forced to a `group` display state — a dashed folder
  with no status color — instead of inheriting the `queued`/pending look they
  could never leave (groups emit no task events). **Run-detail graph** (new
  `RunGraph` json-render catalog component + a Graph card in `runDetail.json`):
  rebuilds the DAG from the workspace via the existing `/v1/graph` (a colocated
  `planRun`) using the recorded task ids, then overlays each task's recorded
  status/duration (a cache-hit task renders blue, etc.); clicking a node writes
  `/selectedTask` (same binding the Flamegraph + Facts panel use). Degrades to
  a clear "start vx-cloud serve in the project" hint when served with no
  colocated workspace. **Deliberately NO core change:** edges are reconstructed
  from `/v1/graph` (an already-sanctioned colocated live feature), so no
  telemetry-contract field, no schema bump, and ZERO run hot-path cost — the
  perf rule holds. Cloud-dashboard only; the core `vx` binary is untouched. The
  embedded SPA grows to ~780 KB / 237 KB gzip (the Cytoscape runtime — the cost
  of a real flow library), rebuilt into the committed `packages/cloud/ui/dist`.
  Deps added to `packages/cloud/ui` ONLY (`cytoscape`, `cytoscape-dagre`,
  `@types/cytoscape`); frozen install re-resolves clean. Verified e2e over the
  Chrome DevTools Protocol in a temp workspace with a real diamond + two group
  tasks: cockpit ran `ci` (4/4 passed) with `check`/`ci` drawn as dashed
  folders (not pending) and the critical path lit; run-detail rendered the
  reconstructed graph with the cache-hit task overlaid blue; 0 console errors.
  (Screenshots confirmed visually.)

- **2026-06-28**: **`cloud()` auto-detects a local `vx-cloud serve` for the
  telemetry push** (owner: "we should auto detect vx cloud running locally").
  The `cloud()` plugin's telemetry capability now, with no explicit ingest
  config, reads the `.vx/serve.json` a `vx-cloud serve` advertises (origin +
  pid) and pushes the `RunSummaryRecord` to `<origin>/v1/ingest` — so a local
  dashboard is zero-config: start the serve, and every `vx run` in the
  workspace shows up. Explicit config (`ingestUrl` / `VX_CLOUD_INGEST_URL`)
  still WINS, so a remote/Docker cloud takes precedence over local auto-detect;
  no serve + no env → decline, so a plain run is unaffected (perf rule holds —
  the detect is one fs read inside the telemetry-sink construction, which only
  happens when a telemetry plugin exists). **Pid-guard:** never push to a serve
  running in THIS process (serve.json records the serve's own pid) — that is
  the serve executing a delegated run, and POSTing to itself mid-request would
  deadlock. Also hardened both telemetry flush paths (cloud ingest + otel
  export) to a clearable `AbortController`+`setTimeout` instead of
  `AbortSignal.timeout`, whose internal timer is not unref'd and would keep the
  CLI alive for the full timeout after the POST already resolved (a phantom
  end-of-run hang). The backend-routing e2e removes the in-process serve's
  serve.json before its `spawnSync` (which blocks the test event loop, so the
  in-process serve can't answer an auto-detected POST back to it — a test-only
  artifact); the push path is covered by a dedicated test with a separate,
  responsive server. Files: `packages/cloud/src/plugin.ts`,
  `packages/vx-otel/src/sink.ts`, `packages/cloud/tests/plugin.test.ts`.

- **2026-06-28**: **Dashboard moved INTO the cloud package — `apps/ui` →
  `packages/cloud/ui`, so `@vzn/vx-cloud` is self-contained** (owner: "why do
  we need apps/ui? cloud should be self contained"). The dashboard SPA was a
  separate top-level app (`@vzn/vx-ui` in `apps/ui`) that cloud declared as a
  `workspace:*` dep and embedded — so cloud reached OUTSIDE its directory for
  its own UI. Now the SPA lives at `packages/cloud/ui` (git-moved), and:
  `ui-asset.ts` embeds it via a RELATIVE `import '../../ui/dist/index.html'
with { type: 'file' }` (no `@vzn/vx-ui` resolution); cloud's package.json
  DROPS the `@vzn/vx-ui` dependency and adds `ui/dist` to `files` (the
  published package carries the dashboard). `packages/cloud/ui` is registered
  as a nested workspace member (explicit entry in the root `workspaces`
  array — Bun's `packages/*` glob doesn't match one level deeper) so its Vite/
  Solid build deps install; its `vx.config.ts` import switched from the
  now-wrong `../../src/index.ts` to the bare `@vzn/vx`. The SPA's Solid JSX is
  kept OUT of the core gate exactly as `apps` was — added `packages/cloud/ui`
  to `.oxlintrc.json` + `.oxfmtrc.json` `ignorePatterns` (the
  `package-boundaries` guard's `*/src` glob doesn't reach `cloud/ui/src`, so
  no false violations). Rewired the build pointer (`vx.config.ts` `build.ui`:
  `cd packages/cloud/ui && bun run build` + workspaceFiles inputs), the dist
  whitelist (`.gitignore` + cloud `.dockerignore`: `apps/ui/dist` →
  `packages/cloud/ui/dist`), the Dockerfile/deploy/README/serve comments, and
  the self-hosting/dashboard guides. `@vzn/vx-ui` keeps its name (so
  `bun run --filter @vzn/vx-ui build` still works); only its LOCATION changed.
  `apps/` now holds only the docs site. Verified end-to-end: the SPA rebuilds
  at the new path (vite, 140 modules → single-file dist), `bun build --compile`
  embeds it (187 modules → standalone binary) and the COMPILED binary serves
  the dashboard at `/` + SQLite `/v1/*` from a bare non-workspace dir; frozen
  install (`--frozen-lockfile`) re-links cleanly; full root suite 1088 pass /
  0 fail; dogfood `vx run ci` exit 0. The committed dist is byte-unchanged
  (restored after the build-verify) so this commit is a pure move + rewire.

- **2026-06-28**: **vx-cloud is a STANDALONE, independent service — fed only
  by the plugin push, never reads vx's cache.db; vx-http dropped; plugins
  declared in `vx.workspace.ts`** (owner: "remove vx-http for now, just cloud
  and otel. cloud should be self contained. add them to vx workspace as
  plugins. vx cloud should never use local vx db — vx is independent, vx cloud
  can be deployed elsewhere with no access to it; it should use a plugin to
  intercept things from vx"). REVERSES the L2 decision from the entry below
  (local serve reading `cache.db`). **(1) `@vzn/vx-http` deleted** — only
  `@vzn/vx-otel` + `@vzn/vx-cloud` remain. The canonical
  `TelemetryRecord`/`RunSummaryRecord` contract (Unit A) is unchanged; cloud
  speaks it directly (self-contained, no vx-http dep). **(2) vx-cloud never
  opens a workspace `cache.db`.** `serve` reads `/v1/*` ONLY from its own
  SQLite `IngestStore`, populated by the `cloud()` plugin's push to
  `POST /v1/ingest`. Removed the `source` switch / `--source` flag /
  `new Cache` / `loadWorkspaceConfig` from `startServe`; it is ingest-only and
  needs no workspace, so vx-cloud runs anywhere (a remote box with no access
  to the machine that produced the runs). The live-cockpit `/v1/graph` (a
  colocated `planRun`) degrades to a clean error with no workspace; the WS
  run-delegation is unchanged (executes on the client's cwd). **(3) `otel()` +
  `cloud()` declared in a new root `vx.workspace.ts`** —
  `defineWorkspace({ plugins: [otel(), cloud()] })`. Both DECLINE with no
  config (otel without `OTEL_EXPORTER_OTLP_ENDPOINT`; cloud's telemetry
  without `VX_CLOUD_INGEST_URL`, backend without `VX_SERVICE_URL`, cache
  without `VX_REMOTE_CACHE_URL`), so declaring them is **zero-overhead by
  default** — measured `vx run` startup unchanged (~116ms with vs without).
  Two moves keep it free: `cloud()`'s `backend` DECLINES when no service is
  configured (no serve-discovery probe), and the heavy service machinery
  (backend → serve/dev) loads LAZILY (dynamic `import('./cli/backend.js')`
  inside `backend()`), so the plugin module is light; `vx.workspace.ts`
  imports `cloud` from a new `@vzn/vx-cloud/plugin` subpath (NOT the `.`
  index, which re-exports the whole service layer). **(4)
  `scripts/link-self.ts`** now also symlinks every `packages/*` member into
  `node_modules/@vzn/<name>` (Bun only auto-links members some package.json
  depends on; these integration packages are depended on by nobody), so the
  bare `@vzn/vx-otel` / `@vzn/vx-cloud/plugin` imports resolve under a frozen
  install. **(5) Docker** default CMD is now `serve --ingest-dir /data` (a
  `/data` VOLUME) — the image is one Bun + SQLite-ingest + UI process fed by
  pushes. Accepted consequence (= design's option c): cache-ENTRY inventory +
  the full input-fingerprint diff are NOT in vx-cloud (they live in the local
  `cache.db`'s `entries`/`entry_inputs`, which cloud never reads);
  `/v1/explain` + `/v1/diff` return graceful empties. Tests: serve metrics
  suite reworked from "delegate a run to populate cache.db" to "POST a
  RunSummaryRecord to /v1/ingest"; ingest standalone-no-workspace test; cloud
  backend-declines-without-config test. Full root suite 1088 pass / 0 fail;
  dogfood `vx run ci` green with the plugins active.

- **2026-06-28**: **Observability + integration architecture — telemetry
  capability + canonical export contract; OTel/HTTP/cloud as plugins**
  (owner: "design some better architecture, extensible and isolated. vx is
  core, exposes API to integrate with but not behavior change. all data
  sent by OTEL or manual API through plugins. vx cloud integrates through a
  plugin"). Design doc `docs/design/observability-architecture-2026-06.md`;
  implemented in four units, all on `main`, full root suite 1100 pass / 0
  fail, dogfood `vx run ci` green. **Unit A (core):** a new observe-only
  `telemetry` capability on `VxPlugin`, cleanly separated from the behavior
  capabilities (`backend`/`cache`). Neutral BY CONSTRUCTION — a
  `TelemetrySink` receives only immutable records and a `TelemetryContext`
  with read-only metadata (no bus, no Cache, no request), so there is no
  API path back into scheduling/caching/exec. New `src/orchestrator/
telemetry.ts` is THE canonical, versioned export contract
  (`TELEMETRY_SCHEMA_VERSION = 1`): `TelemetryRecord` (per-event:
  run.start/task.start/task.log/task.end/run.end) + `RunSummaryRecord`
  (per-run), with `cacheSource` derived ONCE (`deriveCacheSource`) and
  git/CI/host `RunContextRecord` pre-folded — ending the per-exporter
  re-derivation from the rendering-oriented `WireEvent` stream.
  `createTelemetrySource` projects the bus once + fans to sinks under crash
  isolation (a throwing sink is disabled for the run, never propagates);
  `task.log` is OPT-IN via `TelemetrySink.wants` (default excludes it).
  `telemetry-host.ts` consults the capability and — **the perf invariant** —
  returns `undefined` when no sink is contributed, so a run with no
  telemetry plugin (or one whose plugins all decline) adds NO bus
  subscriber AND builds no summary: the hot path is byte-identical
  (`runContextRecord`/`summaryTasks` are allocated only when plugins
  exist). Wired into `run.ts` (consult after the git/CI/host capture,
  before `run:start`; emit the summary + flush at run:end; dispose in
  finally). `eventSink` stays as a back-compat capability. Exports added to
  `src/index.ts` (boundary snapshot +`TELEMETRY_SCHEMA_VERSION`/
  `deriveCacheSource`); `project-loader.ts` plugin validation accepts
  `telemetry`. **Unit B (`@vzn/vx-otel`):** moves OTel OUT of core — deleted
  `src/orchestrator/otel-emit.ts` + its unconditional `attachOtelEmit(bus)`
  in `run.ts`. The new package's `otel()` telemetry plugin maps a run to
  OTLP traces (a `vx.run` root span + `vx.task` children, CI/CD + VCS
  semconv) + metrics, speaking OTLP/HTTP **JSON directly — NO OpenTelemetry
  SDK dependency** (zero-dep, testable here, no SDK-version drift; the
  design's preferred lighter option since the SDK isn't installable in this
  env). **Behavior change (intended de-hardcoding):** `OTEL_EXPORTER_OTLP_
ENDPOINT` alone no longer auto-exports — declare `otel()` in
  `vx.workspace.ts`. The repo sets no endpoint, so its own runs are
  unaffected; no `vx.workspace.ts` was added to the repo (a pointless
  always-declining plugin). **Unit C (`@vzn/vx-http`):** `httpTelemetry({
url })` — the generalized manual-API exporter, POSTs the canonical
  contract; `summary` mode (one `RunSummaryRecord`/run, default) or `stream`
  mode (batched NDJSON/JSON, opt-in `task.log`); Bearer, time-bounded,
  never-fail, idempotent. **Unit D (`@vzn/vx-cloud`):** the cloud plugin's
  `eventSink` (raw WireEvents) becomes a `telemetry` sink POSTing the
  `RunSummaryRecord` to the cloud's `POST /v1/ingest` (options renamed
  `insightsUrl/Token`→`ingestUrl/Token`, env back-compat kept). New
  `IngestStore` = a core `Cache` at a cloud-owned path, so core's runs +
  invocations schema + `recordRunBundle` persist the pushed summary and
  EVERY `metrics.ts` query reads it unchanged (idempotent on runId).
  `serve.ts` gained `POST /v1/ingest` + a `source` switch (`cache` default
  | `ingest`) + `--source` flag: **local serve keeps reading `cache.db`
  directly (zero-config L2, unchanged); hosted serve reads the push-fed
  ingest store**, so core's `cache.db` becomes private to a hosted
  deployment. `InvocationRecord` now public from `@vzn/vx`. Owner decisions
  taken (per the design's recommendations): L2 local-cache.db reader,
  hosted = run/task analytics only (cache inventory stays local), and accept
  the OTel de-hardcoding. The package-boundaries guard generalized to every
  `packages/*/src` (bare `@vzn/vx` only; core imports no sibling
  `@vzn/vx-*`). No CACHE_VERSION/SCHEMA bump — telemetry is a pure
  side-channel of events already emitted. Tests: `tests/telemetry.test.ts`
  - per-package suites (vx-otel 22, vx-http 19, cloud ingest/plugin).

- **2026-06-28**: **Dashboard Tier 3 — Phase B: the input-fingerprint
  diff, invocation context, tags/report, hit split** (read-side over the
  Phase-A schema; parallel agents on disjoint files). Queries
  (`metrics.ts`): `cacheKeyDiff(runId, taskId)` — the Develocity moat,
  resolving a run to its entry hash and anti-joining `entry_inputs`
  against the previous run's to name the exact added/removed/changed
  components (file OID / env / runtime / upstream / package / config /
  forward) with before→after; `getInvocation`; `listInvocations`
  reworked to read the `invocations` header table with branch/ci/tag
  filters (back-compat number arg kept); `getHitRateSplit` + local/
  remote series on stats + trends. CLI: `--tag k=v` (persisted on the
  invocation row) and `--report[=markdown]` (a moon-style per-task table
  to stdout, zero cost when absent). Endpoints (`serve.ts`): a diff
  route, an invocation-detail route, filtered invocations, and a
  cache hit-split route. UI: run-detail "Why did this re-run?" upgraded
  from "hash changed" to the real per-component diff table; Runs page
  gained branch/commit/CI/tags columns; cache + overview show the
  local-vs-remote split. Two integration fixes I made: threaded `tags`/
  `command` through `RunRequest` + the two protocol mappers (so `--tag`
  actually reaches the invocation row — it was being dropped), and fixed
  a PRE-EXISTING `getRun` truncation (it capped at the 500-row
  `listRuns` ceiling, dropping tasks on runs over 500 — so run-detail
  and the diff panel were incomplete on real monorepos; now returns the
  full run, with a 700-task regression test). Verified e2e over the
  Chrome DevTools Protocol against an 800-package workspace with a
  deliberately changed input: the why-card renders the changed file with
  before/after OIDs, the Runs page shows branch/commit/ci/tags, cache
  shows 799 local / 0 remote. No CACHE_VERSION/SCHEMA change beyond
  Phase A. Full suite 1000 core / 1055 root, 0 fail; lint+oxfmt clean;
  dist rebuilt. (The `vx watch` e2e flakes only under heavy machine load
  from leftover test serves and pass clean in isolation on every tree;
  pre-existing, unrelated.) That completes Tier 3.

- **2026-06-28**: **Dashboard Tier 3 — Phase A: schema + recording
  foundation (SCHEMA v22, NO `CACHE_VERSION` bump).** Implements the
  Phase-A slice of `docs/design/dashboard-tier3-2026-06.md` — the durable
  schema everything else reads. Two new SQLite tables. `invocations` is
  one header row per `vx run` (command, requested tasks, compact cache
  policy, concurrency, flow, started/ended, total duration, task/failed/
  hit counts split local-vs-remote, exit_ok, git commit/branch/dirty, ci
  - provider, host/os/arch, vx version, tags JSON). `run_task_inputs` is
    the input-fingerprint moat — one row per cache-key component per task
    per run (kind file/env/runtime/ws-runtime/upstream/package/config/
    forward/workspace, name, hash), captured for hits AND misses so the
    next run can diff against it. Both added to the schema DROP-gate;
    `SCHEMA_VERSION` rolled v21 to v22 (gate drops + recreates, pre-alpha
    no migration). The CACHE KEY is provably unchanged so `CACHE_VERSION`
    stays v24 — capture is a pure side-channel inside `Cache.key()`. New
    `CacheKeyInput.captureInto` is an optional sink that `key()` pushes
    each folded component into at the same fold sites (file rows reuse the
    already-awaited per-file OID — zero extra hash/stat/IO); a guard test
    proves a task's digest is byte-identical with and without
    `captureInto`. New `CacheKeyInput.upstreamIds` (hash to task id) is
    capture-naming only, never folded. The upstream-id seam:
    `filterUpstreamHashes` now returns `Array<[upstreamTaskId, hash]>`
    (dedup still by hash, the key fold still sorts by hash so derivation is
    identical); its lone caller is `task-hash.ts`, which splits the pairs
    back into `upstreamHashes` + an `upstreamIds` map. `TaskInputComponent`
    type lives in `task-hash.ts`, threaded through `computeTaskHash` via
    `captureInto`. `execute-task.ts` allocates the component array, passes
    it to the hash, and attaches it to the hit + miss outcomes (skipped on
    group/persistent/aborted). `TaskOutcome.inputComponents` is declared
    structurally inline in `scheduler.ts` (graph cannot import
    orchestrator). Recording: `Cache.recordRunBundle({runs, invocation,
inputs})` writes runs + the invocation row + all input rows in ONE
    transaction (one fsync); `InvocationRecord`/`TaskInputRow` types
    exported from cache. `run.ts` captures run context once
    (`run-context.ts`: `captureGitContext` = one git spawn per run behind
    try/catch with each field null-on-fail, `detectCi` over a CI env
    matrix, host/os/arch helpers), builds the invocation + input rows from
    the recorded list, and replaces the bare `recordRuns` call with
    `recordRunBundle`. New `RunOptions.tags`/`.command`/`.report` fields
    (CLI parsing is Phase B3; run.ts reads tags/command into the invocation
    row, defaulting command to `process.argv.slice(1).join(' ')`). Trust
    boundary called out in docs: `run_task_inputs` stores env/runtime
    values verbatim, consistent with cache.db already being a local
    gitignored single-user file; redaction is out of scope. Files: core
    `src/cache/{cache,layered-cache,index}.ts`,
    `src/orchestrator/{task-hash,upstream,execute-task,run,options,
run-context}.ts`, `src/graph/scheduler.ts`; docs `caching.md`,
    `modules/cache.md`; tests `cache.test.ts` (schema-gate recreates both
    tables, key-unchanged guard, captureInto completeness per the fold
    map, recordRunBundle round-trip with a cache-hit task getting input
    rows), `run-context.test.ts` (temp git repo sha/branch/dirty, CI
    matrix, non-git all-null no-throw), `orchestrator.test.ts` (e2e
    invocation row + per-task input rows over a real cache.db, hit
    included). Phase B (queries/endpoints/CLI tags+report/UI) is owned by
    other agents and never touches these files.

- **2026-06-28**: **Tier 3 Phase A — warm-path redesign (`run_task_inputs`
  → `entry_inputs`; capture is miss-only; ≤1 git spawn).** The first
  Phase-A cut above regressed WARM `vx run` ~21% (457ms baseline → 560ms
  on an 800-pkg/1600-task workspace) — it persisted per-task input rows
  keyed by `(run_id, task_id)` on EVERY run (incl. all-cache-hit warm
  runs, ~8000 INSERTs/run via `recordRunBundle`) and allocated +
  populated the `captureInto` component array on the HIT path too. Owner
  hard rule: **Tier 3 must not impact run performance.** Redesign,
  measured back to parity (warm median ~465-485ms vs an on-this-machine
  baseline of ~451-464ms — within noise; the regressed cut was 560ms).
  (1) **`run_task_inputs` → `entry_inputs`**, keyed by the cache-ENTRY
  hash (PK `(entry_hash,kind,name)`, FK→entries ON DELETE CASCADE), not
  a run. Written INSIDE the entry-save transaction
  (`writeArtifactAndIndex`) via `INSERT OR IGNORE` — so it persists ONLY
  on a cache miss/save; a HIT never saves, writes nothing; identical
  inputs (same hash) never re-write. DROP-gate drops both legacy
  `run_task_inputs` AND `entry_inputs`. `SCHEMA_VERSION` stays v22
  (uncommitted/unreleased; the bench clears the cache so a fresh gate
  recreates). (2) **Capture is miss-only.** `execute-task.ts` computes
  the PROBE hash with NO `captureInto` (warm path allocates nothing); on
  a miss, a second `computeTaskHash` with `captureInto` runs right before
  `cache.save` — the HashCache memos + gitFilesCache OID map make it a
  fold + array pushes (no re-stat/re-hash I/O), and it runs only where
  the task is about to spawn a subprocess anyway. The components pass to
  `cache.save({ inputComponents })` as `{entryHash,kind,name,hash}` rows.
  (3) **`recordRunBundle({runs,invocation})`** no longer takes/writes
  `inputs` — per-run recording is runs + the invocation header only.
  `run.ts` drops the per-task component loop. (4) **`TaskOutcome.
inputComponents` DROPPED** (the save reads components directly; no
  outcome plumbing). (5) **Git context cheapened**: `captureGitContext`
  is ONE spawn (`git rev-parse HEAD --abbrev-ref HEAD` → commit+branch);
  `dirty` is no longer probed there — it reuses the `git status
--porcelain` the `GitFilesCache` populate ALREADY runs for input
  enumeration, surfaced via new `GitFilesCache.worktreeDirty` and passed
  into `captureGitContext(root, dirty)`. Net ≤1 extra git spawn/run,
  still behind try/catch. The cache KEY is still byte-identical
  (`captureInto` remains a pure side-channel of `key()`; the
  key-unchanged guard test passes) — no `CACHE_VERSION` bump. Tests
  updated: `cache.test.ts` (entry_inputs populated on save, a
  warm-run-writes-nothing assertion, idempotent re-save adds nothing,
  schema-gate recreates `entry_inputs`), `orchestrator.test.ts` (miss
  writes entry_inputs reachable via `runs.hash`; warm hit adds zero
  rows but still records its invocation header), `run-context.test.ts`
  (one-spawn commit+branch, dirty passes straight through). Docs
  (`dashboard-tier3-2026-06.md` persistence + query sections,
  `caching.md`, `modules/cache.md`) updated to `entry_inputs` +
  `runs.hash → entry_inputs[entry_hash]` diff. Phase B's future
  `cacheKeyDiff` reads `entry_inputs` by the two runs' task hashes (not
  built). Files: `src/cache/{cache,inputs,layered-cache}.ts`,
  `src/orchestrator/{execute-task,run,run-context,task-hash,upstream}.ts`,
  `src/graph/scheduler.ts`. Full root `bun test` 1009 pass/0 fail; CI
  gate green.

- **2026-06-28**: **Dashboard competitive upgrade — Wave 2: run
  comparison + cache-entry inventory** (continues the competitive-
  research arc; see `docs/design/dashboard-competitive-2026-06.md`). Two
  parallel developer agents, disjoint file ownership. (C) **Run
  comparison** — the Develocity/BuildBuddy "diff two runs" marquee, MVP
  = a run vs its immediately-previous invocation: new core query
  `compareRuns(db, runId)` in `metrics.ts` (resolves the prior
  invocation by `started_at` like `whyDidThisRerun`, emits per-task diff
  rows `{a, b, hashChanged, durationDeltaMs, statusChanged}` + a
  summary), exported through `orchestrator/index.ts` + `src/index.ts`
  (boundary-test snapshot updated); a `GET /v1/compare/:runId` endpoint
  (cloud `serve.ts`, mirrors `/v1/runs/:id`); a `/#/compare/:id` view
  with header delta cards (this vs previous total, tone via `gt`) + a
  task diff `DataTable`; a "Compare to previous" entry card on the Runs
  page. (D) **Cache-entry inventory** — the Blacksmith "is my key
  actually hitting?" idea: the Cache page entries table gained a Heat
  column (cold = written but never re-hit since creation, i.e.
  `accessedAt − createdAt ≤ 2s`; stale = not hit in 14d), "Cold entries"
  - "Reclaimable bytes" headline metrics, Age/Last-hit columns, and a
    `vx cache prune` footnote — all via `functions.ts` `$computed` helpers
    reusing the existing `cacheEntries` source + `DataTable` dots (no
    api.ts/data.ts change). Read-only throughout: no CACHE_VERSION/SCHEMA
    bump. Verified e2e over the Chrome DevTools Protocol against the real
    cache.db — both `/#/compare/:id` (real prev-run diff, −179ms delta)
    and the enhanced `/#/cache` render console-clean. Full suite 990 pass/
    0 fail (1007 across 71 files, incl. new metrics + serve compare
    tests); lint+oxfmt clean; dist rebuilt once (298 KB / 82 KB gzip).
    Tier 3 (git/commit context, persisted per-run input fingerprints for
    a full input-file diff, invocation header table + tags, local-vs-
    remote hit-rate split) remains a deferred schema-bump follow-up.

- **2026-06-28**: **Dashboard competitive upgrade — Wave 1: cache-miss
  explainability + critical-path cockpit** (owner: "deep research on nx
  cloud nx and turbo repo and others… what features they have in
  dashboard what they miss how could we make them better and implement.
  Spawn agents parallel"). A six-agent parallel research sweep (Nx
  Cloud, Turborepo/Vercel, Gradle Develocity, BuildBuddy/Bazel, a
  second-tier roundup, plus an inventory of our own UI/serve/metrics/
  cache.db) produced `docs/design/dashboard-competitive-2026-06.md` — a
  ranked Tier 1-3 gap analysis. Key finding: the field's #1 feature
  (cache-miss "why") was already ~80% built in our backend
  (`whyDidThisRerun` + `/v1/why/:runId/:taskId`, and `explainCacheKey` +
  `/v1/explain/:taskId`) with ZERO UI. Wave 1 (two parallel
  developer agents, disjoint file ownership): (A) surfaced both — a
  "Why did this re-run?" card on run-detail (per-task hash-changed +
  reason, prev→current key, via a `runWhy` source that fetches the run
  then fans out `/v1/why` per task) and a "Cache key" card on
  task-detail (the existing `explainCacheKey` wrapper); honest framing,
  no false input-file-diff claim (the full per-file diff needs persisted
  fingerprints, deferred Tier 3). (B) added a `critical-path.ts` util
  (longest-duration dependency chain, O(N+E), cycle-guarded) + a live
  Critical-path panel in the run cockpit: ordered clickable chain with
  the wall-time floor, DAG/flamegraph highlight of the chain, and a
  parallelism callout (observed peak concurrent vs the worker count from
  `run:start.info.concurrency`). Frontend-only; the two endpoints +
  queries already existed, so no `src/`/`packages/` change, no
  CACHE_VERSION bump. Verified e2e over the Chrome DevTools Protocol
  against the real cache.db: both cards render (console clean) and a
  driven live `lint` run computes + renders "These N tasks are your X
  floor" with the parallelism callout. Embedded SPA dist rebuilt once at
  integration (293 KB / 81 KB gzip). Core gate green (952 tests, 0
  fail). NEXT (Wave 2): run comparison (diff two runs), a filterable
  cache-entry inventory with a cold/never-rehit flag, and a local-vs-
  remote hit-rate split. Tier 3 (git/commit context, persisted input
  fingerprints for the full Develocity-grade diff, invocation header
  table + tags) is a deferred schema-bump follow-up.

- **2026-06-27**: **Split fallout fix — `vx serve` launch path restored
  (owner: "it is all not working. seams like you have shitt tests").**
  The core/cloud split removed serve/dev/coordinator/worker from core
  (the owner's explicit "no cli in core"), but left no bridge: typing
  `vx serve --ui` hit a bare `vx: unknown command: serve` and the
  replacement `vx-cloud` was not runnable in-repo (not on PATH, not in
  `node_modules/.bin`). Diagnosis (drove the real app over the Chrome
  DevTools Protocol + a live WS run, not just unit tests): the dashboard,
  `/v1/*` API, `/v1/graph`, and the live cockpit at `/#/run` all WORK via
  `vx-cloud serve` — the break was purely the CLI launch path, and the
  tests missed it because they exercise serve via `startServe`/the bin
  file, never the command a user types nor whether `/` actually serves
  the SPA. Fixes, all additive: (1) core's dispatcher now answers
  serve/dev/coordinator/worker with a clear redirect (run `vx-cloud
<cmd>`, install `@vzn/vx-cloud`, or `bun packages/cloud/src/cli/bin.ts
<cmd>` in-repo) instead of a dead-end; (2) `scripts/link-self.ts`
  postinstall now also symlinks `node_modules/.bin/vx-cloud` → the cloud
  bin and chmods it `0755`, so `bunx vx-cloud serve --ui` works in-repo
  and survives a frozen install; (3) two regression tests that would
  have caught it — core CLI asserts each moved command redirects to
  `@vzn/vx-cloud` (not "unknown command"), and the serve suite asserts
  `GET /` serves the embedded dashboard HTML and a deep app route falls
  through to the SPA while `/health` stays JSON. Verified e2e: launched
  via `bunx vx-cloud serve --ui`, all routes render real data with a
  clean console; root `bun test` 984 pass/0 fail. No core behavior or
  CACHE_VERSION change. Owner's workflow is `vx-cloud serve --ui` now
  (one word longer than before); if that friction isn't wanted, pulling
  serve back into core is the open alternative.

- **2026-06-27**: **Core/cloud split — Phase 4: Docker image + Helm
  chart skeleton for `@vzn/vx-cloud`** (completes the "do all t final
  state" arc; Phases 5–7 stay deferred as future designs per
  `docs/design/core-cloud-split-2026-06.md` §11). Implements §8 ("local
  or hosted — same artifact, roles collapse locally, scale out
  hosted"). New `packages/cloud/Dockerfile` (multi-stage, ROOT build
  context `docker build -f packages/cloud/Dockerfile -t vx-cloud .`):
  build stage `oven/bun:1.3` → `COPY . .` → `bun install
--frozen-lockfile` (runs the `scripts/link-self.ts` postinstall that
  re-creates `node_modules/@vzn/vx → root`) → `bun build --compile
packages/cloud/src/cli/bin.ts` to one standalone binary; runtime stage
  `oven/bun:1.3-slim`, non-root `bun` user, `EXPOSE 4321 5180`,
  `HEALTHCHECK` on `/health`, `ENTRYPOINT ["vx-cloud"]` + `CMD
["serve"]` (role chosen by CMD: serve = collapsed-local, coordinator,
  worker). The SPA is NOT rebuilt — the committed `apps/ui/dist/
index.html` is authoritative (embedded by `ui-asset.ts` at compile
  time), keeping the image lean + the build read-only w.r.t. the repo
  (the `vite build` alternative is documented in a Dockerfile comment).
  `packages/cloud/.dockerignore` keeps the context lean. New Helm chart
  `packages/cloud/deploy/helm/vx-cloud/` (Chart.yaml v2 / values.yaml /
  values-local.yaml + 12 templates): coordinator Deployment+Service
  (+Ingress gated `ingress.enabled`, TLS/wss; readiness `/health`,
  startup `/version`), worker Deployment (`--coordinator <svc-dns>`,
  `terminationGracePeriodSeconds: 120` for the `coord:drain`→`worker:bye`
  graceful drain), worker HPA (CPU target + an optional `queue_depth`
  custom metric, DISABLED by default with a metrics-adapter note), cache
  PVC (gated `cache.backend == fs`; `s3`/`r2` are values knobs riding
  the `CASBackend` interface), insights PVC (gated `sqlite`), secrets,
  serviceaccount, NOTES. A `mode: hosted|local` toggle makes §8.1's
  collapsed-local single `serve` pod a first-class installable mode
  (`serve-deployment.yaml`), not just a documented `docker run`.
  `deploy/README.md` documents both topologies, the exact build/install
  commands, the values knobs, and — honestly — that this is a SKELETON:
  the coordinator is still ephemeral-per-run and the
  `s3`/`r2`/`postgres` and `VX_CLOUD_*` env knobs are forward-looking
  wiring for Phases 5/6 (persistent coordinator, blob-CAS input
  shipping) that the binary does not yet read; defaults
  (`coordinator.replicas: 1`, `cache.backend: fs`) reflect today's
  reality. One tracked-file edit: `.oxfmtrc.json` added
  `packages/cloud/deploy` to `ignorePatterns` (same precedent as the
  `apps` exclusion) so `oxfmt --check .` doesn't try to format the Helm
  template YAML (which contains braces) and fail the gate. No core
  `src/` changes, no tests, no CACHE_VERSION bump — pure additive infra.
  Docker build NOT exercised end-to-end (no daemon/socket in this env —
  verified the Dockerfile by review and the load-bearing `bun build
  --compile` step independently: 183 modules to a runnable binary);
  Chart/values parse as YAML, all 12 templates have balanced braces and
  blocks, worker-deployment renders to valid k8s with defaults. CI gate
  green. Recommend a one-off `docker build` on a host with a running
  daemon before relying on the image.

- **2026-06-27**: **Core/cloud split — Phase 3: the first-party
  `cloud()` plugin** (owner: "cloud should be integrated through a
  plugin… anyone could choose to do differently" → "do all t final
  state"). Implements Phase 3 of
  `docs/design/core-cloud-split-2026-06.md`. New
  `packages/cloud/src/plugin.ts` exports `cloud(opts?:
CloudPluginOptions): VxPlugin` (name `'vzn/cloud'`), declared via
  `defineWorkspace({ plugins: [cloud()] })`, contributing all three
  run-level capabilities against core's shipped `VxPlugin` interface —
  each independent and zero-config via env-var fallbacks: **(backend)**
  returns the cloud `resolveBackend(cwd, undefined, serviceUrl)` —
  delegate to a reachable `vx-cloud serve` (the serve-info discovery
  that LEFT core in Phase 2), else local-dev mirror; always returns a
  backend, so with the plugin present runs behave like pre-split core,
  without it core uses plain `localBackend()`. **(cache)** when
  `cacheUrl`+`cacheToken` (or `VX_REMOTE_CACHE_*`) are set, builds `new
LayeredCache(localCache, new RemoteCache({…}), { policy, onRemoteError
})` faithfully mirroring core's `remote-cache-setup.ts`
  (teamId/slug/signatureKey/timeoutMs honored); declines (`undefined`)
  when unconfigured → core's env fallback still applies. **(eventSink)**
  when `insightsUrl` (or `VX_CLOUD_INSIGHTS_URL`) is set, an
  `InsightsSink` buffers WireEvents and POSTs them as one NDJSON body
  with a Bearer token; declines when unconfigured. **(setup)** validates
  the three URLs are well-formed (boundary check → `UserError`).
  **Lifecycle finding (load-bearing):** core never invokes
  `plugin.teardown()` nor `EventSink.flush()` — `run.ts`'s finally only
  disposes bus subscriptions (`plugin-host.ts`'s `subscribeEventSinks`
  disposer just unsubscribes). So `InsightsSink` self-flushes on the
  terminal `run:end` WireEvent inside `onEvent` (idempotent via an
  `uploaded` guard); `flush()` is kept as a best-effort fallback for a
  future host that does await it. `onEvent` never throws (fetch errors
  swallowed, 5s timeout) — observability can't break a run. **One
  minimal core-of-cloud change:** `packages/cloud/src/cli/backend.ts`'s
  `resolveBackend` gained an optional third `serviceUrl?` param
  (preferred over `VX_SERVICE_URL`/serve-info when set); the existing
  env→serve-info→local fail-safe chain is unchanged. **No core `src/`
  changes, no CACHE_VERSION/SCHEMA bump** — additive in `packages/cloud`
  only (4 files: new `plugin.ts` + `tests/plugin.test.ts`, modified
  `index.ts` exports + `backend.ts` param). Verified: core gate green,
  root `bun test` 979 pass/0 fail (996 across 71 files), cloud
  standalone 48 pass/0 fail (11 new plugin tests), boundary guard
  intact. NEXT: Phase 4 — Docker + Helm skeleton (multi-role vx-cloud
  image; coordinator Service, worker Deployment + HPA, shared CAS).

- **2026-06-27**: **Core/cloud split — Phase 2: `@vzn/vx-cloud`
  extracted to `packages/cloud`** (owner: "I would want a total split.
  2 packages. Vx that is core and vx cloud that is a hosted service
  that orchestrates… cloud should be integrated through a plugin… No
  cli. Vx cloud can have its own cli. Vx is limited… Do it nicely the
  best you can keep separation and plugin flexibility" → "do all t
  final state"). Implements Phase 2 of
  `docs/design/core-cloud-split-2026-06.md` (Phase 1 = plugin
  extension points, `495ac66`). The service layer LEFT core: `cli/
{serve,coordinator,worker,dev,dev-client,ui-asset,ui-server}.ts` +
  `orchestrator/coordinator-prepare.ts` moved to `packages/cloud/src/`,
  rewired to import core via the bare `@vzn/vx` specifier; new
  cloud-only `protocol-dist.ts` (the `WireTaskNode`/`WireOutcome` +
  `worker:*`/`coord:*` JSON-RPC families), `cli/backend.ts`
  (`serviceBackend`/`resolveBackend`/`localDevBackend`), `cli/bin.ts`
  (the `vx-cloud` dispatcher), `index.ts`. **`worker-exec.ts` and
  `metrics.ts` STAYED in core** (exported publicly — they're execution/
  query primitives, not service plumbing). Core `cli/run.ts`'s backend
  fallback is now `() => Promise.resolve(localBackend())` — pure core
  no longer auto-delegates to a running serve (cloud owns delegation in
  Phase 3 via its plugin). Core `vx --help` drops serve/dev/worker/
  coordinator and points at the `vx-cloud` binary; `vx-cloud --help`
  dispatches them. `protocol.ts`/`wire.ts` narrowed to the base
  envelope + event/result/error/run messages; `src/index.ts` expanded
  to the ~80-symbol public API the cloud package consumes (pinned by
  the boundary test). **Load-bearing infra:** Bun can't resolve a
  member's `"@vzn/vx": "workspace:*"` against the root `"."` member, so
  `packages/cloud` does NOT declare `@vzn/vx` as a dep — a root
  `postinstall` (`scripts/link-self.ts`) symlinks `node_modules/@vzn/vx
→ <root>` and cloud imports the bare `'@vzn/vx'` through the root's
  `exports` map; survives `bun install --frozen-lockfile` (CI's
  command, verified). `packages` removed from oxlint/oxfmt
  `ignorePatterns` (cloud is linted/formatted like core; `apps` stays
  ignored for solid-js JSX); `scripts/**` added to tsconfig include.
  Dogfood `test` task switched `bun test tests/` → `bun test ./tests/`
  so the bare substring no longer pulls `packages/cloud/tests/` into
  the core gate (cloud tests run via the package's own `bun test`; a
  clean root `bun test` still runs everything). Tests relocated to
  `packages/cloud/tests/` (serve/distributed/ui-server/dev-hub/wire-
  dist); `tests/package-boundaries.test.ts` added (core never imports
  `@vzn/vx-cloud`; cloud imports core only via the bare specifier). No
  CACHE_VERSION/SCHEMA bump (key derivation + artifact bytes
  untouched). Verified: core gate green, root `bun test` 968 pass/0
  fail (985 across 70 files), core-only 931 pass, cloud standalone 37
  pass, boundaries 3 pass, frozen install re-links + cloud resolves 81
  core exports. **Known follow-up:** the broader `docs/` (architecture/
  cli refs still calling `vx serve` a core command) are stale — a doc
  pass is pending. NEXT: Phase 3 — the first-party `cloud()` plugin
  (`packages/cloud/src/plugin.ts`) contributing backend (submit to
  coordinator + serve-info discovery, moved out of core) / cache /
  eventSink.

- **2026-06-27**: **Dashboard restyle + run-centric cockpit with a live
  task graph** (owner: "make the ui prettier… make it modern" → "focus the
  ui on flows of actual development… from working with nx locally" → "runs
  should be visualized with a graph, each node with status + a progress
  bar… display logs for a task… rerun while in progress" → "let's forbid
  running while in progress for now"). Two strands, owner-picked via
  AskUserQuestion (refined custom theme over DaisyUI — DaisyUI's current
  major is Tailwind-4-first and doesn't plug into our UnoCSS; run-centric
  focus over analytics). **(1) Restyle** (`bfe…`/`73252c0`): modern dark
  look — violet/cyan aurora bg, rounded-xl cards + shadows, pill badges,
  gradient-tinted metric cards, glassy chrome, **detached floating
  sidebar**. Fixed a SYSTEMIC bug found along the way: color tokens were
  hex `var()`s, so UnoCSS silently DROPPED every `/N` alpha
  (`.bg-accent/10 → background:var(--accent)` full-strength) — that's why
  the analytics cards rendered loud/unreadable and the active nav was a
  solid block. Tokens are now RGB CHANNELS exposed via `rgb(var(--x) /
<alpha-value>)`, so opacity modifiers work everywhere (one raw usage,
  StatusDot, wrapped in `rgb()`). **(2) Run cockpit** (`/run`, new
  `RunConsole.tsx`, dedicated interactive route — NOT pure-JSON, since a
  live WS-driven console can't be expressed as data): enter a task → it
  fetches the DAG and opens a WS to vx serve; streamed `task:start/stdout/
stderr/complete` events drive each node's live status, an overall
  progress bar, and per-task log capture (ANSI-stripped). The graph is a
  real DAG — new server endpoint `GET /v1/graph?tasks=…` runs a no-exec
  `planRun` and returns nodes + dependency edges + predicted cache status
  (`src/cli/serve.ts`); the client lays it out layered (longest-path
  layering, `run-graph-layout.ts`) with SVG edges, clickable nodes →
  log panel. A **Graph/Flame toggle** switches the SAME live run between
  the DAG and a flamegraph timeline (reusing the run-detail
  `FlamegraphPrimitive`, fed by client-recorded task start/end timings;
  in-progress bars grow via a 250ms tick; clicking a bar selects the task
  and shows its logs too). **Rerun is FORBIDDEN while a run is in progress** (Run button
  disabled until it finishes) — one run at a time sidesteps the
  output-cleaning race between overlapping different-hash runs (the
  in-flight hash-dedup already makes same-input reruns safe; true
  concurrent safety needs the global scheduler / output RW-locks in
  docs/design/execution-service-2026-06.md — deferred). Nav now leads with
  Run. Verified e2e: triggered a real `lint` run, watched 3 nodes + 2
  edges go success/failed live, progress 2/2, logs streamed on click, 0
  console errors. New `/v1/graph` server test. apps + serve only; core
  cache/exec untouched, no CACHE_VERSION impact.

- **2026-06-27**: **`vx serve` defaults to a STABLE port** (owner: "when
  I stop the server and rerun I get a new port even if old is unused
  why"). Root cause: `startServe` bound `port: opts.port ?? 0`, and port
  0 makes the kernel hand out a fresh ephemeral port every run — it never
  tried a stable default, so the old port being free was irrelevant. Now
  the default is `DEFAULT_SERVE_PORT = 4321` (matching the dashboard SPA's
  own default origin in `apps/ui/src/api.ts`), so the URL is the same
  across restarts. If 4321 is already taken, `startServe` falls back to an
  ephemeral port instead of crashing — UNLESS the user pinned `--port`,
  in which case a busy port surfaces the bind error (explicit intent is
  honored). The big `Bun.serve({...})` literal was factored into a
  `listen(port)` arrow so it can be retried on a second port. `.vx/
serve.json` still advertises the chosen origin for `vx run` delegation.
  Files: `src/cli/serve.ts` (constant + try/fallback), `src/cli/help.ts`,
  `docs/cli.md`. Verified: restart reuses :4321; a second concurrent
  instance falls back to an ephemeral port.

- **2026-06-27**: **Dashboard `jr` folder made idiomatic + interactive
  flamegraph + Runs tab** (owner: "simplify jr code folder... all by the
  book. study each page of docs from gh" → then "flame graph need to be
  more interactive with a timeline and a point of time. i should be able
  to click on tasks to see details in some panel... start end and
  duration. Add Runs tab. cache tab still shows nothing"). Studied the
  json-render docs + Solid example in the `vercel-labs/json-render` repo
  (the site 403s automation; the repo source is authoritative). Key
  finding from the compiled `@json-render/solid`: `defineRegistry` ALREADY
  wraps each component with a reactive `get props()` returning
  `element.props` live AND wraps every element in its own `ErrorBoundary`
  — so the prior `adapt()` + `px` Proxy bridge in `jr/renderer.tsx` was
  redundant double-wrapping. **Refactor (#14):** every catalog component
  is now a native json-render component taking `BaseComponentProps<P>`,
  reading `c.props.X` / `c.children` / `c.emit` live; they register
  DIRECTLY (no adapter). Deleted dead `jr/spec.ts` (nothing imported it;
  the loader uses `nestedToFlat`). Hardened `jr/page.tsx`: it reads
  `res.error` BEFORE the resource value (an errored resource accessor
  re-throws, which blanked the whole page) and wraps render in an
  `ErrorBoundary` — a single failing data source now degrades to a
  per-section empty state. This is the real fix for the **"cache tab shows
  nothing"** class (could not reproduce against the committed dist — 77
  entries + all metrics render — so on the owner's machine it is a stale
  COMPILED binary, which embeds the SPA at `bun build --compile` time;
  rebuild the binary or run from source). Zero behavior change, verified
  e2e across all routes. **Runs tab (#12):** new top-level nav entry +
  `views/runs.json` (summary metrics + sortable/filterable table of all
  invocations, rows link to run detail) + `invocationsAll` source.
  **Interactive flamegraph (#13):** `components/Flamegraph.tsx` gained a
  duration time axis, a point-of-time hover cursor (vertical line + time
  readout), and clickable bars. Clicking writes the task to
  `/selectedTask` via json-render's `useStateBinding` (the idiomatic
  hook-driven path for a self-contained widget); a `visible`-gated detail
  panel in `runDetail.json` binds to it and shows status / started / ended
  / duration / CPU / peak RSS / exit / hash; the selected bar is outlined.
  apps-only; core `vx` untouched, no CACHE_VERSION impact. Commits
  `bfe8142` (refactor + loader) and `547a2cb` (Runs + flamegraph).

- **2026-06-27**: **Granular cache read/write control — 4-axis
  `CachePolicy` replaces the single `noCache` boolean; `--force` is no
  longer an alias of `--no-cache`.** The cache now has four independent
  axes — `localRead` / `localWrite` / `remoteRead` / `remoteWrite` —
  defined in `cache/cache.ts` (`CachePolicy`, `FULL_CACHE_POLICY`,
  `parseCachePolicy`) and re-exported from `cache/index.ts`. Enforcement
  lives INSIDE the cache layers at construction: `new Cache(dir, {read,
write})` gates ONLY the task-artifact `get`/`save` (returns null when
  `!read`, skips the artifact + index row when `!write`) — `recordRun` /
  `stats` / `prune` / `ingest` / hashing are untouched; `LayeredCache`
  takes the full policy and gates its own remote read-through (`get`),
  upload (`save`), and `prefetch` (no-op when `!remoteRead`).
  **Subtle-correctness fix:** when `localWrite` off but `remoteWrite` on
  (`--cache=local:,remote:rw`), there's no on-disk artifact to upload, so
  `LayeredCache.save` packs the tar.zst bytes in memory via the new
  `Cache.packArtifactBytes` (gated on `Cache.localWritesEnabled`) — pinned
  by a new e2e test. `LayeredCache`'s `local` param tightened `CacheLayer`
  → `Cache` (always was). CLI (`cli/run.ts`): three flags resolve a policy
  in precedence order — start all-on → apply each `--cache=<spec>` /
  `--cache <spec>` (comma list of `<layer>:<flags>`, layer∈{local,remote},
  flags⊆{r,w}; a named layer set EXACTLY, unnamed kept) → `--no-cache`
  forces all four false → `--force` forces both reads false (writes kept).
  So **`--no-cache` beats `--force`**, and `--force` now means
  "re-execute everything but still refresh the cache" (writes on → outputs
  ARE cleaned before exec). `RunArgs.noCache` → `RunArgs.cache:
CachePolicy`; `RunOptions.noCache` → `RunOptions.cache?: CachePolicy`
  (default FULL). Threaded end-to-end, REPLACING `noCache`:
  `orchestrator/{options,run,execute-task,plan,remote-prefetch,protocol,
prepare,remote-cache-setup}.ts` + `cli/run.ts`. `execute-task`'s
  `cacheEnabled` became `willRead = cfgCacheable && (localRead ||
remoteRead)` / `willWrite = cfgCacheable && (localWrite || remoteWrite)`;
  the pre-exec output wipe (`cleanOutputs`) now gates on `willWrite` (so
  `--no-cache` still leaves the tree alone, `--force` cleans). `plan.ts`
  predicts misses for a no-read policy (correct — those tasks WOULD
  re-execute). `remote-prefetch` short-circuits on `!remoteRead`. Wire
  `RunRequest.noCache` → `cache?: CachePolicy` (both mappers). **No
  CACHE_VERSION / SCHEMA bump** — key derivation and artifact bytes are
  untouched; only WHEN reads/writes fire changed. Tests: `parseCachePolicy`
  unit suite (cache.test.ts), CLI parser suite for all three flags +
  precedence + invalid specs (cli.test.ts), e2e for `--force`
  (re-execute + refresh → next run hits), `local:r` (hit restores, miss
  doesn't write), `local:,remote:rw` (uploads without a local artifact),
  plus the existing `--no-cache` e2e updated to the renamed field. Docs:
  `docs/cli.md` § Cache control, `docs/caching.md` § Cache policy. 956
  tests pass, lint+format clean.

- **2026-06-27**: **Dashboard UI (`apps/ui`) rewritten on json-render**
  (owner: "completely redo whole ui using https://json-render.dev/" —
  chosen with the tradeoffs made explicit). The entire page layer now
  renders through json-render (`@json-render/solid` + `@json-render/core`)
  instead of hand-written Solid pages — used the intended way: a component
  **catalog** + per-page **data specs** the `Renderer` instantiates. New
  `apps/ui/src/jr/`: `catalog.ts` (`defineCatalog` — the component
  vocabulary), `components.tsx` (the Solid impls behind each name: layout
  `Page`/`Stack`/`Grid`/`Card`, content `Metric`/`Text`/`Facts`/`Empty`,
  chart wrappers `LineChart`/`Treemap`/`Heatmap`/`Flamegraph`, and the rich
  self-contained widgets `DataTable` (client sort/filter + clickable rows),
  `RankList`, `LiveActivity` SSE ticker), `renderer.tsx`
  (`createRenderer(catalog, components)` → `<DashRenderer>` — a
  self-contained renderer; it wires the State/Action/Functions providers
  internally), `spec.ts` (`el()`/`toSpec()` — author a nested tree, flatten
  to the json-render `Spec` via the library's own `nestedToFlat`),
  `hints.ts` (declarative format/tone hints so specs stay **pure JSON** — no
  formatter functions on the wire; charts take `xFormat`/`yFormat` hint
  strings, table cells carry a `kind` + tone token). Every page (Overview,
  Tasks, TaskDetail, Projects, ProjectDetail, Cache, Trends, RunDetail,
  Bottlenecks) renders the same `/v1/*` resources through `Dash`. **`api.ts`,
  `format.ts`,
  `charts.tsx`, `ui.tsx` and the router are UNCHANGED** — the proven
  chart/UI code is reused as json-render's component library (the right way
  to adopt it). Carried-over fixes preserved: CPU utilization % (avg/max
  card + per-run column, green >100%), correct cross-platform peak RSS,
  full-size ResizeObserver-measured charts. UnoCSS `safelist` extended for
  the semantic dot/bar tones the catalog references by token (chart-1..8
  already listed; added `bg-/text-` for success/warn/danger/accent/
  cache-local/info). Deps added to `apps/ui` ONLY (`@json-render/core`,
  `@json-render/solid`, `zod` — 4 packages); **core `vx` untouched** (still
  19 deps). Embedded single-file SPA grew ~131 KB → 242 KB raw / 71 KB gzip
  (the interpreter) — acceptable for the embed. **Caveat to remember:**
  UnoCSS's static extractor parses `text-[${expr}]` arbitrary-value
  template literals and emits invalid CSS — never interpolate into bracket
  utilities in a scanned file; pass arbitrary classes through a `class`
  prop literal in page source instead. Verified e2e with Playwright against
  the real workspace `cache.db` (259 runs, 70 entries) across all 9 routes:
  0 console errors, real data, correct nav, charts filling cards. No
  CACHE_VERSION/core-test impact (UI-only; `apps` is excluded from
  oxlint/oxfmt and not covered by `bun test`, so validated at build +
  runtime). PRs #149 (RSS/CPU%/chart fixes) + #150 (initial rewrite) +
  #151 (idiomatic refactor). NB: json-render did not itself fix any
  data/chart complaint (those were backend/component issues fixed in #149)
  — its value is that the dashboard is now spec-driven, so a view could
  later be AI-generated against the same catalog.

  **Idiomatic refactor (owner: "why is it so complex? json-render should
  have easier ways?").** #150's pages built specs imperatively
  (`build(data) → Spec`) and tables carried a per-cell display-object DSL —
  real custom syntax. Reworked to json-render's intended data-binding model
  (owner picked it over trimming or reverting, tradeoffs explicit): each
  page is now a **static, data-independent `Spec`** (module constant) whose
  props bind to the page's **raw `state`** via `$state` / `$computed`
  (formatters live in `jr/functions.ts`, keyed by name) / `$template` /
  `$cond`, with sections gated by element-level `visible` conditions.
  `DataTable`/`RankList` take **raw rows + declarative columns** (`kind` +
  optional `baseTone`/`tone` rule + `*Key` field refs); the component
  formats internally via `format.ts` — **the per-cell DSL is gone**, pages
  just shape `state` (raw API rows + a few derived `_frac`/`_color`/`_href`
  fields). `spec.ts` gained `el(type,props,children,opts)` (opts carries
  `visible`/`repeat`, both preserved by `nestedToFlat`) + `S`/`C`/`T`
  directive shorthands; `renderer.tsx` exposes `Dash` (injects the
  `functions` map). **Hard-won reactivity bug:** json-render passes the
  resolved `element` to components as a REACTIVE getter (it tracks the
  resolved-props memo), so a component must read `rp.element.props` LIVE —
  snapshotting `const p = rp.element.props` once at setup freezes the
  loading-state props and the view never updates when async resources
  resolve. Ungated tables stayed empty while `visible`-gated detail pages
  (which remount after load) worked, which is what surfaced it. Fix:
  `px(rp)` returns a Proxy that forwards every access to the current
  resolved props, so reading `p.x` inside JSX/memos stays reactive.
  `StateProvider` reactivity confirmed from source — it diffs
  `props.initialState` by reference and `store.update`s changed JSON
  pointers, so passing a fresh `state()` object each tick re-renders;
  `flattenToPointers` treats arrays as leaf values so `{$state:'/rows'}`
  yields the whole array. Re-verified e2e across all 9 routes (0 errors,
  full fidelity — sortable headers, dots, tone bars, CPU%/RSS).

  **Two-way catalog (owner: "make it 2-way — either raw JSON or JSX with
  components, one catalog to build UI" + "why not use defineRegistry +
  Renderer?").** The catalog is now ONE set of **plain Solid components**
  (`jr/components.tsx`: `Page`/`Grid`/`Card`/`Metric`/`Text`/`Facts`/`Empty`/
  `LineChart`/`Treemap`/`Heatmap`/`Flamegraph`/`DataTable`/`RankList`/
  `LiveActivity` — each takes ordinary props + `children`), usable two ways:
  (1) **directly in JSX** — the 9 pages are now plain Solid
  (`<Card noPad><DataTable rows={rows()} columns={COLS} /></Card>`), no
  specs/`$state`/`toSpec`; (2) **via raw-JSON specs** through json-render —
  `jr/renderer.tsx` exposes the SAME components to json-render via the
  documented `defineRegistry` + `<Renderer>` API (switched off
  `createRenderer`, which was just sugar over providers), wrapped in
  `JSONUIProvider` for `$state`/`$computed` binding and rendered by `Dash`.
  Glue is one `adapt(Comp)` that forwards json-render's reactive
  `ctx.props`/`ctx.children` to a plain component via a live proxy (same
  reactivity reason as before). `pages/SpecDemo.tsx` (route `/spec`, not in
  nav) renders a literal flat `Spec` bound to live `state` — proof + living
  reference for the JSON path. **Net: the dashboard is back to plain Solid**
  (pages dropped all spec machinery), and **json-render is now OPTIONAL** —
  with no routed page using `Dash` the whole interpreter tree-shakes out
  (bundle 246 KB → 119 KB / 35 KB gzip); the `/spec` demo is what pulls it
  back in (245 KB). So: simple hand-authored pages by default, json-render
  available the moment a JSON/AI-generated view is wanted, both off one
  catalog. `spec.ts` (`el`/`toSpec`/`S`/`C`/`T`) kept as the ergonomic
  JSON-spec authoring helper. Verified e2e: all 9 JSX routes + `/spec`
  (raw JSON, `$computed`/`$state`-bound metrics + DataTable) render against
  the real cache.db, 0 errors. PR #152.

  **Fully pure-JSON pages (owner: "make only components, define registry,
  all pages/views pure json — no generation, new syntax" + "we should have
  a folder called views with all json files").** The JSX pages are GONE;
  every view is now a pure JSON file in `apps/ui/src/views/*.json`
  (`{ data, spec }` — `data` maps a state key to a named source, `spec` is a
  nested json-render tree). The ONLY code is: the catalog components
  (`jr/components.tsx`, now fully data-driven — they absorb ALL derivation
  so the JSON stays raw: `rowHref`/`rowTaskRef` link templates, `colorFrom`
  palette, auto bar-max + fraction, `dots:[{field,map}]`, `cpuPct`/`bar`/
  `shorthash` column kinds, charts take `rows`+field keys, `Facts` takes
  `entry`+field list), the registry (`defineRegistry`), a generic loader
  (`jr/page.tsx` `jsonPage(view)` — fetches each declared source into
  `state`, exposes decoded route `params` + a `<key>Status`
  loading/missing/ok flag for `visible` gating, flattens nested→flat via
  `nestedToFlat`, renders through `Dash`), named data sources
  (`jr/data.ts`), and `$computed` helpers (`jr/functions.ts`: formatters +
  `agg`/`aggFmt`/`ratioFmt`/`aggTone` array aggregations + `text` templating
  - `gt`/`lt`/`palette`/`countWhere`/`span`/`cpuStat`). Metric values/subs
    are `$computed` over raw `$state` arrays (e.g. total runs =
    `aggFmt(sum projects.runs)`; run wall time = `span(tasks)`; CPU% =
    `cpuStat(recent)`); tones via `$computed`/`$cond`; section gating via
    element `visible` on `<key>Status`. **UnoCSS gotcha:** UnoCSS only scans
    code files, so chart `stroke-`/`fill-` tokens that now live ONLY in the
    JSON were dropped until `uno.config.ts` got `content.filesystem:
['src/views/**/*.json']`. Net: the dashboard is spec-driven end to end —
    a view is data, hand-authored OR machine-generated, against one catalog;
    json-render is the engine (always bundled now, ~248 KB / 72 KB gzip).
    Verified e2e against the real cache.db, all 9 routes, 0 console errors,
    full fidelity (CPU%/RSS, `span`/`countWhere` run metrics, tones, palette
    dots, bars, charts/treemap/heatmap/flamegraph). `spec.ts`'s `el/toSpec`
    helpers are now unused (the loader uses `nestedToFlat` directly) but kept.

- **2026-06-27**: **Pure-JSON dashboard follow-up fixes** (owner: "tons of
  ts errors. Not working cache tab, no runs, not working flame graph. no
  cpu % on tasks in runs"). The `views/*.json` conversion shipped with a
  stale `dist` and three real regressions, all fixed. (1) **~21 TS errors**
  — `getHistory` takes `{ limit }` not a number (`jr/data.ts`,
  `CommandPalette.tsx`); optional route params need a `?? ''` fallback
  (`getTaskDetail`/`getRun`); json-render's ctx props are typed `unknown`
  not `Record` (`renderer.tsx` `JrCtx`); the catalog was missing the
  required `actions: {}` (`catalog.ts`). tsc now clean. (2) **Flamegraph
  dropped every cache-hit task** — it keyed off `wallclockStartNs`/`EndNs`,
  which are null for restored tasks, so a 3-task run drew 1 bar. Switched
  the time base to `startedAt`/`endedAt` (epoch ms, present on every row)
  and replaced project-lanes with greedy time-packing in
  `flamegraph-layout.ts` (each task takes the first lane whose previous bar
  finished), so lanes now reveal parallelism and cache hits render as thin
  marks. (3) **Run-detail tasks table had CPU time but no utilization %** —
  added a `cpuPct` column (dashed for cache hits, green > 100%), matching
  the task-detail page. The "cache tab not working / no runs" report did
  NOT reproduce in a fresh build (all metrics + 76 entries + 12 invocations
  render) — it was the stale committed `dist`; rebuilt + recommitted.
  Re-verified e2e across all 9 routes: 0 console errors, flamegraph draws
  all tasks, run detail shows 369% CPU for the one executed task. apps-only
  change; core `vx` untouched, no CACHE_VERSION impact.

- **2026-06-17**: **Execution as a pluggable backend + `vx serve` (owner
  ask: "one process doing all the work; runs inform it what to run and
  subscribe; treat vx as a service with clients; later a hosted service").**
  `vx run` no longer always executes in-process: it resolves a
  `RunBackend` and submits a `RunRequest`, agnostic to where work happens —
  the cache's local/remote split applied to EXECUTION. Files (each
  isolated/swappable): `orchestrator/protocol.ts` (wire contract:
  `RunRequest`/`RunResult`/`Server|ClientMessage` + `RunOptions⇄RunRequest`
  mappers, transport-agnostic), `orchestrator/wire-render.ts` (inverse of
  `wireForwarder` — rebuild node-shaped objects from `WireEvent`s and drive
  a normal `Logger`, so a DELEGATED run renders identically with the
  terminal renderer UNTOUCHED), `cli/serve.ts` (`vx serve`: Bun.serve + ws,
  dep-free, hosted-ready; runs the same `run()` with a silent logger +
  `handleSignals:false`, streams events, returns a result; advertises
  `.vx/serve.json` + `/health`), `cli/backend.ts` (`RunBackend` +
  `localBackend` (byte-identical in-process, mirrors to a `vx dev` hub) +
  `serviceBackend(origin, sink?)` (ws client; render sink INJECTABLE —
  hardcoding `defaultLogger` caused a cross-test hang via its status-region
  ticker) + `resolveBackend` (`VX_SERVICE_URL` → local service → in-process;
  FAIL-SAFE: any doubt → local, a service never blocks/breaks a run, 300ms
  health timeout)). **WireEvent reshaped**: `task:start` carries the full
  `TaskView` (consumer rebuilds incrementally, no upfront table);
  `wireForwarder` now EMITS `WireEvent`s (callers frame them: NDJSON for the
  dev socket, enveloped JSON for serve) and dedupes the double `run:end`
  while STILL forwarding the post-run:end summary footer (`run:status`
  lines) — else delegated runs lost their footer. Verified e2e: `vx serve`
  up, a separate `vx run` delegates, task runs server-side, full framed
  output + footer stream back and render identically, service logs
  activity, info file cleaned up on exit. 834 tests pass (all via local
  fallback) + new `wire-render`/`serve` suites. No CACHE_VERSION impact.
  Design + the deferred roadmap (in-flight dedup via
  `Map<taskHash,Promise>`, one global scheduler, watch+supersede staleness,
  serve/dev convergence, hosted execution):
  `docs/design/execution-service-2026-06.md`.

- **2026-06-17**: **Run event stream + devframe surface (Phase 1, owner
  ask: "use devframe for internals logging; drive our terminal output
  through it; build live CLI/web devtools").** Foundational refactor:
  `run()` no longer calls a `Logger` directly. New
  `src/orchestrator/events.ts` — an in-process `RunEvent` bus
  (`createEventBus`, synchronous order-preserving fan-out), a
  `Logger`-shaped `busLogger` facade, and `terminalSubscriber(sink)` that
  drives the concrete renderer. `run.ts` threads `busLogger` as `log`, so
  every existing `log.X(...)` call emits a `RunEvent` → bus →
  terminalSubscriber → the **untouched** `defaultLogger`. **Output
  byte-identical** (all output suites green, nothing repinned). The same
  file ships the serializable wire contract (`TaskView` / `OutcomeView` /
  `projectNode` / `projectOutcome` / `WireEvent` / `toWireEvent`) the
  off-thread boundary needs — raw `TaskOutcome`s carry bigint wallclock ns
  (`JSON.stringify` throws) + a back-ref to the whole `TaskNode` graph, so
  crossing a worker/RPC requires ids + decimal-string ns. Phase 1b:
  `src/orchestrator/run-state.ts` (`RunState` + pure `reduce` mirroring the
  logger's inline counters) and `src/orchestrator/devframe-surface.ts`
  (`createVxSurface(bus)` → a `DevframeDefinition` forwarding bus events
  onto a `vx:events` streaming channel + a `vx:run` reduced shared state).
  **devframe is a `devDependency`, touched only via type-only imports** in
  devframe-surface.ts + dynamic import at the host — core `vx run` stays at
  19 deps; surface tests use a mock ctx so they never ride devframe's
  runtime. **devframe@0.5.4 due-diligence:** ~33-package closure (native
  oxc-parser + h3-rc HTTP stack); three rough edges worked around
  (`defineDevframe` mis-exported → author the object directly;
  `createSharedState({enablePatches})` throws on uninitialized Immer;
  MCP adapter needs `@modelcontextprotocol/sdk` peer). No CACHE_VERSION
  impact (pure orchestration/output plumbing). **`vx run --ui` shipped
  same day**: `src/cli/ui-server.ts` `startUiServer(port?)` dynamically
  imports `devframe/adapters/dev`, boots `createDevServer` over the vx
  surface, returns the bus; new `RunOptions.bus` lets `runCmd` inject it
  so the surface subscribes before the run emits, then the CLI keeps
  serving until Ctrl-C. `--ui` / `--ui-port` flags; devframe stays
  optional (dynamic import + UserError install hint). Verified e2e (real
  server boots, forwards events, serves `__connection.json`) — the host
  initializes Immer patches so the standalone shared-state bug doesn't
  bite. Bridge mode (no bundled SPA yet; clients connect over WS). NEXT:
  `vx mcp` (createMcpServer, stdio) over the same definition + a real SPA.
  Design + phasing: `docs/design/event-stream-2026-06.md`.

- **2026-06-16**: **`vx-lock.json` globally excluded from cache inputs
  and `--affected`** (owner: "vx lock should be globally excluded from
  affected and cache, like gitignored"). The lockfile is committed, so
  git enumeration includes it, but it's vx's own frozen-config metadata
  — never a task input. (1) **Cache**: added `**/vx-lock.json` to
  `ALWAYS_IGNORE` in `cache/inputs.ts` (covers both project `files` and
  `workspaceFiles` resolution — both fold ALWAYS_IGNORE into their
  exclude globs). Hardcoded literal, NOT the workspace `LOCKFILE_NAME`
  constant: cache is a leaf module and must not import from workspace.
  **CACHE_VERSION → v24** (no SCHEMA bump): a task whose globs matched
  the root lockfile (broad `**/*` on the root `.` project) drops it
  from the hashed set, so those keys change; tasks that never matched
  it stay byte-identical. (2) **Affected**: `affected.ts` filters the
  exact root-relative `LOCKFILE_NAME` out of the `git diff --name-only`
  changed set before mapping to projects (uses the constant — same
  module), so a `vx lock` re-write can't mark every project affected.
  Files: `cache/cache.ts` (version + comment), `cache/inputs.ts`,
  `workspace/affected.ts`, `docs/caching.md` history.

- **2026-06-16**: **Requested persistent task keeps the run in the
  foreground** (owner bug: `vx run @vzn/vx-docs#dev` "is not
  persisting"). A persistent task that is the terminal/edge node (the
  user requested it, nothing downstream depends on it) was SIGTERMed
  the instant it became ready — the dev server died in milliseconds.
  Now `run()` distinguishes persistent tasks that exist only to support
  now-finished work (SIGTERMed at end-of-graph, as before) from
  persistent tasks the user REQUESTED (`node.requested || surfaced`):
  the latter are left running and the run blocks on their `exited` at
  the very END (after the summary prints + history is recorded), so
  Ctrl-C (process-group, plus the existing SIGINT handler → exit 130)
  reaps them and a crash resolves the wait. **Footer/UI unchanged** —
  the owner's first concern was an earlier attempt that called
  `runEnd` early + printed a custom hint + skipped `formatRunSummary`;
  reverted. The summary prints at its normal spot; the block is silent
  and purely defers process exit. **Display (owner-specified, kept
  simple, no region overhaul):** (1) the focused live frame for a lone
  persistent task is MARKED persistent — `formatFrameOpen`/`Close` add a
  cyan `▸` after `┌─`/`└─` when `exec.persistent` is set, and the close
  reads `running` (accent), not `success`, since the child is still
  alive; (2) between the frame and the `─ vx` footer, `run()` emits
  `formatPersistentList(keepAliveNodes)` — one `▸ <id> running` row per
  kept-alive task, so it's clear which are persistent and how many. New
  export `formatPersistentList` in `framed-output.ts`. **Scoped to the real CLI foreground**
  via `options.log === undefined && (handleSignals ?? true)`: a custom
  logger (tests/embedders) or `handleSignals: false` (watch) keeps the
  old return-after-teardown contract, so the persistent-task test
  suites (which request persistent tasks and assert run() returns) stay
  green — gating on `handleSignals` alone hung them. Known limit
  (pre-existing, unchanged): `sh -c '<server>'` grandchildren orphan on
  a lone `kill <pid>` (no process groups); real-terminal Ctrl-C reaps
  via the tty foreground group. File: `orchestrator/run.ts`.

- **2026-06-16**: **Unified `exec.timeout` — one knob, two meanings**
  (owner-driven). One `exec.timeout` (ms) field replaces the old
  `persistent.readyTimeoutMs`. Single mental model: "how long before vx
  SIGTERMs the child." For a NORMAL task it bounds total run time — an
  overrun is SIGTERMed and reported `failed` (timed out), never cached.
  For a PERSISTENT task it bounds the READINESS wait (exactly what
  `readyTimeoutMs` did: SIGTERM + reject `ready` when `readyWhen` never
  matches); a ready-on-spawn persistent task resolves before the timer
  can fire, so it's a harmless no-op (no loader error — a general field
  shouldn't carry a context-specific rejection). Key subtlety: a
  timeout SIGTERMs, but the existing Ctrl-C teardown classifier already
  reverts ANY SIGTERM/SIGINT to `aborted` — so the runner flags
  `RunResult.timedOut` when ITS OWN timer fired, and `execute-task`
  guards the abort check with `!result.timedOut` (timeout → real
  `failed`, exit 143, not cached; streams a `timed out after Nms` line
  into the framed block). Second subtlety: SIGTERMing `sh` doesn't close
  the stdout pipe if an orphaned grandchild (`sleep 30`) still holds the
  write end, so `streamToString` would never see EOF and the run hung —
  `runCommand`/`runSandboxed` now gate on `proc.exited` (not stream
  EOF) and abort the readers via an `AbortSignal` once the child dies on
  timeout, returning captured-so-far output. New shared
  `armTimeout(proc, ms)` helper in `runner.ts` (exported; used by both
  `runCommand` and `runSandboxed`); `streamToString` gained an optional
  `signal` param. Grandchild orphaning is the documented known-limit
  (no process groups) — the killed `sh` pid dies, the orphaned `sleep`
  lingers; matches the existing SIGINT/SIGTERM-reaping caveat. NO
  CACHE_VERSION bump — `hashTaskConfig` JSON-stringifies the whole
  config, so a task declaring `timeout` gets a distinct key while tasks
  without it stay byte-identical (same pattern as `persistent` /
  `readyTimeoutMs`, neither bumped). Files: `config.ts` (ExecConfig
  `timeout`; PersistentConfig `readyTimeoutMs` removed), `exec/runner.ts`
  (`armTimeout`, `RunResult.timedOut`, `RunOptions.timeoutMs`,
  cancellable `streamToString`, persistent `readyTimeoutMs`→`timeoutMs`),
  `exec/sandbox-runtime.ts` (`timeoutMs` + abort), `orchestrator/
execute-task.ts` (thread `step.timeout`; abort-check guard; timeout
  stderr line), `workspace/project-loader.ts` (validate `exec.timeout`;
  drop readyTimeoutMs validation), `cli/show.ts`, `cli/migrate-turbo.ts`
  (comment). Tests: `tests/persistent-ready-timeout.test.ts` rewritten
  (normal-task overrun-kills-fast-not-cached + within-budget, persistent
  readiness bound preserved, loader validation). Docs: `schema.md`
  (`timeout` section), `README.md`, `modules/runner.md`.

- **2026-06-15**: **Output redesign follow-ups + `aborted` status**
  (owner-driven). (1) **Worker rows have no glyph** — the live elapsed
  time leads (`     568ms running  <id>`); the glyph column is blank
  (persistent dev-server rows keep `▸`). (2) **Live region separated
  from the list** — a leading blank line tops the status region so the
  in-flight rows sit apart from the completed-task scrollback. (3)
  **Footer is identical live and final** — the live region now receives
  the run `RunContext` via `runStart` and renders the SAME
  `formatSummarySection` (version + `projects` bar + meters + `info` +
  `time`); previously the live footer was a bare `vx`. (4) **`aborted`
  status** — a child killed by a SHUTDOWN signal (SIGINT/SIGTERM, i.e.
  Ctrl-C teardown) is classified `aborted`, NOT `failed`: not cached,
  not counted (excluded from `tallyOutcomes` + `recordRun`), not shown
  (logger `taskComplete` frees the slot and returns). SIGKILL/OOM stays
  a real failure. Fixes the owner bug where Ctrl-C left in-flight tasks
  reported as `failed` (the TTY signal kills the children, whose
  143/130 exits were recorded before `process.exit`). New `TaskStatus`
  member `'aborted'`; `RunResult.signal` carries `proc.signalCode`;
  classification in `execute-task.ts`. Files: `graph/scheduler.ts`,
  `exec/runner.ts`, `orchestrator/{execute-task,logger,tally,run,
status-line}.ts`. Tests repinned (region row offsets for the leading
  blank; aborted-is-silent pin). NB: on a TTY the frozen region isn't
  yet erased on exit (cosmetic; non-TTY prints nothing).

- **2026-06-15**: **Per-task output redesign — two-axis glyph grid**
  (owner-driven, many iterations). Reported task lines and live worker
  rows are now ONE column grid: ` <glyph> <time> <status> <cache>
<name>` (leading space; single-space separators; time right-aligned
  in a 7-cell column; status 7-wide, cache 6-wide; name LAST so nothing
  shifts with id length — layout shift was the bug). **Two orthogonal
  axes** (owner reframed the old fused vocabulary `restored-local /
up-to-date / success` as task×cache): the GLYPH shape encodes the
  CACHE axis — `⏺` miss (ran) · `►` fresh (up-to-date) · `⇢` local ·
  `⇣` remote · `◼` failed · `⊘` skipped · `⦿` running (worker) · `▸`
  persistent — and the glyph COLOR encodes the TASK axis (green success
  / red failed / yellow skipped / cyan running). The `status` word
  (success/failed/skipped/running, task-colored) and the `cache` word
  (miss dim / fresh green / local sky / remote blue) spell both axes
  out. NO exit code on the line — all detail (exit N, stdout/stderr)
  lives in the framed block that already replays. `⏺` and `◼` carry a
  U+FE0E text-presentation selector so terminals render them narrow
  (Bun.stringWidth sees them as width-1; without VS15 many terminals
  emoji-widen them and the time column jitters). **Footer is identical
  live and final**: the live status region now receives the run
  `RunContext` via `runStart` and renders the SAME
  `formatSummarySection` (version on the wordmark rule + `projects`
  bar + meters + `info` row + `time`) — previously the live footer was
  a bare `vx` with no context (owner: "footer always the same"). Worker
  region: no spinner (the ticking elapsed time IS the motion), ids
  never truncated. Files: `orchestrator/framed-output.ts` (`taskGlyph`
  / `glyphShape` / `statusOf` / `cacheOf` / `formatTaskRow` grid),
  `status-line.ts` (`formatFailureLine` + region rows on the grid),
  `logger.ts` (thread `RunContext` into the live region; spinner
  removed), `summary.ts` (`RunContext`), `run.ts` (pass context to
  `runStart`). No CACHE_VERSION/behavior impact — pure presentation.
  Tests repinned across `output-flow`/`status-line`/`framed-output`/
  `cli`. KNOWN-OPEN (owner asks, not yet done): on SIGINT/SIGTERM the
  live region is left frozen on a TTY (non-TTY prints nothing — already
  correct); killed in-flight tasks already get NO outcome (process.exit
  is immediate, before any taskComplete) so they're never counted
  failed/skipped — but the frozen TTY region should be cleared on exit.

- **2026-06-15**: **`vx upgrade` fixed for curl-installed binaries —
  detection keyed off `Bun.main`, not `import.meta.path`.** Owner report:
  curl-installed `vx` couldn't self-upgrade and "vx points to bun".
  Root cause: `isCompiledBinary()` checked `import.meta.path.startsWith
  ('/$bunfs')`, but vx's release binaries are built `--minify
--bytecode`, and under those flags Bun reports `import.meta.path` as
  the ORIGINAL SOURCE path (e.g. `/private/tmp/bin.ts`), NOT the bunfs
  path — so EVERY installed binary misread as "running from source" and
  `vx upgrade` refused with the git-pull message. `Bun.main` and
  `process.argv[1]` stay the bunfs path (`/$bunfs/root/…`) under every
  compile-flag combo, so detection now keys off those (import.meta.path
  kept as a third fallback). `dest = process.execPath` was always
  correct (it resolves to the real standalone binary, not bun — the
  "points to bun" was the refusal + `process.argv[0]` literally being
  the string `"bun"` in standalone binaries). Verified end-to-end:
  compiled a `--minify --bytecode` binary, `vx upgrade` now downloads
  `latest`, atomically replaces itself, and the new binary runs.
  Extracted pure `isBunfsPath(p)` (exported) for the markers; files:
  `src/cli/upgrade.ts`, `tests/upgrade.test.ts` (marker unit tests +
  the kept source-mode refusal e2e).

- **2026-06-15**: **Task hierarchy — dotted-namespace group composition.**
  The repo's own `vx.config.ts` tasks were restructured so groups
  compose by dotted name: `lint` → `lint.oxlint` + `lint.oxfmt` (+
  `lint.oxfmt.fix` to rewrite); `build` → `build.bun` →
  `build.bun.{linux-x64,linux-arm64,darwin-x64,darwin-arm64}` (one real
  cross-compile task per platform); `ci` → `lint` + `test`. Dotted
  names are a pure convention (no schema feature) — they read as a
  folder tree and pair with the transparent-folder focused output (see
  the entry below; `vx run lint` surfaces `lint.oxlint`/`lint.oxfmt`).
  `vx-lock.json` regenerated, CI/release workflow comments + the
  Workflow/CI sections of this file updated to the new names. NB: `ci`
  initially also chained `build` but that was dropped same day
  (`build.bun.*` OOM-killed on the CI runner) — the four binaries build
  only in `release.yml` via `vx run build`. No CACHE_VERSION impact
  (resolved-config hashing keys each task independently of its name).

- **2026-06-15**: **`dependsOn` bare entries type-checked against task
  keys.** `defineProject` now constrains each task's `dependsOn` so a
  BARE entry (`'build'`) must be one of that config's own task keys — a
  typo (`'biuld'`) is a compile error with a "did you mean" hint. The
  `'^name'` (workspace-dep, incl. `'^all'`) and `'pkg#name'`
  (cross-project) forms reference OTHER projects' tasks and stay free
  strings (this config can't see their keys). Compile-time only:
  `defineProject` stays an identity function at runtime, and
  `TaskConfig.dependsOn` keeps its loose `readonly string[]` for the
  loader/graph (which validate dynamically). Files: `src/config.ts`,
  `tests/config.test.ts`.

- **2026-06-13/14**: **Docs-site adopter overhaul + animated landing
  benchmark.** A large body of `apps/docs` (Astro Starlight) work,
  shipped via web-session PRs per that harness's directive (NOT the
  push-to-main rule): (a) the guide/reference content was overhauled
  for ADOPTERS — every config prop covered, new sandboxing +
  workspace-config guides, install instructions corrected (`bun add` +
  `curl` both shown, `defineProject` kept), `vx lock` / `--frozen` in
  CI documented, several verified inaccuracies corrected; (b) the docs
  LEAD with real large-monorepo benchmark numbers (deep-graph shape,
  Turbo caching fixed in the harness, a `vx (frozen)` variant + frozen
  warm numbers added); (c) the LANDING page was redesigned
  (speed-forward, mobile-responsive, gradient-bordered cards) with an
  animated **benchmark race** — `BenchBar.astro` / `BenchChart.astro`
  render each runner's bar as a relative-length, real-time progress
  fill (cold starts at vx's finish line and watches Turbo/Nx grind on;
  bars share one timescale; a sheen sweeps only still-running bars).
  `docs/**` stays the source of truth for the reference pages; landing
  - benchmark visuals are hand-authored components. No core/runtime
    change — `docs/` + `apps/docs/` only.

- **2026-06**: **Groups are transparent folders in focused output**
  (owner: "treat groups as transparent folders — running them should
  show real tasks"; `vx run build` where `build` is a group printed
  nothing but the footer). In FOCUSED flow a requested GROUP now
  surfaces the real tasks it stands for and displays them like
  requested tasks. New `markSurfacedDeps(nodes)` in
  `graph/task-graph.ts` walks `dependsOn` from each requested group,
  DESCENDING THROUGH nested same-project groups (`build` → `build.bun`
  → `build.bun.*`) and marking the first non-group task on each path
  `node.surfaced = true`. Two hard limits: never leave the requested
  project (`^`/cross-project deps are neither surfaced nor traversed —
  owner: "only if those deps are in this project eg no ^"), and never
  descend past a real task into its own deps (that's its implementation
  detail). `surfaced` is **display-only** — deliberately NOT
  `requested`, because `requested` also scopes `--` `forwardArgs`
  (`execute-task.ts`); flipping it would leak trailing args into the
  surfaced tasks. `run.ts` calls `markSurfacedDeps` after graph build
  and counts surfaced nodes toward `requestedCount` (so one surfaced
  task streams live, several buffer into atomic blocks — the existing
  multi-requested path). The logger gained an `isPrimary(node) =
requested || surfaced` predicate driving `streamsLive` and the
  focused branch; everything else (broad/full/CI/none/errors-only)
  ignores `surfaced`. No CACHE_VERSION/behavior impact — purely which
  tasks the focused logger shows. Tests: `markSurfacedDeps` unit suite
  in `tests/task-graph.test.ts` (descend-through-nested-groups,
  same-project-only, stop-at-real-task, non-group-requested→0) +
  focused surfaced-streams-live / non-surfaced-dep-silent pins in
  `tests/output-flow.test.ts`. Docs: `docs/cli.md` focused-flow
  "transparent folders" note.

- **2026-06**: **Header folded into the footer; top-of-run banner
  removed** (owner: "logs header should [be] in footer. we don't need
  the header" → then a hand-drawn target layout). `formatHeader` +
  `HeaderInput` deleted from `framed-output.ts` (and `SCOPE_BAR_WIDTH`,
  its lone consumer; `unanchored` in `run.ts` too); the run prints
  nothing before task output. The run banner now rides the **footer**
  via a new optional `RunContext` param on `formatRunSummary` /
  `formatSummarySection` (`summary.ts`). Owner-chosen layout (matched
  to a pasted mockup): a `projects` affected-vs-workspace bar **leads**
  the meter stack (`N affected · N total`), then `tasks` (legend gains
  a dim `N total`) and `cache` meters, a blank line, then an `info` row
  (`N workers · <cache mode>`) and the `time` row. Labels pad to **8**
  (was 6), bars/legends shift to column **12** (was 10), and the
  wordmark rule widened to 62 cols (`RULE_DASHES` 55→57) to stay flush.
  Requested task names + the old `run`/`scope` rows were **dropped**
  from the design — the footer is meters-first, names live in the
  stream. Cache mode lives on the `info` row, not a colliding `cache`
  label. **Live region unchanged in spirit**: the status region calls
  `formatSummarySection` with NO context, so the rule stays a bare `vx`
  and `projects`/`info` are skipped — it renders the meters alone
  (label width + tasks `N total` now apply there too, harmless/
  consistent). Custom loggers (tests) previously got header lines via
  `log.status`; they now get the same data in the footer. No
  CACHE_VERSION/behavior impact — pure output formatting. Tests:
  `formatHeader` block removed from `framed-output.test.ts`; all
  `summary.test.ts` geometry pins updated (57-dash rule, 12-indent
  legends, `N total`) + projects-bar/info-row/no-context-parity pins;
  the group-totals e2e in `orchestrator.test.ts` switched its legend
  scan to the 12-indent column. Docs: `docs/modules/summary.md`
  (RunContext + new format), `framed-output.md` (header section
  deleted), `status-line.md` worker-pool note.

- **2026-06**: **Runtime inputs — `cache.inputs.runtime` /
  `cache.inputs.workspaceRuntime`.** The single canonical mechanism for
  folding a shell command's OUTPUT into a task's cache key (tool/runtime
  versions, OS info, project-local probes). Modeled exactly on
  `inputs.env`: the command STRINGS live in the resolved config (frozen
  into `vx-lock.json`), the OUTPUT is resolved live at hash time inside
  `resolveInputs` on EVERY run — so it stays correct under `--frozen`,
  precisely where the TS escape hatch (`define: { X: execSync(...) }`)
  goes stale (its value was baked into the config object at lock time).
  `runtime` commands run in the PROJECT dir, deduped per
  `(projectDir, command)`; `workspaceRuntime` commands run at the
  WORKSPACE ROOT, deduped GLOBALLY per command (a `node -v` in 500
  projects spawns once). Both run via `sh -c` ("shell is the API" —
  pipelines/redirects work). Output = combined trimmed stdout+stderr,
  folded into `Cache.key` as TWO namespaced sections
  (`runtime-values:` / `ws-runtime-values:`) right after env-values, so
  an identical `(command, output)` never aliases between the two
  scopes. A non-zero exit is a hard `UserError` naming the command +
  exit code (fail-loud, like a missing git binary). Dedup uses
  run-scoped `Promise` memos on `HashCache` (`runtime` /
  `workspaceRuntime` maps) shared by the hash path AND the sandbox-
  baseline `resolveInputs` — the first task to need a command fires the
  spawn, the rest await the same promise; each task awaits only its OWN
  commands (no upfront global pass). **CACHE_VERSION → v23, no SCHEMA
  bump** — only `Cache.key` derivation gained two sections; tasks
  declaring neither field fold a `:0` count for both and derive
  byte-identical keys to before. **Nx parity** (Nx has a `runtime`
  input; Turbo lacks this — vercel/turborepo#4124). Files: `config.ts`
  (two `CacheInputs` fields), `workspace/project-loader.ts`
  (validation: non-empty string arrays), `cache/inputs.ts`
  (`runRuntimeCommand` + `resolveRuntimeValues` + `ResolvedInputs` /
  `ResolveInputsArgs` extensions), `cache/cache.ts` (`CacheKeyInput`
  fields + `key()` fold + version bump), `orchestrator/task-hash.ts`
  (`HashCache` memos + threading), `orchestrator/execute-task.ts`
  (sandbox-baseline memo passthrough). Tests: `tests/inputs.test.ts`
  (resolver: cwd split, dedup-runs-once, stdout+stderr, sort, non-zero
  fail), `tests/cache.test.ts` (key folding + namespacing + absent ==
  empty), `tests/project-loader.test.ts` (validation), and
  `tests/runtime-inputs.test.ts` (real-CLI e2e: output drift → miss,
  live under `--frozen`, global dedup one-spawn, non-zero fails the
  run). Reference `docs/design/runtime-inputs-2026-06.md`.

- **2026-06**: **Cold-run optimization — no per-project git re-spawn on
  cache-miss save** + a real vs-Turbo-vs-Nx benchmark. Owner: "we should
  be faster on cold … use bun --profile to find exactly what's causing
  it and optimize." `bun --cpu-prof --cpu-prof-md` on a cold run showed
  `spawnSync` at **22% of CPU**: `execute-task.ts` called
  `gitFilesCache.delete(projectDir)` after every cache-MISS save with
  outputs, so the same-project downstream task (e.g. `test` after
  `build`) re-spawned `git ls-files` SYNCHRONOUSLY — one blocking spawn
  per project. Fix: replace the `delete` with `markOutputsChanged(<rel
output paths>)` — the SAME mechanism the cache-HIT restore path already
  uses — so `snapshotFor` skips the re-spawn when a downstream task's
  input globs can't match the (declared) output paths. Cold A/B (200-pkg
  synthetic, compiled binary): **1534 ms → 1109 ms (-28%)**, spawnSync
  gone from the profile; head-to-head (`bench/compare.ts`, 300-pkg): vx
  cold now **ties Turbo** (was losing at 0.7×), wins both warm states,
  and is **3.9-6.3× faster than Nx** everywhere. **No CACHE_VERSION
  bump** — key derivation and artifact bytes are untouched; only WHEN
  the in-run git snapshot is invalidated changed. Tradeoff (identical to
  what the restore path already accepts, now extended to save): a task
  that writes files OUTSIDE its `cache.outputs.files` which a same-
  project downstream task reads is undeclared behavior and won't trigger
  a re-enumeration — declare your outputs. All 753 tests pass
  (restore-git-spawns.test.ts unaffected). New `bench/compare.ts`:
  scaffolds ONE shared repo (default 1000 pkgs × 10 layers, build+test,
  identical shell commands across runners), runs vx (compiled binary,
  the real artifact) / Turbo / Nx across fresh / warm-no-restore /
  warm-restore, writes committed `bench/RESULTS.md` + `bench/results.json`.
  Fairness fixes baked in: generated workspace gitignores
  node_modules/.vx/.turbo/.nx (else vx's git enumeration walks
  node_modules, a handicap the JSON-config runners dodge), clean commit
  before measuring (vx's zero-read clean-tree OID path).

- **2026-06**: **Docs site (`apps/docs`) + GitHub Pages.** Owner ask:
  "a website with docs guide refs architecture and everything like
  Turborepo or NX … add a new pnpm workspace with a project like this
  and deploy it to GitHub Pages." Built on **Astro Starlight**; the
  repo root became a **Bun workspace** (`workspaces: [".", "apps/*"]`)
  rather than introducing pnpm (owner picked Bun-isolated-app-dir over
  literal pnpm). **The `"."` member is load-bearing**: vx's own
  discovery (`loadWorkspace`) switches from single-project mode to
  glob mode the moment `workspaces` is set, so without `"."` the root
  vx.config.ts (lint/test/ci/build tasks) stops being a project and
  `vx run ci` / `release.yml` break. Bun tolerates `"."` as a member.
  **`docs/` stays the single source of truth** — `apps/docs/scripts/
import-docs.ts` copies `docs/**/*.md` into the Starlight content
  collection, adding frontmatter (first H1 → title) and rewriting
  internal `.md` links to depth-relative clean URLs (base-safe; no
  hardcoded `/vx`). The transform is code-span/fence-aware and escapes
  bare `<placeholder>` tokens in prose so Markdown doesn't eat them as
  HTML. Generated content is git-ignored and regenerated on every
  dev/build; only `index.mdx` (splash landing) + `getting-started.md`
  are hand-authored. Mermaid (architecture.md, flows.md) renders
  client-side: a remark plugin emits `<pre class="mermaid">`,
  `Head.astro` lazy-imports mermaid only on diagram pages and
  re-renders on theme toggle. **oxc guard**: `apps` added to
  `.oxlintrc.json` + `.oxfmtrc.json` `ignorePatterns` so the root
  `oxfmt --check .` / `oxlint` (which scan cwd) don't choke on the
  app. Deploy: `.github/workflows/docs.yml` (Pages, path-filtered on
  `docs/**` + `apps/docs/**`); base `/vx` for the project-site URL,
  `BASE_PATH`/`SITE_URL` overridable for a custom domain. Pages must
  be enabled once (Settings → Pages → Source: GitHub Actions). No vx
  CACHE_VERSION/test impact; the full `vx run ci` gate stays green.
  NOTE: this work shipped via a feature branch + PR per the web
  session's harness directive, NOT the usual push-to-main rule.

- **2026-06**: **Async remote-cache prefetch (remote-only).** Owner
  ask, quoted: "do the remote cache async calls. when exec task probes
  for it it should just get the resolved or pending promise." For runs
  backed by a `LayeredCache`, `run()` now derives every cacheable
  task's pure-input key UP FRONT in topo order (reusing the run's
  `hashCache` memo — execute-task's later `computeTaskHash` hits the
  memo, no double hashing; derivation touches NO cache layer, keys
  only) and fires the remote GETs concurrently in the background under
  a bounded pool (the run's concurrency) BEFORE scheduling, so network
  latency overlaps execution. `LayeredCache.prefetch(hash, ctx)`
  ingests a hit into LOCAL; an `inflight: Map<hash, Promise<boolean>>`
  shared by `prefetch` AND `get` guarantees **at most ONE remote GET
  per key** (a settled-`false` miss blocks a second lazy probe). When
  execute-task calls `cache.get`, `LayeredCache.get` awaits any
  in-flight prefetch for that key before deciding — so it
  "transparently gets the resolved-or-pending promise" with no
  execute-task change beyond what already existed. Provenance: a
  remote-sourced hash reports `source: 'remote'` even when a later
  `get` finds it locally (a `remoteSourced` set), so the outcome stays
  `cache-hit-remote`. The local `Cache` gets a no-op `prefetch`
  returning `false` (CacheLayer contract). This is the
  remote-prefetch follow-up the reverted upfront-classification entry
  said was abandoned — REVIVED on a sound footing: it does NOT depend
  on upfront LOCAL classification (the thing that double-probed and
  regressed warm runs +57%). The hard scoping is what makes it safe —
  gated ENTIRELY on `cache instanceof LayeredCache`; a local-only run
  derives no upfront keys, prefetches nothing, adds NO upfront local
  `get`/`isOutputsCurrent`/stat pass, and is byte-identical (behavior
  - perf) to before. **Stable-key gate** (slim, boolean-only revival
    of the rejected computeRecomputeFlags idea — no statuses, no
    probes): a task whose `cache.inputs.files` could match an upstream's
    declared output has a PRELIMINARY key until that upstream runs, so
    it's skipped from prefetch (lazy read-through stays correct);
    conservatively a task is unstable if a same-project upstream
    declares `outputs.files`, or it reads `inputs.workspaceFiles` and an
    upstream declares `outputs.workspaceFiles`, or it folds an unstable
    upstream — when unsure, unstable. `--no-cache` fires no prefetch.
    Lifecycle: `startRemotePrefetch` returns a handle `run()` awaits
    before `cache.close()` (a still-in-flight prefetch ingesting into a
    closed SQLite DB would throw) but does NOT await before scheduling
    (that's the overlap). No CACHE_VERSION bump — key derivation and
    artifact bytes are untouched; this only changes WHEN the remote GET
    fires. Files: `src/orchestrator/remote-prefetch.ts` (new),
    `src/orchestrator/run.ts` (wire + drain), `src/cache/cache.ts`
    (`CacheLayer.prefetch` + Cache no-op), `src/cache/layered-cache.ts`
    (`prefetch` + `inflight`/`remoteSourced` + shared `pullFromRemote`).
    Tests: 5 LayeredCache unit tests (prefetch pull+provenance, miss,
    at-most-once with injected latency — guard FAILS at 2 if de-dup
    removed, prefetch-miss-no-second-GET, concurrent-prefetch idempotent)
  - 4 orchestrator e2e (at-most-once + overlap on a real CLI run,
    codegen→consumer stable-key correctness, --no-cache no GET,
    local-only-never-prefetch via a `LayeredCache.prototype.prefetch`
    spy). Docs: docs/caching.md § Remote prefetch, docs/optimizations.md
    row 17b.

- **2026-06**: Async remote-cache prefetch (REMOTE-ONLY) + never-fail
  hardening. Owner asks: (1) "do the remote cache async calls — when
  exec task probes it should just get the resolved or pending
  promise"; (2) "remote cache should never fail anything — 500 or any
  error → fall back to cache miss, continue; it's fully optional".
  Design: when a run is backed by a LayeredCache, `startRemotePrefetch`
  (src/orchestrator/remote-prefetch.ts) derives every STABLE cacheable
  task's pure-input key upfront (reusing the run hashCache memo — no
  double hashing; skips inputs-glob-includes-upstream-output tasks
  whose key is preliminary) and fires `LayeredCache.prefetch(key)`
  under a bounded pool, NOT awaited before scheduling (overlap) but
  awaited before cache.close (no ingest-into-closed-DB). LayeredCache
  gained an `inflight` map + shared `pullFromRemote`: prefetch and the
  lazy get() read-through share ONE in-flight promise per hash → AT
  MOST ONE remote GET per key; execute-task's `cache.get` transparently
  awaits any in-flight prefetch (no execute-task change). Provenance
  stays `cache-hit-remote` via a `remoteSourced` set. GATED ENTIRELY on
  a remote layer — local-only runs derive nothing, prefetch nothing,
  add NO upfront local probe/stat (this is what makes it safe vs the
  reverted local classification that regressed warm runs +57%). Never-
  fail: every remote path (get/put/ingest/prefetch/key-derivation/pool)
  catches ALL errors and degrades to miss; reportRemoteError now also
  guards a throwing onRemoteError callback. Pinned by a test where the
  remote 500s on EVERY request and both cold+warm runs still succeed.
  No CACHE_VERSION bump (only WHEN the remote GET fires changed).

- **2026-06**: **Upfront cache classification — built then REVERTED.**
  An upfront pass (`classify.ts`) computed every task's key + probed
  the cache before execution so the live cache meter (miss /
  up-to-date / local) filled before any work. Pure-input keys (v22)
  made it possible. But it REGRESSED warm runs ~57% (127 ms → 200 ms
  on the 1090-pkg repo, measured A/B): `execute-task` still re-probed
  - re-stat'd every task, so the cache.get + loadOutputFilesBatch +
    isOutputsCurrent ran TWICE per task. The owner caught it ("this
    should do less work not more"). Reverted — the warm bar fills
    imperceptibly fast anyway (~120 ms), the regression hit EVERY run,
    and making it net-free would require reusing the probe result
    through the delicate restore path (entry threading + identical
    skip-restore determination shared between classify and execute) —
    real critical-path risk for an essentially-cosmetic warm-run win.
    Lazy per-task resolution restored (back to ~120 ms). If the upfront
    breakdown is ever wanted for LONG miss runs specifically, `vx run
--dry` already previews it; revisit only with a do-less design that
    has execute reuse the classification probe (no second pass). The
    remote-prefetch follow-up (built on a branch) is also abandoned —
    it depended on this.

- **2026-06**: CACHE_VERSION → v22 + SCHEMA v21: **reverted v21
  early cutoff → pure-input transitive hashing** (owner: "simplify,
  rely only on task input hashes, no output hashes"). Downstream keys
  fold the upstream's INPUT key (its own task hash) again, not its
  output content — a pure function of the filesystem, like Turbo/Nx.
  `upstream.ts` folds `u.hash` (was `u.outputsHash ?? u.hash`); the
  aggregate `outputsHash` machinery is gone (computation in
  writeArtifactAndIndex, `CacheEntry.outputsHash`,
  `TaskOutcome.outputsHash`, `entries.outputs_hash` column,
  `CacheLayer.save` return value, plan threading, group rollup → all
  removed). **Early cutoff dropped**: an upstream that re-runs but
  emits byte-identical output now still re-runs dependents — rare in
  practice, and folding output into keys was what blocked any
  upfront/batched cache probe. **Multi-state preserved**: branch
  ping-pong A→B→A still re-hits, because the upstream's input differs
  per state and folds transitively into every dependent key (pinned
  by a new orchestrator e2e). Two v21 cutoff tests inverted to the
  no-cutoff contract; the `outputsHash`-namespace test removed. This
  followed a deep multi-agent review that found the elaborate v22
  "validity-filter" branch (separate input_key + stored `expects`
  columns) correct but PERF-NEUTRAL as built (it kept the cascade and
  left `probeByInputKeys` unwired) — shelved as
  docs/design/cache-validity-2026-06.md; pure-input is the simpler win
  that actually enables future upfront batching. KNOWN-OPEN: the
  skip-restore "tree already current" check (`isOutputsCurrent`) still
  compares size+mode+second-mtime and can leave stale bytes on a hit
  for same-size/same-second/different-content outputs — pre-existing,
  to be fixed separately with a per-output content hash.

- **2026-06**: Focused-flow live framing gated on a single requested
  task (owner bug report: two concurrent requested tasks interleaved
  `┌─`/`└─` frames into garbage). Live open-at-taskStart /
  close-at-taskComplete only works when ONE task owns the terminal
  between its brackets. Fix: `run()` counts requested non-group nodes
  and threads `requestedCount` into `log.runStart`; the focused logger
  streams live only when `requestedCount <= 1` (0/undefined/1 are the
  live path — default-safe, single-target experience byte-identical).
  With >1 requested task, requested nodes buffer like deps and emit
  ONE atomic block at completion (full frame for success / failure /
  hit-with-replay, one-liner for up-to-date / skipped; failures still
  defer to runEnd). Files: `orchestrator/{logger,run}.ts`; tests in
  `tests/output-flow.test.ts`; `docs/cli.md` focused-flow note.

- **2026-06**: Frame sections + pinned zones + force-floor (owner
  feedback: "hard to see what is a command what is STDOUT. maybe all
  STDOUT and COMMAND should have a group like we have ERROR and
  rename ERROR to STDERR? and no left border | so text wont overlap,
  and easier to copy? also frame need new line at the end to not
  colide with others. Are we able to kind of pin errors always to
  the end? like right after workers? on top of them? Same for
  continuous task always pinned until exit"). Three changes:
  (1) FRAME REDESIGN — blocks are now `┌─ id > <outcome header>`,
  dim section headers `├─ command` (executed tasks only — success +
  failed; the command moved OUT of the failed header, which now
  carries `failed (exit N)` like every other status), `├─ stdout` /
  `├─ stderr` (renamed from Error; only when non-empty after trim),
  `├─ sandbox violations (N)`, then the unchanged footer. Content
  lines are RAW — no `│` border, no indent — because the border
  collided with terminal wrapping and polluted copy/paste. Every
  block AND focused frame-close gets a blank line after (logger
  bookkeeping — emitBlock/emitFrameClose; formatter stays pure), no
  doubles between adjacent blocks. Live frame-open keeps its `$ cmd`
  (the command shares the open line there).
  (2) PINNED ZONES in the status region, top to bottom: failures
  `✗ id ── failed (exit N)` (cap 5 + dim `… +K more failed`,
  accumulate until runEnd — owner picked ON TOP of the workers),
  ready persistent tasks `▸ id ── running` (outcome lands at ready
  while the child runs; SIGTERM at graph end makes runEnd the honest
  end), then worker rows + stats. Pins keep identity-colored ids
  (ids never read as outcomes). Region height now varies; the
  writer's erase-old-height/draw-new-height math handles it (pinned
  by a grow/shrink test).
  (3) FORCE-FLOOR COALESCING — 6,540 forced redraws ≈ 6.7 MB ANSI
  (~5.3µs + ~1KB each) on a 3,270-task warm run. Forced sets within
  30 ms of the last draw mark dirty + schedule ONE trailing draw at
  floor expiry (unref'd; canceled by any draw / clearStatus); final
  state always lands; first draw after idle immediate. 6.7 MB →
  ~20 KB. `OutputWriterOptions.forceFloorMs` (default 30, 0
  disables) + defaultLogger 4th-arg pass-through for tests that
  assert region bytes synchronously. Files: orchestrator/
  {framed-output,logger,status-line}.ts; repinned framed-output/
  output-flow/status-line suites.

- **2026-06**: Header v2 + glyph unification (owner). The run header
  now speaks the summary's language: dim-label rows (`run` = task
  names · N projects · N tasks · N workers; `cache` = local only /
  local + remote), gradient wordmark rule WITH the version at the
  BOTTOM of the header (owner) — the run's output lives between the
  header rule and the summary rule. "packages" → "projects" in user
  copy (owner). Margin (blank line) above. Glyphs unified on
  circles: ● success (green) / failed (red) / skipped (yellow),
  ◌ hits, ▸ persistent, ▶ stats, ▰ meter, braille spinner — the ✗
  and ⊘ glyphs are gone from output (comments may still reference
  the old ✗ contract). Skipped one-liner: `● id ── skipped •
upstream failed`; requested-task skip stays logged in focused
  (the asked-for task's fate must be reported — owner agreed).

- **2026-06**: Failure rendering, final contract (owner-picked
  option B after rejecting both the inline frame and the runEnd ✗
  recap): when a task fails in broad / errors-only / focused-dep
  modes, the stream gets ONE permanent `✗ id ── failed (exit N)`
  line and the run continues; ALL full failure frames replay
  together at runEnd, right above the summary — failures read last,
  uncapped ("at the end logs all full frames of failures"). The
  region's pinned-✗ zone was REMOVED (✗ lines live in scrollback
  now; the stats line keeps the red count); the ▸ persistent zone
  stays. full/CI modes keep frames inline (chronological logs +
  GHA annotations). formatFailurePins → formatFailureLine.
  Frame sections also finalized this round: UPPERCASE bold
  state-colored labels with dim trailing rules to 60 cols (STDOUT
  green / STDERR red / SANDBOX VIOLATIONS yellow), vertical margins
  around content, COMMAND label cut — a dim `$ cmd` line under the
  header carries it.

- **2026-06**: Summary v3 — stacked state meters (owner-driven
  iteration over five revisions in one session; picked from a
  15-design visualization file at /tmp/vx-summary-designs.txt). The
  summary is now: gradient wordmark rule (identity violet→pink
  lerped across the dashes, plain when colors off); a 50-cell
  TASKS meter (failed/success/skipped segments, largest-remainder
  cell allocation, non-zero buckets guaranteed ≥1 cell) with its
  color-coded legend on the line BELOW the bar; failed-id index
  capped at 5 + dim '… +N more' (owner: "there can be hundreds");
  a 50-cell CACHE meter (miss/up-to-date/local/remote) + legend;
  blank line; time row = total + dim 'max · avg · min' per-task
  spread (skipped excluded so min stays honest). The ⚡ instant
  stamp was added (owner-picked over '>>> FULL CACHE' Turbo clone)
  then REMOVED same session (owner: full meter bar carries the
  message). Bars always sum to width; NO_COLOR renders plain ▰ runs
  with the legends carrying the data. Files: orchestrator/summary.ts
  (segmentBar, gradientRule); pins in tests/summary.test.ts +
  output-flow/orchestrator e2e.

- **2026-06**: Focused frames + summary v2 (owner-driven, same
  session). FOCUSED requested tasks now get a LIVE FRAME for every
  outcome — `┌─ id > $ cmd` at taskStart, raw stream between (exec or
  hit replay), `└─ id ── (dur) <word>` at completion — "always full
  frame for a single task even if cached or up to date"; silent
  commands no longer vanish. Skipped requested tasks keep the
  buffered block (they never start, so no open fires). Quiet-hit
  one-liners are gone from focused. formatFrameOpen/Close exported
  from framed-output. END SUMMARY rewritten in the live-line
  language: ` Tasks:    0 failed · 23 success · 0 skipped · 23 total`
  / ` Cache:    23 miss · 0 up-to-date · 0 local · 0 remote` — Tasks
  partitions by how things ended (success includes hits), Cache by
  where results came from (miss+up-to-date+local+remote = total -
  skipped); ZERO-valued buckets render dim, non-zero in live-line
  colors; Failed: listing + >>> FULL CACHE kept. Region stats elapsed
  switched to mm:ss (owner). Files: orchestrator/{logger,
  framed-output,summary,status-line}.ts.

- **2026-06**: Status display v2 — worker region (owner-driven
  iteration, same day). The single status line "jumped too much" on
  broad runs (running count 1→10, names churning), so it became a
  FIXED-HEIGHT WORKER REGION on every interactive view: one row per
  worker slot, sized min(concurrency, 10) — the display derives from
  the stable worker set, not the churning task set. A task takes the
  lowest free row and STAYS there for its whole life; idle rows hold
  their place dimmed; overflow queues for a freed row and shows as
  `+k more`. No worker indexes (owner cut them) — instead the run
  header states the pool: `(N tasks, C workers)`; runStart hook
  carries `concurrency`. Stats line iterated through three owner
  designs (worded buckets → colored bare fractions → REJECTED as
  unreadable in the wild) and landed on labeled colored pairs in two
  groups, every bucket always present in fixed order, miss first in
  the cache group: `▶ 1 failed · 78 success · 759 left · 1090 total
│ 79 miss · 252 up-to-date · 0 local · 0 remote │ 16s` (local =
  yellow, remote = cyan — owner-set). Vocabulary change: `executed`
  → `success` ("executed wording is ambiguous"). Identity coloring
  shipped with it: project half of every id gets a STABLE hue hashed
  from the project name (6-hue cool palette), task half fixed pink,
  separator dim — both deliberately outside the status palette so an
  id can never read as an outcome; applied in frames, one-liners,
  and region rows (region pads by visible length, hue hashes from
  the full name so it survives truncation). formatStatusLine deleted
  (no consumer). Writer gained setRegion: single line keeps legacy
  ESC[2K\r bytes; taller regions erase via `\r ESC[nA ESC[J`.
  Focused replay pin added: requested cache hits stream stored
  stdout raw for EVERY hit kind, up-to-date included (execute-task
  replay is unconditional — owner requirement). Files:
  orchestrator/{status-line,logger,framed-output,run}.ts; tests in
  status-line.test.ts (region mechanics, slot stability, overflow,
  buckets) + repinned framed-output/output-flow/cli suites.

- **2026-06**: Output redesign — flow-aware views + status line.
  OWNER RULES, do not re-litigate: flow is decided by SELECTION FLAGS
  ONLY — BROAD iff `--all` / `--filter` / `--affected` was passed,
  otherwise FOCUSED ("when just run no --all etc then single. cwd
  does not matter" — cwd and task count are irrelevant); broad mode
  keeps one `executed` one-liner per executed task (the news
  principle: executed work IS news, cache hits aren't — hits are
  per-task silent, replay dropped, counts live in the summary).
  Truthy `CI` env (not '0'/'false') → today's full grouped output;
  explicit `--output-logs` ALWAYS overrides. FOCUSED streams
  requested nodes raw + live (hit replay included — `vx run test`
  feels like running the command, just faster; quiet hits keep the
  one-liner, skips frame), deps silent-on-success / framed-on-fail.
  Programmatic run() without `flow` keeps 'full'. One outcome
  vocabulary everywhere: executed / restored-local / restored-remote
  / up-to-date / failed / skipped (TaskStatus enum + --summarize JSON
  keep raw enum values; bucket partition semantics unchanged). GHA:
  in full mode with GITHUB_ACTIONS truthy, blocks wrap in
  `::group::<id> (<word> <dur>)`/`::endgroup::`; FAILED tasks stay
  ungrouped + `::error title=<id>::failed (exit N)`; quiet-hit
  one-liners ungrouped. Status line (TTY && !CI only): single
  `▶ n running · d/t · ids · es [· f failed]` line, ESC[2K+\r rewrite
  (NOT a TUI), 100ms throttle + forced on task events; ALL
  default-logger stdout serializes through one writer
  (orchestrator/status-line.ts) — clear → content → redraw, redraw
  held while focused streaming sits mid-line; cleared permanently at
  runEnd and on first requested-task start in focused. Logger gained
  OPTIONAL runStart/taskStart/runEnd hooks (custom loggers
  unaffected). Test consequence: e2e suites that assert on default-
  logger output must pin env (delete CI/GITHUB_ACTIONS) or pass
  `--output-logs full` — otherwise they behave differently locally
  vs in Actions. Files: cli/run.ts (detectFlow),
  orchestrator/{logger,status-line,framed-output,run,options}.ts;
  tests/{output-flow,status-line}.test.ts.

- **2026-06**: `workspaceFiles` (owner-named) — workspace-root-anchored
  `cache.inputs.workspaceFiles` + `cache.outputs.workspaceFiles`, the
  Turbo `$TURBO_ROOT$` / Nx `{workspaceRoot}` equivalent. OWNER CALL,
  do not re-litigate: **no boundary rule** — these globs resolve from
  the workspace root and may match/capture files inside other
  projects' dirs ("they don't care about boundaries. it is bad
  practice but is there"); the hard nested-dir boundary keeps applying
  to project-relative `files`/`outputs` only, and the docs frame
  workspaceFiles as the documented escape hatch. **No CACHE_VERSION
  bump**, twice over: (a) inputs — resolved workspaceFiles (absolute
  paths) are appended to the same `inputFiles` list; rels are already
  workspaceRoot-relative in `Cache.key`, so they share the namespace
  naturally and a task without the field derives byte-identical keys
  (`workspaceFiles: []` vs absent pinned equal at the resolution+key
  level; the taskConfigHash still differs for the literal `[]` — by
  design, resolved-config hashing); (b) outputs — additive second
  artifact namespace `workspace-outputs/<rel-to-root>` beside
  `outputs/<rel>`; non-users produce byte-identical artifacts.
  outputsHash folds tar names, so the namespace prefix participates
  (`outputs/x` ≠ `workspace-outputs/x`). `output_files` rows: project
  rows stay bare rels; workspace rows store the full
  `workspace-outputs/<rel>` name as discriminator (no SCHEMA bump;
  `workspace-outputs/` is a reserved name for project output rels).
  Input resolution is git-aware via a workspace-wide GitFilesCache
  partition keyed by workspaceRoot: when any loaded config declares
  inputs.workspaceFiles, `populateGitFilesCache(..., workspaceWide)`
  drops pathspec scoping (enumerate '.') and stores files+OIDs for the
  root; unused → enumeration/spawns byte-identical (restore-git-spawns
  - git-oid suites unchanged). Staleness: `markOutputsChanged`
    forwards root-relative paths to the ws partition;
    `markWorkspaceOutputsChanged` fans root-anchored changed paths to
    every partition containing them; cache-miss saves with outputs also
    `invalidateWorkspacePartition()` (undeclared writes are only visible
    to git). `restoreOutputs`/`save` grew optional workspaceRoot /
    workspaceOutputFiles params. Overlapping workspace outputs between
    tasks = user responsibility (documented, not policed). Sandbox
    baseline allowWrite gains root-anchored static prefixes. Migrate:
    `$TURBO_ROOT$/x` + `{workspaceRoot}/x` map to the new fields
    (negation preserved); turbo `globalDependencies` preset spread
    re-pointed into inputs.workspaceFiles — the old files-list mapping
    was wrong (they're root-relative by definition). Watch gap closed
    in a follow-up: when any config declares inputs.workspaceFiles,
    `vx watch` swaps its per-project watchers for ONE recursive root
    watcher (boundaries are off, so any workspace file can be an
    input; the ignore filter still drops node_modules/.git/.vx churn;
    gate checks ALL projects' configs, broken ones skipped per
    scoped-run semantics). Files: config.ts, project-loader,
    cache/{inputs,cache,tar,layered-cache}, orchestrator/{task-hash,
    execute-task,prepare}, cli/migrate-{turbo,nx}; 23 tests in
    tests/workspace-files.test.ts + repinned migrate tests.

- **2026-06**: `vx migrate [--dry] [--force]` — onboarding generator
  from Turbo/Nx. Auto-detects: turbo.json → Turbo path (root
  tasks/pipeline + per-pkg `extends` per-key merge + scripts inlined
  as exec.command; task emitted only where the script exists);
  `.nx/workspace-data/project-graph.json` → Nx path (resolved
  snapshot ONLY — "plugin-inferred targets are frozen as static
  config" in the report header; nx.json-but-no-graph errors with the
  `nx graph --file=…` fixit; both sources → delete-one error).
  Deliberate calls: (a) TODOs are ALWAYS comments, never values —
  every generated config round-trips through loadProjectConfig in
  tests; human-input tasks get the valid placeholder
  `echo 'TODO(vx-migrate): fill in' && exit 1`; (b) turbo `env` maps
  to cache.inputs.env AND exec.env.passThrough (isolated-child-env
  rule), passThroughEnv to passThrough only; (c) turbo globals
  (globalEnv/globalPassThroughEnv/globalDependencies) become exported
  arrays in a generated root `vx-preset.ts` that configs import +
  spread — TS composition replaces turbo's global fields (consistent
  with the rejected named-inputs schema machinery); (d) generated
  configs are plain `export default { … }` with no `@vzn/vx` import —
  loadable in workspaces that haven't installed vx yet; a header
  comment points at defineProject(); (e) nx graph dependency edges
  are ignored (vx derives edges from manifests) except one report
  line counting edges with no manifest dep; (f) never overwrites
  vx.config.\* / vx-preset.ts without --force, and conflicts abort
  before ANY write. Files: `src/cli/migrate{,-turbo,-nx}.ts`; 23
  tests in tests/migrate.test.ts; docs/cli.md `## vx migrate`.

- **2026-06**: Introspection subcommands. `vx show [target]
[--format pretty|json]` prints LIVE resolved configs (same loader as
  the run path, scoped to the named project; deliberately NOT the
  lock — vx-lock.json is already the frozen JSON) — no target lists
  projects with task counts, `<project>` prints per-task blocks,
  `<pkg>#<task>` narrows to one; unknown targets are UserErrors with
  includes-match suggestions. `vx info` is the doctor printout
  (vx/bun/git versions, project + task counts, cache dir/entries/
  size/24h runs via Cache.stats, lock + remote-cache presence) and
  ABSORBED `vx stats`: `stats` stays as a deprecated alias of `info`
  (byte-identical output, help says so). Broken pieces degrade
  per-line (`git: (not found)`, broken config = 0 tasks), never fail
  the printout. Files: `src/cli/{show,info}.ts`; e2e + parser tests
  in `tests/show-info.test.ts`.

- **2026-06**: CLI pass. `--output-logs full|errors-only|none`
  shipped (logger-level gate; summary always prints). The `--cache`
  no-op flag REMOVED (a silently-accepted flag that does nothing is
  a footgun; vite-task parity not worth it). Interactive picker got
  injectable IO + its first tests. Named inputs and target defaults
  (old roadmap #1) REJECTED by owner: TypeScript configs compose —
  shared presets via import ARE our named inputs/defaults; schema
  machinery would duplicate the language. Don't re-propose.

- **2026-06**: Lock consumption moved behind `--frozen` (owner
  decision after a correct soundness rebuttal): byte-hashing a
  config can't see its IMPORT CLOSURE (shared presets), so default
  lock consumption gave false confidence locally. `vx run` = always
  live eval; `vx run --frozen` = configs from vx-lock.json (CI),
  hash tripwire + hard error when lockless; `vx lock`/`--check`
  unchanged as the only full-graph operations. pnpm-style
  auto-relock rejected: scoped runs evaluate only a dep closure and
  can't rewrite a whole-workspace lock. Lockfile renamed
  vx-lock.json (editor JSON recognition, package-lock precedent).

- **2026-06**: `vx lock` / `vx-lock.json` — frozen resolved-config
  lockfile. `vx lock` freshly evaluates every project config in the
  current env (per-invocation module-cache bust; the content-hash
  bust would replay a stale-env evaluation in-process) and writes
  `{ configPath, configHash (xxh3 of file bytes), config (resolved,
JSON-normalized) }` per project to `vx-lock.json`. Deliberate
  ASYMMETRY: **runs trust the lock** — when it exists, `prepareRun`
  loads configs from it after a hash-only file check, zero eval,
  frozen-env semantics (env reads keep lock-time values); stale
  file / missing entry is a hard UserError, never a silent fallback
  to evaluation. **`vx lock --check` audits it** — hash checks PLUS
  full re-eval + strict `Bun.deepEquals` against the stored object,
  catching eval-time env drift hashes can't see; mismatches exit 1
  naming each project ("lock differs from fresh evaluation in this
  environment (<project>) — env-dependent config? …"). This is the
  sound-dependency-story answer to the REJECTED transparent eval
  cache: explicit user action instead of purity heuristics. Only
  project configs are locked (not vx.workspace.\*). No CACHE_VERSION
  bump — keys still hash the resolved config object; the lock just
  pins it. Files: `src/workspace/lockfile.ts`, `src/cli/lock.ts`,
  one hook in `prepare.ts`; e2e in `tests/lock.test.ts`; design in
  `docs/design/config-lock-2026-06.md`.

- **2026-06**: Scoped config loading. prepare evaluated every
  project's vx.config.\* regardless of scope — 1090 imports (~200 ms
  - syscall churn) to run one task. Now only in-scope projects and
    their transitive dep closure load (frontier '^task' expansion
    never escapes the closure); anchored-only invocations scope to
    their anchors. Single-task wall on the 1090-package repo:
    0.32 s → ~0.19 s (turbo: 0.27 s). Deliberate Turbo-like semantic
    change: a BROKEN config in an out-of-scope package no longer
    fails a scoped run — it surfaces when that package enters scope
    (pinned in tests/scoped-config-loading.test.ts). Boundary
    geometry still considers every config-bearing project, loaded or
    not. Also: cache.get() became pure SQL (stdout in entries row,
    SCHEMA v20) — hit cost no longer scales with artifact size
    (118 ms → 5 ms for four ~70 MB binaries); and accessed_at bumps
    batch at flush (247 → ~190 ms on the stress repo, before the
    config-scoping win landed on top).

- **2026-06**: CACHE_VERSION → v21 + SCHEMA v19: **early cutoff**
  (vite-task-inspired, adapted to pre-execution keys). Downstream
  keys fold upstream `outputsHash` — content identity of the
  artifact's `outputs/<rel>` entries (path+bytes, sorted, mtimes
  excluded; computed in `writeArtifactAndIndex` for save AND ingest)
  — instead of the upstream task hash. Identical rebuilt outputs no
  longer cascade misses through the graph. Fallback to task hash
  when no outputs are declared (side-effect safety); groups roll up
  members' cutoff identities so cutoff propagates through umbrella
  tasks; plan path threads entry outputsHash so --dry predictions
  match runs. Two cascade tests re-pinned to the new contract
  (identical-output → dependent hits; output-change → re-runs).

- **2026-06**: CACHE_VERSION → v20 + SCHEMA_VERSION → v18. Input-file
  hashing switched from xxh3-of-content to **git blob OIDs** (Turbo's
  technique): the bulk enumeration spawn became `git ls-files -s
--others --exclude-standard -z` — `-s` lines carry `<mode> <oid>
<stage>\t<path>`, so ONE spawn yields the file lists AND every
  tracked file's index OID; one `git status --porcelain -z` spawn
  prunes paths whose worktree diverges (renames drop both sides,
  stage>0 and symlinks/gitlinks never get one — symlink index OIDs
  hash the target STRING, not content). Clean-tree key derivation
  now costs zero reads / zero per-file stats / zero SQLite (the
  resolveFiles exists-probe is also skipped for OID-trusted paths).
  Everything else falls back to `Cache.hashFile`, which computes the
  byte-identical blob OID in-process (`HASH("blob <len>\0"+bytes)`,
  object format lazily detected via `git rev-parse
--show-object-format`, sha1 default outside repos) behind the
  existing mtime+size memo — so a file's key contribution NEVER
  flips across dirty↔clean transitions (pinned by test: dirty-but-
  identical content == clean key; committing an untracked file
  doesn't change the key). Seam: `CacheKeyInput.fileHashes?:
ReadonlyMap<abs, oid>`; carrier: `GitFilesCache.setOids/oidsFor`
  per projectDir, populated by `populateGitFilesCache` (signature
  now takes GitFilesCache), dropped wholesale on `set`/`delete`
  (mid-run re-enumeration can't re-trust index OIDs without a fresh
  status — fallback is identical-value, so purely a perf
  concession) and per-path on `markOutputsChanged`. File-set
  visibility byte-identical to the old `--cached --others` (verified
  empirically incl. staged-but-deleted, conflict stage-duplicates,
  tab-containing filenames; `-z` disables quotePath so the
  fixed-form `^[0-7]{6} [0-9a-f]{40,64} [0-3]\t` prefix is the
  disambiguator). SCHEMA bump because pre-v20 `file_hashes.
content_hash` rows hold xxh3 digests that must not leak into the
  OID domain via the memo. package.json hashing rides the same map.
  Tests: tests/git-oid.test.ts (18: hash-object KATs incl. sha256
  repos, harvest/trust rules, GitFilesCache bookkeeping, fileHashes
  seam, dirty↔clean key-stability guardrails, zero-read clean-tree
  pin). The two git spawns run CONCURRENTLY
  (`populateGitFilesCache` is now async; the bulk path uses
  Bun.spawn, the per-project fallback stays spawnSync) — serial
  spawning measurably regressed few-files-per-project fixtures,
  since `git status` alone costs ~74 ms on a 1000-project tree.
  Measured: at 1-3 files/project the change is noise (the degenerate
  case); at a realistic 30 files/project (500 projects, 15k files)
  warm run-phase drops 245 ms → 76 ms — 3.2× — and the win scales
  with file count (per-file stat+SELECT replaced by git's C-speed
  scan). Cold first runs also win: committed file contents are never
  read by vx at all.

- **2026-06**: CACHE_VERSION → v19. `'^task'` dependsOn expansion
  switched from transitive-deps to **nearest-holder frontier**: walk
  the package dep graph from the project's DIRECT deps; each path
  stops at the first package declaring the task (edge added there);
  packages without the task are passed through (sparse bridging —
  vx extension over Turbo); nothing past a holder is walked — the
  holder's own dependsOn owns deeper ordering. Turbo and Nx are both
  direct-deps-only; vx's transitive reach existed solely to bridge
  sparse deps, and on dense graphs it exploded edge count (~10x more
  edges than needed on the 1090-package/100-layer report repo),
  driving computeGroupHash sorting (103 ms), addNode dep-sorts
  (66 ms), scheduler closure size, and upstream-hash folding.
  Reachability/ordering closure is identical whenever holders chain
  `'^task'` themselves (the universal pattern); a holder that
  doesn't is now a documented stopping point (Turbo parity). Bumped
  because filtered-upstream-hash sets shrink → same inputs derive
  different keys. Implementation: `PackageGraph.directDeps(name)`
  accessor reintroduced (reads the eager adjacency; bitset closure
  code untouched); frontier walk in `task-graph.ts` replaces the
  `transitiveDeps` loop. `'^*'` in cache.inputs.tasks is a FILTER
  over graph edges (upstream.ts) — untouched; `filter.ts` /
  `affected.ts` transitive traversals are non-expansion consumers —
  untouched. Tests: 4 new frontier pins in tests/task-graph.test.ts
  (nearest-holder chain, sparse bridge, stop-at-holder, shared-
  subtree dedup) + directDeps accessor test.

- **2026-06**: Scheduler priority closure switched to bitsets. User
  report: 10 s FULL-CACHE run on a 1090-package, 100-layer dense
  repo. CPU profile: 8.5 s in `reachOf` — the transitive-reverse-dep
  priority computed via memoized DFS over `Set<string>`s, O(N²)
  entries on dense layered graphs. Replaced with an exact bitset
  closure swept in reverse-topo order (own Kahn pass — correctness
  must not hinge on Map insertion order being topo): O(E·N/32),
  ~1.3 MB at 3270 tasks. Same priority contract, byte-identical
  scheduling. Result: 10.2 s → 1.27 s wall on the report repo.
  Perf guard in tests/scheduler.test.ts (dense 100×30 graph with
  5-layer-deep edges; old code 7.2 s, bound 1.5 s, new code ~50 ms).

- **2026-06**: `persistent.readyTimeoutMs` shipped. A persistent task
  whose `readyWhen` never matches while the child keeps running hung
  the run forever. The timer SIGTERMs the child and rejects ready
  with a timeout message; cleared the moment ready fires. Requires
  `readyWhen` (loader-enforced); deliberately no default. Also
  2026-06: a resolved-config eval cache (cache pure-literal configs
  on content hash to cut the 199 ms config-eval cost at 1000
  projects) was designed and REJECTED by the owner — the static
  purity gate is correctness-critical heuristic machinery for a
  modest win. Rationale + numbers in docs/benchmarks.md headroom;
  don't re-propose without a sound dependency story.

- **2026-06**: Module-isolation series complete (steps 1-7 of
  `docs/design/module-isolation-2026-06.md`). `src/` is now eight
  contract modules (`util`, `config`, `workspace`, `graph`, `cache`,
  `exec`, `orchestrator`, `cli`) plus three root files (`bin.ts`,
  `index.ts`, `version.ts`). Each directory module's `index.ts` is
  its contract; cross-module imports of internals fail
  `tests/module-boundaries.test.ts`, which also pins the allowed
  dependency matrix (composition only at orchestrator + cli;
  `cli → exec` deliberately absent). What landed across the series:
  cycle breaks via `version.ts` + `orchestrator/options.ts` (step 1);
  `ProjectEntry`/`nested-dirs`/`fingerprint` → workspace and
  `plan-format` → cli relocations (step 2); hashing surface split out
  of `execute-task.ts` into `orchestrator/task-hash.ts` — kept in
  orchestrator, NOT cache, because key-part selection composes graph
  types (step 3); leaf contracts cache/exec/util (step 4), then
  workspace/graph (step 5); finally `orchestrator.ts` →
  `orchestrator/{index,run}.ts` and `cli.ts` → `cli/index.ts`, with
  CONTRACTED covering every directory module (step 6) and the docs
  refresh (step 7). Zero behavior change throughout; public API of
  `src/index.ts` byte-identical; no CACHE_VERSION bump (key
  derivation untouched). Convention going forward: new cross-module
  surface is exported from the owning module's `index.ts`, and any
  new top-level file/dir forces an explicit matrix decision in the
  boundary test.

- **2026-06**: HMAC artifact signing for the remote cache, gated by
  `VX_REMOTE_CACHE_SIGNATURE_KEY` (roadmap item #2's signing half;
  pre-signed URLs still open). Byte-compatible with Turbo's
  `signature_authentication.rs` scheme so vx interops with signing
  servers/clients: `tag = base64(HMAC-SHA256(key, utf8(hash) ||
utf8(teamId ?? '') || artifactBytes))`, carried in `x-artifact-tag`.
  Implementation lives entirely in `RemoteCache`
  (`RemoteCacheConfig.signatureKey?: string`; env parsed in
  `remote-cache-setup.ts`): PUT signs the outgoing bytes, GET verifies
  the response tag against the received body via
  `crypto.timingSafeEqual`. Two deliberate calls: (a) missing tag on
  GET is a hard `RemoteCacheError` when the key is set — a signing
  deployment must not silently accept unsigned artifacts (Turbo
  verifies too; the hard-fail-on-missing is stricter); (b) we kept
  Turbo's `teamId` in the construction, NOT the `taskId` variant the
  integrity-audit sketch proposed — interop wins. No key → behavior
  byte-identical to before (no header, no verification). LayeredCache
  needed zero changes: the verification error rides the existing
  RemoteCacheError → `onRemoteError` + cache-miss degradation, so a
  tampered artifact re-executes the task. Tests: signing block in
  `tests/remote-cache.test.ts` (tag KAT computed in-test with
  node:crypto, missing-tag, tamper, no-key passthrough, empty-teamId
  folding), tamper-degrades-to-miss e2e in
  `tests/layered-cache.test.ts`, env→wire round-trip + tamper-recovery
  e2e in `tests/orchestrator-remote.test.ts`. No CACHE_VERSION bump —
  the artifact bytes and key derivation are untouched.

- **2026-06**: Warm-restore git re-spawn fix. User report: restoring
  100 tiny outputs took 920 ms vs 113 ms intact (8x). Evidence: a git
  PATH-shim showed 81 per-project `git ls-files` re-spawns — the
  post-restore `gitFilesCache.delete` from the v14-era staleness rule.
  Fix: `GitFilesCache` class (extends Map; same bulk-populate API). On
  restore we know the exact changed paths (cleaned declared outputs +
  artifact outputFiles) — `markOutputsChanged` records them and
  `snapshotFor(globs)` reuses the snapshot when a downstream task's
  input globs can't match any changed path (provably identical to a
  re-spawn; glob matching ignores gitignore status when paths don't
  match). Overlapping globs still re-spawn → gitignore semantics
  byte-identical. Save path keeps the unconditional drop (undeclared
  writes are only visible to git). `cleanOutputs` now returns the
  deleted rel paths. Result on the report repo: 920 ms → 136 ms, git
  spawns 81 → 1. Tests: tests/restore-git-spawns.test.ts pins both
  spawn counts AND the fallback's cache-hit stability via a CLI
  subprocess + PATH shim (in-process PATH mutation doesn't affect
  Bun.spawn executable resolution). Also: bench/ folded into
  tsconfig + lint inputs (its absence rode a stale lint cache-hit).

- **2026-06**: SIGINT/SIGTERM handling in `run()`. Closes the
  runner-comparison gap "children orphaned on mid-run signal": a
  programmatic signal to the vx process alone (CI cancellation,
  `kill <pid>`) previously left one-shot AND persistent children
  running. Design: a run-scoped `liveChildren: Set<Subprocess>` —
  `runCommand` / `runPersistent` / `runSandboxed` add each child on
  spawn and remove it on exit (new optional `liveChildren` field on
  their options). `run()` installs SIGINT/SIGTERM handlers after the
  cache opens and removes them in a `finally`, so repeated runs in
  test suites never stack listeners. On signal: SIGTERM everything in
  `liveChildren` + `persistentRegistry`, close the cache handle, then
  `process.exit(signalExitCode(signal))` — 130/143 per the POSIX
  128+signo convention (`signalExitCode` is a new export in
  `src/exec/runner.ts`). v1 deliberately does NOT cancel scheduling
  or plumb AbortController through executeTask — the process exits
  immediately after forwarding SIGTERM. Known limit: only direct
  children are signalled (no process groups), so a double-forking
  task can still orphan grandchildren. Watch mode opts out via the
  new `RunOptions.handleSignals: false` — the loop owns signal
  disposition for its whole lifetime (its `process.once` handlers
  close watchers and resolve 0); a cycle's run() exiting the process
  would kill the loop (and, in tests, the bun test process — the
  watch e2e suite simulates Ctrl-C with `process.emit('SIGINT')`,
  which is delivered to every listener in-process). New
  `tests/signal-handling.test.ts`:
  3 e2e tests spawn the real CLI and assert exit code + child death
  via pidfile + `kill(pid, 0)`, 1 in-process test pins listener
  counts across repeated runs.

- **2026-06**: CACHE_VERSION → v18. Env-value folding in `Cache.key()`
  switched its name/value delimiter from `=` to `\0` — `("A", "B=C")`
  and `("A=B", "C")` folded identical bytes. Unreachable from a real
  POSIX environ (names can't contain `=`), bumped anyway: the key
  derivation's invariant is unambiguous part boundaries, and file
  inputs already used `\0`. Found by the June 2026 six-reviewer bug
  sweep, which also produced: run() counting remote hits as failures
  (PR #109 — the `ok` predicate omitted `cache-hit-remote`; first e2e
  remote-layer test added), absolute-path validation gap in
  `cache.inputs.files` (PR #110), macOS sandbox `allowWrite: ['/tmp']`
  never matching because SRT keeps the literal path when bare-`/tmp`
  symlink resolution trips its boundary guard — vx now realpaths user
  sandbox paths itself (PR #111), and corrupt remote artifacts going
  live before validation + crashing the run instead of degrading to a
  miss (PR #113, typed `CorruptArtifactError`, validate-before-rename).

- **2026-05**: Dead-code cleanup pass — drop the TUI-era observer
  subsystem and other no-consumer surfaces. -1305 LOC across 28 files,
  no behaviour change.

  Removed:
  - **Observer subsystem** (`src/orchestrator/observer.ts` deleted):
    `Observer`, `ObserverEvent`, `HistoryTable`, `TaskHistory`,
    `makeSafeObserver`, and the `RunOptions.observer` field. The TUI
    consumed this; the TUI was deleted weeks ago. Six tests removed
    (the dedicated observer.test.ts plus the three orchestrator-level
    observer e2e tests). Scheduler's `slot` parameter on
    `execute`/`onStart` was part of this surface — dropped along with
    the `Uint8Array` slot allocator (the no-consumer-side benefit was
    "stable per-slot timelines for TUI panels" which no longer have
    a renderer).
  - **`Cache.getTaskHistory` + `TaskHistoryRow`/`TaskHistoryMap`**:
    designed to feed TUI ETA + Bottlenecks panels. No production
    caller. ~110 LOC including the per-pair CTE query.
  - **`Cache.getMetaBatch` + `CacheEntryMeta`**: batch metadata probe
    for a leaf-task upfront-batch optimization that never wired into
    `execute-task.ts`. ~50 LOC + 90 LOC of perf tests.
  - **`LayeredCacheOptions.onRemoteRequest`/`onRemoteHit`**: drove the
    TUI's remote-cache panel. Telemetry survived only as the
    `onRemoteError` hook the CLI uses to log warnings.
  - **`RemoteCache.has` + `batchExistence` + `RemoteBatchInfo`**:
    speculative API surface, no caller. Same for `tag`/`ci`/
    `interactive` metadata on `RemotePutMetadata` and `tag` on
    `RemoteGetResult`.
  - **`PreparedRun.projects`/`packageGraph`**: returned but never read
    by `run()` or `planRun()`. Tests asserting on them rewritten to
    assert on `nodes`.
  - **`PackageGraph.byName`/`directDeps`**: on the interface but no
    consumer reads them outside the constructor. Kept as locals
    inside `buildPackageGraph`.
  - **`TaskOutcome.stdout`/`stderr`**: populated by `execute-task.ts`
    but no production reader (live stream goes through
    `taskStdout`/`taskStderr` logger callbacks). The two
    orchestrator tests that asserted on `o.stderr`/`o.stdout` now
    assert on the live `fixture.err`/`fixture.log` arrays instead.
  - **`RunRecord.bytesUploaded`/`bytesDownloaded`** + the matching
    SQL columns: never populated by production. Schema row narrowed.
  - **`noopLogger()`**: zero callers, comment referenced the deleted
    TUI.
  - **`WatchLoopArgs.cacheDir`**: passed through then explicitly
    `void`-discarded; ~5 LOC + one less file read at startup.

  Refactors:
  - **`formatTaskBlock(body: TaskBlockBody | string)`** narrowed to
    `body: TaskBlockBody`. The string-body back-compat existed for
    "older tests + embedders" — pre-alpha, no embedders, tests
    rewritten to wrap in `{ stdout: '...' }`.
  - **`listGitTrackedFiles`** (3-line wrapper around `runGitLsFiles`)
    inlined. Caller now calls `runGitLsFiles` directly.
  - **`xxh3hexOf`** (3-line wrapper) deleted; two callers inline
    `.toString(16).padStart(16, '0')`.

  Bug fix bundled in:
  - **`vx cache prune` honors `defineWorkspace({ cacheDir: ... })`**.
    Previously hardcoded `path.join(root, '.vx', 'cache')`, so a
    user-relocated cache dir was silently pruned against the wrong
    path. Now uses `resolveCacheDir(root, workspaceConfig)`.

  Verified: 499 tests pass, `oxlint` + `oxfmt` clean. Cache key
  derivation unchanged; the SQL schema dropped only NULL-only
  columns. Existing `<hash>.tar.zst` artifacts still load (the v17
  format from the previous pass is unchanged).

- **2026-05**: Drop the `ignore` npm dep — vx now hard-requires git.
  `src/cache/inputs.ts` no longer parses `.gitignore` via the `ignore`
  library; it defers entirely to `git ls-files --cached --others
--exclude-standard` for the input file set. When git is absent or
  the workspace isn't a git work tree, `resolveFiles` (and
  `populateGitFilesCache`) throw a `UserError` with a clear "vx
  requires git: run `git init`…" message instead of silently
  degrading. Net: -1 npm dep, -~30 LOC (`loadGitignore` gone), tests'
  `makeWorkspace()` helpers gained a 3-line `git init` block.

  Also fixed: a latent staleness bug in the bulk `gitFilesCache`
  snapshot. The snapshot is taken at the top of a run; if an
  upstream task in project P writes outputs, a downstream
  same-project task that resolves inputs after it would otherwise
  miss those files. `execute-task.ts` now drops the project's cache
  entry after cache.save (cache miss) or cache.restoreOutputs
  (cache hit) when the task has declared outputs — the next
  resolveFiles call re-spawns git for that dir. Pre-existing bug;
  the previous non-git fallback masked it by walking the live FS.

- **2026-05**: Cache v17 — artifact carries only logs + outputs;
  unified local/remote format; stderr no longer cached.

  The cache artifact (`<cacheDir>/<hash>.tar.zst`) is now exactly:

  ```
  stdout            (always present; may be empty)
  outputs/<rel>     (declared output files, when any)
  ```

  No more `meta.json`, no more stderr entry. The artifact carries only
  replayable bytes; entry metadata (taskId, command, durationMs,
  storedAt) lives in the SQLite `entries` row — the queryable index.

  Local and remote layers transport the **same** tar.zst bytes
  end-to-end. `cache-archive.ts` (the parallel tar.gz format with
  meta.json) is gone, along with `LayeredCache.stageAndPack` /
  `unpackArchive` / the stage-dir dance. `LayeredCache.save` reads
  the just-written local artifact off disk and uploads it verbatim;
  on remote-hit, the body is written straight to `<hash>.tar.zst`
  and ingested via `Cache.ingest(hash, bytes, meta)`.

  Metadata routing: `CacheLayer.get(hash, ctx?)` accepts an optional
  `{ taskId, command }` context. The local Cache ignores it (entries
  row has everything); the LayeredCache forwards it to `ingest()` on
  remote-hit alongside `durationMs` pulled from the remote response's
  `x-artifact-duration` header. Orchestrator + plan call sites have
  `node` in scope, so passing ctx is essentially free.

  Why drop stderr? We only cache successful runs (the `effectiveExitCode
=== 0 && cacheEnabled` gate in `execute-task.ts`). Successful runs
  rarely write meaningful stderr; storing it cost artifact bytes for
  near-zero value. Live runs still stream stderr through the logger,
  failed-task stderr still surfaces on the outcome and via the framed
  block — only the cache-hit replay path changes (stdout only).

  Why always store stdout? Predictability: the archive layout is now
  exactly "one `stdout` entry + zero-or-more `outputs/<rel>` entries".
  No conditional branches at extract time, no "is this entry missing
  because the original stdout was empty, or because the artifact is
  corrupt?" ambiguity.

  `CACHE_VERSION` + `SCHEMA_VERSION` bumped to v17. Old entries are
  dropped on first run (schema gate); old artifacts become orphans
  and reap on `vx cache prune`. Pre-alpha, no migration cost.

  Net: −1 module (`cache-archive.ts`), −1 test file
  (`cache-archive.test.ts`), 506 tests pass, `oxlint` + `oxfmt` clean.
  `Cache.save` internally split into `packArtifact` + private
  `writeArtifactAndIndex`; the latter is the shared path both `save`
  and `ingest` write through, so the SQL-row insertion logic lives in
  exactly one place.

- **2026-05**: Refactor pass — perf + simplification, no behavior change.
  Thirteen focused tweaks across the hot paths, all preserving public
  API and cache key derivation:
  1. **Scheduler tick is now O(N + E)** instead of O(N²). Old loop
     walked `scheduleOrder` (every node) on every completion. New
     design: `pending[id]` dep-counters + a `ready[]` priority queue
     pushed-to on `pending → 0`. Slot allocator switched from a
     sorted free-list (`unshift + sort` per release) to a
     `Uint8Array` busy bitmap with a linear scan over `[0,
concurrency)`. Same priority contract: higher transitive-reverse-
     dep count first, ties break in graph-insertion order via a
     binary-search-insert that respects existing equals.
  2. **`detectCycle` is iterative** with a numeric-indexed
     `Uint8Array` color array instead of recursion + `Map<string,
number>`. Removes V8 stack-frame ceiling risk on deep `dependsOn`
     chains and skips the per-node Map lookup cost.
  3. **`nested-dirs.ts` is O(P log P)** instead of O(P²). Sort projects
     by `dir`; each project's nested set is the contiguous prefix-
     matched suffix immediately after it. Same output, no behaviour
     change.
  4. **Logger buffers chunks as `string[]` then joins on flush** —
     replaces `Map<string, string>` accumulation via `+=`, which was
     O(N²) over total bytes for chatty long-running tasks (each `+=`
     allocates a fresh string of full accumulated length).
  5. **Dead tar manifest API removed** from `src/cache/tar.ts`:
     `Manifest`, `ManifestEntry`, `buildManifest`, the optional
     `manifest?` arg to `extractOutputs`, and the skip-if-matches
     branch + `ExtractResult` return. v16 dropped the manifest.json
     entry from the artifact already (file fingerprints live in the
     `output_files` SQL table); the API surface lingered with no
     callers. ~70 LOC down.
  6. **`prune` deletes in a single transaction + parallel rm** instead
     of N round-trips + serialized unlinks. ON DELETE CASCADE handles
     `output_files`. Hashes are bound with placeholder IN-list (≤ N
     stay well under SQLite's 999 limit in practice).
  7. **`workspace.listProjects`** runs the package globs concurrently
     via `Promise.all` (was serialized). Same dedup pass after.
  8. **`Bun.color` results memoized** in `src/orchestrator/colors.ts`.
     Pure function called thousands of times per run with one of four
     hex strings — the new `ansiCache` Map turns those into hits.
  9. **`Bun.Glob`** replaces hand-rolled `globToRegex` in
     `src/workspace/filter.ts:matchProjects`, and replaces the
     readdir + recurse + dynamic-import in
     `src/cache/layered-cache.ts:listFilesRecursive`.
  10. **`AbortSignal.timeout`** replaces the manual
      `AbortController + setTimeout + clearTimeout` ceremony in
      `RemoteCache.fetch`. Also catches `TimeoutError` in addition
      to `AbortError` for the timeout path.
  11. **`toPosix` Linux fast-path** — returns `p` unchanged when
      `path.sep === '/'`, skipping `split + join` on the dominant dev
      platform.
  12. **Hoisted dynamic import** out of `prepareOutputsForBind` (was
      `await import('node:fs/promises')` per sandboxed task) and out
      of `listFilesRecursive` (was per-call).
  13. **Cleanups**: `void id` dead loop var in the persistent-task
      shutdown loop (Bun's `Subprocess.kill` is idempotent on exited
      children), redundant `tasks.length === 1` ternary in
      `formatHeader`, `.map(String)` defensive coercion on an already-
      typed `readonly string[]` in `cli/run.ts:parseRunArgs`, and a
      `filter().map()` two-allocation idiom in `upstream.ts` →
      single-pass `for-of` push.

  Verified: 518 tests pass (no test changes); `oxlint --type-aware
--type-check` clean; `oxfmt --check` clean. Cache schema/format and
  cache key derivation unchanged — no `CACHE_VERSION` bump needed.

- **2026-05**: Sandbox refactored to per-task config + fail-on-violation.
  Drops the `--sandbox` CLI flag and `RunOptions.sandbox` entirely;
  activation is declarative via `sandbox: {}` (or `sandbox: { ... }`)
  in each task's config. No workspace inheritance, no built-in escapes
  for `node_modules` / `/tmp` — users declare everything explicitly so
  a single `vx.config.ts` describes the full task permission surface.
  `SandboxConfig` in `src/config.ts` mirrors SRT's full user-facing
  schema (filesystem allow/deny, network as `boolean | NetworkConfig`,
  `allowGitConfig`, `allowPty`, `enableWeakerNestedSandbox`,
  `enableWeakerNetworkIsolation`, `ignoreViolations`) with strict
  loader validation (allowlist of known fields, type checks, no globs
  in path lists). Policy switched from "detect-and-skip-cache" to
  **fail-on-violation**: on macOS, a non-empty `SandboxViolationStore`
  after exec forces exit code 1 + appends violation lines to stderr;
  on Linux, bwrap's structural deny means the child sees `ENOENT` and
  typically fails naturally. Lazy SRT init — `probeSandbox` +
  `initSandbox` only fire when at least one node in the graph has
  `node.config.sandbox`. Baseline `allowRead` = resolved
  `cache.inputs.files`; baseline `allowWrite` = static prefix of every
  `cache.outputs.files` glob; baseline `denyRead` = workspace root.
  Linux silent-swallow case (tools that catch `ENOENT` and continue)
  is acknowledged — strace-based per-process detection coming in a
  follow-up commit on the same branch.

- **2026-05**: Sandbox revived as opt-in layer via
  `@anthropic-ai/sandbox-runtime` (SRT). New module
  `src/exec/sandbox-runtime.ts` is a thin wrapper around SRT's
  `SandboxManager` + `SandboxViolationStore`. Initially shipped with
  a `--sandbox` CLI flag + "detect-and-skip-cache" policy; refactored
  the same day (see entry above) after user feedback to per-task
  config + fail-on-violation.

- **2026-05**: Bun-builtins audit. Replaced the hand-rolled 50-LOC
  Crockford-base32 ULID generator (`src/util/ulid.ts`) with a thin
  wrapper over `Bun.randomUUIDv7()`. UUIDv7 is RFC 9562's timestamp-
  prefixed UUID — 48-bit ms-epoch + 74 bits of randomness, lex-
  sortable, standard format. `run_id` strings change from 26-char
  Crockford (`01JABC…`) to 36-char hex (`019e3255-9a99-7000-…`); pre-
  alpha so no migration burden. Wider audit findings recorded for
  posterity: `Bun.Archive` benchmarked **15-400× slower** than our
  `extractOutputs` for typical cache artifacts (KB-MB range, flat
  trees) — fixed JS-bridge overhead dominates Bun.Archive for small
  archives. Kept our hand-rolled `parseTarHeaders` + `extractOutputs`
  in `src/cache/tar.ts`. APIs we already use: `Bun.YAML`,
  `Bun.Glob`, `bun:sqlite`, `Bun.hash.xxHash3`,
  `Bun.zstdCompress/Decompress`, `Bun.spawn`, `Bun.color`,
  `Bun.file`, `Bun.write`, `Bun.nanoseconds`, `Bun.sleep`. APIs with
  no consumer in our code: `Bun.semver`, `Bun.deepEquals`,
  `Bun.stripANSI`, `Bun.stringWidth`, `Bun.which`, `Bun.JSONC`,
  `Bun.TOML`, `Bun.password`, `Bun.markdown`, `Bun.serve`. `Bun.env`
  is an alias for `process.env`; pure cosmetic swap not worth the
  churn. `fs.watch` in `src/cli/watch.ts` has no Bun equivalent.
- **2026-05**: CACHE_VERSION → v15. Hash algorithm swapped from
  SHA-256 (`Bun.CryptoHasher`) to xxHash3 (`Bun.hash.xxHash3`) at
  every cache-key derivation site: `Cache.key()`,
  `hashFileFromDisk()`, `hashTaskConfig()`, `computeGroupHash()`,
  `computeWorkspaceFingerprint()`, and the config-load module
  cache-busting in `project-loader.ts`. Cache keys shrink 64 hex →
  16 hex (matches Turbo's xxh64 width), derivation is ~5× faster on
  the cache-warm path. xxHash3 has no streaming Hasher API in Bun,
  so `Cache.key()` chains updates via the seed parameter
  (`xxh3(part, prevDigest)`); `hashFileFromDisk` reads the whole
  file before hashing — fine for source files. New shared helper
  `src/util/hash.ts` exporting `xxh3`, `xxh3hex`, `xxh3hexOf`.
  SCHEMA_VERSION bumps to v15 in the same change (PR #86's tar.zst
  work already took v14): `file_hashes.sha256` column →
  `content_hash`, and the migration path now `DROP`s stale tables
  before `CREATE TABLE IF NOT EXISTS` runs so column renames take
  effect on existing DBs. PR #87.
- **2026-05**: TUI dropped entirely. After six PRs (#73, #74, #75,
  #76, #77, #79, #80, #81) trying React, then Solid, then patching
  the painter, the user's verdict was "still freezing, no screens
  for tasks without logs, very bad — drop it for now." The right
  call. `src/tui/` deleted, `@opentui/*` / `solid-js` /
  `xterm-headless` / `@types/babel__core` removed, `bunfig.toml`
  removed, `tsconfig`'s `jsx` / `jsxImportSource` reverted, the
  `--tui` / `--no-tui` CLI flags removed.

  What survived from the TUI work:
  - `src/orchestrator/observer.ts` — the tagged-union `Observer`
    contract + `makeSafeObserver` wrapper. Useful for embedders,
    future dashboards, structured-event consumers.
  - `RunOptions.observer?: Observer` wiring + emit sites in the
    orchestrator (`runStart`, `taskStart`, `taskStdout/Stderr`,
    `cacheProbe`, `taskComplete`, `runEnd`, `remoteCache`). No
    runtime cost unless a consumer subscribes.
  - Scheduler worker-slot allocation (`runGraph` allocates lowest-
    free-index slots, passes `slot: number` to `execute()` /
    `onStart()`). Stable allocation across runs.
  - `Cache.getTaskHistory(taskIds)` — batched SQL CTE returning a
    `TaskHistoryMap`. Used by `prepareRun` so any future consumer
    has per-task aggregates cheap.
  - `LayeredCacheOptions.onRemoteRequest` — remote-cache request
    callback. Currently no consumer; useful when telemetry lands.
  - `noopLogger()` in `src/orchestrator/logger.ts` — minimal
    Logger that drops every call. Already used by embedders.
  - Design docs `docs/design/tui.md`, `docs/design/tui-design.md`,
    `docs/design/tui-rebuild.md`, `docs/design/tui-claude-code.md` —
    kept as a record of what was explored and why it didn't ship.

  Tests: 506 → 434 (deleted all TUI-specific tests + the `--tui`
  parser test). The remaining 434 cover orchestrator, scheduler,
  cache, CLI, watch, persistent tasks, observer, etc.

  Lessons logged in `docs/design/tui-claude-code.md`: production-
  grade terminal UIs (Claude Code, lazygit, fzf, btop) all
  hand-roll the cell-buffer + ANSI emitter. They use
  `react-reconciler` for the component API but write the painter
  themselves. The existing React/Solid-on-OpenTUI stack has too
  many leaky abstractions for our use case.

- **2026-05**: TUI rebuild — wholesale rewrite on `@opentui/solid`
  - `@opentui/keymap` + `xterm-headless`, scrapping the React-based
    Phase 1-3B implementation. Three drivers (see
    `docs/design/tui-rebuild.md`):
  1. **opencode uses Solid not React.** The OpenTUI maintainers'
     own TUI runs on `@opentui/solid`; the React reconciler caused
     the ghosting / overlay-bleed problems we kept fighting. Solid's
     fine-grained reactivity has no VDOM diff to race the OpenTUI
     painter.
  2. **`xterm-headless` for per-task log panes.** Mirrors Turbo's
     `vt100` parser: each task's stdout/stderr feeds an
     `xterm-headless` Terminal; the pane reads `buffer.active.getLine`
     rows. Build-tool output (`\r` overwrites, ANSI cursor escapes,
     progress bars) now renders correctly. xterm-headless 5.x still
     references browser `window`/`self` globals in its bundle — we
     shim them to `globalThis` before importing.
  3. **Scope cut to match Turbo.** One screen: TaskList (left,
     sorted Turbo-style — running first w/ spinner, planned, then
     finished by failure→success→cache) + LogPane (right, reads the
     selected task's pty buffer) + StatusBar + Help dialog. No 5
     view-tabs, no sparklines, no critical-path widget, no auto-exit
     countdown. q / Ctrl-C exits.

  Architecture mirrors opencode's TUI:
  - `src/tui/context/helper.tsx` — `createSimpleContext` factory.
  - `src/tui/context/{theme,run-state,pty-store}.tsx` — Solid
    contexts (no single reducer; each subsystem owns its state).
  - `src/tui/ui/dialog.tsx` — modal Dialog using
    `position="absolute"` full-viewport with `zIndex={3000}` +
    translucent `RGBA.fromInts(0,0,0,150)` backdrop, popup centered
    inside via `alignItems="center" + paddingTop`. Opencode's exact
    pattern.
  - `src/tui/component/{task-list,log-pane,status-bar,pty-output}` —
    components + the xterm-headless wrapper.
  - `src/tui/overlay/help-dialog.tsx` — Help bound to `m`
    (Turbo convention).
  - `src/tui/tui.tsx` — entry: `createCliRenderer` + `render(<App />)`
    inside `ThemeProvider > RunStateProvider > PtyStoreProvider >
DialogProvider`.

  Tsconfig: `jsx: preserve`, `jsxImportSource: @opentui/solid`.
  `bunfig.toml` adds `preload = ["@opentui/solid/preload"]` for
  `bun run` / `bun test`; the CLI also does
  `await import('@opentui/solid/preload')` before lazy-loading the
  TUI so installed-binary users (different cwd) also get the
  babel-preset-solid plugin registered.

  Deps: removed `@opentui/react`, `react`, `@types/react`. Added
  `@opentui/solid`, `@opentui/keymap`, `solid-js`, `xterm-headless`,
  `@types/babel__core` (for tsc strictness against the OpenTUI
  preload script).

  Tests: 506 → 436 (deleted the React-binding-specific tests; kept
  the orchestrator-side Observer + scheduler tests). One Solid smoke
  test verifies the new TUI mounts under OpenTUI's `testing: true`
  mode.

- **2026-05**: TUI Phase 3B — polish PR. Three additions on top of
  Phase 3 (497 → 506 tests):
  1. Filter input (`/`). State gains `filterEditing: boolean`; the
     reducer adds `startFilterEdit` / `endFilterEdit` key actions.
     The App's keyboard handler routes printable keys + Backspace +
     Enter/Esc to filter editing when active. `selectFilteredTasks`
     is a substring (case-insensitive) match on `${project}#${task}`
     keyed by `state.filters[activeView]` (per-view, not global).
     The TaskList title shows the active filter.
  2. **Post-run auto-exit** (3s, cancelable). On `runEnd`, the
     reducer sets `state.autoExitAt = Date.now() + 3000`. A new
     `AutoExit` overlay shows a 1Hz countdown over the final frame.
     Any key dispatch clears `autoExitAt` (the user is engaged; the
     TUI stays open until they press q). The sampler tick flips
     `autoExitTriggered` when the deadline passes; `startTui` exposes
     `waitForExit()` that resolves on q / Ctrl-C OR autoExitTriggered.
     `cli/run.ts` awaits it between `runEnd` and `dispose()`.
  3. Context-sensitive `StatusBar` — keymap hints change by
     `activeView` (Overview vs Graph vs Workers vs Bottlenecks vs
     Queue) and by mode (filter-editing vs help-open vs default).
     Shows the view name + number on the left.

- **2026-05**: TUI Phase 3 — multi-view + overlays + stats panel.
  Adds the four follow-on views (Graph, Workers, Bottlenecks, Queue)
  and two overlays (Help, Task Detail) on top of Phase 2B's
  Overview layout. Keyboard: `1`-`5` selects view; `?` toggles
  Help; Enter opens Task Detail; Esc closes overlays. The reducer
  gained two per-tick counters (`completedSinceTick`,
  `remoteOpsSinceTick`) so the 1 Hz sampler now drives real
  throughput + remote-ops sparklines (Phase 2A's stubbed `0`s are
  gone). New `StatsPanel` shows the three sparklines stacked under
  the task list on Overview. `Bottlenecks` runs the topo-DP
  critical-path live and ranks top blockers / slow-vs-history /
  cache-miss impact via the Phase 2A selectors. Tests: 497 → 499
  (added reducer key/overlay tests). All Phase 1-2 surfaces
  unchanged.

- **2026-05**: TUI Phase 2B — OpenTUI renderer shipped behind `--tui`
  (explicit only; auto-promote is Phase 3). Single-screen layout:
  Header (run id, status counts, parallel %), TaskList (left), LogPane
  (right, follows selection), ProgressBar (filled-bar + N/M + %),
  StatusBar (keymap hint). Components live in `src/tui/components/`;
  `src/tui/App.tsx` switches view by `state.activeView` (only view 1
  for Phase 2B). `src/tui/tui.ts` is the single import site for
  `@opentui/react` — wraps `createCliRenderer` + `createRoot`, builds
  a `Observer` that dispatches into the Phase 2A reducer, runs a
  paint-debounced render loop (33ms) and a 1 Hz sparkline sampler.
  Renderer-swappable: only `src/tui/tui-shim.ts` imports OpenTUI.
  Renderer falls back silently to framed-block when stdout/stdin
  isn't a TTY, NO_COLOR is set, CI=1, or term < 80×20; explicit
  `--tui` surfaces a `vx: TUI unavailable (<reason>)` line. Tests:
  495 → 497 (added a smoke test + CLI flag parser tests). Manual
  e2e verified `--tui` disqualifier path; live TTY render path is
  exercised by `startTui({ testing: true })` (OpenTUI's headless
  mode).

- **2026-05**: TUI Phase 2A — renderer-agnostic foundation. Pure-
  function modules under `src/tui/`: `should-use-tui.ts`,
  `primitives/{sparkline,timeline-layout}.ts`,
  `state/{store,selectors,critical-path}.ts`. All TDD-driven, no
  JSX, no renderer dependency. Tests: 434 → 495.

- **2026-05**: TUI Phase 1 foundation — orchestrator-side scaffolding,
  no renderer yet. Five focused additions (no behaviour change for
  non-TUI runs, 414 → 434 tests):
  1. New `src/orchestrator/observer.ts` exporting a tagged-union
     `ObserverEvent` (`runStart` | `taskStart` | `taskStdout` |
     `taskStderr` | `cacheProbe` | `taskComplete` | `remoteCache` |
     `runEnd`), an `Observer` interface, and `makeSafeObserver(inner)`
     that swallows throws from `inner.emit` so a buggy TUI never
     crashes the run. Logger stays parallel — it owns terminal
     framed-block output; Observer is the structural sink.
  2. `RunOptions.observer?: Observer` wired through `orchestrator.run()`.
     Emit sites: `runStart` after header writes; `taskStart` from the
     scheduler's `onStart` (now `(node, slot)`); `cacheProbe` from
     `execute-task.ts` after `cache.get(hash)`; `taskComplete` from
     scheduler's `onFinish`; `runEnd` after `formatRunSummary`.
  3. `runGraph` now allocates lowest-free-index worker slots and
     passes `slot: number` to `execute()` + `onStart()`. Stable
     allocation across runs so a future TUI Workers view renders
     `[1]` always-busy / `[N]` idle-gap visibly.
  4. New `Cache.getTaskHistory(taskIds)` — one SQL CTE with
     `ROW_NUMBER() OVER (PARTITION BY project, task)` capped at 50
     rows per pair, returns a `TaskHistoryMap` of runs / avg / p50 /
     p99 / successRate / hitRate / recent[10]. Threaded through
     `prepareRun` so the `runStart` event carries `historyTable`
     populated for every node in the graph (cheap; one batched read).
  5. `LayeredCacheOptions.onRemoteRequest` callback fires for every
     remote GET/PUT with `{ op, hash, bytes?, latencyMs, ok }`. The
     orchestrator wires it to `observer.emit({ kind: 'remoteCache',
... })` in `wrapWithRemoteCache(local, log, observer)`.

  No renderer in this PR — Phase 1's UI components land in the
  follow-up PR. The orchestrator side is renderer-agnostic by design:
  the same Observer feeds future `vx ui` historical browser and
  embedder use cases.

- **2026-05**: Architecture refactor. Three focused changes (no
  behaviour change, all 414 tests still pass):
  1. Extracted `orchestrator/prepare.ts:prepareRun(options, log) ->
PreparedRun`. `run()` and `planRun()` no longer duplicate
     ~50 lines of workspace-discovery → config-load → graph-build →
     cache-open. `PreparedRun.empty` is a small discriminated union
     so the two callers handle empty cases in their own way (run
     logs + returns NOT-ok; planRun returns `{ tasks: [] }`).
  2. Split `executeTask` into three named functions —
     `executeGroupTask`, `executePersistentTask`, `executeCachedTask`
     — behind a tiny dispatcher. Hoisted `buildIsolatedEnv` to a
     private `taskEnv(node, step)` helper since the persistent and
     cached paths constructed it identically.
  3. Shared `tallyOutcomes` between `summary.ts` and
     `run-artifacts.ts` via a new `orchestrator/tally.ts`. Both
     surfaces (terminal summary + `--summarize` JSON) now compute
     the same numbers from one place; group-task exclusion is baked
     into the helper.

  Small follow-ons in the same PR: `isGroupTask(node)` predicate
  added to `graph/task-graph.ts` and applied at six call sites that
  previously inlined `node.config.exec === undefined`;
  `expandRequested` moved from `orchestrator.ts` to
  `graph/task-graph.ts` next to `buildTaskGraph` (they're paired);
  dead `taskId` re-export from `orchestrator.ts` removed;
  `formatBriefDuration` (framed-output.ts) replaced with the
  byte-identical `formatDuration` from `summary.ts`; the `OnDiskMeta`
  shape in `layered-cache.ts` is now `Omit<CacheEntry, 'hash' |
'outputFiles' | 'source'>` so it stays in sync with the cache
  contract automatically; `SaveArgs` marked `@internal`.

- **2026-05**: CACHE_VERSION → v14. File enumeration switched from
  `Bun.Glob` + `ignore`-library filter to `git ls-files --cached
  --others --exclude-standard` (Turbo / Nx parity — both defer to
  git at the bottom of their hash pipelines). User-visible effects:
  (a) nested `.gitignore` patterns are anchored to the gitignore's
  own directory (fixes the v13 footgun where `pkg/.gitignore:
src/skip.ts` was misinterpreted as `<workspaceRoot>/src/skip.ts`);
  (b) `.git/info/exclude` and global excludes participate; (c)
  untracked-but-not-ignored files enter inputs immediately (no
  `git add` required). When git isn't available, we fall back to
  the pre-v14 walker. New: `listGitTrackedFiles(projectDir)` helper
  in `cache/inputs.ts`. 9 new git-path tests in `tests/inputs.test.ts`
  (init a real git repo in the fixture); all 23 pre-existing
  `inputs.test.ts` tests still pass via the fallback path.
- **2026-05**: `vx watch <task>` shipped. New subcommand:
  initial run uses the same orchestrator path as `vx run`; afterwards
  a debounced (150 ms) `fs.watch(projectDir, { recursive: true })`
  per project + non-recursive watch of the workspace root re-invokes
  the orchestrator on changes. Path filter ignores `node_modules` /
  `.git` / `.vx` / `*.tsbuildinfo` / `*~` (editor swap files).
  Reentrancy guard: events while a cycle runs set `pending = true`;
  the loop drains after the current cycle so two events collapse
  into one re-run. Rejected at parse time: `--dry`, `--graph`,
  `--summarize`, `--profile` (don't make sense for a loop). Extracted
  `resolveRunOptions(parsed, cwd, tasks)` from `cli/run.ts` so both
  subcommands share scope resolution. 7 new CLI tests including an
  end-to-end re-run-on-change against a real fixture workspace +
  clean SIGINT exit. Docs: new module page `cli-watch.md`,
  `comparison.md` flipped from gap to shipped, `cli.md` new
  `## vx watch` section.
- **2026-05**: CACHE_VERSION → v13. Unified per-entry on-disk layout:
  outputs moved from `<cacheDir>/<hash>/<rel>` to
  `<cacheDir>/<hash>/outputs/<rel>`; stdout/stderr moved from the
  sibling `<cacheDir>/logs/<hash>.{stdout,stderr}` into
  `<cacheDir>/<hash>/stdout` and `<cacheDir>/<hash>/stderr`. Eviction
  collapses to a single `rm -rf <hash>/`. Also dropped the run-time
  `logs/<run_id>/<project>__<task>.{stdout,stderr}` dump from the
  orchestrator (the `persistTaskLogs` helper + module). Rationale: the
  cache only writes on success and already captures stdout/stderr per
  hash; failures are streamed live and surfaced on the outcome object;
  CI captures the parent stdout natively; structured per-task metadata
  lives in the `runs` table. The duplicate sibling dump was pure
  redundancy. PR pending.
- **2026-05**: Persistent / long-running tasks shipped via
  `exec.persistent.readyWhen`. Schema-extending: `ExecConfig` gains an
  optional `PersistentConfig`. Runner has a new `runPersistent` that
  spawns + watches stdout/stderr for a regex match (line-by-line),
  resolving a `ready` promise on first match or immediately when no
  regex given. The orchestrator owns the subprocess registry and
  SIGTERMs every persistent child once the rest of the graph
  finishes. `cache + persistent` is a config error (no exit, nothing
  to cache). Project-loader rejects malformed `persistent` shapes
  (non-object, non-string `readyWhen`). 8 new e2e tests cover:
  immediate-ready, regex-ready, fail-before-ready, downstream
  blocking, multi-package concurrent persistent, SIGTERM-on-sibling-
  failure, output streaming pre-ready, schema validation. PR pending.
- **2026-05**: Multi-task positional invocation. `vx run build lint
test` runs all three with a shared graph (Turbo parity). Anchored
  positionals (`vx run pkg#deploy lint`) resolve directly; bare
  positionals fan out across the resolved project scope. New
  `expandRequested(tasks, candidates, projects)` helper in
  `src/orchestrator.ts` dedupes `{project, task}` pairs across mixed
  inputs. `RunOptions.task: string` → `RunOptions.tasks: string[]`;
  parser's single-positional rule replaced with array accumulation.
  Header `Running ...` line comma-lists the unique task names. PR
  pending.
- **2026-05**: dependsOn + cache.inputs.tasks switched to Turbo/Nx
  micro-syntax — a flat `string[]` instead of
  `{ self: [...], dependencies: [...] }`. Entries:
  `'name'` (same-project), `'^name'` (workspace deps), `'pkg#name'`
  (cross-project edge). For `cache.inputs.tasks`, two extras for
  filtering: `'*'`/`'^*'` for "every same-project/dep upstream",
  `'!<form>'` for exclusion. Last-write-wins ordering. New
  `src/graph/dependency-spec.ts` is the shared parser. dependsOn
  validation rejects wildcards/negation (they're filter-only). PR #56.
- **2026-05**: Declared output paths are wiped before every cache-hit
  restore AND every cache-miss exec, so the project's output dir ends
  the run bit-identical to the cached snapshot (no stragglers from a
  prior build / hand-edits / removed files survive). New
  `cleanOutputs` helper in `src/cache/inputs.ts` reuses `resolveOutputs`'
  glob-and-boundary logic; `execute-task.ts` calls it in both spots
  when `cache.outputs.files` is non-empty AND caching is enabled
  (`--no-cache` leaves the tree alone — user is debugging and managing
  files themselves). Three new e2e tests pin the behavior; one
  existing test that relied on a stale output surviving across runs
  (`non-zero exit code is NOT cached`) was rewritten to track
  re-execution via a non-output file. PR #50.
- **2026-05**: PATH-prepend each project's `node_modules/.bin` per
  task (vite-task-style). `buildIsolatedEnv` gained an optional
  `binPaths` arg; `executeTask` passes
  `[<projectDir>/node_modules/.bin]`. Only the _project's own_ bin —
  not the workspace root's — so sibling-project bins stay invisible
  per the project-isolation rule. Side effects: deleted
  `tryDelegateToLocal` / `findProjectDeclaringVx` from `bin.ts` (no
  longer needed — PATH is set up by us, not by a PM wrapper),
  dropped `[<agent>]` PM tag from the run banner, removed
  `src/workspace/package-manager.ts`, and dropped the
  `package-manager-detector` dep. Also dropped the orchestrator's
  end-of-run failure replay (stderr is already streamed live;
  reprinting just duplicates noise) — logs are still persisted to
  `<cacheDir>/logs/<run_id>/`. Also dropped all `package.json`
  scripts; CI invokes `bun src/bin.ts run ci` directly. PR #46.
- **2026-05**: CACHE_VERSION → v12. Folded project's `package.json`
  bytes into every task's cache key (Turbo/Nx-style "implicit
  dependencies"). Closes the gap where a narrow `cache.inputs.files`
  like `['src/**']` missed package.json and dep changes went stale.
  One-line addition in `cache.ts:key()` + a `hashProjectPackageJson`
  helper in `orchestrator/execute-task.ts`. New CacheKeyInput field
  `projectPackageJsonHash`. PR #42.
- **2026-05**: **Removed the entire sandbox subsystem.** `src/sandbox.ts`,
  `tests/sandbox.test.ts`, `docs/design/sandbox.md`, `docs/modules/sandbox.md`,
  the `--sandbox` CLI flag, and the bwrap installation step from CI all
  gone. Reasons: Ubuntu 24's default AppArmor profile blocks unprivileged
  user namespaces, breaking bwrap on the most common CI target; the
  sandbox contract requires the user to declare every input file exactly
  right or builds break confusingly; and Turborepo / Nx ship without
  sandboxing and that's fine — under-declared inputs producing stale
  hits is the accepted task-runner tradeoff. RunOptions.sandbox dropped;
  the `executeTask` body simplifies to a single `runCommand` call.
- **2026-05**: **Removed the entire dashboard subsystem.** Server
  (`src/dashboard.ts`), UI app (`apps/dashboard/`), `vx dashboard`
  subcommand, design doc, and module doc all deleted. Project
  flattened back to a single-package layout (no more `packages/run/`
  or `apps/`). What stays: `runs` table + ULID + hrtime spans +
  cpu_ms / peak_rss / wallclock columns in cache.db, populated on
  every `vx run`. CI consumes them either via `vx stats` or by
  reading `cache.db` directly with `sqlite3`. Net: −9 of 10
  dashboard PRs' worth of code; dep tree down from 304 packages to 19. Original framing of "dashboard as a window onto the cache"
  was real scope creep — the cache file IS the API.
- **2026-05**: Dashboard PR 10/10 — Run detail page + flamegraph.
  `/runs/:id` hits the existing `/api/runs/:id` endpoint and renders
  per-task spans against the wallclock timeline. Flamegraph is a
  pure CSS/absolute-position layout (no canvas, no SVG library):
  one lane per project, bars positioned by `wallclockStartNs` (ns
  precision when available, ms fallback for legacy rows), colored
  by `status`/`cacheHit`. Layout math lives in a pure
  `src/flamegraph.ts` with unit tests; rendering in
  `components/Flamegraph.tsx`. Summary cards, a task table with
  CPU/peak-RSS columns, and a status-badge component round out the
  page. Last dashboard PR. Bundle: 53 KB raw / 18 KB gzipped JS,
  7 KB CSS. PR #29.
- **2026-05**: Dashboard PR 9/10 — `vx dashboard` now serves
  `apps/dashboard/dist/` (the built Solid bundle from PR #27)
  instead of the inlined `packages/run/src/dashboard-ui/` static
  files. Legacy `dashboard-ui/` deleted. `DashboardServerOptions`
  gained a required `uiDir` field; the CLI computes it from
  `$VZN_DASHBOARD_DIST` (override) or the repo-relative
  `apps/dashboard/dist/` path, surfacing a `DashboardUiMissingError`
  with a `bun --cwd apps/dashboard run build` fixit if the bundle
  isn't there yet. CI gained a "Build dashboard UI" step before
  tests; tests' `beforeAll` builds lazily so local cold runs still
  work. Static-serving tests rewritten around the Vite layout
  (`index.html` + `assets/<hashed>.{js,css}`) plus a path-traversal
  guard test. Run-detail + flamegraph is the last dashboard PR (#29).
  PR #28.
- **2026-05**: Wired `defineWorkspace({...})` loading. Was a dead
  export — schema docs even flagged it as deferred. Now
  `vx.workspace.{ts,mts,js,mjs}` at the workspace root is jiti-loaded
  by both `vx run` and `vx dashboard`. `concurrency` provides the
  default when `-c` isn't passed; `cacheDir` (relative to workspace
  root) lets users park `.vx/cache` somewhere else (e.g.
  `build/.vx-cache` to keep all derived files in one tree).
  `resolveCacheDir(root, config)` is the single source of truth so
  the runner and the dashboard never disagree on which DB to open.
- **2026-05**: Dashboard PR 8/10 — ported the four legacy pages
  (Overview, Cache, Tasks, Runs) to Solid components inside
  `apps/dashboard/`. Routing via `@solidjs/router`'s `<HashRouter>`
  so URLs stay shaped like the legacy app (`#/overview`, `#/runs`,
  `#/runs/:id`) and so the bundle works as a flat static asset
  without needing SPA-fallback config on whatever serves it. Each
  page does `createResource(() => fetchJson<T>(url))` and wraps the
  output in a small `<AsyncView>` for loading/error/data states.
  Shared chrome (header + nav + footer) lives in a `Shell` root
  component; pages render into it via the router's outlet
  (`props.children`). UnoCSS classes lean on the semantic color
  tokens from PR #26 (`bg-bg-elevated`, `text-fg-muted`,
  `border-border-muted`, …). Added `src/api.ts` (response types +
  `fetchJson<T>`) and extended `src/format.ts` with `formatAge`,
  `formatPercent`, `shortHash`, `shortRunId`. Run-detail page +
  flamegraph land in PR #29; legacy `dashboard-ui/` removal +
  server-side static-serving rewrite is PR #28. Production bundle:
  ~46 KB raw / 16 KB gzipped JS, 5 KB CSS. PR #27.
- **2026-05**: Dashboard PR 7/10 — `apps/dashboard/` scaffold. Vite 6 +
  vite-plugin-solid + UnoCSS (presetUno + presetIcons +
  transformerVariantGroup) with a dark-by-default theme and
  system-font stack (presetWebFonts deliberately omitted — would fetch
  from fonts.bunny.net at build time, breaking hermetic CI). Vite dev
  server runs on port 5280 and proxies `/api/*` to `127.0.0.1:4280`
  (the legacy `vx dashboard` server) so the Solid app can develop
  against real data. `src/main.tsx` mounts a placeholder `<App />`;
  pages port in PR #27. Brought along `src/format.ts` (bytes,
  duration, relative-time formatters) + tests so the `apps/*/src/` CI
  glob has something to assert on. PR #26.
- **2026-05**: Re-monorepo'd the project. Root `package.json` is a
  Bun-workspaces manifest (`"workspaces": ["packages/*", "apps/*"]`);
  current `src/` moved into `packages/run/src/`. Set up to host
  `apps/dashboard/` (Vite + Solid + UnoCSS) alongside `packages/run/`
  per user direction — the dashboard server + UI is being pulled
  out of `@vzn/vx` so it can be a proper component-based app with
  a build step. Convention: `packages/*` is published libs,
  `apps/*` is end-user applications. PR #25.
- **2026-05**: Dashboard PR 6/10 — Tasks + Runs UI pages. Tasks
  ranks `(project, task)` pairs by average wall-clock duration
  (cache-hits excluded so the ranking reflects work actually
  done). Runs is a reverse-chronological list of `vx run`
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
- **2026-05**: Dashboard PR 4/10 — `vx dashboard` subcommand +
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
  them later. `CACHE_VERSION` → `vx-cache-v11`. First PR of the
  dashboard 10-PR sequence (`docs/design/dashboard.md`). PR #19.
- **2026-05**: `CacheLayer` interface extracted in `src/cache.ts`. Both
  `Cache` and `LayeredCache` `implements CacheLayer`. Orchestrator's
  `cache` field types as `CacheLayer` (was the brittle `Cache |
LayeredCache` union). `SaveArgs` exported as `Parameters<CacheLayer['save']>[0]`
  so callers don't redeclare the shape. PR #18.
- **2026-05**: P1 bug bundle from Agent A's real-world test. Adds
  `PRAGMA busy_timeout = 5000` (concurrent `vx run` no longer crashes
  with SQLITE_BUSY), scopes `forwardArgs` to user-requested task nodes
  (no longer leaks into `dependsOn`-pulled deps; no longer pollutes
  their cache keys), returns `ok: false` when no project declares the
  requested task (CI scripts surface typos), adds runtime validation
  of `TaskConfig` shape in `project-loader.ts`, introduces a
  `UserError` class so user-input failures print a clean message
  instead of a full stack. Also renames the stale `nxt:` log prefix
  to `vx:`. PR #17.
- **2026-05**: Sandbox shipped (v1). `src/sandbox.ts` with bwrap on
  Linux + sandbox-exec on macOS. `vx run --sandbox` opts in. Declared
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
  Wired into orchestrator via env vars: `VX_REMOTE_CACHE_URL` +
  `VX_REMOTE_CACHE_TOKEN` (plus optional `_TEAM_ID`, `_SLUG`,
  `_TIMEOUT_MS`). Compatible with `ducktors/turborepo-remote-cache`,
  `Fox32/openturbo-remote-cache`, Vercel hosted cache.
- **2026-05**: `vx cache prune` CLI command. Supports `--older-than
<duration>` (TTL eviction) and `--max-size <bytes>` (LRU eviction
  until under cap). Both can combine. Uses `entries.accessed_at` and
  `entries.size_bytes` from the v10 schema. PR #9.
- **2026-05**: `vx stats` CLI command — surfaces v10 cache stats
  (entry count, total size, runs/hits last 24h). PR #8.
- **2026-05**: Local cache v10 — SQLite metadata index (`cache.db`),
  on-disk outputs at `<hash>/`, separate `logs/<hash>.{stdout,stderr}`
  log files. Adds `runs` table for run history (drives future `vx stats`).
  CACHE_VERSION → `vx-cache-v10`. Per-entry `meta.json` is gone. PR #7.
- **2026-05**: Project memory + agents — `CLAUDE.md` + architect /
  developer subagents under `.claude/agents/`. PR #6.
- **2026-05**: Bun runtime + oxc toolchain (oxlint + oxfmt + tsgolint).
  Dropped Node, pnpm, tsc, prettier, vitest. PR #5.
- **2026-05**: Remote cache wire = Turbo `/v8/artifacts/` spec verbatim,
  but tar interior is ours (`meta.json` + `outputs/`, no Turbo log-file
  mimicry). Design at `docs/design/remote-cache.md`. **Not yet implemented.**
- **2026-05**: Schema reshape — `defineProject({ tasks: {...} } })`.
  `exec` is a single ExecConfig, not an array. CACHE_VERSION → `v9`.
  PR #3.
- **2026-05**: CLI aligned with vite-task — default scope is cwd
  project, `-r` for all, `-F` for filter DSL, `--` separator, `pkg#task`
  addressing, `--no-cache` (was `--force`), `-v` for verbose. PR #2.

## Active workstreams (prioritized)

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
4. **Flaky detection → surface + optional auto-retry.**
   `getFlakiestTasks` (a query) + the new `attempts` primitive exist;
   wire them: surface flaky tasks in the dashboard, suggest/auto-apply
   `retries` on flagged tasks.
5. ~~Duration-aware dispatch ordering~~ — **SHIPPED** 2026-07-04
   (LPT; serve-computed `durationHints` from ingest history).
6. **Run-level policy to REMOTE agents** (narrow; deferred). Corrected
   framing after investigation: the CACHE policy is already handled — the
   §5.3 refusal gate falls a run back to LOCAL when it lacks
   `remoteRead && remoteWrite` (`--no-cache`/`--force`/`--cache=remote:`),
   so any run that distributes already has full remote axes, and remote
   agents running "full cache" is correct BY DESIGN (the cache IS the
   artifact transport). The real residual is that a REMOTE `vx-cloud agent`
   live-evals (ignores `--frozen`) and doesn't inherit `--timeout`/`--retry`
   — narrow value under the standard pinned-image + `--frozen` recipe
   (env-pure configs make live-eval == frozen), and it needs a
   DIST_PROTOCOL bump to carry per-submission policy in `task:assign`
   (per-assignment, since one agent multiplexes submissions with different
   policies). Deferred: not worth a wire-protocol bump for the narrow gain
   until a real need surfaces.
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

## Recently shipped

- **2026-05**: `vx watch <task>` subcommand. Initial run via the
  shared orchestrator path, then debounced (150 ms) recursive
  `fs.watch` per project + non-recursive root watch for lockfile
  edits. Path filter ignores `node_modules` / `.git` / `.vx` /
  `*.tsbuildinfo` / `*~`. Reentrancy guard collapses bursty events
  into a single re-run. Rejects `--dry` / `--graph` / `--summarize`
  / `--profile` (no sense for a loop). 7 new tests including
  end-to-end re-run on FS change + clean SIGINT.

- **2026-05**: `--dry-run` (`--dry`) and `--graph` for `vx run`. Both
  short-circuit execution: build the graph, compute every task's
  cache key, probe the cache, emit a human/JSON/DOT view of the
  predicted plan. `computeTaskHash` extracted from `executeTask` for
  reuse. New `orchestrator/plan.ts` + `orchestrator/plan-format.ts`.
  12 new tests; 303 total passing.

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
