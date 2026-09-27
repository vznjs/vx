# Shipped, 2026-09 — improvement-loop items 1053–1092

The record `docs/STATUS.md` carried until 2026-09-27, moved here whole
when the loop passed forty items again (item 1093). A PREFIX,
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
`2026-09-improvement-loop-820-852.md`, items 853–892 in
`2026-09-improvement-loop-853-892.md`, items 893–932 in
`2026-09-improvement-loop-893-932.md`, items 933–972 in
`2026-09-improvement-loop-933-972.md`, items 973–1012 in
`2026-09-improvement-loop-973-1012.md`, items 1013–1052 in
`2026-09-improvement-loop-1013-1052.md`; items 1093 onward continue in
`docs/STATUS.md`.

1053. DONE (2026-09-27, the nx() review's leads 7 and 8a). `dependsOn`
      edges Nx takes were dropped: `{ target, projects: "b" }` (Nx reads a
      lone string as `["b"]`) was "not representable", and a list's
      entries were looked up as package names, so `tag:lib` and `lib-*`
      dropped their edges. `projects` is now read as Nx's
      `findMatchingProjects` reads it (`matchNxProjects`: names, `*`
      patterns, `tag:` patterns, `!` exclusions, a list opening with one
      starting from every node) over the graph's nodes and their tags; an
      exact name that is no package still draws its todo. And `params:
"ignore"`, Nx's default, drew a todo about forwarding; only
      `forward` does now.
      - Rows: `nx-helpers-sweep.test.ts` › a lone projects string is a
        one-entry list, only params forward is a todo, and
        `matchNxProjects`; `nx-map-sweep.test.ts` › a dependsOn projects
        pattern reaches the nodes whose tags or names it matches. Each red
        with its change reverted.
      - Left from the review: `nxCache`'s kept body can be cancelled by a
        concurrent probe (a refetch, not a wrong answer; unmeasured).

1054. DONE (2026-09-27, Next 27's measurement; STATUS only). A warm hit
      over 5,000 output files costs 47 ms more (min of 15, interleaved)
      with the bare literal `dist` than with `dist/**`: only the glob form
      gets `outputDirsCurrent`'s directory-mtime short-circuit. Next 27
      carries the numbers and the candidate that keeps it.

1055. DONE (2026-09-27, the telemetry review's lead 1). A telemetry sink
      hung past its flush deadline could hold `vx` open: core stops
      waiting at the deadline (3 s) but a request still in flight keeps
      the event loop alive, and `bin.ts` exits when the loop drains. A
      hanging GitHub API kept `vx run` alive until the CI job's own
      timeout (vx-github's POST had no timeout), and a hanging collector
      held it for vx-otel's `timeoutMs`, 15 s by default.
      - Seam: `TelemetrySink.flush(signal)` — core passes an
        `AbortSignal` it aborts at the deadline. vx-github passes it to the
        check-run POST, vx-otel to each export beside its own timer.
        `modules/telemetry-host.md` and the sink blog post say so.
      - Rows: `telemetry-lifecycle.test.ts` › the signal a flush receives
        aborts at the deadline; `github.test.ts` › the check-run POST ends
        when core's flush deadline aborts; `collector.test.ts` › the POST
        ends when core's flush deadline aborts, not at timeoutMs (a real
        hanging server). Each red without its change.

1056. DONE (2026-09-27, the telemetry review's leads 2–4). vx-otel's
      headers and the SDK opt-outs.
      - A header NAME fetch refuses killed every export and printed it:
        a curl-style `Authorization: Basic …=` split at its first `=` is a
        name holding the credential, and fetch's error quoted it. Names
        are held to RFC 7230's token and a bad one is dropped with a
        warning that prints neither name nor value.
      - Names merged case-sensitively: `Authorization` and
        `authorization` (the shared env and a signal's, or the env and the
        option) were both sent, fetch joined them, and the collector got
        `Bearer shared, Bearer traces-only`. Names are lower-cased, so the
        later one replaces the earlier as the spec orders.
      - Only `OTEL_LOGS_EXPORTER=none` was read. `OTEL_SDK_DISABLED=true`
        now declines, and `OTEL_TRACES_EXPORTER=none` /
        `OTEL_METRICS_EXPORTER=none` turn their signal off (the options
        still win). The README says so.
      - Rows: `otel.test.ts` › a header name no request can carry is
        dropped; header names merge case-insensitively; the SDK opt-outs
        are honoured; a sink with traces off POSTs no traces. Each red
        without its change.

1057. DONE (2026-09-27, the telemetry review's lead 6). The run's
      command line went to every telemetry sink verbatim, so a task
      argument after `--` (`vx run build -- --token=SECRET`) reached an
      OTLP span's `vx.command`, the GitHub job summary and a check-run
      posted over the API. What follows `--` is counted, not quoted, in
      the line sinks receive (`vx run build -- <1 argument>`); local
      history (`vx last`) keeps the whole line, on this machine.
      - Row: `telemetry.test.ts` › a sink never receives what follows `--`
        on the command line (a real run with a spoofed argv, every record
        and the summary). Red with the sinks' line restored.

1058. DONE (2026-09-27, the telemetry review's lead 5). vx-github's job
      summary and check-run misrendered: the footer cell-escaped the
      command though it sits in no table, so `a|b` showed as `a\|b`, and a
      backtick in the command ended the code span early; and a task id's
      `*` or `_` rendered as emphasis (`a#*x*`). The footer is one code
      span whose fence outruns any backtick run in the command, and ids
      are escaped as inline markdown (and as cells in the table).
      - Rows: `github.test.ts` › the footer counts a hit as passed (now
        pinning the unescaped `|`), and the footer holds any command in
        one code span; an id is escaped as inline markdown. Both red
        without the change.
      - Left from the review: a check-run on a `pull_request` event
        attaches to the merge commit (`GITHUB_SHA`), which GitHub may not
        list on the PR (unverified here, no GitHub access); and
        `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_EXPORTER_OTLP_TIMEOUT` and
        `_PROTOCOL` are unread (the README does not claim them).

1059. DONE (2026-09-27, the local runner review's leads 1 and 2). A
      persistent task's `readyWhen` was tested against the whole pending
      fragment, so an anchored pattern missed a line that arrived in one
      chunk with others (`booting\nready\n` failed `^ready`, and `ready$`
      never matched a newline-terminated line), and the run failed at its
      timeout or hung without one. And the pattern saw raw terminal
      escapes, so the documented Vite example (`Local:`) never matched
      under `FORCE_COLOR`, which vx passes through. Each line is now
      tested on its own, without its break (`\n`, `\r`) and with CSI,
      OSC and two-byte escapes removed from the tested text only; the
      trailing partial line is tested too. schema.md and runner.md say so.
      - Rows: `runner.test.ts` › readyWhen per line (six shapes red
        without the change, two controls that hold both ways);
        `output-memory.unsafe.test.ts` gains a no-line-break flood, since
        a `\r` now ends a line and no longer drives the 64 KiB window.
      - Left from the review: Ctrl-C reports a persistent server vx
        killed as "exited … before the run stopped it" (1061); the Aborted
        section lists never-started tasks as killed with exit 1 (1062); forwarded
        args after a command ending in a `#` comment are dropped (1060).

1060. DONE (2026-09-27, the local runner review's lead 5). The args
      after `--` were dropped in silence twice over: appended after a
      command that ends in a comment (`echo args: # print them`) they
      landed inside it, and a persistent task with a `readyWhen` got none
      at all, "so the matcher sees the unmodified output" — though args
      change the command, not what the matcher reads — so
      `vx run dev -- --port 4000` on the documented Vite task lost the
      port. One `withForwardArgs` (runner.ts) now builds the line for the
      one-shot runner, the sandbox wrapper and the persistent path: the
      args go before a comment still open at the end, and a server gets
      them like any task. cli.md and execute-task.md say so.
      - Rows: `runner.test.ts` › withForwardArgs (each joined line run
        through sh; two red with the splice off, six controls: a comment
        on an earlier line, a quoted `#`, `a#b`, `$#`, `\#`, `a\ #b`);
        `persistent.test.ts` › appends forwardArgs to a persistent command
        WITH a readyWhen (was the row pinning the drop; red with it back).

1061. DONE (2026-09-27, the local runner review's lead 3). A Ctrl-C of a
      run with a dependency-only server ended with
      `vx: app#srv exited with code SIGINT before the run stopped it`: the
      stop's own teardown signals every server before the graph ends, so
      by the end-of-run check each had ended, not cleanly, and was named
      a crash (4 in 6 runs, timing-dependent). The run now notes which
      servers had already ended when the stop landed, and on a stopped run
      only those are named. orchestrator.md says so.
      - Rows: `keep-alive.test.ts` › a Ctrl-C does not name the servers it
        stopped as crashed (the dependant holds in its INT trap so the
        server is reaped first: red 3 of 3 without the change), and the
        control, a server that died before the Ctrl-C is still named.

1062. DONE (2026-09-27, the local runner review's lead 4). After a
      Ctrl-C the Aborted section listed each task the stop reached before
      it ran as "killed by a shutdown signal" with `exit 1` — an exit the
      scheduler writes on an undispatched task, not one any process had —
      and counted a group among them. Those are now listed apart, under
      `Not started:`, with no exit, and a group is left out as the skipped
      section leaves it. A task ran if its outcome carries a wall-clock
      start, which only execute-task sets. summary.md says so.
      - Rows: `summary.test.ts` › names what the stop reached before it
        ran apart; `signal-handling.test.ts` › a Ctrl-C names the task it
        killed apart from the one it kept from starting. Both red without
        the change; `aborted-outcome.test.ts`'s self-SIGTERM row is the
        control that a task which ran still reads as killed.

1063. DONE (2026-09-27, the local runner review's minor finding). A
      timed-out task that outlived the SIGTERM grace died of the SIGKILL,
      and its frame still said `killed (SIGTERM)` over the footer's
      `exit 137`. The line names the signal the task died of:
      `killed (SIGKILL after the SIGTERM grace)`. execution.md's table says 137. The review's other minor finding stays open: a dependency-only
      server that crashed mid-run keeps its frame reading `running` and a
      green footer tally over a red exit (the `vx:` line explains it).
      - Row: `task-timeout.test.ts` › a timed-out task that IGNORES SIGTERM
        now pins the line (red without the change);
        `signal-death.test.ts` holds the SIGTERM line.

1064. DONE (2026-09-27, the trim the loop passed forty at). Items
      1013–1052, with the parallel sessions' own 1017 and 1018, moved to
      `docs/history/2026-09-improvement-loop-1013-1052.md` in this commit,
      a prefix as the rule says. What that stretch was: review agents'
      reproduced leads, area by area — the lockfile plugin (1013, 1014),
      `vx watch` (1015–1018), the graph's filters (1019, 1024–1026, 1030),
      the plugin seams (1020–1023, 1027–1029), vx-migrate's `turbo()` and
      `nx()` (1031, 1032, 1043, 1045, 1050–1052), the CLI verbs (1033–1035,
      1042), the config cache (1036, 1044, 1046), vx-reapi (1037–1040) and
      the local cache's save and restore (1048, 1049). The loop here is
      the record from 1053.

1065. SUPERSEDED (2026-09-27) by F-2 (`docs/history/ws-f.md`), which
      landed first: the cache and history tools of vx mcp open the index as `vx last` does, making nothing on disk and refusing an earlier schema's index by name.

1066. SUPERSEDED (2026-09-27) by G-4 (`docs/history/ws-g.md`), which
      landed first: vx-schedule-history checks its number options.

1067. DONE (2026-09-27, the MCP and schedule-history review's leads 4
      and 5). `vx mcp` answered what JSON-RPC 2.0 and MCP call invalid.
      A request with no `jsonrpc`, or with `"1.0"`, and one whose id was
      an object or a boolean were each served, and the bad id was echoed
      back. A call to an unknown tool was an `isError` result, where
      the spec lists -32602. A string or array `arguments` was read as no
      arguments and returned the full unfiltered history. And the server
      echoed 2025-03-26, a revision that obliges it to take batches,
      which it refuses. Each is now -32600 or -32602; the error echoes a
      readable id, and one that is not an id is answered as null. The
      supported revisions are 2024-11-05 and 2025-06-18. A tool's own
      refusal stays an `isError` result. The README says so.
      - Rows: `server.test.ts` › an unknown tool or non-object arguments
        is invalid params; a request with no "2.0" version or an id that
        is no id is invalid (string and null ids are the controls); a
        2025-03-26 client is offered the newest revision. All three red
        without the change; the row that pinned the unknown tool as a
        result moved into the first.

1068. DONE (2026-09-27, the MCP and schedule-history review's lead 6,
      first half). `vx history` printed "budgets 4 cores (the default
      worker count…)" beside a workspace that says `concurrency: 1`,
      which is what a run there uses and what `vx info` reports: the verb
      asked `machineParallelism()` itself, since a plugin verb had no way
      to learn the workspace's setting. `CommandContext` now carries
      `concurrency`, the worker count a `vx run` there uses without
      `--concurrency` (the same rule as `run.ts`), and the verb budgets
      it. plugin-commands.md says so.
      - Row: `schedule-history-e2e.test.ts` › `vx history` budgets the
        worker count a run here uses (red with the machine's count: 4
        against 1).
      - Left: a config's `Bun.write(Bun.stdout, …)` still reaches
        `vx mcp`'s JSON-RPC stream (`console.*` and
        `process.stdout.write` are redirected, item 922); 1069.

1069. DONE (2026-09-27, the MCP and schedule-history review's lead 6,
      second half). A config evaluated while a `vx mcp` tool loaded the
      workspace could still write into the JSON-RPC stream through Bun's
      own stdout: `Bun.write(Bun.stdout, …)` and `Bun.stdout.writer()`
      bypass both `process.stdout.write` and the console, which item 922
      redirected, and a strict client drops the connection on a line that
      is not JSON-RPC. While it serves, both go to stderr as well, and
      both are restored after. A process a config spawns with fd 1
      inherited still writes there; the README says so.
      - Row: `server.test.ts` › keeps stdout JSON-RPC while a config or a
        plugin stage prints, extended with both (red without the change:
        the reply line could not be parsed).

1070. DONE (2026-09-27, Next 27). `nx()` wrote an extensionless output
      as `<path>/**`, which matches nothing under a FILE, so a target
      whose output is a binary (`dist/bin/tool`) never saved it and a hit
      restored nothing. The bare path fixes that, since core reads a
      literal as the file or the tree under it, but a bare path lost the
      directory-mtime short-circuit that only `<dir>/**` got. Measured in
      item 1054: `dist/**` min 181 ms against the bare `dist` 228 at 5,000
      files. `wholeSubtreePrefixes` now takes a bare literal too. One that
      names a directory is snapshotted like `<dir>/**`. One that names a
      file refuses the snapshot, so that task keeps the walk it had, and
      one that is absent is recorded absent. The mapper emits every path
      as written. A/B (15 interleaved warm runs, one task, 5,000 files in
      50 directories, before arm from a worktree at 1069, each arm on its
      own pre-warmed copy): the bare `dist` went from min 235 ms, median
      266, to min 209, median 219. The `dist/**` control on the after arm
      measured min 196, median 217. The before arm recorded no directory
      rows; the after arm recorded 51. caching.md, cache.md and the
      vx-migrate README say so.
      - Rows: `output-dirs.test.ts` › accepts a bare literal as the tree
        it may name; a bare literal directory output records its
        directories, and a stray still forces the restore (both red
        without the change); a bare literal FILE output records nothing
        and is still restored when it changes (the control).
        `nx-helpers-sweep.test.ts` › a glob and a bare path are kept as
        written (`bin/tool`); the mapper's other expectations in
        vx-migrate's suites moved from `<dir>/**` to the bare path.

1071. DONE (2026-09-27, the local runner review's other minor finding).
      A persistent server that became ready and then died on its own
      before the run stopped it failed the run (items 892 and 1061). Its
      outcome still said `success`, so the footer read `2 success · 2
total` over exit 1, both for a dependency-only server and for a
      requested one kept alive. Such a server's outcome is now `failed`
      with its own code, or 128 plus the signal, so the footer reads `1
failed · 1 success`. A server a Ctrl-C stopped stays out of it (1061).
      orchestrator.md says so.
      - Rows: `keep-alive.test.ts` › the three server-crash rows now pin
        the footer tally. The dependency-only and requested cases are red
        without the change; the green control reads `2 success · 2 total`
        both ways.

1072. SUPERSEDED (2026-09-27) by G-1 (`docs/history/ws-g.md`), which
      landed first: pnpm() reads pnpm 11's two-document lockfile.

1073. DONE (2026-09-27, the lockfile review's lead 2, a stale hit).
      Every pnpm importer node folded the same material, `'importer'`,
      and `reachDigests` tells a cycle's members apart by their own
      material and what their edges reach. Two workspace projects that
      link each other (`link:../b` / `link:../a`), each on its own
      `is-number`, gave the same lines when a lockfile swapped which one
      reached 7.0.0. A real `pnpm install --frozen-lockfile` moved
      `packages/a/node_modules/is-number` from 7.0.0 to 6.0.0, and both
      builds replayed as up to date while `--affected` named nothing. Each
      importer now folds its own dir, and bun's workspace nodes do too
      (the review could not collide those, since their package nodes
      carry the path). npm's nodes fold their path and yarn's their
      resolution already. `DIGEST_VERSION` 6 → 7, since every pnpm and bun
      digest moves once.
      - Row: `pnpm.test.ts` › two importers that link each other and swap
        versions both move (red without the change; the same lockfile
        twice is the control).

1074. DONE (2026-09-27, the lockfile review's lead 3, a stale hit).
      Yarn berry compat-patches `resolve`, `typescript` and `fsevents`.
      It writes a plain entry and a
      `resolve@patch:resolve@npm%3A…#optional!builtin<compat/resolve>`
      entry, and installs the patched one (its `normalize-options.js`
      differs from the pristine tarball). The workspace still asks for the
      plain `npm:` descriptor, which keys the plain entry, so the patched
      entry was reached by no workspace. A Yarn upgrade that revised the
      builtin patch under the same version then re-keyed nothing, and
      `--affected` named nothing. `yarn()` now maps each builtin patch key
      back to the plain descriptor it patches, and that descriptor reaches
      both entries, which can over-invalidate but never under-invalidate.
      `DIGEST_VERSION` 7 → 8. The README says so.
      - Row: `yarn.test.ts` › a builtin compat patch moves the workspace
        that asks for the plain descriptor when the patch changes. It is
        red without the change; a workspace without `resolve` stays put,
        and the same lockfile twice moves nothing.

1075. DONE (2026-09-27, Next 26, a stale hit). `nx()` decided its graph
      snapshot was fresh from the mtimes of `nx.json`'s chain and the
      manifests. Nx derives dependency edges from source imports, so
      `import { b } from '@w/b'` added in `a` kept the old snapshot, and a
      later edit to `b` replayed `a#test`. The snapshot is now keyed, in a
      file beside it, on `HEAD`, `git status -z -uall`, the content of each
      listed path under a project root or among the root files Nx reads,
      and `nx.json`'s chain by content (a base can live in
      `node_modules`). Key and file both change.
      - A second edit to an already-dirty file moves the key; the status
        text alone missed it (a measurement agent showed it with Nx
        22.7.12's own export).
      - A touch alone, or a report a task writes at the root, does not
        re-export.
      - The key is computed before the export, so an edit made while Nx
        runs costs one more export rather than being lost.
      - Outside a git worktree the mtimes still decide.
      - Measured on a synthetic 1,000-project `@nx/js` workspace (7,005
        files, 11 interleaved runs, load around 11 from a gate beside it):
        the old stats took min 8.6 ms, median 10.3; the key takes min 43,
        median 52. A first draft that also read every manifest took 166,
        and it was cut because git already lists an edited manifest and
        `HEAD` moves with a committed one.
      - The export itself measured 1.26 s with the daemon off and 0.51 s
        with it on, rising to 1.5 s and 0.9 s after an edit. The README
        figures are corrected.
      - Reusing core's own `git status` (`startGitEnumeration`) would take
        the 35 ms back, but the `project` stage cannot see it yet, so that
        is a follow-up.
      - Rows: `nx.test.ts` › a source file under a project root, added or
        edited again, re-exports; a touch alone, or a stray file at the
        root, does not re-export. Both are red without the change. The
        five rows that provoked a re-export with a touch now edit instead.

1076. DONE (2026-09-27, a cache-key review agent's lead 2, a stale hit).
      With `core.fileMode=false`, which WSL's DrvFs writes, `git status`
      reports no `chmod`. A `chmod +x` on a clean tracked input therefore
      kept the input trusted at its index mode (`100644:`), and the task
      replayed the output a plain input had built. Item 887's mode fix
      works only where git sees the mode change. When `git var -l`, which
      the enumeration already spawns, says `core.filemode` is false, each
      trusted identity takes its mode from an lstat, the way `hashFile`
      spells it, and keeps the index OID. The cost is one lstat per
      trusted file, only under that setting. caching.md says so.
      - Row: `stale-hit.test.ts` › under core.fileMode=false an executable
        bit still re-keys the task. It is red without the change; the
        chmod back to 644 is the control, and it hits the first entry.

1077. SUPERSEDED (2026-09-27) by A-1 (`docs/history/ws-a.md`), which
      landed first: the files of a nested repository inside a project are listed as that project's inputs.

1078. DONE (2026-09-27, Next 23 (b), closed on its evidence).
      `signal-handling.test.ts` › "at the moment vx exits on a signal every
      task process is gone" went red in the gate for item 1075. The
      evidence item 864 made it print was `child: 1937 (procfs is another
pid namespace's), gone within 21 ms`. That is `slow`'s backgrounded
      `sleep 30`, which starts with SIGINT ignored and dies only to the
      group SIGKILL: it was dead at vx's exit and waiting for its reaper,
      and the sandbox's `/proc`, belonging to another pid namespace, cannot
      tell a zombie from a live process. This is the leading suspect Next
      23 named, now shown. The row fails only on a process still alive
      3 s after the exit, which is a leak; a zombie reaped inside the
      window is not one. Next 23 (a), the macOS SIGINT row, stays open.
      - The row's leak check is unchanged: a task process vx leaves
        running is still alive at 3 s and still reddens it.

1079. DONE (2026-09-27, --affected review). A workspace member whose
      directory is a symlink (`packages/c -> ../ext/c`) was never selected
      by `--affected`: git reports the change at `ext/c/...`, and
      `projectsContaining` indexed only the link's spelling. It now also
      indexes each member's real place when that lies under the root.
      cli.md says so, and says a link out of the root stays unseen.
      - Row: `affected.test.ts` › "selects a member linked in from
        elsewhere in the tree", red without the change; the file's other
        rows still hold.

1080. DONE (2026-09-27, prune review #2). A reading verb's cache open
      (`vx info`, `why`, `last`, `cache prune --dry-run`) wrote the new
      `cache_version` over the old, so the run after an upgrade missed
      every task and never printed "cache format changed". The inspect
      open now records nothing. caching.md says so.
      - Rows: `schema-reset-notice.test.ts` › "`vx info` …" and
        "`vx cache prune … --dry-run` leaves the format notice to the next
        run", both red without the change.

1081. DONE (2026-09-27, prune review #1). `--max-size` still counted an
      index row whose artifact was gone if the row had been used within
      the hour, and evicted a real entry to make room for it: three ~200 KB
      entries, one artifact removed by hand, and `prune --max-size 450K`
      deleted a real one though the disk held 408 KB. `phantomRows` now
      reads the rows BEFORE listing the directory. A save renames its
      artifact in before its row commits, so a row read without its file
      is gone, whatever its age. Every such row is left out of the total;
      only those past the grace window are dropped. `evictIfDue` and
      `vx info` still sum the index: an over-count there only triggers a
      prune that now evicts nothing. cli.md says so.
      - Row: `cache.test.ts` › "prune() drops a row whose artifact is
        gone …" now gives the in-grace row 1 MB; red without the change.

1082. DONE (2026-09-27, prune review #3). `file_hashes.seen_at` was
      written and never read: a row stayed for every path ever hashed,
      including deleted generated inputs and other worktrees' and CI
      checkouts' paths, and `cache.db` grew for good. Neither `--max-size`
      nor `vx info` counts it. A writing close now drops rows unwritten
      for 30 days, on the same window as run history. The scan costs
      0.4 ms at 10,000 rows and 8.3 ms at 100,000 (in-memory, min of
      7), so it runs at most once a day on its own `schema_meta` clock:
      one indexed read per close otherwise. A hit does not refresh
      `seen_at`, so a file unchanged for a month is read once more; a
      dropped row is only a memo miss. caching.md says so.
      - Row: `cache-hash-files.test.ts` › "a close drops rows unseen for
        30 days, at most once a day". It is red without the change, and
        red with the daily clock removed.

1083. DONE (2026-09-27, prune review #4). `vx cache prune --dry-run` on an
      index from an earlier schema exited 1 ("this verb leaves it
      untouched"), while the same prune without the flag reset the index
      and reaped every aged artifact. So the dry run could not preview the
      biggest prune there is, the one after an upgrade. `Cache.orphansBeforeReset`
      reads the recorded version alone. On an earlier one, the dry run
      warns that the real prune resets the index and names what the
      reset leaves; it still touches nothing. Output is one
      `printPruned` for both paths. cli.md says so.
      - Row: `schema-reset-notice.test.ts` › "`vx cache prune --dry-run`
        on an earlier schema names what the real prune reaps" pins the
        dry run's stdout and stderr, the index unchanged, and the real
        prune reaping the same count and bytes. It is red without the
        change. The item-896 refusal rows keep `last`, `why` and `info`.

1084. SUPERSEDED (2026-09-27) by D-3 (`docs/history/ws-d.md`), which
      landed first: a dependent whose edge a manifest edit dropped is
      selected. This item keeps two rows D-3 lacks: a deleted dependency
      named by an npm alias, and one named by a `file:` path.

1085. DONE (2026-09-27, --affected review #2). Deleting `lib` while
      `app`'s config said `dependsOn: ['lib#build']` gave `vx run build
--affected` "nothing affected", exit 0. The full run fails with
      "depends on lib#build but no such project", so CI went green on a
      broken config. `AffectedArgs.taskEdges` hands the selection the
      cross-project `dependsOn` edges, the staged load's
      `taskEdgesFrom`, which the `--affected` walk has already built. It
      is asked only when a package's identity moved (item 1084's names),
      and every project whose tasks name one is selected. The probe now
      fails loudly on that error. cli.md says so.
      - Row: `affected.test.ts` › "a deleted package selects the projects
        whose tasks name it in dependsOn", red without the change. Its
        control is a plain edit, which never asks for the edges.

1086. SUPERSEDED (2026-09-27) by D-1 (`docs/history/ws-d.md`), which
      landed first: a new nested member's parent is selected when the
      base lacked its manifest or held it nameless. That closes the
      --affected review; its four other findings were items 1079, 1084
      and 1085.

1087. DONE (2026-09-27, restore review #2; a stale output tree under a
      green run). The directory snapshot behind a hit's skip-restore is
      taken at run end, when the directories are old enough, but the
      tree it describes was the tree at save or restore time. `post`
      (after `build`, uncached) wrote `dist/stray.txt`; the run-end walk
      recorded `dist`'s mtime with the stray in it, and every later
      `vx run build` was `up-to-date` with the stray kept. The walk now
      collects the files it passes, and `recordOutputDirs` takes a
      `holds` predicate. The run asks it with the entry's rows, read in
      one batch: a set match, rows-present for an additive task, and a
      dependant's additions allowed for an upstream, the hit path's own
      rule. A tree it refuses records nothing, and the next hit walks and
      restores. Cost on the 1,000-project bench after a full `rm -rf` of
      every `dist` (5 interleaved, min): the `output dir snapshots` stage
      went 17.2 → 27.4 ms. Reading the rows per snapshot cost 110 ms,
      because each read flushed the pending snapshots in its own
      transaction. Warm no-op runs take no snapshot. caching.md says so.
      - Row: `output-dirs.test.ts` › "a stray written into the outputs
        before run end is not recorded as the entry", red without the
        change. The run-end restore row still records.

1088. DONE (2026-09-27, restore review #1; a declared output lost under a
      green run). `detectOutputCollisions` compared `files` within one
      project and `workspaceFiles` only with other `workspaceFiles`. So
      `a#build` writing `packages/b/dist/a.txt` beside `b#build`'s
      `dist/**`, with no edge, was neither refused nor an addition.
      `b`'s clean deleted `a.txt` and `a#build` replayed `up-to-date`;
      one round even failed `a`'s restore with the concurrent-run message.
      Given the workspace root (`BuildGraphOptions.workspaceRoot`, from
      `prepareRun`, the `graph` stage's `checkGraph` and the playground),
      each `files` declarer joins the root-anchored index with its globs
      rebased to the root, and only the mixed pairs are compared. With an
      edge the pair is the item-588 addition, the upstream told the
      dependant's globs in its own namespace; a workspace glob that does
      not start in the `files` task's project cannot be, and is refused.
      Without `workspaceRoot` (a unit graph) the pass is off. No cost
      without a workspace output declarer. schema.md says so.
      - Rows: `output-collision.test.ts` › "a workspaceFiles output inside
        another project's files output": refused without an edge, and an
        addition in each direction with the globs in the upstream's
        namespace. All three are red without the change; the control (a
        root-anchored output beside the tree) passes both ways. The
        reviewer's fixture now refuses at plan.

1089. DONE (2026-09-27, env review #2). Bun loads `.env`, `.env.local`
      and `.env.<NODE_ENV>` from the working directory into its process,
      and vx reads its environment there: every `passThrough` and
      essential variable, `cache.inputs.env`, and every `VX_*` switch. A
      task saw `FOO=[fromdotenv]` that no shell had set, decided by the
      directory vx was started from, and env.md, comparison.md and
      schema.md said the opposite. `bin.ts`'s shebang is now `#!/usr/bin/env
-S bun --no-env-file`, which covers `vx`, `bunx` and
      `node_modules/.bin/vx` (probed each way: with plain `bun` all three
      loaded it). The four release compiles, `check-binary.ts`'s and CI's
      darwin launch check carry `--no-compile-autoload-dotenv`. Running
      the source as `bun src/bin.ts` still loads one; bin.md says so.
      - Rows: `dotenv-isolation.test.ts` runs the file itself with a
        `.env` in the workspace: unset without a shell value, and passed
        through with one. It is red with the old shebang.
        `check-binary.ts` (every gate) now also runs the compiled binary
        over a workspace `.env`; without the flag it fails with
        `VX_DOTENV_PROBE=from-dotenv`.

1090. DONE (2026-09-27, env review #3). `exec.env.passThrough:
['VITE_*']` loaded clean and passed nothing through: the name is
      read literally, and no environment holds `VITE_*`. Turbo's
      `passThroughEnv` expands it, so a migrating user met a silent
      no-op. `cache.inputs.env` already refused the same text. Now
      `passThrough` refuses any `Bun.Glob` wildcard (`* ? [ ] { }`) with
      the same message. The class is closed: `turbo()` already refused a
      wildcard `passThroughEnv`, and `nx()`'s env inputs are exact names.
      schema.md says so.
      - Row: `config-schema-refusals.test.ts` › "an env name that no
        environment can hold is refused in every list" gains the four
        wildcard shapes, red without the change. `A_B` stays the control.

1091. DONE (2026-09-27, env review #4). `key-fold.ts` says `cache.db`
      never holds a plaintext secret at rest, and `entry_inputs` keeps a
      digest of the `--` args for that reason. But `runs.forward_args`
      stored them as written: `vx run a#fa -- --token=FWDSEKRET42` left
      the token in `cache.db`. Nothing reads the column but for whether
      the args changed, so it now holds `xxh3hex` of the JSON, the same
      digest rule. No `SCHEMA_VERSION` bump: the column's type and name
      stand, and an older row's plaintext ages out with the 30-day
      history. architecture.md and caching.md say so.
      - Row: `run-history-columns.test.ts` reads the digest back, and
        neither `cache.db` nor its WAL contains `--mode`. That is red
        without the change; the file exists, checked first.

1092. DONE (2026-09-27, env review #1; one key, two environments).
      vx-reapi's `commandEnvironment` shipped every set `cache.inputs.env`
      value to the worker. Locally, `buildIsolatedEnv` gives the child
      only `passThrough`, essentials and `define`, so a name the config
      only tracks (legal, schema.md) reached the remote child and not the
      local one. `exec.remote` is stripped from the key, so both
      placements shared one key, and whichever ran first filled the cache
      the other replayed. An `inputs.env` name now crosses only when the
      request's resolved child environment holds the same value, so the
      worker sees what a local run would, as the README already claimed.
      The README's advice for a value a worker needs is now
      `cache.inputs.env` plus `passThrough`.
      - Row: vx-reapi `executor.test.ts` › "leaves out a cache.inputs.env
        name the local child does not get", with the name absent and with
        another value, red without the change. The other rows now hand the
        child's environment in, and the live env-order row passes `MID`
        through so it still crosses.
