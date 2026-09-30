# Workstream E (CLI and UX) — the record of merged PRs, plan 2026-09-27

## Leads (review of `src/cli/`, `src/bin.ts`, `src/util/`, 2026-09-27)

Every core verb was driven against `docs/cli.md` in a scratch workspace
(bad flags, missing values, unknown targets, a corrupt `cache.db`, a
missing `--cache-dir`, no workspace): exit codes and error lines hold.
What did not:

1. `vx upgrade`: a transfer cut after the headers (`ECONNRESET` from the
   body read) and a release document that is not JSON escaped
   `fetchOrRefuse` as a stack (E-1).
2. `vx upgrade v1 v2`: the second positional was ignored without a word (E-2).
3. `vx info --format json`: the reference's field list lacked
   `bunSupported` and `sandbox` (E-3).
4. `vx completions` offered flags each verb refuses (`watch` only the
   four it rejects; `show --run --list`; `lock --frozen`; `run --check`)
   and `vx run --chek` suggested the refused `--check` (E-4).
5. A plugin verb resolving 256 exited 0, the OS keeping eight bits (E-5).
6. Ctrl-C or Ctrl-D at the `vx run` picker printed `vx: AbortError` with
   a stack, exit 1 (E-6).
7. `vx cache prune` on a workspace that never ran created `.vx/cache`
   (E-7).
8. `vx watch buidl` printed the refusal and watched forever (E-8).

## Leads for other streams

- C: `No projects declare task(s): <name>.` from a real run goes to
  STDOUT through `log.status` (`src/orchestrator/run.ts`), while
  `docs/cli.md` § Top-level shape says "on stderr" and the `--dry` path
  (`src/cli/run.ts`) prints it on stderr as `vx run: no projects …`. A
  `2>err.log` CI step loses the one line that says why it went red.
- J: `docs/cli.md` § Plugin commands showed a plugin as a plain object
  with a `name` field, which the loader refuses. Fixed by J-9.
- C: `vx watch` reads "the initial run refused to start" off the
  result's shape (`ok: false, outcomes: []`, E-8), the only way
  `RunSummary` says it today. Carrying the unresolved names on
  `RunSummary` would make that a field instead of an inference.
- F: `packages/vx-reapi/tests/wedged.test.ts` — "RST_STREAM(CANCEL)
  reads as CANCELLED and is not retried" (F-1's control row) went red
  twice in this stream's full gates (`sent: 0` for `1`) and is green
  alone (3 of 3): a race between the proxy's cut and the count.

- A: `tests/workspace-files.test.ts` — three "workspace-wide partition"
  rows are red when run outside the gate's sandbox on a host whose
  global git config sets `core.checkstat=minimal` /
  `core.trustctime=false` (this container's): the trusted-OID read then
  distrusts every entry. The sandbox's HOME hides that config, so the
  gate is green. The fixture could pin `GIT_CONFIG_GLOBAL=/dev/null`.

- B: the sandbox runtime's init runs `getGlobalNpmPaths`
  (`generate-seccomp-filter.js`, an `execSync`), 128 ms of `vx info`'s
  321 ms (compiled binary, this repo; CPU profile of the
  `trySandboxedTrue` probe). Measured since: the `execSync` is
  `findJar` → `getJavaProxyAgentJarPath` (152 ms), plus `updateConfig`
  103 ms; in source mode that is 260 of `vx info`'s 567 ms, and a warm
  `vx run lint --all` spends 342 of 491 ms in `miss: build request`.
- B: the unsafe suite's row "a traced sandboxed one-shot task's
  children die with vx that is descheduled after the spawn" failed once
  on PR 1254's CI (a diff that touched only a watch test); main was
  green.
- B, C: the scheduler (`graph/scheduler.ts`) and the cache save
  (`cache/cache.ts`) ask `isFsRefusal` only, so a task that dies of
  `EMFILE` still reads as an internal error there; `isOutOfFds` and
  `OUT_OF_FDS_HINT` (E-50) are the one-line form `bin.ts` prints.
- C: a failed task's output is not kept: `vx last` can name the task
  and the re-run (E-55) but not show the lines that failed it. A tail
  stored with the run row would let the replay print them.
- G: `turbo()` drops Turbo's root tasks (`"//#format": {}` over a root
  `format` script) with a note that a root vx.config would make the
  root a project; `vx run format --all` then reads "No projects
  declare task(s)". Common in create-turbo repos, so "runs a Turbo repo
  unchanged" stops short there (walk, 2026-09-28).

