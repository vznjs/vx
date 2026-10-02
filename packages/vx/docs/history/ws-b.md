# Workstream B — sandbox and exec (plan-2026-09-27)

## Leads (review of `src/exec/`, `src/orchestrator/sandbox-request.ts`, 2026-09-27)

In order of harm:

1. Stale hit: on Linux a glob grant's hit that IS a wall (a nested
   project, `.git`, `.vx`) or lies inside one was kept as if the user
   named it — `read: ['*']` in a root project bound `.git` and `.vx`,
   `packages/*` or `**/*.ts` bound nested projects its key excludes, and
   `write: ['.*']` was refused for a wall it never named. (B-1)
2. Wrong exit code: `ignore` patterns are anchored at the project
   directory as given, never canonicalized, while a Linux violation's
   target is canonical (and a macOS one is the real path seatbelt logs).
   Under a workspace reached through a symlink (macOS `/var` →
   `/private/var`), `ignore: { read: ['x'] }` matches nothing, and the
   violation it should silence fails the task. A `~` pattern is kept
   unexpanded and matches no absolute target.
3. Stale doc: `filterIgnored`'s docblock describes SRT's per-command
   substring semantics (`'*'` keys, commands), not the per-operation
   glob match the code does.
4. The tracer retry (`runSandboxed`) does not ask whether the run is
   stopping; an attempt that ended on a signal is never retried only
   because strace prints no `strace:` line then (probed: SIGINT, SIGTERM,
   SIGHUP, SIGKILL of the group, stderr empty). Low harm; a guard on
   `signalCode` would make it structural.
5. macOS: item 1010's walls are Linux-only (`punchWalls` returns the
   grant as is), so a root project's `read: ['.']` still reads nested
   projects, `.git` and `.vx` under seatbelt. Needs a darwin probe
   (seatbelt precedence of a deny inside an allow) before a fix.

## Leads for other streams

- **A:** a local save decodes and re-parses the artifact it just packed
  (`save: scan`, about 0.1 ms per save, B-37). The checks there guard
  the ingest boundary, and vx's own bytes could skip them. A save also
  runs about 6 SQLite statements plus a `renameSync` (0.33 ms).
- **watch:** `watch-loop.test.ts` › a server that rewrites a file in its
  project is named after three restarts (item 948) timed out on #1772's
  CI (15 s, no notice) and passes 4 of 4 locally.
- **E:** a remote-only task no remote executor takes still reads `miss`
  after the run: `run-report.ts` `cacheWord`, the logger's and
  `summary.ts`'s miss counts, `run-artifacts.ts` and the event view all
  derive it from `status: 'success'` and a `cache` block. The plan now
  says `@noop` (C-48, B-34); the outcome carries no flag to tell them.

- H: `isLocalExecutor`'s false arm (core's executor bounded like a plugin
  after an abort) has no row: `boundAfterAbort`'s grace and the local
  SIGKILL share `killGraceMs`, so a row would race the two (2026-09-28).

- Windows CI (not required), 2026-09-28, on #1514: every row of
  `local-shortcircuit.test.ts` hit `EBUSY` in its fixture `rm`, and
  `output-wipe-guard.test.ts` expects `dist/a.js` where Windows gives
  `dist\\a.js`; the job then timed out at 8 minutes.

- Cache: `execute-task.test.ts` › "trusts recorded directories without
  re-recording them…" failed once in a full local gate (restore false
  after a `utimes` on the dir), 2026-09-28; 3/3 alone.
  Also `output-dirs-snapshot.test.ts` › "a cold build records its output
  directories by run end…" once in a full gate, 2026-09-28; 2/2 alone.
- O: on the Windows job (#1552, 2026-09-28) about twenty pure rows of
  `sandbox-runtime.unsafe.test.ts` fail: `resolveSandboxConfig`'s
  subtree collapse, `parseStraceViolations`' anchors, the
  `reportableViolations` rows, localBinding's socket-path halves and
  the `/dev/tty` row. They build POSIX paths for a Linux/macOS-only
  feature; skip them on win32 or make the paths native.

- E/C: a task failing on a vx sandbox refusal (`exec.sandbox.allow.write: …`)
  gets "(no output)" in the failure footer; the reason prints only above.

- F: `vx-reapi/tests/wedged.test.ts` › "a call a proxy cuts in transit"
  (F-1's rows) failed twice in a full local gate, 2026-09-27, on
  ws-b/ignore-canonical rebased on d258208: RST_STREAM(CANCEL) read
  `sent: 0` where 1 was expected, and the INTERNAL_ERROR twin failed
  after 2.2 s. The file alone passed 13 of 13 twice. The proxy's count
  looks read before the attempt reached it under load.

- `watch-loop-members.test.ts` › a root package.json's workspaces that add
  a glob watch the packages they name: timed out ("d joins the set")
  under the full gate's load on 2026-09-28, 2 of 2 green alone. Its
  `until` deadline is a claim about time under load.

- core: `scale-graph.test.ts` › core pipeline at ~2000 projects
  / ~6000 tasks timed out its 5 s hook once in a full local gate,
  2026-10-02, on the B-54 merge; its shard alone passed.

## Entries

B-1. A glob grant's hit on a wall is not a grant of it (lead 1). On
Linux `expandGrants` binds each hit of a glob, and a hit that was a
nested project, `.git` or `.vx` passed `punchWalls` as a grant
naming the wall on purpose: a root project's `read: ['*']` bound
`.git` and `.vx`, `packages/*` and `**/*.ts` bound nested projects
whose files the root's key excludes (item 1010's stale hit, by glob).

- Fix (`sandbox-runtime.ts` `resolveSandboxConfig`/`expandGrants`,
  `sandbox-request.ts`): the walls are computed once, canonical, and
  a glob hit that is one or lies inside one is dropped before the
  bind. A literal grant naming a wall still stays.
  `modules/sandbox-runtime.md` § The walls a project stops at.
- Row: `sandbox-request.test.ts` › a glob hit on a wall, or inside
  one, is not a grant of it (`*`, `packages/*`, `**/*.ts`, a write
  `.*`). Red without the fix.

B-2. An `ignore` pattern matches where the project lands (lead 2, lead 3).
Both violation producers record a canonical path, and `sandbox.ignore`
patterns were anchored at the project directory as given: under a project
reached through a link (macOS's `/var`, or `run({ cwd })` through a
symlink) no pattern matched, and the denial it names failed the task
with exit 1.

- Fix (`sandbox-runtime.ts` `resolveSandboxConfig`): a pattern's literal
  head (up to its first `Bun.Glob` wildcard) is canonicalized.
  `filterIgnored`'s docblock described SRT's per-command substring match;
  it now says what the code does. `modules/sandbox-runtime.md` step 4.
- Row: `sandbox-runtime.unsafe.test.ts` › matches an `ignore` pattern
  where the project lands through a link (a literal, a glob, an absolute
  path through the link; an unignored file as the control). Red without
  the fix.
- Not pursued: a `~` pattern stays unexpanded; a denial under `~` is
  never reported (outside the project), so nothing reaches it.

B-4. A root project is walled off under seatbelt too (lead 5). Item
1010's walls were a punch of the read bind, a mount layout and so Linux
only: under seatbelt a root task's `read: ['.']` still read its nested
projects, `.git` and `.vx`, and an edit in a nested project replayed the
root's old output.

- Fix (`sandbox-request.ts`): on macOS each wall is also a read deny.
  SRT emits a deny strictly inside a literal read grant after the grant,
  where it wins (`lateReadDenyFilters`, 0.0.76); a grant naming the wall
  is not strictly outside it and stays. `modules/sandbox-runtime.md` §
  The walls a project stops at.
- Row: `sandbox-runtime.unsafe.test.ts` › a root project's read grant
  stops at the walls, through `sandboxRequestFor` and `runSandboxed` on
  both platforms. Pushed first on its own: red on the macOS job of #1141
  (the Linux job green, the punch already holding there).

B-3. A Linux sandboxed task reports no usage that is not its own (found
probing lead 6, a sandboxed peak read with no floor). bwrap runs the task
in a pid namespace (`--unshare-pid`), and what its processes use never
reaches vx's wait: a 500 ms busy loop read 2 ms of CPU under the flag and
510 without it, and the peak was vx's own high-water mark inherited at
exec (a sandboxed `true` from a 300 MB vx read 353 MB). Both went to
history, the run artifact, the cache entry and telemetry as the task's.

- Fix (`sandbox-runtime.ts` `runSandboxedOnce`): no `cpuMs` and no
  `peakRssBytes` on Linux; macOS's `sandbox-exec` execs the command, so
  its usage is the task's and stays. `cli.md` (the run artifact's
  fields) and `modules/sandbox-runtime.md` say so.
