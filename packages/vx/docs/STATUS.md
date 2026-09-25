# STATUS — the living handoff

**Read this first.** It is the one file a fresh session needs to pick the
project up: the direction, what shipped, what is in flight, what is next.
Update it in the SAME commit as the work it describes. Newest state wins;
delete stale lines rather than appending corrections.

## Direction (owner, 2026-09-02)

> "VX should be the Vite of task orchestration. Perf first, then
> modularity. Slim core; add features with plugins or replace
> functionality. Remove DTE / VX Cloud / agents — vx ships none of it, but
> gives people a way to implement it on top. Consider everything before
> this date legacy."

Concretely:

1. **Performance is the first decision driver.** Every change to the run
   path is measured (`packages/vx-bench/`), and a slower core is a regression even if
   it is prettier. Targets: the fastest warm no-op run and the lowest
   scheduler/hash overhead of any JS-monorepo task runner.
2. **Core is a pipeline with seams, not a product.** Core owns:
   discovery, config evaluation, the task graph, cache keys, scheduling,
   and the seams. Plugins own: WHERE a task runs (`executor`), WHERE
   artifacts live (`cache`), WHO observes (`telemetry`/reporters), and —
   as the seams widen — how the graph is shaped and prioritised and which
   CLI verbs exist.
3. **No distribution in the repo.** No agents, synchronizers, controllers,
   cloud, dashboards. The executor seam is the extension point for all of
   it; `@vzn/vx-reapi` (Bazel Remote Execution API) stays as the proof
   that the seam is wide enough.
4. **Native first.** Bun APIs over dependencies. A dependency needs a
   reason written down next to it.
5. **Adoption ready.** Docs, site, and design describe the product that
   exists — verified against the code, not remembered.

Process: push directly to `main`, no PRs. Gate before every push:
`bun packages/vx/src/bin.ts run ci --all`. Small, focused commits.

## Shipped — the record

The review arc (2026-09-02 → 09-09) and improvement-loop items 1–64,
with the bench numbers behind them, moved whole to
`docs/history/2026-09-review-arc.md` on 2026-09-10, items 65–104 to
`docs/history/2026-09-improvement-loop-65-104.md` on 2026-09-11, and
items 105–144 to `docs/history/2026-09-improvement-loop-105-144.md` on
2026-09-16 (with the Next list's record to
`docs/history/2026-09-status-next-log.md` the same night), and items
145–202 to `docs/history/2026-09-improvement-loop-145-202.md` later
that day (the 2026-09-10 measurement paragraphs to the 65–104 file, and
handoffs 14g–14i to the next-log file), and items 203–242 to
`docs/history/2026-09-improvement-loop-203-242.md` that night (handoffs
14j–14p to the next-log file), and items 243–281 to
`docs/history/2026-09-improvement-loop-243-281.md` that afternoon
(handoffs 14q–14v to the next-log file), and items 282–305 to
`docs/history/2026-09-improvement-loop-282-305.md` that evening
(handoffs 14w–14y to the next-log file), and items 306–332 to
`docs/history/2026-09-improvement-loop-306-332.md` late that night
(handoffs 14z–14ad to the next-log file), and items 333–352 to
`docs/history/2026-09-improvement-loop-333-352.md` on 2026-09-19, and
items 353–372 to
`docs/history/2026-09-improvement-loop-353-372.md` that night
(handoffs 14ae–14af to the next-log file), and items 373–392 to
`docs/history/2026-09-improvement-loop-373-392.md` on 2026-09-20
(handoff 14aj to the next-log file), and items 393–412 to
`docs/history/2026-09-improvement-loop-393-412.md` later that day
(handoff 14am to the next-log file), and items 413–432 to
`docs/history/2026-09-improvement-loop-413-432.md` on 2026-09-20
(handoff 14an to the next-log file), and items 433–452 to
`docs/history/2026-09-improvement-loop-433-452.md` on 2026-09-20
(handoffs 14ao–14ap to the next-log file), and items 453–572 to six
files of twenty, `docs/history/2026-09-improvement-loop-453-472.md`
through `-553-572.md`, on 2026-09-22 (item 573), and items 573–591 to
`docs/history/2026-09-improvement-loop-573-591.md` later that day
(handoffs 14aq–14au to the next-log file, item 592), and items 592–611
to `docs/history/2026-09-improvement-loop-592-611.md` on 2026-09-23
(handoffs 14av–14ax to the next-log file, item 612), and items 612–631
to `docs/history/2026-09-improvement-loop-612-631.md` that afternoon
(handoffs 14ay–14ba to the next-log file, item 632), and items 632–654
to `docs/history/2026-09-improvement-loop-632-654.md` that night
(entries 14bb–14bv to the next-log file, item 677), and items 719–743
to `docs/history/2026-09-improvement-loop-719-743.md` on 2026-09-25
(item 764), and items 744–778 to
`docs/history/2026-09-improvement-loop-744-778.md` that afternoon
(item 785), so
this file stays the handoff
and not the log; numbering continues from there. Keep
it that way: when the loop below passes forty items, move the oldest
batch there in one commit, and move a Next entry's record the same way
once it is closed.

