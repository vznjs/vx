# Shipped, 2026-09 — improvement-loop items 853–892

The record `docs/STATUS.md` carried until 2026-09-26, moved here whole
when the loop reached forty items (item 893). A PREFIX,
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
`2026-09-improvement-loop-744-778.md`, items 779–819 in
`2026-09-improvement-loop-779-819.md`, items 820–852 in
`2026-09-improvement-loop-820-852.md`; items 893 onward continue in
`docs/STATUS.md`.

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

888.  DONE (2026-09-26, the same review's lead 2, reproduced). The config
      evaluation cache counted every import from `@vzn/vx` as pure, on
      the ground that `defineProject` / `defineWorkspace` are identity
      functions. Core also exports what reads the machine
      (`machineParallelism`, `machineMemoryBytes`, `collectInfo`) and the
      disk. A config computing `jobs=${machineParallelism()}` ran under
      `taskset -c 0` (`jobs=1`), and a plain run on the 4-core box then
      read `up-to-date` with `jobs=1`: the cached config kept the task's
      key.
      - An `@vzn/vx` import is pure now only when every value it takes is
        in `PURE_CORE_EXPORTS`: `defineProject`, `defineWorkspace`,
        `splitTaskId`, `normalizeGlob`, `isLiteralPattern` and three
        constant tables. Types are always fine. Any other name, a
        namespace or default import, or an `export *` of the package
        evaluates live.
      - Rows in `config-cache.test.ts` (item 888): the pure spellings
        still key (an alias, a multi-line list, types); seven impure
        spellings do not, and that row fails with the check removed. A
        third row holds every allowlisted name to a real export of
        `src/index.ts`.
      - The CLI repro reads `miss` with `jobs=4` on the second run.

889.  DONE (2026-09-26, a remote-cache review agent's one reproduced lead).
      With two remote cache plugins over one local store (`turboCache()`,
      `nxCache()`), and the artifact only in the second remote, the
      prefetch pulled it into the shared store through the second layer.
      The task's own lookup walked from the first layer, which found the
      copy locally and returned `source: 'local'`. So the outcome read
      `cache-hit` instead of `cache-hit-remote`, the summary said
      "1 local", and telemetry counted the saving as local, against
      caching.md's promise that provenance survives. The bytes were right.
      - `ChainedCache.get` now asks first the layer a prefetch recorded
        for the hash.
      - Row: `chained-cache.test.ts` › "a hit a later layer prefetched
        into the shared store still reports remote". It fails without the
        fix.
      - The same review found nothing else, and checked these: the cache
        policy flags end to end against a fake Turbo server; integrity (a
        truncated or garbage body degrades to a miss); no upload of a
        failed or stale task; every remote error degrading to a miss;
        tokens staying out of logs and keys. It also noted, not as a
        defect, one wasted GET under `local:,remote:rw` after a batch
        probe had answered absent.

890.  DONE (2026-09-26, a scheduler review agent's one reproduced lead).
      `cli.md` lists `--filter '...^<pattern>'` as "only the transitive
      dependents, excluding the matched package", but `parseFilter`
      stripped the `...` and left the `^` in the name glob. So `...^a`
      matched no package, and the run refused with "no projects matched
      filter(s)" (exit 1).
      - The parser now reads `...^` as `onlyDependents`, and the expansion
        leaves the matched package out, as `^...` does for dependencies.
      - Rows: `filter.test.ts` (item 890), for the parse and for the
        selection over a three-package chain (`...^utils` → app, ui;
        `...^app` → nothing). Both fail without the fix. On the review's
        fixture the CLI now runs b, c and e's tests and a's build, not
        a's test.
      - The same review found the scheduler consistent with the docs. It
        checked `^build` ordering across all four dependency kinds and
        cycles, the `dependsOn` forms and groups, `--continue`'s three
        modes, `--concurrency` peaks (exact over 18 tasks), no double
        runs, retries with the cache, and the other `--filter` forms.
      - Open, unspecified rather than contradicted: a persistent server
        pulled in only as a dependency that crashes after readiness,
        while its dependant still runs, leaves the run green if the
        dependant passes, and the end-of-run pin still lists it as
        running. And `vx run g --all --exclude-dependencies` on a group
        runs nothing and exits 0.
891.  DONE (2026-09-26, a watch review agent's three reproduced leads).
      `vx watch` re-read its watched set only after a member directory
      came or went under a package glob's base. Three edits that change
      the set waited for a restart while the loop looked alive:
      - A package whose directory appeared before its `package.json`
        (an editor, a `git checkout`) was never watched: the base's
        non-recursive watcher heard the directory, the re-read found no
        package, and the manifest written inside it was no event.
        `armPending` now arms each such directory on its own.
      - A dependency added to a `--filter` scope's `package.json` ran in
        the next cycle, but its own edits were silence: the closure was
        computed at start.
      - A config that started declaring `workspaceFiles` kept the
        per-project arms, so the declared root file was no event.
      - The fix: a cycle started by a `package.json`, a project config or
        the workspace config re-reads the set (`shapesWatchedSet`), and
        the re-read re-decides the arm's shape (`dropMode` / `armMode`).
        A dropped arm no longer swaps in a poller when its late proof
        fails.
      - Rows: three in `watch-loop-members.test.ts`, each failing
        without the fix. Mutants of the pending arm, the manifest check,
        the config check and the swap each fail their row.
      - Also fixed: `cli-watch.md` listed `--verbosity` as passing
        through, but watch refuses it above 0.
      - Still open: a `pnpm-workspace.yaml` edit that adds a new base
        directory is a cycle, but the base is watched only after a
        restart.
892.  DONE (2026-09-26, item 890's open note on persistent servers).
      A persistent server that became ready and then died on its own
      while its dependants ran:
      - Dependency-only, the run stayed green and said nothing: the
        server's outcome is `success` (it became ready), and the SIGTERM
        at the end of the graph went to a process already gone.
      - Requested (`vx run srv e2e`), the run did fail, but the pin after
        the summary still listed it as running.
      - Now `shutdownPersistent` returns the dependency-only servers that
        ended on their own and not cleanly (a non-zero exit or a signal),
        read before the stop so the SIGTERM's own 143 is never one. Each
        fails the run, and vx names it (`vx: <id> exited with code <n>`,
        then "before the run stopped it"). The pin lists only the servers
        still up. An exit 0 on its own stays green (a daemon that forks
        and returns).
      - Rows: `keep-alive.test.ts` (item 892). The two crash rows fail
        without the fix. The control (exit 0 on its own, and a server the
        run stops) catches two mutants: dropping the exit-0 exemption, and
        dropping the has-ended check.
      - Still open from item 890: `vx run g --all --exclude-dependencies`
        on a group runs nothing and exits 0.
