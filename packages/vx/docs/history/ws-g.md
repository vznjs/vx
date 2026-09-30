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
- **C:** nx()'s graph key runs its own `git status --porcelain -z
-uall` (item 1075); core's early enumeration runs the same command
  beside it. refine: 60 ms median; scoping by pathspec does not help
  (two top dirs 60 ms, all 206 project roots 124 ms). A project-hook
  context field for the worktree status (HEAD + that output) would let
  nx() drop its spawn (I-6 measured 417 → 321 ms with the key bounded).
- **B:** `sandbox-runtime.unsafe.test.ts` rows are load-sensitive: on
  PR #1324's CI "control: `localBinding: true` binds inside the
  namespace and the host sees nothing" read `r.ok` true (expected
  false), and a local gate beside another run failed "a traced sandboxed
  one-shot task's children die with vx"; both passed alone (179/179,
  twice). Neither touched by stream G.
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
- **G-12.** turboCache() and nxCache() resend a failed request once, as
  Turbo's client does (`retry.rs`): a 429 or 5xx other than 501 after
  2 s (a 429's `Retry-After`, capped at 10 s), a refused port or
  unresolved host likewise. One gateway 503 read as a miss and the task
  ran again. A spent deadline is not resent (Turbo resends reads): a
  hung server would cost it twice. Option `retries` (default 1, 0 off,
  a non-integer refused: NaN resent forever). Slow remote probed: 8
  chained tasks against a server that never answers cost two deadlines,
  not eight (the prefetch pass is concurrent). Rows:
  `remote-cache-degrade` › a 503 heals on the resend (both wires, red
  without the fix); `remote-retry.test.ts` (which answers, how long, how
  often; the option).
- **G-13.** turbo() follows a package config's `extends` to other
  packages (`"extends": ["//", "shared"]`, read by Turbo 2.11, refused by 2.5). It read root
  plus own: the shared file's tasks were not emitted and its fields not
  folded, so an `inputs` it widened keyed nothing (a stale hit). The
  chain is Turbo's `turbo_json_chain` order; task existence is
  `has_task_definition_in_run` (own entry, else the first parent in
  `extends` order); the fold restarts at the nearest `extends: false`.
  A parent with no turbo.json and a cycle are refused, as Turbo refuses
  them. A 3-level fixture matches `turbo run build check test
