# Module isolation — design

> **Status:** complete (June 2026) — all seven steps landed; the
> boundary law runs in CI with every directory module contracted.
> **Feeds:** Phase 4 of `architecture-overhaul-2026-06.md`
> **Principle source:** PR #108 (modules-first), adopted in place — no rebuild.

## What we're solving

`src/` already has directory-shaped concerns (`workspace/`, `graph/`,
`cache/`, `exec/`, `orchestrator/`, `cli/`, `util/`), but nothing
enforces them: 30+ cross-directory imports target internal files
directly, two import cycles exist (one through `index.ts`, one inside
orchestrator), three orchestrator files are actually workspace
concerns, and one file (`execute-task.ts`) mixes execution glue with
cache-key derivation that two other files reach in for. This doc is
(1) the audit, (2) the target module contracts, (3) the mechanical PR
series.

## 1. Audit findings (2026-06-10, tip of main)

### Cycles

1. **`index.ts` ↔ `orchestrator.ts`** (and `cli.ts → index.ts`):
   `orchestrator.ts` / `cli.ts` import `VERSION` from `./index.js`
   while `index.ts` imports `run` from `./orchestrator.js`. Works only
   because `VERSION` is a hoisted const under ESM live bindings.
   Fix: extract `src/version.ts`.
2. **`orchestrator.ts` ↔ `orchestrator/prepare.ts`** (file-level,
   type-only): `prepare.ts` imports `RunOptions` upward from the
   module entry. Fix: move `RunOptions`/`RunSummary` to
   `orchestrator/options.ts`; entry re-exports.

No other cycles at file or directory level.

### Deep imports past would-be boundaries

- `cli/run.ts → orchestrator/plan-format.ts` — plan rendering is CLI
  presentation living in the wrong module; move to `cli/`.
- `cli/cache.ts → cache/cache.ts` — legitimate composition, must flow
  through the cache contract once it exists.
- `plan.ts`/`prepare.ts → execute-task.ts` for the hashing surface
  only — evidence `execute-task.ts` hosts two concerns; split
  `task-hash.ts`.
- All other cross-directory edges are directionally fine and need
  only re-pointing at module index files.

### Type homes

