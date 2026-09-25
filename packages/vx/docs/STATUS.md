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
(item 764), so
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

744.  DONE (2026-09-24, Next 17: why Turbo won warm at size). Not the
      cache: `deriveStableKeys` built each task's transitive set of
      upstream output producers by copying every dep's string `Set`,
      tasks × deps × projects inserts — 101 ms of CPU self time in a
      513 ms warm profile at 476 packages, growing with the graph. The
      set is now a bitset over project indexes (`ProjectSet` in
      `stable-keys.ts`), so a union is a word-wise OR; the gate reads
      it unchanged. Warm, compiled, interleaved against a `git worktree`
      "before" (main after item 742): 476 packages 0.45 → 0.35 s (Turbo
      0.35, min of 9); 3,270 tasks 0.89 → 0.56 s (Turbo 0.71, min of 7). The existing
      rows hold the union, the direct add, the iteration and the size
      (each neutralised in turn, each red).

745.  DONE (2026-09-24, upstream survey: the missing rows and the
      ledger). The survey mapped 302 Turborepo and Nx bug reports; 66
      had no test that would notice vx regressing into them (one was
      pinned by item 734 since). 63 are written, each through the real
      path (a run, the CLI, a pty, a real shallow clone or worktree),
      and rows in every file but three were shown red under a mutation
      of the code they guard: not task-selection or watch-loop, and a
      named pipe in inputs is kept out by git's and `Bun.Glob`'s own
      enumeration, which no vx line decides. Writing
      them found two faults: a Yarn 4 `catalog:` dependency is recorded
      as the literal `"catalog:"` in `yarn.lock`, so under `yarn()` a
      catalog bump moves no workspace digest (a stale hit, fixed in
      747); and a
      remote upload that times out, or a server that cannot be reached,
      warns with the bare runtime message, naming neither the request
      nor the server, once per request. One row stays untested: an
      output past the 2 GiB ceiling costs 6 to 14 s a run. The page
      `docs/upstream-ledger.md` lists every report with its verdict and
      the test that holds it, and `tests/upstream-ledger.unsafe.test.ts`
      fails when a cited title is not a test in the file it names (two
      template-titled loops were unrolled so their rows can be cited).