## Merged

- E-1 — `vx upgrade`: a transfer cut mid-body and a release document
  that is not JSON are one refusal naming the host, never a stack
  (`readOrRefuse`); rows in `tests/upgrade.test.ts`, red without it.
- E-2 — `vx upgrade v1 v2`: a second tag is refused
  (`unexpected argument`) instead of dropped while the first installs;
  row in `tests/upgrade.test.ts` against a copy of the runtime.
- E-3 — `vx info --format json`: the reference's field list is held to
  the `InfoFacts` interface both ways by a drift row (J-9 had just named
  the two missing fields, `bunSupported` and `sandbox`).
- E-4 — `vx completions` offers only the flags each verb accepts (its
  Usage line; run's option lines less `WATCH_REFUSED_FLAGS` for watch),
  and `vx run --chek` no longer suggests the refused `--check`; rows
  parse every completed flag through its verb's own parser.
- E-9 — Sweep of `cli/cache.ts` and `util/size.ts` (never named): 41
  mutants, 29 caught, 1 inconclusive (the unwritable-cache refusal:
  its row is `skipIf(root)`, held by CI's non-root job), 2 equivalent
  (`cache.close()` and the run lock's release: process exit does both,
  the lock through its exit hook), 9 held now. The harmful ones: an
  unparsable `--older-than` or `--max-size` reached the prune as `null`
  (a cutoff of now; a null cap), and a `--dry-run` that stopped
  reaching the cache would have deleted with the suite green. Rows in
  `tests/cli.test.ts`, `tests/cache-prune-verb.test.ts` (new),
  `tests/schema-reset-notice.test.ts`.
- E-5 — A plugin verb's exit code must be an integer 0–255; 256 exited
  0 and -1 exited 255. Row in `tests/plugin-commands.test.ts`.
- E-6 — Ctrl-C at the run picker exits 130, Ctrl-D exits 1 with `no
task picked`; neither prints a stack. Row in
  `tests/cli-picker.test.ts` drives both through a TTY-mode interface.
- E-7 — `vx cache prune` with no cache prunes nothing, exits 0 and
  creates nothing. Rows in `tests/inspect-no-create.test.ts`.
- E-8 — `vx watch` exits 1 when its initial run refuses a name no
  project declares, as `vx run` does. Row in `tests/watch-loop.test.ts`.
- E-10 — Sweep of `cli/index.ts` and `cli/help.ts` (never swept): 30
  mutants, 26 caught, 3 equivalent under the current text, 1 unheld —
  the gate that keeps `vx <plugin-verb> --help` for the plugin. Row in
  `tests/plugin-commands.test.ts`.
- E-11 — Sweep of `cli/select.ts` (never swept): 24 mutants, 12 caught,
  2 equivalent, 10 held now — among them a directory sharing a member's
  name as a string prefix placed in the member, a typo beside an empty
  diff exiting 0 as "nothing affected", a self or negated `dependsOn`
  drawn as a graph edge, and `--affected`'s `workspaceFiles` owners
  lost when the staged load fails. Rows in `tests/select.test.ts` (new)
  and `tests/cli-picker.test.ts`.
- E-12 — Sweep of `cli/watch.ts`'s rules (the ignore predicate, the
  root-event filter, the member set, the change judgement): 22 mutants,
  15 caught, 5 equivalent (a `!`-prefixed container only a `!` path
  could match; a literal's trailing slash the ancestor rule covers; an
  absolute-root prefix no output can have; two `git check-ignore`
  readings of an empty answer), 2 held now: an event naming a relocated
  cache directory itself, and a project-directory test without its path
  separator (the E-11 class again). Rows in `tests/watch-rules.test.ts`.
- E-13 — Sweep of `cli/run.ts` (never swept): 32 mutants, 28 caught
  (the parser held every one), 2 equivalent (the `--affected` filter's
  place, which `applyFilters` no longer reads since item 979 — the
  comment claiming it did is corrected; the zero-task `--dry` branch,
  unreachable while `unresolvedTasks` answers first), 2 held now: an
  anchored spec with no project (`#build`) refused by name, and the
  picker's Ctrl-C mapped to exit 130 at the verb. Rows in
  `tests/run-exit-codes.test.ts` (new).
- E-14 — Sweep of `util/cgroup.ts` (the default worker count and the
  memory budget): 14 mutants, 8 caught, 1 untestable on Linux (the
  non-Linux branch), 5 held now — a limit or quota above the machine
  taken whole, a `memory.max` of 0 read as a budget, a cgroup path cut
  at a colon, and `cpu.max`'s period ignored. Rows in
  `tests/cgroup.test.ts`.
- E-15 — Sweep of the small `util/` files (`settle.ts`, `which.ts`,
  `procfs.ts`, `bun-version.ts`, `task-id.ts`, `hash.ts`): 18 mutants,
  16 caught, 1 equivalent (`settleWithin`'s `p.catch` after a lost
  race: `Promise.race` already subscribed to `p.then`, so a late
  rejection is handled either way — the row for it passes both ways),
  1 held now: `procfsIsOwn()` inverted, pinned against `/proc/self/stat`'s
  pid in `tests/util-procfs.test.ts` (new).
- E-16 — `vx run`'s same-stem flag hint (a third edit, so `--retries`
  reaches `--retry`) read every capped distance as three: under the cap
  of 3, `--continue-on-error` hinted `--concurrency` (nine edits) and
  `--cache-directory` hinted `--cache`. `editDistance` takes its cap and
  `nearest` caps one past its budget. Rows in `tests/cli.test.ts`.
