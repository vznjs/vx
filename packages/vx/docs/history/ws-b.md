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