## Improvement loop (2026-09-09, after the review pass merged)

Open-ended, owner-delegated: find flaws, widen seams, sharpen DX,
refactor toward cleaner layers. One coherent commit per step, gated,
recorded here as it lands. Layer map measured first (imports between
`src/<module>` directories): util ← workspace ← cache, exec ← graph ←
orchestrator ← cli, `config.ts` a leaf, no back edges — the boundaries
test is telling the truth.

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

## In flight

**The gate's runtime (settled 2026-09-21, item 572; plan F4).** A gate
under Bun 1.4.2 is the only gate: the 2026-09-19 container shipped
1.3.11, below `engines.bun: >=1.4`, and every "flapper" of that arc — the
shard-9 SIGILL (3 of 24 reps on 1.3.11, 0 of 24 on 1.4.2), the three
recorded failing tests, the inert symlink tripwires that scored three
containment guards as survivors — was the version. `bun upgrade` is
refused there; the release asset
`github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip`
downloads through the proxy and the gate with it first on PATH is 44 of
44 green. A shard failure under 1.4.2 is the diff's. The diagnosis of
the 23-test baseline as it stood on 1.3.11 is in
`docs/history/2026-09-status-next-log.md` § "In flight as it stood
2026-09-22"; the `ci` task refusing a Bun below the floor is plan F4.

**The sandbox arc (2026-09-05) is closed.** Its four Linux items closed
by 2026-09-10 (`docs/history/2026-09-status-next-log.md`); the fifth,
macOS violation reporting being lossy under load, is a recorded decision
since item 586 (Decisions below), not an open item.

**Releases.** v0.0.21 is on npm, the four platform packages with it
(2026-09-15, handoff 14d in the history file), published through
`npm.yml`, which reads no secret and sets no token — its publish is the
OIDC exchange or nothing — so the trusted publishers on npmjs.com are in
place. The v0.0.18 record (the token's `E401`, the held packages, the dry
run of the token-free workflow) moved to the history file with the
items above.