- E-17 — Sweeps of `bin.ts`, `cli/init.ts`, `cli/core-alias.ts` (18
  mutants: 16 caught; bin's `isFsRefusal` branch inconclusive here, its
  rows `skipIf(root)` and held by CI's non-root job; bin's
  `registerCoreAlias` call changes only a compiled binary's load time,
  since the plugin marker is `Symbol.for`) and of `util/edit-distance.ts`
  on E-16 (14 mutants: 9 caught, 2 equivalent early exits, 3 held now in
  `nearMatches`: nearest-first order, containment either way and
  case-insensitively, the limit). Rows in `tests/near-miss.test.ts`.
- E-18 — Sweep of core's `util/paths.ts` (never swept; the glob
  prefixes the sandbox, the deferral gate and the warm-hit directory
  shortcut read): 25 mutants, 22 caught, 1 unreachable (`dir === '.'`,
  which `normalizeGlob` folds to `''` first), 2 held now: a brace set or
  a negation in a `<dir>/**` prefix read as a whole directory by
  `wholeSubtreePrefixes`, and an entry folding to nothing (`./`) kept
  by `asTrees` as `''` plus `/**`. Rows in `tests/output-dirs.test.ts`
  and `tests/util-paths.test.ts`.
- E-19 — `vx watch`'s poller (the fallback on a macOS sandbox, a network
  mount, a bind, or `VX_WATCH_POLL=1`) compared mtime alone, so a
  replacement carrying the old mtime (`cp -p`, `rsync -a`, a `mv`) was
  no edit to it while the OS watcher saw the rename. It samples the
  later of mtime and ctime, as `modifiedBefore` does since item 945.
  Row in `tests/watch-rules.test.ts` (`touch -r`, then a rename).
- E-20 — Sweep of the watch loop's judgement (14 mutants: 5 caught, 3
  equivalent, 1 macOS-only, 2 that only reword the notice, 1 recorded —
  a streak not reset on a different path — and 2 held now): the
  self-write window's end bound (without it an uncached task's
  git-ignored input, edited a second time after the first cycle,
  re-ran nothing) and the notice's threshold of three. Rows in
  `tests/watch-loop.test.ts` and `tests/watch-loop-selfwrite.test.ts`.
