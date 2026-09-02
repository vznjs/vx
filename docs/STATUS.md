# STATUS — the living handoff

**Read this first.** It is the one file a fresh session needs to pick the
project up: the direction, what shipped, what is in flight, what is next.
Update it in the SAME commit as the work it describes. Newest state wins;
delete stale lines rather than appending corrections.

## Direction (owner, 2026-09-02)

> "VX should be the Vite of task orchestration. Perf first, then
> modularity. Slim core; add features with plugins or replace
> functionality. Remove DTE / VX Cloud / agents — vx ships none of it, but
> gives people a way to implement it on top. Consider everything before
> this date legacy."

Concretely:

1. **Performance is the first decision driver.** Every change to the run
   path is measured (`bench/`), and a slower core is a regression even if
   it is prettier. Targets: the fastest warm no-op run and the lowest
   scheduler/hash overhead of any JS-monorepo task runner.
2. **Core is a pipeline with seams, not a product.** Core owns:
   discovery, config evaluation, the task graph, cache keys, scheduling,
   and the seams. Plugins own: WHERE a task runs (`executor`), WHERE
   artifacts live (`cache`), WHO observes (`telemetry`/reporters), and —
   as the seams widen — how the graph is shaped and prioritised and which
   CLI verbs exist.
3. **No distribution in the repo.** No agents, synchronizers, controllers,
   cloud, dashboards. The executor seam is the extension point for all of
   it; `@vzn/vx-reapi` (Bazel Remote Execution API) stays as the proof
   that the seam is wide enough.
4. **Native first.** Bun APIs over dependencies. A dependency needs a
   reason written down next to it.
5. **Adoption ready.** Docs, site, and design describe the product that
   exists — verified against the code, not remembered.

Process: push directly to `main`, no PRs. Gate before every push:
`bun packages/vx/src/bin.ts run ci --all`. Small, focused commits.

## Shipped in this arc

- 2026-09-02 — this handoff; compact `CLAUDE.md` (the 13k-line decision
  log left the project memory; history stays in git).
- 2026-09-02 — removed `@vzn/vx-agents`, predictive scheduling
  (`predict.ts`, `predictive:` workspace flag), `vx mcp` + `mcp-rpc.ts`,
  and the mcp-only run-history queries (`getHistory`, `listProjects`,
  `getCacheStatsSql`). `metrics.ts` stays as the `vx why` / `vx last`
  query home. Deleted the decision-log archive, `docs/design/archive/`,
  `docs/progress/`, and the design docs of removed products (dashboard,
  TUI, cloud execution service, trust scopes, lookahead/predictive
  scheduling). `bench/` paths fixed for the `packages/vx` layout.

## In flight

- Nothing. Next up is the bench + profile baseline.

## Next (ordered)

1. **Bench + profile baseline** — `bench/run.ts` at 100 and 1000
   projects; a stage-timing profile of the warm path (startup, config
   eval, git enumeration, hashing, SQLite, scheduling). Record in
   `docs/benchmarks.md`.
2. **Perf wave** — driven by the profile. Candidates already known:
   config-evaluation cache keyed on the static import closure
   (`config-imports.ts` already computes it); fewer SQLite round trips on
   the warm path; run-history recording cost; startup module graph.
3. **Plugin pipeline v2** — Vite-shaped hooks on ONE `VxPlugin` type:
   `config` / `configResolved` / `graph` (shape + order) / `hash` (extra
   key parts) / `executor` / `cache` / `schedule` (priorities — the
   replacement for the removed predictive mode) / `reporter` (events +
   summary) / `commands` (CLI verbs). Existing plugins migrate; the
   deprecated `eventSink` goes.
4. **Move verbs out of core** behind `commands`: `migrate`, `prune`,
   `upgrade`, and an MCP server package.
5. **Docs + site rewrite** around the pipeline model. Delete design docs
   for removed products.

## Decisions (this arc)

- **Agents removed.** `@vzn/vx-agents` (synchronizer + persistent
  workers, Nomad/K8s backends) was an in-repo distributed-execution
  product. It used only public core APIs (`run`, `createEventBus`, the
  executor seam), which is the proof the seam suffices — so it lives
  outside this repo, if anywhere.
- **Predictive scheduling removed.** Opt-in, measured at ~280 ms of
  history loading on a large cache (more than a warm run), and a
  scheduler-priority policy is exactly what a plugin hook should decide.
  The scheduler keeps its `priorities` input; a `schedule` seam will feed
  it.
- **`vx mcp` removed; `metrics.ts` trimmed.** The MCP server read the
  dashboard-era analytics queries and predictive history. An MCP server
  is a good plugin (`commands` seam), not core. The queries `vx why` /
  `vx last` need stay in `metrics.ts`; the rest went.
- **`vx why` / `vx last` stay.** Cache-miss explainability is a core
  promise; both read the local run history core already writes.

## Legacy map (what the old memory called things)

- `docs/design/decision-log-archive.md` held the full 2026-05→08 log; it
  is deleted from the tree (git history: `git log -- docs/design/decision-log-archive.md`).
- "waves" = the old audit cycles. Their standing rules survive in
  `CLAUDE.md` § Rules.