--dry=json` (2.11.4) on every task's inputs, outputs, env and edges.
  Rows (`turbo-map-sweep` › a package config that extends another
  package): both red without the fix.
- **G-14.** turbo() reads two Turbo 2.11 turbo.json shapes. The `global`
  block (`futureFlags.globalConfiguration`) was ignored: its `inputs`
  and `env` keyed nothing, so an edit to a global file was a hit on
  every task; it now replaces the top-level lists, as Turbo's
  `resolve_global_config` does. A structured `inputs` entry
  (`{ mode, globs, withDefaults }`) crashed the plugin and failed the
  run; `startup` / `jit` now map to their globs (`**/*` with
  `withDefaults`), `dependencyOutputs` to none (vx folds the
  dependency's key). Probed against `turbo --dry=json` 2.11.4. Rows
  (`turbo-map-sweep` › the `global` block, structured inputs): red
  without the fix.
- **G-15.** turbo() notes Turbo's `envMode: "loose"` (top-level or in
  `global`). Loose mode hands every task the whole environment; vx's is
  isolated, so a task reading an undeclared variable ran without it and
  nothing said so. Row (`turbo-map-sweep` › envMode "loose"): red
  without the fix; strict and absent are the controls. With it, a
  mutation sweep of G-12's `remote-retry.ts` (17 mutants): 3 survived
  (the resent answer's body not cancelled, a past `Retry-After` date's
  clamp, an unreadable one's fallback) and 2 hung (the retry bound
  removed); `remote-retry.test.ts` now catches all 17.
- **G-16.** A mutation sweep of G-13 and G-14's turbo-map code (31
  mutants): 9 survived. Held now: the first parent's opt-out
  (`r !== 'none'`), the nearest `extends: false` (fold direction), an
  empty `extends` read as the root's, `jit` with `withDefaults` — rows
  (`turbo-map-sweep` › an extends diamond, structured inputs) from
  `turbo --dry=json` 2.11.4 on the same fixture. Equivalent: the chain's
  seen set (a file read twice folds to the same definition), the
  unrequired-root guard (only the package's own file can be missing
  unrequired; the condition is gone), `taskDefined`'s seen and root
  stops (the chain refuses a cycle first), the `excluded` filter, the
  `extends` key's delete, the `global` null guard (Turbo refuses a null).
  A comment that dated the empty-`extends` reading to Turbo 2.0–2.6
  (unproven) now says Turbo refuses it.
- **G-17.** A mutation sweep of G-10's `mapping-cache.ts` (15 mutants):
  12 survived. Held now: a hit restores the miss's notes and todos (a
  cached run warned nothing), and a mapping file that cannot be written
  still plans the run (the best-effort catch). Rows (`turbo.test` › the
  mapping cache): a hit warns what the miss warned; a mapping that
  cannot be kept still plans the run. Unheld by design: the code
  identity part (sources are fixed in a test; G-10). Equivalent: the
  `mkdir` (core makes the cache dir first), the rename's atomicity, the
  per-process memo and the file sort (cost only).
- **G-18.** A mutation sweep of `vx-lockfile/src/npm.ts` (25 mutants):
  22 caught. Held now: a node's path in its material — without it two
  workspaces that link each other at the same version gave one set of
  lines when a lockfile swapped which reached which `is-number`, item
  1073's class on npm's side (1073 named npm safe by the path and had
  no row for it). Row (`npm.test` › two workspaces that link each other
  and swap versions both move): red without the path; the same lockfile
  twice is the control. Equivalent: the `lockfileVersion` in the global
  (v2 and v3 install one tree), the `continue` after a link (a link
  entry carries no dependencies).
  With it, `yarn.ts` (29 mutants): 18 caught, 11 equivalent (duplicate
  edges or names, a peer range folded twice, the classic comment and
  `inDeps` resets, the `catalog:` branch the unkeyed-descriptor fallback
  already covers); no row needed. `bun.ts` (27): 21 caught, 6
  equivalent (a node's path and id, the importer's dir: the workspace
  package ids already part every line; the root-name and empty-path
  guards). `pnpm.ts` (34): 30 caught, 4 equivalent (the trailing-null
  filter, the lockfile version the rest already carries, the absolute
  and own-key lookups the version fallback covers).
- **G-19.** A mutation sweep of `vx-schedule-history`'s
  `critical-path.ts` (15 mutants): 13 caught. Held now: a history entry
  with no p50 (runs, but every one a cache hit) stays out of the
  workspace median; counted as 0 it pulled the median down and every
  task without history of its own was scored short. Row
  (`schedule-history.test` › a history entry with no p50 does not enter
  the workspace median), red without the guard. Equivalent: `left <= 0`
  (an upstream outside the run has no node to release).
- **G-20.** `vx-schedule-history` checks declared `reservations`. A
  NaN axis (`memory: Number(process.env.X)`, X unset) held its task
  alone and summed into what runs, so every reserving task beside it
  waited: the run went serial and said nothing (G-4's class, the
  declared side). Each axis that is no number above 0 now reserves
  nothing, named in the one options warning; `0` is taken silently.
  Row (`resource-estimates` › a declared reservation axis that is no
  number above 0 reserves nothing): red without the fix.
- **G-21.** A mutation sweep of nx()'s graph key (`graphInputKey`, item
  1075; 13 mutants): 3 caught. Item 1075's own row appended to a file,
  so the key moved by the file's LENGTH and dropping the content hash
  survived; so did dropping HEAD. Held now: a same-length edit, and a
  commit that leaves the status empty before and after, each re-export
  (`nx.test` › a same-length edit and a new commit on a clean tree
  each re-export; both red without their part). Unheld, recorded: the
  status guard (vx refuses a workspace outside git before it matters),
  the cache-dir and root-project arms (only a workspace whose root is a
  project reaches them; the fixture has none), the rename record skip,
  the sort and the per-file path line.
- **G-22.** nx() in a standalone Nx repo (the workspace root is the one
  project) exported the graph on every run. Every file under the root
  was a project file, and the export writes Nx's own
  `.nx/workspace-data/` (and `.nx/cache/`): a repo that does not ignore
  them saw the key move each time. Both are now out of the key;
  `.nx/installation` (Nx's pinned version) stays in. Row (`nx.test` ›
  a workspace whose root is the project): a source edit re-exports, a
  second run with nothing changed does not; red without the fix. It
  also holds G-21's root-project arm; the cache-dir arm stays
  equivalent (the cache dir ignores itself).
- **G-23.** nxCache()'s `has` kept its unread response for a `get` of
  the same hash, and the README and docstring said the prefetch pass
  asks that way. It does not: prefetch calls `get`; core asks `has`
  only for a `--dry` prediction, and nothing follows it. The kept
  state served nothing and held the last probe's connection until the
  deadline. `has` now cancels its body before it answers. Row
  (`nx-cache.test` › has is a GET whose body is cancelled before it
  answers): red on the old code; the two rows that pinned the reuse
  are gone with it.
- **G-24.** A mutation sweep of `vx-lockfile/src/index.ts` (9 mutants):
  5 caught. Dropping the `extraFiles` wiring, or bun's
  `patchFiles`, survived: item 1014's rows hand the patch content to
  the digest by hand, so an edited Bun patch keeping every key through
  the plugin went unseen. Row (`bun.test` › an edit to a patch file
  bun.lock names re-keys every project): red on both. Unheld: the
  `DIGEST_VERSION` value (the memo's identity; a row would restate the
  constant) and the unprefixed-message branch (every parser names its
  file).
- **G-25.** A mutation sweep of `vx-migrate/src/shared-outputs.ts` (22
  mutants): 14 caught, one hang (a cycle without its `seen` set), seven
  survived. Three were real and each now has a row
  (`helpers-sweep.test` › the edge orders a pair): a third task is
  checked against every kept sibling, not only a `^`-edge keeper; a
  kept task it does not overlap needs no edge; a same-project edge is
  not a `^` edge. Four are equivalent: a non-string or empty output
  list never overlaps, and a `^name` in the local walk names no task.
- **G-26.** A mutation sweep of `vx-migrate`'s `nx-exec.cjs` (29
  mutants) and `remote-token.ts` (6), neither swept before: 23 caught
  (one only by `nx.test`'s dotenv row), 12 survived, each now held.
  `nx-exec.test`: `-h`, an empty `--project`, `--options null`, a cache
  whose `nodes` is null, a repeated `--dotenv` (every file loaded, none
  an override), `NX_VERBOSE_LOGGING`, and the fake Nx now records the
  graph's `externalNodes` / `dependencies` (filled when absent, as
  executors read both) and the project's other targets (the injected
  one joins them). `turbo-cache-sweep.test`: a bare CR is refused and
  U+00FF, Latin-1's last, is not (Bun 1.4.2's `Headers` does the same).
- **G-27.** A mutation sweep of nx()'s `index.ts` outside G-21's graph
  key (38 mutants): 28 caught (one after its broken first spelling),
  ten survived. Three only make the key read more (a root's trailing
  slash, `''` as `.`, a matched node's manifest read again). Seven were
  live and are now held (`nx.test` › the graph snapshot, keyed and not):
  - the graph load's notes are in the mapping key, so a failed export's
    note leaves with the next export that succeeds instead of replaying
    from the kept mapping;
  - a snapshot deleted under a key still on disk is exported again;
  - a `root` outside the git worktree (no key; core refuses a run
    outside git, so this is the only way to reach the mtime fallback)
    re-exports on a newer nx.json base, root manifest, `project.json`
    or package manifest, and not otherwise.
- **G-28.** A mutation sweep of turbo()'s `index.ts` (16 mutants): 12
  caught, four survived. Two were live mapping-cache holes, each now a
  row (`turbo.test` › the mapping cache): a package `turbo.jsonc`
  edit maps afresh, and an empty `turbo.json` beside a `turbo.jsonc`
  (which shadows it, and Turbo refuses) is not keyed as an absent one.
  Two are equivalent: the dirs list and the package name are already
  in the manifests' part of the key.
- **G-29.** nx()'s mapping key read `nx.json` alone, while the mapper
  resolves named inputs from its whole `extends` chain (item 1050): an
  edit to a base's `namedInputs` kept the mapping, and every task ran
  on the old inputs. The key reads the chain now (`readNxJson`'s
  files). Row (`nx.test` › the mapping cache › an edit to the nx.json
  base maps afresh): red without the fix. Found by auditing what each
  adoption mapper reads against its key after G-28; the rest of both
  mappers' reads, and the lockfile plugins' patches, are keyed. A
  re-sweep of `nxCache()` after G-23's rewrite: 28 mutants, all caught.
- **G-30.** A sweep of G-20's reservation checks in
  `vx-schedule-history` (10 mutants): 7 caught, 3 survived. Two were
  live and are now held by the G-20 row: a NaN `cpus` beside a valid
  `memory` reserves no cores (the row had only a negative one, which
  admits either way), and a `null` entry is neither a crash nor a
  warning. `{}` for "no reservations declared" is equivalent to
  `undefined`.
- **G-31.** A yarn classic `yarn.lock` with git merge conflict markers
  parsed without a word: the line parser took the second side and read
  `<<<<<<< HEAD` as an entry, so the key named an install that may not
  be the one on disk (a stale hit when another checkout holds that side
  cleanly). pnpm, npm, bun and berry refused only through a parse
  error. Every manager now refuses markers by name with the install
  that fixes it. Row (`refusal-message.test`): red without the fix.
  Found probing each parser with a conflicted lockfile.
- **G-32.** turbo() maps a task's `description`. Turbo 2.11.5's schema
  has the key and Turbo refuses a task key it does not know (measured:
  `bogusKey` fails the parse, `description` does not), yet turbo()
  reported it as "no vx equivalent — map it manually" on every task
  that set it; it is now the vx task's `description`. Row
  (`turbo-map-sweep.test`): red without the fix. Also drops the unused
  `type Gaps` import in `nx/index.ts` (C's lead).
- **G-33.** nx() reports `parallelism: false` and `syncGenerators`
  (both in Nx 23.2.1's project schema). They were dropped in silence:
  a target Nx runs alone (an e2e suite that owns a port or a database)
  ran beside others under vx, and Nx's sync generators
  (`@nx/js:typescript-sync` keeping tsconfig references current) never
  ran. Each is now a todo naming its stand-in (`--concurrency 1`,
  `nx sync`); the defaults say nothing. Row (`nx-map-sweep.test`): red
  without the fix. Found comparing Nx 23.2.1's target keys with the
  mapper's.
- **G-34.** nx() says nx.json's `sync.globalGenerators` once per run
  (and `vx-migrate --from nx` in its notes). Nx runs them before a
  run's tasks; G-33 reported the per-target `syncGenerators` and these
  stayed silent. The mapper returns workspace-wide `notes` beside its
  projects. Rows (`nx-map-sweep.test`, `nx.test`): each red without its
  line.
- **G-35.** turboCache() reads the root `turbo.json`'s `remoteCache`
  (`apiUrl`, `teamId`, `teamSlug`, `enabled`, Turbo 2.11.5's schema)
  below options and Turbo's env vars, Turbo's own order. A repo whose
  self-hosted cache lives only there had no remote cache under vx, and
  no word: with a token the plugin went to Vercel's; without one it
  declined. `enabled: false` declines unless options name a cache. The
  timeouts stay vx's (Turbo's `0` is "none", which a deadline cannot
  take). Rows (`turbo-cache.test`): red without the fix.
- **G-36.** Yarn Plug'n'Play, probed on a Yarn 4.9.1 workspace with
  no `node_modules`: yarn() keys it right (a `left-pad` lock edit
  re-keyed its one dependant, not the sibling), but turbo() inlined
  the script body, and `node -e "require('left-pad')"` was
  MODULE_NOT_FOUND: PnP resolves through `.pnp.cjs` and bins through
  `yarn run`'s shims. Under PnP (`.yarnrc.yml` with no `nodeLinker`,
  or `pnp`) every script now runs as `yarn run <name>`, as Turbo runs
  it; `.yarnrc.yml` joins the mapping key. nx() is untouched: Nx
  itself refuses PnP. Rows (`script-command.test`, `turbo.test`): red
  without the fix.
- **G-37.** nx() and Nx 23 inferred targets (`@nx/js/typescript`,
  `@nx/vite`, `@nx/vitest`, `@nx/jest`, `@nx/eslint`; no project.json):
  all 20 targets map, run, hit warm and restore. One stale hit:
  `@nx/vitest` infers a `json` input on the root `tsconfig.json`,
  fields `compilerOptions`; it was a "not representable" todo and
  dropped, so a `compilerOptions` edit was a hit where Nx re-ran. A `{ json }` input
  now keys its whole file (a superset of the fields). Row
  (`nx-helpers-sweep.test`): red without the fix.
- **G-38.** Real-repo proof of the four lockfile parsers: every
  `name@version` bumped as its manager would (integrity, pnpm key
  renames), `importerDigests` diffed against an independent closure
  walker. pnpm vuejs/core@4ab865a 481/481 exact; npm
  microsoft/playwright@b9a34ac 408/408; bun sst/opencode@03e6717
  375/375; yarn 4 jestjs/jest@202dd8a 209/250 exact, 41 over, 0
  under. The yarn over-keys are one fallback, `resolveDescriptor`'s
  every-entry-of-the-name (item 903): 39 are peer ranges no entry
  keys (hoisted, so arguably real edges), 2 are root `resolutions`
  overrides (`type-fest@1.4.0` re-keyed 23 projects, not 1). Honouring
  `resolutions` needs the root package.json's text in the digest; the
  claim hands the parser content hashes only, a core seam, so the
  over-key (safe: never a stale hit) stays.
- **G-39.** An Nx output whose `{options.x}` is unset (falsy) is
  dropped, as Nx's `getOutputsForTargetAndConfiguration` drops it. It
  was a "not a literal string" todo on every inferred `@nx/eslint`
  `lint` target (`{options.outputFile}`, G-37's probe). A set
  non-string option keeps its todo. Row (`nx-helpers-sweep.test`): red
  without the fix.
- **G-40.** nx()'s `externalDependencies` todo said vx hashes the
  project's package.json; Nx's inferred targets name root
  devDependencies (eslint, vitest) no project manifest holds. What
  keys them is the lockfile: the whole file in core's fingerprint, or
  a lockfile plugin's project closure, which folds the root
  importer's (`lockfile-claim.ts`). The todo now says so, and names
  the one case left: a package only another project installs. Left as
  is from G-37's probe: an atomized `test-ci--<file>` whose coverage
  dir sits under `test`'s runs uncached; caching both would let one
  restore over the other's outputs.
- **G-41.** turbo() + yarn() on callstack/reassure@29c4611 (Yarn
  4.11, `node-modules` linker, 8 workspaces): 6 builds ran, warm
  rerun 6 up-to-date in 34 ms, a wiped `lib/` restored. A checksum
  edit to `@react-native-community/cli`, installed for
  `test-apps/native` alone, re-keyed all six: a peer range matches no
  lockfile key, so the edge reaches every entry of the name (213 of
  217 such edges are peers). Kept: under `node-modules` an unprovided
  optional peer loads whatever copy is hoisted, so the edge is real.
  Only under PnP could it drop, and the parser cannot see
  `.yarnrc.yml`'s `nodeLinker` (the claim hands it hashes, as for
  G-38's `resolutions`). Both wait on one core seam: extra files'
  content in `digest`.
- **G-42.** nx() emits an `nx-input:<name>` twin only where an edge
  reaches it, not in every project for every name asked (Next 25). On
  a synthetic 300-project graph (200 libs, 100 apps, `^production` on
  `build` and `test`): 300 → 181 twins, the same 781 tasks planned
  with identical keys. A/B, interleaved, before arm a `main` worktree:
  `load configs` warm 28.5 → 25.6 ms at min (N=11), cold 62.1 → 57.5
  (N=9); the warm wall is noise (215 vs 224 ms min, 265 vs 261 median,
  N=21). Rows (`nx-map-sweep`, `nx-upstream`): an unreached project
  has no twin; red without the fix.
- **G-43.** Mutation sweep of G-36..G-42's code: eight mutants, four
  caught. In G-42's twin walk: the output sort was dead (the walk's
  order is already deterministic), so it went; the `wanted` guard
  and `{ input, projects }`'s `want` survived, since the sweep's
  `tasksOf` kept the last of two same-named tasks and no row asked
  for a named project's twin. `tasksOf` now refuses a task mapped
  twice; a diamond row and the `projects` row hold both.
- **G-44.** turbo() and nx() map a `!` output now that core takes one
  (A-44). Turbo's stock Next pair, `.next/**` minus `!.next/cache/**`,
  was a todo: the positive alone saved Next's cache into the artifact
  and cleaned it before every miss. A negation rides beside its
  positives in `files` or `workspaceFiles`; one with no positive beside
  it takes back nothing and is dropped (core refuses a list of them
  alone). The shared-output rule reads positives only, as core does: a
  `!` glob compiled as-is matched every other path, and a literal
  `out` beside `!.next/cache/**` uncached a task. Rows (`turbo.test`,
  `turbo-map-sweep`, `nx-helpers-sweep`, `helpers-sweep`): red without
  the fix. wireit(), lage() and moon() still refuse `!`; theirs is
  stream N's slice.
- **G-45.** turbo() runs Turbo's root tasks. Core makes a root with a
  `vx.config` a project (D-39); on one, `//#task` keys map to that
  project from the root `package.json` scripts, and `//#x` in a
  package task's `dependsOn` is an edge to `<root name>#x` (it was a
  note and a dropped edge, so a build waiting on a root codegen ran
  first). Turbo runs no plain task in the root package, and neither
  does the mapper now. With no root project the note says how to make
  one. Rows (`turbo.test` › root tasks, and its control): red without
  the fix.
- **G-46.** nx() and a root project (D-39): a root with a `vx.config`
  already takes the Nx root project's targets by directory, now held by
  a row. Without one, an explicit edge to a root target
  (`{ projects: ["ws"], target: "prep" }`) refused the whole run as "no
  such project"; it is dropped with a todo naming the key it misses, as
  item 1051 dropped a `^target`. The unattached note names the fix for
  the root. The README's line on negated outputs, stale since G-44,
  is corrected. Rows (`nx.test` › a root vx.config attaches…): red
  without either half.
- **G-47.** `DOTENV_PROBE`, the `.env` probe turbo() and moon() key a
  gitignored `.env` by, lived as two copies (stream N's lead: N may not
  edit `turbo/`); a fix to one would have keyed the same files two
  ways. One module, `src/dotenv-probe.ts`, now holds it; the string is
  unchanged, so no key moves.
- **G-48.** A stale hit in G-45's root tasks, found on
  NotionX/react-notion-x@03c5e88 (`//#test:lint`, `oxlint` over the
  repo): a member file broken after a green run replayed green. Turbo
  hashes a root task over the whole repo; mapped as the root project's
  own `**/*`, core stopped the globs at every member (D-39). A root
  task's inputs and outputs are now `workspaceFiles`
  (connectrpc/connect-es's hand-written `!packages/**` rides along).
  The `//#x` todo with no root project and the `$TURBO_ROOT$` one no
  longer say vx has no root tasks. Row (`turbo.test` › a member edit
  re-keys it): red without the fix.
- **G-49.** The Turbo/Nx mapper-gap inventory (supervisor, 2026-09-28):
  `vx-migrate --dry` over 11 Turbo repos (trpc ec0b0a4, unocss f05ee3a,
  cal.com 54343aa, shadcn-ui 984f435, formbricks 817a656, dub 21c57ae,
  create-t3-turbo 8f945b7, trigger.dev 8fe554a, react-notion-x 03c5e88,
  connect-es 49773cd, next.js e32cb8e) and 3 Nx (typescript-eslint
  0bbe5e7, TanStack/router 41ebd28, nx-examples 3a884ec). No Turbo task
  key or Nx target field is dropped silently. The mapper's own gaps,
  ranked by repos × tasks: `dependentTasksOutputFiles` /
  `externalDependencies` todos that vx already covers (3 repos, 915
  tasks, noise); `//#` root tasks with no root `vx.config` (5 repos,
  opt-in by design, G-45); an Nx target glob in `dependsOn` (TanStack's
  `test:e2e--*`, 140 tasks, edges lost); `syncGenerators` (2 repos);
  `params: forward` (2); an unpropagated `^` configuration (1); and two
  silent top-level keys, Turbo `cacheMaxSize` (formbricks) and nx.json
  `parallel` (TanStack, nx-examples). Core's, not the mapper's: shared
  output paths (9 repos, 211 tasks), `parallelism: false`, env
  wildcards and framework inference, `outputLogs`, `interactive`, a
  wildcard-first output. The top edge loss is mapped here: a target
  glob (Nx's `*|{}()[`) expands over every target name in the
  workspace, as Nx's `expandWildcardTargetConfiguration` does, before
  the `project:`/`^` rules; a match another entry names literally is
  that entry's edge. Rows (`nx-helpers-sweep` › a target glob expands…,
  `nx.test` › a ^target no project has…): red without the expansion or
  its wiring. Also probed: the packed `@vzn/vx` + `@vzn/vx-migrate`
  tarballs install and run turbo() with all four bins linked; no
  offline row (core pulls sandbox-runtime from the registry).
- **G-50.** G-49's silent workspace keys: turbo.json `concurrency`
  (`"10"`, `"50%"`), `cacheMaxSize` (formbricks' `"10GB"`) and
  `cacheMaxAge` (weeks become days; `"0"` is off), top level or under
  `global`, and nx.json `parallel` (TanStack/router 5, nx-examples 1;
  or the legacy runner option) were read by nothing, so a repo's cache
  cap or serial run did not reach vx. turbo() and nx() now fill
  `concurrency` and `cacheRetention` through the `config` stage when
  `vx.workspace.ts` sets none. Rows (`workspace-keys.test`): red
  without the stage or the `global` read.
- **G-51.** G-49's noisiest todo: `{ dependentTasksOutputFiles }` sat
  on 881 tasks of three real Nx repos (TanStack/router, nx-examples,
  typescript-eslint). It names no gap: Nx hashes the outputs of the
  tasks this one depends on, and vx folds those tasks' keys (their
  inputs, transitively) through `dependsOn`, from which the outputs
  follow. It is now read as nothing. The turbo-nx-support contract
  calls it supported, and names #1802's target-glob expansion under
  `dependsOn`. Row (`nx-helpers-sweep` › fileset, input and each
  fold-through object form): exact todo list, red without the change.
- **G-52.** G-49's `//#` root tasks through the CLI: five of eleven real
  Turbo repos (react-notion-x, cal.com, connect-es, create-t3-turbo,
  next.js) declare root tasks, and with no root `vx.config` the 11
  tasks were a note and 36 edges to them were dropped. The live plugin
  can only name the fix (G-45); `bunx @vzn/vx-migrate` now makes it:
  when turbo.json has a `//#` task and no glob lists the root, the root
  package joins the mapping, its `vx.config.ts` is written (the opt-in
  core reads, D-39), and `//#x` edges reach it. The README's migrate
  list no longer names negated outputs (stale since G-44). Row
  (`migrate.test` › vx migrate (turbo): root tasks): red without it.
- **G-53.** Mutation sweep of G-49..G-52's code: twelve mutants, eight
  caught. Four guards had no row: turbo()'s `cacheRetention` the
  workspace already sets, a `concurrency` that is no positive whole
  number (`"abc"`, `"1.5"`), and the CLI's two root checks. Of those two,
  the directory check was dead: a root meta always carries the root
  `package.json` name, so the name check covers both a root already
  listed and a package that took the name. It went; rows hold the
  rest (`workspace-keys.test`, `migrate.test` › adds no second root).
- **G-54.** Turbo root tasks run with nothing written (E's lead, #1832):
  `"//#format": {}` over a root script made `vx run format --all` say
  "No projects declare task(s)", since core makes the root a project only
  with a `vx.config` there (D-39). Core gains D-62's `discover` stage
  (budget mode: the one active stream builds it): `discover(ctx)` returns
  `{ dir, name }[]`, run after core's discovery by every run and reading
  verb, refused at the boundary (outside the root, a taken name or
  directory, a `package.json` of another name, no such directory).
  `turbo()` names the root when turbo.json has a `//#` key and the root
  `package.json` a name no package holds. Rows: `discover-stage.test`,
  `turbo.test` › root tasks (red without the hook). `nx()` naming Nx
  graph roots (N-18) is next on this seam.
- **G-55.** `nx()` names unlisted Nx projects (N-18): an integrated Nx
  repo keeps `project.json` libraries out of the package manager's list
  (analogjs: 1 of 21 `build` tasks attached), and a root project needed
  a hand-written root `vx.config`. `nx()`'s `discover` hook names each
  graph node with targets at a directory core did not find, by its
  `package.json` name or else its Nx name; a taken name or a gone
  directory stays unattached with the note. The graph loads once per run
  for both stages; `DiscoverContext` gains `cacheDir` (the snapshot's
  home), and a nameless `package.json` takes the plugin's name. The
  snapshot key counts the last graph's roots and any `project.json`, so
  an edit under a named project re-exports. Rows (`nx.test` › a project
  no glob lists…, red without the hook; `discover-stage.test` › a
  nameless package.json…).
- **G-56.** A root `package.json` named like a member: the Nx mapper
  synthesized the root project under the member's name, and the root's
  tasks replaced the member's (planned nothing for `lint`; the migrate
  CLI would write two configs of one name). A synthesized project takes
  its manifest name only when no package holds it, else its Nx name.
  Row (`nx.test` › a root package named like a member…): red without it.
- **G-57.** Turbo's task `with` (sidecars Turbo runs beside a task,
  `web#dev` with `api#dev`) was a "no vx equivalent" todo, so running
  `web#dev` started no api. Each persistent sidecar is now a `dependsOn`
  edge: vx starts the task once the sidecar spawns and runs the sidecar
  only with it. A sidecar that ends is a todo (an edge would wait for
  it); a pair that names each other keeps one edge. Rows
  (`turbo-map-sweep` › `with`): red without the mapping or the pair
  guard. Contract row mapped.
- **G-58.** Probed `nx()` on analogjs (40cc8b4) after G-55: 22 `build`
  tasks plan, the 22 projects `nx show projects --with-target build`
  names (1 before). The same run carried the `externalDependencies`
  todo on 32 `eslint:lint` tasks for `eslint`, a root devDependency
  every task's key already holds (the whole lockfile, or a lockfile
  plugin's root dependencies). The mapper reads the root
  `package.json`; names it declares are silent, and a todo names only
  the rest. Rows (`nx-helpers-sweep` › externalDependencies the root
  declares; `nx.test` › …the root package.json declares is no todo):
  red without the check or the manifest read.
  Also probed on ngrx/platform (32c4c74, Nx 23.1.0), whose
  `pnpm-workspace.yaml` lists no packages at all: 15 `build` and 15
  `test` tasks plan, the sets `nx show projects --with-target` names,
  and every `build` task's edges equal Nx's task graph
  (`nx run-many -t build --graph`) once vx's key-only fileset twins
  are set aside: 0 mismatches of 15.
- **G-59.** `with` on a task with no script: Turbo's own with-tailwind
  example gives `ui` no `dev` script, and its `dev` exists to start
  `dev:styles` and `dev:components`; Turbo plans both, vx planned
  neither (G-57 mapped `with` only on a task with a command). Such a
  task is now a group task depending on its persistent sidecars, and a
  node other edges reach only when one of them persists (else an edge to
  it is dropped with a todo, not left dangling). Also probed: turbo()
  on create-t3-turbo plans the 11 `clean` tasks Turbo's own dry run
  does, `//#clean` as the root project's (G-54). Rows
  (`turbo-map-sweep` › `with`): red without the group or the emission
  check.
- **G-60.** Swept every example in Turborepo's own repo (vercel/turborepo
  `examples/*`): `turbo run <every root task> --dry=json` (2.5.8) against
  `vx run … --all --dry=json` under turbo(), task sets and edges. 27
  match exactly. Turbo's single-package mode (`non-monorepo`: no
  workspaces, plain tasks run on the root package) planned nothing
  under vx: the root held `//#` tasks only. A lone root project now
  takes turbo.json's plain tasks, as Turbo runs them; a monorepo root
  still holds `//#` only. Row (`turbo-map-sweep` › a single-package
  repo): red without it. Also found, for later items: `with-tailwind`'s
  script-less `ui#build` carries edges a dependant's `^build` reaches
  through Turbo's no-op node (vx drops them), and `with-changesets`'
  `test` has no script anywhere, which Turbo plans as nothing and vx
  refuses as "no projects declare task(s): test" (core's choice, E).
- **G-61.** Turbo's no-op node across packages: with-tailwind's `ui` has
  no `build` script, and its `build` depends on `build:styles` and
  `build:components`; Turbo builds both before `web#build`, vx built
  neither (`web`'s `^build` found no `ui#build`, and core's walk past a
  package without the task skips that package's own edges). A
  script-less node whose edges name a task of its own package or
  another, or a persistent `with` sidecar (G-59, now the same rule), is
  a group task holding all its edges, `^` ones included, so core's walk
  stops there without losing what lies beyond, when another package's
  `^name` or `pkg#name` reaches it (a sidecar group, always). One with
  only `^` edges, or one no other package reaches (vx's own
  examples/turbo: `lib` has no tests, and a migration wrote `lib#test`
  as a fourth task), stays none. Within its package a dependant still walks through it
  (item 939), so a group never waits on itself; one whose edges all
  drop is `dependsOn: []`, never a dangling edge. The examples sweep
  (G-60) matches on with-tailwind now. Rows (`turbo-map-sweep` ›
  `with`): five mutants, each caught.
- **G-62.** Turbo's transit node (its with-vitest example and documented
  pattern): `transit: { dependsOn: ["^transit"] }`, no script anywhere,
  and `test: { dependsOn: ["transit"] }`. Turbo hashes the no-op per
  package over its files, so a dependency's edit re-runs a dependant's
  `test`. vx dropped the edge, and `test` keyed on its own files alone:
  editing `ui` left `web#test`'s key unchanged, a stale hit (probed on
  the example: same key before and after). Such a node is now a
  key-only task in each package that defines it (`true`, cached, keyed
  on its inputs, with its `^` edge), as nx()'s `nx-input:*` twins are;
  the edit moves `web#test`'s key and leaves `math#test`'s. A `^self`
  task some package runs, or none depends on, is not one. Rows
  (`turbo.test` › a transit node, red without it; `turbo-map-sweep` › a
  transit node): three mutants, each caught.
- **G-63.** Plan parity on real Turbo repos, Turbo's own dry run at each
  repo's Turbo against vx's under turbo(), task sets and edges: dub
  (a99e7c3) 17 of 17, formbricks (abc8919) 120 of 120, trigger.dev (9d38ff5) 169 of 169,
  shadcn-ui (08ab84f) 35 of 35, all exact; connect-es (b299633) 79 of 79
  with vx's extra `peerDependencies` edges, which vx takes on purpose
  (a spare edge costs order, a missing one a stale hit). cal.com
  (54343aa) planned nothing: its shared `post-install` writes
  `../../node_modules/@prisma/client/**` from every package with the
  script, one workspace path, and core refused the run over the first
  pair. The mapping now keeps the first task on a workspace output path
  cached and runs the rest uncached with a todo; cal.com plans all of
  Turbo's 106 tasks. The class holds in nx() and moon() too (both emit
  workspace outputs), so both take the same pass. Rows
  (`turbo-map-sweep`, `nx-map-sweep`, `moon.test` › a workspace output
  two projects declare): each red without its line.
- **G-64.** A same-project target glob matched every target name in the
  workspace. TanStack/router (41ebd28) names `test:e2e--*` in
  `targetDefaults`, and a project without, say, `test:e2e--vite-ssr` got
  that name, which then split at the colon into project `test`: one
  dropped-edge todo per aggregator and mode (128–139 per mode). Such a
  glob now keeps only its own project's targets, as Nx does, and vx
  plans all 279 of Nx's `test:e2e` tasks. Row (`nx-helpers-sweep` › a
  target glob): red without the filter. More probes, recorded here:
  plan parity unocss 91/91, react-notion-x 40/40, vercel/ai 425/425,
  payload 235/235, all exact; n8n 893/894 (Turbo runs an opted-out
  build as a no-op's dependency; not replicated). vx-lockfile's
  per-project keys on real lockfiles: pnpm (dub: only `dub-cli#build`
  moved), npm (connect-es: only web-bench's two tasks), yarn berry
  (cal.com: 4 of 114 workspace digests). nx() cacheability against Nx's:
  ngrx 58 and analog 88 tasks, no diff. Lead: vercel/ai's 68 builds
  output `**/dist/**` and run uncached; caching them needs a core clean
  that skips tracked files and `node_modules`. (Stale by 2026-09-30:
  vercel/ai's turbo.json now names `dist/**`, `.next/**` minus
  `!.next/cache/**`, all literal-rooted and cached.)
- **G-65.** typescript-eslint (2369384, Nx 23.2): `vx run typecheck`
  was refused by core. The root project caches `{projectRoot}/dist`
  (the workspace's `dist`) and each package's typecheck
  `{workspaceRoot}/dist/packages/<name>`; G-63's pass compared
  workspace outputs only, so the nesting reached core. A project's own
  outputs now take part at their workspace path (own against own in one
  project stays `resolveSharedOutputs`', which reads the edges), and vx
  plans all 37 of Nx's typecheck tasks. `build` 18/18, `test` 47/47,
  `lint` 36/36 matched before the fix. Row (`nx-map-sweep` › a project's
  own output takes part at its workspace path): red without it.
- **G-66.** Committed files under a mapped output. A real
  `vx run build` on typescript-eslint (2369384) under nx() deleted the
  committed `packages/website/data/sponsors.json`: the website build
  caches `data`, Nx never cleans an output, vx cleans before a run. Its
  tests output `{projectRoot}/**/*.shot`, 3,656 committed snapshots in
  ast-spec alone, and nx() lacked turbo()'s wildcard-first rule (item
  1031), so a test run would have deleted them. The rule is now one
  helper both mappers call. turbo(), nx() and lage() take each
  committed file under an output back with `!` (A-44): kept by the
  clean, the save and the restore, and the task stays cached. The
  tracked list is one `git ls-files` on a mapping miss; the kept
  mapping is keyed on HEAD and its reflog's size (a stat). Past sixteen
  files the task runs uncached: 4,200 take-backs cost the warm run
  1.2 s; with the wildcard rule tse's warm `test --dry` is 1,222 ms
  against 1,272 without the pass, within noise. wireit() is left out:
  wireit cleans outputs itself. Rows (`turbo.test` › a committed file
  under an output, red with the pass off or its `!` dropped;
  `tracked-outputs.test`; `nx-map-sweep` › a wildcard-first output, red
  without the rule). Also recorded: angular-eslint (c7402dc) build 14,
  test 16, lint 11 and typecheck 23 tasks match Nx (nx:noop targets
  are group tasks, which a dry run does not list); its root
  `update-rule-configs` names `utils:build`, and no project is `utils`,
  so that todo is the repo's own dead edge.
- **G-67.** A real `vx run build --all` on TanStack/router under nx():
  every file-based router app regenerates its committed
  `src/routeTree.gen.ts` (same bytes) during its build, so core withholds
  the save each run (item 1015: a write during the command cannot be
  told from an edit reverted mid-run) and the task never caches. The
  status line named the file and not the way out; it now ends "if the
  task writes it, declare it in cache.outputs" (not for `package.json`,
  which an output may not cover). `caching.md` says so. Rows
  (`inputs-moved.test` › six named-file rows, red without it; the
  `package.json` row is the control). Also probed: typescript-eslint's
  real build (58 tasks, warm all cached in 2.0 s, tree clean) and lint
  (76 tasks; `cache: false` in Nx too); unocss's real build under
  turbo() with the repo's own `--filter='./packages-*/*'` (42 tasks,
  warm 41 cached in 1.3 s; `@unocss/vscode#build` rewrites its README
  input, the same class). `--all` there fails `playground` and a test
  fixture, which import unocss without declaring it, as Turbo would.