- E-21 — `vx last --list --format json` is an array of the same
  invocation objects as the replay's, newest first: documented, and
  pinned field for field in `tests/last.test.ts`.
- E-22 — `vx upgrade`'s start check (item 1097: the replaced binary must
  answer `--version`, or the previous one is put back) was an unbounded
  `spawnSync`; a new binary that hung on start held the verb forever
  with no rollback. `startedVersion()` bounds it at 10 s and a timeout
  counts as not started. Rows in `tests/upgrade.test.ts`.
- E-23 — `--report` and `--report-file` were lost on a Ctrl-C or
  SIGTERM (C's lead, 3 of 3 probes): `cli/run.ts` wrote the file with
  awaited I/O after `run()` returned, and the signal path exits once
  stdout drains. The write is now synchronous, done before that exit.
  Row in `tests/run-exit-codes.test.ts`, red without the fix.
- E-24 — `vx stats` (deprecated alias of `vx info`) said nothing of its
  deprecation. It now prints `vx stats is deprecated; use vx info` once
  on stderr; stdout stays byte-identical. Row in `tests/show-info.test.ts`.
  Also `vx run`'s exit-code table (C's lead) now names nothing
  affected (0), an unknown task and a persistent task that exits after
  ready (1), each already held by a row.
- E-25 — A plugin verb that threw a plain Error printed `vx: Error: …`
  and a stack (C's lead). It now names the plugin and verb in one line
  (`plugin '<name>' failed in command '<verb>': …`), as the other
  stages name a crash; a verb's own `UserError` keeps its one line.
  Row in `tests/plugin-commands.test.ts`.
- E-26 — Item 948's row went red on CI twice (PRs 1125, 1203; ~1.8 s,
  so after its wait). The error body never reached the log (the gate
  prints a failed shard's last lines), and 60+ local runs stayed green:
  sandboxed, as non-root, under load, all 12 shards at once, and on the
  tree before B-9. Refuted: an `afterEach` ESRCH (the servers are gone
  before it runs, even with a 1.5 s window forced), a split read of the
  notice (Bun drains the pipe whole), the server-less wording (`held` is
  unset only inside a running cycle). Cause unproven. The row no longer
  SIGKILLs vx mid-storm in its teardown: it stops watch with SIGTERM,
  asserts exit 0, and asserts no server survives (red when the stop
  skips the held server).
- E-27 — `tests/module-boundaries.test.ts` scanned static `from`
  specifiers only, and said no dynamic import crossed a boundary (J's
  lead): `bin.ts` lazy-loads the façade, and a lazy deep import such as
  `import('../orchestrator/run.js')` from `cli/` passed unseen. It now
  scans `import('…')` too; `bin → index` joins the matrix with its why.
- E-28 — `vx why` listed what changed in the key and stopped there.
  Under the rows it now says what to do, one line per changed kind
  (`WHAT_TO_DO`), held to the kinds `cache/key-fold.ts` captures in
  both directions. Rows in `tests/why.test.ts`.
- E-29 — `vx run <typo> --dry` (and `--graph`) refused with no hint,
  while the run itself names the nearest task (`Did you mean build?`)
  or how to declare one. `planRun` now returns the run's own hint
  (`unresolvedHint`) and the verb prints it. Row in `tests/cli.test.ts`.
- E-30 — Error-line audit of `src/cli` and `src/util`. Two lines named
  no fix: `vx why --run <id>` for a task that run did not run (or an
  unknown id) now points at `vx last --list` and `vx last <runId>`;
  the picker's `no tasks declared in any project` now says how to
  declare one (`tasks` in a vx.config, or `vx init`). Rows pin both
  lines exactly (`tests/why.test.ts`, `tests/cli-picker.test.ts`).
- E-31 — `cli/watch.ts` (1,613 lines) split at its one clean seam: the
  file-system side (the OS watcher and its delivery probe, the stat
  poller, `fsClockNow`, `modifiedBefore`) is `cli/watch-fs.ts`, which
  knows nothing of tasks or cycles. No behaviour change; the watch
  suites pass unchanged but for their imports.
- E-32 — A scoped project typed without its scope (`--filter vx-mcp`
  for `@vzn/vx-mcp`) refused with no hint: the whole name is many edits
  away. The hint now also matches the part after the `/`, when exactly
  one project owns it. Row in `tests/select.test.ts`.
- E-33 — Only `vx run` hinted the flag a typo meant; `vx info --formt`,
  `vx lock --chek` and the other verbs said only "unknown". The hint is
  `flagHint(verb, arg)` in `help.ts`, over the verb's own usage line,
  and every verb's refusal uses it. Row in `tests/cli.test.ts`.
- E-34 — `vx show app#bui` hinted `build`, a bare name that means a
  project or every project's task to `vx show`. It hints `app#build`,
  the spec to paste. Row in `tests/show-info.test.ts`.
- E-35 — `vx show ''` and `vx why ''` read the empty string as a query;
  it is part of every name, so the hint listed the workspace. `vx why`
  reads it as no target; `vx show` refuses it. Row in `tests/why.test.ts`.
- E-36 — `invalid concurrency: 0`, `invalid verbosity: high` and
  `invalid --dry value: yaml` now say what each flag takes, as
  `--retry` and `--continue` did. Row in `tests/cli-arg-hygiene.test.ts`.
- E-37 — `vx init` with no `package.json` here or above printed the
  lookup's "Could not find a workspace root"; it now says to create one
  (`bun init` or `npm init -y`) first. Row in `tests/init.test.ts`.
- E-38 — `vx show` in a workspace that never ran created `.vx/cache`
  (it opened the eval cache to store its evaluations), against item
  900's "a reading verb makes nothing on disk". With no cache directory
  it now evaluates without one; with one, it still stores. Also struck
  cli.md's claim that a real prune creates an empty cache (E-7 changed
  that). Rows in `tests/inspect-no-create.test.ts`,
  `tests/workspace-config.test.ts`.