**Launch checklist (2026-09-10, the owner's "what is needed to go
fully live").** What a public announcement needs, in order, with the
state of each:

1. DONE by 2026-09-15 (0.0.21 published through the token-free
   `npm.yml`, so the trusted publishers exist). OWNER residue: delete
   the `NPM_TOKEN` repository secret if it still exists — nothing reads
   it. Documented in `docs/cli.md` § Releasing.
2. OWNER: cut the release — the notes are drafted in
   `docs/history/release-0.1.0-notes.md` (item 581); a GitHub release with the tag is the whole
   process (`release.yml` builds and signs the binaries, `npm.yml`
   publishes with provenance). Pick the version the articles will name;
   `0.1.0` says "first real release" where 0.0.19 says "another nightly".
   The release notes are the changelog — there is no CHANGELOG file, and
   GitHub's generated notes from merged PR titles are accurate since
   every merge is one titled PR.
3. OWNER: the site's address — it deploys to
   https://vznjs.github.io/vx/ on every push to main (`docs.yml`). A
   custom domain is a DNS record plus `SITE_URL` / `BASE_PATH` env in
   that workflow (`astro.config.mjs` reads both); every internal link is
   base-relative, so nothing else moves.
4. DONE 2026-09-10: the blog and its thirty posts, README and site
   numbers, LICENSE holder, SECURITY.md, CONTRIBUTING.md (items 115,
   116, 118).
5. OWNER, optional: enable GitHub private vulnerability reporting
   (Settings → Security) so `SECURITY.md`'s instruction is live; issue
   templates are not needed for a first announcement.
6. DONE 2026-09-16 as item 226: the site's introduction has a
   "Known limits" section — Bun ≥ 1.4 for source installs (the binary
   needs nothing); Linux sandboxing needs `bubblewrap`, `socat` and
   `ripgrep` (the third named 2026-09-16, item 246) and cannot run as
   root inside a container; Windows is WSL; macOS
   violation reporting is lossy under load (In-flight 5);
   a task's replayed output is its first and last 8 MiB (229); a project
   inside a submodule is enumerated by its own repository (221). An
   article links it.

## Next (ordered)

0. DONE 2026-09-10 as item 87 (history) — core has no `build`; dependants stop compiling the release binaries.
1. **The live REAPI suites are green again (2026-09-04); the
   whole-graph run stays optional.** With OrbStack's docker back, the
   rehosted `vx-nativelink:bun-node` image on
   `tests/helpers/nativelink-exec.json5` ran all ten `@vzn/vx-reapi`
   files one process each with both endpoints set: 121 pass, 0 fail —
   the wire-level execution suite (15), the cache suite (16) and the
   `execute: true` composition proof (2) included, so the barrel
   narrowing and the by-name error classification (2026-09-03) changed
   nothing live. Not done: `vx run ci --all` of THIS repo at a worker —
   it needs a workspace that wires `reapi({ execute: true })` (none is
   checked in) and filesystem stores (the memory stores evict under a
   `node_modules` install, per the helper notes). An exercise, not a
   gap; do it when a worker-side change needs it.
2. DONE 2026-09-23 as item 662 (entry 14bj) — the remote seam streams: `get` resolves `Blob | Response`, `put` takes a file-backed `Blob`, every first-party layer moved in the same commit.
3. DONE 2026-09-09 as item 88 → `@vzn/vx-turbo` (history) — zero-migration adoption as a plugin on the `project` stage.
4. DONE 2026-09-10 as item 77 (history) — one core per process; the shipped binary serves its own façade to every `@vzn/vx` import.
5. DONE 2026-09-11 as item 148 — the watch e2e flake was the arm
   instant on the wrong clock; the macOS intermittent extra cycle stays
   recorded under item 130.
6. **Re-measure the warm run after each day's work** — the hot path is
   the product. CI wall time is the other number this duty carries
   (plan I2): 2:23–3:16 per push run on main over 2026-09-21's eleven,
   all three jobs; a run past six minutes is the signal to fold the
   heaviest witness files onto a shared fixture. `bun packages/vx-bench/run.ts 100 5` and `1000 5`; an interleaved
   A/B against an immutable worktree settles any gap
   (`scratchpad/ab.ts`-style: alternate arms, min and median of N).
   The closing figures of 2026-09-03 → 09-10 and the refutations
   recorded under this duty (a synchronous restore for small
   artifacts, discovery's stat memo, the `restore: rows` lead) are in
   `docs/history/2026-09-status-next-log.md`; the latest day's A/B is
   item 285 (2026-09-16, a tie; 274 was the one before), and the
   restore arm's floor is the note under item 193 (history). 2026-09-16, after item 225: 5,000 projects
   687 ms warm / 2,854 restore / 12,152 cold (medians of 3) against
   1,000's 231 / 718 / 2,436 — the warm stage table grows 3.4–3.9× for
   5× the projects (discover 23 → 89 ms, load configs 24 → 87, classify
   56 → 190, run graph 42 → 144), git's own enumeration 6× (9 → 55),
   nothing super-linear; the fixed ~30 ms of startup and workspace
   config is what makes 5,000 cheaper per project than 1,000. PARKED for
   the 2026-09-19 arc (items 341–362): it changed docs, comments and
   tests only, so there is no run-path delta to A/B, and the arc ran on
   a shared 4-core container whose own baseline fails 23 tests for
   environmental reasons — an absolute figure from it is not comparable
   to the table above, and an A/B has no arms. Re-measure on the first
   run-path change. REFRESHED 2026-09-20 (item 420): this container, at
   1,000 projects, reads warm 271 ms / restore 1 031 / cold 3 147, and at
   5,000 warm 807 / restore 3 931 / cold 14 181 — the dev box's figures
   below are a DIFFERENT MACHINE and only the 1k→5k scaling (×2.98 warm
   here against ×2.97 there) compares. The harness's warm arm spreads
   ±13 % on identical code. UNPARKED 2026-09-20 (item 404), with the
   container's own noise floor measured first: interleaved min-of-7, one workspace
   copy per arm pre-warmed by that arm, 1,000 projects warm all-hit —
   the A/B read 232.1 ms before against 218.9 ms after, and the A/A
   CONTROL (the same arm against both copies) read 246.4 against
   259.0. A 12.6 ms spread between identical code is the same size as
   the 13.2 ms "difference", so this box resolves nothing below about
   6 % even at min-of-7. Absolute figures here, for the record and not
   for the table: 1,000 projects warm 194–204 ms total
   (`bun packages/vx-bench/run.ts 300 3`: no-cache 987 ms, warm
   172 ms, warm-restore 329 ms). Any future claim on this container
   needs an A/A control beside it. 2026-09-22 (item 580), the sweep week
   (items 342–572, PRs #488–#681) as one arm: base 164.7 ms, head
   167.8 ms warm min-of-15 at 1,000 projects, A/A 170.1 against 169.2 —
   a tie. Item 588 (the additive hit path, every task's): main 173.5
   against head 170.5, A/A 168.3 against 164.2 — a tie. The COLD path
   has its own number since 2026-09-23 (item 615): 1,000 projects,
   `.vx` removed, 2,938–3,420 ms before against 2,680–2,997 after, the
   `load configs` stage 507–607 → 207–272; a cold arm is five reps with
   the cache removed before each, no A/A needed at that size. 2026-09-24 (items
   690–702, the day's run-path changes being the key fold's move to
   `key-fold.ts`, one config worker per repeat round and the JSON-data
   walk): base 39294a8d against head, compiled binaries, 1,000 projects
   warm, interleaved, n=25 — medians 266.5 ms before and 266.4 after,
   mins 245.1 and 230.8; A/A 270.4 against 264.8 (mins 238.5, 238.1).
   A tie; a first n=15 pass read the mins the other way round (225.9
   before, 251.8 after) with the same tied medians, which is the box's
   min-of-N noise, not a cost.

7. CLOSED — the 2026-09-04 walkthrough's four follow-ups landed
   ((a) `noCache` in `--summarize` rows, (b) `init` no longer makes
   `lint` wait for `build`, (d) an empty filter set names its patterns)
   or were measured out ((c) watch's one extra cycle on an undeclared
   write is the price of not declaring it). Record: history, next-log.

8. **Improvement-loop candidates (2026-09-09).** (a), (b), (f), (h)
   DONE as items 16/63, 8(b) 2026-09-10, 75 and 58; the measurements
   behind (e) and (h) are in `docs/history/2026-09-status-next-log.md`.
   Still standing: (c) `vx lock` reads config files raw on purpose,
   and the doctor, the selector and watch fall back to a raw per-file
   read only when the staged load throws (five call sites by
   2026-09-16, each read and confirmed against a `turbo()` workspace:
   `vx info` counts the plugin's tasks) — grep for `loadProjectConfig(`
   before adding a consumer that is not a fallback; (d) was "`logger.ts` and
   `framed-output.ts` are the last large files" — by 2026-09-16 they are
   699 and 518 lines and the largest are `cache/cache.ts` 1,583,
   `cli/watch.ts` 1,121, `orchestrator/run.ts` 1,040 and
   `exec/sandbox-runtime.ts` 1,034, each one concern (the split of
   cache.ts is item 8's), so the note is closed; (e) REFUTED: a discovery memo keyed on directory and
   manifest stats saves ≈ 3–4 ms of a 230 ms run for a second staleness
   surface — revisit only if discovery's share grows; (g) `vx why` shows
   a plugin `key` part's digests, not its material, because a raw
   column is a `SCHEMA_VERSION` bump or a persisted secret — revisit
   when a plugin's part is the thing people debug.

9. Superseded by 14 (items 70–80 landed as PRs #269–#271, 2026-09-10).
10. Superseded by 14 (items 81–95 landed as PRs #272–#273, 2026-09-10).
11. Superseded by 14 (the survey and parity rounds, items 96–111, 2026-09-10).
12. Superseded by 14 (items 102–112 landed as PRs #275–#279, 2026-09-10).
13. DONE 2026-09-10 as item 120 — `vx watch` watches the projects a cycle can run.
14. The handoffs after items 153, 130, 166, 170, 176, 183, 189, 192,
    197, 202, 208, 211, 214, 221, 225, 230, 236, 240, 242, 252, 263,
    270, 275, 281, 287, 293, 299, 305, 312, 319, 326, 332, 383 and
    394, 400, 403, 409, 412, 419, 426, 432, 441 and 452 (14–14ap) are
    in `docs/history/2026-09-status-next-log.md`; items 453–572 are in
    `docs/history/2026-09-improvement-loop-453-472.md` through
    `-553-572.md`; items 573–591 are in
    `docs/history/2026-09-improvement-loop-573-591.md`, 592–611 in
    `docs/history/2026-09-improvement-loop-592-611.md`, 612–631 in
    `docs/history/2026-09-improvement-loop-612-631.md`, 632–654 in
    `docs/history/2026-09-improvement-loop-632-654.md` and 719–743 in
    `docs/history/2026-09-improvement-loop-719-743.md` (entries
    14aq–14di and loop item 677 in the next-log file). The loop above
    is the record since 744 (14dj in the next-log file); 14dk is below,
    and the next entry written here is 14dl.
15. **The plan after the sweep week: `docs/design/plan-2026-09-22.md`.**
    Fixes F1–F6, improvements I1–I7, arcs D1–D5, in the order that
    document gives (F4 → F1 → F3 → F2; F5 → I1 → I4; D3 → D1, D5
    alongside, D4 with the owner, D2 when a workspace asks). Each entry
    names its seam, the constraint that must survive, the measurement
    and what not to do; strike an entry through there when its item
    lands here.

14dk. **Handoff after item 727 (2026-09-24, midday).** Since 14dj the
site was redone as one story and read on a phone: the Guide of ten
chapters on one toy monorepo, Docs and Reference around it, internals
out of the sidebar, one look, build-time pictures (721); the old Learn
pages retired with redirects (722); the widgets restyled and cut (723);
every picture, the cover, the graph explorer (724) and the scheduler's
charts (725) given a phone form, held by the diagram kit's laws, and
code blocks wrapped. Core alongside: a sandboxed task no longer reads
its own package through its self-link (720, `CACHE_VERSION` v30), nor a
linked sibling its key does not cover (726, v31, the Decisions entry on
narrowing core's grant), and a task downstream of a persistent task has
one key on both paths (727). WHAT STANDS: 14dj is in the next-log file
(§ Handoff 14dj); the loop holds 719–729. OWNER, unchanged: the site's read
(Next 16), cut 0.1.0 (the tag, then delete `NPM_TOKEN`), the scope list (roadmap 2.4), the soak length. NEXT: the owner's read of the short site (Next 16); the trim when the loop reaches twenty items; the warm-path A/B on the next run-path change (Next 6). Never end with "what
next?".

16. **The site, short (owner, 2026-09-24, after 728).** Shipped as item
    729 (`design/site-short-2026-09.md`). Left: the owner's read.
17. DONE as item 744 — **Turbo 2.11 won warm at 476 packages on the Linux box (item 735).**
    Two one-rep runs read Turbo at 255 and 303 ms against vx's 334 and
    376 (restore: 436 and 446 against 524 and 478). Measure it min-of-N
    with interleaved arms, find where vx's warm path spends it at that
    size, and fix it or say so on the site. The 3,270-task run on the
    same box reads the same way: Turbo 496 ms warm against vx's 678.
18. **Re-run the site's benchmark with the fixed harness (item 735).**
    The landing's Nx numbers (34m 44s cold, 3,270 tasks, macOS) come
    from the harness that gave Nx npm; npm was two thirds of Nx's cold
    run at that size on the Linux box. OWNER: re-run `compare.ts 100 11
1` on the macOS machine and `update-site.ts`, or take the Linux run
    in `benchmarks.md` for the site. The Linux run of this exact shape
    (`compare.ts 100 11 1`, 2026-09-25, item 758) has vx leading every
    column; its generated `RESULTS.md` / `results.json` were not
    committed over the macOS run the site reads.
19. DONE as item 751 — **A sandboxed task's `kill 0` killed the
    sandbox (Linux, found in 736).** The command runs in a session of
    its own inside the sandbox.
20. DONE as item 752 — **A cancelled sandboxed task got no TERM grace
    (Linux, found in 751).** SIGINT and SIGTERM reach the command's
    group through fd 3; SIGKILL stays the group's.
21. **The rest of the 476-package warm profile (item 753).** In order
    of measured saving, each on a patched copy (interleaved, stage
    mins): scheduler priorities over the exec tier only (DONE as item
    754); one multi-row insert for the run's history rows (REFUTED
    2026-09-25: 40-row INSERTs made 85 rows three statements, and a warm
    476-package run's `record history` stayed 8.2 → 8.6 ms at min, wall
    174.3 → 176.6, N=21; the 5 ms the profile saw was skipping the
    rows, and binding 21 columns a row is the cost, not the statement
    count); `node:readline/promises` imported only by
    the picker (REFUTED 2026-09-25: two compiled binaries, one importing
    it beside the other node: modules vx loads, differ by 0.27 ms at min
    and 0.1 at median, 41 interleaved; the 2.5 ms was the source run's
    transpile under the profiler); `git rev-parse` in the enumeration
    as an async spawn beside the others (REFUTED 2026-09-25: as a fourth
    spawn in the `Promise.all`, two interleaved passes of 21 read min
    168.7 → 171.8 and 165.5 → 183.8 ms; the sync spawn's block overlaps
    git's own run, which is the enumeration's wall anyway);
    the group hash computed once instead of in the stable-key pass and
    again at execute; and `resolveFiles`' memo checked before it builds
    its key (both declined in item 756). The large lever, persisting
    last run's stable keys, is designed and DEFERRED (item 756).
    (`vx-bench/strace-vx.ts` counting git's worker threads as vx: fixed
    in item 755.) DONE through items 753–756.
22. DONE as item 771 — **`baseAllowWrite` had one value (item 770).** Core sends `[]` on
    every sandboxed request, so the field on `ExecuteSandbox` and
    `SandboxedRunArgs` is a knob no producer turns; an executor plugin
    reading it learns nothing. Remove it from the seam and let the
    runtime's own write set be `allow.write` alone. Three runtime rows
    pass it as a direct write grant (two of them macOS `sandbox-exec`
    rows, which this box cannot run) and move to `allow.write` in the
    same change, proven on the darwin CI job.

## Decisions (this arc)

- **Persisted stable keys: deferred (item 756).** Designed and
  prototyped (`docs/design/persisted-stable-keys-2026-09.md`): 13–21 ms
  of a 476-package warm run, exact-repeat runs only, and any input the
  digest misses is a stale hit on every run. Not built while vx leads the
  warm column; revisit on a measured warm-no-op loss or an agent-loop
  workload, and land only through that doc's gate.
- **Once per run (owner, 2026-09-24, item 732).** Within a run nothing
  outside vx changes the files it reads; what vx learns once (a read, a
  stat, a PATH lookup, a spawn's answer) it reuses, and only vx's own
  writes or its tasks' runs invalidate a fact. A repeat that stays has a
  measured reason in a comment and in the strace laws that pin it.
- **Tools resolve on vx's own PATH (item 732).** The task's PATH decides
  what its command runs, never which shell parses it.
- **What a cached task may write undeclared (item 750).** Its own
  inputs, in place (a formatter), and nothing else: its key names those,
  so a reader folding it is covered. A root-project task may rewrite the
  lockfile; the run watches for it. An `inputs.runtime` answer is the
  environment, asked once per run and never re-checked: a task that
  changes it is out of contract, and a file another task writes is
  declared as an input instead.
- **Every project's lockfile key folds the root importer (item 733).**
  What the root declares is reachable from every task.

- **Declaring `cache` may narrow core's own grant, never widen one
  (owner-delegated, 2026-09-24, item 726).** The user's `sandbox.allow`
  still derives nothing from `cache` (2026-09-05). Core's implicit
  `node_modules` link grant is bounded by the key for a task that
  declares `cache`: a linked workspace package is granted only when the
  key folds a task of it, because an unkeyed read is exactly the stale
  hit the sandbox exists to rule out. A task with no `cache` keeps the
  whole grant, having no key to be stale. The coverage is per package,
  not per file (an edge to `ui#source` also admits `ui/README.md`), the
  same limit a grant wider than a task's own inputs already has.

- **macOS violation reporting is lossy under load, and stays so
  (2026-09-22, item 586).** The store is fed by the unified log, which
  drops records under pressure; the settle window that halved the loss
  cost 300 ms per clean sandboxed task and went 2026-09-05 (owner); no
  unprivileged channel reports a denial the child survived. Enforcement
  is unaffected and the Known limits page says so. Not an open item.
- **`--affected` includes dependents (2026-09-16).** The sugar is
  `--filter '...[<base>]'`: the changed projects and everything that
  depends on them, the superset a CI gate needs and what the guides
  promised; `--filter '[<base>]'` is the changed-only form for "test
  what I touched". Item 287.
- **Resources are the schedule plugin's (owner, 2026-09-12).** Core
  gates on the worker count and asks the `admit` stage for anything
  finer; it holds no per-task cores or megabytes, no config field for
  them, no budget flag. What a task needs is learned from what it used
  (`@vzn/vx-schedule-history`), or declared to that plugin. Item 157.
- **No first-party technology plugins (owner, 2026-09-10).** A plugin
  that gives packages tasks from a framework's config (`vite()`,
  `next()`, …) is the community's to write on the `project` stage; core
  names no tool, and this repo ships no such plugin. `turbo()` in
  `@vzn/vx-migrate` is an adoption plugin, not a technology plugin, and stays.
- **Windows is WSL (owner, 2026-09-10).** vx spawns POSIX shell and ships
  linux / darwin binaries; a Windows developer runs it under WSL, and the
  docs say so instead of listing Windows as a gap.
- **One core per process (2026-09-10).** The running `vx` serves its
  own façade to every `@vzn/vx` import it evaluates. A plugin package
  never carries its own copy of core into a run; the host decides the
  runtime, as any host does. Item 77.
- **The façade names only what has a consumer (2026-09-10).** An
  export written for a consumer that no longer exists is a promise
  nobody collects and a surface nobody may change; item 78 took 41
  of them off. Core keeps every function behind its module contract;
  a new consumer widens the façade deliberately, with the pin.
- **No seam without a consumer (2026-09-10).** The `CASBackend` /
  `Digest` substrate left core after three months with zero callers
  (item 74). A content-addressed view of the artifacts directory comes
  back when a plugin needs it, shaped by that plugin's use — not
  before. The same rule retired `recordRun` / `recordRuns` from the
  layer contract (item 72).
- **Merge your own PR once it is green (owner, 2026-09-10, "Merge
  whenever you own the project").** The session's PR flow stays
  (branch, PR, CI), but a green, mergeable PR no longer waits for the
  owner's word; the next PR starts from the merged main.
- **A plugin's name is its package name; no overrides (owner,
  2026-09-10).** `definePlugin(import.meta, hooks)` reads it and stamps
  it; the workspace loader refuses anything else. Item 69.
- **Gap audit vs Nx 23 / Turbo 2.10 (2026-09-04, owner's ask).** Core
  is at parity or ahead on every must-have a developer would miss
  (graph, filter DSL superset, affected, strict caching, env
  isolation, persistent readiness, watch, prune, migrate, init, dry /
  graph / summarize / profile). The one game changer left is
  zero-config adoption — scripts as tasks with no generated file —
  whose mapping is a `project`-stage plugin and whose core half is one
  seam widening (§ Next 3). `.env` loading, configurations, cache caps,
  graph UI, release, test splitting, boundaries: plugin or the
  language. Windows is the only must no plugin can supply; parked.
  Full table in `docs/comparison.md` § Gap audit 2026-09-04.
- **Agents removed.** `@vzn/vx-agents` (synchronizer + persistent
  workers, Nomad/K8s backends) was an in-repo distributed-execution
  product. It used only public core APIs (`run`, `createEventBus`, the
  executor seam), which is the proof the seam suffices — so it lives
  outside this repo, if anywhere.
- **Predictive scheduling removed.** Opt-in, measured at ~280 ms of
  history loading on a large cache (more than a warm run), and a
  scheduler-priority policy is exactly what a plugin hook should decide.
  The scheduler keeps its `priorities` input; a `schedule` seam will feed
  it.
- **`vx mcp` removed; `metrics.ts` trimmed.** The MCP server read the
  dashboard-era analytics queries and predictive history. An MCP server
  is a good plugin (`commands` seam), not core. The queries `vx why` /
  `vx last` need stay in `metrics.ts`; the rest went.
- **`vx why` / `vx last` stay.** Cache-miss explainability is a core
  promise; both read the local run history core already writes.

## Legacy map (what the old memory called things)

- `docs/design/decision-log-archive.md` held the full 2026-05→08 log; it
  is deleted from the tree (git history: `git log -- docs/design/decision-log-archive.md`).
- "waves" = the old audit cycles. Their standing rules survive in
  `CLAUDE.md` § Rules.
