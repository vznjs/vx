# Workstream N — adoption paths (plan-2026-09-27)

New adoption paths in `packages/vx-migrate/src/<tool>/`, beside G's
`turbo/` and `nx/`.

## Items

N-1. `moon()` and `vx-migrate --from moon`. moon 1 and moon 2 workspaces
run under vx from `.moon/` and each `moon.yml`; the CLI writes the same
tasks as configs. Checked against `moon query tasks`: 0 differences on
moonrepo/examples (moon 1.41.7, 12 projects, 76 tasks) and on a moon 2
fixture (2.5.5) covering `inheritedBy`, merges, `rename`, `extends`,
`noop` and `moon.yml` `dependsOn`. Two rules the probe taught: moon
applies the merge strategy of the task's FINAL options to every layer
(a project's `mergeArgs: prepend` puts its args ahead of all inherited
args), and a command list's tail joins the layer's args. moonrepo/moon
itself needs toolchain plugins from GHCR, unreachable here.

- Rows: `tests/moon.test.ts` (each red with its rule removed: the `**/*`
  default, the `dependsOn` edges, final-option merges, the `.env` probe).

N-2. `wireit()` and `vx-migrate --from wireit`. A wireit workspace (lit's
shape: npm workspaces, `wireit` blocks in each package.json) runs under
vx; the CLI writes the same tasks. `files` + `output` are the cache
block (wireit caches only with both), `../pkg:script` is `pkg#script`, a
plain npm script a dependency names runs as a task, `service` is
persistent with its `readyWhen`. On lit/lit all 299 tasks across 53
packages plan; its `packages/react` and `packages/context` list
`../../../rollup-common.js`, a path outside the repo, reported as a todo.
The dangling-edge prune moon and wireit share moved to
`src/dangling-edges.ts`.

- Rows: `tests/wireit.test.ts` (each red with its rule removed: both
  arrays for a cache, the `../` climb, `readyWhen`, the plain-script task).

N-3. `lage()` and `vx-migrate --from lage`. lage's JS config is
evaluated in a child `bun` per run and the mapping keyed on the result
(an edit to a file it requires remaps). Script targets map as Turbo's
do; `^^t` is an edge to every transitive dependency's `t`; `pkg#task`
replaces the generic entry as lage 2.17's target graph does. A target
with neither `outputs` nor `cacheOptions.outputGlob` runs uncached:
lage's default is every package file, which vx would clean. `outputGlob`
applies to every target, so two on it collide (the shared-outputs rule
uncaches one). A worker target (lage itself: 150 of 196) is a
`lage-worker` line, a Node bin that imports the module and calls it
with the target lage would build, one process per task, as `nx-exec`
does for Nx executors. fluentui-react-native (85 packages, 498 tasks)
and lage (25, 196) plan clean.

- Rows: `tests/lage.test.ts` (each red with its rule removed: `^^`, the
  no-outputs rule, the evaluated-config key, `pkg#task` replacing; a
  worker runs, caches and fails through `lage-worker`).