- E-39 — `vx why` with no recorded run said only "no runs"; it points
  at `vx last`, or says nothing has run here yet. Row in
  `tests/why.test.ts`.
- E-40 — `cli/watch.ts` split again: which paths are events
  (`isIgnoredWatchPath`, `makeWatchIgnore`, `gitIgnored`,
  `makeRootEventFilter`) is `cli/watch-filter.ts`. No behaviour change.
- E-41 — `vx watch` with no task says the form
  (`vx watch <task>, e.g. vx watch build`). E-33's control row now
  uses `info format`, which the positional guard alone decides.
- E-42 — `vx last <id>` and `vx why --run <id>` take a unique prefix
  of the 36-char run id (`cli/run-id.ts`); a shared prefix exits 1 and
  lists its runs. Row in `tests/last.test.ts`.
- E-43 — three refusals named no next step: `vx run` with no task and
  no TTY (now the form and why no picker opened), a `--filter` typo
  beside a match (now the nearest project, as the all-missed error
  says) and a picker answer out of range (now the range). Rows in
  `tests/cli.test.ts`, `tests/select.test.ts`,
  `tests/cli-picker.test.ts`.
- Probe, refuted: CLI startup. Source mode loads one shared module
  graph (~50 ms) for every verb, `--version` included; a lazy `run.ts`
  or dropping `cli/index.ts`'s re-exports saves under 5 ms. The
  compiled binary answers `--version` in 18 ms. The cost worth cutting
  is B's sandbox init above.
- Mutation: E-38's `noCreate` guard replaced by `false` reddens
  `tests/inspect-no-create.test.ts`.
- E-45 — Mutation sweep over this stream's new guards (E-29..E-44):
  ten mutants, eight caught. Two survived and now have rows: the
  "more than 5" count of an ambiguous run-id prefix
  (`tests/run-id.test.ts`), and `vx why`'s filter that keeps a stored
  kind the map does not know from printing `undefined` (a `legacy` row
  in `tests/why.test.ts`).
