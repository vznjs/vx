# Monorepo structure — design

> **Status:** proposal (2026-05-16)

## What we're solving

`@vzn/vx` ships today as a flat single-package project. `src/` has
seven subdirectories that already behave like modules (`cache/`,
`cli/`, `exec/`, `graph/`, `orchestrator/`, `util/`, `workspace/`).
Per-module docs exist (one markdown per source file), tests sit at the
top-level `tests/`, and there is exactly one Bun-installable package.

Two questions are worth answering before we accumulate more code:

1. Should we promote those subdirectories to real Bun-workspace
   packages (`@vzn/cache`, `@vzn/orchestrator`, `@vzn/cli`, …)?
2. If not, how do we encode the module boundaries that exist
   informally today, so they don't decay as the project grows?

Two pieces of debris on disk also need a decision:
`apps/dashboard/{dist,node_modules}` and `packages/run/node_modules`.
Both are leftovers from a deleted subsystem. They aren't tracked by
git (`git ls-files apps/ packages/` returns nothing), but they sit at
the repo root and confuse newcomers who expect them to mean
something.

## Current state

```
/home/user/run/
├── package.json              # @vzn/vx, no "workspaces", 1 runtime dep ("ignore"), 3 dev deps
├── bun.lock
├── tsconfig.json
├── .oxlintrc.json
├── .oxfmtrc.json
├── src/
│   ├── bin.ts                # shebang
│   ├── cli.ts                # subcommand dispatcher
│   ├── orchestrator.ts       # run() / planRun()
│   ├── config.ts             # public schema
│   ├── index.ts              # public re-exports
│   ├── cache/                # local + remote cache cluster
│   ├── cli/                  # run / watch / cache / help / format
│   ├── exec/                 # Bun.spawn wrappers + env composition
│   ├── graph/                # TaskNode DAG + scheduler + dep-spec parser
│   ├── orchestrator/         # per-task glue, fingerprint, plan, logger, …
│   ├── util/                 # paths, ulid, errors
│   └── workspace/            # discovery, project-loader, filter, affected
├── tests/                    # 28 test files, flat layout, cross-module imports via ../src/*
├── docs/
│   ├── architecture.md
│   ├── modules/              # one markdown per src file
│   └── design/               # forward-looking proposals (this doc included)
├── apps/dashboard/           # DEBRIS: dist/ + node_modules/ (untracked)
└── packages/run/             # DEBRIS: node_modules/ only (untracked)
```

One install (`bun install`), one test command (`bun test`), one lint
(`oxlint --type-aware --type-check`), one format (`oxfmt`). The bin
entry runs TypeScript directly via Bun's loader — no build step. The
public surface is `src/index.ts`, re-exporting `defineProject`,
`defineWorkspace`, `run`, plus a handful of types.

### Verified invariants today

These were spot-checked while writing this doc — they are the de
facto boundary even without enforcement:

- `src/cache/` imports only from `src/util/paths.ts`,
  `src/config.ts`, and within `src/cache/`. **No import from
  `src/orchestrator/`, `src/cli/`, or `src/graph/`.**
- `src/graph/` imports from `src/util/errors.ts`, `src/config.ts`,
  and a type from `src/workspace/package-graph.ts`. **No import
  from `src/orchestrator/` or `src/cli/`.**
- `src/workspace/` imports from `src/util/errors.ts` and
  `src/config.ts` only. **No import from anything higher up.**
- `src/exec/` and `src/util/` have zero internal imports — they
  are leaf modules.
- `src/orchestrator/` (and `src/orchestrator.ts`) imports from
  `cache/`, `graph/`, `workspace/`, `exec/`, `util/`, `config.ts`.
  That is the intended direction — orchestrator is the assembly
  point.
- `src/cli/` imports from `orchestrator.ts`, `workspace/`,
  `cache/`, and sibling cli files. Also the intended direction.

The dependency order is clean: `util → config → {cache, graph,
workspace, exec} → orchestrator → cli → bin`. No cycles.

### Test coupling

`tests/` is flat and imports across every src subdirectory using
relative paths (`from '../src/cache/cache.js'`,
`from '../src/graph/scheduler.js'`, …). 28 files total. Many — most
notably `tests/orchestrator.test.ts` (82KB) and `tests/cli.test.ts`
(30KB) — are end-to-end harnesses that exercise the full stack
against fixture workspaces.