- **G-69.** langfuse (turbo.json `"cacheMaxSize": "7.5GB"`) did not load
  under turbo(): core takes a whole-number size and refused the
  workspace. Turbo's grammar (turborepo-cache `parse_human_size`,
  `parse_human_duration`) is 1024-based, truncates a fraction to bytes,
  and reads a bare size as bytes and a bare age as days; the mapper now
  restates each in core's (`7680MB`, `1000000B`, `30d`). langfuse then
  plans build 9, typecheck 10, test 9 and lint 9 as Turbo does. Row
  (`workspace-keys.test` › the cache bounds take Turbo's grammar): red
  without it.
- **G-68.** Turbo's `interruptible` (a persistent task `turbo watch` may
  restart) was an unknown key: "has no vx equivalent — map it manually".
  `vx watch` stops and re-spawns every persistent task each cycle, so
  either value maps to nothing; a non-boolean is refused as Turbo does.
  Row (`turbo.test` › interruptible maps to nothing): red without it.
  Also probed, plan parity against `turbo --dry=json` 2.10.13:
  documenso (build 5, start 5, test:e2e 3, clean 12) and mastra (build
  188, lint 167, validate:package, clean) exact; mastra's typecheck and
  dev miss the builds Turbo runs only as a no-op's `^build` (G-64's n8n
  class, not replicated).
