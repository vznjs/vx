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

O-2. No artifact saved on Windows restored, on any OS. Entry names came
from `path.relative`, so a nested output was `outputs/dist\a.js`, and
`assertSafeName` refuses a backslash. They go through `relPosix`. On
win32 alone: pack records 0o644 (Windows reports 0o666, world-writable
on a Linux restore), restore skips `chmod` (it sets the read-only
attribute, which refuses the next rename over the file), and
`resolveThrough` keeps the drive root.

O-5. Windows renames no directory onto another, even an empty one:
EPERM where POSIX says ENOTEMPTY, so every contender for the run lock
ran unlocked, and an empty leftover lock dir unlocked every run after
it. On win32 a name that exists is taken; an empty one is removed and
the rename tried once more.

O-9. The Windows data step printed 24,000 lines, past what an API tail
reads, and ran out its time one shard after another. Shards now run
four at a time, 100 s each, into their own logs, and only counts,
failing rows and first error lines are printed. Actions runs bash with
`-e`, which ended the first version at the first red shard; `set +e`.

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

## Windows data, compact run (2026-09-28, run 36380553265)

Past the harness fixes, by class:

- `EBUSY` removing a temp dir, in every suite that opens a cache
  (getMany, history, artifact ceiling, layered cache, failure mode,
  unreadable index, capture cap, `./` globs). The cache index stayed
  open after `Cache.close()`: O-10.
- Rows that assume `/` in a path they build or compare:
  `output-wipe-guard` (`path.relative` against `dist/a.js`),
  `sandbox-runtime.unsafe` (`reportableViolations`,
  `parseStraceViolations`: Linux line shapes built with `/`).
- `EFTYPE ... uv_spawn` spawning a script directly (the `.env` row):
  Windows runs no shebang.
- Shutdown-signal rows and the kill-guard hold rows: signals and
  process groups, O-4's ground; to read one by one.
- On Windows `bin.ts`'s `beforeExit` fired while the verb was pending
  (run 36379869161: the "can never settle" line printed before the
  run's own summary). The loop drained mid-run; `settled` and exit 1
  are set there, so a green Windows run may exit 1. To probe on a run
  that passes.

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
- A: O-10 changes `cache.ts`'s four `Database` close sites to
  `closeDb` (`close(true)`): a plain close left the index open. Any new
  close site in the cache wants the same.
