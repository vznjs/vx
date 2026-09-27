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
  `trySandboxedTrue` probe). A run that arms the sandbox likely pays it
  too; unmeasured.
- B: the unsafe suite's row "a traced sandboxed one-shot task's
  children die with vx that is descheduled after the spawn" failed once
  on PR 1254's CI (a diff that touched only a watch test); main was
  green.

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