| Type                                    | Verdict                                                                                                                                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TaskNode`, `TaskOutcome`, `TaskStatus` | Stay in `graph` — they are the graph/scheduler's product. The cache-flavored statuses are opaque to the scheduler (documented; a generic `TaskOutcome<S>` is ceremony for one consumer).             |
| `ProjectEntry`                          | Move to `workspace` — it's "discovered project + loaded config", the joint output of discovery + loading. Today's home in graph forces `nested-dirs` (pure workspace geometry) to import from graph. |
| `CacheLayer` + friends                  | Stay in `cache/cache.ts`, exported via `cache/index.ts`.                                                                                                                                             |
| `RunOptions`/`RunSummary`               | Move declarations to `orchestrator/options.ts` (kills cycle 2).                                                                                                                                      |
| `VERSION`                               | Move to `src/version.ts` (kills cycle 1); `index.ts` re-export keeps the public name.                                                                                                                |

### Mixed-concern files

- `orchestrator/execute-task.ts` → split the hashing surface
  (`computeTaskHash`, `computeGroupHash`, `hashTaskConfig`,
  `hashProjectPackageJson`, `createHashCache`) into
  `orchestrator/task-hash.ts`. NOT into `cache/` — key-part selection
  composes graph types; pushing it down would force `cache → graph`.
- `orchestrator/nested-dirs.ts`, `orchestrator/fingerprint.ts` →
  move to `workspace/` (workspace geometry / workspace-file hashing).
- `orchestrator/plan-format.ts` → move to `cli/` (pure presentation;
  orchestrator keeps the `RunPlan` data types).
- `orchestrator/upstream.ts` stays — same `cache → graph` argument as
  task-hash.

## 2. Target design

Eight modules. A module is a directory with an `index.ts` contract,
or a single root file when it has no internals to hide.

| Module         | Form                                               | Contract highlights                                                                                                                                             |
| -------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `util`         | dir + index                                        | `UserError`, `xxh3*`, `relPosix`/`toPosix`, `ulid`                                                                                                              |
| `config`       | single file `src/config.ts`                        | schema types + `defineProject`/`defineWorkspace`. Stays at ROOT — cache/exec/graph/workspace all consume it; nesting under workspace inverts direction          |
| `workspace`    | dir + index                                        | discovery, loaders, package-graph, filter, affected, `ProjectEntry` (moved in), `computeNestedProjectDirs` (moved in), `computeWorkspaceFingerprint` (moved in) |
| `graph`        | dir + index                                        | task-graph, scheduler, dependency-spec, `TaskNode`/`TaskOutcome`/`TaskStatus`                                                                                   |
| `cache`        | dir + index                                        | `Cache`, `CacheLayer`, `LayeredCache`, `RemoteCache`, inputs/outputs resolution. `tar.ts` stays internal                                                        |
| `exec`         | dir + index                                        | runner, env, sandbox-runtime                                                                                                                                    |
| `orchestrator` | dir + index (entry moves to `orchestrator/run.ts`) | `run`, `planRun`, options/summary types, `Logger`, `defaultLogger`, `RunPlan` types                                                                             |
| `cli`          | dir + index (`cli.ts` moves in)                    | dispatcher + test-facing parser exports                                                                                                                         |

Root files outside the module set: `bin.ts`, `index.ts` (public
façade — exports unchanged), `version.ts` (new).

### Allowed dependency matrix (rows import columns, via index only)

|                  | util | config | version | workspace | graph | cache | exec | orchestrator | cli |
| ---------------- | ---- | ------ | ------- | --------- | ----- | ----- | ---- | ------------ | --- |
| **workspace**    | ✓    | ✓      |         | —         |       |       |      |              |     |
| **graph**        | ✓    | ✓      |         | ✓         | —     |       |      |              |     |
| **cache**        | ✓    | ✓      |         |           |       | —     |      |              |     |
| **exec**         | ✓    | ✓      |         |           |       |       | —    |              |     |
| **orchestrator** | ✓    | ✓      | ✓       | ✓         | ✓     | ✓     | ✓    | —            |     |
| **cli**          | ✓    | ✓      | ✓       | ✓         | ✓     | ✓     |      | ✓            | —   |
| **index**        |      | ✓      | ✓       |           | ✓     |       |      | ✓            |     |
| **bin**          | ✓    |        |         |           |       |       |      |              | ✓   |

Composition happens only at `orchestrator` and `cli`. `cli → cache`
stays (prune/stats open the cache without a run). `cli → exec` is
deliberately absent.

### Enforcement

Primary: `tests/module-boundaries.test.ts` — scans `src/**/*.ts`
import specifiers, asserts (rule 1) every cross-module edge is in the
ALLOWED matrix, and (rule 2) imports of modules listed in a
`CONTRACTED` set target the module's `index.ts` only. `CONTRACTED`
started empty and grew as contract PRs landed — a ratchet, complete
since step 6 (every directory module is contracted). Tests in
`tests/` are exempt (they may exercise internals). Zero new deps;
runs under the existing `bun test` CI gate.

Secondary: `import/no-cycle` in oxlint, if available — verify it
fires before trusting it; the boundary test catches directory-level
cycles either way.

## 3. Migration plan (each PR: zero behavior change, suite green)

All seven steps landed (June 2026).

| PR  | Status | What                                                                                                                |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| 1   | ✅     | This doc + boundary test (matrix law from day one) + cycle breaks: `version.ts`, `orchestrator/options.ts`          |
| 2   | ✅     | Relocations: `ProjectEntry` → workspace; `nested-dirs`, `fingerprint` → workspace; `plan-format` → cli              |
| 3   | ✅     | Split `execute-task.ts` hashing surface → `orchestrator/task-hash.ts`                                               |
| 4   | ✅     | Contracts: `cache/index.ts`, `exec/index.ts`, `util/index.ts`; rewrite importers; CONTRACTED += {cache, exec, util} |
| 5   | ✅     | Contracts: `workspace/index.ts`, `graph/index.ts`; CONTRACTED += {workspace, graph}                                 |
| 6   | ✅     | Entries: `orchestrator.ts` → `orchestrator/{index,run}.ts`; `cli.ts` → `cli/index.ts`; CONTRACTED complete          |
| 7   | ✅     | Docs: architecture.md module map, modules/ pages, CLAUDE.md layout                                                  |

## Out of scope

Test colocation (tests stay in `tests/`); renaming public exports;
splitting `cache/cache.ts` internals; exec's `RunOptions` rename
(flagged, optional); package-level splitting; any behavior change.
Cache key derivation untouched — no CACHE_VERSION bump anywhere in
the series.
