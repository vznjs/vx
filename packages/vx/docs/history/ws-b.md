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

(none yet)

## Entries

B-1. A glob grant's hit on a wall is not a grant of it (lead 1). On
Linux `expandGrants` binds each hit of a glob, and a hit that was a
nested project, `.git` or `.vx` passed `punchWalls` as a grant
naming the wall on purpose: a root project's `read: ['*']` bound
`.git` and `.vx`, `packages/*` and `**/*.ts` bound nested projects
whose files the root's key excludes (item 1010's stale hit, by glob). - Fix (`sandbox-runtime.ts` `resolveSandboxConfig`/`expandGrants`,
`sandbox-request.ts`): the walls are computed once, canonical, and
a glob hit that is one or lies inside one is dropped before the
bind. A literal grant naming a wall still stays.
`modules/sandbox-runtime.md` § The walls a project stops at. - Row: `sandbox-request.test.ts` › a glob hit on a wall, or inside
one, is not a grant of it (`*`, `packages/*`, `**/*.ts`, a write
`.*`). Red without the fix.
