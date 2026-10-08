# Workstream D (workspace and config) — the record, one entry per merged PR

## Leads (review of 2026-09-27)

In order of harm. `--affected` under-selection is a re-keyed task a CI
run leaves out; the rest are refusals.

1. `--affected`: a `package.json` that makes an existing directory a
   project re-keys the project above it (its inputs stop at the new
   one) while containment maps the change to the new project alone.
   Repro: `a` with `**` inputs and `a/sub/data.txt`; add
   `a/sub/package.json` with a name; `--all --dry` says `a#build`
   misses, `--affected=HEAD~1` selects nothing that declares `build`.
2. `--affected`: an edited manifest whose `name` or `version` moved
   drops an edge at the base graph that today's graph cannot see. `app`
   declares `lib: ^1.0.0`; bump `lib` to 2.0.0 (or rename it `lib2`)
   and `app#build` re-keys (its upstream is gone) while `--affected`
   selects `lib` alone. The item-959 walk reads only DELETED manifests.
   Fix shape: build the package graph over the base manifests of the
   changed ones and select every project whose `directDeps` differ
   (subsumes the removed-package walk).
3. Schema: a NUL in `exec.command`, `cache.inputs.runtime` /
   `workspaceRuntime` loads, and fails at spawn as "exit 127 … not on
   this task's PATH" with the NUL printed as a space — item 999's
   class (env names), not yet applied to commands.

## Leads for other streams

- E: `--filter packages/b` (a path without `./`) is refused "no projects
  matched" with no hint; pnpm reads it as a name too, but
  `didYouMeanProject` (`src/cli/select.ts`) could name `./packages/b`.
- Exec: `armTimeout` › settle() lets a grandchild that traps the SIGTERM
  finish inside the grace failed once on macOS CI (#2405, true vs false
  at 133 ms) and passed on re-run: a timing-sensitive row.

- E: `vx init` on an Nx repo suggests `vx run <first targetDefaults key> --all`
  when `nx.json`'s `targetDefaults` names no `build` (`firstTask`,
  `src/cli/init.ts`): electron/forge got `vx run coverage:base --all`
  though its root has a `build` script, which Nx infers as a target.
- E: `vx lock --check` words a renamed or moved config as `"a"
(packages/a/vx.config.ts) is not in the lock` (`src/cli/lock.ts`,
  the `entry.configPath !== rel` branch) while the lock holds "a" under
  its old path; `--frozen`'s refusal names both paths since D-88.
- E: `--filter ./kit` run from `packages/` is read from the workspace
  root (as pnpm 12 does; Turbo 2.11 reads it from the cwd) and refused
  "Did you mean @sveltejs/kit?". When the cwd-relative reading would
  match, the hint could name the root-relative path (`./packages/kit`)
  for a Turbo user (`didYouMeanProject`, `src/cli/select.ts`).
- A: an unscoped run's early `lazyGitEnumeration(root).start()` holds
  the main thread ~6.5 ms synchronously (300-project bench workspace;
  the `workspace config` stage reads 15 ms unscoped against 2 ms
  scoped). NOT a lead: STATUS Next 21 measured the sync `git rev-parse`
  as an async spawn (REFUTED 2026-09-25): the block overlaps git's own
  run, which is the enumeration's wall anyway.
- F: `vx-reapi` `materialise-concurrency.test` "output files are fetched and
  written at once" read `peak` 4 against 5 once in a local gate
  (2026-10-02); 5 of 5 green alone. The peak depends on fetches
  overlapping, so a loaded box can finish one before the last starts.
- A: `cache.outputs.files: ['{dist,lib/esm}/**']` saves an empty
  artifact and a hit restores nothing — `scanUnion` (cache/inputs.ts)
  scans with `Bun.Glob`, whose scan skips a brace holding a slash.
- B: the sandbox's mount-glob expansion (`sandbox-runtime.ts`, scanSync)
  has the same shape; not probed.
- C/E: flaky rows seen here: `watch-loop` "a server that rewrites a file
  … (item 948)" (CI, PR 1125), `signal-handling` "every task process is
  gone" (local gate, twice in four gates), and `keep-alive` "a kill -9
  in a Ctrl-C's grace takes the child of a shell that died on the
  signal": under load vx exits within the row's 200 ms sleep, so its
  `kill(pid, 'SIGKILL')` throws ESRCH (local gate, once; 3/3 alone).
- L (resolved by PR 1421): `sandbox-runtime.unsafe.test.ts` "a SIGKILLed
  task's port bridge leaves no socket behind" was red on main after L-10
  (18bfb32) moved the socket into the task's own temp dir.
- F: `vx-reapi` "RST_STREAM(INTERNAL_ERROR) reads as INTERNAL and is
  retried" failed once in a local gate, green on re-run.
