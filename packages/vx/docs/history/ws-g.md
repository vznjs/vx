# Workstream G — adoption (`vx-migrate`, `vx-lockfile`, `vx-schedule-history`)

## Leads (review of 2026-09-27)

Probed against real repos cloned outside the tree: create-t3-turbo
(pnpm 10, Turbo 2.5), astro (pnpm, Turbo), turborepo itself (pnpm 11,
Turbo 2.11), and Turbo's own lockfile corpus (`lockfile-tests/fixtures`,
`examples/*`: 163 lockfiles across pnpm v5.3–v9, npm, yarn classic and
berry, bun). `turbo run … --dry=json` against `vx run … --all
--dry=json`, dependency closures compared with Turbo's no-op nodes
collapsed: create-t3-turbo 25 of 25 tasks and astro 122 of 122 agree.

1. pnpm 10.x / 11 multi-document `pnpm-lock.yaml` (the env lockfile
   ahead of the project's) refused as "not a YAML document — regenerate
   it", which regenerates the same file: turborepo's own lockfile, the
   `pnpm-v11-multi-document` fixture and 8 of its examples. G-1.
2. Turbo 2.11's task `command` (`futureFlags.experimentalTaskCommand`)
   is reported as "no vx equivalent" and ignored. Turbo treats it as
   authoritative: an argv runs where the package has no script, `null`
   never runs. On turborepo itself vx misses `@turbo/types#build`,
   `docs#schema`, `docs#collect-examples-data`, `@turbo/gen#build:embed`,
   so it drops the edges to them (`docs#build` runs before the schema it
   copies), and runs the script body where the command differs.
3. Every other lockfile edge in the corpus resolves: pnpm by snapshot
   key, npm and bun by the node_modules walk, yarn berry by descriptor
   (its peer ranges and `resolutions` overrides fall back to every entry
   of the name, conservative by design). No dangling edge found.
4. Cargo crates Turbo discovers under `experimentalCargoWorkspaces` are
   outside vx's JS discovery: 117 of turborepo's 125 `build` tasks. A
   recorded refusal, not a row.

5. nx(): `{ fileset, dependencies: true }` expands as the project's OWN
   fileset, and `^{projectRoot}/x` (Nx's dependency fileset,
   `splitInputsIntoSelfAndDependencies`) is looked up as a named input
   and dropped with a todo: an edit to a dependency's file does not
   re-key the dependant (a stale hit where no task edge covers it).
   nx-examples' inferred `typecheck` carries both.
6. nx(): an Nx `implicitDependencies` edge (nx-examples' e2e projects →
   their apps) is reported "not representable", and `^typecheck` follows
   package.json only; each could be an explicit `pkg#target` edge.

## Leads for other streams

- **C/E:** in a `turbo()` workspace, `vx run build --all --dry=json`
  prints the plugin's warnings on STDOUT ahead of the JSON (the project
  stage's `warn` is `log.status` in `orchestrator/prepare.ts`), so the
  output does not parse (`… --dry=json 2>/dev/null | jq` fails on
  create-t3-turbo). Warnings belong on stderr, at least under `--json`
  modes.

- **F:** `vx-reapi` › a call a proxy cuts in transit ›
  RST_STREAM(INTERNAL_ERROR) reads as INTERNAL and is retried (F-1)
  counts `sent: 3` where it expects 4 under load: 2 of 3 runs failed
  while a gate ran beside it, 0 of 4 idle, and it failed G-3's re-gate.
  The retry count depends on time, not on the retry rule.
- **D:** `workspace/migration.ts` documents `MigrationPlan.notes` as
  "trailing report lines (e.g. implicit Nx deps)"; after G-7 the Nx
  mapper writes none, so the example names a note no source emits.

## Record

- **G-1.** pnpm multi-document lockfiles read (lead 1).
  `parseLockfile` takes the last non-empty YAML document as the
  lockfile and folds the ones before it into every importer's global
  digest, only when there are any, so a one-document lockfile keys as
  before. Rows (`pnpm.test.ts` › every input the pnpm digest must
  read): the last document is read and a bump in it moves only its
  importer; an env-document change moves every importer (red with the
  fold removed); a `---`-led one-document file keys as without it
  (control). All 161 text lockfiles of Turbo's corpus now parse.
- **G-2.** Turbo 2.11's task `command` mapped (lead 2). An argv is the
  task's command (each word quoted, from the package dir, no hooks) and
  emits the task where the package has no script; `null` / `[]` is
  Turbo's no-op node, its edges passed through; a toolchain map takes
  `javascript` (alias `typescript`) or leaves the script. On turborepo
  itself every JS task's dependency closure now matches `turbo run build
test check-types --dry=json` (43 tasks; the 75 left are Cargo crates,
  lead 4). Rows (`turbo-map-sweep.test.ts` › a task `command`): seven,
  red without the fix; the `rust`-only map is the control.
- **G-3.** `vx-schedule-history`'s docs say what the plugin packs (lead
  routed by J). The `resources` docstring said a reservation holds "the
  most CPU parallelism seen, rounded to a core", and the README's
  `vx history` sample showed a learned row reserving `· 2 cores`; cores
  are never learned, only declared. The sample was not the renderer's
  output either (column widths, `41.2s`). Row (`history-view.test.ts` ›
  the README sample): the block after `$ vx history` is `renderHistory`
  over the history it shows, reservations taken through
  `resourceEstimates` and `withDeclared` — red on the old sample and on
  `· 2 cores` alone.
- **G-4.** `vx-schedule-history`'s number options are checked. A NaN
  `memory` (`Number(process.env.X)`, X unset) fitted no reservation,
  so every task that reserved memory waited for an idle machine and
  the run went serial with no word; a NaN `headroom` dropped every
  learned reservation; a fractional or NaN `window` reached the
  history query. Each non-finite, non-positive value (and a fractional
  `window`) runs on its default, named in one warning per run and by
  `vx history`, as `assume` does (item 930). Rows: `resource-estimates`
  › a `memory` that is no number above 0 packs against the default
  (NaN, 0, −1); `schedule-history-e2e` › `vx history` shows the default
  budget and the learned reservation, the warning on stderr. Both red
  without the fix.
- **G-5.** nx() follows Nx's `dependsOn` rules on nx-examples (nrwl's
  own sample, Nx 23, yarn 4). Its `targetDefaults` give every
  `typecheck` a same-project `codegen` that one project declares; Nx
  adds an edge only where the target exists (`processTasksForSingleProject`)
  and says nothing, and vx passed it through, so core refused the whole
  run ("depends on …#codegen but no such task is declared"). And
  `^rsbuild:typecheck` (an inferred target's name holds a colon) was
  split into project `^rsbuild` and the edge dropped. `mapNxDeps` now
  drops an edge to a missing target in every form (plain, `p:t`,
  `{ target }`, `{ projects }`) and passes `^name` through whole. Rows
  (`nx-helpers-sweep.test.ts` › mapNxDeps): both red without the fix;
  each of the five guards mutated alone reddens one. Against
  `nx run-many -t build typecheck test lint --graph`, 40 of 42 tasks'
  closures agree; the two left are lead 6.
- **G-6.** nx() keys a task on its dependencies' FILESETS (lead 5).
  Nx reads `^{projectRoot}/…` / `^{workspaceRoot}/…` and
  `{ fileset, dependencies: true }` as each dependency's fileset
  (`splitInputsIntoSelfAndDependencies`, hashed with the `^name`
  inputs). The first was looked up as a named input (a todo per
  project, nothing keyed); the second expanded as the project's own
  fileset. Either way a dependency's edit re-keyed no dependant, a
  stale hit wherever no task edge covered it. Both now fold through a
  twin, `nx-input:fileset-<xxh3>`, like `^name`. Rows (`nx-map-sweep` ›
  a dependency fileset … keys on each dependency's files), one per
  form, red without the fix. nx-examples: the 30 "named input … not
  found" todos are gone. With it, the first mutation sweeps of
  `nx-upstream.ts` (28 mutants, 10 survivors, now held by
  `nx-upstream.test.ts`: deps' env/runtime, nested `^other`,
  `{input, projects}` on a non-vx node, `^{workspaceRoot}/…`) and
  `glob-grammar.ts` (12 mutants, 4 survivors, now held by
  `glob-grammar.test.ts`: `@()`, nested extglobs, braces in
  alternatives and classes). Equivalent: self-edge filter, `under`
  memo, the glob fast path.
- **G-7.** nx() follows the Nx graph for `^target` edges (lead 6). vx's
  `^` follows package.json, so an Nx edge with no manifest path
  (`implicitDependencies`; nx-examples' e2e projects → their apps)
  ordered nothing and folded nothing: an app's source edit left its e2e
  `typecheck` a hit. It was a note, "N implicit Nx deps not
  representable". Each `^target` now gains an explicit `pkg#target` to
  every project Nx's `processTasksForDependencies` reaches (a
  dependency with the target; through one without it, its
  dependencies), unless vx's package graph already reaches it (item
  931's rule). The note, its package-graph build and `NxMapping.notes`
  are gone. Rows: `nx-map-sweep` › `^target` follows the Nx graph
  (through a project that lacks the target; `listed` and `npm:` are
  controls); `nx.test` › an implicit dep … is an edge, not a note;
  `migrate.test` pkg-a's `build`. Red without the fix; the reach guard
  mutated reddens two.