746.  DONE (2026-09-24, Next 20 and 21 as they stood: the graph at
      scale). `vx run app#t0 --dry` on a 50,000-deep chain threw
      `RangeError` from `pinnedLocalSet`, a walk items 737 and 741 left
      recursive. Grepping the class found four more recursions over the
      task graph, each reproduced at 50,000 and each now on an explicit
      stack: the restore-tier exclusion below a workspace-output writer
      (a real run of a 50,000-deep group chain over one threw out of the
      classify); `expandGroupUpstream` (a task over a 50,000-deep chain
      of groups failed as an internal error, and a group reached along
      two paths was expanded once per path, 2^16 reads for sixteen
      stacked diamonds, now once); `keyedProjects` (a sandboxed task's
      fold); and `materializeFor` (a deferred producer's closure). The
      pin and the exclusion flow up the dependant edges from what seeds
      them, and a graph that pins nothing builds no index. Each fix has
      a row at 50,000 that throws `RangeError` without it, and a
      50,000-task cached chain then ran green cold (443 s) and warm (6.2
      s). The package graph's walks, the cycle check, the lockfile's
      Tarjan walk and the plan's critical path were already iterative (a
      50,000-project chain filters in 29 ms). Not recursion, and left:
      the scheduler's reverse-dependant closure and the package graph's
      transitive closure are bitsets of n²/32 words, 312 MB at 50,000
      tasks by arithmetic, and `transitiveDeps` on a 50,000-project
      chain took 3.4 s. Then `detectOutputCollisions` compared every
      pair of a project's tasks with outputs: 10.0 s for 4,000 distinct
      literals in one project, 2.65 s for globs. A path index now names
      the pairs that can overlap (equal globs, equal literals through
      their `/**` twins, and a literal against the globs whose literal
      head names one of its ancestors, the head ending at `*?{}`, `\` or
      a leading `!`), and `collide` runs over them in all-pairs order,
      so the refusal and the addition marks are all-pairs' own. A fuzz
      of nearly four million glob/literal pairs found no match outside
      the head, and thousands once `\` and `!` were dropped; a
      differential over 3,000 random configs holds the index to the
      all-pairs loop, and nine mutations of the index are each caught
      (the `!` one only once the configs were drawn with mulberry32:
      drawn from an LCG's low bits by `% n`, they never held a pair that
      decided it). Two lookups that survived mutation were redundant and
      went: equal literals, and a glob filed at a literal's own path
      (the fuzz found no glob matching the directory its head names).
      Interleaved, first build, min of 3: 4,000 literals 10,040 → 9.8
      ms, globs 2,650 → 7.6, mixed with a chain 8,576 → 15; 1,000
      projects of ten literals 54.8 → 8.0 ms; 1,000 workspace-output
      declarers 142 → 0.85. The warm 1,000-project bench ties, n=25 and
      31: `build graph` min/median 1.8/2.2 ms before and 1.7/2.2 after
      (A/A 1.8/2.1), the run 194/219 ms before and 197/233 after against
      an A/A of 195/224. A call per single-task project had cost that
      stage 0.4 ms until the call site skipped it. The time bound at
      4,000 fails the old loop tenfold.
747.  DONE (2026-09-25, Next 20 as it stood: Yarn 4 catalogs,
      turborepo#12635). A real Yarn 4.18.1 install writes a workspace's
      catalog dependency as `is-number: "catalog:"` and gives the range
      the catalog names an entry nothing in `yarn.lock` points at, so
      `yarn()` folded the literal and reached nothing: a bump inside the
      range (`yarn up`, `.yarnrc.yml` unchanged) moved no digest, a
      stale hit. Worse, and not `yarn()`'s alone: with `^6` and `^7`
      both already resolved, flipping the catalog `^6 → ^7` rewrote not
      one byte of `yarn.lock` while the workspace's `node_modules`
      moved from 6.0.0 to 7.0.0 (measured with the real install), and
      `.yarnrc.yml` was in no key, so core without any plugin replayed
      too. Core's workspace fingerprint now folds `.yarnrc.yml` (a
      catalog edit re-keys and `--affected` selects every project, as a
      `pnpm-workspace.yaml` edit does; one more absent-file probe, 2 µs
      a run, min of 2,000 interleaved), and `yarn()` resolves
      `catalog:` and `catalog:<name>` to every entry of the package
      (scoped names too), so a bump of any of them moves the workspace;
      which one the catalog names is `.yarnrc.yml`'s to say, and the
      plugin does not claim it. `DIGEST_VERSION` 3 retires the old
      memos. Every new row fails without its half of the fix, and a
      mutation of the scoped-name split is caught. pnpm and Bun catalogs
      were already right and are pinned from real installs: pnpm
      records the resolved version beside `specifier: 'catalog:'`
      (only the importer moves), and `bun.lock` copies the catalog and
      hoists what it resolved (every workspace moves on the catalog,
      only the naming one on a bump inside it).

748.  DONE (2026-09-25, Next 22 as it stood: a dangling output-root
      link). `dist -> real-out` inside the project with `real-out`
      deleted failed every hit: `mkdir -p` does not follow a dangling
      link, so it stopped EEXIST at the link ("blocked by what is on
      disk … a path the output globs do not cover", though `dist/**`
      covers it) and ENOENT below it, which reached the user as an
      internal error, a corrupt artifact. A live in-project link is
      written through (742's control), so a dangling one now is too:
      the extractor resolves the link on the failed `mkdir` alone
      (`resolveThrough`, a clean tree never pays), creates the
      directory it names when that is inside the project, and writes
      through it; the link stays. One that resolves out of the project
      — absolute, `../`, or the last hop of a chain — is 742's refusal
      by name, and nothing is created outside; a cycle is refused by
      name. A link the output globs cover (`dist/sub` under `dist/**`)
      never reaches this: the clean unlinks it, as before. A restore
      that aborts prunes the target it created from where the link
      leads, since the lexical walk never meets it. Six rows restore
      through such a link under a root reached through a link (the
      macOS `/var` shape): at the root, below it, above a deeper entry,
      a chain, an absolute link, and a task probed in its own slot
      rather than restored in the tier. Six refuse (five shapes out,
      one cycle). These twelve and the abort row fail without the fix;
      the live-link and covered-link controls pass both ways; the
      containment check, its resolved base and the abort's resolve are
      each red when neutralised.

749.  DONE (2026-09-25, Next 21 as it stood: a remote-cache warning
      named nothing). An upload past its deadline warned
      `vx/turbo-cache: The operation timed out.`, and a closed port
      printed Bun's bare "Unable to connect" once per request: three
      lines for one task over the Turbo wire, two over Nx's. The
      naming and the counting went into core's `LayeredCache`, so
      every cache plugin has them. The seam's `RemoteCacheLayer` takes
      an optional `endpoint`, and a failure reads
      `upload <hash> to <endpoint> failed: <cause>` (or `probe`,
      `probe of N artifacts`, `download`), with a URL's credentials,
      query and fragment dropped before printing. A failure class is
      said once per layer, which is once per run: the error's `code`
      when it has one (gRPC writes the elapsed time into each
      deadline's message), else the message with the hash taken out.
      `close()` then counts the rest, as
      `N more requests failed the same way: <cause>`. `turboCache()`
      and `nxCache()` name their endpoint, throw `HTTP 413` rather
      than `PUT <hash> → 413`, and name a spent deadline
      (`no answer within 700 ms`); `reapi()` names its endpoint. The
      closed port now prints two lines, the first request with its
      server and the count of the other two. The degrade rows pin the
      exact lines and each is red on main; five mutations of the
      class, the stripping and the count are each caught. Over Turbo's
      wire the first request to fail is either the batch probe or the
      task's own download: the prefetch pass is detached from
      execution, so the two race.

750.  DONE (2026-09-25, Next 20 as it stood: the three stale-hit edges
      743 left). Each was reproduced first (`tests/in-run-writes.test.ts`).
      A CACHED formatter (`outputs: []`, rewriting `a.ts` from a seed)
      ahead of a same-project `build` with `tasks: []`: seeds A,B,B,A
      built A,B,B,B, the up-front probe restoring run 3's B before the
      formatter wrote A. The gate now counts a cached task where
      `commandWriteReach` says it may rewrite its own inputs, but only
      for a reader whose key folds no path to it: a folding key names
      the rewriter's inputs, which are what it may rewrite, so a default
      reader keeps its up-front probe. Two bitsets per task carry it,
      built only when some key leaves a dependency out (a `tasks`
      filter, or a persistent dependency). Second, a cached task that
      ran but saved nothing marked nothing in the git snapshot: under
      `--cache=local:r,remote:r` a `gen` rewriting its tracked `gen.txt`
      left the committed OID there, and a `tasks: []` reader restored
      the first run's X over B; a formatter under the same policy did
      the same, no re-check having run. Such a miss now re-checks its
      inputs (a move drops the project) or marks its declared outputs
      as a save does (`markUnsaved`), when some task depends on it.
      With none, nothing in the run can read it: the walk had cost
      1,000 read-only misses 1,624 → 1,778 ms (min of 9), and with the
      gate 1,685 → 1,685. Third, a root-project `install` rewriting
      `pnpm-lock.yaml`, which is in contract (the root is its own
      project): seeds A,B,B,A,A built A,B,B,B,B — the fourth run
      restored up front under lockfile B after installing A, the fifth
      hit what the second saved under lockfile A from an install of B.
      A task that `mayWriteFingerprint` (unsandboxed in the root
      project, or a grant over a fingerprinted file) makes every reader
      after it unstable and tells the run's `FingerprintWatch` when its
      command ran (a persistent one when ready); the watch re-checks the
      files then, an `lstat` each and the bytes compared with what the
      fold kept, and once one moved nothing is lazily probed or saved
      for the rest of the run, with one status line. `inputs.runtime` is
      not re-checked: it would be a spawn per command per miss, and its
      answer is the environment, which the contract says no task
      changes. caching.md claimed a runtime command sampling a task's
      output was "never a stale hit"; that held only for a reader
      folding the task, and a row now pins the contract (asked once per
      run; a `tasks: []` reader after a task that changed the answer
      hits an entry filed under the old one). `CACHE_VERSION` v33 →
      v34: an entry the old code saved after an in-run lockfile rewrite
      replays under the fixed code once the tree is back on that
      lockfile (probed: under v33 the fixed code restored B on lockfile
      A; under v34 it built A). The other two edges poisoned nothing:
      their stale restores fell in runs that saved nothing, or under a
      key 743's re-check already guarded. 23 mutations of the three
      fixes each redden a row; the uncovered set passed through a
      folded dependency needed a cross-project row (a same-project one
      inherits instability), and the same pass-through for a
      workspace-reach rewriter was dead and went. Warm, 1,000 projects,
      31 interleaved reps, min/median: `build --all` 227/248 → 222/249
      ms, `test install --all` 362/398 → 350/388 (A/A: 219/248 against
      225/247, 341/387 against 339/383).

751.  DONE (2026-09-25, Next 19 as it stood: a sandboxed task's
      `kill 0` killed the sandbox). Reproduced driving `runSandboxed`:
      `sleep 10 & trap 'trap "" TERM; kill 0' EXIT; echo done` exits 0
      unsandboxed and 143 sandboxed. bwrap's `--new-session` puts the
      runtime's shells (the proxy bridges' script, the seccomp step's)
      in one group with the command, and `kill 0` reaches a group's
      members across the nested pid namespace. On Linux the command now
      runs as `: 'vx-<tag>'; setsid bash -c '<command>'`, both tools on
      vx's own PATH: `setsid` from a shell's child is no group leader, so
      it execs without a fork and the exit is the command's (3 stays 3,
      a SIGKILL stays 137; that control passes without the fix too). Job
      control was refuted first: bash's `set -m` printed job notices and
      returned 0 for `exit 3`, dash refused it without a tty. Cost, min
      of 15 over three interleaved pairs of a sandboxed `true`: 35.2 →
      38.6 ms. The item asked to keep "the TERM grace a cancellation
      gives it": there is none to keep. A group SIGTERM (a timeout, or
      sent by hand, with and without strace) ends bwrap's monitor, and
      `--die-with-parent` SIGKILLs the namespace, so a sandboxed
      command's `trap … TERM` never runs (Next 20).

752.  DONE (2026-09-25, Next 20 as it stood: a cancelled sandboxed
      task got no TERM grace). vx's group signal reached bwrap's
      monitor, which died of it, and `--die-with-parent` SIGKILLed the
      namespace: a sandboxed command's trap never ran, on a timeout, a
      Ctrl-C or the end-of-run persistent teardown. bwrap forwards no
      signal, and a spare descriptor was probed to reach the command
      through bwrap, SRT's shells and apply-seccomp; so a sandboxed
      spawn gets fd 3, a pipe vx owns, and `killTree` writes SIGINT's or
      SIGTERM's name down it (`signalThrough`) instead of signalling the
      group. Inside, a watcher forked before `exec setsid bash -c` reads
      the name and signals the command's group, `$$` (the exec keeps the
      shell's pid). SIGKILL at the grace's end still goes to bwrap's
      group. The first form backgrounded the command and waited: SIGTERM
      rows passed and SIGINT rows did not, since an `&` command starts
      with SIGINT ignored and a shell cannot trap what it inherited
      ignored; the foreground `exec` fixed both. Rows: SIGINT and SIGTERM
      to vx reach a sandboxed one-shot and a ready sandboxed persistent
      task by their own trap (the four rows `signal-handling.test.ts`
      holds unsandboxed), and a timeout reaches a TERM trap while a
      command that ignores TERM is SIGKILLed at the grace. All six fail
      without the fix; dropping the persistent spawn's channel alone
      reddens the two persistent rows. A timed-out sandboxed task now
      exits 143 with its own status, no longer the tracer's signal death.
      `closeSignalChannel` drops a child's entry before it closes the
      descriptor: Bun leaves the pipe open after exit, and a kill after
      the close must not write to a reused number. The PR's darwin job
      failed an unrelated row of item 745's, the post-exit drain: its
      grandchild slept 0.1 s before printing, and on a loaded runner that
      overran the 250 ms drain (292 ms). It now prints once its parent is
      gone (`kill -0 $$` polled), the claim the row makes; 20 serial and
      8 parallel runs pass, and it still fails with the drain at 0.

753.  DONE (2026-09-25, found by profiling the warm no-op at 476
      packages: vx 189 ms against Turbo 226, min of 9, both noisy). The
      profile's cheapest large cost: each of the 952 task lines was its
      own stdout write, 8.5 ms of the run-graph stage. Off a TTY the run's
      terminal logger now holds its writes and hands them over once per
      turn of the event loop, settling in `runEnd` (before the summary)
      and in `run()`'s `finally`, so nothing is held when `bin.ts` ends
      stdout. Warm, compiled, interleaved against a binary built from
      main, min of 15: 184.0 → 167.8 ms wall, 363 → 350 ms CPU; the
      output is the same lines. Rows: the writer's coalescing and
      `settle`, a TTY and an unasked writer untouched, the logger's
      `runEnd` handing over what it held (fails with the settle
      neutralised), and twenty cache hits reaching stdout in at most five
      writes that carry task lines (twenty with coalescing off). The
      profile's other findings, ranked, are Next 21.

754.  DONE (2026-09-25, Next 21's first: scheduler priorities over the
      exec tier). A restore-tier task never waits on its deps, so it
      blocks only the exec-tier tasks that depend on it, and the
      whole-graph closure ranked by edges nothing waits on. With a
      restore tier, `tieredReverseDepCount` takes an exec task's count
      exactly over the exec tier, and a restore's as the sum over its
      direct exec dependents of one plus theirs (a rank that can count a
      diamond twice, among restores only), so a restore feeding pending
      work still goes first. A cold run has no restore tier and ranks as
      before. At 476 packages the warm run-graph stage went 48.1 → 37.7
      ms (min of 6, `VX_TIMING`); wall, compiled, interleaved, min of
      21: 180.0 → 172.0 ms, median 192.0 → 189.6 (an N=15 pass read no
      difference: the stage saving sits near the wall's noise). Rows:
      the exact tiered counts with the whole-graph control, an exec task
      whose only dependent is a restore yielding to one that blocks work
      (red on the whole-graph count), and a restore feeding pending work
      restoring first (red with restore weights zeroed).

755.  DONE (2026-09-25, Next 21's next three, each A/B'd on the
      476-package warm run and each REFUTED, recorded there: a multi-row
      history insert, a lazy `node:readline/promises`, an async `git
rev-parse`). The profile's numbers for them came from a source run
      under the profiler or from skipping the work outright; against
      compiled binaries, interleaved, none moved the wall. What the pass
      did fix: `vx-bench/strace-vx.ts` read only whole calls, so a spawn
      strace split across threads (`<... clone3 resumed> … = <pid>`) left
      git's worker threads unowned and their 3,371 `newfstatat`s counted
      as vx's; it now reads the resumed line too, and its counter is a
      function a row drives with a synthetic trace (red without the
      resumed match). And `bindRun`'s comment said 17 columns; it binds 21.

756.  DONE (2026-09-25, Next 21 closed). The profile's last two small
      fixes are declined unmeasured, each under the wall's ~5 ms noise
      at 476 packages: the group hash computed once (reusing it needs
      every upstream outcome's hash compared with the pass's, the same
      order of work as the 2–3 ms of hashing it saves) and `resolveFiles`'
      memo checked earlier (the memo cannot hit there: its key holds the
      task's own outputs, and a project's `build` and `test` differ in
      them; sharing the glob matches instead would save about 3 ms). The
      large lever, persisting last run's stable keys under one digest of
      what they read, is designed in
      `docs/design/persisted-stable-keys-2026-09.md`: sixteen input
      classes with where each enters, five shapes that bypass, a proof
      sketch, and a prototype that saved 13–21 ms at min (base 212–230,
      memo 198–214 over four interleaved passes). DEFERRED (Decisions):
      exact-repeat runs only, part of the saving reappears in `run
graph`, and a missed input is a stale hit on every run.

757.  DONE (2026-09-25, the 476-package Linux row re-run after items
      744, 753 and 754; `compare.ts 20 25 1`, the fixed harness, one
      rep). vx 225 / 367 ms warm (no restore / restore) against Turbo
      247 / 392 and Nx 1.84 / 1.89 s; cold 1m 37s against 1m 39s and
      2m 27s, vx's cold CPU 7.06 s against Turbo's 13.84. The day
      before, the same row read Turbo ahead on both warm columns (303 /
      446 against 376 / 478). `benchmarks.md` carries the new table and
      says the lead is one rep each; the committed `RESULTS.md` (the
      3,270-task run) is unchanged.

758.  DONE (2026-09-25, the 3,270-task Linux row re-run after items
      744, 753 and 754; `compare.ts 100 11 1`, the fixed harness, one
      rep). vx 3m 40s cold, 359 / 653 ms warm (no restore / restore),
      16.05 s cold CPU; Turbo 5m 4s, 431 / 722 ms, 33.27 s; Nx 6m 59s,
      4.50 / 4.60 s, 20m 55s. The day before, Turbo led both warm
      columns (496 / 856 against 678 / 971); vx now leads every column
      at 476 and 3,270 tasks on this box. `benchmarks.md` carries the
      table; the committed `RESULTS.md` stays the macOS run the site
      reads, since which run the site quotes is Next 18's, the owner's.

759.  DONE (2026-09-25, the run lock, `run-lock.ts`, unmentioned in any
      sweep). Two runs held it at once. It was a bare `mkdir` then a
      `pid` write, left as an unlink then the rmdir, reclaimed by
      `rm -r`: visible without its pid a moment each way, and a waiter
      whose grace (one poll, counted from ITS start) had long passed
      removed that moment as abandoned. Probe: four processes contending
      for four seconds held it two at once 22 times, one release threw
      ENOENT (out of `run()`'s `finally`, in a CLI run) and six took the
      "no run lock" path; with holders SIGKILLed mid-hold, 27 overlaps.
      A first fix (build beside, rename into place, reclaim by moving
      aside and putting back what was not the judged holder) cut that to
      a window a third run could take: a failed put-back in four stress
      runs of ten, an overlap in two. Now the lock is a directory HELD
      while not empty, holding one entry `h-<pid>-<start>-<n>` unique to
      the taking: taken by a rename onto an absent or empty name, left
      and reclaimed by unlinking that entry BY NAME (an unlink that cannot
      hit the next taking's entry), then a best-effort rmdir. An older
      vx's `pid` file is still read and reclaimed. Five calls to take
      and release, as before, nothing read back (the syscall pin
      rewritten). Rows: the stress (six contenders, every third taking
      dies holding, a real SIGKILLed one beside; red 3/3 on the old
      file, 0 of 60+ runs on the new), a release that leaves a lock
      another run took since (deterministic; red with the release as
      `rm -r`), an older vx's pid file dead and live, an empty
      directory is free. Recorded survivors, each a single mutation the
      stress hits only sometimes: reclaim as `rm -r` (caught in 2 of 3
      runs), an empty directory read as pid-less (0 of 3) — both need a
      reclaim to interleave with a take inside one async step. The one
      stress "warning" chased on the way was the waiting notice: a
      contender among six can wait past a second. Two more found
      re-reading the diff: a reclaim the file system refuses (another
      user's lock) read as "gone already" and the wait retried at once,
      no poll, forever — it is the "no run lock" warning now (a
      non-root row, driven as `probe`: red as a 1 s spin with the
      refusal swallowed); and a staging name unique only by pid, start
      and number (start is `x` where procfs is not ours) would meet a
      killed pid 1's leftover after a container restart and refuse
      every run — it carries a random suffix.

760.  DONE (2026-09-25, `fingerprint-watch.ts`, unmentioned in any
      sweep). A stale hit: the watch that catches a task rewriting the
      lockfile mid-run (item 750) gated its re-read on `lstat`'s ctime,
      while both reads — the fingerprint's and its own — follow links.
      A lockfile that is a symlink, rewritten through it (`cp` writes
      the target in place), moved the target's ctime and never the
      link's, so once the link aged past the 50 ms racy window every
      rewrite went unseen: item 750's A, B, B, A, A sequence built A, B,
      B, B, B. `statSync` now; the row is item 750's with the lockfile
      a symlink (red before). The class, grepped: `movedInput` in
      `task-hash.ts` keeps `lstat`, correctly — an input symlink folds
      its target STRING as git does (`file-hashes.ts`), so the link's
      own ctime is the fact its digest names.

761.  DONE (2026-09-25, found reading `dependency-spec.ts` and
      `plugin-commands.ts` in the unswept-file pass that also read
      `chained-cache.ts`, `upgrade.ts` and `run-artifacts.ts` and found
      them sound). A doc block directly followed by another describes
      nothing: a helper with its own doc had been inserted between a doc
      and its declaration, so the doc attached to the helper. 26 such
      pairs across the packages — `runGraph`'s, `taskEnv`'s,
      `CacheLayer`'s, `parseDependencySpec`'s among them; 23 moved onto
      their declarations (pure moves, the diff balanced line for line),
      `initSandbox`'s two blocks merged into one, the pack-step block in
      `cache.ts` folded into `packArtifact`'s doc (its "return them, no
      disk write" had gone stale when `packArtifactToTemp` began writing
      the temp), and `migrate-turbo.ts`'s block for a `relPosix` that
      moved to `paths.ts` deleted. One the detector cannot see, moved by
      hand: `peakRssBytes`' doc sat on the constant above it. The law:
      `tests/doc-comments-attached.unsafe.test.ts` (red with one orphan
      put back).

762.  DONE (2026-09-25, the rest of the unswept-file pass: `nested-dirs.ts`,
      `tail.ts`, `settle.ts`, `colors.ts`, `completions.ts` read sound).
      One comment claimed more than the code: `settleWithin` "returns
      true when `p` settled first", while a rejection before the deadline
      propagates by design (a row pins it). The doc says fulfilled, and
      that a rejection throws. Considered and left: `completions.ts`
      interpolates plugin verb names into the shell scripts unquoted —
      the plugin supplying such a name already runs code in vx.

763.  DONE (2026-09-25, two end-to-end probes, both sound). A workspace
      reached through a symlink and through its real path, from the root
      and from a project directory: one cache, warm runs up to date and
      restores correct across an input change and back (the unit rows
      in run-lock, inputs-resolution and sandbox-request hold the shape,
      and macOS CI's `/var` temp directory runs every e2e row through a
      non-canonical root). And `vx watch` over a root `install` that
      rewrites `pnpm-lock.yaml` to the same bytes each run: one extra
      cycle, then settled — no loop. `cli-watch.md` said watch "doesn't
      react to lockfile changes during a cycle"; since item 750 the run
      withholds what it keyed before the rewrite, and the page says so.

764.  DONE (2026-09-25, the trim the loop passed forty at). Items
      719–743 moved to `docs/history/2026-09-improvement-loop-719-743.md`
      in this commit. What that stretch was: the site redo R1–R4 and the
      short site; Next 17's per-task sandbox, usage and warm-path work;
      the upstream bug ledger (744 follows it here); the once-per-run
      law and the signal and procfs fixes. Probes recorded since 763 and
      held by rows already: a stray, a tampered and a deleted file in a
      restored `dist/` each restore the tree (`output-dirs.test.ts`),
      and `--affected` across a lockfile-only bump
      (`vx-lockfile/tests/*`). Next trim when the loop passes forty.

765.  DONE (2026-09-25, mutation sweeps of two files STATUS named once).
      `failure-recap.ts`, 16 mutations: 11 caught, 3 equivalent (the
      empty-chunk guard; the two eviction boundaries, where the partial
      path does what the whole-chunk path would), 2 held now. With
      whole-chunk eviction gone the ring grew without bound and the
      bound row passed, because it read `ring.chars` — the count the
      ring keeps, not what its chunks hold — so the rows sum the chunks
      and pin the count to them. And a blank line opening the thirty
      shown lines counted as one above them under `<=` in the newline
      count; a row puts one there. `download-policy.ts`, 23 mutations:
      15 caught, 2 equivalent (an empty prefix, which `staticPrefix`
      never returns; eligibility computed under `all`, which reads no
      answer), 6 held now. One was a stale-hit hole the suite left
      open: the overlap test checked a reader UNDER an output, not an
      output under a reader, so `build` writing `src/gen/**` beside a
      `test` reading `src/**` could defer — its key would move with
      whether the bytes came home. The code was right; nothing held it.
      The other five: a cacheable reader with no files reads the whole
      project; a task's own outputs never make it ineligible; `dist2`
      is not under `dist`; a task with no outputs is never named; a
      group gets no mode.

766.  DONE (2026-09-25, the sweep of `excluded-keys.ts`, which found a
      bug next door). 13 mutations: 7 caught, 2 equivalent (the empty
      early return; the unsaved count's persistent test, since a
      persistent task cannot carry `cache`), 4 held now — a skipped
      dependency that is a group, a persistent task, a project with a
      config-bearing project nested inside it, or requested with
      forwarded arguments must each fold the key the full run gives it.
      Writing the persistent row found `--dry` wrong: the planner keyed
      a persistent task (the live path gives it no key) and folded that
      into its dependants, so after a run saved `app#build`, `--dry`
      still said "cache miss — would exec" under a key the run never
      looks up. `plan.ts` now gives a persistent task no key and
      `no-cache`; red before. The class, grepped: every other
      `computeTaskHash` site already skips or cannot see a persistent
      task. Refuted on the way: a config-less package nested in a
      project is NOT fenced without a `project` plugin — deliberate and
      pinned (`orchestrator-run.test.ts`), and under `turbo()`/`nx()`
      every package counts.

767.  DONE (2026-09-25, the sweep of `run-history.ts`). 19 mutations: 12
      caught, 2 equivalent (the retention cut at `<` against `<=` on a
      millisecond; the single-row fast path, which the transaction path
      does the same), 5 held now by one row. The history is written by
      position, so a swapped or dropped binding stores a plausible value
      in the wrong column and nothing read it back: the wall-clock pair
      and `host`/`os` swapped, `forward_args` dropped, a false `cached`
      stored as NULL (which reads as a row from before the column), and
      `ON CONFLICT` dropped (a second bundle under one run id then
      threw) all passed the suite. `tests/run-history-columns.test.ts`
      records a run and an invocation whose every field carries a value
      no other field has, false booleans included, and reads each column
      back.
768.  DONE (2026-09-25, sweeps of `failure-mode.ts` and `cli/lock.ts`).
      `failure-mode.ts`: 18 mutations, 16 caught, 2 equivalent (a
      pass-now test that ignores the attempt count, the empty-candidate
      guard), no change. `cli/lock.ts`: 13 mutations, 5 caught, 4 held
      now, 4 equivalent or held by a law. Four holes in `vx lock`:
      `vx lock --chek` WROTE the lock and exited 0 where a CI step had
      asked for an audit; `--check` passed a config renamed with its
      bytes unchanged, which `--frozen` then refused; `--check` passed a
      lock naming a project whose config was gone; and the check's JSON
      round-trip, the one thing that keeps a field a config leaves
      `undefined` (`description: process.env.UNSET`) from reading as
      drift, was held by nothing. Four rows in `tests/lock.test.ts`, each
      red against its mutant. The equivalents: strict against loose
      `deepEquals` (both sides are JSON by then); the write side's
      round-trip, now removed since `writeLockfile` stringifies anyway;
      and the two `fresh: true` flags, which change nothing today (no
      `evalCache` is passed) and which `module-boundaries.test.ts` pins
      as the guard against a later edit freezing a stored evaluation.
      `fresh`'s doc claimed "no module-cache reuse", which it never
      controlled, and `config-cache.md` named `vx show` as a user of it;
      both are corrected.
769.  DONE (2026-09-25, sweeps of `cli/info.ts` and `graph/priorities.ts`).
      `info.ts`: 31 mutations, 14 caught, 16 held now, 1 equivalent (the
      memory row's cgroup test beside the usable-below-total test: usable
      is below the total only when a limit binds). The suite drove the
      printout from a real box, which shows one side of every branch — a
      supported Bun, git present, a sandbox that starts, no plugin
      without seams — so the other side of each was unheld: the
      unsupported-Bun warning, `(not found)` and `(unknown)` for git, the
      git status settings named when off, "will fail" beside a declared
      sandbox that cannot start, the flaky list's first-only "on
      unchanged inputs", the lockfile row, the 24-hour hit count, and the
      label column's alignment itself. `renderInfo` is exported beside
      `describeWorkers` and three rows in `tests/show-info.test.ts` drive
      a healthy and a degraded facts object through it whole, compared as
      literals; `vx info --cache-dir` with no path, which the mutant read
      as the default cache, is refused by an e2e row; a workspace worker
      count beside a quota and a cgroup limit wider than the machine join
      the describe rows. `priorities.ts`: 15 mutations, 11 caught, 1 held
      now, 3 equivalent (the two `nodes.has` guards: the restore tier is
      built from the graph's own nodes, and an extra entry would never be
      looked up; the cycle default the builder makes unreachable). The
      held one: a restore feeding two exec-tier tasks kept only the last
      one's weight under an overwrite, and every row fed one; a row in
      `tests/scheduler.test.ts` feeds two. Every new row is red against
      its mutant. `deferred-outputs.ts` was swept in item 643; the sweeps
      now run in a scratch worktree, so the tree a stop check reads stays
      clean.
770.  DONE (2026-09-25, the sweep of `exec/local-executor.ts`, the last
      file STATUS named once). 14 mutations: 13 caught, 1 equivalent. The
      eight fields the local executor forwards to the runner (command
      args, streams, capture, live children, timeout, env, the empty
      violation list) were each dropped against fourteen run-path suites
      as root; the sandbox branch's six (the branch itself and each
      baseline) against the sandbox suite as `probe` with
      `VX_REQUIRE_SANDBOX=1`, in a `probe`-owned worktree under `/tmp/vx-*`
      (bwrap cannot create a mount point in a root-owned directory, which
      failed two rows of the unmutated baseline until the tree changed
      owner). The equivalent: `baseAllowWrite` emptied, because core
      passes `[]` for it on every request (a declared output is not a
      write grant, owner 2026-09-05). The runtime's doc comments said the
      opposite for both baselines — reads "built from resolved
      `cache.inputs.files`", writes "from the static prefix of
      `cache.outputs.files`" — the claim item 443 corrected in
      `config.ts` and missed here; both now say what core passes. Removing
      the always-empty field from the executor seam is Next 22.
771.  DONE (2026-09-25, Next 22). `baseAllowWrite` leaves the executor
      seam (`ExecuteSandbox`), the runtime's `SandboxedRunArgs`, its
      canonical baselines and `buildCustomConfig`'s: core sent `[]` on
      every request, so the write set was always the task's own
      `allow.write`, and now that is the only place it can come from. The
      runtime's file header claimed, a third time beside the two comments
      item 770 corrected, that the caller derives writes from "declared
      inputs + outputs" and that no `node_modules` is added; it now names
      the two baselines core does pass. Test rows that used the baseline
      as a direct write grant (two macOS `sandbox-exec` rows, the Linux
      TERM-trap row, two `buildCustomConfig` rows) moved the same paths
      into `allow.write`, which the runtime unions identically; the
      trap row is red without its moved grant (as `probe`). The sandbox
      suites as `probe` with `VX_REQUIRE_SANDBOX=1`: 223 pass, 1 skip
      (a platform row), 0 fail.
772.  DONE (2026-09-25, Next 6: the day's warm A/B). The run-path changes
      since item 758's measurement (the run-lock rewrite, 759, on every
      run; the sandbox seam, 771) against 758's commit, as whole
      `vx run build --all` processes on the synthetic workspace, one copy per arm
      warmed by that arm, 21 interleaved reps each (the order alternating
      rep by rep), this 4-core container: 100 projects, min 100.1 → 95.4
      ms, median 111.3 → 112.1; 1,000 projects, min 195.5 → 195.3,
      median 243.4 → 235.0. A tie at both sizes: the lock's five calls
      (same count as before, item 759) cost what the old ones did.
773.  DONE (2026-09-25, sweeps of the two files no STATUS entry had named
      that feed the keys: `workspace/fingerprint.ts` and
      `cache/config-evals.ts`). The fingerprint: 17 mutations, 16 caught
      — every lockfile in the table, every fold of name and bytes on
      both digests, the claim skip and the digests' order are held. The
      one survivor: a CLAIMED lockfile's bytes left out of `files`, the
      map the mid-run watch (item 750) compares against. Its effect is
      a false "moved" — the watch finds the file with nothing to compare
      and withholds every later save and restore of the run, for a
      file no task touched — in a workspace with a lockfile plugin,
      which this repo is. A row in `tests/in-run-writes.test.ts` builds
      the watch from a claimed read: untouched, nothing moved; rewritten,
      moved. The evaluation store: 16 mutations, 11 caught, 4 held now,
      1 equivalent (`INSERT OR IGNORE` for `OR REPLACE`: a key names its
      bytes, and a put follows only a miss). Held now: the BATCHED read
      ignoring the local read axis (`--cache=local:w` served cached
      evaluations; the row read only the single-key getter, which a run's
      load does not use), a re-learned closure kept as the old one or
      under its old retention clock (each is a stale index the slow path
      re-learns on every run), and a key dropped from each 900-parameter
      chunk (no row asked for more than 900). The retention comment and
      `config-cache.md` said rows "unused" / "not loaded" for 30 days are
      pruned; a hit refreshes nothing (a write per config per warm run),
      so it is rows not WRITTEN for 30 days, and both say so.
774.  DONE (2026-09-25, the auto-install refusal in
      `workspace/config-imports.ts`; its `--affected` half was swept in
      item 649). 16 mutations: 12 caught, 3 held now, 1 equivalent (the
      ESM scan forced to the TS loader: TS parses a superset). Held now:
      a DYNAMIC `import('pkg')` dropped from the textual pass — the
      form a config uses to load a package lazily reached no refusal at
      all, and Bun installs what it cannot find from the registry, the
      download item 239 exists to refuse; an absolute specifier looked up
      as a package, which refused a config importing a helper by path
      beside a real package; and unparseable source reported as a missing
      import in place of its syntax error (the row that pinned "empty on
      unparseable" named no package, so the textual pass returned before
      the scan it meant to reach). Three rows in
      `tests/config-missing-import.test.ts`, each red against its mutant.
      The gate for this item went red once on item 752's TERM-trap row:
      its 300 ms timeout counts from the spawn, so it is also the window
      bwrap, the tracer and `sh` have to set the trap in, and the loaded
      gate delivered TERM first (exit 143, no `got.txt`; 12 reps under
      six CPU burners did not reproduce it, the gate's many sandboxes
      did). Both halves of the row now time out at 1,000 ms.

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
