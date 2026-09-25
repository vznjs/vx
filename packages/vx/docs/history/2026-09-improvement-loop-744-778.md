# Shipped, 2026-09 — improvement-loop items 744–778

The record `docs/STATUS.md` carried until 2026-09-25, moved here whole
when the loop passed forty items (item 785). A PREFIX,
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
`2026-09-improvement-loop-719-743.md`; items 779 onward continue in
`docs/STATUS.md`.

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
775.  DONE (2026-09-25, the sweep of `cache/chained-cache.ts`, a
      never-named file). 22 mutations: 7 caught, 15 held now. The rows
      drove real caches, which answer from one layer at a time, so every
      broadcast narrowed to the first layer and every remembered answer
      forgotten changed nothing they could see: `has()` and `prefetch()`
      forgetting the layer that answered (a restore then went to the
      first layer, which does not hold the artifact); the batched remote
      probe asking local-only layers (no batch at all), skipping each
      layer's own complement, or never answering; `markRemoteAbsent` and
      `drainUploads` reaching only the first layer (a second remote's
      uploads undrained at run end); the output-row merge letting a later
      layer override the first; `outputsPath` from the first layer; a
      layer over a DIFFERENT local handle skipping its local write; `close`
      stopping at the first throw or swallowing it; the lookup order
      reversed; the two-layer guard. Eight rows over recording fake
      layers in `tests/chained-cache.test.ts`, each red against its
      mutants.
776.  DONE (2026-09-25, sweeps of `orchestrator/keyed-projects.ts` and
      `workspace/json-data.ts`, never named). `keyed-projects.ts`: 10
      mutations, 6 caught, 4 equivalent (the memo skip and the re-push of
      a visited dependency cost only time; a group's selection is every
      dependency, having no `cache.inputs.tasks`; an unsorted group unit
      splits a dedup whose two groups name the same projects), no change.
      `json-data.ts`: 17 mutations, 14 caught, 3 held now. An array was
      never an ancestor, so a config whose array holds itself recursed
      until the stack gave out instead of being refused; an array's
      ancestor entry left un-popped read a DAG as a cycle — the shape that
      shows it is a task OBJECT holding an array, used under two names,
      because the object's own pop removes the array in its place; and an
      instance of an anonymous class read "an instance of " with no name.
      Two refusal rows (each on the first load and the worker) and one
      faithful row in `tests/config-eval.test.ts`, each red against its
      mutant.
777.  DONE (2026-09-25, sweeps of `orchestrator/run-report.ts` and
      `orchestrator/run-artifacts.ts`, never named). The markdown report:
      24 mutations, all caught. The `--summarize` / `--profile` writers:
      31 mutations, 23 caught, 8 held now. Every conditional field of a
      summary row had a row setting it except five: a hit's stored CPU and
      peak RSS (what the PRODUCING execution used, item 41's point), an
      admit hold, a timeout and a persistent task's not-ready reason — each
      dropped from the artifact unseen. An aborted GROUP could join the
      aborted list; the profile turned an outcome with a start and no end
      into an event of negative duration; a relative profile target
      resolved against the process directory. Four rows in
      `tests/run-artifacts.test.ts`, each red against its mutants. (Two
      mutants wrote their artifact into the process directory; the
      sweep's worktree kept them off the tree, and they were removed.)
778.  DONE (2026-09-25, sweep of `orchestrator/telemetry-host.ts`, never
      named). 17 mutations, 16 caught, 1 held now. The host hands the
      telemetry source the run's own `warn`; replacing it with a no-op
      survived the whole telemetry fixture, so a sink that throws once the
      run is live was isolated in silence, against the invariant that a
      never-fail plugin still warns. One row in
      `tests/telemetry-lifecycle.test.ts` (a throwing `onRunSummary`
      driven through the handle), red against the mutant.
