# A Linux task's exact peak memory (2026-11)

> **Status:** shipped (2026-11-22): one `vx-measure` per vx forks every Linux task shell; no cold cost (Cost). Code: `src/exec/measure/vx-measure.c`, `src/exec/spawn-off.ts`.

Owner's call: measure the task's own peak, not sample around the floor.
This page is the design pass: the mechanism, the options, what stays the
same, and the cost.

## The problem

Bun spawns with vfork. At `execve` Linux keeps the old memory's high-water
mark in the new process's `signal->maxrss` (`exec_mmap` →
`setmax_mm_hiwater_rss`), and under vfork the old memory is vx's. `wait4`
reports `max(maxrss, cmaxrss)`, so the shell vx spawned read at least vx's
own size: ~69 MB in a real run. `resourceUsageToCpuRss` dropped any peak
within 4 MiB of vx's `VmHWM` as inherited, so a task lighter than vx had
no peak (16 and 32 MB: none; 48 MB and up: right, over a 35 MB floor), and
conformance `report/memory` (a 64 MB `dd`) failed. A spare shell
(`warm-shell.ts`) had the same floor.

A fork is different: the child gets a fresh `signal->maxrss` (0), and its
memory's mark starts at the parent's current size. A fork of a small
process that then execs starts clean. The owner's probe proved it: a
16 MB `dd` forked by the task's shell read 18 MB while vx was at 176 MB.

## Options

1. **The shell forks the work.** Every process vx spawns itself is dirty,
   so the measured process must be a fork of something small. sh forks a
   clean child for every command, but waits for it, and the shell's own
   wait folds the child's peak into its own dirty one. The one fork that
   does not wait, `cmd &`, is not the same command: a non-interactive
   shell ignores SIGINT and SIGQUIT in it and points its stdin at
   `/dev/null` (POSIX), and a signal ignored at a shell's entry cannot be
   trapped or reset, so Ctrl-C and `trap … INT` would change for every
   task. Rejected.
2. **vx forks instead of vforks.** The fork's memory mark is vx's current
   size (`dup_mm` sets `hiwater_rss` to the copied RSS), so the exec folds
   vx's size in again, after a page-table copy of vx per task. Rejected.
3. **vx as child subreaper, an intermediate that forks and exits, vx
   reaps the adopted grandchild with libc `wait4`** (the probe's route).
   The intermediate cannot be sh (option 1), so it is a native helper
   anyway; on top of it vx must learn the grandchild's pid, be told of its
   exit off Bun's loop (a pidfd poller), and every `server &` a task
   leaves reparents to vx instead of init: zombies `kill(-pgid, 0)` counts
   as live, which vx must reap before leftover detection asks. More moving
   parts than 4 for the same reading.
4. **An exec wrapper that waits, per task.** vx spawns a helper in place
   of the shell; it forks, the child execs the shell, the helper waits and
   hands vx the child's `ru_maxrss`. Built first: exact, but each task
   paid vx's vfork, the helper's exec and its fork, ~0.5 ms of CPU (+11%
   CPU over 600 `true` tasks cold). Rejected: cold must stay 1x.
5. **One helper per vx forks every shell: `vx-measure`.** Chosen. Started
   once, at the first task; each spawn is a message to it, and the fork of
   a 5 KB static process is cheaper than Bun's vfork of vx. Same reading
   as 4, no per-task exec, and vx's own vfork is gone too.
6. **Sample `/proc` on every miss.** Already there (`watchTree`, 250 ms);
   it misses a peak between looks and a task over before the first look.
   Kept as the live sum beside the exact number, not instead of it.

## The helper

`src/exec/measure/vx-measure.c`: no libc, ~5 KB static for x86_64 and
aarch64, built with vx-observe by `scripts/build-observe.ts` and committed
(`source.sha256`, held by `tests/measure-helper.test.ts`). A compiled vx
embeds it and copies it out once per user (`src/util/embedded-binary.ts`,
the code vx-observe already used).

The spawn thread (`spawn-off.ts`) starts it with Bun's spawn, in a session
of its own, holding two descriptors: fd 3, one end of a `SOCK_SEQPACKET`
socket pair, and fd 4, the write end of a pipe. It writes a hello, then
loops on `ppoll` over the socket and a `signalfd` for `SIGCHLD`; every
signal is blocked, so no group signal, terminal or `kill` stops it.

- **Spawn.** One message: `{1, id, nfds, ignored, argc, envc}`, then the
  shell's path, the directory, argv and env, each NUL-ended, and the
  task's descriptors by `SCM_RIGHTS` (slots in the `ignored` mask get
  `/dev/null`, as Bun's `'ignore'`). The helper checks the path and the
  directory (`faccessat`), forks, and answers `spawned {id, pid}`. The
  child calls `setsid`, moves the descriptors to 0..n-1 and closes every
  other, clears its signal mask, enters the directory and execs. A refused
  check, a failed fork or a full table answers `declined`, and the thread
  spawns that task itself, so a missing directory is Bun's own ENOENT as
  before.
- **Exit.** On `SIGCHLD` the helper reaps with `wait4(-1, WNOHANG)` and
  writes `exited {id, pid, status, ru_maxrss KiB, utime, stime}`. The
  thread reads the pipe (`Bun.file(fd).stream()`) and hands vx the exit
  code, or the signal by its first name (by number where it has none, as
  Bun does), the CPU and the peak.
- **Kill.** `kill()` on a child is `{2, id, signal, pid}`: the helper
  signals only a pid it has not reaped, so never a reused one.
- **End.** vx's exit closes the socket; the helper exits.

The reading is `ru_maxrss` of the shell's wait: the largest single
process among the shell and every descendant it reaped, the meaning
`peakRssBytes` always had; the runner keeps the larger of it and the tree
sum `watchTree` saw. A builtin-only task reads the shell's own 1-2 MB
instead of nothing.

## Fallback

- **Cannot start** (no binary for the arch, no `bun:ffi`, a failed spawn):
  every spawn is Bun's, with the floor, as before.
- **A spawn it cannot take:** a relative path, a NUL in a string, a
  request over 200 KiB, more than 16 descriptors, or a send that waits
  past a second (`SO_SNDTIMEO`; `SO_SNDBUF` is raised so a burst of
  spawns waits rather than refuses): that one is Bun's.
- **Dies:** the pipe ends after its last record. Spawns asked before its
  hello are Bun's; one asked after it and not answered fails (it may have
  forked, so it is not run twice). A shell it forked can no longer be
  waited for: its group is killed and the task ends with `SIGKILL`. Every
  later spawn is Bun's.

