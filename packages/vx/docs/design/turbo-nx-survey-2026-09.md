# Turbo / Nx test-suite survey (2026-09-10)

The owner's ask: "go through all tests of nx and turbo, see if we miss
any test or any core functionality, e.g. prevention of circular task
deps." Two survey passes over fresh sparse clones (Turborepo at
`crates/turborepo/tests`, `turborepo-lib`, `turborepo-cache`,
`turborepo-scm`; Nx at `packages/nx/src`, task-runner / hasher /
project-graph / command-line / native), every upstream test classified
against vx's suites with grep evidence: COVERED, GAP-TEST (behaviour
present, unpinned), GAP-CORE (behaviour absent), DIVERGENT (documented
choice), REJECTED (owner's list). This is the record of what came out
and what was decided; `docs/parity.md` stays the user-facing map.

Counts. Turbo: 568 tests over 74 files — ~355 rejected (Cargo/Go/uv
workspaces, prune, query, the daemon, TUI, futureFlags, globals, env
modes, `//` tasks…), ~155 covered, ~28 divergent, 10 core gaps, 5 test
gaps. Nx: ~380 cases in 146 rows — 78 covered, 41 rejected, 17
divergent, 7 core gaps, 3 test gaps. Circular task dependencies
specifically: every cycle shape both suites pin is covered, and vx
refuses at graph build rather than breaking edges (`NX_IGNORE_CYCLES`
has no vx spelling, on purpose).

## Fixed the same day (STATUS 102–105)

1. A literal directory in `cache.inputs.files` / `outputs.files`
   (`src/`, `dist`) matched nothing — the most common turbo.json shape
   migrated into a config that folded zero inputs and cached an empty
   artifact. A literal is now the file or its whole tree (Turbo
   `globs_test.rs`).
2. A negated workspace package glob (`!packages/fixtures`) inverted
   discovery: every manifest in the tree became a member. Negations
   subtract now, in discovery and the root-claim walk (Nx
   `project-configuration-utils.spec.ts`).
3. `--affected` diffed from the ref, not the merge base of ref and
   HEAD, so a branch off a moved trunk selected everyone else's changes
   (Turbo `affected_test.rs`, Nx `command-line-utils.spec.ts`).
4. Path filters take a glob (`./packages/*`, `{apps/**}`), matched
   against the project's own dir (Turbo `infer_pkg_test.rs`).
5. A `--cache` spec naming a remote axis with no remote layer says so
   (Turbo `run_caching.rs`).
6. Pins: the cycle message names the path; an unknown `pkg#task`
   target is named as such; `--concurrency <n>%`; `pkg#task` runs
   under `--filter '!pkg'`. Comparison rows: no bare-task
   cross-product; `parallelism: false` maps to a whole-budget
   `exec.resources` reservation.

## Fixed (STATUS 106, same night)

- SIGINT/SIGTERM: SIGTERM then `process.exit` with no grace and no
  SIGKILL escalation, so a child that trapped TERM was orphaned by a CI
  cancellation (Turbo `graceful_shutdown_test.rs`). Now: SIGTERM, a
  `VX_KILL_GRACE_MS` wait (2 s, the persistent shutdown's grace),
  SIGKILL, exit 130/143; a second signal skips the grace.
- A task whose command re-entered `vx run` forked without bound (Turbo
  `recursive_turbo_test.rs`). Now every child carries
  `VX_RUN_WORKSPACE` / `VX_RUN_TASK` and `run()` refuses its own root,
  naming the task — the terminating shape too, since a nested run is
  invisible to the outer graph; a different workspace is still fine.

## Deferred, with the reasoning

- **Project edges outside `package.json`** (Nx `implicitDependencies`;
  an e2e package that tests `app` without depending on it is invisible
  to `...[ref]`). vx's graph IS the manifest, on purpose: declare the
  dependency (`devDependencies: { app: 'workspace:*' }`) and every
  surface agrees. Whether a cross-project `dependsOn` edge should also
  count for selection is the open question; not decided here.
- **Project-selector `dependsOn`** (`lib*#build`, `!lib1`). vx
  materialises concrete edges and rejects a pattern in the `pkg#task`
  form; task-name patterns (`^build.*`) cover the common case. Revisit
  when a real workspace needs it.
- **Default base configuration** (`defaultBase`, `NX_BASE`). vx falls
  back `origin/HEAD` → `HEAD~1`; a workspace-level `affectedBase` is a
  small addition when someone asks.
- **`FORCE_COLOR` synthesized for children** (Nx defaults it on). vx
  forwards it only when set; a default would put ANSI into cached
  logs and every renderer. Explicit over magical.
- **Structured log stream** (`--log-file`, `--json` NDJSON). The
  telemetry seam carries every record; a sink plugin is the vx
  spelling. Core will not grow a second stream.
- **Richer `--dry=json` / `--summarize`** (per-file input hashes,
  command, env). `vx show` gives the command, `vx why` the input diff;
  a pre-execution file listing is a candidate, not a gap.
- **watch + persistent** divergence (documented, unpinned): a pin
  needs a watch harness that is not flaky; on the list with M7/M8.
- **Scoped vs whole-repo enumeration equivalence** for untracked files:
  a property test over `gitFilesCache`'s two partitions; candidate.