## History — what we already tried

The decision log in `CLAUDE.md` records two relevant 2026-05 entries:

1. **PR #25 — "Re-monorepo'd the project."** Root `package.json`
   became a Bun-workspaces manifest (`"workspaces": ["packages/*",
   "apps/*"]`); the runner moved into `packages/run/src/`. The stated
   convention was "`packages/*` is published libs, `apps/*` is
   end-user applications." The reason for the move was to host
   `apps/dashboard/` (Vite + Solid + UnoCSS) alongside the runner —
   the dashboard needed a build step (`vite build`) that wouldn't fit
   inside the source-only runner package.

2. **Dashboard removal entry, weeks later.** "Server
   (`src/dashboard.ts`), UI app (`apps/dashboard/`), `vx dashboard`
   subcommand, design doc, and module doc all deleted. **Project
   flattened back to a single-package layout** (no more
   `packages/run/` or `apps/`). … Net: -9 of 10 dashboard PRs' worth
   of code; dep tree down from 304 packages to 19. Original framing
   of 'dashboard as a window onto the cache' was real scope creep —
   the cache file IS the API."

The monorepo existed exclusively to host the dashboard UI build
pipeline alongside the runner. Once the UI was gone, the monorepo had
no reason to exist, and we flattened back. That history matters: the
project literally tried `packages/*` once and walked it back for
cause within the same month.

The `apps/dashboard/dist/` files and the two stray `node_modules/`
dirs survived the rollback because they aren't git-tracked and were
never explicitly cleaned. They are pure debris.

## Options considered

### A. Stay flat (status quo)

Keep one package. `src/` subdirs remain de facto modules. Tests stay
flat. No build step, no workspaces field, no per-package tsconfigs.

- **What it enables:** today's developer loop. One `bun install`,
  one `bun test`, one `oxlint`, one `oxfmt`. New code goes in the
  obvious subdir. Public API is `src/index.ts`. Embedders import
  from `'@vzn/vx'`.
- **What it costs:** module boundaries are conventional, not
  enforced. An over-zealous future PR could plausibly add an
  `import { logger } from '../orchestrator/logger.js'` inside
  `src/cache/`, and nothing would flag it until someone reads the
  diff. (Today nobody has done this — the audit above confirms — but
  the guardrail is social, not mechanical.)
- **Shape match with code today:** Excellent. The code is already
  organised this way; this option is "name what exists and stop."

### B. Split into per-subdir workspace packages

`@vzn/cache`, `@vzn/graph`, `@vzn/workspace`, `@vzn/exec`,
`@vzn/util`, `@vzn/orchestrator`, `@vzn/cli` (or some grouping). Root
becomes a Bun-workspaces manifest again. Per-package tsconfigs.
Per-package tests (or keep flat — see below).

- **What it enables:** independent versioning per package; an
  external consumer can `bun add @vzn/cache` without pulling the
  full runner; per-package CI shards; clear publish boundaries.
- **What it costs:** 7-8 new `package.json` files; a workspaces
  field; cross-package import paths flip from
  `'../graph/task-graph.js'` to `'@vzn/graph'`, which means every
  internal import in every `src/*` file gets touched in the migration
  PR. Per-package tests means either splitting `tests/orchestrator.test.ts`
  (which exercises every layer) into per-package fragments — losing
  the end-to-end coverage — or keeping it at the root and accepting
  that one of the packages is "the integration test owner." Bun's
  workspaces handle the symlinking well, but linting/formatting/test
  invocation now has to traverse packages, multiplying the wall-clock
  cost on every PR. Versioning independence implies a release
  process that doesn't exist today (pre-alpha, version stuck at
  `0.0.0`).
- **Shape match with code today:** Mostly good — the import graph is
  already DAG-clean (see verified invariants). But: `src/graph/task-graph.ts`
  imports a type from `src/workspace/package-graph.ts`, which means
  `@vzn/graph` would need to declare `@vzn/workspace` as a dependency
  (or invert the dependency by moving `PackageGraph` somewhere
  shared). Similarly, `src/orchestrator/execute-task.ts` imports from
  `cache/`, `graph/`, `exec/`, and `workspace/` — so `@vzn/orchestrator`
  declares all four as dependencies. The graph is acyclic but the
  number of cross-package declarations is non-trivial.

