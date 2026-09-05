# Architecture Overhaul — June 2026 Implementation Plan

> **Historical.** Written as a task-by-task plan for agentic workers;
> everything below shipped or was superseded. Steps use checkbox (`- [ ]`)
> syntax for tracking. Phases 2/4/6 are decision-gated: their detailed
> task lists are written when their inputs exist (bug-hunt findings,
> module audit). Do not invent placeholder work for them.

**Goal:** Take vx to a next-level architecture — every confirmed bug
fixed, every concern isolated behind a module interface, every flow
documented with diagrams, every optimization cataloged — while keeping
all features and the full test suite green at every merge.

**Architecture:** Adopt PR #108's modules-first principles **in place**
on `main` instead of merging the reset: each concern (workspace,
config, graph, cache, exec, orchestrator, cli) lives behind its own
`index.ts` contract; the orchestrator/CLI are the only composition
points; no cross-module deep imports. The full-featured codebase
(520+ tests) is the substrate — we restructure it, we don't rebuild it.

**Tech Stack:** Bun ≥ 1.3, bun:test, oxlint (type-aware), oxfmt.
No build step; TS source ships.

---

## Context (read first)

- **PR #108** (`claude/modular-rebuild-tdd-Hldt4`) proposed a hard
  reset: wipe the tree, rebuild module-by-module with TDD. At its tip
  it has workspace/project/graph only (28 files, 93 tests) — no runner,
  cache, scheduler, watch, remote cache, or persistent tasks. Merging
  it would regress the product by months. Its _principles_ are right;
  this plan adopts them on `main` without the regression. #108 closes
  with rationale once Phase 4 lands (Phase 6).
- **PR #97** (runner comparison doc) — merged 2026-06-10. Its gap
  table seeds the bug hunt: no SIGINT/SIGTERM handling in `run()`,
  no artifact integrity verification, no FS retries.
- **Known failing test:** `tests/sandbox-runtime.test.ts` —
  "allowWrite grants a specific extra write path" fails on macOS
  (`allowWrite: ['/tmp']` does not grant writes; suspected
  `/tmp → /private/tmp` symlink canonicalization in policy paths).

## Phases

### Phase 1 — Baseline + sandbox fix (PR a)

- [x] `bun test` baseline: 518 pass / 1 fail (sandbox allowWrite).
- [ ] Root-cause the macOS allowWrite failure (systematic-debugging;
      the execution-subsystem reviewer's findings feed this).
- [ ] Failing test already exists — make it pass with the minimal fix
      (likely `realpathSync` canonicalization of user-supplied
      `allowRead`/`allowWrite`/`denyRead` lists where they enter the
      SRT policy in `src/exec/sandbox-runtime.ts`).
- [ ] Full `bun test`, oxlint, oxfmt clean → branch → PR → merge.

### Phase 2 — Bug hunt + fixes (PRs b, c, …) — GATED on findings

Six parallel read-only reviewers (scheduler/graph, local cache,
remote/layered cache, execution, cli/watch/workspace, orchestrator)
produce findings with file:line + severity + confidence + trigger
scenario.

- [ ] Adversarially verify each high/medium finding against the
      actual code + tests before accepting it (a plausible-sounding
      finding is not a bug until a failing test demonstrates it).
- [ ] For each confirmed bug: write the failing test FIRST, then the
      minimal fix. One PR per coherent bundle (e.g. "scheduler
      correctness", "cache integrity").
- [ ] Known-gap candidates to evaluate even if reviewers miss them:
      SIGINT/SIGTERM handling in `run()` (children reaped, persistent
      children killed, cache.db left consistent); corrupt/truncated
      remote artifact ingestion blast radius; tar extract path
      traversal.

### Phase 3 — Docs: flows, graphs, optimization catalog (PR d)

- [ ] `docs/flows.md` (or split per scenario under `docs/flows/`):
      Mermaid sequence/flow diagrams for — cold run (miss → exec →
      save), warm run (local hit → restore skip logic), remote hit
      (download → ingest → restore), failure propagation (failed task →
      transitive dependents aborted, siblings continue), watch loop
      (debounce + reentrancy), persistent task lifecycle (spawn →
      readyWhen → downstream → SIGTERM), sandbox violation → exit 1,
      `vx cache prune` (TTL + LRU), `--dry`/`--graph` plan path.
- [ ] `docs/optimizations.md`: catalog every shipped optimization
      (xxh3 keys, O(N+E) scheduler, O(P log P) nested-dirs, git
      ls-files enumeration, logger chunk buffering, single-transaction
      prune, memoized Bun.color, Bun.Glob adoption, hand-rolled tar
      vs Bun.Archive benchmark, v17 single-format artifact) — each
      with: what, why, measured effect, where (file), and the
      invariant that must hold to keep it valid.
- [x] Refresh `docs/architecture.md` module map + data-flow diagram.
      (Done with Phase 4 step 7 — eight-module contract map +
      Mermaid dependency diagram + matrix table.)

### Phase 4 — Module isolation restructure (PR series e…) — COMPLETE

Executed as the seven-step series in
[`module-isolation-2026-06.md`](./module-isolation-2026-06.md).

- [x] Architect-agent audit of current `src/` import graph: list every
      cross-module deep import (e.g. orchestrator reaching into
      `cache/inputs.ts` internals), every type that leaks across a
      boundary, every file with mixed concerns.
- [x] Design doc: target module set + public contract per module
      (`index.ts` re-exports only), composition points (cli, orchestrator),
      allowed dependency direction (workspace ← graph ← orchestrator →
      cache/exec; util leaf).
- [x] Execute as mechanical PRs (one module per PR): add `index.ts`
      contract, rewrite importers, enforcement via
      `tests/module-boundaries.test.ts` (import-graph assertion under
      the normal `bun test` gate).
- [x] Zero behaviour change per PR; full suite green per PR.
- [x] Move per-module docs in `docs/modules/` to match.

### Phase 5 — Perf pass (PR f) — after restructure

- [ ] Benchmark cold + warm runs on a synthetic large workspace
      (reuse `docs/benchmarks.md` methodology).
- [ ] Candidates: batched cache-entry lookup for the warm path,
      parallel output restore, single workspace-root `git ls-files`
      reuse audit. Only land measured wins; record in
      `docs/optimizations.md`.

### Phase 6 — PR hygiene

- [x] #97: merged (squash) 2026-06-10.
- [ ] #108: close with comment linking the landed restructure PRs +
      this doc; reopenable if the owner disagrees.

## Invariants for every PR in this plan

1. `bun test` fully green (no skips added).
2. `oxlint --type-aware --type-check` + `oxfmt --check` clean.
3. Cache key derivation untouched unless the PR explicitly bumps
   CACHE_VERSION via the bump-cache-version skill.
4. CLAUDE.md decision log updated when a decision is made.