N-4. `moon()` on three more real moon 1 repos (adobe/leonardo, jsx-email,
astro-shield), each diffed against `moon query tasks` (milesj/boost's
own config fails moon's validation), found three rules the first two
repos lacked, now mapped:
`node.inferTasksFromScripts` (leonardo: package.json scripts are tasks,
`<pm> run <script>`, `test:types` as `test-types`, under moon.yml's
declaration); a task named `dev`, `start` or `serve` is `local` unless it
says otherwise (jsx-email's `dev` and leonardo's inferred `start` were
cached and blocking); and a layer that sets `command` replaces the args
before it (leonardo's `node --test` ran as `node run test --test`).
astro-shield: 0 differences. Left as moon differs: moon quotes a string
command's shell syntax (`rm -rf 'dist/*'`), and drops an inherited
`~:build` edge when the project excludes `build` and redefines it (vx
keeps the edge: more ordering, never a stale hit).

- Rows: `tests/moon.test.ts` › inferTasksFromScripts (red with each rule
  removed, the lifecycle filter included).

N-5. `workspaceScripts()` and `vx-migrate --from scripts`: a workspace
whose root scripts fan out through the package manager (`pnpm -r`,
`--filter`, `npm --workspaces`, `yarn workspaces foreach`, `bun --filter`,
`lerna run`) runs under vx, each fan-out a task in the packages it
selects, `^name` where the tool sorts, uncached. The last source the CLI
detects (every orchestrator wins over it). Checked against `pnpm -r`
10.34 at concurrency 1 on pinia (`size`, `test:dts`), starlight (`build`,
`build:examples`) and react-day-picker: pnpm's packages are vx's (a
package any root script fans out to takes the task), and pnpm's order
breaks no vx edge. vite, vitest and sveltekit could not be loaded: core
refuses their workspaces (lead below). Also covers `lerna run` in a root
script, the Lerna-without-Nx case.

- Rows: `tests/scripts.test.ts` (each red with its rule removed: `^`
  edges, chain order, `--parallel`, exclusion, path selection).
- Decision (supervisor, 2026-09-28): `rush()` waits on a core
  project-discovery seam; core finds projects only from package-manager
  manifests, and a Rush repo has none at its root. Routed to D below.

N-6. `moon()` dogfooded on kindspells/astro-shield (moon 1.41.7): the same
four commands under both tools, 2.64 s cold and 111 ms no-op against
moon's 3.78 s and 2.37 s (`benchmarks.md` § Adoption paths on real
repos). No mapping gap. moon's own warm run here is 4.2 s with the
network up: its version check times out behind the proxy.
N-7. `wireit()` dogfooded on FormidableLabs/spectacle (wireit 0.14.13):
21.5 s cold and 387 ms no-op against wireit's 22.2 s and 593 ms
(`benchmarks.md`). The first run deleted the tracked
`examples/one-page/index.html`: its script declares the file as input
and output with `clean: false`, and vx cleans outputs before a run. A
`clean: false` task with outputs now runs uncached (was: only one with a
wildcard first segment).

- Row: `tests/wireit.test.ts` › clean: false with an output that is also
  an input (red on the old rule: the file is gone and the task fails).

N-8. `lage()` dogfooded on microsoft/lage (lage 2.15.16, 71 targets, most
of them workers through `lage-worker`): 284 ms no-op against lage's
1.56 s; cold 32.4 s against 29.4 s, lage's worker pool keeping swc and
TypeScript loaded where `lage-worker` starts a process per target
(`benchmarks.md`). No mapping gap: both ran the same 71 targets.

N-9. `workspaceScripts()` dogfooded on vuejs/pinia (pnpm 11.21): its
`build` is `pnpm run -C packages/pinia build && …`, one package per
command, which the mapper did not read, so the repo's main build mapped
to nothing. `pnpm -C <dir>` / `--dir` and `yarn workspace <name>
<script>` now select that one package. 10.0 s against `pnpm build`'s
13.6 s, vx running `nuxt` and `testing` side by side after `pinia`
(`benchmarks.md`).

- Rows: `tests/scripts.test.ts` › parseFanOut (`-C`, `--dir=`, `yarn
  workspace`).

N-10. `workspaceScripts()` on withastro/starlight (3ec633b): `build`
fans `build` over `@astrojs/*`, `build:examples` over `@example/*`,
and vx holds one `build` task, so `vx run build` ran all five packages
where `pnpm build` ran two. The note that names each root script's vx
command now carries its selectors as `--filter` (vx's DSL is pnpm's)
whenever they narrow the script's holders, and `--all` otherwise: the
old `` `ci` is `vx run build test` `` refused at the root ("not inside
a project"). npm's `--workspace <path>` now selects by path.

- Row: `tests/scripts.test.ts` › each noted `vx run` selects the root
  script's packages — runs every noted command with `--dry=json`
  (red on the old note: `vx run test` exits 1 at the root).

N-11. A scan of 32 cloned repos' root scripts for fan-outs the parser
returned null on: docusaurus' `watch` is `pnpm lerna run --parallel
watch` (lerna through the manager; only `npx lerna` was read), and
unocss' `deploy` / `docs` are `npm -C <dir> run <script>` (npm's
prefix, one package). Both now map. Left unmapped on purpose: a
fan-out inside `concurrently "…"` or behind `cross-env` (shell the
parser does not take apart), npm/cli's `node . run` (npm running
itself).

- Rows: `tests/scripts.test.ts` › parseFanOut (`pnpm lerna`, `yarn
  exec lerna`, `npm -C`, `npm --prefix=`; red without the change).

N-12. `bunx @vzn/vx-migrate --dry` swept over 32 cloned repos: each
detected its own tool, but OpenCut (e668010: `.moon/` over a Cargo
workspace, no root `package.json`) and rushstack stopped at core's
"Could not find a workspace root". vx-migrate now names the moon or
Rush workspace it sees and what vx needs from it; any other refusal
reads as core words it.

- Row: `tests/migrate.test.ts` › a repo core finds no workspace root in
  (moon, Rush, and an empty dir as the control; red without the change).

N-13. `workspaceScripts()` on withastro/starlight against pnpm 11.22:
10.3 s against 12.7 s for `build`, the same two builds in the same
order (`benchmarks.md`). pnpm stalls offline (81 s under `unshare -n`),
so these reps ran with the network up. Lerna without Nx looked at and
left: docusaurus has `useNx: false` and uses lerna only to version and
publish; its builds are root fan-outs, which `workspaceScripts()` maps.

N-14. `turbo()` on vueuse/vueuse (Turbo 2.10.12): the mapping plans
Turbo's 12 tasks, `metadata#update` before `metadata#build` from the
package `turbo.json`, `$TURBO_ROOT$` inputs as `workspaceFiles`. vx
fails cold as checked in (an undeclared read of an output vx cleans
first; lead A below); with the missing edge, 21.4 s cold against 29.2
s, restore 263 ms against 128 ms (`benchmarks.md`). Harness: Turbo
runs each script through `pnpm` on PATH, and the box's `/opt/node22`
pnpm stalled 28 min fetching the repo's pinned pnpm 11.25; the
install's pnpm goes first on PATH.

N-15. `nx()` on TanStack/query (Nx 23.2.1): the plan matches Nx's own
task graph for `build`, 25 tasks and 0 edge mismatches. 34.6 s cold
against 37.1 s, restore 910 ms against 1.62 s, no-op 291 ms against
1.60 s (`benchmarks.md`). No mapping gap. The harness learned that Nx
keeps a task-to-cache record in `.nx/workspace-data/*.db`: a wiped
cache directory under a kept database replays 25 "hits" that restore
nothing.

N-16. `nx()` on TanStack/router (Nx 23.2.1): 43 build tasks, 0 edge
mismatches against Nx's task graph. 123.0 s cold against 138.0 s,
restore 1.27 s against 3.82 s, no-op 626 ms against 3.91 s
(`benchmarks.md`). No mapping gap for `build`; the e2e targets' Nx
`params: "forward"` edges are reported as unsupported, as designed.

N-17. `turbo()` on unocss/unocss (Turbo 2.10.13): 42 tasks, 0 edge
mismatches; `turbo()` names the `VITE_*` / `PUBLIC_*` env Turbo infers
for vite and astro packages. 45.1 s cold against 47.3 s; warm Turbo
wins (185 ms restore, 126 ms no-op against 859 and 770 ms) because
one task re-runs every time under vx (lead A below).

N-18. `nx()` on analogjs/analog (40cc8b4, Nx 23.2.1): an integrated Nx
repo, where `pnpm-workspace.yaml` lists only `apps/docs-analog` and
every library is an Nx project by its `project.json` alone. vx finds
projects only through the package manager, so `nx()` attached one of
the 21 `build` tasks Nx plans and named the other 31 projects as
unattachable. No benchmark: nothing comparable runs. Lead D below.

N-19. `nx()` on typescript-eslint (Nx 23.2.1): 16 build tasks from
the `@nx/js/typescript` inference plugin, 0 edge mismatches once Nx's
short project names (`parser`) map to package names. 16.8 s cold
against 17.8 s, restore 1.50 s against 2.95 s, no-op 1.11 s against
2.96 s (`benchmarks.md`). No mapping gap.

N-20. `turbo()` on trpc/trpc (ec0b0a4, Turbo 2.10.12): core refused the
whole run. Five packages' `turbo.json` list `package.json` as a `build`
output (the build rewrites `exports`); Turbo caches the manifest, vx
cleans outputs before a run, and the loader refuses a glob that covers
the project's own `package.json`. `turbo()` and `nx()` now run such a
task uncached with a todo; trpc's plan then matches Turbo's (7 tasks, 0
edge mismatches). The check is a copy of core's (the façade does not
export it), held to the loader in both directions.

- Rows: `tests/own-file-outputs.test.ts` (the loader agreement table;
  the turbo and nx rows each fail with their call site undone).

N-21. `turbo()` on trpc/trpc, benchmarked after N-20: 7.8 s cold
against 8.1 s; warm runs 6.4–6.6 s against 143–210 ms, because the five
`build` tasks whose outputs hold `package.json` run every time. Their
build rewrites `package.json` with the same bytes (`git status` clean),
so the A lead on same-bytes input rewrites (unocss, N-17) would let a
mapping that drops that output cache them.

N-22. `turbo()` on shadcn-ui/ui (Turbo 2.9.18): `build` over
`./packages/*` (3 tasks) and `typecheck` (5) plan as Turbo does, 0 edge
mismatches. 21.4 s cold against 24.4 s, restore 221 ms against 567 ms,
no-op 216 ms against 545 ms (`benchmarks.md`). No mapping gap.

N-23. `nx()` on TanStack/form (Nx 23.2.1): `build`, `test:lib`,
`test:types`, `test:eslint` and `test:build` plan as Nx does over 171
tasks, 0 edge mismatches; tests pass, rerun all hits. `build` over the
14 packages: 40.3 s cold against 44.2 s, restore 335 ms against
1.16 s, no-op 247 ms against 1.15 s. No mapping gap.

## Candidates not built (2026-09-28)

- Lerna without Nx: `lerna run <s>` (lerna 10.0.1, `prepNxOptions`)
  runs each package's script with an edge to its dependencies' `<s>`
  and caches nothing unless `nx.json` configures targets, which is an
  Nx repo (`nx()`). Real users (docusaurus `useNx: false`, jest via
  lerna-lite) run lerna for versioning and `lerna run build`; `vx init`
  already writes those scripts with `^build`. No `lerna()`: it would add
  only `^<s>` on non-build scripts.
- Rush: rushstack (197 projects) has no root `package.json` and no
  `pnpm-workspace.yaml`; its projects live in `rush.json`. vx discovery
  finds no workspace, and a plugin cannot add projects (the `project`
  stage fills discovered ones). Blocked on a discovery seam.

## Leads for other streams

- A: `execute-task.test.ts` › "trusts recorded directories without
  re-recording them; a restore leaves its snapshot to run end" failed
  once in a local gate (`restored` false at line 1225) and passed 3/3
  alone. It stamps `dist` with `utimesSync(…, now, now)` right after a
  recording and expects the restore to see the change; within one
  timestamp tick the two can be equal. Unproven cause; a stamp that
  differs by construction (now + 1 s) would settle it.

- D, for `rush()` (what it needs, exactly): (1) `findWorkspaceRoot`
  accepts a directory holding `vx.workspace.{ts,mjs}` as a root, since a
  Rush root has no `package.json` or `pnpm-workspace.yaml`; (2) the
  `config` stage (or a new discovery hook) may add project directories,
  each holding a `package.json`, which core then loads as it loads a
  package glob's. With both, `rush()` reads `rush.json` `projects[]
.projectFolder` in that hook and maps `common/config/rush/command-line.json`
  bulk and phased commands and each `config/rush-project.json`
  `operationSettings` outputs in the `project` stage.

- D: core refuses a workspace with two packages of one name ("Duplicate
  package name"), and vite (`playground/hmr` and
  `playground/module-graph`), vitest (`test/e2e/dts/*`) and sveltekit
  (`packages/kit/test/build-errors/apps/*`) each have such test fixtures,
  which pnpm accepts. None of the three can run under vx.
- H: `PERSISTENT_TASK_NAMES` is not on the façade; `workspaceScripts()`
  keeps a copy of its five names.

- C / B: `keep-alive.test.ts` › "a kill -9 in a Ctrl-C's grace takes the
  child of a shell that died on the signal" failed once in a local gate
  (ESRCH at its `process.kill(proc.pid, 'SIGKILL')`: vx had exited
  within the 200 ms after SIGINT) and passed 3/3 alone. The row's kill
  assumes vx outlives the grace; a timed wait, not a marker. Again in
  the N-12 gate (2026-09-28, 06:55, same line 580), 5/5 green alone.
  Fixed by C-38 (vx held in the grace until its kill -9).

- G: `DOTENV_PROBE` is now in `turbo/turbo-map.ts` and
  `moon/moon-map.ts`; move it to a shared module (N may not edit
  `turbo/`).
- D / coordinator: a discovery seam (a plugin names project dirs). It
  unblocks Rush (`rush.json`), Lerna's `lerna.json` `packages` without
  package-manager workspaces, and moon projects with no `package.json`.
- D: `vx init` on docusaurus leaves `build:watch` (`tsc --build --watch`)
  and `copy:watch` (`… --watch`) non-persistent; a `--watch` script is
  a watcher.
- D / coordinator: workspace-root tasks. Every adoption path drops
  them: turbo `//#task`, Nx's root project, wireit root scripts (lit:
  12, incl. `build`, `lint`), lage root targets, root-only commands in
  workspace scripts. microsoft/fluentui-react-native (fc6133e) builds
  with one root `tsc -b` (`root-build`) that all 85 packages' `test`
  wait on, so under `lage()` they test with nothing built (162 edges
  dropped). A root project with tasks (its own inputs, never globbing
  into members) would let each mapper keep them.
- A: `cache.outputs.files` takes no `!`. lit (01dbc66) excludes a
  tracked file or a scratch dir from 12 wireit outputs
  (`!development/test/router_test.html`, `!test/__temp`), so those 12
  run uncached under `wireit()`: dropping the `!` would clean the
  excluded file. Wrong by the time it merged: A-44 had given outputs
  `!` (a negated output takes its path back).
- A: vx cleans a task's outputs before it runs; Turbo does not. On
  vueuse (efdd69a) ten builds read `packages/metadata/index.json`, the
  output of `metadata#update`, with no edge to it, so every vx cold run
  fails (`index.json` gone for the 1.6 s `update` takes) where Turbo
  reads the old file. A mapper cannot know an undeclared reader. Worth
  a word in the failure: a task that fails reading a file another
  running task's clean just removed.
- A: a task that rewrites an input with the same bytes is never cached.
  unocss's `@unocss/vscode#build` (f05ee3a) runs `vscode-ext-gen`,
  which rewrites `README.md` and its generated `meta.ts` unchanged;
  `movedInput` counts any ctime inside the command's window as a move,
  so the save is withheld on every run (550–900 ms per no-op) where
  Turbo caches it. A digest compare for those paths would decide it by
  content.
- D / coordinator, for `nx()` (Turbo and Nx are the only adoption
  paths, owner 2026-09-28): an integrated Nx repo does not run under
  vx. analogjs/analog (40cc8b4) keeps its libraries out of
  `pnpm-workspace.yaml`; each is an Nx project by `project.json`, and
  some (`@analogjs/router`) have a `package.json` no workspace lists.
  `nx()` attaches 1 of Nx's 21 `build` tasks. It needs the discovery
  hook asked for above (a plugin names project directories), taking a
  directory with a `project.json` and no `package.json` too; `nx()`
  would name every graph node's `root`.
