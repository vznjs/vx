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