### C. Two-package split — library + CLI

`@vzn/run` (the library: orchestrator + cache + graph + workspace +
exec + util + config) and `@vzn/cli` (the CLI consumer + the `vx` bin).
Mirrors Turbo (`turbo` + `@turbo/gen`), Nx (`nx` + `@nx/devkit`),
Vite (`vite` + `create-vite`).

- **What it enables:** publishes the engine as a reusable library
  without the CLI surface. An embedder writing a custom build tool
  gets a clean library import without the argv parser. The CLI
  becomes a thin shell over the lib, which makes the contract
  visible.
- **What it costs:** two package.jsons, two tsconfigs, one workspaces
  field. Less migration than Option B (fewer boundary lines to draw,
  fewer cross-package imports). The flat `tests/` layout largely
  survives because the lib's surface is what's tested today via
  `tests/orchestrator.test.ts` and `tests/cli.test.ts` already split
  along the same line. But: the `vx` bin currently runs from
  `src/bin.ts` shipping uncompiled TS — splitting means deciding
  whether `@vzn/cli` ships TS or built JS, and whether the lib does.
  Currently it's "TS ships, period." Splitting doesn't force a build
  step (`@vzn/cli` can depend on `@vzn/run` symlinked through
  workspaces and consume `.ts` directly), but it does introduce a
  publish-time question we don't have today.
- **Shape match with code today:** Very good. `src/orchestrator.ts` +
  `src/index.ts` are already the library entry; `src/cli.ts` +
  `src/bin.ts` + `src/cli/*` are already the CLI entry. The seam
  exists — we'd just be making it formal.

### D. Internal-only modularity (no packages)

Stay flat (Option A) but encode the inter-module boundaries as a
mechanical rule. Concretely: an oxlint `no-restricted-imports`
configuration declaring the allowed import edges per directory. The
rule is the contract; it fires in CI; it costs zero install time and
zero migration.

- **What it enables:** the audited invariants above become enforced.
  A future PR adding `import { logger } from '../orchestrator/...' `
  inside `src/cache/` fails lint. Module replaceability (which the
  architecture doc already advertises) is no longer a gentleman's
  agreement.
- **What it costs:** one config block in `.oxlintrc.json`. Possibly
  one CI red on the first PR that someone runs against existing code
  that the rule already covers — but the audit shows the code is
  already clean, so the rule should land green.
- **Shape match with code today:** Perfect. Nothing moves. Lint
  catches new violations; existing code stays put.

### Hybrid: Option A + D + clean up debris

This is what the recommendation actually is. Option D on its own
covers boundary enforcement; cleaning up `apps/` and `packages/` is
orthogonal but worth doing in the same pass to remove the structural
confusion.

## The case for splitting (steelmanned)

- **Embedder use case.** A team wanting to wire `@vzn/cache` into a
  custom build orchestrator or dashboard gets a focused dependency,
  not the full runner. The cache is the most reusable subsystem (a
  content-addressed cache with a SQLite index and a Turbo-protocol
  remote layer is genuinely standalone-shaped). Likewise
  `@vzn/graph` (a topological scheduler with the Turbo/Nx
  micro-syntax parser) is independently useful.
- **Test isolation.** A change inside `src/cache/` only needs to
  re-run `cache.test.ts` + `layered-cache.test.ts` + `cache-archive.test.ts`
  + `inputs.test.ts`. Today every PR runs all 28 test files. With
  workspace packages, Bun could shard by package.
- **Versioning independence.** A `CACHE_VERSION` bump (we've done 14
  of these) is a cache-format break; today it forces a `@vzn/vx`
  version bump too. With a split, `@vzn/cache` bumps independently
  and the CLI version reflects user-facing changes only.
- **Discoverability.** A published `@vzn/cache` on npm advertises
  the cache as a reusable component. The architecture doc already
  has a "Replace it to…" table per module — splitting makes
  replacement literally `bun add @vzn/cache@^x` for the fork.

## The case against splitting (steelmanned)