- Rows: `sandbox-usage.unsafe.test.ts` (a busy `bun -e` burns ≥ 300 ms
  unsandboxed, and sandboxed reports neither number; red without the
  fix, `17.43` and `60002304`), and the trace-log row in
  `sandbox-runtime.unsafe.test.ts`, which had pinned the wrong numbers
  as "the resources the task used".

B-5. A Linux write no grant binds is reported (found reviewing lead 4's
neighbours). `schema.md` says a write the sandbox refuses fails the task;
on Linux one the command swallowed passed with nothing reported. strace
never sees a write: SRT's seccomp step hands every write-intent syscall
to its observer (USER_NOTIF outranks strace's TRACE), and vx read the
observer's records on macOS only, since SRT judges them against the
run-wide config, which grants no write. `read: ['.']` plus a swallowed
`echo x > src/gen.txt` (`EROFS`) exited 0, as did a write into the
anchor's scratch (items 444, 1011).

- Fix (`sandbox-violations.ts` `refusedWrites`, `sandbox-runtime.ts`):
  on Linux the store's records for the command SRT wrapped (the group
  wrapper included, which is what it keys by) are judged against the
  task's own binds (`bindableWrites`); a write none covers is a
  violation, silenced only by `ignore.write`. `schema.md` (a missing
  write grant fails the task, both Linux shapes), `modules/sandbox-runtime.md`.
- Rows: `sandbox-runtime.unsafe.test.ts` › an undeclared write, run for
  real (the swallowed write fails with one line naming it; granted, it
  lands and passes). Red without the fix; 15 of 15 repeats green with
  it, and the repo's own gate reports no such write.

Sweep, 2026-09-27: `sandbox-violations.ts`, 30 mutants, 29 caught. The
survivor (dropping the empty-trace early return) is equivalent:
`deniedCalls('')` is `[]`. B-5 also names SRT 0.0.76 beside 0.0.75 in
three citations, each rechecked in 0.0.76.

B-6. A glob grant under a missing directory matches nothing (found
probing grants outside the project). On Linux `expandGrants` scans from
the directory above the first wildcard, and `Bun.Glob` throws ENOENT when
it is missing: `read: ['~/.x/y/*']` on a runner that never populated
`~/.x` failed the task with the raw errno and no word of the grant, and a
write glob there never reached its "matches nothing yet" warning.

- Fix (`sandbox-runtime.ts` `scanOrNothing`): ENOENT and ENOTDIR from the
  scan are no hits; anything else still throws. `schema.md` § Globs.
- Row: `sandbox-runtime.unsafe.test.ts` › a glob under a directory that
  does not exist matches nothing, and a write one says so. Red without
  the fix.

B-7. A refused write is reported however many writes follow it (found
reviewing B-5). SRT's violation store is a 100-record ring the whole run
shares, and on Linux its write observer reports every write any task
makes: a refused write followed by 150 declared ones was evicted before
the task's exit read it, and the task passed. macOS read the same ring.

- Fix (`sandbox-runtime.ts` `collectRecords`): one subscription takes
  each record as it arrives and keeps it for a command still running;
  the task reads its own list at exit. `modules/sandbox-runtime.md`.
- Rows: `sandbox-runtime.unsafe.test.ts` › an undeclared write … is
  reported however many declared writes follow it (red without the
  fix); `sandbox-request.test.ts` › a wall sharing a grant's name prefix
  does not punch it, for the sweep survivor below.

Sweep, 2026-09-27: `sandbox-binds.ts`, 28 mutants, 25 caught. The
`punchWalls` separator survived (row above). Not reachable here: the
non-Linux return of `bindableWrites`, and `punchWalls`'s unreadable
directory fallback (root reads everything).

B-8. B-3's usage row burned 400 ms of wall time and asserted 300 ms of
CPU; two loaded gates read 246 ms. It now burns 400 ms of CPU
(`process.cpuUsage()`), which load cannot shrink. Green alone, green
three of three beside four CPU burners.

B-9. A task's group is listed before it runs (C's root cause, routed). vx
wrote the guard's `+<pgid>` line after `spawn()` returned; under load
the child ran first, and a `kill -9` of vx in between left its group
unlisted and alive (4 of 40 local runs at tenfold load; macOS CI).

- Fix (`kill-tree.ts` `spawnGuarded`, `guardLine`; `runner.ts`,
  `sandbox-runtime.ts`): the child gets a copy of the guard's pipe and
  its shell lists `$$` and closes the copy before anything else; strace
  and the host socat are `exec`'d after that line. The child holds the
  pipe until it has written, so the guard cannot reach EOF first.
  `modules/kill-tree.md`. Per spawn: 1.31 ms against 1.32 (a tie).
- Rows: `keep-alive.test.ts` › a task's group is listed before it runs,
  and `sandbox-runtime.unsafe.test.ts` › a traced sandboxed one-shot
  task's children die with vx that is descheduled after the spawn. A
  preload blocks vx three seconds after each task spawn; both red
  without the fix.

B-10. Sweep of `kill-tree.ts` after B-9: 16 mutants, 13 caught; each
survivor was behaviour. Its first row found a defect on the macOS job: a
dead guard (killed, OOM) was still handed to later spawns, and bash as
macOS's sh flushed the failed `+<pgid>` line into the task's stdout
(`+14248` before `ran`), cached replay included.

- Fix (`kill-tree.ts` `startGuard`): once the guard has exited, no spawn
  is handed its pipe. `modules/kill-tree.md`.
- Rows (`kill-tree-hold.test.ts`, `kill-tree.test.ts`), each red with its
  mutant only: a task spawned after the guard died runs and is handed no
  guard; the guard line's `trap '' PIPE` runs its task over a broken pipe;
  a hold's end leaves a group the runner still runs listed; `killTree`
  never signals a group it saw freed.

B-11. A sandboxed task's strace runs inside the sandbox, around the
command alone. Wrapped around bwrap it stopped on every `openat` of the
namespace's setup: a sandboxed `true` cost 41 ms, 17 of them strace.
Now 30 (min of 40, A/B interleaved against `origin/main`, A/A within
2 ms). Moving it surfaced three defects, each found by a red row:

