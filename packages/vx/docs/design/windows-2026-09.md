# vx on Windows (2026-09-28, stream O)

**Status: the plan. Items land as `O-<n>` in `docs/history/ws-o.md`.**

Goal: vx runs and caches on Windows under Bun, with no WSL. This
replaces the 2026-09-10 "Windows is WSL" decision (coordinator,
2026-09-28). Linux and macOS behaviour does not change: every fix is a
separator-neutral rewrite or a `win32` branch.

CI: `core-windows` in `ci.yml`, `continue-on-error` and not required
until green. Queue cost on the first run (2026-09-28): 34 s to a runner
(macOS 82 s, Linux 2 s), 25 s of `bun install`.

## Decisions

1. **Shell: Bun's shell, via `bun exec <command>`.** Windows ships no
   `sh`, and Git for Windows puts only `Git\cmd` on PATH. `cmd.exe`
   would change what a command means per OS. `bun exec` runs the same
   POSIX-ish syntax (`&&`, `|`, `$(…)`, `VAR=x cmd`, redirects) that
   `bun run` already uses for scripts on Windows. It is still one
   process per task, spawned the way `sh -c` is, so kill and resource
   accounting stay per task. A compiled vx spawns itself with
   `BUN_BE_BUN=1`. The command string is unchanged, so the key is too.
   `sh` stays the shell on Linux and macOS.
2. **Kill: `taskkill /T /F /PID <pid>`.** Windows has no process groups,
   and `process.kill(-pid)` is ESRCH there, which `killTree` reads as
   "group gone", so today nothing is killed. `/T` walks the parent-pid
   tree. A grandchild whose parent already exited is missed; a Job
   Object (FFI to kernel32) closes that gap and comes only with a
   measured leak. Liveness is `process.kill(pid, 0)`.
3. **Signals.** SIGINT (Ctrl-C) and SIGHUP (console close) arrive, and
   SIGTERM never does. A task cannot be asked to stop, so the grace
   (`VX_KILL_GRACE_MS`) does not apply: the first stop is the tree kill.
   The kill-9 guard (an `sh` script on fd 3) is not spawned on win32:
   `taskkill /T` replaces it.
4. **Sandbox: refuse.** `exec.sandbox` on win32 already fails with
   `sandbox not available: …`, and never runs unsandboxed. The message
   gives Linux install advice, which is wrong on Windows (fix: O-n).
   `@anthropic-ai/sandbox-runtime` 0.0.76 ships a Windows backend
   (`vendor/srt-win`, `windows.srtWin.path`). Wiring it is stream B's
   (lead in `ws-o.md`). Until it lands, a repo whose tasks all declare
   `exec.sandbox` (this one) cannot run through vx on Windows, so the CI
   job also runs the shards as bare `bun test` to get data.
5. **Cache keys: Windows is its own key space.** Today no key part names
   the platform. Windows cannot see an exec bit (`core.fileMode=false`,
   `st.mode` is 0o666), and it writes CRLF under `autocrlf`. Its
   artifacts would be replayed on Linux without `+x`, and the other way
   round. On win32 alone, the key folds `win32`. Linux and macOS keys do
   not move, so `CACHE_VERSION` does not bump.
6. **Archive: POSIX entry names, and no mode on win32.** Entry names are
   built with `path.relative` (`cache.ts` `outputsOf`), so they hold `\`
   on Windows, and `assertSafeName` refuses them: no Windows artifact
   restores. They go through `toPosix`. On win32, restore does not
   `chmod`. `chmod` there only sets the read-only attribute, and a
   read-only restore blocks the next rename over it.
7. **Run lock.** Windows cannot rename a directory onto an existing one:
   EPERM, not ENOTEMPTY. The lock reads that as a failure and runs
   unlocked. On win32, EPERM/EACCES on the rename means "taken".
8. **Paths.** Most code is separator-aware (`toPosix`, `path.sep`).
   The known exceptions:
   - `resolveThrough` (archive.ts) loses the drive letter;
   - output-glob scans compare `\` paths against `/`;
   - the workspace display name splits on `/`;
   - config imports pass a raw `C:\…?q=` path to `import()`. The fix is
     `pathToFileURL`.

   Case: NTFS is case-insensitive, but vx compares the spellings it
   produced itself (cwd, realpath, git), so no case folding goes in
   until a row shows a mismatch.

9. **Environment.** The essential passthrough gains `USERPROFILE`,
   `SystemDrive`, `WINDIR`, `HOMEDRIVE`, `HOMEPATH`,
   `NUMBER_OF_PROCESSORS` and `PROCESSOR_ARCHITECTURE` on win32. Node
   and npm break without them. The key keeps folding only the declared
   env.
10. **File replace.** A rename over a file another process holds open
    fails EPERM/EBUSY on Windows. The artifact store, lockfile memo and
    archive restore retry a bounded number of times on those codes on
    win32.
11. **Not in the way:** `/proc` and cgroup readers are already
    `linux`-gated, git spawns need nothing, and `Bun.which` applies
    PATHEXT.

## Order

Correctness before reach, so the first thing Windows gets right is the
cache:

1. Key space (5) and archive names and modes (6): a Windows artifact
   that restores, and never on Linux.
2. The shell (1), so that any task runs.
3. Kill and signals (2, 3), so that a timeout or Ctrl-C leaves nothing
   behind.
4. The run lock (7), paths (8), env (9), replace (10), each as the CI
   job names them.
5. The job goes green (bare shards, then `vx run` once B wires srt-win),
   it becomes required, and win32-x64 joins the release binaries and the
   install docs.