- A: `tests/git-subdir-workspace.test.ts` "a modified tracked file is
  pruned…" reads the host's global git config: under
  `core.checkStat=minimal` / `core.trustctime=false` (this container's)
  A-6 trusts no OID and the sibling control fails. Isolate it
  (`GIT_CONFIG_GLOBAL=/dev/null` in the fixture's git env).
- C/E: `output-memory.unsafe.test.ts` "stays flat while a never-ready
  task floods stdout (carriage-return only)" read `long - short` 140
  MiB against its 64 bound once in a gate with no other gate running
  (2026-09-28); green on the re-run.
- B: CI's `@vzn/vx-docs#build` died by SIGKILL (exit 137) after astro
  had finished, on two PRs in an hour (2026-09-28, runs 36375024471
  and 36380291678), the kill under strace's
  `ptrace(PTRACE_LISTEN,pid:61,sig:0): Input/output error`: the
  item-925 class reaching a task other than the output-memory floods.
- E: `watch-loop-members.test.ts` › "a root package.json's workspaces
  that add a glob watch the packages they name" failed once in a local
  gate (17 s, an `until` past its wait; 2026-09-28), 3/3 green alone on
  the same tree and 2/2 on main.
- N: core holds a workspace-root task since D-39 (a root `vx.config.*`
  makes the root a project; design
  `docs/design/root-project-2026-09-28.md`), so the Turbo and Nx mappers
  can emit Turbo's `//#task` and an Nx root project's targets instead of
  dropping them; the root is named by its `package.json` `name`, and a
  root task that reads members declares `cache.inputs.workspaceFiles`.

- E: a bare `vx run <task>` whose cwd project lacks the task says
  "No projects declare task(s): <task>" while other projects declare
  it. At the root this replaced, once a root config exists (D-39), the
  "not inside a project … Pass --all" hint. Name the cwd project and
  hint `--all`. And `vx run '//#build'` (Turbo's task spelling) says
  the same; `--filter //` works since D-46. With no root project,
  `--filter //` is hinted "Did you mean a?": say the root is no project.

- C: `dependsOn: ['//#lint']`, Turbo's spelling of a root task, refuses
  "no such project or task is declared" even when the root is a project
  (D-39). `--filter //` reads `//` as the root project since D-46; the
  graph could resolve `//#x` to it the same way.

- H: `npm-pack.unsafe.test.ts`'s turbo row installs from the registry;
  in a container whose TLS is signed by a local CA it hung to its 180 s
  timeout (`SELF_SIGNED_CERT_IN_CHAIN`, npm's debug log) because the task
  env dropped `NODE_EXTRA_CA_CERTS`. D-54 passes it through; CI never saw
  it (no local CA there).
- B: vx's isolated task env drops `NODE_EXTRA_CA_CERTS` (and
  `SSL_CERT_FILE`) by default, so any task that fetches over TLS behind a
  CA-signing proxy fails until each task passes it through. Worth a
  decision on whether CA trust belongs in the default env.

- C: a `vx.config` with an extension discovery does not read (`.cts`,
  `.cjs`, `.json`, `.jsx`, `.tsx`; probed) is ignored, and a run then
  says "No package declares a vx.config — run `vx init`", which reads
  wrong to someone who wrote one. Discovery cannot flag it without
  breaking its platform-uniform answer or adding stats on macOS (both
  measured paths, `findConfigFile`); `initHint` in `run.ts` could look for
  a misnamed file only on that failure path.

- A: out of file descriptors, the cache's SQLite open fails as a raw
  `vx: SQLiteError: unable to open database file` without the `ulimit -n`
  hint the rest of the run gives (probed at `ulimit -n` 12, 16 and 22 on
  a 20-project fixture); at 10 the run printed nothing at all.

- H: `sandbox-runtime.unsafe.test.ts` › "a SIGKILLed task's port bridge
  leaves no socket behind" failed once in the gate (2026-09-28): two
  `-<port>.sock` files while the task ran, one left after. Passed 3 of 3
  alone. Its `socks()` reads every `vx-task-<pid>-<tag>` directory under
  the shared root, other processes' included, so a concurrent task
  bridging the same port number counts; unproven which pid held the
  extra. Scoping the scan to `vx-task-${process.pid}-` would remove it.
  A second gate the same day failed `sandbox-bridge-socket.unsafe.test.ts`
  › "is removed when the task ends": SRT's own
  `/tmp/claude-http-*.sock` was gone ("the bridge process may have
  died"); 2 of 2 alone. Both are sockets under the shared `/tmp`, under
  the gate's parallel load; what removed the second is unproven. A third
  gate (D-68's) failed `output-memory.unsafe.test.ts` › "stays flat while
  a never-ready task floods stdout (no line break)": the long run's
  growth over the short one was 189 MiB against a bound of 64; 5 of 5
  alone.

- E: a config's `console.log` on its first load (in process) lands in
  stdout ahead of `vx show --format json` (probed), so the JSON does not
  parse; `vx mcp` redirects around its own serving (item 922) and D-64
  covers repeat loads. A verb that promises machine output could
  redirect stdout the same way while it loads the workspace; a global
  redirect inside the loader would also catch vx's own writes made
  meanwhile, so the verb is the place.

- E: a config that leaves a handle open (`setInterval(() => {}, 1000)`
  at top level, a client's socket) keeps `vx run` alive after it has
  printed its result: the run succeeded and the process never exited
  (probed, killed at 15 s). `bin.ts` lets the loop drain on purpose, so
  a pipe is not cut; once the verdict is set and stdout and stderr have
  drained, an exit would end it. D-66's refused first load holds open
  the same way when its config's timer is alive.
- E: pnpm's own `vx run` flags are refused with no word on vx's spelling:
  `--filter-prod`, `--test-pattern`, `--changed-files-ignore-pattern`,
  `-w` / `--workspace-root` all read `unknown flag` (`src/cli/foreign-flags.ts`
  holds Turbo's and Nx's only), though vx's `--filter` is pnpm's DSL.
- orchestrator: a project config written as `vx.config.json` (or `.yaml`,
  `.tsx`, `vxconfig.ts`, `.vx.config.ts`) is not read, and a run says only
  "no projects declare task(s): build" (probed with `--all`).
  `initHint` (`src/orchestrator/run.ts`) runs on that error path only;
  with no project config it could name a member's `vx.config.<other>`
  and the names vx reads.
- cache: a member a workspace glob reaches outside the root
  (`../shared/*`) that sits outside every git work tree fails each task
  with "vx requires git: <dir> is not inside a git work tree. Run 'git
  init' in your workspace root" although the root is a repo (probed); the
  hint could name the member's directory. Inside the root's repo such a
  member plans, runs and caches.
- util: `PERMISSION_HINT` (`src/util/errors.ts`) reads "a path vx must
  write is not writable by this user" for every EACCES / EPERM that
  reaches `bin.ts`, a refused READ included. D-132 / D-133 name the
  workspace's reads as reads; any other read path still gets the write
  wording.
- B: the runner's exit-127 hint ("install it in this package or at the
  workspace root") is wrong under Yarn Plug'n'Play, where the package IS
  installed into `.pnp.cjs` and no `node_modules/.bin` exists (probed on
  Yarn 4.5: `json5 --version` ran under `yarn run`, exit 127 under vx).
  `vx init` names PnP since D-108; the hint could too.

## Entries

- **D-1** `--affected` selects the project a new nested project took
  files from (lead 1). `parentsOfNewNested` in `affected.ts`: a changed
  manifest of a project with a project above it is read at the base;
  absent or nameless there, the parent is selected. Row: `tests/affected.test.ts`
  "a new nested project selects the project it took files from (D-1)",
  red without the fix. Docs: `cli.md` § `--affected`, `modules/affected.md`.
- **D-2** Discovery scans a `workspaces` brace holding a slash
  (`packages/{a,nested/b}`) as its expansions; `Bun.Glob`'s scan found
  none of its members. Row: `tests/workspace.test.ts` "a brace whose
  alternatives hold a slash lists every member (D-2)".
- **D-3** `--affected` selects a dependent whose edge a manifest edit
  dropped (lead 2): the package graph is rebuilt over the changed
  manifests as the base had them (one `git cat-file --batch`, shared
  with D-1's check) and every project whose `directDeps` differ is
  selected; replaces the removed-package walk. Row: `tests/affected.test.ts`
  "a manifest edit that drops an edge selects the dependent (D-3)".
- **D-4** Schema refusals for entries that loaded and did nothing:
  `sandbox.ignore` takes only `read`, `write`, `systemInfo`, `network` (the
  classes a denial is reported in; `machLookup`, `unixSockets`,
  `localBinding` and the flags silenced nothing — H's lead), and a NUL in
  `exec.command` / `cache.inputs.runtime` / `workspaceRuntime` is refused at
  load (lead 3; it failed at spawn as "exit 127 … not on PATH"). New type
  `SandboxIgnore`; H's contract record regenerated. Rows:
  `tests/config-schema-refusals.test.ts`.
- **D-5** The config worker awaits a Promise default export, as the
  in-process first load's async return already did: an async config
  loaded on a run and was refused as "an instance of Promise" on every
  later evaluation in the process (a `vx watch` cycle). Row:
  `tests/config-eval.test.ts` "reads a Promise default export the same on
  the first and the repeat load (D-5)".
- **D-6** A workspace config's awaited default export is checked as a
  project config's is: `Promise.resolve(null)` crashed the validator with
  a TypeError stack, `Promise.resolve(42)` loaded as no config. Row:
  `tests/config-eval.test.ts` "refuses a workspace Promise default of no
  object, as a project one is (D-6)".
- **D-7** The workspace fingerprint folds root `.npmrc` and `bunfig.toml`
  (A's lead): bun's `linker = "isolated"` moved `node_modules` under a
  byte-identical `bun.lock`, so a build relying on a hoisted undeclared
  package kept its hit. Row: `tests/fingerprint.test.ts` "an install
  setting that leaves the lockfile byte-identical moves the digest (D-7)".
- **D-8** `MigrationPlan.notes` named "implicit Nx deps" as its example,
  a note G-7 removed; it names the Turbo mapper's, the one source that
  still writes it (coordinator's lead).
- **D-9** Mutation sweep of `fingerprint.ts` (14 mutants: all caught or
  equivalent) and of D-1/D-3's code in `affected.ts` (13). One behaviour
  survivor: no row read two manifests in one `git cat-file --batch`, so
  an offset slip between blobs (the bump read as absent at the base, the
  edge never dropping) survived. Row: the D-3 row's two-manifest case.
- **D-10** Discovery's Linux config lookup ranks a directory's entries
  into precedence slots instead of building a Map per directory, and
  joins paths by concatenation: `listProjects` at 5,000 projects 53.5 →
  47.7 ms (min of 15 per arm, six interleaved rounds; A/A 54.7). The
  `Bun.file` manifest read stays: `load-reads.test.ts` counts reads
  through it.
- **D-11** Row: a moved project root (`git mv packages/lib
packages/core`) selects the dependent whose `file:../lib` spec named
  it; the edge drops with the dependent's manifest unchanged, so only the
  base graph sees it (red with D-3's comparison removed). Probes that
  confirmed the rest of the backlog, no fix owed: `workspace:` / `link:`
  / `catalog:` specs and glob negations (rows exist), and lazy `byDir` in
  `buildPackageGraph` bought nothing (14.3 vs 14.0 ms, A/A 14.1).
- **D-12** `vx init` made a group over a script that becomes no task:
  `setup: npm run prepare` (a lifecycle script) or
  `clean: npm run prebuild` (a hook folded into `build`) became
  `dependsOn` on a task it never emitted, and the `vx run` it suggested
  refused the config. Such a script keeps its command. Row:
  `tests/init.test.ts` "a delegation that cannot become a group stays
  the command it was".
- **D-13** Mutation sweep of `config-imports.ts` (38 mutants). Two
  behaviour survivors, now rows: dropping the relative-specifier skip in
  `unprovidedBareImports` refused a config's `./helper.mjs` as a missing
  package when no `node_modules` sat above
  (`tests/config-missing-import.test.ts` "a RELATIVE specifier resolves
  by path…"), and dropping the `index` candidates of an unresolved
  extensionless import lost the importer of a deleted directory
  (`tests/affected.test.ts` "…a deleted directory index…"). Equivalent
  or cost-only: the textual prefilter, both early returns, the `skip`
  filter, the start of `ownerOf`, the workspace and `node_modules`
  bounds.
- **D-14** Mutation sweep of `package-graph.ts` (43 mutants). One
  behaviour survivor: `workspace:~` had no row, and without its fast
  path it reads as an alias named `~` and the edge drops. Row: the
  "`*`, `workspace:^` and `workspace:~` take any version…" case in
  `tests/package-graph.test.ts`. Equivalent or cost-only: the
  `workspace:*` fast path, both memos, the bitset path (the DFS
  fallback answers the same), the peer and dependents sorts, a
  `path.resolve` over already-resolved dirs, a non-string spec. A
  mutant that drops the DFS `seen` check hangs on a cycle (caught by
  the run never ending).
- **D-15** Mutation sweep of `filter.ts` (28 mutants). One behaviour
  survivor: no row held a name filter's regex characters literal, so
  dropping the escape (`socket.io` then selects `socketxio`) passed.
  Row: `tests/filter.test.ts` "a name's regex characters are literal…".
  Equivalent: the path glob's trailing-slash strip (`path.relative`
  never ends in one), the literal-then-glob order, and an empty walk
  reported for a pattern that also matched nothing.
- **D-16** `vx init` wrote a task cycle for a `build` that delegates to
  a script that waits for `build` by convention:
  `build: npm run typecheck` made `typecheck` wait for `build`, and the
  run refused `a#build -> a#typecheck -> a#build`. The worker and every
  group on the way drop `build`. Found by a mutation sweep of
  `migrate-scripts.ts` (33 mutants), which also left the walk's cycle
  guard unheld: mutual groups hung `vx init`. Row: `tests/init.test.ts`
  "the task a delegating `build` reaches never waits for `build`
  (D-16)". Equivalent: the first-dependency pick (a `build` group has
  one), the `build` exclusion and both dedups (each masks the others),
  the empty project and empty script guards.
- **D-17** Mutation sweep of `config-eval.ts` (28 mutants). Two
  behaviour survivors, now rows in `tests/config-eval.test.ts`: the
  worker's `error` handler (a config whose microtask throws was refused
  at once, naming the throw; unheard, it waited out the budget), and
  the timeout's worker retirement inside a held round (a busy-looping
  config would have timed out every later config in the round).
  Equivalent: a `null` default read as an object, the id and pending
  guards, a round ended twice, `messageerror` (the worker posts only
  plain data), and the budget's digit guard (Bun clamps a negative
  delay to 1 ms, and the reply won that race).
- **D-18** Mutation sweep of `project-loader.ts` (32 mutants). One
  behaviour survivor: nothing held the unprovided-import refusal on a
  REPEAT load, which evaluates in the config worker, a second door to
  Bun's registry auto-install (`vx watch`, `vx lock`). Row:
  `tests/config-missing-import.test.ts` "a REPEAT load is refused too,
  before the worker evaluates it (D-18)". Equivalent: the stale-import
  check's `Math.floor` (sub-millisecond) and moving its baseline on
  each load (a refused load never moves it).
- **D-19** Mutation sweep of `workspace.ts` (35 mutants). Seven
  behaviour survivors, now rows in `tests/workspace.test.ts`: a literal
  negation's `/` boundary (`!packages/a` kept `packages/ab`), the dot
  and `node_modules` skips under `packages/*`, the nested and root
  `node_modules` skips under a deep glob (pnpm installs where
  `packages/**` looks), the unreached hint's `node_modules` skip (a
  single-package repo's dependencies named as members it left out) and
  its "and N more". Equivalent: the `.` member in `claimsMember` (a
  member is below the root), the negation's trailing-slash strip (the
  member strip ran first), the wildcard negation (the manifest match
  covers it), `.` in `memberBaseDirs`, symlink following under `**`
  (the `node_modules` skips bound it). `show-info.test.ts` failed under
  every mutant, equivalent ones included, and was dropped from the set:
  its alias row compares two runs over the mutated tree.
- **D-20** Mutation sweep of `config-cache.ts` (35 mutants). Three
  behaviour survivors, now rows: `execArgv` in the transpile inputs (a
  `--define` on Bun's command line, which the bunfig row does not
  reach; flipping it would have replayed the old evaluation,
  `tests/config-staleness.test.ts`), and in the `vx watch` import list
  the plain-scan fallback for a config the lexer refuses (a division)
  and the `node_modules` skip (`tests/config-cache.test.ts`).
  Equivalent: the namespace-import refusal (the default-import check
  covers it), the blob header in `blobOidOf` (its identities meet no
  store's), and `BUN_OPTIONS` (Bun 1.4.2 puts it in `execArgv`).
- **D-21** A migration TODO holding a line break ended its `//`
  comment in the written config, and the rest was code the next run
  evaluated: the file failed to parse, or ran what the text said. A
  reason can quote a manifest's own text (the Nx mapper's `env.${k}`
  names the key). Each line, ` ` and ` ` included, stays
  inside the comment. Row: `tests/migration.test.ts` "a TODO holding a
  line break stays a comment in the written config (D-21)".
- **D-23** `--affected`'s config-import walk awaited one config read at
  a time and scanned every config: at 5,000 configs a one-file change
  cost `affectedProjects` 433 ms, 200 of them serial reads. Each level
  of the walk is now read together, and a config with no quoted `./`,
  `../` or escape skips the scan: 140 ms (min of 10, three interleaved
  rounds; A/A 433–445). Row: `tests/affected.test.ts` "a specifier
  spelled with an escape still reaches its importer (D-23)", red with
  the textual pass narrowed to a literal `./`.
- **D-22** Mutation sweep of `migration.ts` (30 mutants). Three
  behaviour survivors, now rows in `tests/migration.test.ts`: the
  same-name guard on `--force` replacement (without it the config just
  written was unlinked), and a plan's import lines and raw expressions
  (the mappers' `nxExec` calls) rendered as code.
  The helpers of `config-schema.ts` (34 mutants) held: every mutant that
  applied was caught; item 653's sweep had already pinned them. So did
  `lockfile.ts` (15, all caught) and the rest of `affected.ts` (23: three
  equivalent — the unreadable-root sentinel, the no-positive guard of
  `workspaceGlobsMatch`, the non-blob branch of the batch read).
- **D-24** `--affected` realpath'd every project dir twice, in the
  containment pass and in the config-import walk. It asks once, in
  `affectedProjects`, and hands the answers to both
  (`ConfigImportOwnersArgs.realDirs`): at 5,000 projects a one-file
  change 157 → 141 ms (min of 10, three interleaved rounds; A/A
  154–160). Rows: the containment and import-closure rows of
  `tests/affected.test.ts`, the moved-root and linked-member ones among
  them. The `json-data.ts` sweep (19 mutants) held: its one survivor,
  reporting only the first finding, is what every caller reads.
- **D-25** A config calling `prompt()`, `confirm()` or `alert()` was
  cached as pure: Bun implements all three and they read the user's
  terminal, so the evaluation cache replayed the first answer on every
  later run. The three words join the purity deny-list; an entry cached
  before this evaluates live now (its key is no longer computed), so no
  `CACHE_VERSION` bump. Rows: `tests/config-cache.test.ts` "refuses to
  cache a config that mentions prompt('mode?')" and its two siblings,
  red before the fix. Probes that found no defect: a UTF-8 BOM in
  `package.json` and `pnpm-workspace.yaml` loads; one package reached
  twice (directly and through a link under a second glob) is refused as
  a duplicate, as npm does (bun accepts it).
- **D-26** A config importing through a tsconfig `paths` or `baseUrl`
  alias was refused as `cannot find` with no node_modules to provide it,
  though Bun resolves the alias from the nearest `tsconfig.json` and
  loads the file with no network. The guard now asks that tsconfig
  (relative `extends` followed) and lets a specifier through only when
  its target exists; one that maps nowhere is still refused. Rows: the
  two D-26 rows of `tests/config-missing-import.test.ts`.
- **D-27** `--affected` missed a project whose config imports a file
  through a tsconfig `paths` alias: the import walk read only relative
  specifiers, so editing or deleting the aliased file selected nothing
  while the task re-keyed. The walk now follows a bare specifier the
  nearest tsconfig maps, and scans for one only when the config quotes
  such a specifier. At 5,000 projects a one-file change: configs
  importing only `@vzn/vx` 136–140 → 140–144 ms (noise); every config
  importing a package under its own tsconfig 138–145 → 200–204 ms.
  Row: the D-27 row of `tests/affected.test.ts`.
- **D-28** A config importing through its package.json `imports` field
  (`import { cmd } from '#tasks'`) was refused as `cannot find` with no
  node_modules to provide it. Bun maps a `#` name inside the package and
  never asks the registry for one (strace: no connect, against 30 for
  an unknown package name), so the guard no longer lists it. Row: the
  D-28 row of `tests/config-missing-import.test.ts`.
- **D-29** A config importing its own package by name
  (`import { preset } from '@acme/self/tasks'`, the nearest
  `package.json` naming `@acme/self` with `exports`) was refused as
  `cannot find`. Bun resolves a self-reference inside the package and,
  strace shows, never reaches the registry for one, an unexported
  subpath included; the guard lets it through. Rows: the two D-29 rows
  of `tests/config-missing-import.test.ts`.
- **D-30** D-26's guard followed an array `extends` (TS 5's form), and
  Bun follows none: an alias only the array mapped was let through and
  Bun went to the registry (strace: 30 connects). The guard follows a
  string `extends` only. A sweep of the D-26 to D-29 code (32 mutants)
  found nine more rules unheld, each probed against Bun and now held:
  `paths` against `baseUrl`, inherited `paths` against the child's
  `baseUrl` (Bun misses), a key's head, tail and overlap, a
  `jsconfig.json`, a directory target with no index (Bun downloads), and
  the realpath of a target reached through a symlinked directory. Four
  survivors are equivalent: the per-file tsconfig memo, a package
  `extends` read as a path (no such file), the alias pre-filter (it
  gates only the scan), and the extra candidates of a deleted target
  that carries an extension. Rows: the D-30 rows of
  `tests/config-missing-import.test.ts` and `tests/affected.test.ts`.
- **D-31** `vx init` folded `prebuild` / `postbuild` into `build`'s
  command in a Yarn 2+ workspace, which runs no such hooks (probed with
  Yarn 4.5.0: `yarn run build` printed BUILD alone; npm, pnpm 10, bun and
  yarn 1 printed PRE BUILD POST): the migrated task ran scripts the
  user's `yarn build` never did, and the hook is usually `rm -rf dist`.
  Under the nearest `packageManager: yarn@2+`, or a Berry `yarn.lock`,
  each hook is a task of its own. Row: the D-31 row of
  `tests/init.test.ts`.
- **D-32** `vx init` read `pnpm docs`, `pnpm version`, `bun deploy`,
  `yarn check` and a dozen more as delegations to the script of that
  name, and made a group over a script the manager never runs: pnpm
  hands npm's own commands to npm whatever the scripts say, Bun
  reserves names, Yarn 1 has verbs Yarn 4 dropped. The tables now come
  from each manager's own list (pnpm 10.33.0's `commandNames` and npm
  pass-through, `bun --help` and its reserved names, `yarn help` of
  1.22.22 and 4.5.0), and `bun lint`, which runs the script, left Bun's.
  Rows: the D-32 rows of the `delegatedScript` table in
  `tests/init.test.ts`. Probe rule learned: a sweep over a manager's
  verbs ran `publish`, `login` and `upgrade` in a scratch package; none
  landed (no credentials; the registry's `own` package unchanged since
  2022; Bun still 1.4.2), and such verbs are listed from source now,
  never run.
- **D-33** D-31's class, two more managers: npm under
  `ignore-scripts=true` in the project `.npmrc`, and pnpm under
  `enable-pre-post-scripts=false` or `enablePrePostScripts: false` in
  `pnpm-workspace.yaml`, run no `pre` / `post` hooks (probed: BUILD
  alone, also from a member with the setting at the root), and
  `vx init` folded them in. The manager is the nearest `packageManager`
  or lockfile and its settings are read beside it; pnpm's
  `ignore-scripts` and Bun's lockfile under any `.npmrc` still fold, as
  they run the hooks. Row: the D-33 row of `tests/init.test.ts`.
- **D-34** A migrated script reading `$npm_package_version` (or the
  name, or `$npm_lifecycle_event`) printed an empty string: npm, pnpm,
  bun and yarn all set them for a script (probed) and vx sets none.
  `vx init` now defines the three under `exec.env.define`, the name and
  version from `import pkg from './package.json'` so a bump reaches the
  task (probed: 2.3.4, then 2.4.0), the event as the script's name; a
  folded hook's own event and any other `$npm_*` get a TODO. Row: the
  D-34 row of `tests/init.test.ts`.
- **D-35** Mutation sweep of the D-31 to D-34 code in
  `migrate-scripts.ts` (24 mutants). Five rules were unheld and are
  held now: `packageManager: yarn@1.x` still folds; `npm@<version>` is
  npm and reads its `.npmrc`; a commented-out `.npmrc` line is no
  setting; the nearest lockfile decides (a Bun one under a Berry root
  folds); a `$npm_*` read twice is one TODO. Two survivors are
  equivalent: the memo, and `yarn@[2-9]` for a Yarn 10 that does not
  exist. Rows: the two D-35 rows of `tests/init.test.ts`.
- **D-36** A CommonJS `vx.config.js` reaching `require` as
  `arguments[1]` never spelled a denied word, so it was cached as pure:
  one reading a file outside its closure
  (`arguments[1]('fs').readFileSync(…)`) printed `one` after the file
  said `two`. `arguments` joins the deny-list. `module` does not:
  `module.require` spells `require` and was refused already (the row's
  control). Rows: the D-36 rows of `tests/config-cache.test.ts`.
- **D-37** A Turbo task's `outputs: [...]`, `inputs`, `env` or
  `persistent: true`, or an Nx `command` on the task, was refused as an
  unknown field that named neither the field vx means nor where it lives;
  `cache: false` and `persistent: true` were refused as "must be an
  object" with no shape. Each now names vx's spelling
  (`vx spells it cache.outputs.files`) or the shape to write. A typo
  still gets the nearest spelling. Row: the D-37 row of
  `tests/config-schema-refusals.test.ts`. Probes with no defect: a
  relative text import of a file outside the workspace is in the key's
  closure and seen changing, a backdated mtime included; the other
  refusals of the probe set already named field and fix.
- **D-38** D-37 at the top of `vx.workspace`: Turbo's `pipeline`,
  `tasks`, `globalEnv`, `globalDependencies` and `remoteCache`, and
  Nx's `targetDefaults`, `namedInputs`, `parallel` and
  `cacheDirectory`, were refused as unknown fields with no word of
  where vx keeps each (per-package `tasks`, `cache.inputs.env`, a cache
  plugin, `concurrency`, `cacheDir`). The refusal names it. Row: the
  D-38 row of `tests/config-schema-refusals.test.ts`.
- **D-39** Workspace-root tasks (supervisor: Turbo's `//#task` and
  Nx's root project): a `vx.config` at a root the package globs do not
  list was ignored, so `a#test` depending on `root#build` refused with
  "no such project" and both adoption paths dropped their root tasks. The root
  package is now a project when it holds a config; boundaries, the key
  and `--affected` are the existing root-member rules (design:
  `docs/design/root-project-2026-09-28.md`; a root `tsc -b` that reads
  members declares `cache.inputs.workspaceFiles` or runs uncached).
  Rows: `tests/root-project.test.ts` (discovery, the edge, a member
  edit leaving the root's key and a root file moving it, `--affected`),
  all four red before. A claim the draft made and a probe refuted:
  npm accepts `.` in `workspaces` (it links the root into its own
  `node_modules`); `!.` normalizes to an empty negative and excludes
  nothing, so the draft's promise for it was cut.
- **D-41** `--affected` left a member out when a helper two hops from
  its config changed, in any workspace whose root is a project: the
  root owns every file no member owns, and the config-import walk
  stopped at the first root-owned file, a limit a row pinned as
  deliberate. D-39 made that shape every root with a `vx.config`, so the
  walk now descends through the root project's own files as through
  unowned ones (the same shared tooling); a member's files still stop
  it. Row: `tests/affected.test.ts` › "selects the importer two hops
  out, through files the root owns (D-41)", the old limit row flipped.
- **D-40** `vx init` left a watcher a plain task (stream N, on
  docusaurus: `build:watch` is `tsc --build --watch`), so a dependent
  waited on a script that never exits. A `watch` segment in the name, a
  `--watch` flag, `tsc -w` / `rollup -w` or nodemon now makes it
  persistent. A bare `-w` is not read (npm's workspace flag), nor
  `--watchman`. Row: the D-40 row of `tests/init.test.ts`.
- **D-42** Mutation sweep of D-39 to D-41 (13 mutants: the watcher
  rules, the root-config gate, the root-owned descent): all caught.
  Probes with no defect: Turbo 2.8.17 refuses two packages of one name
  as vx does ("Failed to add workspace … it already exists"), so N's
  duplicate-name lead needs no change for the runners vx adopts; a root
  project locks (`configPath: vx.config.ts`), runs `--frozen` and passes
  `vx lock --check`; `vx watch` on a root task ran it once in 11 s with
  no cycle from its own `.vx` or output writes.
- **D-43** A path filter read every path as "at or under" its
  directory, so with a root project (D-39) `--filter .` selected every
  project, and `./packages/app` took the examples nested in it. Turbo
  2.8.17 and pnpm 10 (probed) read a path naming a package's directory
  as that package alone: `--filter .` runs the root task only. vx now
  does; a directory that is no package keeps the "at or under" reading
  (Turbo selects nothing there, and vx refuses an empty selection).
  Rows: the two D-43 rows of `tests/filter.test.ts`.
- **D-44** A selector narrowed by a git range (`@scope/*[HEAD]`,
  `{./apps/*}[main]`) was read as one name glob and refused "no
  projects matched". Turbo 2.8.17 (probed) and pnpm read it as the
  selected packages that changed since the ref, and vx now does, the
  `...` / `^` expansions after it. An unbraced `./` path keeps its
  brackets as a glob class (Turbo takes a directory with a ref only as
  `{dir}[ref]`). Parity probe with no other gap: ten name, scope, path
  and `...` / `^` forms and the bare `[ref]` forms select what Turbo
  selects. Rows: the D-44 rows of `tests/filter.test.ts`.
- **D-45** D-39 made a root with a hand-written `vx.config` a project, so
  `vx init --force` replaced that config with the root's scripts: a
  `build: npm run build --workspaces` became a root task (with `^build`)
  that ran every member's build again under `--all`. `vx init` no longer
  maps the workspace root when it has members (their dirs under its
  own), and says so; a single-package repo's root still maps. Parity
  probes against Turbo 2.8.17 with no gap: seven negation, expansion and
  multi-filter combinations, `--affected` with dependents, a root-level
  file no package owns (neither selects), and package-graph edges over
  dev, peer and optional dependencies. Row: the D-45 row of
  `tests/init.test.ts`.
- **D-46** `--filter //`, Turbo's name for the root package (`//`,
  `!//`, `//...`, `...//`, `//[HEAD]`, probed on 2.8.17), matched as a
  name and refused "no projects matched … Did you mean a?". It now
  selects the root project, and nothing when the root is no project
  (read as `.` it would select every project there). Row: the D-46 row
  of `tests/filter.test.ts`.
- **D-47** Mutation sweep of D-43, D-44 and D-46 in `filter.ts` (12
  mutants). Three survived, all in D-44's selector and range split:
  the `./` guard (the control path did not end in `]`), the `.` guard
  (`.[HEAD]` is a name, as Turbo 2.8.17 reads it) and the greedy
  selector group (`{./libs/[c]*}[HEAD]` takes the last bracket as the
  ref, as Turbo does). A row now holds each. Also probed without a gap:
  a root config importing a member's file re-evaluates on its edit, and
  `--affected` gives that edit to both projects; an Nx root project named
  apart from its package attaches its targets through `nx()`.
- **D-48** Mutation sweep of D-45's root detection in
  `migrate-scripts.ts` (7 mutants). One survived: `every` read as
  `some`, which took a member holding a nested member, beside a member
  outside it, for the workspace root and left it unmapped. The D-45 row
  now holds that case.
- **D-49** Keys pasted from project.json, nx.json and turbo.json were
  refused as unknown fields that named no vx home: a target's
  `executor`, `options` and `continuous`, Turbo's task `outputLogs`, and
  the top-level `defaultBase`, `tasksRunnerOptions` and
  `globalPassThroughEnv`. Each now ends `— vx spells it …`. A string in
  `plugins` (Nx lists plugins by module name) adds that a vx plugin is
  what its package's function returns. Rows: the D-49 rows of
  `tests/config-schema-refusals.test.ts`.
- **D-50** A Turbo or Nx glob token pasted into a vx glob list
  (`$TURBO_DEFAULT$`, `$TURBO_ROOT$`, `{projectRoot}`, `{workspaceRoot}`)
  was taken as a literal that matched no file. `inputs.files:
['$TURBO_DEFAULT$']` keyed the task on nothing, and after a source
  edit the run said up-to-date and kept the old output (probed); a
  first-run warning was the only sign. Each token is now refused in
  inputs, outputs and `workspaceFiles`, naming what to write. Row: the
  D-50 row of `tests/config-schema-refusals.test.ts`.
- **D-51** Nx's upstream named input (`^production`) pasted into a glob
  list matched no file and only warned, keying the task on nothing. A
  glob starting with `^` is now refused, pointing at `dependsOn`. A bare
  named input (`default`) stays a path: it can be a directory. Row: the
  D-51 row of `tests/config-schema-refusals.test.ts`.
- **D-52** Nx's `{options.outputPath}` as an output matched no file: the
  miss saved an empty artifact and a later hit restored no build (probed;
  inputs already refused it as a one-alternative brace). D-50's token
  list now holds `{options.…}` and `{projectName}`. Row: the D-52 row of
  `tests/config-schema-refusals.test.ts`.
- **D-54** The local gate failed `npm-pack.unsafe`'s turbo row twice in
  this container: `npm install` of the packed tarballs retried
  `SELF_SIGNED_CERT_IN_CHAIN` to the 180 s timeout on a cold npm cache,
  because the unsafe task's env dropped `NODE_EXTRA_CA_CERTS`
  (differential under a temp HOME: without it the row hung, with it it
  passed in 4.5 s; proxy variables refuted, `NO_PROXY` holds the
  registry). `test.bun.unsafe` now passes it through.
- **D-53** Turbo's env exclusion `!SECRET` in `cache.inputs.env`,
  `exec.env.passThrough` or `exec.env.secret` loaded clean (probed): vx
  has no env wildcards, so it was a variable named `!SECRET` and nothing
  was excluded. A leading `!` is now refused in all three lists, the way
  their wildcards are. Row: the D-53 row of
  `tests/config-schema-refusals.test.ts`.
- **D-55** Mutation sweep of D-49 to D-53 in `config-schema.ts` (24
  mutants: each foreign key, each glob token, the `^` form and its `!`
  strip, the `{options.…}` display, the three env-negation sites and the
  plugin-string message): all caught.
- **D-56** Keys pasted from a package's turbo.json or an Nx project.json
  into a project's vx.config were refused naming no home, and `tags`
  was hinted as a typo of `tasks`. `targets`, `extends`,
  `implicitDependencies`, `name` and `tags` now end `— vx spells it …`.
  Row: the D-56 row of `tests/config-schema-refusals.test.ts`.
- **D-57** Mutation sweep of every refusal guard in `config-schema.ts`
  (72 mutants: each `if` in front of a `throw new UserError`, turned
  off): all caught, the plugin `backend` refusal by
  `tests/project-loader.test.ts`.
- **D-58** Guard sweep of the rest of `src/workspace/` (20 mutants, each
  `if` before a `throw new UserError` turned off, against the 37 test
  files that import these modules): 19 caught, `filter.ts`'s empty
  selector by `tests/cli.test.ts`. `loadWorkspace`'s refusal of a root
  with neither manifest survived: the CLI never reaches it, but the
  function is public API, so a row now holds it and its comment no
  longer calls it unreachable. `affected.ts`'s "cat-file --batch ended
  before" guard also survived: it defends against a truncated stream
  that real git does not produce, so it stays unheld and is recorded.
- **D-59** Lead from L: the config purity gate let `new Worker('./x.ts')`
  through, and the worker's file is outside the hashed closure, so what
  it reads (env, clock) could reach a cached evaluation stale. `Worker`
  joins the deny-list (`IMPURE_RE`, and the word lists in
  `config-cache.md` and the resolved-config-hashing post). Row: the
  `new Worker` case of `tests/config-cache.test.ts`, red without it.
- **D-60** Lead from A: under a low `ulimit -n`, discovery read `EMFILE`
  as an empty workspace ("No package matched the workspace's package
  globs"). Every catch that means "absent" (the member listing, the
  config lookup, a member's `package.json`, the root walk's manifest
  read, a link's stat, `isFile`) now rethrows an out-of-descriptors
  error through `absent()`, so the run fails with the `ulimit -n` hint.
  Rows: the D-60 rows of `tests/workspace.test.ts` hold the member
  listing, the config lookup (its `readdir` on Linux and its `isFile`
  stats elsewhere; the macOS job caught the first version, which spied
  only `readdir`, and the stat path was then driven on Linux by forcing
  the branch) and the `package.json` read, spies restored per row, with
  a control that a missing directory is still absent. The root walk's
  manifest read and a link's stat share the helper the rows hold.
- **D-61** Lead from L: two in-process `run()` calls on a config that
  reads `process.env` derived different keys. Probed: a Bun Worker
  starts with the process's STARTUP environment, so the first load (in
  process) saw a variable set since and every Worker re-evaluation did
  not. Each Worker request now carries the parent's `process.env`, and
  the Worker syncs to it (deletions included) before the import. The
  in-process fixture now hits on one key across three runs. Row: the
  D-61 row of `tests/config-eval.test.ts`, one evaluation round with a
  new file per call; red without the fix, and each half (assign,
  delete) caught by its mutant.
- **D-62** Design note for N's discovery-seam lead
  (`docs/design/discover-seam-2026-09-28.md`, proposed): a `discover`
  hook through which a plugin names project directories, so `nx()` can
  attach an integrated Nx repo's projects that no package manager lists
  (analogjs: 1 of 21 `build` tasks today). It gives the refusals at the
  boundary, what does not change, open questions for watch and lock, and
  the slices for D, C, H and G/N.
- **D-63** Failure class after D-60, grepped across the slice: the
  `--affected` config-import walk reads a level of configs together,
  and an `EMFILE` there read the config as having no imports, so a
  changed preset selected nothing and `--affected` reported a clean
  tree. The read now rethrows an out-of-descriptors error. The slice's
  other swallowing catches stat (no descriptor), parse bytes already
  held, or read one file synchronously; none holds a level open. Rows:
  the D-63 rows of `tests/config-missing-import.test.ts`, a `Bun.file`
  spy refusing the config's read with `EMFILE` (red without the fix)
  and an `EACCES` control that still reads as no edges.
- **D-64** Failure class: a config's output under `vx mcp`. The server
  redirects the parent thread's stdout (item 922), but a repeat load
  evaluates in the config Worker, whose console and stdout are its own:
  the second `listTasks` call's `console.log` landed between the two
  JSON-RPC responses (probed). The Worker now routes every stdout route
  to stderr. Row: the D-64 row of `tests/config-eval.test.ts`, a child
  process whose fd 1 stays empty while five routes print; red without
  the fix, and each of the four redirects caught by its own mutant.
  A first load still prints to stdout: a lead for E.
  Refuted on the way: a warm-path cost in the slice. At 1,000 projects
  the `workspace config` span (17 ms) is mostly the git spawns started
  there on purpose, to overlap discovery; the slice's own reads take
  1–5 ms per stage.
- **D-65** Failure class: a config that calls `process.exit`. On a first
  load (in process) it ended vx mid-load: `exit(0)` made a
  `vx run build --all` green, with no task run and nothing printed
  (probed). On a
  repeat load it ended the config Worker unheard, and the load waited
  out its whole deadline to say the worker did not answer. While a
  config evaluates, `process.exit` now throws, naming the call, at the
  config's line: counted in process (restored when the last concurrent
  load leaves), permanent in the Worker. An exit scheduled for later (a
  timer) is not covered. Rows: the D-65 rows of
  `tests/config-eval.test.ts`, the Worker's refusal inside 2 s of a 5 s
  budget and, in a child process, two concurrent first loads both
  refused with `process.exit` restored after; each guard, the save and
  the restore caught by its own mutant (the concurrency pair only once
  the slow load enters first and exits last).
- **D-66** Failure class: a config that never settles. The Worker had a
  deadline; a first load (in process) had none, so a top-level await
  that never settled while a timer kept the loop alive hung `vx run`
  with nothing printed (probed, killed at 45 s). The first load now
  races the same budget (`evalBudgetMs`, `VX_CONFIG_WORKER_TIMEOUT_MS`)
  and fails naming the config, releasing D-65's exit guard. Refuted on
  the way: an unref'd deadline does not let a pending import's loop
  drain, so the budget fires either way. Row: the D-66 row of
  `tests/config-eval.test.ts`, in a child that exits itself: the named
  refusal at 300 ms and `process.exit` given back; red without the race
  (killed), and the guard's release caught by its mutant.
- **D-67** Failure class: a getter in a config. A read of the config
  called it each time (`vx show` printed `echo read-3` for a counting
  `get command()`), so the key, the schema check and the command could
  each see another value, and a throwing one surfaced as vx's own stack
  with the `?vx-held=` query in it. The JSON-data walk reads each
  property by descriptor and refuses a getter or setter by path, never
  calling it, on both paths (`nonJsonPaths` is the workers' too). Cost:
  2.1 to 4.7–5.2 ms per 1,000 configs in the walk (per-key descriptor;
  one `getOwnPropertyDescriptors` per object was 8.1); the warm path
  calls the walk zero times (counted on the 1,000-project bench). Rows:
  three KINDS entries of `tests/config-eval.test.ts` (a varying getter,
  a throwing one, a setter alone), each on both paths, red without the
  fix, the setter branch caught by its mutant; the row that held a
  throwing read in the worker now uses a Proxy trap, which still throws.
- **D-68** Cost cut: cold config loading. `loadProjectConfigs` awaited
  each first load in turn, and the in-process imports were ~110 ms of
  a ~230 ms cold `load configs` at 1,000 projects. In isolation 1,000
  imports took 157 ms one at a time, 61 at 64 wide, 46 unbounded. Misses
  now load 64 at a time; hits stay synchronous. Interleaved, cache wiped
  per run, min of 5: 226 to 164 ms cold; warm tied (min of 9: 23.0 and
  22.3 ms; a first cut that sent hits through the lanes cost the warm
  path ~2.5 ms). Rows: the D-68 rows of `tests/project-loader.test.ts`:
  a config that settles only once a later one has run (deadlocks at
  width 1, caught), results in the order asked, and the first failure
  in order thrown when a later one fails sooner (caught by the
  last-failure mutant). Stopping new loads after a failure was dropped:
  nothing observed it, and storing the rest helps the next attempt.
- **D-69** Failure class: `defineProject` let any key through. Its
  argument is a generic `T`, and TypeScript skips the excess-property
  check for an inferred one, so `outputs` on a task, `cwd` in `exec`,
  a top-level `pipeline` and a stray key in `cache`, `cache.inputs` or
  `cache.outputs` all type-checked (probed with a named fixture under
  `oxlint --type-check`) and failed only at load, where the runtime
  message is good. A `Known<T, Shape>` intersection types every
  undeclared key `never`, so the error sits on that key's line. Row: the
  D-69 row of `tests/config.test.ts`, one `@ts-expect-error` per level
  (each unused, so an error, without the fix) and a control with every
  declared key, a conditional spread and a cross-task `dependsOn`.
  Declared breaking (`fix(config)!:`): the signature's lines changed in
  `tests/contract/package-api.txt`, and a config that type-checked with
  an undeclared key now fails `tsc`, though vx already refused it at
  load.
  Probed clean on the way: package-graph linking (an unsatisfied range
  and an `npm:` alias stay external; `workspace:`, dev, peer and
  optional deps link; a self-dependency adds nothing).
- **D-70** D-69's class in `defineWorkspace`: its test held only a lone
  unknown key, which TypeScript's weak-type check refuses anyway; beside
  a known key the generic skipped the excess-property check, so
  `{ plugins: [], concurency: 4 }`, a `pipeline` beside `cacheDir` and a
  `maxAge` in `cacheRetention` type-checked (probed). The same `Known`
  intersection now covers the top level and `cacheRetention`. Row: the
  D-70 row of `tests/config.test.ts`, three `@ts-expect-error` lines
  (unused, so errors, without the fix) and a control with every key.
  Declared breaking, as D-69 was.
- **D-71** Pin: the config types and the validator name the same keys.
  D-69 and D-70 made an undeclared key a type error, so a field the
  validator accepts but the type lacks would be a config that loads and
  fails `tsc`. Nothing held the two together; diffed from source at 14
  levels, they agree today. `tests/config-types-schema.test.ts` lists
  each level's keys once and holds the list to the TYPE with the
  type-checker (`satisfies` for every entry, an `Exhaustive` check for
  every key) and to the VALIDATOR through its refusal of an unknown key,
  which names what it allows. Each direction caught by its own mutant:
  a key dropped from a list or added to it, a field added to a type
  (type errors), a field dropped from a validator set (a red row).
- **D-72** Mutation sweep of D-68's load pool (10 mutants, the six
  loader suites): nine caught (the synchronous hit path, both stores,
  both closure paths, the throw, one lane, width 1, a rethrowing lane).
  The survivor was equivalent: without the `continue`, a failed entry
  pushed `undefined` into a result that the rethrow then discarded. The
  collection now records the evaluations and closures of the loads that
  succeeded, throws the first failure, and only then maps the configs,
  so no line is dead; its three mutants (the last failure kept, the
  evaluations dropped, the throw dropped) are caught. Probed clean on
  the way: package-graph build is linear to 5,000 projects (2–3 µs a
  project; the run's 40 ms stage was the one-shot run's JIT).
- **D-73** Sweep of D-63 to D-67's guards, the branches their own rows
  never named: dropping the first load's `clearTimeout(deadline)` was
  caught (an end-to-end run held open 30 s). Dropping the config
  Worker's `await quiet` survived: the redirect was set up behind an
  awaited `import('node:console')`, and the first evaluation raced it
  and lost only in principle (the config's own import is slower). The
  Worker now builds its console from `globalThis.console.Console`,
  synchronously, before `onmessage` is set, so there is no race and no
  line to drop; the D-64 row still catches a dropped redirect.
- **D-74** Failure class: a config that changes the built-ins. A first
  load runs in process, and `Object.prototype.exec = {…}` in project a
  gave project b's cache-declaring `build` (no `exec` of its own) that
  command. The key folds b's own JSON, so changing a's command replayed
  the old output as up-to-date (probed: CMD-ONE replayed under CMD-TWO,
  a stale hit on a green run). Each first load is now compared with a
  snapshot of `Object.prototype` and `Array.prototype` taken before the
  round, before its validation reads through them (a replaced
  `Array.prototype.includes` turned the JSON-data walk's own check into
  "a cyclic reference"); what changed is put back and the load refused,
  naming the property, and the round's end puts back what a failed load
  changed. Rows: the D-74 rows of `tests/project-loader.test.ts`, each
  in a child: an added property refused and removed, a replaced one
  restored, a failing config's own error with its change taken back, a
  clean control; three red without the fix, and the per-load check and
  the end-of-round restore each caught by its mutant.
- **D-75** D-74's class beyond the prototypes: a config that set
  `Bun.hash.xxHash3 = () => 7n` gave every task the key 00000000, and a
  changed command replayed the old output as up-to-date (probed, a
  stale hit on a green run). A replaced `JSON.stringify` did not reach
  the key (probed clean). The watched set grows to what vx runs on:
  `Bun`, `Bun.hash`, `JSON`, `Math` and the `String`, `Map`, `Set` and
  `Promise` prototypes, each measured stable across a run's worth of
  Bun calls (no lazy property changes shape). Row: the D-75 row of
  `tests/project-loader.test.ts`, the hash refused and put back; red
  with `Bun.hash` dropped from the set.
- **D-76** A project config's first load wrote `process.env` for the
  whole process: `process.env.LEAK = 'one'` in project a overrode the
  host's `LEAK=three` in project b's `passThrough` (probed; the key saw
  the same value the child got, so no stale hit), reached vx's own
  `VX_*` reads, and a repeat load, in a worker, dropped it. The D-74
  round now snapshots `process.env` too, puts back what a load added,
  replaced or deleted, and refuses naming each variable. Assigned back:
  `process.env` refuses `defineProperty` (probed). Rows: the two D-76
  rows of `tests/project-loader.test.ts`, red with `restoreEnv` removed.
- **D-77.** `config-eval.test` › a REJECTED evaluation does not poison a
  later one timed out on loaded macOS runners ("config worker did not
  answer within 1000ms"): the rejected load's 1000 ms budget paid for
  the worker's spawn, and it had to stay below the slow load's 1200 ms
  sleep for the orphan timer to land inside it. The row now holds a
  round whose worker a first load spawns under a 10 s budget, so the
  1000 ms covers an import in a live worker; the slow load starts after
  the rejection, so it outlasts the orphan by construction. Red with
  the `clearTimeout` moved back after the await; 5 of 5 green with two
  busy loops per core.
- **D-78.** J-59's lead: a config importing a plugin that is not
  installed (`cannot find '@vzn/vx-otel'`) was told `bun add -d @vzn/vx`,
  naming core. The hint now names the package the specifier does, a
  subpath's too (`@vzn/vx-migrate/turbo` → `@vzn/vx-migrate`). Row:
  `project-loader.test.ts` › the install hint names the missing package,
  another scope as control; red without the fix.
- **D-79.** J's lead: the `cache.inputs.tasks` "names no task" refusal
  printed the config's path twice (`<path>: tasks.build…` and again
  before `tasks.build.dependsOn`). The second mention
  is the task alone. Row: `project-loader.test.ts` › the typo that
  decouples, now the path counted once; red without the fix. The
  config-schema record's three messages regenerated.
- **D-80.** `vx init` left out a root script that runs the members (D-45), but not one that runs such a script by name: vite's `ci-docs` (`pnpm build && pnpm docs-build`) and `test-docs` (`pnpm run docs-build`) mapped as root tasks, each running members' builds again beside their own. A root script calling a member-running root script (`pnpm x`, `npm run x`, `yarn x`, `bun run x`, to a fixed point) is left out too. Row (`init.test` › the workspace root among members is not mapped …, with a control calling a root script that runs no member). Probes, nothing else to fix: vite's other root scripts; openpanel (plain pnpm, as designed).
- **D-81.** `vx init` read a workspace flag on any program as the package manager's: berry's nine root scripts over `yarn node -r ./scripts/setup-ts-execution …` (node's `--require`) were left out as running the members, as `mocha -r`, `tar -C` would be. A flag now counts on `pnpm`/`npm`/`yarn`/`bun` up to the program it runs (`node`, the name after `exec`/`dlx`/`x`), or after a `run` verb (npm/cli's `node . run test --workspaces`). Row: `init.test` › a workspace flag counts on the package manager …, with controls (`cross-env CI=1 pnpm -r`, `pnpm exec -r`, `yarn --cwd`, `node . run --workspaces`); red without the fix. Probes, nothing else to fix: jest (yarn), npm/cli, sveltejs/kit, vitest (pnpm).
- **D-82.** `vx init` mapped a root script over `yarn workspace <name> …` (cal.com's `prisma: yarn workspace @calcom/prisma prisma`) as a root task, running a member's script from the root beside the member's own. It is left out as running the members. Row: the D-45 row of `init.test`, now with that script; red without the fix.
- **D-87.** facebook/react's root package.json has no `name`, and `vx init` said "not mapped: its scripts run the workspace" — not why: 29 of its scripts (`lint`, `flow`, `prettier`, the `build-for-*` ones) are the repo's own and map once it is named. The note now says the root has no name, and how many scripts naming it maps, listing them. Row: `init.test` › an outside root is named by its manifest …, the D-87 cases, with a control whose scripts all run the members; red without the fix. Probes on the way: starlight, lexical, react-router (pnpm), prisma (`turbo()`): nothing new (lexical's root `build: node scripts/build.mjs` is D-85's case).
- **D-86.** A `vx.config.cjs` / `.cts` (or `vx.workspace.cjs` / `.cts`) was no config name, and was ignored without a word: its project's tasks were "declared nowhere" (probed: three CommonJS configs, one task ran). Both names are now read, after the ESM ones; `module.exports` is the config, as Node reads a CommonJS default (an `exports.default` needs `__esModule`, as in Node). Linux discovery is one `readdir` per project either way. Row: the D-86 cases of `tests/contract-discovery.test.ts` (recorded), red without the fix. Probe on the way, no gap: npm 10's `packages/**` workspaces (nested, no `node_modules`, no dot dir) match vx's discovery.
- **D-83.** Probing oven-sh/bun's root (a plain Bun workspace): `typecheck` (`tsc --noEmit && cd test && bun run typecheck`) was left out as running the members on any `cd`, and `run:linux` (`docker run … -w /root/bun`) on D-81's `run` fallback. A `cd` now counts into or above a member's directory, or to a target vx cannot read (`$DIR`, `~`); the `run` fallback only as `node <bin> run` (npm/cli). Row: `init.test` › a cd runs the members only into a member …, with controls (`cd packages/a`, a quoted subdir, `cd packages`, `cd "$DIR"`); red without the fix. Re-probed jest, npm/cli, kit, vitest, berry: unchanged.
- **D-84.** `--filter './packages/kit/**'` left out the package at `packages/kit` itself: `Bun.Glob`'s `a/**` does not match `a`, while pnpm 12 and Turbo read a trailing `**` as zero dirs too (sveltejs/kit's root `check` filters `./packages/**`). A path glob ending in `/**` now also matches its base. Row: `filter.test` › a path form with a glob selects by root-relative dir, with `./packages/core/*` as control; red without the fix. Differential against pnpm 12.5 on a kit copy (a task per package): 40 selectors (names, scopes, globs, `...`/`^` forms, braces, `..`/`.` segments, `!`) agree but for two, both by design: `./packages` (no package there) selects the packages under it (D-43; pnpm 12 selects none), and `[HEAD]` counts untracked files.
- **D-85.** jest's root `build` (every package's, `yarn build:js && …`) was left out as the website member's task name, unnamed: `vx run build --all`, which init's own report suggests, built the website alone. The note now names each root script left out, by reason, and says one doing other work maps by hand under its own name. Two siblings in the same rule: a left-out `build`'s `prebuild` stayed as a task of its own, and npm/cli's root `postlint` was dropped from its `lint` because each member declares a `postlint`. A hook is now judged with its script (where the manager runs hooks). Rows: the D-45 row (a `prebuild`, the new note) and `init.test` › a root script's hook is judged with its script …; each red without its half. Probes on the way, no gap: a Bun object-form `workspaces` with a catalog; `vx init` then `vx run build|test --all --dry` loads on jest, npm/cli, vitest, berry, kit; Turbo 2.11.6 against vx on the kit copy, 26 selectors, differing only where recorded (D-43 `./packages`, D-46 `.`/`//`, scope-less names, Turbo's root needing `//#x`); `[ref]` forms against pnpm 12.5 agree on tracked edits (vx also counts untracked files, as Turbo does; pnpm 12 selects nothing for `{packages/**}[HEAD]`, its docs' own example).
- **D-91.** `vx init` made a script persistent by its name or as a watcher only, so a server under any other name mapped as a one-shot task: docusaurus's `serve:website:baseUrl` (`serve website`), `serve:website:ssl`, `start:baseUrl` (`cross-env BASE_URL=… pnpm start`), vitest's `preview-https` (`pnpm run build && serve .vitepress/dist`) and `@vitest/ui`'s `dev:client` (`vite`). A dependent would wait forever, and a server that exits on stdin EOF ended at once. A command running a server (`serve`, `http-server`, `sirv`, bare `vite`, a tool's `dev`/`serve`/`start`/`preview` verb) per foreground segment, outside quotes, or a script running such a script of its own package by name, is now persistent. Row: the D-40 row of `init.test`, with controls (`vite build`, `start-server-and-test "vite preview" …`, `pnpm preview & playwright test`, `docker run -w`); red without the fix. Diffed over twelve cloned repos: those eight scripts change, nothing else.
- **D-89.** Five task keys pasted from turbo.json or project.json were refused as unknown fields with no word on vx's home: Turbo's `interactive` and `with`, Nx's `cwd`, `parallelism` and `configurations` (probed: eighteen Turbo and Nx task keys in a vx.config). Each now ends `— vx spells it …`, worded as `@vzn/vx-migrate`'s support table maps them (`with` → `dependsOn` on the persistent sidecar, `parallelism: false` → `--concurrency 1`). Row: the D-49 Nx/Turbo task-key row of `config-schema-refusals.test.ts`, each message compared whole; red without the fix.
- **D-90.** `vx init`'s cache TODO guessed `dist/**` for every build no framework rule named: ky's `del-cli distribution && tsc …` writes `distribution/`, and a cache block pasted from the TODO would save nothing and restore nothing. With no tool rule, the guess is now the directory the command names (`--outDir`, `--out-dir`, `-d`), else the ones it cleans first (`rimraf`, `del-cli`, `rm -rf`, `shx rm`); a hidden dir, a file, a glob, `node_modules`, or a dir the command makes again with `mkdir` (kit's `rm -rf ./missing_ids && mkdir ./missing_ids && vite build`) keeps `dist/**`. Row: `init.test` › the cache TODO names the framework's own build output, the D-90 cases; red without the fix. Probed over the twelve cloned repos: ky changes, the rest keep their guesses. Also probed without a gap: npm 10's workspace glob spellings (`./packages/*`, a trailing `/`, braces, a class) match vx; an extglob is refused with its rewrite.
- **D-88.** A config renamed or moved after `vx lock` (`vx.config.mjs` → `.ts`) was refused under `--frozen` as `vx-lock.json has no entry for "a"`, while the lock holds "a" under its old path. It now says the lock holds it at the old path and names the new one. Row: `lockfile-boundary.test` › refuses when the entry points at a DIFFERENT config path, the message compared whole; red without the fix.
- **D-94.** Two more `config-eval.test` deadline rows raced the clock as D-77's did. "rejects the whole wedged round at the FIRST deadline" gave the sibling an 800 ms budget and a 500 ms ceiling, so a loaded box that fired the 200 ms timer late read HUNG; the sibling's budget is now a minute and its ceiling 5 s, and the rejection's own "within 200ms" proves which deadline fired. "deadlines instantly on 0" also asserted `< 300 ms` of wall; a 0 ms rejection of a config that sleeps 400 ms already proves it, so the bound is gone. The first row is red (HUNG) with the timeout rejecting only its own call; 5 of 5 green with two busy loops per core.
- **D-93.** `--affected` with no base and no `origin/HEAD` compared with `HEAD~1`: a repo with no remote, or a checkout that adds `origin` and fetches (actions/checkout sets no `origin/HEAD`), saw only a feature branch's last commit, where Turbo (`TURBO_SCM_BASE` default `main`) and Nx (`defaultBase: main`) compare with the trunk (probed: two commits on `feat` off a local `main`, the first commit's change unselected). The default is now `origin/HEAD`, then the first of `origin/main`, `origin/master`, `main`, `master` that exists and is not HEAD's commit (one `for-each-ref`), then `HEAD~1`; on the trunk itself the trunk is HEAD, so `HEAD~1` as before. Row: `affected.test` › with no origin/HEAD, a trunk branch that is not HEAD is the base, with the on-main control; red without the fix.
- **D-92.** Yarn 2+ runs a script in its own shell, where `run <script>` is `yarn run <script>`; vx's shell has no `run`, and 23 of berry's scripts (`run build:zip:worker`, `run test:unit packages/yarnpkg-fslib`, `run pegjs -o …`) mapped to tasks that would fail "command not found". Under Yarn 2+ (the nearest `packageManager` or Berry `yarn.lock`, now one `ownerOf` walk that the hook rule shares) a segment-leading `run` is written `yarn run`, so a lone `run b` of a sibling script becomes a group over it. Row: `init.test` › under Yarn 2+ a script's `run <script>` is spelled `yarn run`, with `echo run b && docker run img` and npm as controls; red without the fix. Also probed end to end without a gap: ky (npm) installed, `vx init`, `vx run build` miss → hit → restore after deleting `distribution/` under a `distribution/**` cache block; svelte, nuxt, solid-start (pnpm) and material-ui (`nx()`) init as recorded rules say.
- **D-96.** zod's root `packageManager` is `nub@0.8.3` beside a `pnpm-lock.yaml`, and `vx init` wrote "nub ran `postbuild` …", a claim nothing had checked. `packageManager` is read only for npm, pnpm, yarn and bun; any other value defers to the lockfile. Row: `tests/init-package-manager.test.ts`, with a known manager as control; red without the fix. Probes on the way, no gap: trpc (`turbo()`); `vx init --dry` runs under 100 ms on kit, docusaurus, react-router and vitest. Measured, not changed: a cold config load (300 projects, fresh `--cache-dir`) spends about a third of `load configs` in the per-config built-ins and `process.env` check (`restoreBuiltins` / `restoreEnv` at each first load: min 109 ms with it, 75 ms without, 8 runs each); the check is what names the config in D-74's refusal, which the rows hold, so a cheaper equivalent is the open lead (337 descriptor reads a config; `getOwnPropertyDescriptors` measured slower).
- **D-95.** A root script left out as running the members (D-80) was found only through a package manager naming it (`pnpm x`, `npm run x`): lexical's `ci-check` (`npm-run-all --parallel tsc … tsc-extension tsc-website …`, the two over `pnpm --filter`) mapped as a root task that ran members' work again. Script references now also come from `run-s` / `run-p` / `npm-run-all` (a `build:*` glob one segment deep, `**` any) and `concurrently "npm:x"`. Row: `init.test` › a root script reaching a member-running one through a script runner is left out, with controls (a runner over scripts that run no member, one naming a script the root lacks); red without the fix. Diffed over sixteen cloned repos: lexical's `ci-check` alone changes.
- **D-97.** pnpm/pnpm's root runs its members through `pn`, pnpm 11's short name for itself: `test-pkgs-all` (`pn … -r .test`), `release` (`pn --filter=…`), `dev-setup` (`pn -C=…`) and a dozen more mapped as root tasks re-running member work. `pn` is read as pnpm wherever `vx init` matches a package manager (workspace flags, script references, a lone `pn x` as a group). Rows: `tests/init-pn.test.ts`; both red without the fix. Probes on the way, no gap: vuejs/core (a nameless root, D-87's note), angular/angular, the `next:` install line for Turbo repos under yarn 4 (cal.com), Yarn 1 (`-W`), npm, bun and no lockfile.
- **D-99.** A project vx.config written in another runner's shape was refused as unknown fields with no word on where vx keeps them: package.json's `scripts`, Turbo's `pipeline`, Nx's `namedInputs`, `root`, `sourceRoot`, `projectType`, and a task's `dependsOn`, `cache`, `exec`, `description`, `inputs`, `outputs`, `env` written one level too high (beside `tasks`). Each now names vx's home. Rows: `tests/config-schema-project-keys.test.ts`, a typo control kept; red without the fix. (#2182)
- **D-100.** Nx run-commands' options pasted under a task's `exec` (`cwd`, `args`, `commands`, `parallel`, `shell`, `interactive`) were refused as unknown fields with no word on vx's home. Each now names it (`cd <dir> && …` in `command`; arguments after `--` on `vx run`; one task each, or `a & b; wait`; `command` always runs in a shell). Rows: `tests/config-schema-exec-keys.test.ts`, a typo control kept; red without the fix. (#2190)
- **D-101.** pinia's online-playground `build` (`pnpm -C ../pinia run build && vite build`) mapped verbatim, so vx built pinia again outside the graph beside pinia's own task. The part of a member's script that runs another member's work — `yarn workspace`, a runner, `-r` / `--filter` / `--workspace`, a `cd` / `-C` / `--dir` / `--cwd` / `--prefix` whose innermost member is another one — now gets a TODO naming it; the command stays. Probed: flags pinia, kit, react, headlessui, pnpm/pnpm; not jest, docusaurus, lexical (root-directed). Rows: `tests/init-member-sibling.test.ts`, controls for a fixture, the root, the member itself, `$DIR`; red without the fix. (#2209)
- **D-102.** A task written in package.json's shape (`tasks: { x: 'tsc -b' }`) was refused as `tasks.x must be an object` with no word on where the command goes. A non-empty string now adds `— a command is { exec: { command: "tsc -b" } }`; an empty string and other non-objects keep the bare message. Rows: `tests/config-schema-task-string.test.ts`, with controls; red without the fix. The schema contract record regenerated. (#2229)
- **D-103.** insomnia (npm workspaces) read the root note's examples in pnpm's spelling, "(`pnpm -r`, `--filter`, a runner)". The examples follow the repo's manager: npm `--workspaces`, `-w`; Yarn 1 `yarn workspaces run`, `yarn workspace`; Yarn 2+ `yarn workspaces foreach`; Bun `bun --filter`; pnpm's (or a `pnpm-workspace.yaml`'s) as before, and with no lockfile anywhere the old wording. Rows: `tests/init-root-note-manager.test.ts`; red without the fix. (#2240)
- **D-108.** Yarn 2+ installs with Plug'n'Play unless `.yarnrc.yml` names another linker, and a mapped task's bin exited 127 under vx (probed on a real Yarn 4.5 PnP workspace: `json5 --version` ran under `yarn run`). The init report names PnP and the ways out: `nodeLinker: node-modules`, or `yarn exec '<command>'` (verified to take a quoted shell line); init does not wrap commands itself, which would boot Node before every task. berry trips it; cal.com (`node-modules`) does not. Rows: `tests/init-yarn-pnp.test.ts`, controls for node-modules, the pnpm linker, Yarn 1; red without the fix. (#2290)
- **D-109.** Under Yarn PnP a config's bare import was refused with "install the workspace's dependencies first", though they are installed, into a `.pnp.cjs` Bun does not read. With a `.pnp.cjs` at or above the config the refusal names PnP and `nodeLinker: node-modules`; after that switch the probed config loaded and its task ran. Rows: `tests/config-pnp-import.test.ts`, a no-`.pnp.cjs` control; red without the fix. (#2308)
- **D-111.** A Lerna-classic root lists its packages in `lerna.json`, not `workspaces`, and vx saw the root alone; the unreached-packages hint fires only when nothing maps, and such a root has scripts. In single-project mode a `lerna.json` beside the root now gets a note naming the `"workspaces": [...]` to add (Lerna's `packages/*` default when it lists none); following it mapped the members (probed). Rows: `tests/init-lerna-packages.test.ts`, controls for reached members and no `lerna.json`; red without the fix. (#2325)
- **D-112.** docusaurus's `netlify:test` (`pnpm dlx --package netlify-cli netlify dev`) read `netlify-cli`, the value of `--package`, as the program and mapped a server as a one-shot task (D-91's follow-up). A launcher's `--package <name>` / `-p <name>` skips its value. Rows: `tests/init-serves-dlx.test.ts`, one-shot controls; red without the fix. (#2335)
- **D-104.** react-navigation's twelve packages build only in `prepack: bob build`, and its root `build` (`lerna run prepack`) runs the members and is left out, so `vx init` mapped the repo with no build. A member with no `build` script whose `prepack` / `prepublishOnly` / `prepublish` / `prepare` runs a builder is named in a report note, which says to add a `build` script running it. Of 38 cloned repos only react-navigation trips it. Rows: `tests/init-lifecycle-build.test.ts`, controls for a package with a build, `prepare: husky`, the root's own hook; red without the fix. (#2244)
- **D-105.** With no `build`, the report's `next:` line ran the first task: react-navigation was told `vx run clean --all`. It runs `build`, else the first task that neither serves (`persistent`) nor changes the repo (`clean`, `release`, `publish`, `deploy`, `version`, `format`, `fix`, …), else the first. Rows: `tests/init-next-task.test.ts`; red without the fix. (#2251)
- **D-106.** A member whose package.json has no `name` is no project, and `vx init` left its scripts unmapped without a word (remix's `packages/component/bench`). Init names each nameless member with a script, in either report; the directories come from an internal `discoverProjects(workspace, nameless?)`, so `listProjects` / `listProjectMetas` keep their signatures. Rows: `tests/init-nameless-member.test.ts`, controls for a nameless member with no or only an empty script; red without the fix. (#2274)
- **D-107.** On CI's one-commit checkout `--affected=HEAD~1` read only `git ref "HEAD~1" did not resolve`; in a shallow clone the refusal now says so and names `git fetch --unshallow` / `fetch-depth: 0`. The extra `git rev-parse --is-shallow-repository` runs only on that error path. Rows: `tests/affected-shallow.test.ts`, a full-clone control; red without the fix. (#2287)
- **D-113.** `isPersistent` followed `pnpm <script>` references but not a runner's: `concurrently "npm:web" "npm:api"`, `run-p web api` and `npm-run-all --parallel w*` over servers mapped as one-shot tasks. It reads references through `scriptRefs` (D-95's reader). No change across the 34 cloned plain workspaces. Rows: `tests/init-persistent-runner-refs.test.ts`, a runner-over-one-shot control; red without the fix. (#2345)
- **D-117.** Turbo's CI docs filter `[origin/main...HEAD]`, and vx refused it as a range. vx already diffs from the merge base to the working tree, so `<base>...HEAD`, in a filter or `--affected=`, reads as `<base>`; any other range is refused as before. Rows: `tests/affected-head-range.test.ts`, controls `main...feature` and `-x...HEAD`; red without the fix. (#2373)
- **D-118.** A cache block in another tool's shape (wireit's `files` / `output`; `env`, `dependencies`, `enabled` under `cache`; `globs`, `include`, `patterns`, `exclude`, `ignore` under `inputs` / `outputs`) was refused as unknown fields with no word on vx's home. Each now names it. Rows: `tests/config-schema-cache-keys.test.ts`, a typo control; red without the fix. (#2377)
- **D-119.** Configs load 128 at a time, so a watched built-in one config changed could surface after another's load, and the refusal named the wrong file (probed 3 of 3). With loads overlapping, the round now evaluates each config alone in a throwaway worker and names the first that changes something, else "a project config"; the worker runs only on this error path. Rows: `tests/config-builtins-blame.test.ts`, a single-config control; red without the fix. (#2382)
- **D-120.** A config's `process.chdir()` moved the whole vx process, and every relative path after it read from the config's choice. Each load round compares `process.cwd()`, puts it back and refuses the change as `process.cwd (a chdir)`, blamed as in D-119. Rows: `tests/config-chdir.test.ts`, an innocent control, each checking the cwd is restored; red without the fix. (#2389)
- **D-121.** `config-eval.test` › a REJECTED evaluation does not poison a later one raced the clock on macOS (a 1000 ms budget to reject; a 1200 ms sleep to outlast it). The rejected load now has 3000 ms, and the healthy load blocks on a release file written by a timer due after the rejected load's own; timers fire in deadline order, so no row is a guess about speed. Red with the clear removed from the `finally`. (#2393)
- **D-110.** A config in Vite's shape, `export default () => ({ tasks: {} })`, was refused as "did not export a default object" with no word on what it did export. The refusal adds `: it exports a function, and vx reads the object itself — export what the function returns`, for project and workspace configs, on the first load and a repeat one (the eval worker flags a function, which JSON cannot carry). The playground mirrors it. Rows: `tests/config-function-export.test.ts`, a number control; red without the fix, and red with only the worker half reverted. (#2315)
- **D-122.** One config's `globalThis.x` reached every config loaded after it in the process: `vx run --all` ran `echo leaked`, a `--filter` of the reader alone `echo none`. `globalThis` joins the watched built-ins (put back, refused naming `globalThis.<key>`, blamed as in D-119), and descriptors compare by `Object.is` so `globalThis.NaN` reads unchanged. Cold 300-config load 60.5 → 63.9 ms, warm unchanged. Refuted as fixable: a config mutating an imported module leaks the same way (probed), and splitting the module registry needs a worker per config; the loader page names the limit and the hint says a shared _constant_. Rows: `tests/config-global-leak.test.ts`; red without the watch, and all three red without `Object.is`. The D-68 overlap row now signals through a shared module. (#2436)
- **D-123.** `--affected` probed against Turbo and Nx across moves, deletes and nesting, no gap: a moved file selects both projects, a moved project its new dir, a deleted one nothing, a nested project its own files (its parent's once unlisted), a root-only change none, a renamed package its new name with dependents; `[HEAD~1]` and `...[HEAD~1]` agree. Lockfile bumps are held by vx-lockfile's own `affected` rows. Rows: `tests/affected-moves.test.ts`; the move row is red with `--find-renames` for `--no-renames`. Also probed, no gap: pnpm's `{dir}`, `...{dir}`, `{dir}...`, `^` and `!` selectors; a config's `process.exit()` (refused) and `process.exitCode` (no effect on the run). (#2430)
- **D-124.** A config that set `Reflect.ownKeys = () => []` (or replaced `Array.prototype.forEach`) hid its own `Object.prototype.exec` from the built-ins check, and another project's task ran its command (probed). Each round takes the reflection primitives with its snapshot, before any config runs, and compares and restores in indexed loops; `Reflect`, `Object`, `Array`, `Date` and the RegExp, Function, Number and Date prototypes are watched too. Cold 300-config load +2 ms, warm unchanged. Rows: `tests/config-check-blind.test.ts`; red without the fix. (#2465)
- **D-125.** A config's `process.umask(0o777)` left every file vx and its tasks wrote after it mode 000: the cache artifact and the task's outputs (probed). A worker shares the process umask, so a repeat load moved it unchecked. Each round and each worker evaluation puts it back, and the load is refused naming `process.umask`. Rows: `tests/config-umask.test.ts`; red without the fix. (#2469)
- **D-126.** `vx.workspace.ts` loaded with no built-ins guard, so its prototype edits reached every project config and vx itself. It gets the project config's snapshot, restore and refusal, with `globalThis` left out (plugin tests hand values through it); its bytes are in no cache key. Rows: `tests/workspace-config-purity.test.ts`; red without the fix. (#2478)
- **D-127.** A duplicate package name refusal listed the root's directory as an empty string. It reads "the workspace root". Rows: `tests/workspace-dup-root.test.ts`; red without the fix. (#2488)
- **D-128.** A member directory with a vx config and no `package.json` was skipped without a word. It now warns that vx names a project by its package.json `"name"`. Rows: `tests/workspace-config-no-manifest.test.ts`; red without the fix. (#2492)
- **D-129.** insomnia's root shares its `"name"` with `packages/insomnia`; `vx init` wrote a root config, which made the root a project, and every later run was refused for the duplicate. Init writes no root config then, and the report says to rename the root. Rows: `tests/init-root-name-clash.test.ts`, a distinct-name control; red without the fix. Probes on the way, no gap: `vx init` on query, refine (Nx), ai, astro, tldraw, drizzle-orm, shadcn-ui (Turbo), mantine, excalidraw, vite, biome. (#2507)
- **D-130.** A package named `a#b` was planned under `--all`, but every task spec splits at the first `#`, so `vx run a#b#build` and a `dependsOn` on it found nothing. Discovery refuses the name (npm does too). Rows: `tests/workspace-name-hash.test.ts`, a scoped-name control, and a `schema.md` error-table row; red without the fix. Probed, no gap: `workspaces` as an object, a trailing slash, `./`, `**`, repeats, `!` exclusions; `pnpm-workspace.yaml` quoting, comments and flow lists; `.mts` / `.cts` / CJS `.js` configs, top-level await, JSON imports; the config cache following an imported module, a JSON file, an env var and an `fs` read; a task named `a#b`, `^b` or padded (refused). Two configs in one directory load the `.ts` silently, by choice: a warning would cost a stat per project. (#2517)
- **D-131.** `VX_CONFIG_WORKER_TIMEOUT_MS` was documented as bounding a config evaluation "in process or in its worker"; a first load runs in process, and `while (true) {}` holds the thread the deadline fires on, so `vx run` hung until killed (probed past a 2 s budget). The docs say so; bounding it would take D-68's measured-out worker per config. A repeat load's worker still fails at the budget. Rows: `tests/config-eval-sync-loop.test.ts`; red with the timer's reject removed. (#2522)
- **D-132.** As a non-root user, a member's `package.json` at mode 000 dropped its project from `--all` under a green run (D-128's warning said it had none), and an unreadable config read "a path vx must write is not writable". A member manifest, a project config, the root manifest and `vx.workspace.ts` vx may not read now refuse as `<file>: not readable by this user (EACCES)`; a member directory it may not search is named and skipped. Rows: `tests/workspace-unreadable.test.ts` (non-root, `VX_REQUIRE_NONROOT` on CI; run as `nobody` locally), red without the fix; a first push assumed a canonical temp root and was red on macOS. Probed, no gap: the config cache follows a `node_modules` package and its version, a tsconfig `paths` alias and its retarget; package edges (`workspace:`, matching and non-matching ranges, dev / peer / optional, `npm:`, `link:`, `file:`), a package cycle (refused under `^build`), and `...a` / `a...` / `^` selectors over it. (#2533)
- **D-133.** A glob other than `<dir>/*` is scanned, and the scan threw EACCES at a member directory vx may not open, with the write wording; it cannot skip the directory, so the load is refused naming it and the glob. Merged apart from D-132, whose PR merged before this commit landed. Rows: `tests/workspace-unreadable.test.ts`; red without the fix. (#2548)
- **D-134.** `--affected` probed with a member that is a real `git submodule add` checkout and with an untracked nested repo, no gap: a dirty edit, an untracked file, a moved pointer (unstaged or committed) and `.gitmodules`' own `ignore = all` each select the submodule's project, and its cache key follows dirty and committed edits. `affected.test` drove a gitlink and `diff.ignoreSubmodules`; the two cases it left undriven are pinned. Rows: `tests/affected-submodule.test.ts`; both red without `--ignore-submodules=none`. Also probed, no gap: `--affected` over modified, untracked, ignored and staged-then-deleted files; `--filter` spellings (`@s/*`, `*a`, `{dir}`, `./dir`, `!`, `...`, `^`, an empty value, a case typo). (#2568)
- **D-135.** With `packages/*` and `apps/*`, a link `apps/docs -> ../packages/docs` was refused as two packages sharing the name, with "rename one" as the way on. A name group now collapses entries with one real path, keeping the one reached through no link (the root's real path is the reference, for macOS's symlinked temp dir); real paths are resolved only inside a group. Rows: `tests/workspace-member-alias.test.ts`; red without the fix and red without the root's real path, a two-package control kept. Also probed, no gap: a symlink loop under `**`, a link out of the root, two links to one outside package, a dangling link; `cache.inputs` / `outputs` globs that are absolute, `..`, empty, all-negated, or spelled `./src/**`, `src/./**`, `src//**`. (#2587)
- **D-136.** `config-eval.test` › "a REJECTED evaluation does not poison a later one" timed its release from a mark taken before the rejected load armed its timer; a slow arm (a loaded runner) put the orphan past the release, and the row passed with the bug back (probed: the `finally`'s clear removed and a 100 ms arm, old row green). The mark is taken once the load settles, after the arm. No timeout or budget raised. (#2612)
- **D-137.** A workspace inside a member of another (`apps/tool/ws` with `workspaces` of its own, under a root listing `apps/*`) resolved to the outer root through `apps/tool`, and its members ran in a workspace that does not list them ("no projects declare task(s): build"). Past such a manifest, an outer root claims the tree only by listing that directory, as npm reads it; `vx init` from there writes the inner workspace only (probed). Rows: `tests/workspace-nested-root.test.ts`; red without the fix, two controls (a member's own subdirectory, an outer root that lists the nested one). (#2617)
- **D-138.** Exact-message rows through `vx run` for a broken workspace file: a config that throws names its own line (red with the stack's specifier rewrite removed), a missing import names the specifier, an unparseable manifest names its file, and a manifest saved with a byte-order mark plans as one without (Bun's decoding strips it; pinned as a probe). Rows: `tests/workspace-load-messages.test.ts`. Also probed, no gap: `dependsOn` naming a missing task, project or spec shape; a self-dependency (a cycle). (#2619)
- **D-139.** npm 10 put what only a workspace nested in another's directory needs (`packages/a/packages/n`) in `packages/a/node_modules`, where Node resolves it; `npm()`'s resolver stepped between `/node_modules/` boundaries, skipped that directory, and keyed `n` on its spec alone, a stale hit on a version change under it. It walks every ancestor directory now; `DIGEST_VERSION` 9. Rows: `packages/vx-lockfile/tests/npm-nested-workspace.test.ts`; red without the fix. Probed on real npm 10, bun 1.4 and pnpm 9 installs (yarn 4 is blocked by the egress policy), bumping one project at a time; every real lockfile in 100+ cloned repos parses. (#2642)
- **D-140.** A re-hoist installs the same bytes at another path (`is-odd/is-number@6.0.0` → `is-number@6.0.0` when another project took 6.0.0), and `bun()` and `npm()` folded the path, so every project reaching it re-keyed. A package folds its install name and resolution; where it sits stays in the edges; the root and workspaces keep their path. `DIGEST_VERSION` 10. Rows: `packages/vx-lockfile/tests/rehoist-identity.test.ts`; red without the fix. Landed through #2653, which was stacked on it; #2648 closed. (#2653)
- **D-141.** `bun()` folded the lockfile's `catalog` / `catalogs` into every project, so one catalog bump re-keyed them all, the root's digest (folded into every key) included. What a catalog resolved to is the `packages` entry a workspace naming `catalog:` reaches, so only that moves a key, as `pnpm()` already did; a catalog edit resolving the same version moves nothing. `DIGEST_VERSION` 11. Rows: `packages/vx-lockfile/tests/bun-catalog-precise.test.ts`; red without the fix; two `bun.test` rows that pinned the coarse behaviour updated, and their fixture's nested `is-number@6.0.0` given the real lockfile's integrity. (#2653)
- **D-142.** On a real pnpm 9 install, a `pnpm.overrides` entry only `b`'s tree reaches (`is-number` under `is-odd`) re-keyed `a` and the root; an override edit resolving the same version re-keyed every project. `pnpm()` and `bun()` folded `overrides` into every project; what an override did is the entry a project reaches, so it keys through that, as catalogs do (D-141). npm 10 does not write `overrides` to `package-lock.json` (probed), so `npm()` stops folding it. `DIGEST_VERSION` 12. Rows: `packages/vx-lockfile/tests/overrides-precise.test.ts`; red without the fix, a forced-version control; three rows that pinned the coarse behaviour inverted; bun's exclusions in one set, which `site-samples.unsafe` now holds the guide to. (#2672)
- **D-143.** On a real `bun patch is-number@7.0.0` only `b` reaches, a patch edit re-keyed `a` and the root: `patchedDependencies` and the patch bytes were install-wide. The patch now folds into the entry it names (`name@version` or bare name); one naming no entry stays install-wide. `DIGEST_VERSION` 13. Rows: `packages/vx-lockfile/tests/bun-patch-precise.test.ts`; red without the fix, a no-entry control; two rows that pinned the coarse behaviour updated. (#2684)
- **D-144.** Berry keys a path range (`portal:`, `file:`, `link:`) bound to its depender (`::locator=…`, forge's template fixture, babel's two `$repo-utils` links), and the parser trimmed a range's own trailing space off its key (forge's `p-limit: "npm:^3.1.0 "`); both lookups missed and fell back to every entry of the name, so another workspace's bump re-keyed this one (coarse, never stale). Both resolve exactly. `DIGEST_VERSION` 14. Rows: `packages/vx-lockfile/tests/yarn-bound-descriptor.test.ts`; red without the fix, a depender control. (#2698)
- **D-145.** One row per parser (pnpm 9, bun, npm v3, yarn berry): a bump in one project's closure re-keys that project and what links it, no other, and the root neither; a mutant folding `packages` install-wide fails it (bun, npm). Probed, no gap, on real installs: npm 10 v3 (an `npm:` alias, a `file:` dependency, a nested workspace, a workspace/registry clash), bun 1.4 (scoped workspaces with nested versions), pnpm 9 (`workspace:^`, an injected workspace dependency). Rows: `packages/vx-lockfile/tests/closure-per-project.test.ts`. (#2694)
- **D-152.** `vx-lock.json` was read and written through plain-object lookups. A project named `__proto__` was assigned into the map's prototype: `vx lock` said "locked 1 project config" and wrote `"projects": {}`, so `--check` failed and `--frozen` lost it. A project named `constructor` or `toString` absent from the lock read Object's member as its entry, and `--frozen` said it was "locked at undefined" and had moved. The writer now defines entries (`Object.fromEntries`) and `--frozen` reads own entries only. Rows: `lock.test.ts` › locks a project named `__proto__`; `lockfile-boundary.test.ts` › a project named like an Object.prototype member; each red without its fix. `vx lock --check` already reported such a name as not in the lock, so it is unchanged.
- **D-148.** A NUL in `cacheDir` or `affectedBase` loaded, then failed the run with Node's argument error: the cache dir's blamed the workspace's permissions, `affectedBase`'s named `args[3]`. Both are refused at load.
- **D-149.** A `pnpm-workspace.yaml` whose `packages:` list was commented out (the key left null) was refused "`packages` must be an array of glob strings"; pnpm 10.28 runs the root alone (probed). A null `packages:` now defers to `package.json`, as an absent one does (item 984). Row: `workspace.test.ts` › an empty `packages:` key defers to package.json; red without the fix.
- **D-155.** `defineWorkspace` typed `rules` as plain `WorkspaceRules`, and a generic argument skips the excess-property check: `rules: { exclusiveOutputs: false, upfrontKey: false }` type-checked and was refused only when vx loaded it. `rules` now takes the same `Known` mapping `cacheRetention` has (D-70), so the typo is a type error; `package-api.txt` gains the line (an addition). Row: `config.test.ts` › rejects an undeclared key beside a declared one, its `@ts-expect-error` unused without the fix.
- **D-153.** `cacheDir: '~'` (or `VX_CACHE_DIR=~`) was not expanded, only `~/…` was, and made a directory named `~` in the workspace; expanded, it names the home directory itself, where the cache's `*` `.gitignore` and index would land. `resolveCacheDir` now expands a bare `~` and refuses any cache directory that resolves to home (`~`, `~/`, the absolute path), naming the setting. Row: `cache-dir-home.test.ts` › refuses the home directory itself; red without the fix, a `~/.vx` control.
- **D-158.** One plugin package declared twice (`plugins: [bun(), bun()]`, probed) was refused "plugins '@vzn/vx-lockfile' and '@vzn/vx-lockfile' both claim fingerprint file 'bun.lock'", naming one package as two plugins. The refusal now names the package once, the two `plugins[]` positions, and the fix (declare it once); two different packages keep the old line. Row: `schema-doc-drift.test.ts` (the workspace-config table and its `schema.md` row); red without the fix.
