# Workstream O — Windows (plan-2026-09-27)

Design: `docs/design/windows-2026-09.md`.

## Items

O-1. A Windows CI job, and the design. `core-windows` in `ci.yml`
(windows-latest, not required, `continue-on-error`) runs `vx run test`
for core, then the same shards as bare `bun test` for data. The first
run stopped at the first task: every task here declares `exec.sandbox`,
and vx refused it (`sandbox not available`), as it should. Queue: 34 s
to a Windows runner (macOS 82 s, Linux 2 s), 25 s of `bun install`.

O-3. Windows ships no `sh`, so every task and runtime probe exited 127.
On win32 the task shell is `bun exec` (`shellArgv`, `util/which.ts`),
with no `exec` wrap, no kill guard (an `sh` script over process groups)
and no `detached` spawn (a detached child has no console). Linux and
macOS spawn exactly as before.

O-6. The Windows job's data was noise: 64 of 460 unsafe rows failed,
and every shard was dealt no files. `scripts/test-shard.ts` took its
dir from `new URL(import.meta.url).pathname`, which is `\D:\a\…` on
Windows, and 14 doc pins read files the same way. The runner also
checks out CRLF (`core.autocrlf=true`), and the pins match `\n`. The
job now sets `core.autocrlf false` before checkout (a root
`.gitattributes` would give every path an `eol`, and vx would then
trust no index OID on any OS), and the paths come from
`import.meta.dir` or `Bun.file(url)`. Row: `file-url-paths.test.ts`,
red with any one site put back.

The job also held main's CI. Inside `ci.yml`, run 36371549761 (B-16)
sat 40 minutes in the data step while Linux, macOS and plugins had
passed, and main's concurrency group cancelled every later main run
while it was queued: no verdict on main from 02:37 UTC. The cause of the
40 minutes was the same broken dealer: its `$(…)` came back empty, so
every shard was a bare `bun test` of the whole suite. The job now lives
in `windows.yml` with its own concurrency group, cancels any older run
(main's too), is bounded at 15 minutes (10 for the data step, 60 s per
shard), and stops when the dealer deals nothing. It runs only on main
and on `ws-o/` PRs: at 03:12 UTC fifteen runs sat queued, and a Windows
runner held for 30 minutes per PR was part of that.

O-7. A Windows task got no `USERPROFILE`, `SYSTEMDRIVE` or `WINDIR`:
the essential allowlist carried only the Windows paths vx had needed
so far, and `os.homedir()`, npm and git read these. Seven names join
`ESSENTIAL_ENV` (they are absent on Linux and macOS, so nothing
changes there), with the three pages that list it. Row: `env.test.ts`
› passes the Windows home and system variables, red without them.

O-4. On Windows no stop killed anything. `kill(-pid)` is ESRCH there
(no process groups), which `killTree` read as "the group is gone", so
a timeout, a Ctrl-C and a persistent task's teardown all left the tree
running. On win32 every stop is `taskkill /T /F`, and a group's
liveness is its leader's.

O-8. The Windows job still took a runner on every stream-O PR, and the
account's job cap counts Windows runners: merges fell from 43 to 21 an
hour (coordinator, 03:57 UTC). A PR runs it only when it touches
`exec/`, the win32 files (`util/which.ts`, `cache/archive.ts`,
`cache/cache.ts`, `orchestrator/run-lock.ts`), the shard dealer or the
workflow. The job is bounded at 12 minutes, the data step at 8, a shard
at 45 s. A filter from `vx run --affected` is the better rule once a
task names the Windows suite.

## Windows data, first real run (2026-09-28, #1489's head)

The data step still ran out its 10 minutes, so this is part of the
suite. Two classes so far:

- `EBUSY` removing a fixture's temp dir in `afterEach` (the
  short-circuit suite): something still holds a file in it open.
  Windows refuses to delete an open file, POSIX does not care.
  Whether vx or the test leaves it open is not yet known.
- Tests compare `path.relative(...)` against `'dist/a.js'`
  (`output-wipe-guard.test.ts`): `resolveOutputs` is right to return
  native paths, and the rows assume `/`.

## Leads for other streams

- B: `@anthropic-ai/sandbox-runtime` 0.0.76 ships a Windows backend
  (`vendor/srt-win`, set through `windows.srtWin.path`, exported as
  `VENDORED_SRT_WIN_EXE`). Wiring it gives `exec.sandbox` on Windows.
  It is also the only way this repo's own suite runs through vx there.
- B: on win32 the sandbox refusal says "install it (Linux: apt install
  bubblewrap socat ripgrep …)". That advice is wrong there.
- J: `caching.md` should say that a Windows artifact restores on Linux
  without an exec bit (Windows cannot see one), the same class as a
  native binary shared across OSes, with the same answer: a declared
  `cache.inputs.runtime` such as `node -p process.platform`.
