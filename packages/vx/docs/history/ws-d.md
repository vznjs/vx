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
- F: `vx-reapi` "RST_STREAM(INTERNAL_ERROR) reads as INTERNAL and is
  retried" failed once in a local gate, green on re-run.
- A: `tests/git-subdir-workspace.test.ts` "a modified tracked file is
  pruned…" reads the host's global git config: under
  `core.checkStat=minimal` / `core.trustctime=false` (this container's)
  A-6 trusts no OID and the sibling control fails. Isolate it
  (`GIT_CONFIG_GLOBAL=/dev/null` in the fixture's git env).

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