- E-44 — `vx upgrade`'s failed or empty download says nothing was
  replaced and to re-run; a release without this platform's asset
  points at npm. `vx show app#` names the verb and says
  `vx show app` lists the tasks. Rows in `tests/upgrade.test.ts`,
  `tests/show-info.test.ts`.
- E-48 — `vx last --list` prints each run id cut to the shortest prefix
  no other run shares, never under its 13-char clock (`shortRunId`, two
  indexed neighbour lookups); E-42 resolves it back. Rows in
  `tests/run-id.test.ts`; dropping either neighbour or the floor
  reddens them.
- E-46 — A value-less `--filter`, `--concurrency`, `--retry`,
  `--timeout`, `--cache`, `--verbosity` or `--tag`, a bad prune duration
  or size, and a stray argument to init/last/show/why name the form
  they take. Rows pinned with `toBe`.
- E-47 — `cli/watch-set.ts`: what `vx watch` watches (`watchedProjects`,
  `sweepConfigs` → `ConfigSweep`, `memberEntries`, `sameMembers`); the
  loop in `watch.ts` decides when to re-read it. No behaviour change.
- E-50 — `EMFILE`/`ENFILE` reached the user as a stack naming a file
  that was fine; `bin.ts` prints one line with `ulimit -n`
  (`isOutOfFds`). Row preloads an EMFILE-throwing `process.cwd`.