## What stays the same

- **Exit status.** The status is the shell's own wait status, decoded as
  Bun decodes it: `tests/peak-memory-exact.test.ts` holds ten commands
  against a bare `sh -c`, fresh and on a spare, and every signal 1-64 was
  probed equal.
- **Session and group.** The shell leads its own session and group, as
  Bun's `detached` made it, so a task's `setpgid(0, 0)` (`timeout`) is
  still a no-op and its `setsid` still fails. The helper lives in another
  session, so `killTree`, `pauseTree`, the timeout and the group guard
  never reach it. `child.pid` is the shell's, known before the spawn
  resolves; `$$` in the guard line is right as before.
- **Orphans.** The helper is not a subreaper: what a task leaves running
  reparents to init as before, stays in the task's group, and is seen and
  killed by `groupOutlives` / `untilGroupsGone` / `killTree` as before.
  The helper holds no task pipe past the fork, so a leftover's pipe still
  decides the drain.
- **What the task sees.** The same env, directory, descriptors, signal
  dispositions (Bun's children get them default; so does the helper and so
  its forks) and argv0. One difference: the shell's `$PPID` is the
  helper's pid, not vx's, fresh and spare alike.

## Where it applies

- `runCommand` on Linux x64/arm64, every spawn on the spawn thread
  (`spawnOff({ measure })`): fresh tasks and the ready shells
  (`warm-shell.ts`; a run keeps one per first-wave slot, `primeSpares`),
  each forked before its task is asked for. Retiring the ready shells
  now that a fork is cheap was measured and kept them: 600 `true` cold
  without them, 2567 ms wall and 2511 ms CPU (min) against 2414 and 2439
  with them; 400 mixed cold, 9942 against 9379 wall.
- DTE workers run tasks through the same local executor, so the same.
- **Not** the bwrap sandbox (`sandbox/runtime.ts` spawns its own wrap, and
  the pid namespace keeps the task's use out of any wait outside it; the
  tree is sampled as before) nor its strace path; **not** persistent
  tasks (`runPersistent` reports no usage); **not** a terminal task
  (`exec.interactive` on a TTY, spawned on the main thread): those keep the
  floor.
- **macOS** is unchanged: no helper, the floor as before.

## Cost

Per spawn: one `sendmsg` on the spawn thread instead of Bun's vfork and
exec wait; in the helper a `recvmsg`, two `faccessat`, a fork of a 5 KB
process, one 40-byte write; per exit a wake, a `wait4` and one write. Once
per run: the helper's start (~1 ms, at the first task).

Measured interleaved, min of N, on origin/main 77b85f0 (ready shells per
slot, #5523): "before" a `git worktree` of it, "after" a worktree of this
commit, an A/A arm (a second worktree of main) for the noise floor, one
workspace copy and `HOME` per arm warmed by that arm. Each run went under
a child subreaper, so CPU is vx's plus every process reaped (task shells,
the helper), whoever reaped them. The box ran at load 25-32 on 4 cores
from other jobs. Two passes for the mixed workspace and warm runs:

| workspace                     | mode       | wall min before / after / A/A | CPU min before / after / A/A | CPU median before / after / A/A |
| ----------------------------- | ---------- | ----------------------------- | ---------------------------- | ------------------------------- |
| 600 `true`                    | cold, n=15 | 3562 / 2414 / 3487            | 2578 / 2439 / 2546           | 2713 / 2633 / 2711              |
| 200 projects, 400 mixed tasks | cold, n=9  | 9462 / 9379 / 9306            | 8377 / 8553 / 8316           | 8706 / 8711 / 8614              |
| 200 projects, 400 mixed tasks | cold, n=15 | 9039 / 9125 / 9422            | 8370 / 8243 / 8251           | 8610 / 8577 / 8505              |
| 600 `true`                    | warm, n=11 | 319 / 433 / 480               | 301 / 317 / 321              | 338 / 339 / 341                 |
| 600 `true`                    | warm, n=21 | 415 / 415 / 426               | 319 / 319 / 327              | 340 / 352 / 340                 |
| 200 projects, 400 mixed tasks | warm, n=9  | 437 / 436 / 361               | 298 / 311 / 299              | 310 / 321 / 312                 |
| 200 projects, 400 mixed tasks | warm, n=21 | 380 / 459 / 373               | 292 / 291 / 285              | 318 / 310 / 310                 |

All in ms. The wall noise is the A/A's;
the CPU of vx and everything it left is steadier, and the after arm's sits
within the A/A spread: no cold cost. The wall is lower cold, since the
spawn thread no longer waits on a vfork per task. Warm runs spawn nothing
and do not move.
