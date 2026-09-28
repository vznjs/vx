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

- C / B: `keep-alive.test.ts` › "a kill -9 in a Ctrl-C's grace takes the
  child of a shell that died on the signal" failed once in a local gate
  (ESRCH at its `process.kill(proc.pid, 'SIGKILL')`: vx had exited
  within the 200 ms after SIGINT) and passed 3/3 alone. The row's kill
  assumes vx outlives the grace; a timed wait, not a marker.

- G: `DOTENV_PROBE` is now in `turbo/turbo-map.ts` and
  `moon/moon-map.ts`; move it to a shared module (N may not edit
  `turbo/`).
- D / coordinator: a discovery seam (a plugin names project dirs). It
  unblocks Rush (`rush.json`), Lerna's `lerna.json` `packages` without
  package-manager workspaces, and moon projects with no `package.json`.
- D: `vx init` on docusaurus leaves `build:watch` (`tsc --build --watch`)
  and `copy:watch` (`… --watch`) non-persistent; a `--watch` script is
  a watcher.