- strace `-f` waited for every child, so a `sleep 10 &` the command left
  held the task for ten seconds. Fixed with `-DD`: strace forks off the
  command, and the namespace takes it along.
- `-DD`'s process waits for ANY child. A child it inherited (the fd-3
  watcher, SRT's network bridges) that exited first sent the command on
  untraced, and `execve` failed `ENOSYS` under `--seccomp-bpf`. Fixed:
  strace starts from a fresh fork of the shell.
- That fork is an async list, which starts with SIGINT and SIGQUIT
  ignored, so the task's `trap … INT` never fired. Fixed: the fork puts
  them back.

- Fix (`sandbox-runtime.ts` `ownGroupCommand`, `runSandboxedOnce`): the
  trace goes to the host's log on fd 5, which the command's shell
  closes. A tracer that dies no longer ends the task, so the retry keys
  on strace's own stderr line whatever the exit: the trace stopped
  short. `modules/sandbox-runtime.md`, `modules/kill-tree.md`.
- Main run 36354815851 (E-25): `@vzn/vx-docs#build` ended on strace's
  `PTRACE_LISTEN` error, exit 1, and the old retry printed no line, so
  it never fired. Under B-11 such a failure leaves the build's own exit,
  and the retry keys on the line. Why the old key missed it is not
  proven.