- **We walked this back once already.** Five months ago, in this
  project, this same call was made and reversed. The reason the
  monorepo existed was the dashboard's build step. The dashboard is
  gone. **Nothing about the current scope demands the monorepo
  layout.** Re-introducing it without a concrete forcing function
  ("we need to build X with a different toolchain alongside the
  runner") repeats the mistake.
- **No build step today.** The single biggest reason monorepos pay
  for themselves is build orchestration: lib A produces `dist/`, lib
  B consumes it. We ship TypeScript source. Every consumer (including
  the bin) resolves source. There is no `dist/`. Most of the
  apparatus of monorepo tooling (build cache, output sync,
  per-package tsconfig output paths) solves problems we don't have.
- **Pre-alpha, zero embedders.** The version is `0.0.0`. The package
  isn't published. There are no users importing `@vzn/cache`
  separately because there is no `@vzn/cache`. Designing the split
  before the demand exists is speculative — we'd be guessing where
  the boundary should land, and the previous attempt's boundary
  (runner vs. dashboard) is no longer the right one (the dashboard
  is dead).
- **The convention already exists.** Per-file docs under
  `docs/modules/` (47+ files) already function as a public module
  catalog. The architecture doc has a "Replace it to…" table per
  module. Discoverability is already at 80% of the published-package
  story.
- **Splitting multiplies the developer loop.** Today: one install,
  one test, one lint, one format, one tsconfig. After a 7-package
  split: 7 package.jsons to keep in sync, N tsconfigs, cross-package
  imports that have to be remapped on every refactor, a workspaces
  field that means Bun walks more on install, per-package CI matrix
  jobs to add. The user has been explicit that build speed and
  developer-loop friction matter (CLAUDE.md: "trust internal code,"
  "fail loud," "explicit over magical" — all of which lean toward
  fewer moving parts, not more).
- **Tests cross every boundary.** `tests/orchestrator.test.ts` (82
  KB) is an end-to-end harness that imports from `cache/`, `graph/`,
  `workspace/`, `exec/`, `orchestrator/`. To split it along package
  lines we'd either (a) keep it at the root and pick one package to
  "own" the integration tests, defeating the isolation argument; or
  (b) split it, losing the cross-stack coverage. Neither is good.
- **The history is recent.** This isn't a five-year-old decision
  that the project has outgrown. It is five months old. The
  conditions that made the monorepo wrong haven't changed.

## Concrete invariants worth preserving regardless of decision

The module boundaries are real today. They should stay real, whether
or not we promote them to packages:

| Module                | May import from                                              | MUST NOT import from              |
| --------------------- | ------------------------------------------------------------ | --------------------------------- |
| `src/util/`           | (none — leaf module)                                         | everything else                   |
| `src/config.ts`       | (none — schema only)                                         | everything else                   |
| `src/cache/`          | `util/`, `config.ts`                                         | `orchestrator/`, `cli/`, `graph/` |
| `src/graph/`          | `util/`, `config.ts`, `workspace/` (types only)              | `orchestrator/`, `cli/`, `cache/` |
| `src/workspace/`      | `util/`, `config.ts`                                         | `orchestrator/`, `cli/`, `cache/`, `graph/` (except types via `workspace/package-graph.ts` reverse) |
| `src/exec/`           | (none — leaf module aside from `config.ts` types)            | everything else                   |
| `src/orchestrator/`   | all of the above + `orchestrator.ts`                         | `cli/`, `bin.ts`                  |
| `src/cli/`            | all of the above                                             | `bin.ts`                          |
| `src/bin.ts`          | `cli.ts` only                                                | direct imports of anything else   |

One mild quirk worth noting: `src/graph/task-graph.ts` imports a
**type** from `src/workspace/package-graph.ts`. That's a structural
coupling that survives because types are erased at runtime — but if
we ever split into real packages along these lines, we'd want to
move `PackageGraph` to a shared types module (probably
`src/graph/package-graph-types.ts` or into `src/config.ts`) so the
package graph isn't artificially "above" graph in the layering.

## Recommendation

**Stay flat (Option A) + enforce boundaries via lint (Option D) +
delete the debris.**

Concretely:

1. Do not introduce a `packages/*` or `apps/*` layout. The previous
   attempt was reverted for a reason that still applies (no build
   step, no external consumers, no toolchain heterogeneity inside
   the repo).
2. Encode the table in §6 as an oxlint `no-restricted-imports`
   configuration so the convention is mechanical, not social.
3. Delete `apps/` and `packages/`. They are untracked debris from
   the deleted dashboard subsystem. Their presence misleads anyone
   reading the repo for the first time.
4. Update `CLAUDE.md`'s "Repository layout" section to say
   explicitly: *"`src/` subdirectories are de-facto modules. The
   project is intentionally single-package; the previous
   `packages/*`/`apps/*` layout (PR #25, deleted with the dashboard)
   should not be reintroduced without a concrete forcing function."*

If a real split becomes warranted later — say, an external embedder
asks for `@vzn/cache` standalone, or we decide to publish the cache
as a reusable npm component — the right shape at that point is
**Option C (lib + cli)**, not Option B. Option C requires the
smallest carve and matches the precedent set by Turbo, Nx, and Vite.
Option B's seven-package split is overkill for a project of this
size and would create more friction than it removes.

## What's out of scope

- **Building the lint rule.** This doc proposes it; implementation
  is a follow-up task (an oxlint config snippet plus the obvious CI
  job, both small).
- **Publishing `@vzn/vx`.** The package is still pre-alpha, version
  `0.0.0`. The npm publish workflow is a separate decision.
- **Re-doing the dashboard.** The dashboard removal is settled
  (decision log, 2026-05). If we ever rebuild it, we'd reopen the
  monorepo question then, with concrete requirements in hand.
- **Renaming the package** (`@vzn/vx` vs. `@vx/vx` vs. anything
  else). Out of scope here.

## Open questions

- Is there an external embedder asking for any subset of the engine
  as a standalone import today? (Best guess: no — confirm before
  acting.) If yes, that flips toward Option C.
- Do we want per-module test files (`tests/cache/*.test.ts`,
  `tests/graph/*.test.ts`) as a low-cost organizational change, even
  while staying single-package? Could be done incrementally without
  splitting packages. Out of scope here; cheap to do later.
- Should `PackageGraph` be moved out of `src/workspace/` to remove
  the type-only upward import from `src/graph/task-graph.ts`? Low
  priority either way; only matters if Option B/C is ever revisited.

## Why this is the right move

- **We already tried the monorepo, and the only reason it existed
  is gone.** PR #25's stated rationale was the dashboard's build
  step. The dashboard was deleted weeks later and the project
  flattened back. Nothing about the current scope re-introduces
  that forcing function.
- **The audit shows the code is already clean.** Every boundary in
  the recommended invariant table is already respected by the
  source. We are formalising a fact, not negotiating a contract.
- **Lint enforcement is cheap and reversible.** Adding
  `no-restricted-imports` to `.oxlintrc.json` is one config block.
  If it turns out wrong, deleting it is one config block. Compare
  to "split into seven packages and migrate every import."
- **Pre-alpha with zero embedders is the wrong time to design a
  publish boundary.** When demand is concrete, the right boundary
  will be obvious. Designing it now is guessing.
- **Cleaning the debris is unambiguously good.** The `apps/` and
  `packages/` dirs exist solely because we never ran `rm -rf` after
  the dashboard removal. They cost zero to delete and remove a
  consistent confusion for new readers.

## Action items if the recommendation is adopted

In order:

1. `rm -rf /home/user/run/apps /home/user/run/packages`. Both
   contain only `node_modules/` and a built `dist/` from the
   deleted dashboard subsystem; neither is tracked by git.
2. Add an oxlint `no-restricted-imports` configuration to
   `.oxlintrc.json` reflecting the table in §6. Test that
   `bun src/bin.ts run lint` passes against the current codebase
   (the audit says it will).
3. Update `CLAUDE.md`'s "Repository layout" section: add one
   paragraph stating `src/` subdirs are the project's module
   layout; the previous `packages/*`/`apps/*` layout should not
   be reintroduced without a concrete forcing function; refer to
   this design doc.
4. Optional follow-up (separate PR): reorganise `tests/` into
   per-module subdirs (`tests/cache/`, `tests/graph/`, …) for
   discoverability. No package split, no behavioural change.
