# Shipped, 2026-09 — improvement-loop items 779–819

The record `docs/STATUS.md` carried until 2026-09-25, moved here whole
when the loop passed forty items (item 826). A PREFIX,
as item 373 set the rule: the formatter renumbers an ordered list
sequentially, so a cut from the middle would renumber every entry below it
and break the cross-references that cite item numbers here, in STATUS and
in the test comments.

Items 1–64 in
`2026-09-review-arc.md`, items 65–104 in
`2026-09-improvement-loop-65-104.md`, items 105–144 in
`2026-09-improvement-loop-105-144.md`, items 145–202 in
`2026-09-improvement-loop-145-202.md`, items 203–242 in
`2026-09-improvement-loop-203-242.md`, items 243–281 in
`2026-09-improvement-loop-243-281.md`, items 282–305 in
`2026-09-improvement-loop-282-305.md`, items 306–332 in
`2026-09-improvement-loop-306-332.md`, items 333–352 in
`2026-09-improvement-loop-333-352.md`, items 353–372 in
`2026-09-improvement-loop-353-372.md`, items 373–392 in
`2026-09-improvement-loop-373-392.md`, items 393–412 in
`2026-09-improvement-loop-393-412.md`, items 413–432 in
`2026-09-improvement-loop-413-432.md`, items 433–452 in
`2026-09-improvement-loop-433-452.md`, items 453–472 in
`2026-09-improvement-loop-453-472.md`, items 473–492 in
`2026-09-improvement-loop-473-492.md`, items 493–512 in
`2026-09-improvement-loop-493-512.md`, items 513–532 in
`2026-09-improvement-loop-513-532.md`, items 533–552 in
`2026-09-improvement-loop-533-552.md`, items 553–572 in
`2026-09-improvement-loop-553-572.md`, items 573–591 in
`2026-09-improvement-loop-573-591.md`, items 592–611 in
`2026-09-improvement-loop-592-611.md`, items 612–631 in
`2026-09-improvement-loop-612-631.md`, items 632–654 in
`2026-09-improvement-loop-632-654.md` (655–713 are handoff entries in
`2026-09-status-next-log.md`; the audit's 714–718 were dropped, as that
file records), items 719–743 in
`2026-09-improvement-loop-719-743.md`, items 744–778 in
`2026-09-improvement-loop-744-778.md`; items 820 onward continue in
`docs/STATUS.md`.