- Limit (documented): the tracer shares the task's pid namespace and uid,
  so a task can end it or reach its log; the report is the task's to
  spoil, enforcement (bwrap's mounts) is not.
- Rows: `sandbox-runtime.unsafe.test.ts` › returns promptly when a
  backgrounded grandchild holds the pipe open; accepts every capability
  the schema defines (network mode: ENOSYS); SIGINT to vx reaches a
  sandboxed one-shot task as SIGINT; traces openat only
  (argv `-DD … -o /dev/fd/5`). `sandbox-tracer-retry.unsafe.test.ts` ›
  strace's own word is run once more when the task's exit is 0, red
  without the new retry key.
  B-12. A glob grant stops at the walls on macOS. From the seatbelt parity
  review: B-1 dropped a glob's hits on a wall on Linux, but seatbelt matches
  a glob as a regex and SRT re-emits a wall's deny only under a LITERAL
  allow, so a root project's `read: ['**/*.txt']` read nested projects'
  files (excluded from its key: item 1010's stale hit, by glob) and `.git`.

- Fix (`sandbox-runtime.ts` `resolveSandboxConfig`, `darwinWallRules`):
  the walls a glob reaches are denied at the profile's tail, a literal
  grant at or inside one carved out. `modules/sandbox-runtime.md`.
- Rows: `sandbox-runtime.unsafe.test.ts` › a glob grant stops at the walls
  too (both platforms; the PR's first commit, the row alone, shows the
  macOS job red); `seatbelt-profile.test.ts` › darwinWallRules.
- Parity review, the rest (leads, in order): `deny.network` reaches no
  proxy on either platform (SRT filters by the global deny list, `[]`);
  `gitConfig` per task is dropped (SRT reads the global value); a
  `localBinding` port list opens every port on macOS; a glob WRITE grant
  can reach a wall on macOS through the same regex (covered by this fix's
  write rules, no darwin runtime row yet); `systemInfo`, `machLookup`,
  `unixSockets` and `pty` have no darwin runtime row.

B-13. Sweep of `sandbox-runtime.ts` after B-11: 52 mutants, 33 caught.
It found one defect: a `~` ignore pattern was kept as written, and since
every producer records an absolute path, `ignore: { read: ['~/.cache/*'] }`
silenced nothing.

- Fix (`resolveSandboxConfig`): a `~` pattern anchors at the home
  directory, as a grant does. `modules/sandbox-runtime.md`.
- Rows, each red under its mutant:
  - `sandbox-runtime.unsafe.test.ts` › matches an `ignore` pattern under
    `~`; the command's shell holds neither the trace log nor the signal
    channel (fds 5 and 3); a timeout's signal reaches the command's
    children, not only its shell (the watcher's `-$c`); leaves no
    descriptor on a traced task's log.
  - `sandbox-tracer-retry.unsafe.test.ts` › strace's word split across
    two chunks, or as the last unterminated line, is still heard; a task
    that timed out is not run again.
- Equivalent: `trap - INT QUIT`, since bash 5.2 does not ignore SIGINT
  for a backgrounded brace group (measured; the comment now says so).
  `fresh = all.length` re-delivers ring records, which Linux's
  `refusedWrites` de-duplicates. Stale tags left in the exit set only
  grow the set.
- Gaps left as leads:
  - the untraced wrapper (no strace, or a persistent server) is never
    driven for the watcher's `-$$` or fd 3 (B-14);
  - a relative `../x` trace under a cwd reached through a link
    (`canonicalBaselines`' cwd) (B-15);
  - a literal ignore entry that is itself a link (B-15);
  - the task side's port socket after a SIGKILLed namespace (B-15);
  - `releaseBridges`' deferred reset with two live servers and a bridged
    one-shot (B-14).
- Also recorded:
  - Probe refuted: stalling vx's event loop 300 ms per output chunk did
    not truncate a task's output after it exited.
  - macOS `localBinding` stays wide, documented: seatbelt has no network
    namespace, so narrowing a port list would refuse a task's own
    ephemeral server.
  - Lead: `-DD`'s attach under Yama `ptrace_scope=1` is proven only by
    the CI runner; this container has no Yama.

B-14. Two of B-13's leads pinned, each row red under its mutant. The code
already held; nothing pinned it.

- Rows (`sandbox-runtime.unsafe.test.ts`):
  - a server that stops while another runs leaves a running task's bridge
    alone: only the LAST server's release runs the deferred reset, which
    releases every bridge no server owns (`rb-deferred`);
  - untraced (strace refused), the command holds no signal channel and vx
    reaches its children: the `exec` form's `3<&-` and the watcher's
    `-$$` (`og-run-fd3`, `og-watch-pp`).

B-15. The rest of B-13's leads pinned. The code held each time; each row is
red under its mutant (`sandbox-runtime.unsafe.test.ts`):

- an `ignore` entry naming a link silences the denial it leads to: a
  literal entry is realpath'd whole, since the record names the target
  (`ign-nowild-dirname`);
- a relative denial under a linked cwd is reported at its physical path,
  the cwd the kernel walked (`base-cwd`);
- a SIGKILLed task's port bridge leaves no socket behind: the task's socat
  unlinks it only on a graceful exit, so the host's unlink shows only when
  the namespace dies by the grace's SIGKILL (`rb-unlinksock`).

B-16. A sweep of the wall code B-1 and B-12 built: 40 mutants, 21 caught.
Eleven survivors were real gaps. The code held every time. Each row below
is red under its mutant:

- `sandbox-request.test.ts`:
  - a root reached through a link is punched around its walls (the walls
    are canonical; unrealpath'd, `read: ['.']` stayed whole);
  - a write grant binding a wall itself is refused (Linux, where a file
    grant binds its directory; macOS binds the file), and a name-prefix
    sibling is not (the first push asserted the refusal on macOS too, and
    the macOS job caught it);
  - a glob hit sharing a wall's name prefix is still a grant.
- `seatbelt-profile.test.ts` (darwin code driven on any platform):
  - `wallsGlobsReach`, now exported: the walls at or under a glob's head,
    a literal reaching none, `/*` reaching all;
  - `darwinWallRules` carve-outs: a literal at the wall itself, never a
    glob, and writes by the write grants;
  - a darwin config's write-only glob reaches the walls.
- Equivalent: a `require-not` over a glob string (it names a file
  literally called `*`); `startsWith(x + sep)` already excluding
  equality; an outside-workspace bind sharing the root's name prefix
  (every wall is under the root).
- Main went red on B-15's bridge-socket row after L-10 moved each task's
  socket into its own directory: two green PRs made a semantic conflict.
  L fixed the row (34a6c14). Since L-10 two guards hold "no socket
  behind", the socket's unlink and its directory's removal, and each
  survives alone (measured here); the pair is what the row pins.
- Held on macOS CI only: `baseDenyRead`'s walls and the injected wall
  rules (the B-4 and B-12 rows).
- Leads:
  - `punchWalls` keeps a grant whole, walls included, when its readdir
    fails. That fails open, and a root sweep cannot drive it; a non-root
    row with a mode-000 directory would pin the intent.
  - `/tmp/claude` held 728 `vx-task-*` directories from SIGKILLed
    processes. An in-process hook cannot clean them, and a sweep at init
    cannot trust `kill(pid, 0)` across pid namespaces: a sandboxed vx
    shares the directory and would delete a live task's TMPDIR. A
    per-task lock would work, at a per-task cost.
  - The rest of a sandboxed task's wrap, about 10 ms, is SRT's one `rg`
    scan for mandatory denies (7 ms is `rg`'s own start). Caching it
    would let one task plant a hook file the next could write, so it
    stays.

B-17. `keep-alive.test.ts` › a kill -9 in the persistent shutdown's grace
takes the server a dead shell left: red once under the full gate (no
`term.txt` within 10 s), 3 of 3 green alone. The server is a backgrounded
`sh -c "trap … TERM; …"` and the task said READY at once, so under load
the shutdown's SIGTERM could land before the trap was set, and the
server died unmarked.

- Fix (the row): the server writes a marker once its trap is set, and
  the task says READY only after it. Proven: with the trap delayed 0.5 s,
  the old form fails and the new form passes.
- The class, grepped: `signal-handling.test.ts`'s trapped server writes
  its pid after its trap, and the test waits on it; `keep-alive`'s
  `outlivesVx` rows end by SIGKILL, which no trap changes.

B-18. A host that refuses ptrace failed every sandboxed task. Detection
asked only `strace --version`, which answers where ptrace is refused
(Yama's `ptrace_scope` 2 or 3, a container's seccomp profile). Every
task then failed twice, the retry included, on
`strace: attach: ptrace(PTRACE_SEIZE…): Operation not permitted`.
Reproduced with a fake strace that answers `--version` and refuses the
attach, as the real one does when its `-DD` tracer cannot seize.

- Fix (`wantsStraceDetection`, `traceAttaches`): detection also traces
  `true` once per run with a task's own flags. A refusal means no
  tracing, said once on stderr; bwrap still enforces. The probe costs
  about 9 ms (`strace --version` alone is 4.5).
  `modules/sandbox-runtime.md`.
- Row: `sandbox-runtime.unsafe.test.ts` › strace detection › a strace
  that may not attach is not used, and is asked once. Red without the
  fix. The tracer-retry fake passes the probe through uncounted.
- Open: whether `-DD`'s grandchild tracer may attach under Yama
  `ptrace_scope=1` (Ubuntu's default) is proven only by CI's runner.
  Where it may not, this probe now keeps tasks green, untraced.

B-19. A dependency's `bwrap` replaced the sandbox (J-33's security lead).
SRT writes a bare `bwrap` into the command vx spawns, and a bare `socat`
into its in-sandbox network bridge. That shell runs with the TASK's
environment, whose PATH leads with `node_modules/.bin`. A fake `bwrap`
there ran instead: the task printed what the fake chose and exited 0,
with no sandbox at all.

- Fix (`initSandbox`, `linuxToolPaths`): SRT is handed vx's own paths
  for `bwrap` and `socat` (`bwrapPath`, `socatPath`), resolved on vx's
  PATH as `sh` and `strace` are. A tool vx cannot find is left to SRT's
  dependency check. The `exec` prefix now matches the absolute path.
  `modules/sandbox-runtime.md`.
- Row: `sandbox-runtime.unsafe.test.ts` › a `bwrap` or `socat` first on
  the task's PATH is not the sandbox's: the command runs and its
  undeclared write is refused, and the wrapped command execs vx's
  `bwrap` and names vx's `socat`. Red with either path dropped, or both.
- J-33's other B leads, still open: network isolation is per run
  (`deny.network` unenforced, `network: true` capped at the union); the
  false "no read access to the cwd" hint for a root `read: ['.']` that
  `wallOff` punched; vx's own hints counted as violations; SRT's bridge
  `socat` on a host without IPv6.

B-20. Two of J-33's leads, both about vx's own notes beside a failure.

- The cwd note was false for a root project. It fired when no read grant
  covered the task's cwd, but on Linux `wallOff` binds a root's
  `read: ['.']` as its children around the walls, and bwrap builds the
  path to a bind, so the cwd lists. Every failing root task was told its
  cwd was unreadable while it had just listed it (reproduced: `ls && exit
3` drew the note). Fix (`readableUnder`): on Linux a grant inside the
  cwd counts too; macOS keeps the cover rule, since seatbelt grants no
  parent.
- vx's notes were counted as violations: the cwd note, an untouched
  placeholder and a withheld link all went into the `(N sandbox
violations)` count. A task that failed on its own read "1 sandbox
  violation". Fix: a note is a `SandboxViolation` with `hint: true`
  (public type, additive), shown with the lines and never counted, nor
  failing a task.
- Rows (`sandbox-runtime.unsafe.test.ts`), each red without its fix:
  - the ungranted-cwd note is not added on Linux when a grant lies
    inside the cwd, which then lists (the first row's cwd moved beside
    its grant, keeping its premise on both platforms);
  - a literal write grant that meant a directory counts no violation.

B-21. `deny.network` refused nothing (J-33's network lead). SRT's proxy
filters every request against the lists `initialize()` was given, and vx
armed it with the run's allowlist union and an empty deny list. A task's
`deny.network` reached SRT only per call, where the proxy never looks.

- Fix (`sandboxRunUnion`, `prepareSandbox`, `initSandbox`): the run's
  deny list is the union of every task's `deny.network`, refused to
  every task and checked before the allowlist, as the allowlist is
  already the union's. The per-call comments in `sandbox-binds.ts` that
  claimed otherwise are de-claimed. `schema.md`,
  `modules/sandbox-runtime.md`.
- Per task stays out of reach. SRT's filter hears only host and port,
  and the command's name rides in the proxy username, which the
  sandboxed process writes, so a task could claim another's list.
  `network: true` still reaches only the union.
- Rows, each red without the fix:
  - `sandbox-request.test.ts` › denied domains are the union of every
    task's `deny.network`;
  - `sandbox-runtime.unsafe.test.ts` › hands SRT the run's domain union
    (now with the deny list), and arming a run hands SRT every task's
    domains, denied ones included (`prepareSandbox` → `initSandbox`,
    which nothing drove before).
- Not proven here: a request actually refused. This container's
  sandboxed curl reaches no proxy at all (exit 7, allowed or not). The
  refusal rests on SRT's `filterNetworkRequest`, which checks
  `deniedDomains` first (read in 0.0.76).

B-22. No sandboxed network on a host without IPv6 (J-33's lead). SRT's
in-sandbox bridge is `socat TCP-LISTEN:3128`, and socat 1.8 opens that
as an IPv6 socket. Here (no `/proc/net/if_inet6`) it failed with
"Address family not supported by protocol" into /dev/null, and every
networked task's curl exited 7, allowed domain or not. That was the
"proxy unreachable" behind B-21's unproven refusal.

- Fix (`wrapSandboxedCommand`, `hostHasIpv6`): without IPv6 the wrapped
  command sets `SOCAT_DEFAULT_LISTEN_IP=4`, socat's switch for the
  listen family. It covers the one-shot and persistent spawns alike;
  with IPv6 nothing changes. `modules/sandbox-runtime.md`.
- Row: `sandbox-runtime.unsafe.test.ts` › a networked task reaches the
  proxy, which refuses a domain off the list (its 403). Red here without
  the fix. CI's runners have IPv6, so there it passes either way.
- B-19's row read the wrapped command's first word as `exec`; with the
  assignment in front on a host without IPv6, it now strips that first.
- With the bridge up, this container showed B-21's defect directly: a
  domain in a task's `deny.network` got the proxy's 502 (allowed, dialed)
  where an unlisted one got 403.

B-23. B-21's refusal proven on the wire. B-21 was held only by the
config SRT received; no row saw the proxy refuse. With B-22's bridge
working here, one does.

- Row: `sandbox-runtime.unsafe.test.ts` › the proxy refuses a denied
  domain the allow glob covers: `ads.a.test` gets the proxy's 403,
  `cdn.a.test` (allowed control) its 502 from the failed lookup. With
  `deniedDomains: []` in `initSandbox` the denied one gets 502 (red).

B-24. Sweep of `runner.ts`'s command helpers, 35 mutants: 16 caught,
4 equivalent on Linux (`shellQuote('')`'s early return, `exitSignal`'s
bounds and alias filter), 15 survived; each now held. One was a bug:
forwarded args went before the LAST trailing comment, so
`echo one # c\n# two` became `echo one # c --fix # two` and ran
without them. Also swept: `env.ts`, 16 mutants, all caught.

- Fix (`withForwardArgs`): walk back to the earliest comment of the
  trailing run. `cli.md`, `modules/runner.md`.
- Rows: `runner.test.ts` › withForwardArgs (a comment line after a
  commented line, red without the fix; quoted words before a comment;
  `#` after a closing quote; `#` after `;`) and › execWord (blanks,
  `~`, `!`, `\`, five builtins).

B-25. Sandbox init spawned `npm root -g` (E's lead: 260 ms of `vx
info`). SRT's `findJar` lists `getGlobalNpmPaths()` in an array literal
beside the bundled jar, so the spawn ran before any candidate was tried,
once per process. `vx info` here, 15 interleaved runs per arm: median
429 → 316 ms, min 399 → 304.

- Fix (`initSandbox`, `bundledJavaAgent`): pass SRT's own
  `javaAgentJarPath` when the jar is on disk; SRT then returns before
  its search. `modules/sandbox-runtime.md`.
- Row: `sandbox-runtime.unsafe.test.ts` › initializes without asking npm
  where the global root is (a fake `npm` on PATH; SRT's own init asks,
  the control; red without the fix).

B-26. Sweep of the rest of `runner.ts`'s pure parts (capture, decode,
RSS), 24 mutants: 10 caught (the tail `>=` hangs capture-cap: caught),
5 equivalent or unobservable (`<=` at two capture edges, a zero peak,
the abort listener's removal, `/proc` VmHWM vs rss), 8 now held. One
mutant stood on the wrong site: `runPersistent`'s ready watcher also
decodes `{ stream: true }`, and nothing held it.

- Rows: `runner.test.ts` › streamToString (a character split across
  chunks, a truncated last character to text and onChunk, the head/tail
  seam, an fd or no stream, an already-aborted signal) › reports
  nothing without a usage › readyWhen matches a character split across
  two writes.

B-27. Sweep of `sandbox-request.ts`'s pure parts (run union, write
reach, withheld hints), 21 mutants: 18 caught, 3 now held.
`reachedWithheld` had no row at all, and nothing held that a
`localBinding` port lifts the run's unix sockets on Linux alone.

- Rows: `sandbox-request.test.ts` › the unix-socket union (a bound port
  on Linux, on darwin, an empty list) and › reachedWithheld (by path,
  not by name prefix, and a denial with no path).

B-28. Sweep of `runner.ts`'s `armTimeout` and `drainOrAbort`, 12
mutants: 10 caught, 1 unobservable (`settle` leaving the SIGKILL timer
armed: it is unref'd and names a reaped group), 1 now held: `settle`
SIGKILLed at once instead of after what is left of the grace, and no row
saw a TERM handler cut short.

- Row: `runner.test.ts` › settle() lets a grandchild that traps the
  SIGTERM finish inside the grace (red with the window at 0).
- Measured, not changed: a warm `vx run lint --all` spends ~200 ms
  arming the sandbox on its one miss (SRT import ~50, the probe's
  sandboxed `true` ~35, SRT `initialize` ~115). ~100 of the last is
  SRT's `initializeLinuxNetworkBridge`: its first check finds socat not
  yet listening, then it sleeps `i * 100` ms. SRT starts the bridge on
  every Linux init. The fix is upstream (poll at a few ms); a bun patch
  reaches only this repo, and arming earlier taxes every all-hit run.

B-29. Sweep of `runPersistent`, 21 mutants: 5 caught, 1 unobservable
(the exit clearing a ready timer that could only kill a reaped group),
4 in two masking pairs, 11 now held. Its readiness window, final decoder flush,
stderr routing, empty-chunk guard, `liveChildren` entry, `readyMs`, the
no-`readyWhen` ready, the exit message and both halves of the timeout's
kill (TERM first, then KILL for what ignores it) had no row. Pairs, each
member equivalent alone: the ready guard and the post-ready match skip;
the timer clear on ready and the timer's own guard, which together kill
a ready server at `timeoutMs` (held as a pair).

- Rows: `runner.test.ts` › runPersistent — the rows its sweep asked for
  (seven).

B-30. Sweep of `runCommand` and `spawnFailureText`, 19 mutants: 13
caught, 1 unobservable (a timed-out run aborting its streams: `settle`
has reaped the group, so a drain ends at once), 1 unreachable in a row
(the out-of-fds hint), 4 now held: a missing cwd blamed on `sh`, the
`spawnFailed` flag, a timed-out run returning before its group was gone,
and a finished run left on the guard's list, so a vx `kill -9` killed
what the task had left running.

- Rows: `runner.test.ts` › runCommand — the rows its sweep asked for
  (three).

B-31. One path-containment check. "`p` is `dir` or below it" was written
out ten times in the sandbox code, three spellings of the root case
among them; `atOrUnder` (`sandbox-paths.ts`) is the one copy, and
`sandbox-request.ts`' `within`, `assertWriteStaysHome`'s `inside` and
`readableUnder`'s `under` go. `modules/sandbox-runtime.md`.

- Swept alongside, no row: `local-executor.ts` (3 mutants, 1 caught;
  the false arm is the H lead above), and `sandbox-runtime.ts`' code
  since B-16 (19 mutants, 8 caught). Equivalent here: the jar memo, the
  jar's existence (source mode always has it), tool paths on darwin
  (SRT ignores them), IPv4 forced with IPv6 absent, the one-time warning.
  Not drivable here: the probe without `-DD` (Yama) or without
  `--seccomp-bpf`, `readableUnder`'s Linux-only arm (a darwin hint).
  Unheld: an strace before 5.3 still given the seccomp form; detection
  is memoized per process and the wrap does not carry the trace, so a
  row needs `runSandboxed` in a subprocess with a fake strace.

B-32. The strace-version branch B-31's sweep left unheld: an strace
before 5.3 was trusted with `--seccomp-bpf`, which it refuses, and no row
saw which form the detection picked.

- Row: `sandbox-runtime.unsafe.test.ts` › an strace before 5.3 traces
  without --seccomp-bpf, one after with it (a fake strace reports 5.2
  or 6.1; the probe's own trace carries the form; red with the form
  fixed either way).
- Measured, nothing to cut: a sandboxed miss's request build is ~5 ms
  (`linkedDeps` 4.4 avg; the config, walls and placeholders under 1),
  28 lint tasks at `--concurrency 1`. The ~2 s `miss: build request`
  sum at 4 workers is the one arm (~200 ms) every waiting worker
  awaits. The root `node_modules` scan repeats per task but may not be
  memoized: an unsandboxed task can write there (principle 9's limit).

B-33. Where a sandboxed task's cost goes (supervisor lead: cut what
repeats per task). Fixture: 200 projects, one uncached `true` each,
sandboxed and not; `bun --cpu-prof` of vx. vx's CPU: 3,835 ms
sandboxed, 488 plain, so ~17 ms per task, besides the child processes
(bwrap, strace, rg, socat) that dominate the wall (3.4 s vs 0.35 s).

- SRT, ~9 ms: `generateFilesystemArgs` per wrap. Its mandatory-deny
  scan runs `rg` from `process.cwd()` (vx's cwd, the workspace root), so
  every task repeats one scan and its symlink walks. Not memoized: it
  decides refusals, and a dangerous file an unsandboxed task writes
  mid-run must still be denied (principle 9). The fix is upstream: a
  per-run result, or a scan rooted at the task's cwd.
- vx, ~4 ms: `Bun.spawn` of the wrapped command (1.4), `realpath`s of
  the walls, baselines and trace paths (0.7; refusal inputs, so no
  memo), the per-task temp dir's `rmSync` (0.4), the trace parse (0.4),
  the guard write (0.3), the request (0.1–0.2).
- Refuted: taking the temp dir's `rm` off the event loop. Interleaved,
  7 runs per arm: min 3,241 → 3,336 ms, median 3,467 → 3,551; the loop
  was not the bottleneck. Not shipped.

B-34. The text plan and the run agree on a remote-only noop (supervisor
lead; C-48 had labelled it `@noop` and kept it out of the prediction).
`--dry`'s line still read `cache miss — would exec` and its summary
counted the task under "would run"; the line now reads `∅ … noop —
would not run` and the summary counts `noop`. A row in
`plugin-capabilities.test.ts` plans then runs one workspace: `@noop` in
the plan, no tombstone after the run, the dependent built.

B-35. Refuted: caching SRT's mandatory-deny scan once per run (supervisor
lead). The scan is `rg --files --hidden --max-depth 3` over
`process.cwd()` (the workspace root) on every wrap. In the 200-project
fixture that is 11 ms wall and 19 ms of rg CPU per task (50 runs:
0.56–0.79 s, against 0.09 s for 50 bare spawns). It stays for two
reasons. First, its hits become write refusals, and a task can create
`out/.git/hooks` or `.vscode/` under a write grant mid-run, so a memo
would decide a refusal (principle 9). Second, SRT offers no parameter to
scope the scan to the task's write allowlist, which is the only set
whose hits matter. That scoping is the upstream fix. The profile's other
per-task costs (the realpaths of `canonicalBaselines`, `toRealPath` and
`throughLinks`) canonicalize paths a task could relink, and each decides
a grant or a refusal, so B-33's list has nothing left that vx can cut
alone.

B-36. The tracer retry spawns nothing once the run is stopping (lead 4).
`localExecutor` never passed `ExecuteRequest.signal` to `runSandboxed`,
and the retry did not ask about it. A stop kills the children the run
holds, so an attempt that ended with strace's own line would be run
again after that kill, a child nothing stops. `runSandboxed` now takes
`signal` and does not retry once it is aborted. Two rows in
`sandbox-tracer-retry.unsafe.test.ts` cover it: one through
`runSandboxed`, one through the local executor. Each is red without its
line.

B-38. `keep-alive.test.ts` › a kill -9 in a Ctrl-C's grace failed the
gate once (`late.txt` present). The row wrote `go` as soon as vx exited,
but the group guard kills only after the kernel has closed vx's pipe
and the guard has been scheduled, so a loaded gate's child could see
`go` first. Stopping the guard (`SIGSTOP`) for 300 ms across vx's kill
fails the old row 3 of 3. The row now reads the child's pid, checks it
is alive, and waits (at most 5 s) for it to die before writing `go`. A
guard that never kills still fails the row: the child outlives the wait
and writes. With the teardown's `holdGroups` emptied the row is red.

B-39. `npm-pack.unsafe.test.ts`'s rows run `npm pack --dry-run` through
`spawnSync` under bun's 5 s default timeout. On CI (#1772) the first row
died at 5,048 ms with exit `null`, and locally a cold first run failed
one row of 18. Both rows now take a 30 s timeout.

B-37. The unsandboxed per-task path, profiled (supervisor lead: vx's
per-package overhead). The fixture is `vx-bench/generate.ts` with 300
projects and 600 forced misses (`test` runs `true`), on 4 cores. vx's
own CPU is about 1.9 s against 0.35 s warm, so about 2.6 ms per miss.

The three largest costs:

1. `spawn`, 0.57 ms per task on the main thread. Bun's spawn waits
   until the child reaches `execve`, so the wait grows with CPU
   contention: 0.33 ms idle, 4.7 ms with 4 busy loops on 4 cores. It is
   native. `argv0`, an absolute path, 3,000 open descriptors and a
   400 MB heap do not change it.
2. The save's SQLite transaction and `renameSync`, 0.33 ms (`src/cache`,
   stream A's slice; lead above).
3. The save's re-scan of its own artifact, about 0.1 ms (also A's).

Everything in exec or orchestrator is 0.06 ms per task or less:
`ownRssHighWater` 0.05, `guardWrite` 0.04, `secretMask` 0.03 (144
variables, 30 µs). None of them is worth a change that must then prove
itself against run-to-run noise. The first profile had put 2,100
`file_hashes` lookups on this run. They came from the host's git config
(`core.checkStat=minimal`, so vx rightly stops trusting the index), and
under `GIT_CONFIG_GLOBAL=/dev/null` there are none.

B-40. SRT's mandatory-deny scan, scoped to each task's write grants
(supervisor lead: the deny scan's cost per task, other than the refuted
memo). Before the change, SRT walked the whole workspace root with
`rg --max-depth 3` on every wrap and kept a hit only inside a write
grant. Removing the scan outright (a probe) halved a sandboxed
1,090-package run, 24.3 s → 12.5 s. Capping rg's threads was measured
and not shipped: interleaved min 24,077 → 23,943 ms, noise.

The fix: vx starts SRT at `mandatoryDenySearchDepth: 1`, and
`scopedMandatoryDenies` walks each task's write grants to the same depth
and adds what it finds to `denyWrite`. It uses SRT's name rules and
SRT's hit-to-deny mapping. It is stricter than rg: no `.gitignore`,
`node_modules` included, symlinks counted by name. A glob character in a
deny path refuses the task, and a root with one keeps SRT's own scan.

Interleaved A/B with the before arm from a worktree:

| Fixture                             | Before, min / median | After, min / median |
| ----------------------------------- | -------------------- | ------------------- |
| 1,090 sandboxed packages (min of 3) | 25,362 / 25,818 ms   | 14,679 / 14,793 ms  |
| 200 packages (5 runs)               | 3,293 / 3,508 ms     | 2,817 / 2,975 ms    |

Rows:

- `sandbox-deny-scan.unsafe.test.ts` builds the same wrap from SRT's
  whole-root scan and from depth 1 plus the scoped denies, for grants
  `a,g`, `.` and `..`. bwrap's deny binds are equal.
- A wiring row checks the task wrap's `denyWrite`.
- `sandbox-deny-scan.test.ts` holds the stricter cases and the
  refusal.
- Mutations of depth, case folding, the `.git/config` mapping, the
  whole-root grant and the wiring are each red.

B-41. `allow.gitConfig` takes effect, for the task that grants it. SRT
reads `allowGitConfig` only from the run's `initialize` config, so the
per-task flag vx passed was inert: `schema.md` said so, and `config.ts`
promised a writable `.git/config`. The run union now carries `gitConfig`;
such a run sets it per wrap through the same serialized override as the
unix-socket lift (`perTaskRun`, formerly `socketRun`), and the scoped
deny scan (B-40) skips `.git/config` for that task.

`sandbox-git-config.unsafe.test.ts` covers the root repository and a
nested one. In each, a task that grants `gitConfig` sets a key, and a
task in the same run that does not grant it fails. Both rows were red
before: the granted task exited 4. A `sandbox-request.test.ts` row
checks the union. Dropping the scan skip, the per-wrap override or the
arming condition each turns a row red.

B-43. `sandbox-bridge-socket.unsafe.test.ts` › is removed when the task
ends failed a local gate at 5,319 ms. The row is the file's first
sandboxed run: SRT's start and the probe come before its task's
`sleep 1`, and the row ran on bun's 5 s default while its sibling has
20 s. It passes alone 3 of 3. The row now takes 20 s.

Lead for K: `examples.unsafe.test.ts` › matches a real run of
examples/basic timed out at 5,006 ms in the same gate, and passes alone
3 of 3. It spawns a whole vx run under the 5 s default.

B-42. What a sandboxed task costs after B-40 (1,090 packages, CPU
profile of one run: 8.0 s of vx CPU, 15.6 s of main-thread samples).
The largest remaining costs are SRT's own, per task:

| Where                                                               | Main-thread time |
| ------------------------------------------------------------------- | ---------------- |
| `spawn`                                                             | 2.9 s            |
| `findSymlinkInPath`'s `lstat` of every component of every deny path | 1.3 s            |
| `resolveSymlinkedDenyPath`'s `realpath`                             | 1.25 s           |
| `normalizePathForSandbox`'s `realpath`                              | 0.93 s           |
| `hasFileAncestor`'s `stat`                                          | 0.54 s           |

That is about 3.7 ms per task of filesystem work on SRT's fixed list of
about 15 root-level mandatory denies. vx hands each task 2 read denies,
3 read grants and 1 write grant, so the lists vx builds are not the
cost. vx's own `toRealPath` calls are about 0.6 ms per task, and each
decides a grant or a refusal (principle 9). The temp directory's
`rmSync` is about 0.3 ms per task, and B-33 refuted moving it off the
event loop.

The next cut is upstream: SRT walks every component of every deny path
on every wrap. vx found no lever that keeps parity.

B-44. Mutation sweep of `exec/sandbox-deny-scan.ts` (B-40), run against
its three test files: 15 mutants, 11 caught.

Two of the survivors were dead code, now removed:

- The trailing-slash strip on a grant: `atOrUnder`, `path.relative` and
  `lstat` read `a/` as `a`.
- The `depth > 0` guard on a file grant: a depth-0 root is the workspace
  root, which is a directory.

Four survivors were real gaps. Two new unit rows in
`sandbox-deny-scan.test.ts` now catch them:

- Both `.git/hooks` mutations (the hit and its mapping). Within depth 3
  a hooks file lies only at the root, where SRT's static list has it
  too, so the parity rows cannot see it.
- A file named `.vscode` must not count as a hit (`<` → `<=` in
  `inside`).
- A file grant four levels deep must add no deny (the root-depth bound).

B-45. Mutation sweep of B-41's per-task override (`wrapForTask`,
`perTaskRun`, and `prepareSandbox`'s pass-through): 6 mutants, 3 caught.

One survivor is equivalent: clearing `perTaskRun` at a reset. Every
init reassigns it, and no wrap runs between a reset and an init.

Two survivors were real gaps. Two rows in
`sandbox-git-config.unsafe.test.ts` now catch them:

- Three concurrent wraps (granted, withheld, granted) each read their
  own task's `allowGitConfig` from SRT's `getConfig()`. Without the
  `wrapTurn` chain they interleave.
- A run armed through `prepareSandbox` with a granting task hands SRT
  the grant at the wrap. The pass-through to `initSandbox` had no row.

B-46. `bun build --compile --target=<other>` on a cold Bun cache, in
the sandbox, with no warm step. Traced (strace, Bun 1.4.2): Bun fetches
`@oven/bun-<t>` from npm, extracts it into `<cwd>/.<16 hex>-<8
hex>.tmp/`, and moves the runtime into
`~/.bun/install/cache/bun-<t>-v<version>` (a copy across mounts on
EXDEV). TMPDIR is not used. Four core fixes, each with a row that fails
without it:

- A `dir/` write grant outside the project (`~/.bun/install/cache/`) was
  never created; only a glob's prefix was. bwrap bound nothing.
- Linux: a write glob that matches nothing at the start now covers
  writes that land in the sandbox's scratch (no bind holds its
  directory), and nothing written there persists. The "mounts nothing"
  warning fires only where a read grant mounts the directory read-only
  (`scratchWrites`, `pendingWriteGrants`).
- macOS: a collapsed `<glob>/**` kept only `<glob>`, which seatbelt
  matches as an exact regex, so `.*.tmp/**` covered the directory and
  nothing in it. It keeps `<glob>/**/*` beside it (SRT strips a
  trailing `/**`, so `<glob>/**` was the same regex; CI's first macOS run
  showed it).
- A failed task names the writes refused outside the project, with the
  directory to grant (`refusedWritesOutside`). The owner's Mac said only
  "Failed to extract executable". Write-only records, absolute paths, and
  SRT's own write paths skipped: CI's first run named a strace READ and
  an `anon_inode:[eventfd]` descriptor.

`ALWAYS_IGNORE` gains the extraction directory, as `*.bun-build`
before it. `build.bun.*` and `check.binary` grant the cache, the
`.tmp` glob and `registry.npmjs.org`, and fold `bun --version` (the
embedded runtime is the compiling Bun's version; no key held it). The
warm steps are gone from `vx-runner` and `npm.yml`; `ci.yml` cross-
compiles two non-host targets on a cold cache on Linux and macOS.

B-47. The per-task costs on the unsandboxed miss path, ranked from a CPU
profile of 100 one-file tasks at `--concurrency 1`, the stat memo warm
(a run that deletes `.vx` also empties it, and its inserts then read as
`hashFile` cost): `resolveOutputs` 1.5 ms per task (the glob scan 0.8,
`containedIn`'s async `realpath`s 0.5), `describeTaskInputs` 1.2 ms,
`writeArtifactAndIndex` 0.9 ms. `VX_TIMING`'s spans were no guide here:
the save overlaps the next task's spawn, and `save: pack` summed 2.3 ms
per task of which one async `lstat` is 70 µs. Cut: `containedIn`
resolves with `realpathSync` (4-6 µs a call, 65-84 µs async). Interleaved
A/B against an origin/main worktree, one workspace copy per arm, every
rep a full miss, min of 9, two rounds: `--concurrency 1` 1161-1192 ms →
1067-1141 ms; default concurrency 594-604 → 541-548 ms. A warm run is
unchanged. The symlinked-output rows fail with the containment check
admitting everything. Lead, not taken: of `describeTaskInputs`' 1.2 ms,
0.5 is `resolveKeyInput` run again and 0.44 the key folded again, both
done for the probe already; the second fold captures the miss's input
rows. Reusing the probe's resolved input is a change to what a miss
keys and records (stale-hit-critical), so it needs its own item.

B-48. A miss's output clean removes up to 128 paths synchronously
(`SYNC_CLEAN_MAX`, `cache/inputs.ts`), and the parallel async `rm` /
`rmdir` only past it: the threadpool round trip cost more than the
unlink (1 file 0.30 → 0.13 ms, 128 files 1.7 → 1.5, min of 7; 512
files async wins, 4.5 against 5.4). The awaits also let the previous
task's save run ahead of this task's spawn. 100 one-file tasks,
`--force`, interleaved A/B against an origin/main worktree, one
workspace copy per arm, min of 9, two rounds: `--concurrency 1`
1034 → 907 and 979 → 898 ms; default concurrency 527 → 542 and 515
→ 506 (noise). Rows at 128 and 129 outputs hold removal, pruning to
the top and the named refusal on both paths; each path's prune and
refusal mutants fail them.

B-49. The unsandboxed miss path re-ranked on main (100 one-file tasks,
`--force`, `--concurrency 1`, CPU profile): the output clean 1.9 ms per
task (its `pruneEmptiedDirs` 0.84, nearly all `rmdirSync` of `dist`),
the save 0.6, the task hash 0.34. Cut: before a miss the clean keeps
the directory each wildcard output glob is rooted at (`dist` for
`dist/**`); the task writes there, so the remove bought an rmdir and
the task's mkdir. Deeper emptied directories still go, so a shape
change on a miss works, and a restore prunes as before. Interleaved
A/B against an origin/main worktree, one workspace copy per arm, min
of 9, two rounds: `--concurrency 1` 504 → 481 and 487 → 442 ms;
`--concurrency 4` 254 → 239 and 244 → 228 ms. Rows: B-49 in
`inputs-resolution.test.ts` (red with the keep filter removed) and in
`output-shape.test.ts` (red with the miss path not passing the flag;
the inode number was no discriminator, ext4 reuses it).

B-50. The unsandboxed miss path after B-49, re-ranked (100 one-file
tasks, `--force`, `--concurrency 1`, release build, CPU profile of
three runs). No cut ships: each site left is under 2% of a task, below
what this box resolves (~6%, item 404), and several are smaller in
isolation than the profile says.

- `save: pack` (2.7 ms a task, wall) splits into the plan 1.8, the tar
  0.4 and zstd 0.4. The plan is one `lstat` per output, and the save
  runs beside the next task's spawn, so its wall is not its cost (item
  616); what it costs alone is unmeasured.
  `Bun.zstdCompressSync` for a 3 KiB tar saves 0.05 ms (0.089 → 0.033
  median of 200).
- `renameSync` in the save's transaction read 1.5 ms a task in the
  profile; a rename over an existing file measures 0.05 ms alone.
- `ownRssHighWater`'s `/proc/self/status` read: 0.018 ms a call alone
  (`getrusage` 0.001, but its `maxRSS` is not `VmHWM` by definition, so
  a swap is a claim to prove first).
- `secretMask`'s name scan over `process.env`: ~0.06 ms a task.
- `containedIn`'s realpath of the project root each task: a task may
  write there, so it is not memoised (principle 9).
- The built-in snapshot (7 ms a run) is E-88's.

B-51. J's lead: with no `strace` on PATH (or one whose `--version`
fails) an undeclared read was denied but unreported, with no word of
it, so a task that tolerated the miss passed and cached; only a strace
that may not attach said so (B-18). All three now say once, on stderr,
why sandboxed tasks run untraced and what that loses (`warnUntraced`).
Rows: `sandbox-runtime.unsafe.test.ts` › the strace-detection rows now
pin what vx said; the missing and failing-`--version` rows are red
without the change, the refused attach is the control. `vx info` still
says `available` there: the fact would be a new field in `vx mcp`'s
tools record, left as a lead. schema.md and sandbox-runtime.md say so.

B-52. B-51's lead: `vx info` said `available` on a Linux host whose
sandboxed tasks run untraced (no `strace` on PATH, one whose
`--version` fails, or one that may not attach), so the doctor hid what
the run warns about. The strace verdict is memoized with its reason
(`straceState`), the run still warns once, and `untracedReason()` hands
the reason to the doctor without a word on stderr: `sandbox.untraced`
in `vx info --json` and `vx mcp`'s getWorkspaceInfo, and the row reads
`available (N tasks declare exec.sandbox), untraced — <why>, so the
reads it denies go unreported`. Rows: `sandbox-runtime.unsafe.test.ts`
› untracedReason names what the warning would (the real strace is the
null control); `show-info.test.ts` › the rendered sandbox rows. A new
fact is a contract change: `schemas/info.json`, `docs/api.md` and
`vx-mcp`'s `tools.json` record it, so the title and a commit carry `!`.

B-53. A Linux sandboxed task whose cwd no mount held ran in `$HOME`.
bwrap enters the old cwd only if it exists in the new root, else
`$HOME`, silently; a project with no read grant and no `node_modules` of
its own (`sandbox: {}`) ran there, so `cat x.txt` read `~/x.txt`, and
the bare-baseline row passed on `Read-only file system` from `$HOME`.
Fix (`cwdMounted`): when no grant holds the cwd, the cwd is denied too,
an empty directory the task enters; its reads are refused and reported,
its writes are scratch the observer reports. The ungranted-cwd note
missed it as well (a grant under the cwd that does not exist mounts
nothing); with the fix the read itself is reported. Rows:
`sandbox-runtime.unsafe.test.ts` › runs in its own cwd when no grant
holds it (red without the fix: `pwd` read `/root`), and the bare
baseline's row now pins the two write violations (red without it).

B-54. strace writes a path as a C string (a quote, a backslash and a
control byte escaped, a non-ASCII byte as octal), and `deniedCalls`
read it raw: `q"t.txt` was cut at `q\`, `é.txt` was reported as
`\303\251.txt`, so the report named the wrong path and no `ignore`
pattern could match it. The quoted argument is now matched escape-aware
and decoded (`cStringPath`). Row: `sandbox-runtime.unsafe.test.ts` ›
deniedCalls › decodes the C-string escapes strace writes a path with
(red without the fix).

B-59. SRT drops every Linux write path holding a bracket, so a grant
like `write: ['out/\\[id\\]/']` bound nothing, yet the read grants were
punched around it: `out/[id]` vanished from the task's view, its write
read "Directory nonexistent", and the refusal went unreported, judged
against the grant that named it. `bindableWrites` now drops such a path
on Linux and says once which directory to grant instead; the write is
then refused (`Read-only file system`) and reported. Row:
`sandbox-runtime.unsafe.test.ts` › says so when a write path holds a
bracket, and names the directory above it (red without the fix).
