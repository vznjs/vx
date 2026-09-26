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
(item 785), and items 779–819 to
`docs/history/2026-09-improvement-loop-779-819.md` that night (item
826), and items 820–852 to
`docs/history/2026-09-improvement-loop-820-852.md` on 2026-09-26 (item
859), so
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

853.  DONE (2026-09-26, the watch loop's SIGINT rows get the grace their
      trap needs). `watch-signals.test.ts`'s two `reachesAsSigint` rows
      are item 852's `reaches` rows run through `vx watch`: a TERM/INT
      trap writes `got.txt` inside a 200 ms grace. That shape failed on
      #929's macOS job with the file missing. These rows test which
      signal arrives, so they now pass a 5 s grace. Next 23(a) records
      the likely link, and 23(b) that its row ran on a 2 s grace until
      item 849.

854.  DONE (2026-09-26, a Ctrl-C'd run no longer lands in `vx last`).
      Before item 849 the signal handler exited before any outcome was
      recorded, so a stopped run left no history, which is what
      `aborted-outcome.test.ts`'s header described. Since 849 the
      stopped run finishes its own path, and `vx last` showed it as
      FAILED with 0 tasks, hiding the run the user wanted. A run the
      process signal stopped now skips the history record; an
      embedder's `RunOptions.signal` abort keeps its record, as before.
      A schema column for "stopped" was the alternative, and it was
      declined: a `SCHEMA_VERSION` bump drops every table. Row:
      `signal-handling.test.ts` › "a Ctrl-C leaves the history as it
      was", which fails without the guard.

855.  DONE (2026-09-26, the Ctrl-C post says what vx does). The site's
      `blog/ctrl-c.md` listed the teardown as SIGTERM to every child and
      an exit straight after the reap. The first has been wrong since
      2026-09-24: vx forwards the signal it got, a SIGINT as SIGINT. The
      second has been wrong since item 849: the run then finishes its
      own end, with the summary, the flushes and the teardowns. Both
      steps now say so.

856.  DONE (2026-09-26, the remote-layer contract names who owns the
      deadline). Core awaits every `RemoteCacheLayer` call and bounds
      none. A `get` that never settles holds its task, and a `put` holds
      the upload drain the run awaits before it closes; since item 849 a
      stopped run waits there too, until the signal's bound. Every
      first-party layer carries its own deadline (turboCache and
      nxCache default to 30 s per request, and reapi bounds every
      call). But the plugin guide's example, which authors copy, used a
      bare `fetch`. The example now passes `AbortSignal.timeout` on
      every request and says why. The contract's comment and
      `layered-cache.md` state the duty. Docs and a comment only.

857.  DONE (2026-09-26, the signal path's own sweep, and a Ctrl-C in CI
      that lost output). Items 849–854's code in `signals.ts` and
      `run.ts`, 14 mutations. Caught at once: the stop call, the wait
      for `run()`, the exit code, the forwarded signal's kind, the
      history guard, the keep-alive line and the scheduler's signal.
      Caught once the suite list was widened: SIGHUP
      (`task-tree-kill.test.ts`) and the awaited abort teardown. Three
      findings:
      - The SIGKILL at exit and the second signal's immediate exit
        survived the second-signal rows. Their child trapped only TERM,
        and since 2026-09-24 a Ctrl-C forwards as SIGINT, so the child
        died on the first signal and the rows tested nothing. Both now
        `trap '' INT TERM`, and both catch both mutants.
      - The stdout drain survived, and the row written to hold it
        (2 MiB printed as the task stops, read only after vx exits)
        passed without it, but failed in the gate. With `CI=true` a
        Ctrl-C lost 0.8 of the 2 MiB: the drain's empty `write` called
        back before the pipe took the bytes. The handler now ends
        stdout and exits in `end`'s callback, the form `bin.ts`
        documents for Bun ≥ 1.4, bounded at 2 s for a reader that has
        gone. The row runs in CI mode, passes 3 of 3 with the fix and
        fails 2 of 2 with the old write. It also fails on the code
        before 849, which never printed the stopped task's frame.
      - `holdPersistent` on an aborted run is equivalent: the abort
        teardown kills those children either way.

858.  DONE (2026-09-26, a stopped run no longer prunes the cache). Since
      item 849 a stopped run finishes its own end-of-run path, and that
      path applies `cacheRetention`. A Ctrl-C while a run waited on
      another run's workspace lock stops it before it holds the lock.
      Its prune then evicted an entry while the other run held the lock,
      the overlap the lock exists to rule out (`vx cache prune` takes it
      too). Reproduced with two live runs and an aged entry the waiter
      did not touch: "vx: cache retention evicted 1 entry". An
      embedder's abort during the wait had the same gap before 849.
      Retention now runs only on a run that was not stopped, and
      `schema.md` says so. Row: `cache-retention.test.ts` › "a stopped
      run evicts nothing", an aborted signal, fails without the guard.
      The row beside it, which evicts, is the control. The rest of a
      stopped run's end prunes nothing shared: the output-dir snapshots
      need a finished task, and the history write is SQLite's own
      concurrency.

859.  DONE (2026-09-26, the trim the loop reached forty at). Items
      820–852 moved to `docs/history/2026-09-improvement-loop-820-852.md`
      in this commit. What that stretch was: the last sweeps of the
      plugin packages' and the site's own files (820–843); the test
      helpers pinned, and the `/tmp` wipe a sweep mutant caused, which
      taught each mutant its own `TMPDIR` (844–847); then a Ctrl-C made
      to end a run properly. vx now removes its temp files on the way
      out (848), lets the stopped run flush and tear its plugins down
      (849), reports it as cancelled, not failed (851), and prints
      nothing that reads as a crash (852). The move paragraph above
      also gains item 826's batch, 779–819, which that trim left out.

860.  DONE (2026-09-26, the ledger's `signal:parent-sigkill-orphans-children`
      row, turborepo#9666, the owner's third ask). A `kill -9` of vx
      left an unsandboxed task's tree under init. A group guard now takes
      it down: one `sh` per vx process (`vx-group-guard`) reads a pipe
      only vx writes. vx lists each spawn's group on it while it holds
      the task, and when vx dies the kernel closes the pipe and the guard
      SIGKILLs every group still listed (`kill-tree.md`).
      - It is started just before the first spawn, so a warm run starts
        nothing (strace: 0 guard execs warm, 1 cold). Started after the
        spawn, the first draft left the guard's own spawn as a window in
        which the task ran unlisted: in the gate's traced sandbox a third
        of the `kill -9` rows found the group unlisted (instrumented: no
        `+pid` line reached the guard). `spawnGuarded` fixed the order,
        40 of 40 there since. A 300-project
        `test --all --no-cache` run (600 tasks) took 4,462 ms against
        4,473 on main (min of 9, interleaved): a tie.
      - A per-spawn watcher in the task's shell was sketched first and
        dropped: it is a job of that shell, so a bare `wait` in a task
        waits on it.
      - It closed a gap the probe found. A traced sandboxed one-shot
        task's strace outlived vx with the whole tree under it
        (reproduced on main); strace is in the guarded group, so bwrap's
        `--die-with-parent` now fires.
      - Rows: `keep-alive.test.ts`, a persistent and a one-shot task's
        grandchild die with vx, and both fail without the guard. The
        control, a released group that outlives a clean exit, fails
        without the release, and "a run that spawns no task starts no
        guard" fails on an eager guard. The unsafe suite's unsandboxed
        control flipped (the backgrounded child dies, the `setsid` one
        lives), and the traced one-shot row fails without the guard.
      - Swept (13 mutants): 6 caught by the rows above, 3 held by rows
        added for them, 4 equivalent. Held: a guard per spawn (the
        warm row's cold run has two tasks and one guard), a guard in
        vx's group (a terminal's Ctrl-C killed it; "a terminal’s Ctrl-C
        leaves the guard…" SIGKILLs vx in the teardown grace), and a
        TERM for the KILL (the one-shot row's child ignores TERM).
        Equivalent: the list-membership check on a release, keeping a
        dead descriptor, and the pid checks, each reachable only once
        the guard is off or on a pid Bun never returns.
      - The ledger row is `fixed-in-item-860`, the last open one, so
        the ledger law's verdict set is now covered, fixed and n/a.
      - What remains: a `setsid` daemon, unsandboxed.

861.  DONE (2026-09-26, `orchestrator/signals.ts` swept again after
      items 849–858 reshaped it). 19 mutants: 14 caught, 1 held now, 3
      equivalent, 1 unobserved. The guard from item 860 was standing in for two
      guarantees. Without the SIGHUP handler, vx died of the hang-up and
      the guard SIGKILLed the task. Without the second signal's SIGKILL,
      the guard's kill at exit did the same. Either way the rows saw a
      dead grandchild.
      - Driven with the guard off, both are caught, so each is held as a
        pair.
      - The SIGHUP handler is also held alone now by
        `task-tree-kill.test.ts` › "SIGHUP gives the grandchild its
        SIGTERM cleanup, not only a death". The ledger's SIGHUP row cites
        it.
      - Equivalent: the persistent registry in the second signal's sweep
        (a ready server is in `liveChildren` its whole life) and `runEnd`
        before the stop (the run's own end clears the region). The cache
        close on the second signal's exit survived and is unproven either
        way: no row observes it. `signals.md` records each.

862.  DONE (2026-09-26, the run lock's exit hook from item 848, swept).
      Three of five mutants survived: without the unlink, without the
      rmdir, and without the hook itself. The row meant to hold them,
      `signal-handling.test.ts` › "a second signal exit leaves no run-lock
      entry behind", sent its two SIGINTs back to back. A process can
      receive them as one, so the row ran the first-signal path. That
      path leaves through run()'s finally since item 849, which releases
      the lock, so the exit hook never ran.
      - The row now sends the second signal once the task's `trap … INT`
        has written that it heard the first. All three mutants are
        caught.
      - Equivalent: the hook's once-only flag, since a second hook's
        unlink finds nothing and is caught.
      - Class grep: the other second-signal rows already space their
        signals (100 ms, or a teardown marker), and item 861's sweep
        showed they catch their mutants.

863.  DONE (2026-09-26, Next 6 re-measured after item 860, and the last
      exit hook item 848 added swept). Warm, 1,000 projects, source runs,
      interleaved min-of-15, one workspace copy per arm pre-warmed by that
      arm:
      - before item 860 (60ef0159): min 530.8 ms, median 579.6;
      - main: min 528.7, median 574.3;
      - A/A control (main against a third copy): min 521.1, median 561.3.

      A tie: the warm path spawns nothing, so it never starts the guard,
      and the gap is inside the A/A spread. The cold number is item
      860's own (a tie at 600 tasks).

      `vx-migrate`'s `turbo-cache` temp hook, 4 mutants:
      - caught (2): the exit hook's unlink and `trackTemp`, both by
        "a process exit with a verified body unread leaves no temp";
      - equivalent (2): the delete from the live set (the exit then
        unlinks paths already gone, each with a random UUID) and the
        once-only flag (a second hook finds nothing).

      The sandbox's strace-log hook had item 862's flaw. Its row sent one
      SIGINT, the task died of it, and the run ended the normal way,
      which reads and removes the log. The hook's unlink mutated away
      still passed (control and mutant both green under a short
      `TMPDIR`). The row, renamed "a second signal exit leaves no strace
      log behind", now traps INT and sends the second signal once the
      trap has fired. The mutant fails it in 6 of 6 runs, and the fixed
      row passes 5 of 5. Two mutant runs before those passed, each
      exiting at the 2 s grace, i.e. by the first signal's path. That did
      not recur, and the cause is unproven. With the run lock's (862),
      all three of item 848's exit hooks are now held.

864.  DONE (2026-09-26, Next 23(b), evidence for the next failure). The
      row "at the moment vx exits on a signal every task process is gone
      and its pipes are closed" still cannot reproduce its one red: 60
      sandboxed runs were clean, 30 idle and 30 beside six CPU burners.
      Its leading suspect is a zombie read as alive through a sandbox's
      procfs, and nothing told that apart from a leak. Now, for each
      process alive at the exit, the row polls 3 s and says "gone within
      N ms" or "still alive 3 s after the exit". vx released every group
      before it exited, so its guard (item 860) kills nothing there to
      blur the two. Driven with a leak (signals.ts without its SIGKILL
      sweep), the row names `child: … sleep 30, still alive 3 s after the
exit`.

865.  DONE (2026-09-26, a gap in item 860's guard, found by reading it
      again). The runner lets a group go when its LEADER exits. In a
      teardown the leader is often the first to go: a shell dies on the
      signal while the child it backgrounded ignores it, or traps it,
      and runs out the grace. The group was off the guard's list
      mid-grace, and a `kill -9` of vx there left the child under init.
      - Reproduced for a Ctrl-C of a one-shot task and for the end-of-run
        persistent shutdown.
      - `holdGroups` now keeps a teardown's groups listed until its
        SIGKILL sweep has settled. A release that arrives meanwhile is
        written when the hold ends. Holds count, so two teardowns over
        one server let it go once.
      - Rows in `keep-alive.test.ts`, each failing without the hold (3 of
        3): "a kill -9 in a Ctrl-C’s grace takes the child of a shell that
        died on the signal", and "a kill -9 in the persistent shutdown’s
        grace takes the server a dead shell left".
      - The class, grepped: the readiness timeout of a persistent task
        had the same gap, and a wider one. Its SIGKILL waits on an
        unref'd timer, so a vx whose run ended inside the grace exited
        with no kill at all, and a server that trapped TERM behind a dead
        shell lived on. It holds the group until its SIGKILL now, and
        vx's exit hands the group to the guard. Row: "a never-ready
        server a dead shell left goes with a vx that exits inside the
        grace", failing without the hold (2 of 2). The one-shot timeout
        already releases only after its grace settles.
      - The second row's first draft passed without the fix: its escaped
        quotes broke the server's trap, so no server was ever there to
        leave behind. It waits for the shell's death too, since a vx
        killed before handling that exit still held the group.
      - Also: item 863's closing sentence (all three of item 848's exit
        hooks held) had landed at the end of item 864, because 864 was
        inserted mid-way through 863's text. It is back under 863.

866.  DONE (2026-09-26, item 865's `holdGroups` and its three callers,
      swept). 6 mutants: 4 caught, 2 unheld.
      - Caught by the three rows 865 added: a release that ignores the
        hold, and each caller letting go at once (the signal stop, the
        persistent shutdown, the readiness timeout).
      - Unheld: the deferred release never written, and the hold count
        ignored.
      - The first leaves a stale entry. Every held group is SIGKILLed
        before its hold ends, so the entry's only reach is a later task
        whose group gets that pid back in a long `vx watch` session, and
        the guard would kill its leftovers at vx's exit.
      - The second needs two teardowns holding one live group while a
        release lands between them: a signal stop overlapping the
        end-of-run persistent shutdown, a timing race no row drives.
      - Neither had a row then. Both are held since item 870, driven
        directly.

867.  DONE (2026-09-26, two of today's rows red on macOS CI, on #943).
      - Keep-alive's "a never-ready server a dead shell left goes with a
        vx that exits inside the grace" asserted the server's SIGTERM
        mark. The trap waits for the loop's `sleep 0.05`, and a vx that
        exits first hands the held group to the guard, which may kill it
        before the mark: the fix racing its own witness. It now checks a
        mark the server writes on start, and still fails without the
        hold.
      - Signal-handling's "a second signal exit leaves no run-lock entry
        behind" left the lock directory (entry unknown). Reading
        run-lock.ts found a real race: `release()` unlisted its taking
        before its async unlink and rmdir, so an exit between the two
        found nothing to remove. Reproduced in-process: start a release,
        emit `exit`, and the directory is still there.
      - The taking now stays listed until the directory is gone, and the
        exit hook tries the rmdir even when the entry is already
        unlinked. Row: `run-lock.test.ts` › "an exit while a release is
        under way still removes the lock", failing without the fix.
      - Whether that race was the macOS red is not proven: the second
        signal should come before the 200 ms grace ends the run. The
        lock row now names what a leftover directory holds, so a
        recurrence says whether the hook ran.

868.  DONE (2026-09-26, item 867's race, the class grepped). Two more
      exit-cleanup lists struck their file before its async unlink
      landed, so an exit in between left the file:
      - `vx-migrate`'s verified-download temp (`removeTemp`);
      - the sandbox's strace log.

      Both now unlink first and unlist after. Row:
      `vx-migrate/tests/turbo-cache-exit.test.ts` › "an exit while a
      verified temp is being removed still takes it". It mocks
      `node:fs/promises` so the unlink stays pending, emits `exit` inside
      that window, and fails without the fix. An earlier draft timed the
      exit with twenty microtasks, and it passed without the fix: the
      cancel awaits the file reader first, so the window was never
      reached. The strace-log twin got its row in item 871. The other `.delete`
      sites clear kill registries, not exit-cleanup lists.

869.  DONE (2026-09-26, a survivor of the item 849 sweep, re-driven). In
      `run.ts`, the `await aborting` before `leftRun()` (the signal
      stop's teardown finishing before the handler may exit) survived
      the targeted mutants of 849. It was never recorded.
      - On main now, it is caught by `task-tree-kill.test.ts` › "a
        grandchild's SIGTERM cleanup gets the grace after its shell has
        exited" and › "SIGHUP gives the grandchild its SIGTERM cleanup,
        not only a death".
      - Item 865 made it observable. Without the await, vx exits
        mid-grace, and the guard SIGKILLs the still-held group and cuts
        the cleanup short. Before 865 the grandchild outlived vx and
        finished its cleanup unseen.
      - Its sibling there, `holdPersistent` on a stopped run, stays
        equivalent as 857 recorded.
      - Audited with the same lens: `vx watch` stops its held servers
        through `terminateChildren`, so 865's hold covers watch too.
        Nothing new.

870.  DONE (2026-09-26, the two `holdGroups` mutants item 866 left
      unheld, driven directly). No end-to-end run reaches them, but a
      child process can. `tests/kill-tree-hold.test.ts` has a child spawn
      a guarded task, hold and release its group by hand, then SIGKILL
      itself; the guard's EOF kill decides whether the task's grandchild
      writes `late.txt`.
      - "a release deferred by a hold is written when the hold ends"
        catches the release that is never written.
      - "a group two teardowns hold stays listed until both let go"
        catches the count that lets go at the first of two holds.
      - The control, a held group whose release never came, is the
        guard's.
      - All three mutants of `kill-tree.ts`'s hold are caught by the new
        file (the release that ignores the hold as well).

871.  DONE (2026-09-26, item 868's strace-log fix, given its row). The
      window sits inside a sandboxed run, and an in-process one reaches
      it. `tests/sandbox-trace-exit.unsafe.test.ts` mocks
      `node:fs/promises` so the trace log's unlink stays pending, runs a
      task through `runSandboxed`, and emits `exit` once the removal has
      begun. The log is gone with the fix and left without it.

872.  DONE (2026-09-26, today's two lessons into CLAUDE.md's rules). Two
      signals sent back to back can land as one (862, 863). An exit
      hook's list drops an entry only after its cleanup lands, and a
      window like that is driven with the async call held pending, not
      with microtasks (867, 868).

873.  DONE (2026-09-26, found by an adversarial review of today's
      process-lifecycle code). A sandboxed task's host port bridges (one
      `socat TCP-LISTEN:<port>` per `localBinding` port) were plain
      children of vx. They were in vx's own group, which the guard does
      not list, so a `kill -9` of vx left each one listening under init.
      The next run's bridge for that port then failed to bind, silently,
      since the bridge's stderr is ignored.
      - Reproduced with the CLI: a sandboxed server on a bridged port,
        `kill -9` of vx, and the host port still accepted connections 3 s
        later.
      - The bridges are now spawned through `spawnGuarded` in a group of
        their own. `releaseBridges` SIGTERMs the group (a socat forks per
        connection) and strikes it from the guard's list once it has
        exited.
      - The spawn-failure return of `runSandboxed` now releases the
        bridges it had started, too.
      - Row: `sandbox-runtime.unsafe.test.ts` › "a kill -9 of vx takes
        the host side of a port bridge with it", failing without the
        fix. Its first draft probed the port with `Bun.connect`, which
        read the live bridge as closed on the second call. It uses
        `node:net`'s `connect` event now.
      - Seen once in this item's first gate, and unrelated to the diff:
        `runner.test.ts` › "the peak is the child’s own, never the
        parent’s footprint handed back" hit bun's 5 s default timeout.
        It allocates about 900 MB while 12 shards run. It passed 5 of 5
        alone and the re-run gate was green. The cause is unproven.
      - The review's other finding stays open for its own item: an
        exited persistent child stays in the registry, so a teardown
        signals its old pid's group, which the kernel may have handed to
        another group.

874.  DONE (2026-09-26, the adversarial review's other finding). A ready
      persistent server stays in the run's registry after it exits, and
      keep-alive reports it from there. The end-of-run teardown, the stop
      and the second signal's exit then signalled `-pid` for it. Once
      the group is empty its number is free, and the kernel hands it to
      the next process group that needs one: on a long run that wraps
      `pid_max` (32,768 in many containers), a stranger's.
      - `runPersistent`'s exit now marks a child whose group went with
        its leader. `killTree` never signals it again, and `groupAlive`
        reads it as gone, so a teardown does not wait out a grace on a
        stranger's group either.
      - A group that still had a member at the leader's exit keeps its
        number reserved and is signalled as before. The readiness
        timeout's kill timer, which outlives an early exit, is covered by
        the same mark.
      - Row: `persistent.test.ts` › "a server that exited mid-run is not
        signalled at the end: its group number is free". It spies on
        `process.kill`, sees SIGTERM and signal-0 probes to `-pid`
        without the fix, and only the exit's own probe with it.

875.  DONE (2026-09-26, a gate row past bun's 5 s default twice today).
      `runner.test.ts` › "the peak is the child’s own, never the parent’s
      footprint handed back" holds 300 MB and spawns a bun that allocates
      600 MB. Alone it takes about 0.6 s. Under the gate's twelve shards
      it ran past 5 s in two gates today, and its neighbour, "reads a
      known allocation back as bytes", took 2.3 s against its usual
      ~70 ms. The whole shard was slow there; why is unproven.
      - These rows make no claim about time. The three heavy peak rows
        (the allocation, the parent floor, the CPU burn) get a 20 s
        budget, `HEAVY_ROW_MS`, instead of the default.
      - Item 873's note about the first timeout is this one.

876.  DONE (2026-09-26, the review's last lead and the gap its probe
      seemed to show, both refuted; no code change).
      - The lead: a retry of a sandboxed task with a `localBinding` port
        rebinds the host bridge while the old socat, SIGTERMed and not
        awaited, still listens. A probe (the server writes `up.txt`, then
        a host `curl` of the port) failed 3 to 6 runs in 10 with a retry,
        without one, and on the tree before item 873. The retry was
        never the cause.
      - The gap it seemed to show (a fetch right at the ready mark
        fails; "Couldn't connect" or "Empty reply") was the probe's own.
        `up.txt` is a declared write path, so vx creates it empty before
        the task starts (schema.md, "A write grant's shape"). The probe
        waited for the file to exist and fetched before the server had
        started. It is 0 bytes at first sight in 3 runs of 3. Waiting
        for its content instead gives 10 fetches in 10 on the unchanged
        tree, at ~5 ms to the first byte.
      - A patch that awaited both socats' readiness before the command
        was written and dropped: no row fails without it.

877.  DONE (2026-09-26, found while probing 876). Every run of a task
      with a `localBinding` port list left its bridge socket,
      `vx-port-<tag>-<port>.sock`, in the sandbox tmpdir. The task's
      socat binds it and dies with the namespace without unlinking it:
      176 had piled up in this box's `/tmp/claude`.
      - `releaseBridges` unlinks each port's socket, and the sockets are
        listed with the strace logs on the exit hook (item 848's), so a
        signal exit mid-task removes them too.
      - Rows: `sandbox-bridge-socket.unsafe.test.ts`, "is removed when
        the task ends" and "is removed by an exit while the task runs".
        Both fail without the fix, and the second fails with only the
        exit-hook listing removed.

878.  DONE (2026-09-26, macOS CI on #954). `signal-handling.test.ts` ›
      "a second signal exit leaves no run-lock entry behind" waited its
      10 s for the task's INT trap marker and failed. The task was spawned
      with the file's 200 ms `VX_KILL_GRACE_MS`, the class items 852 and
      853 fixed in its twins: a loaded runner SIGKILLs the shell before
      its trap runs.
      - The two-signal case gets a 5 s grace; its second signal follows
        the marker, so the row does not wait the grace out. The
        one-signal case keeps 200 ms: its trap never ends the task, so
        the grace is its whole wait.
      - Not reproducible on Linux, and so not proven: the rows it copies
        have held since 853.

879.  DONE (2026-09-26, found beside 877). A green gate left ~27
      entries in the sandbox tmpdir, and 1,080 had piled up in
      `/tmp/claude`.
      - `vx-plugin-pkgs-2-*` (478): `tests/helpers/plugin.ts` sweeps
        the roots of dead pids. Under the sandbox every shard's test
        process is pid 2 in its own namespace, so pid 2 always looked
        alive and nothing was swept. A root idle for an hour is now
        swept whatever its pid says. Row: `fixture-helpers.test.ts` ›
        "sweeps a root idle for an hour even when its pid is alive",
        which fails without the change.
      - `nxt-e2e-*`: `orchestrator-run.test.ts` made a second workspace
        it never used or removed (`void f1`). The workspace is gone.
      - `vx-cio-link-*`: the link's parent directory was never removed.
        `vx-bunver-*`: the `vx info` row's root was never removed. Both
        are removed now.
      - `vx-run-*` (keep-alive): a SIGKILLed vx leaves its run lock,
        keyed by the fixture root. The file's `afterEach` removes
        `runLockPath(root)`.
      - Each file, run alone, now leaves nothing in the temp dir. The
        gate after the fix left the live shards' 12 plugin roots (the
        next run an hour on sweeps them) and one other root.
      - Open, cause unknown: in two gates, one root was left PARTLY
        removed. It still held a cache dir and some fixture files, and
        others were gone: `vx-plan-e2e-*` with `caches/plain`
        (`plan-predict.test.ts`), and `vx-prep-*` with `.vx/cache/cache.db`
        and `.git/info/exclude` (`prepare-run.test.ts`). Both files remove
        their root in `afterEach`, and neither reproduced alone.

880.  DONE (2026-09-26, found chasing 879's open note). The input
      enumeration's `git status` refreshed the index under `index.lock`
      whenever tracked files were stat-dirty. A user's own `git add` run
      beside vx failed on the lock: 12 of 1,165 across 80 runs of a
      400-file workspace with the files touched between runs.
      - Every enumeration spawn now runs `git --no-optional-locks`, as
        editors and shell prompts do: 0 of 1,121.
      - Warm A/B, 20 projects and 1,000 files, clean tree, interleaved:
        min 142.0 against 143.3 ms and median 155.0 against 155.7, N=21
        (a first pass of 15 split the other way). A tie. The cost moves
        to a stat-dirty tree: git no longer caches the refresh, so each
        run re-reads those files (98 ms for 5,000) until any git command
        refreshes the index.
      - Not fixed: `--affected`'s `git diff <base>` rewrites the index
        with the flag too (git 2.43, probed), and the plumbing
        `diff-index` would report every stat-dirty file as changed.
      - Row: `git-optional-locks.test.ts`. Every tracked file is
        stat-dirty; the enumeration leaves `.git/index` byte for byte,
        then a bare `status` rewrites it. The row fails without the flag.
      - 879's partly-removed roots are not proven to be this: the row
        rules the enumeration out as a writer, and nothing yet ties it
        to them.

881.  DONE (2026-09-26, the gate for 880). Item 877's row "is removed
      when the task ends" failed in a gate. A socket for its port was
      left, but it was an old one, bound at 13:11 before 877 landed. The
      row took any tag's socket for the port, and a box that ran bridged
      tasks before 877 still holds 180 of them, so a free port can be
      one of theirs.
      - Both rows now watch the socket their own run binds (one absent
        before the run) and hold the port's set to what it was before.

882.  DONE (2026-09-26, CI on #955 went red on "a kill -9 of vx takes the
      host side of a port bridge with it"). A sandboxed persistent server
      held past its run lost its host port, and SRT's proxies, about
      40 ms after the summary. This hit a foreground `vx run dev` and
      every `vx watch`, and dated from before item 877 (the row failed 5
      runs in 6 there).
      - The cause: `run()` calls `resetSandbox()` at its end, BEFORE the
        keep-alive wait. The reset released every host bridge. A watch
        cycle's run reset the same way under a held server. The row
        passed only when its first connection landed inside that window.
      - The fix: the runtime lists each sandboxed server's tag
        (`wrapSandboxedCommand`'s `server`). While one runs, a reset
        releases only the bridges no server owns and defers SRT's reset.
        The last server's `releaseBridges` runs the deferred reset. A
        persistent spawn that fails releases its tag at once.
      - Probe (a foreground `vx run serve`, then curl the port): 0 in 8
        before, 6 in 6 after.
      - Row: `sandbox-runtime.unsafe.test.ts` › "a held server keeps its
        port through its run’s reset and a later run’s, until it is
        stopped". It holds the server with `holdPersistent`, runs a
        second sandboxed run, and checks that `SandboxManager.reset` is
        not called until the stop and is called once after it. It fails
        without the fix, and without either the listing or the deferred
        reset.
      - While chasing this, 877's exit row moved into a child process. A
        real `process.exit` drives it, where it had emitted `exit` in the
        suite's own process, which runs SRT's hooks. That was not the
        cause (the kill -9 row failed alone too); the move stays because
        it tests the real exit.
      - Seen, and chased in 883: this box held leaked sandboxes, `bun
serve.ts` under bwrap, some parented to init.

883.  DONE (2026-09-26, the leaks 882 saw). Two sources.
      - Sixteen `vx run serve` processes sat under init, each holding a
        sandboxed server in the foreground. They were the kill -9 row's
        own vx: the row failed its positive check (882's bug) before
        reaching its `SIGKILL`, and nothing else ever stopped them. The
        class: `keep-alive.test.ts` (eleven spawns) and
        `task-tree-kill.test.ts` (`spawnVx`) also kill vx only after
        their assertions. Each now tracks the vx it spawns and SIGKILLs
        any still running in `afterEach`. The kill -9 row kills vx in a
        `finally`. Probe: a failure injected after a keep-alive spawn
        leaves 0 vx with the tracking and 1 without it.
      - Five sandboxes survived a `kill -9` of vx, and one more in 6 runs
        of the kill -9 row while the box still held those orphans. In
        the one inspected, the survivor was the namespace's init, the
        inner `bwrap`, in its own session (`--new-session`) and holding
        only the inner port socat. The guard's group kill reaches the
        outer `bwrap` alone, and the inner one did not die of
        `--die-with-parent`. It did not reproduce after the orphans were
        cleared: 0 in 25 runs of the row and 0 in 15 of a CLI probe.
        Open, cause unknown; the next leak is read from the survivor's
        `NSpid` and children before it is killed.

884.  DONE (2026-09-26, reviewing 882's lifecycle). 882's deferred reset
      raced the next run. A held server's exit starts the reset unawaited,
      and a watch cycle stops its server and starts its run straight
      away, so the run's `initSandbox` found SRT still up and hot-reloaded
      it, and the reset landed after and tore SRT down under the cycle.
      - `initSandbox` now waits for a reset in flight.
      - Row: `sandbox-runtime.unsafe.test.ts` › "the next run’s sandbox
        starts after the reset a stopped server deferred, never under it".
        It holds `SandboxManager.reset` for 300 ms and pins the order.
        Without the wait it reads `reset`, `initialize`, `reset`.
      - A `vx watch` probe (a sandboxed server on a `localBinding` port,
        a sandboxed build, two cycles, then Ctrl-C) kept the port up
        across both cycles. After the exit it found no host socat, no
        socket and no process of the workspace's left.

885.  DONE (2026-09-26, Next 6 re-measured after the day's items 873–884;
      the run path gained 880's `--no-optional-locks` and the sandbox
      lifecycle of 873, 882 and 884). Warm, 1,000 projects, `run build
--all`, source runs, interleaved min-of-15, one workspace copy per
      arm pre-warmed by that arm:
      - item 863's head (67eab83a): min 393.8 ms, median 422.2;
      - head (item 884's branch): min 379.5, median 433.2;
      - A/A control (head against a third copy): min 375.9, median 422.3.

      A tie: the gap is inside the A/A spread, and a warm run spawns no
      sandbox. The absolute figures are this container's under the
      day's load, above item 863's 530 ms and below it in no comparable
      way.

      The lifecycle review 884 came out of found nothing further:
      - `vx mcp` handles one message at a time and its tools are
        read-only, so the doctor's `resetSandbox` never overlaps a run;
      - `vx watch` restarts a sandboxed server each cycle, as `cli.md`
        documents, and on Ctrl-C leaves no host socat, bridge socket or
        process of the workspace's.

886.  DONE (2026-09-26, a stale hit found by a review agent and
      reproduced on Bun 1.4.2). The skip-restore check compared an
      output's size, mode and millisecond mtime with the entry's row. A
      task that sets its outputs' mtime (`tar -x`, `cp -p`, `rsync -a`,
      `SOURCE_DATE_EPOCH`) gives two entries identical rows when the
      sizes agree. Back on v1 with v2's bytes on disk, vx reported
      `1 up-to-date` and left v2's bytes: a green run with the wrong
      output. A version bump of one length or a branch round trip is
      enough to hit it.
      - Each `output_files` row now carries the inode and ctime this
        machine saw after the save or restore that wrote the file
        (`recordOutputStamps`, called by miss-save and hit-restore,
        written with the directory snapshots). `isOutputsCurrent`
        requires them. No task sets a ctime and a restore's rename gives
        a new inode, so a forged mtime (`touch -r`), the documented blind
        spot until now, is caught too. A row with no stamp (a remote
        ingest, or a file that had changed when the stamp was taken) is
        never current: the hit restores and stamps.
      - `SCHEMA_VERSION` v27 → v28 (the index resets once). The cache
        key is unchanged and `CACHE_VERSION` is not bumped: every stored
        artifact held the right bytes, and only the check that skipped
        restoring them was wrong.
      - Rows:
        - `stale-hit.test.ts` › "a round trip between two entries whose
          outputs carry one fixed mtime restores the right bytes";
        - `cache.test.ts` › "two entries with one size and one fixed
          mtime are told apart";
        - `cache.test.ts` › "a forged mtime is caught", flipped from the
          old "remains the documented blind spot";
        - `cache-baseline.test.ts`'s forged-mtime tail, flipped the
          same way.

        All of them fail with the stamp dropped from the check. Six
        existing rows fail without the stamp after a save; the round
        trip's steady-state `up-to-date` needs the one after a restore.

      - A/B at 1,000 projects, interleaved, one copy per arm (the schemas
        differ):
        - warm, min-of-15: main min 367.7 ms / median 424.2, head 387.3 /
          420.5, A/A 363.4 / 412.7. A tie; the warm path takes no new
          stat.
        - cold, five reps: main 3,629.6 / 3,799.1, head 3,577.6 /
          3,903.5. A tie inside a ~500 ms spread.

        The warm run after a cold one reads 1000 up-to-date.

      - Also probed and refuted: 879's leading suspect for its partly
        removed roots, the early git enumeration outliving a refused
        `prepareRun`. A refused run over 300 packages leaves no git child,
        at the throw or 300 ms later: git finishes before the config
        refusal.

887.  DONE (2026-09-26, a key review agent's lead, reproduced). A file's
      git mode was not in the key. The fold took `(relPath, oid)`, and a
      blob OID holds no mode. A `chmod +x` on an input, dirty or
      committed, kept the key while `git status` and `--affected` saw
      `M`, and the task replayed its old output. So did a symlink
      replaced by a file holding its target string (`T`).
      - The identity folded is now the OID prefixed by the git mode
        unless that is a plain file's: `100755:<oid>`, `120000:<oid>`,
        the bare OID for 100644 (`fileIdentity`, git-inputs.ts). The
        `ls-files` parse spells it from the index, and `hashFile` from
        the lstat it already takes (owner execute bit). A plain file's
        key is unchanged, so only executables and symlinks re-key once;
        no `CACHE_VERSION` bump (a self-healing key fix).
      - `hashFiles`, the batch form the config closures use, spells it the
        same way. The gate's "agrees on a symlink too" row caught the
        first draft, which had left it bare.
      - Row: `stale-hit.test.ts` › "a mode change re-keys the task: an
        executable bit, a symlink swapped for a file". It reads `miss`
        on the chmod, `up-to-date` once committed (the index path and the
        stat path agree), and `miss` on the swap. It fails without the
        fix, and with either source left unprefixed. `git-oid.test.ts`'s
        pins now carry the prefix.
      - The same review's lead 3 was a docs claim: `caching.md` said a
        link to an in-project file tracks that file. It does only when
        the file matches the task's globs, and the sentence and the
        `file-hashes.ts` comment now say so.
      - Warm A/B, 1,000 projects, min-of-15: main min 393.1 ms / median
        416.6, head 370.4 / 409.5, A/A 368.0 / 398.3. A tie.
      - Lead 2 (the config cache replaying a config that calls
        `machineParallelism()`) is item 888.

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
   item 885 (2026-09-26, the day's items 873–884, a tie at 1,000 projects; 863 was the one before), and the
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
    `docs/history/2026-09-improvement-loop-632-654.md`, 719–743 in
    `docs/history/2026-09-improvement-loop-719-743.md` (entries
    14aq–14di and loop item 677 in the next-log file), 744–778 in
    `docs/history/2026-09-improvement-loop-744-778.md`, 779–819 in
    `docs/history/2026-09-improvement-loop-779-819.md` and 820–852 in
    `docs/history/2026-09-improvement-loop-820-852.md`. The loop above
    is the record since 853 (14dj in the next-log file); 14dk is below,
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
23. **Two signal rows went red once each, root cause unproven
    (2026-09-25).** (a) `watch-signals.test.ts` › "SIGINT during the
    initial run reaches its task as SIGINT", on the macOS job of #878.
    The recap cut the assertion, it passed on the same code in #879, and
    it passed 49 of 49 Linux repetitions. Its twin in `signal-handling.test.ts` failed
    the same way on the macOS job of #929 with the assertion in the log:
    `got.txt` missing, the shell SIGKILLed at the 200 ms grace before
    its trap ran. Both rows now pass a 5 s grace (items 852, 853). That
    (a) was the same cause is likely, not proven. (b) `signal-handling.test.ts`
    › "at the moment vx exits on a signal every task process is gone and
    its pipes are closed", in a full local gate. On SIGINT one task pid
    was alive at vx's exit; the shard passed 4 of 4 alone and a gate
    re-run passed. Under the sandbox `procfsIsOwn()` is false, so the
    test's `isAlive` counts a zombie, and `slow`'s `sleep 30 &` starts
    with SIGINT ignored and dies only to the SIGKILL. An orphan zombie
    that init has not reaped yet is the leading suspect, not a proven
    one. One fact since: until item 849 every vx that file
    spawned ran on the 2 s default grace, not the 200 ms it set
    (`Bun.spawn` without `env` passes the startup environment), so the
    failure was seen at 2 s. Both rows now print what they saw on a mismatch (item 804); the
    next failure names the process and what vx said, and this entry
    closes on that evidence. Item 864: 60 sandboxed runs of (b) (30 idle,
    30 beside six CPU burners) were clean, and (b) now also says, for
    each process alive at the exit, whether it was gone within 3 s (a
    zombie awaiting its reaper) or still alive (a leak). vx releases every
    group before it exits, so its guard kills nothing there to blur the
    two.

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