779.  DONE (2026-09-25, a hazard the `cli/upgrade.ts` sweep found). The
      source-mode row of `tests/upgrade.test.ts` spawned `process.execPath`
      (the host's Bun) on `src/bin.ts upgrade`, and the one guard between
      it and `replaceBinary(process.execPath)` is `isCompiledBinary()`.
      With that guard mutated to always-true, `vx upgrade` downloaded the
      real v0.0.21 release and renamed it over the container's Bun. The
      row now copies the runtime into its temp dir, spawns the copy and
      asserts the copy's SHA-256 unchanged: under `if (false) {` it is red
      (the copy was replaced) and the host Bun's digest is unchanged, run
      in a scratch worktree. The rest of the suite reaches `upgradeCmd` only
      in process (`tests/cli.test.ts`'s help and bad-flag rows), where the
      unknown-flag refusal and `isCompiledBinary()` would both have to
      break to reach the download. The rule is in CLAUDE.md.
780.  DONE (2026-09-25, sweep of `cli/upgrade.ts`, never named). 24
      mutations, 14 caught, 10 held now, each red against its mutant
      over `tests/upgrade.test.ts` + `tests/cli.test.ts`: `npmOwnedBinary`
      of a bare `…/node_modules` returned '' instead of `node_modules` (U7);
      the `(unknown)` tag of a release document with no `tag_name` (U8,
      now an exact message); an asset with no download url, and one with
      '' (U10, U11); a digest one hex digit too long, which the dropped
      `$` anchor accepted (U12); an empty body whose published digest is
      sha256('') installed a zero-byte executable without the emptiness
      refusal (U18); an upper-case expected digest refused a good
      download (U19); a failed rename left its `.upgrade-*` temp file
      (U21) or surfaced as a raw error (U22) — driven by a non-empty
      directory at dest; and `vx upgrade --forse` joins the bad-argument
      table (U23).
781.  DONE (2026-09-25, sweep of `util/errors.ts`, E9 onward). 19
      mutations over the eight files that assert its sentences; with the
      new rows all 19 are caught. Before them, `isFsRefusal` dropping its
      permission half (E9) was held by no row, `isExecutableMissing`
      read as always-true (E14 — a git that ran and failed would say
      "install git") and `gitSpawnRefusal` losing `(working dir: …)` (E15)
      survived, and `isTmpdirRefusal` had no unit row at all: its code
      gate, path-over-message choice, realpath, both `includes` and the
      non-Error guard were held only where `tests/tmpdir-refusal.test.ts`
      drives ENOENT end to end. Rows in `tests/user-error-classify.test.ts`,
      with TMPDIR pointed per row at a canonical dir, a symlink to it
      (macOS's `/tmp` → `/private/tmp`) and a missing one. Two fixture
      files skip rows as root here (`cache-dir-selection` 4,
      `inputs` 1); no verdict rests on them.
782.  DONE (2026-09-25, sweep of `cli/plan-format.ts`, never named). 45
      mutations over the ten files that assert its sentences, 40 caught,
      4 held now, 1 equivalent (`executes > 0` beside
      `executes > p.unknownCount`, a count that is never negative). Held
      now: one hit read "1 cache hits"; a plan with more than three eager
      refusals listed all of them, or dropped its "…and N more" line; and
      a prediction whose every would-run task has history grew a
      "0 tasks without history" tail. Three rows in
      `tests/plan-format.test.ts` (the refusal row with a three-refusal
      control), each red against its mutant.
783.  DONE (2026-09-25, sweep of `util/timing.ts`, never named). 16
      mutations; the dry-run file held 2 (the off switch on an empty
      variable, and the span section). The module reads `VX_TIMING` at
      import, so the new `tests/util-timing.test.ts` drives a child per row:
      the table's own-share arithmetic, span accumulation (count, total,
      largest first, the caveat line), no span section without spans, no
      table without marks, and off when unset or empty, with a span as the
      shared no-op. Now 14 are caught; `mark` recording while off (T3) and
      `printTimings` without its `enabled` test (T9) are each invisible
      alone, and the pair is held. The header claimed marks were
      cumulative from process start. They are from the module's load, which
      is also what `benchmarks.md` says, so the comment now says so, and a
      row (50 ms of child work before the import) pins the origin.
784.  DONE (2026-09-25, sweeps of `util/ulid.ts`, `util/num.ts`,
      `cli/format.ts` and `workspace/load-reads.ts`, never named). 2, 9, 1
      and 5 mutations, every one caught: a UUIDv4 or a constant id, each
      `clampInt` / `parseDecimalInt` guard and the timer ceiling, the
      `formatBytes` re-export, and the load's memo and its probe
      (`tests/read-once.unsafe.test.ts` holds the memo and both sets;
      `fingerprint.test.ts` and `syscall-repeats` the probe). No change.
785.  DONE (2026-09-25, the trim the loop passed forty at). Items
      744–778 moved to `docs/history/2026-09-improvement-loop-744-778.md`
      in this commit. What that stretch was: why Turbo won warm at size
      and the upstream bug survey (744–745); the Next 19–22 fixes (the
      graph at 50,000 deep, Yarn 4 catalogs, a dangling output-root link,
      the remote-cache warning, three stale-hit edges, a sandboxed
      `kill 0` and the TERM grace, 746–752); the warm-path profile at 476
      packages, its A/Bs and the Linux rows re-run (753–758, 772); the
      unswept-file pass (the run lock's double hold and the
      fingerprint watch's stale hit, 759–763); the `baseAllowWrite` seam
      (771); and the mutation sweeps of files STATUS had named once or
      never (765–770, 773–778). Next trim when the loop passes forty.
786.  DONE (2026-09-25, sweep of `cache/output-index.ts`, never named in
      a sweep; the proofs a cache hit runs before it skips a restore). 27
      mutations over the 17 files that name it or assert what a hit
      restores: 17 caught, 5 held now, 5 equivalent. Held now, each by a
      row in `tests/output-dirs.test.ts` that fails against its mutant:
      the size half of the file check (the mtime half masked it, so a
      different size under a forged identical mtime read current);
      a missing output file read current (masked twice in `run()`: the
      removal bumps its directory, and the glob drops the path); a
      re-save kept the previous save's file rows beside its own; a
      recorded directory replaced by a file with every mtime forged read
      current; and a flushed snapshot stayed pending, so each later flush
      wrote it again over the rows another process had since stored. None
      of the five is a stale hit as `run()` drives it today: each needs a
      forged mtime or is masked by another proof, and the last only costs
      a walk. Equivalent: the empty-list early return (SQLite answers
      `IN ()` with no rows), the walk's `isDirectory` guard (a file
      prefix fails at `readdir` the same way), `!isSymbolicLink()` beside
      a `Dirent`'s own `isDirectory()` (which does not follow links), the
      absent-prefix return (a real directory's mtime is never within 1 ms
      of −1), and the empty-flush return (an empty transaction).
787.  DONE (2026-09-25, sweep of `exec/kill-tree.ts`, never named in a
      sweep). 24 mutations over the 13 files that assert what a kill
      reaches: 11 caught, 10 held now, 3 unreachable. The new
      `tests/kill-tree.test.ts` holds, each row red against its mutants:
      the channel gets the signal's bare name (`TERM`; the in-sandbox
      watcher runs under the runtime's bash, which takes `SIGTERM` too,
      but dash refuses it) and the group gets nothing; a closed channel
      leaves the table (a later kill would write to a reused descriptor)
      and closes its descriptor; a child with no pid signals nothing (a
      kill of `-0` names vx's own group); ESRCH ends the kill and EPERM
      falls back to the child; `untilGroupsGone` counts a group it may
      not signal as still there, polls nothing for a child with no pid,
      and reads a live member named `a) Z 9 9` as live (a parse from the
      first `)` read it as a zombie and left it un-killed; that row is
      `tests/kill-tree-proc.unsafe.test.ts`, since only an unsandboxed
      run owns the `/proc` it parses). The
      `procfsIsOwn()` gate in `groupAlive` survived every bare run and is
      held only in the sandbox: under `@vzn/vx#test.bun.shard-12`, run
      sandboxed in a worktree, dropping it turned four
      `task-tree-kill` / `armTimeout` rows red, and the unmutated shard
      is 446 pass, 0 fail. Unreachable from a row: `/proc` unreadable
      right after `procfsIsOwn()` read it, the non-digit entry skip (a
      cost), and the transient `X` state.
788.  DONE (2026-09-25, found gating 787). Three `isTmpdirRefusal` rows
      (item 781) went red once the new test file re-dealt the shards and
      put `timeout-bounds.test.ts` ahead of `user-error-classify.test.ts`
      in one process. `timeout-bounds` restored its environment with
      `process.env = { ...saved }`, which DETACHES `process.env` from the
      process environment: every later write in that process lands on a
      plain object that `os.tmpdir()` never reads, so the rows' TMPDIR
      went unseen. Reproduced with the two files alone; the fix restores
      in place (`tests/helpers/env.ts`), in `timeout-bounds`, `colors`
      and `vx-github`'s own suite (a local copy: a plugin's tests do not
      read core's), the three places the pattern stood.
789.  DONE (2026-09-25, sweep of `cli/why.ts`, never named in a sweep).
      33 mutations over the 14 files that assert its sentences: 17
      caught, 15 held now, 1 equivalent (`previousRun == null` against
      `=== null`: the query answers null, never undefined, once `found`
      holds). The suite asserted `vx why`'s output with `toContain`, so
      its shapes went unseen. New rows in `tests/why.test.ts`, each a
      whole line or message, with a fixture of five projects:
      - Resolution: a bare name matches the whole task name
        (`lint` is not `prelint`); several projects are listed to pick
        from; a typo hints three, not all; an anchored id with no runs
        and no near miss gets no empty "did you mean"; the anchored form
        keeps its own message; a missing target is one line, not a
        TypeError.
      - The diff rows: `+` and `-` signs; the change word padded to 7;
        the kind to the longest.
      - An older database: a NULL `cache_hit` is not called
        "executed"; a changed key with no entry inputs prints its
        `detail` line; runs with no run id fall back to the latest
        entry, in both formats, and to "(no cache entry either)".
        And `tests/schema-reset-notice.test.ts` shows `vx why` prints the
        reset notice too.
790.  DONE (2026-09-25, sweep of `workspace/migration.ts`, the seam
      `vx init` and `@vzn/vx-migrate` share, never named in a sweep). 42
      mutations over `init`, `cli` and the site samples in core and
      `migrate`, `turbo`, `nx`, `script-command` and `paths` in
      vx-migrate (run with the worktree's own `@vzn/vx` linked in, so the
      plugin's suite saw the mutant): 23 caught, 19 held now by the new
      `tests/migration.test.ts`, which drives `applyMigration` with
      hand-made plans. Held now: a carriage return left raw in a
      generated literal (a line terminator: the file would not load);
      both "nothing to migrate" messages; no config for a project with no
      tasks; `vx.workspace.js` counts as a workspace file; a hand-written
      config of another extension refuses the write, and one beside a
      project with no tasks does not; a skipped target (null task, no
      TODO) is not counted clean; the report's singulars and its colon;
      the dry-run file header; `next:` names `build` wherever it sits,
      else the first task; and the renderer's `null`, dropped
      `undefined`, `{}` and key quoting.
791.  DONE (2026-09-25, sweep of `cache/archive.ts` beyond
      `assertSafeName`, which item 485 swept). 44 mutations over the 21
      files that pack, scan or restore an artifact: 27 caught, 3 held now
      by `tests/archive-extract-meta.test.ts`, 14 that no row can tell
      apart. Held now:
      - An artifact with no sidecar scans to its header's mtime, not 0.
      - A header mtime of 0 is unknown, so the restored file keeps the
        time it was written rather than 1970.
      - The sidecar's mode is applied whatever the umask made the temp
        file: the chmod is skipped only when the temp already has the
        mode, and a skip keyed to a fixed 0644 would restore a 0644
        output as 0664 under umask 002.
        Not distinguishable from a row:
      - Masked: the packed-size check (`tarPack` already refuses a body
        that grew or shrank since the plan, both probed); the lexical
        containment check (`assertSafeName` refuses the names first);
        the empty-rest guard (the tar reader strips `outputs/`'s slash,
        so the name has no namespace).
      - Unreachable: a non-finite usage in the sidecar (JSON carries
        none).
      - Costs, not outcomes: the directory memos, the buffer against
        stream choice at 4 MiB, the one-part fast path, the in-flight
        byte bound, the cancelled pack generator's `return`.
      - The same outcome another way: the second `mkdir` rethrows the
        code the first did; the prune loop ends at its top either way;
        a link cycle is refused at hop 400,000 as at 40, only later.
792.  DONE (2026-09-25, sweep of `cache/layered-cache.ts` beyond the
      degrade paths and temp cleanups item 489 swept). 44 mutations over
      the 15 files that drive the remote seam, the vx-migrate wires and
      vx-reapi's plugin suite among them: 32 caught, 11 held now by rows
      in `tests/layered-cache.test.ts`, 1 equivalent (`close()` clearing
      its failure classes; a run closes the layer once). Held now:
      - The upload pool is four wide and the fifth waits (a pool of one
        passed everything).
      - A `get()` that joins an in-flight pull after `markRemoteAbsent`
        still waits for it: the existing row held the pull's own promise,
        which survives the clobber, not the joiner.
      - A pulled entry carries the caller's task id, and an upload carries
        the entry's duration.
      - `has()` with remote reads off never probes.
      - A `hasMany()` resolving `undefined` is no batch info, not
        `undefined`.
      - The messages: a `{ body: null }` named as `null`, a thrown string
        as its own text, an empty endpoint printed as none, a bare origin
        printed without a trailing slash, and with no reporter the line on
        stderr.
793.  DONE (2026-09-25, sweeps of five small never-named utilities).
      `util/task-id.ts` 3 of 3 and `util/bun-version.ts` 6 of 6 caught.
      `util/which.ts`: 7, 6 caught, 1 equivalent (the error's `path`,
      whose one reader, `isTmpdirRefusal`, never finds the temp
      directory in a bare tool name). `util/verbs.ts`: 6, 3 caught, 3
      held now. Dropping `completions`, `help` or the `stats` alias from
      the verbs a plugin may not declare survived every row, and each
      would have let a plugin verb load and sit dead behind the
      dispatcher. `tests/dispatched-verbs.test.ts` reads the list
      against the dispatcher's own `case` labels in both directions.
      `util/procfs.ts`: 4, none caught bare:
      - The `/proc/self` comparison is held only in the sandbox: under
        `@vzn/vx#test.bun.shard-12`, run sandboxed in a worktree,
        dropping it turned the four `task-tree-kill` / `armTimeout` rows
        red that item 787's gate mutant did.
      - The memo is a cost.
      - The Linux test is equivalent, since `readlink` throws elsewhere.
      - The unreadable `/proc` answer (false, not true) differs only
        where `/proc` is missing: macOS, a job this gate cannot run.
794.  DONE (2026-09-25, sweeps of `exec/sandbox-paths.ts` and
      `orchestrator/persistent.ts`, never named in a sweep).
      `sandbox-paths.ts`: 12 mutations, 8 caught, 4 equivalent, no
      change. The equivalent four are the root guard of `toRealPath` (a
      realpath of `/` never fails), the exact-member fast path and
      `abs === a` in `isUnderAny` (the set lookup answers both first),
      and `absolutize` normalising an absolute path. That last was
      probed rather than assumed: every caller passes its answer through
      `toRealPath`, whose realpath or `path.join` fallback resolves `..`
      whether or not the path exists (`/tmp/no-such/../secret` →
      `/tmp/secret`).
      `persistent.ts`: 10 mutations, 5 caught, 4 held now, 1 equivalent
      (the empty early return; `untilGroupsGone([])` resolves at once).
      Every e2e row sets `VX_KILL_GRACE_MS`, so the default grace was
      free: 60 s passed as well as 2 s. The new
      `tests/persistent-shutdown.test.ts` holds:
      - The default grace, unset: a SIGTERM-ignoring child is SIGKILLed
        in 1.9–8 s.
      - The SIGTERM before the wait: a server's TERM trap cleans up.
      - The await of the killed children's exits.
      - A surfaced (not requested) persistent task is kept alive in the
        foreground.
795.  DONE (2026-09-25, sweep of `cli/workspace-config.ts`, never named
      in a sweep: the workspace every reading verb sees). 12 mutations
      over the 16 files that read a cache or a staged load: 8 caught, 4
      held now.
      - `--cache-dir=-x` is a path (only the space form refuses a
        dash-led value, where an empty variable would swallow the next
        flag).
      - A relative `--cache-dir` resolves against the working
        directory, as `vx run`'s does, in the new
        `tests/workspace-config.test.ts`.
      - The staged load `show`, `watch` and the picker share opens the
        evaluation cache: a pure config has no side effect to count
        evaluations by, so the row reads `config_evals` after one
        `vx show`, and without the store every reading verb re-evaluated
        every config.
      - That same load prints the schema-reset notice: a `vx show` row
        beside `vx why`'s in `tests/schema-reset-notice.test.ts`.
796.  DONE (2026-09-25, sweeps of `cli/plugin-commands.ts` and
      `cli/completions.ts`, never named in a sweep).
      `plugin-commands.ts`: 11 mutations, 5 caught, 5 held now, 1
      equivalent (listing a verb once in help: the schema refuses two
      plugins on one verb). Held now in `tests/plugin-commands.test.ts`:
      - A verb only a later plugin declares is found (a `break` for the
        `continue` stopped at the first plugin without it).
      - A plugin verb's `ctx.warn` reaches stderr.
      - The help line's padding.
      - A broken workspace offers no plugin verbs.
      - The load error is its message, not its class name in front of
        it.
        `completions.ts`: 15 mutations, 4 caught, 10 held now, 1
        equivalent (the dedup against plugin verbs, which can never repeat
        a core one). The suite read the scripts as text; the new rows run
        the bash script in bash and read `COMPREPLY`:
      - The first word's verbs.
      - `cache prune` and the three shells after `completions`.
      - Only `--help` after a plugin verb.
      - An unknown verb offering nothing even after a call that offered
        something (`COMPREPLY` is global).
      - The early `return` at the first word, without which the `*)`
        arm wiped the verb list.
        Also held: the zsh verb list as words, the order `vx completions`
        emits (core verbs, `help`, `version`, then plugin verbs), and its
        refusals of a second shell.
797.  DONE (2026-09-25, sweeps of the last five `src/` files no sweep
      had named, each read sound in items 761–762: `workspace/nested-dirs.ts`,
      `util/tail.ts`, `util/settle.ts`, `orchestrator/colors.ts`,
      `graph/dependency-spec.ts`). 42 mutations, 32 caught, 4 held now, 6
      equivalent. With this item every non-index file under `src/` has
      been named by a sweep.
      - Held now, in `tests/dependency-spec.test.ts`:
        `compileTaskPattern`'s escaping (an unescaped dot matched `buildx`
        for `build.*`) and its anchors (`prebuild.x`, and
        `build.bun.linux` for `build.bun`); `isTaskPattern` for a `*`
        anywhere, not only first; `pkg#task` splitting on the first `#`,
        so `a#b#c` is task `b#c`.
      - Equivalent: in `nested-dirs.ts`, the empty early return and
        `break` against `continue` past the prefix block (same result,
        more scanning); the one-chunk fast path in `tail.ts`;
        `void p.catch` in `settleWithin` (`p.then` already attaches a
        handler, so a late rejection is handled either way); in
        `colors.ts`, the colour memo (a cost) and `if (color)` (an empty
        colour's ANSI code is `''`).
798.  DONE (2026-09-25, sweep of `@vzn/vx-lockfile`'s `bun.ts`, the
      parser this repo declares; no plugin package had been swept). 23
      mutations over `bun.test.ts` and `npm.test.ts`: 10 caught, 13 held
      now. Every survivor was an input the per-workspace digest did not
      provably read, which is a stale hit on every run that changes only
      that input. Held now, in `tests/bun.test.ts`, each row changing one
      input and naming the workspaces whose key must move:
      - An optional or peer dependency is followed like any other.
      - The integrity alone moves a package (a republish, a git
        dependency's new commit), including past a non-empty registry
        field, where `find` took the registry URL for the resolution.
      - The install-wide `configVersion`, `patchedDependencies` and
        `catalogs` each move every workspace.
      - Resolution walks up level by level: `x/y`'s `z` is `x/z`, not
        the root's.
      - From a scoped package an unscoped `y` is never `@s/y`.
      - An unresolved dependency still folds its specifier, from a
        workspace and from a package.
      - A workspace that depends on the root package (`ws@workspace:`)
        folds the root's reach.
      - A non-tuple entry is passed over, not a crash.
        `npm.ts`, `pnpm.ts` and `yarn.ts` are next, one item each.
799.  DONE (2026-09-25, sweep of `@vzn/vx-lockfile`'s `npm.ts`, as 798
      did `bun.ts`). 18 mutations over `npm.test.ts` and `bun.test.ts`: 7
      caught, 8 held now, 3 equivalent. Held now, in `tests/npm.test.ts`,
      each row changing one input:
      - An optional and a peer dependency are followed.
      - `version`, `resolved` and `integrity` each move a package alone:
        the fixture moved all three together, so any one could drop out.
      - The level-by-level walk through nested `node_modules`.
      - An unresolved dependency's specifier and a dangling link's target
        are folded.
        Equivalent:
      - The link test's operand order.
      - A link entry's dependency pass: npm writes a `link: true` entry
        with no dependency map.
      - The node's path in its material: what a workspace can import is
        its reach, and a package moved without a byte or an edge changing
        names the same bytes.
800.  DONE (2026-09-25, the ledger's `remote:large-upload` row,
      nx#36943 / nx#30335, untested → covered). The 2 GiB artifact
      ceiling was a module constant, so no test could reach it. It is
      now `Cache`'s `artifactCeiling`, set only through
      `RunOptions.artifactCeiling`; no config, flag or variable reaches
      it. The save refuses an output set whose tar is past it from the
      plan's stats, before a byte is compressed. The run stays green,
      and one status line names the task, the packed size and the
      ceiling. Before this, the scan found the same overage only after
      the whole compress and a decode (6 to 14 s on the 2.2 GB probe),
      and it called the task's outputs a corrupt artifact.
      Six mutations, all caught: the precheck alone and with the scan's
      cap, the scan's cap alone (an ingest's only guard), the restore's
      cap, the threading in `prepare.ts`, and `>` → `>=`. The ledger has
      no `untested` row left, and its law's verdict set drops the name.
      `tests/artifact-ceiling.test.ts` holds five rows:
      - the refusal at save;
      - its control;
      - exactly the ceiling is cached and hit (inclusive, as at restore);
      - a restore under a lowered ceiling fails loudly (a local fault,
        not a miss);
      - an ingest past it never lands.
801.  DONE (2026-09-25, the ledger's `signal:parent-sigkill-orphans-children`
      row, turborepo#9666). The ask was to evaluate util-linux
      `setpriv --pdeathsig KILL --` in front of every task. Measured and
      refuted:
      - It costs 3.6 ms against 2.4 ms per spawn (min of 400,
        interleaved).
      - A 300-project `test --all --no-cache` run (600 tasks) took
        3,865 ms against 3,631 (+6.4%, min of 9, interleaved).
      - The death signal reaches only the process it was set on and does
        not survive a fork. `sh -c 'x & wait'` lost the shell and kept
        `x`, and an exec'd command died while its children lived on, so
        a `dev` script's runner goes and its server stays.
        The probe found the real gap on the sandboxed path. bwrap already
        passes `--die-with-parent`, but its parent was the spawn's shell,
        which outlived vx. `wrapSandboxedCommand` now returns
        `exec bwrap …` on Linux, so bwrap is vx's own child and the pid
        namespace goes with a `kill -9` of vx, a `setsid` child included.
        The new unsafe row fails without the `exec`, and its control
        (unsandboxed, both children survive) pins the limit that remains.
        A strace-traced one-shot spawn keeps strace as bwrap's parent; a
        persistent task is never traced. The ledger row becomes
        `open (limit: unsandboxed)`, and kill-tree.md and
        sandbox-runtime.md record the numbers.
802.  DONE (2026-09-25, sweep of `@vzn/vx-lockfile`'s `pnpm.ts`, as 798
      and 799 did `bun.ts` and `npm.ts`). 35 mutations over
      `pnpm.test.ts`: 13 caught, 19 held now, 2 equivalent, and 1 bug.
      The bug was a stale hit. A v9 `file:` directory dependency is keyed
      `name@file:…` (`pnpm@9 install --lockfile-only` writes it so), but
      `snapshotKey` took the bare `file:…` version first. The directory
      became a leaf, and a bump behind it moved no digest. The
      generation's own key now comes first; v5/v6, which key it by the
      bare version, reach it through the fallback. Held now, in
      `tests/pnpm.test.ts`, each row changing one input:
      - a bump behind a v9 and a v6 `file:` dependency;
      - lockfiles below v5 refused;
      - a single-package lockfile's top-level dependencies;
      - four patch shapes: a scalar, a record with no hash, one keyed
        `name@version`, and a scoped package named alone (v9 and v5);
      - `settings`, `overrides`, `packageExtensionsChecksum`,
        `ignoredOptionalDependencies` and the lockfile version, each
        alone;
      - optional dependencies;
      - key order inside a resolution and the settings;
      - a peer-suffixed package's resolution (v9 under `name@version`,
        v6 under its suffixed key);
      - a `link:` outside every importer;
      - a package listed without a snapshot.
        Equivalent:
      - The `/` shortcut: the version fallback reaches the same key.
      - The key order: it differs only when a version string is itself
        another snapshot's key, which pnpm writes for no plain
        dependency.
803.  DONE (2026-09-25, sweep of `@vzn/vx-lockfile`'s `yarn.ts`, the
      last of the four parsers). 31 mutations over `yarn.test.ts`: 11
      caught, 14 held now, 6 equivalent. Held now, in `tests/yarn.test.ts`,
      each row changing one input:
      - berry: an entry with no `resolution` is keyed by its descriptors
        and never merged with another;
      - berry: peer dependencies;
      - berry: an entry's checksum;
      - berry: the second descriptor of a multi-descriptor key;
      - berry: the metadata version;
      - berry: a `workspace:` range the keys do not list;
      - berry: a bare range resolving to its `npm:` entry;
      - berry: an unresolved range;
      - classic: `version`, `resolved` and `integrity`, each alone;
      - classic: `optionalDependencies` and a quoted scoped name;
      - classic: CRLF line endings and entry order.
        Equivalent:
      - The two berry detections (`__metadata:`, `version: N`) mask each
        other: yarn writes both at the top of every file, and dropping
        both is caught.
      - Classic dependency lines are never indented past four spaces.
      - Classic's early `[]` and the `:`-range `[]`: every later branch
        finds nothing for those inputs.
      - Classic's global is a constant.
804.  DONE (2026-09-25, Next 23's first step). The two signal rows that
      went red once each with no proven cause now say what they saw.
      `signal-handling.test.ts`'s at-the-moment-of-exit row names each
      survivor by its file (`dev`, `slow`, `child`) with `describePid`,
      a new `tests/helpers/alive.ts` export: the state and command line
      where procfs is the process's own, and a note that it is not
      under a sandbox. `watch-signals.test.ts`'s SIGINT rows compare one
      `{ code, got, dead }` object and, on a mismatch, carry the task's
      description and vx's stdout and stderr into the diff. The rows no
      longer throw on a missing `got.txt`; it reads as `<no got.txt>`.
      A mutant that forwards SIGTERM for SIGINT printed the whole
      picture.
805.  DONE (2026-09-25, sweep of `@vzn/vx-schedule-history`). First pass:
      35 mutations over the package's three suites, 20 caught, 15
      survived. The survivors pointed at three defects, fixed:
      - The history memo was dead weight. Core calls `schedule` once
        per run, so dropping the memo changed nothing; its comment named
        a `graph` hook the plugin does not have. Removed.
      - The window, the headroom, `resources: false` and the memory
        budget were each read twice, once for a run's hooks and once for
        `vx history`, so either copy could drift unseen. Each is now
        read in one helper both paths call.
      - `vx history`'s pretty table and its unit breaks could only be
        reached through a run. It is `renderHistory` in
        `src/history-view.ts` now, a pure function.
        New rows:
      - the numeric workspace median;
      - a node on a cycle;
      - a reservation of exactly one 64 MB step;
      - a zero-cost axis beside an over-budget task;
      - the admit hook installed for declared reservations alone;
      - the fail-open warning when the history read throws;
      - the table's listing, its count line, the p50 and peak unit
        breaks, and the budget's label;
      - an e2e row turning the window and the headroom, then learning
        off.
        After the refactor, 41 mutations over `critical-path.ts`,
        `index.ts` and `history-view.ts` are all caught.
806.  DONE (2026-09-25, sweep of `@vzn/vx-github`). 50 mutations over
      `summary.ts`, `checks.ts` and `plugin.ts`: 22 caught, 27 survived,
      1 did not compile. One survivor was a bug. The job-summary clamp
      measured `.length`, which counts UTF-16 units, against GitHub's
      1 MiB cap, which counts bytes. The page is not ASCII: every status
      is an emoji and every separator a `·` or a `—`. So a page under the
      cap in units could be well past it in bytes, and GitHub refuses
      such a page whole. The clamp now measures UTF-8 bytes and backs a
      cut off a continuation byte, so no character is split; a page
      under a third of the cap in units skips the encode. New rows in
      `tests/github.test.ts`:
      - the byte cap, on a page under it in units and past it in bytes;
      - a cut inside a character, both parities;
      - each clamp's exact boundary;
      - the duration breaks;
      - an unlabelled status;
      - the stats line in both numbers;
      - a spawn that never became ready;
      - the footer's pass count and escaping, and an escaped blocked id;
      - the check-run's times, title and clamped summary;
      - the POST's exact headers, its 200-character body cut, and an
        unreadable body;
      - an empty `GITHUB_STEP_SUMMARY`;
      - `checks: false`, `checkName` and `title`.
        With the fix and a re-anchored clamp, 52 mutations: 50 caught, 2
        equivalent. `blockedBy` is set only on a skipped task, and the
        record's `hitCount` is built from the statuses the footer counts.
807.  DONE (2026-09-25, sweep of `@vzn/vx-otel`). 123 mutations over
      `otlp.ts`, `plugin.ts` and `sink.ts`: 83 caught, 36 held now, 4
      equivalent. A bug found by reading `resolveOtelConfig`: a signal
      without its own URL fell back to the traces URL while staying
      enabled. With only `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` set, every
      run POSTed its metrics payload to `/v1/traces`, which a collector
      refuses. `logs: true` did the same for logs. A signal now ships
      only to its own URL, and one asked for by name without a URL warns
      once. Rows fail without the fix; the control passes both ways.
      Held now:
      - `otlp.ts`: the metrics, trace and log envelopes, pinned whole
        (counter values, temporality and monotonicity, the scope
        version, a failed record's severity, observed time and
        workspace), and a fractional int attribute truncated to an
        integer string.
      - `plugin.ts`: trimmed header keys, a whitespace-only endpoint,
        per-signal options over env, the logs opt-out read trimmed and
        in any case, and `metrics: false`, `timeoutMs` and `post`.
      - `sink.ts`: span times without a summary (run.start to run.end,
        a task without task.start, a root with no end), a summary's
        times over the records' for the root and the logs, integer
        nanoseconds, nothing POSTed for an empty run, the configured
        headers, the run's vx version, a one-line error body, a
        message-only partial success, a refusal whose body dies
        mid-read, and the request timer cleared once the export
        answers (a child process exits well inside its 5 s timeout).
        Equivalent:
      - `eq <= 0` in the header parser: the empty-key guard catches `=v`.
      - The `partialSuccess` substring check: a fast path in front of a
        parse that answers the same.
      - `Number.isFinite`: a NaN count already fails `> 0`.
      - `logs.finish` with logs off: no `task.log` reaches that sink.
808.  DONE (2026-09-25, sweep of `@vzn/vx-mcp`). A bug found by reading
      `handleMessage`: a line of valid JSON that is not an object read as
      a request. `null` threw on `msg.id` outside every catch, so
      `serve()` rejected, the session ended, and the next request was
      never answered (probed). Such a line is now JSON-RPC's `invalid
request` (-32600), and the session goes on. The new row sends
      `null`, `5`, `[]` and a string, then a ping, and fails without the
      fix. 49 mutations over `server.ts` and `tools.ts`: 32 caught, 15
      held now, 2 equivalent. New rows, most in `tests/sweep.test.ts`:
      - `listTasks` narrowed to one project, every field exact
        (description, a `null` command for a group, `cached`,
        `persistent`), and an empty project name refused;
      - `getRunHistory` rows carrying their blocker, their timeout and
        their violation count;
      - `explainCacheKey` explaining the latest of two entries;
      - `initialize`'s instructions;
      - a tool result indented two spaces;
      - a tool's own non-user failure (a `cache.db` that is not a
        database) as -32603 carrying SQLite's message;
      - blank and whitespace-only lines getting no reply.
        Equivalent:
      - The decoder's final flush: JSON cannot end mid-character.
      - `entry ?? null`: `bun:sqlite`'s `get()` already answers `null`.
809.  DONE (2026-09-25, `@vzn/vx-migrate`'s shared helpers, the first
      slice of its sweep). Files: `paths.ts`, `script-command.ts`,
      `persistent-note.ts`, `plugin-gaps.ts`, `shared-outputs.ts` and
      `nx/nx-dotenv.ts`. 56 mutations: 42 caught, 10 held now, 4 not
      held. `persistent-note.ts` had no row of its own at all. Held now,
      in `tests/helpers-sweep.test.ts`:
      - A task named by a bare name, a `^` edge or a `pkg#` edge keeps
        its readiness note; an orphan loses the note alone; a
        non-string `dependsOn` entry is passed over.
      - The package manager's `pack`, `publish` and `version` hooks
        stay out of a task.
      - A shared-output pair is ordered by an edge in either direction.
      - A `dependsOn` cycle terminates: without the `seen` set the walk
        spins, and the row hangs until the job's timeout.
      - An empty `nonAtomizedTarget` is no parent.
      - `.<id>.env` files are listed.
        Not held:
      - `relPosix`'s separator join, a no-op on the two supported
        platforms.
      - An output list of no strings, which overlaps nothing either way.
      - The `''`-directory fallback in `existingDotenv`: no candidate
        produces it.
      - `kept.push` in `resolveSharedOutputs`. The outer loop judges
        every remaining task as a keeper in turn, so a pair one pass
        misses the next pass drops, with the same todo. No input built
        separates the two; not proven equivalent.
        `nx-map.ts`, `turbo-map.ts`, `nx-command.ts` and the two remote
        caches are the next slices.
810.  DONE (2026-09-25, `vx-migrate`'s `turbo/turbo-map.ts`, the second
      slice). 44 mutations: 29 caught, 14 held now, 1 equivalent. Held
      now, in `tests/turbo-map-sweep.test.ts`, driven through
      `mapTurboWorkspace` on a small tree:
      - turbo 1's `pipeline` read like `tasks`;
      - a script that is `''`, `null`, an array or a number, each
        reported in its own words;
      - a root `pkg#task` key giving that package the task, and a
        package overlay's `#` key never becoming one;
      - two tasks on one output path, the second uncached;
      - a persistent task never cached;
      - a `pkg#task` edge to a missing script dropped with a todo;
      - `?`, `[…]` and `!` refused as wildcards in `env` and
        `passThroughEnv`;
      - a negated `$TURBO_ROOT$/` input, an input leaving the
        workspace, and `$TURBO_ROOT$` mid-glob.
        Equivalent: the `delete def.extends` after the merge. Nothing
        reads `extends` again, and the unknown-key scan skips it.

811.  DONE (2026-09-25, `vx-migrate`'s `nx/nx-map.ts`, the third slice).
      A defect found by reading `parseNxGraph`: a graph file of `null`
      read `null.graph` and threw a bare TypeError, not the error naming
      the shape it wanted. It reads `?.graph` now; the row fails
      without it. 42 mutations: 26 caught, 14 held now, 2 equivalent.
      Held now, in `tests/nx-map-sweep.test.ts`, driven through
      `mapNxWorkspace` on a synthetic graph:
      - a node root with a trailing slash finds its project (unmatched,
        it would be synthesized with the slash in its dir);
      - a root node with no discovered project takes its package.json
        name;
      - a `defaultConfiguration` naming no configuration is ignored;
      - a group whose every `^` edge held nothing keeps an empty
        `dependsOn`;
      - a cached continuous target says it runs uncached;
      - a cached target with no inputs reads the whole project;
      - a plain `command` target maps as run-commands;
      - `envFile`: an absolute path kept, none loaded under
        `NX_LOAD_DOT_ENV_FILES=false`;
      - run-script's `script` option;
      - `{args.*}` reported;
      - implicit deps: one pair per target project, and "and N more"
        past five.
        Equivalent:
      - Skipping a graph node without targets before synthesizing it:
        the mapping loop skips it again.
      - The `nx.json` existence check: the failed read lands in the
        same catch.

812.  DONE (2026-09-25, `vx-migrate`'s `nx-inputs.ts`, `nx-outputs.ts`
      and `nx-deps.ts`, the fourth slice). Pure functions with no rows
      of their own: 29 mutations, 8 caught, 20 held now, 1 equivalent.
      Held now, in `tests/nx-helpers-sweep.test.ts`, by exact output:
      - inputs: a negated `{workspaceRoot}` glob, an unsupported token, a
        named input that names itself, and every object form (fileset,
        input, dependencies, externalDependencies,
        dependentTasksOutputFiles);
      - outputs: a glob kept as written, `{workspaceRoot}` directories,
        the root project's plain path, a normalized root path, and a
        non-string option and an unknown token reported;
      - deps: a leading colon, an empty target, and the object forms
        (`self`, a project by its package name, a non-array `projects`,
        a missing target).
        Equivalent: one `seen` set per entry rather than per call.
        Sharing it drops only a duplicate glob, which resolves to the
        same files.

813.  DONE (2026-09-25, `vx-migrate`'s `nx-command.ts`, the fifth
      slice). 55 mutations: 24 caught, 29 held now, 2 unreachable.
      Held now, in `tests/nx-command-sweep.test.ts`, by exact line:
      - quoting: `shellQuote` on the empty word and a single quote,
        and the appended `--name=value` for a lone `"`, a value already
        single-quoted, and a value holding double quotes;
      - the `args` option as yargs-parser reads it: a leading zero, an
        exponent, camel case, repeats joined with a comma, a dotted
        name, `--no-name`, a flag before a flag, an object option;
      - `{projectName}` twice, an empty project dir, an empty
        `envFile`, an empty `command` beside `commands`, a `command`
        array, a non-string command entry, a mixed `readyWhen` list;
      - `prefixColor` and `bgColor` alone, an empty `__unparsed__`, an
        `args` array and a quoted `args` string;
      - one command of a parallel list, a non-object `env`, and a
        `color` other than `true`.
        Unreachable: `nxQuoteArg`'s branch for a word without `=` and
        its `--` test. Its one caller passes `--name=value`, so the
        function now takes only that shape, with the same output.

814.  DONE (2026-09-25, `vx-migrate`'s `turbo-cache/index.ts`, the
      sixth slice). 46 mutations: 30 caught, 15 held now, 1 not held.
      Held now, in `tests/turbo-cache-sweep.test.ts`, through a stub
      `fetch` that records each request and serves the exact response:
      - config: a signature key measured in bytes (11 `€` pass), exactly
        32 bytes enough, the `teamId` option over `TURBO_TEAMID`, and
        every trailing slash stripped;
      - statuses: 403 is a refused token (thrown once, then off); HEAD
        and GET answering 500 are errors, not misses; a batch query not
        answering 200 is no answer; a duration of `0` or `Infinity` is
        none;
      - the upload: its `Content-Length`, a rounded duration that is
        never negative, and the upload deadline rather than the request
        one (the HEAD on the same slow stub is the control);
      - a tag of the wrong length is refused, not a `RangeError`.
        Not held: the temp's removal when a read fails part-way. A
        truncated temp ends the stream cleanly (probed), and as root a
        permission change cannot make the read fail.

815.  DONE (2026-09-25, `vx-migrate`'s `nx-cache/index.ts`, the
      seventh slice). 25 mutations: 16 caught, 9 held now. Held now, in
      `tests/nx-cache-sweep.test.ts`, through a stub `fetch`:
      - config: every trailing slash stripped, a server of `''` or `/`
        declines, a password with no user name refused, the
        `accessToken` option over the env, and an empty token as none;
      - requests: no token sends no `Authorization`, an upload declares
        its `Content-Length`, a GET answering 500 is an error;
      - the probe's kept response serves one `get`, and the next
        fetches again.

816.  DONE (2026-09-25, `vx-migrate`'s plugin glue: `nx/index.ts`,
      `turbo/index.ts`, `adoption-plugin.ts`, `remote-deadline.ts`, the
      eighth slice). 26 mutations: 14 caught, 12 held now. Held now, in
      `nx.test.ts` and `turbo.test.ts` through a real `planRun`:
      - `root` names where nx.json and the graph live, and where
        turbo.json lives;
      - the mapper's notes are reported (an implicit dep);
      - a root project's gaps are not reported;
      - with no line that starts with `nx-exec` or `nx-env`, neither a
        missing bin nor a missing `node_modules/nx` is reported (a line
        that names the bin mid-way does not start with it);
      - the root `package.json` and a package's `package.json`, each
        newer than the snapshot, re-export. One row per file: a file
        dated in the future stays newer than every later snapshot, so a
        second touch in the same row proved nothing;
      - an export that exits 0 and writes nothing is a failure, and a
        failure names stderr's last three lines;
      - a target the mapper skips (`nx:noop` with nothing to chain) is
        left out, not declared `null`.
        Left for the next slice: the `bunx @vzn/vx-migrate` writer
        (`index.ts`, `migrate-turbo.ts`, `migrate-nx.ts`, `bin.ts`).

817.  DONE (2026-09-25, `vx-migrate`'s writer: `index.ts`,
      `migrate-turbo.ts`, `migrate-nx.ts`, `bin.ts`, the ninth and last
      slice). 27 mutations: 14 caught, 13 held now, in `migrate.test.ts`:
      - `parseMigrateArgs`: `--from=nx`, `--help` and `-h` as the usage
        line, and an unknown flag named as one (the positional error
        also contains the word, so the row pins the whole message);
      - source detection, through the bin, by exact stderr: turbo.json
        beside a bare `nx.json` and beside a graph with no `nx.json`
        both ask for `--from`; `--from turbo` without turbo.json, and
        `--from nx` with no Nx at all, say which is missing; an argument
        error is said on stderr;
      - the preset: `globalEnv` alone or `globalPassThroughEnv` alone
        writes the file with that one section and a final newline, and
        a config imports the names it uses sorted.
        `vx-migrate` is swept end to end (items 809 to 817).

818.  DONE (2026-09-25, `@vzn/vx-reapi`'s `cache.ts`, the first slice
      of the last package). 16 mutations: 4 caught offline, 10 held
      now, 2 equivalent. The offline suite held little: the live e2e
      suite (skip-mode in the gate) was the only other reader. Held
      now, in `tests/stream-cache.test.ts` against its in-process gRPC
      stub:
      - `execDigestFor` and `actionDigestFor` by exact digest;
      - `has` and `get` find the artifact by its path, not by its
        place in `output_files`;
      - `has` is false for an entry whose blob is gone;
      - a duration that is not a number is none, and one normalised
        into CAS (`stdout_digest`) is read from there;
      - a put of a blob the server has uploads nothing and records one
        non-executable output file;
      - `close` ends the client.
        Equivalent: `decodeDuration`'s empty-bytes guard (an empty
        `stdout_raw` never reaches it, and `JSON.parse('')` lands in
        the same `undefined`), and `exit_code: 0` (proto3's default).

819.  DONE (2026-09-25, `vx-reapi`'s `index.ts`, the plugin). 17
      mutations: 7 caught, 8 held now, 2 not held. Held now, in
      `tests/plugin-sweep.test.ts` against an in-process Capabilities
      stub that sets `exec_enabled` per row and records each request's
      instance name:
      - an empty endpoint declines;
      - the `endpoint` option wins over `VX_REAPI_ENDPOINT`, and
        `VX_REAPI_INSTANCE` names the instance on the wire;
      - a cache-only server is declined with its exact warning and its
        client closed;
      - an execution server gets the executor with its `capacity`, and
        teardown closes its client;
      - an unreachable server's client is closed before the refusal.
        Not held: `platform` and `executeTimeoutMs` reaching the
        executor. Both act only inside a remote `Execute`, and no suite,
        live or offline, passes them through `reapi()`. The executor
        slice needs an Execute stub, and these two rows go with it.