- E-52 — `vx help <name>` for no verb here printed the whole reference
  and no hint; it is refused as `vx <name>` is (did-you-mean over core
  and plugin verbs, a moved verb's pointer). A plugin verb, or a
  workspace that fails to load, still gets the reference. Rows in
  `tests/cli.test.ts`, `tests/plugin-commands.test.ts`.
- E-49 — An OS watch limit (`ENOSPC`, `EMFILE`) made each arm print
  "cannot watch" while the loop said "watching" and never fired; the
  arm falls back to the poller with a line naming the limit to raise.
  Rows preload an `fs.watch` that refuses.
- E-51 — An empty `--run` or `--format` in `why`/`last` says what the
  flag takes, both spellings.
- E-53 — Mutation sweep over E-46..E-52's guards: seven mutants, four
  caught. Rows now hold the three that survived: the EMFILE half of the
  watch fallback, that a refusal that is not a limit (EACCES) still
  names the directory rather than polling, and `vx help <moved verb>`.
- E-55 — `vx last` replaying a failed run ends with the command that
  re-runs the failures, carrying the run's forwarded arguments. Rows in
  `tests/last.test.ts`, with an ok run as the control.
- E-54 — `vx why`'s upstream what-to-do line printed a placeholder
  (`vx why <that task>`) under a row naming the task; it prints the
  command for each dependency that moved.
- E-56 — `vx last --failed` replays the latest failed run past any
  green one since, and narrows `--list` to failures.
- E-57 — `vx watch`'s six "cannot watch" / "cannot re-read" catch
  blocks share one `sayCannot`. No behaviour change.
- E-58 — Mutation sweep of older `src/cli` guards (`--filter` empty,
  `--cache=` empty, `--timeout` zero, the empty-walk selection, the
  show `#` target, `--list`'s space form and its range): seven mutants,
  six caught. The `--list` ceiling (500) had no row; it has one.
- E-59 — Sweep of `plugin-commands.ts` and `workspace-config.ts`: five
  mutants, four caught. The survivor, `vx help`'s dedup of a verb two
  plugins declare, was unreachable (the load refuses two owners); it is
  gone, and a row pins the refusal through the CLI.
- E-60 — Sweep of the watch helpers: six mutants, four caught. A
  persistent task not counting as a project that reads what it likes
  (`uncached`) had no row; it has one. `watchedProjects`' whole-scope
  shortcut survives as an equivalent mutant: the walk returns the same
  set.
- E-61 — Sweep of `help.ts` and `bin.ts`: five mutants, four caught.
  `documentedFlags` reading only the flag an option line opens with
  survived (today's prose names only run's own flags); it takes the
  text now and a fixture row pins it.
- E-62 — Sweep of `info.ts` and `completions.ts`: five mutants, four
  caught. The survivor, completions skipping a plugin verb named like a
  core one, was unreachable (the load refuses the shadow, pinned in
  `tests/plugin-commands.test.ts`); it is gone.
- E-63 — `cli/watch-judge.ts`: what counts as a change (the settled
  state gate, the self-write window, the git-ignored rule for uncached
  projects, the 3-cycle notice) is `ChangeJudge`; the loop keeps when
  to judge and what to run. `watch.ts` 950 → 818 lines. No behaviour
  change.
- Sweeps of `util/num.ts` and `util/timing.ts`: ten mutants, ten
  caught. With E-45..E-62 every file in this stream's slice has had a
  sweep batch.
- E-64 — `cli/watch-fs.ts`: `WatcherPool`, the watchers a loop holds
  (arm, the first-event proof, close-all), out of `watch.ts` (818 →
  743 lines). No behaviour change.
- E-65 — `schemas/{show,info,why,last}.json`: each read verb's
  `--format json` as a checked-in JSON Schema, shipped. A test holds
  every output to its schema (closed key sets), every declared field
  to some output, and each object's keys to its source type through
  the compiler (`keys<T>`), so a field added to `InfoFacts` fails until
  the schema names it. A hundred-line subset validator in
  `tests/helpers/json-schema.ts`; no dependency.
- E-66 — `vx init`'s report groups its TODOs by reason (ids, first
  five then a count; sveltejs/kit printed 139 lines of two reasons),
  says when no task caches that a TODO's cache block makes the second
  run hit, and its header note no longer names a `build` TODO that a
  repo with no `build` script never got (nrwl/nx-examples: "carries a
  TODO" over "0 TODOs"). From the first-five-minutes walk below.
- E-67 — the duplicate-package-name refusal gives root-relative paths
  in a stable order and the way on: rename one, or a `!` workspace
  glob. sveltejs/kit (pnpm accepts two test apps of one name) died on
  the first command with two absolute paths and no next step.
- E-68 — `vx cache prune --format json` and `schemas/cache.json`
  (dryRun, evicted, bytesFreed, orphans, orphanBytes), held by the E-65
  test; the one read-ish verb that had only prose.
- E-69 — `vx init`'s `next:` line names the runner that started it
  (`npx vx run …`, `bunx @vzn/vx run …` with nothing installed); a bare
  `vx` only with no runner. From `npm_config_user_agent`, probed per
  runner (plain `bun file.ts` sets none).
- E-70 — `vx history --format json` (@vzn/vx-schedule-history) gets
  `schemas/history.json`: the plugin's suite holds its keys to its
  types, core's unsafe suite the printed output to it; the plugin's
  test key folds `schemas/**`.
- E-71 — `vx run --dry=json` gets `schemas/plan.json`; `PlanTaskJson`
  types the wire; an end-to-end and a hand-built plan held to it.
- E-72 — `--summarize` gets `schemas/summary.json`; `SummaryTaskJson`
  and `RunSummaryJson` type the writer (it built a
  `Record<string, unknown>`).
- E-73 — `vx init` beside `turbo.json(c)` or `nx.json` writes only
  `vx.workspace.ts` declaring `turbo()` / `nx()` (turbo wins), and a
  `next:` line that installs what the file imports with the lockfile's
  manager and runs the build. `@vzn/vx-migrate` is not on npm yet, so
  that install fails until it is published.
- E-74 — `cli/foreign-flags.ts`: every Turbo `run` and Nx
  `run-many`/`affected` flag on `vx run` is same, an alias rewritten
  before the parse, or a refusal naming the vx spelling; `vx run-many`
  and `vx affected` point at `vx run`. cli.md's table is rendered from
  it and pinned; `--graph=x.svg` no longer writes DOT into an `.svg`.
- E-75 — a task typed as a verb (`vx build`, `vx build app`,
  `vx app#build`) is refused with its `vx run`; a plugin verb of the
  name still wins.
- E-76 — `vx run --help` names the Turbo and Nx spellings and links
  the table; the no-service `vx dev` row runs outside the repo, whose
  own `dev` task met E-75's line (red only outside the gate's sandbox).
- E-77 — `vx watch` keeps each task's inputs apart, less its own
  outputs and their directory, as the key reads them: a `turbo()` task
  reading `**/*` took its own `dist/` for an edit, and every save ran
  one more up-to-date cycle.
- E-78 — the footer ends with a `result` row, the run in one line:
  `42 tasks · 38 cached (90%) · 3.20s`, `all cached` when every task
  hit, `N failed` after the count. About 5 µs per run.
- E-79 — Nx's `vx run web:build` names `vx run web#build`, from the
  root (it said "not inside a project") and as the unresolved name's
  `Did you mean`. Found walking `vx init` → run → second run on a
  Turbo fixture; the rest of that walk read clean.
- E-80 — `vx init` in a Turbo or Nx repo that shows a remote cache
  (turbo.json `remoteCache`, or CI setting `TURBO_TOKEN` /
  `NX_SELF_HOSTED_REMOTE_CACHE_SERVER`) declares `turboCache()` /
  `nxCache()` too, naming the file; before, the repo's CI ran vx
  without the remote cache it already had.
- E-81 — the `result` row counts cached over the tasks that have a
  cache; the rest read `N no-cache`: `vx run dev` said
  `0 cached (0%)` for a task that could never hit.
- E-82 — the footer's projects legend reads `N in run · M total`: it
  said `affected` on every run, which a Turbo user reads as git-changed
  on a plain `--all`.
- E-83 — `vx watch <task>` judges inputs of the tasks it reaches only:
  over a `turbo()` package, `vx watch build` re-ran once more on each
  save because `lint`'s `**/*` took build's own `dist/` for an edit.
- E-84 — `vx run` with no task and no terminal names the tasks here
  (`tasks here: build, serve, test`) instead of guessing `build`. The
  Nx walk (synthetic graph, a stand-in `nx` bin) read clean otherwise:
  init → run → all cached, `vx build app`, `app:build`, `-t`/`-p`,
  `--parallel`, `--skip-nx-cache`, `--exclude`, `vx show`.

## First-five-minutes walk (2026-09-28)

`bunx @vzn/vx@latest init` (0.0.122) on t3-oss/create-t3-turbo,
nrwl/nx-examples and sveltejs/kit (a pnpm workspace, no orchestrator).
Running a clone's own scripts was refused in this container, so the
walk stops at init/show/`--dry` there; a run and its warm hit are
walked on fixtures.

- Turbo: 11 configs written though the note says turbo.json was not
  read and names `vx-migrate`; 13 TODOs as 13 long lines (E-66); no
  task caches, so the `next:` run can never hit (E-66). The `next:`
  line names `vx`, which a `bunx` user does not have on PATH (E-69).
- Nx: one root `codegen` script, 0 TODOs, and a header saying `build`
  carries one (E-66).
- sveltejs/kit: the first command refuses — two test apps share a
  package name (pnpm accepts it) — and the refusal names no way on (E-67).
  With one excluded: 354 tasks, 139 TODOs of two reasons (E-66).
- The README's npm path, end to end on a fixture: install with npm,
  `npx vx init`, paste the TODO's cache block, then a miss, an
  up-to-date run, and a local restore after `rm -rf dist`.
- Leads, not taken: in a Turbo repo `vx init` writes configs though
  `turbo()` runs it unchanged (whether init should offer the plugin
  instead is the owner's call); the summary says `up-to-date` where
  `vx last` says `cache-hit` for the same run.
- **E-85.** CLI startup. `vx --version` spent 49 of its 65 ms importing
  the run path: `cli/index.ts` imported `run.js`, the plugin-verb lookup
  and the task-verb hint statically, and re-exported every verb's
  parser for tests, so each start loaded every verb. The dispatcher now
  imports each verb, `run` included, and those lookups on use; tests
  import a parser from its own file. Interleaved A/B against an
  origin/main worktree, three rounds of min-of-5: `--version` 58–65 ms
  → 24–26 ms; a warm two-task no-op `vx run` unchanged (126–134 ms both
  arms, one pre-warmed copy each), as it needs the same modules.