- **G-71.** openstatus (turbo 2.11.2) lists `!NEXT_PUBLIC_VERCEL_URL`
  and three more exclusions in `build.env`, to keep Vercel's per-deploy
  vars out of the hash Turbo's framework inference would add. Each was
  a "wildcards are not supported" todo, six tasks times four. An
  exclusion removes names from what its list matched; vx matches no name
  it is not given, so it now removes the list's own matching names and
  says nothing. Rows (`turbo-map-sweep` › a `!` env entry removes the
  names it matches; › a global env wildcard is a note): red without it.
- **G-70.** rallly (turbo 2.6.3): `build: [^build, ^db:generate]` and
  only `database` has a `db:generate` script, so every other `build` is
  Turbo's no-op node. `web#build:test` → `^build` reaches them, and
  Turbo runs `database#db:generate` first; vx dropped it: G-61 made a
  no-op a group only for an edge to a named task, and core's walk past a
  package carries only the name it walks for. A `^` edge to another name
  now makes the node a group too, and rallly's `build:test`, `build` and
  `dev` plan as Turbo's. Re-checked unchanged: mastra, better-auth,
  midday, documenso, openstatus. Row (`turbo-map-sweep` › a no-script
  task whose ^ edge names another task is a group): red without it.
- **G-72.** Nx hands a task's configuration to every edge
  (`resolveConfiguration`): `nx run a:build:ci` runs `a:gen:ci` and
  `b:pack:ci` where those targets declare `ci`, else their default. The
  mapper's `build:ci` ran its own and named edges' default and said
  nothing; only `^` edges drew a todo, and that one fired even when no
  other project declares the configuration (Nx runs the default there
  too). Own, `project:target` and `{ target, projects }` edges now take
  the configuration; the `^` todo fires only where another project
  declares it. Rows (`nx-map-sweep` › a configuration reaches its
  edges): red without it.
- **G-73.** A `*` env name (`NEXT_PUBLIC_*`, in every Vercel template's
  `build.env`) was a todo under `turbo()`: the task neither keyed nor
  saw those variables. Turbo matches the name against the environment
  it runs in; `turbo()` maps where the tasks run, so it now does the
  same (`envNames`), for a task's `env` and `passThroughEnv` and the two
  globals, and a `!` entry still takes names back. The environment's
  names join the mapping cache's key, so a new variable maps afresh. The
  migrate CLI writes files for another environment and keeps the todo;
  `?`, `[…]` and `\` stay todos everywhere. Row (`turbo-map-sweep` › a
  `*` env name expands over the live environment): red without it.
- **G-74.** Turbo 2's framework inference (a package on `next` hashes
  and passes `NEXT_PUBLIC_*`; `vite`, `react-scripts`, `gatsby`, `astro`
  likewise) was a note under `turbo()` too: a Next build inlined empty
  public variables. With G-73's live env names the prefix now joins each
  such package's task env list, where the task's own `!` entries take
  names back, as Turbo applies them. The migrate CLI keeps the note.
  Row (`turbo-map-sweep` › a live mapping infers a framework env
  prefix): red without it; `lib` without the framework is the control.
