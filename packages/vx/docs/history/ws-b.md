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