- **G-10.** turbo() and nx() keep their mapping (leads from I, I-3).
  Both mapped every package each run. The adoption skeleton now keeps
  the mapping in `<cache dir>/vx-migrate-<nx|turbo>-mapping.json`,
  keyed on the plugin's own reads (nx: graph, nx.json, manifests,
  unmatched nodes' package.json, `.env` names, env flag, installed
  bins; turbo: every turbo.json(c), manifests) and the package's code.
  15 interleaved rounds, medians: refine (nx, `build --filter
@refinedev/antd... --dry`) main 284, A/A 285, cache 243; astro
  (turbo, 25 rounds, `build --filter astro... --dry`) main 677, A/A
  695, cache 669 — inside the A/A spread there: its key reads 1,124
  config paths (~12 ms) against ~40 ms of mapping, and the mapper
  modules load anyway (the package entry re-exports them). A hit plans
  refine's 281 task hashes as a miss does. Rows (`nx.test`,
  `turbo.test` › the mapping cache): a hit serves the kept file; each
  key input maps afresh; each key part removed reddens its row. The
  code part has no row (sources are fixed in a test).
- **G-11.** `vx-migrate --help` / `-h` print the usage on stdout and
  exit 0; they printed it as an error and exited 1 (`nx-env --help`
  exits 0). Row: `migrate.test` › --help and -h …, red without the
  fix; an unknown flag is the control. Also noted: on main after G-7,
  nx-examples' 42 task closures all match Nx's; a `turbo.json` field of
  the wrong type (`dependsOn: "^build"`) maps per character, but Turbo
  refuses that file itself, so no working repo carries one.
