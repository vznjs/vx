# `src/exec/` — process primitives

## `src/exec/kill-tree.ts` — a task dies with everything it forked

### Purpose

`killTree(child, signal)` signals a task child's whole process group.
Every task child is spawned `detached` — its own session and process
group — so the group IS the task's tree: the shell, what it backgrounded
(`server &`), a test runner's workers. Signalling the child alone left
all of that alive: a timed-out `sh -c "x & y"` killed the shell and
orphaned `x`, and a Ctrl-C did the same for every compound command
(item 236, 2026-09-16). A group signal reaches a member whose parent
already died — the group outlives its leader — so the order of death
does not matter.

### Public surface

```ts
export type Child = ReturnType<typeof Bun.spawn>
export function killTree(child: Child, signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): void
export function pauseTree(child: Child, signal: 'SIGSTOP' | 'SIGCONT'): void // Ctrl-Z, fg: the group, never the channel
export function markStopped(stopped: boolean): void // Ctrl-Z, fg: a task's timeout skips the time stopped
export function runTime(): number // performance.now() less the time stopped: the clock a task's duration reads
export async function untilGroupsGone(children: readonly Child[], graceMs: number): Promise<Child[]>
export function signalThrough(child: Child, fd: number): void
export function closeSignalChannel(child: Child): void
export function spawnGuarded(spawn: (guard: number | undefined) => Child): Child // guard: the pipe's fd in the child
export function guardLine(fd: number): string // the shell line that lists `$$`'s group and closes the pipe
export function listGroup(pid: number): void // vx lists a child that runs nothing until handed work (a spare shell)
export function flushGuard(): void // write the turn's queued lines now
export function releaseGroup(child: Child): void
export function groupAlive(child: Child): boolean // a group the guard still lists
export function holdGroups(children: readonly Child[]): () => void
export function releaseServerGroup(child: Child): void
export function guardSession(pids: readonly number[], paths: readonly string[]): () => void
```

`signalThrough` routes a child's SIGINT and SIGTERM down `fd`, a pipe vx
owns, instead of to its group: a Linux sandboxed task (item 752). Its
group is bwrap's, whose monitor died of the SIGTERM and took the
namespace down with SIGKILL (`--die-with-parent`), so a sandboxed
command's trap never ran; a watcher inside reads the signal's name and
signals the command's group (`exec.md`); the channel's end
(vx closed it, or vx is gone) SIGKILLs the namespace's processes, where
bwrap's `--die-with-parent` can miss. SIGKILL still goes to
the group, and a write the reader is gone for (EPIPE) falls back to it.
`closeSignalChannel` runs once the child has exited, and drops the entry
before it closes the descriptor, so a later kill never writes to a
number the process has since reused.

`untilGroupsGone` is the wait between the polite signal and SIGKILL: it
resolves when every child's GROUP is gone, or at the grace with the
children whose group still has a member — the ones to SIGKILL. The
leader's exit is not the end of the tree: `server & wait` dies on the
SIGTERM while a server that ignores it keeps the group and the task's
pipe alive, and the end-of-run shutdown that waited for the shell alone
never SIGKILLed the server — vx printed its summary and never exited
(nx#8286 reproduced on vx, 2026-09-24). After the leaders exit the
groups are polled every 20 ms, and only while one is left.

### The group guard: a `kill -9` of vx

A `kill -9` of vx, or the OOM killer, runs nothing in vx, so the kill
has to live outside it. `spawnGuarded` wraps each task spawn and lists
its group with the guard: one `sh` per vx process (argv0 `vx-group-guard`), its own group,
reading a pipe on its fd 3 whose write end vx holds. The spawned child
gets a copy of that end and lists itself: its shell writes `+$$` first
and closes the copy (`guardLine`; a program that is not a shell, the
port bridge's socat, is `exec`'d after it), and vx writes
`-<pgid>` (`releaseGroup`) once it is done with the task, beside the
`liveChildren` entry. A spare shell (`warm-shell.ts`) runs nothing until
vx writes its script, so vx lists its group itself (`listGroup`) and
writes the line before the script (`flushGuard`); a spare vx dies before
listing reads the end of its script's pipe and exits. vx's lines of one
event-loop turn go in one write at its end, and a clean exit writes any
still waiting: a write each held a cold run's main thread (500 tasks,
38 ms for the strikes) and woke the guard per line (140 ms of its CPU).
A `kill -9` inside that turn also takes what a task that ended in it
left in the background, as one a moment earlier would. A batch the
guard cannot take at once goes in 1 KB pieces as it drains; only a
guard that takes nothing for a second is gone. When vx and every child that has not yet listed
itself have closed their ends, the guard's read ends, and it SIGKILLs every group
still listed: the unsandboxed and the macOS sandboxed spawns get what
bwrap's `--die-with-parent` gives a Linux sandboxed task (item 860,
turborepo#9666). A group kill reaches what the task forked, so a
`dev` script's runner and its server go together.

- Started just before the first spawn: a run that spawns nothing, a
  warm run, never starts it (`keep-alive-sigkill.test.ts` › "a run that spawns
  no task starts no guard", which also pins the order). Before, not
  after: started after the first spawn, the guard's own spawn was a
  window in which the task ran unlisted, and under the gate's traced
  sandbox a third of the `kill -9` rows landed in it. vx then wrote the
  `+` line after the spawn returned, and under load the child ran first:
  a `kill -9` there left its group unlisted (4 of 40 runs at tenfold
  load, and macOS CI). The child holds the pipe until it has listed
  itself, so no window is left (B-9; `keep-alive-sigkill.test.ts` and
  `sandbox-lifecycle.unsafe.test.ts` stall vx after the spawn with a
  preload, red without it). A `true` spawn cost 1.31 ms against 1.32
  before it (min of 3 × 200, interleaved): a tie. A 300-project `test --all --no-cache` run
  (600 tasks) took 4,462 ms against 4,473 before it (min of 9,
  interleaved, one workspace copy per arm; medians 4,575 and 4,543): a
  tie. The cost is the one `sh` and two pipe writes per spawn.
- A guard that has exited (killed, the OOM killer) is handed to no
  later spawn: bash as macOS's sh buffers a failed `printf` and flushed the
  `+<pgid>` line into the task's own stdout (B-10). The line's `trap ''
PIPE` covers a guard that dies after the hand-over, so the task still
  runs; in that window bash may still print the line.
- A teardown holds its groups (`holdGroups`) until its SIGKILL sweep
  has settled: the signal stop (`terminateChildren`), the end-of-run
  persistent shutdown, and a readiness timeout, which holds until its
  group is gone or SIGKILLed. The runner lets a group go when its LEADER
  exits, and a shell that died on the signal while its child ran out
  the grace let the group go mid-grace; a `kill -9` of vx there left
  the child under init (item 865, both reproduced). A release that
  comes while a group is held is written when the hold ends; holds
  count, so two teardowns over one group let it go once both are done.
- A child whose group was empty when its leader exited is never signalled
  again (`releaseServerGroup`, from `runPersistent`'s exit): its number is
  free, and a ready server stays in the run's registry after it exits, so
  the end-of-run teardown's `kill(-pid)` could reach a group the kernel
  had since handed it (item 874). `groupAlive` reads such a group as gone.
  A group that still has a member keeps its number, is signalled, and
  stays listed until a teardown lets it go: the registry still owns it,
  and struck at the leader's exit, the `server` of a `server & echo up`
  outlived a `kill -9` of vx.
- A clean exit closes the pipe too, with the list empty, so the guard
  kills nothing. A released group is left as before: a one-shot task's
  `server &` outlives vx's clean exit, and a pid the kernel reuses is
  never killed on an old task's account.
- The sandbox runtime's session is listed too (`guardSession`). On Linux
  the runtime spawns its network bridge, a socat on
  `<tmp>/claude-http-<hex>.sock`, as a plain child in vx's OWN group,
  which the guard must never kill, and vx itself listens on
  `<tmp>/srt-obs-*/` and `<tmp>/srt-mux-<pid>-<n>.sock`. A `kill -9` of
  vx left the socat under init and the three paths behind; dozens piled
  up on a dev box. `initSandbox` reads them from procfs once per session
  (vx's children whose argv listens on the runtime's socket path, and vx's
  own socket inodes against `/proc/net/unix`; ~3 ms, sandboxed runs only)
  and lists the pids (`=<pid>`, killed alone) and the paths (`@<path>`,
  removed) — each a name only that session carries, never a sweep that
  could reach another live vx's. A finished reset strikes them (`_`,
  `!`), so a reused pid is never killed. A path holding whitespace is not
  listed. A socat that dies mid-session stays listed until the reset.
- The guard is detached, so a terminal's Ctrl-C does not reach it; that
  path is vx's own teardown (`orchestrator.md`).
- Best-effort: a guard that cannot start, or a write it is gone for,
  stops the guarding for the process and never fails a task.
- A guard that is behind is waited for, up to 1 s. Bun opens the pipe
  nonblocking and the kernel queues ~280 unread writes whatever their
  size (a burst of 420 releases overran a running guard), so a write
  EAGAINs while the guard lives. That read as a dead guard: vx stopped
  guarding while the guard kept every group whose release it never got,
  and SIGKILLed them at vx's CLEAN exit. A guard vx gives up on is
  SIGKILLed with its list. A child's own `+` line meets the same queue
  (it holds vx's nonblocking end): a group whose line hit a full queue
  went unlisted and survived a `kill -9`. Its shell retries a failed
  write until it lands or the guard's pid is gone (`kill -0`); the shell
  cannot tell EAGAIN from EPIPE, and a guard vx gives up on is
  SIGKILLed, so the pid ends the wait. `kill -0` counts a zombie, and
  a guard vx had not reaped (its event loop held, or an init that
  never reaps the orphan after vx's `kill -9`) kept the shell spinning
  at full CPU; where /proc is vx's own (`procfsIsOwn()`) the guard's
  state is read instead, so Z ends the wait. macOS keeps `kill -0`:
  the spin lasts until vx's loop runs. Only a line built inside
  `spawnGuarded` retries: any other pipe is not that guard's. The success path costs nothing
  new. The guard lists a group once however often its line arrives: a
  `-` strikes one entry, and a shell that keeps a failed printf
  buffered (bash as macOS's sh, B-10) resends it with the retry.
- The pipe is not inherited: Bun opens it close-on-exec, and a task's
  `/proc/self/fd` holds 0, 1 and 2 only (probed 2026-09-26).
- A per-spawn watcher in the task's own shell was the first sketch and
  is wrong: it is a job of that shell, so a task's bare `wait` waited on
  it until vx wrote.

`PR_SET_PDEATHSIG` was the other way, and was measured twice and
refused:

- 2026-09-24, a `bun:ffi` wrapper that calls prctl and then execve
  (`Bun.spawn` has no pre-exec hook): a Bun start per spawn, 9.8 ms
  against 1.0 ms for a bare `sh` (min of 10), Linux and glibc only.
- 2026-09-25 (item 801), util-linux `setpriv --pdeathsig KILL --` in
  front of the shell: 3.6 ms against 2.4 ms per spawn (min of 400,
  interleaved), and the same 600-task run at 3,865 ms against 3,631
  (+6.4%, min of 9, interleaved, one workspace copy per arm).

Either way the death signal reaches the one process it was set on, and
it does not survive a fork: `sh -c 'server & wait'` lost the shell and
kept the server, and a plain command vx execs (`exec sleep`) died while
whatever it forked lived on.

### Invariants

- A child with no pid (a spawn that failed) is left alone: `kill(-0)`
  would name vx's own group.
- `ESRCH` means the group is gone — nothing to do. Any other refusal
  falls back to the pid alone, as before.
- A zombie is not a member. `kill(-pgid, 0)` counts one, and an
  orphaned member that died on the SIGTERM stays a zombie until init
  reaps it — 1 to 2 s under this container's init — so on Linux a group
  the kernel still knows is read from `/proc/*/stat` (state and pgrp).
  Counting the zombie made a clean teardown wait 1.5–2 s instead of
  0.32 s. Elsewhere `kill(-pgid, 0)` is the answer — and on Linux too
  when procfs is another pid namespace's (`util/procfs.ts`): there the
  table held no member, a group that ignored the SIGTERM was never
  SIGKILLed, and a run under vx's own sandbox hung on a persistent
  dependency's server.
- Callers: the runner's timeout and readiness deadline, the signal
  teardown (`orchestrator/signals.ts`), the end-of-run persistent
  shutdown (`orchestrator/persistent.ts`), the sandbox's port-bridge
  teardown (`sandbox/runtime.ts`). The sandboxed spawn is
  detached too; bwrap's pid namespace would reap on its own, and one
  rule for every spawn is simpler than two.
- A task runs in its own session, so the terminal closing no longer
  reaches it: vx handles SIGHUP beside SIGINT and SIGTERM (129). The
  same session is why a terminal's Ctrl-C reaches vx alone, and vx
  forwards it as SIGINT (`orchestrator.md`), so a task hears it once.

### What it does NOT do

- Reach a daemon that called `setsid` itself — the residual every
  non-cgroup runner shares; a sandbox's pid namespace takes even that.
- Outlive a `kill -9` of vx in a process that left the task's group:
  a `setsid` daemon, as above. The guard itself can be killed too (a
  `pkill` of its name); then a `kill -9` of vx leaves the groups under
  init, as before item 860.
- Reap: the caller awaits `exited` as before.

### Tests

`tests/keep-alive-sigkill.test.ts`, "a SIGKILLed vx takes the groups it holds
with it": a persistent and a one-shot task's backgrounded grandchild die
with a `kill -9` of vx, and both fail without the guard. The control, a
one-shot task's leftover that outlives vx's clean exit, fails without the
release, and "a run that spawns no task starts no guard" fails on a guard
started at load, after the spawn, or once per spawn. A terminal's Ctrl-C
(SIGINT to vx's group) leaves the guard alive for a `kill -9` in the
teardown grace, and the one-shot row's child ignores SIGTERM, so a
guard that sent it fails. In `sandbox-lifecycle.unsafe.test.ts`, "a traced
sandboxed one-shot task’s children die with vx" (strace, then bwrap's
parent, outlived vx before the guard; since B-11 strace runs inside), and the unsandboxed control has the backgrounded
child die and the `setsid` one live. In `keep-alive-sigkill.test.ts`, "a kill -9 in
a Ctrl-C’s grace…" and "a kill -9 in the persistent shutdown’s grace…"
and "a never-ready server a dead shell left goes with a vx that exits
inside the grace" each fail without the hold. `tests/kill-tree-hold.test.ts` drives the hold
itself in a child that SIGKILLs itself: a deferred release is written when
the hold ends, and a group two teardowns hold stays listed until both let go.
There too, "a listed session’s pid dies alone…" (its unlisted sibling in
the same group lives) and "a struck session is left to itself".
`tests/sandbox-session-guard.unsafe.test.ts` SIGKILLs vx under a
sandboxed server and finds no bridge socat alive and no socket or
observer directory left; red without the listing.
`tests/kill-tree-guard-backlog.test.ts`: a task spawned after a burst of
2,000 releases still dies with a `kill -9` (fails without the wait), and
a released task's grandchild outlives a clean exit after a stopped guard
overran the queue (fails without the guard's SIGKILL). A task that
lists itself behind a stopped guard's full queue dies with a `kill -9`
once the guard resumes (fails without the retry); one whose guard is
SIGKILLed instead still runs (hangs without the `kill -0`); and a group
listed twice is released by one release (fails without the dedupe).
`tests/kill-tree-guard-zombie.unsafe.test.ts` (unsandboxed, for its own
/proc): such a task runs while vx's loop is held and its dead guard is a
zombie (hangs 10 s without the state read), and, the control, still
lists itself once a stopped live guard resumes (fails if the read calls
every guard dead).

`tests/task-tree-kill.test.ts`: a timeout, SIGINT, SIGTERM and SIGHUP
each reap a task's backgrounded grandchild (its pid from the inner
shell's own `$$`); every case fails on a pid-only kill. A timeout
reaps a grandchild that ignores SIGTERM after its shell has died. A persistent
dependency whose server ignores SIGTERM behind `& wait` does not hang
vx's exit; a grandchild's SIGTERM cleanup gets the grace after its shell
exits, and the teardown ends when the group is gone (under 1.2 s; the
zombie-counting read took 1.5 s).

## `src/exec/proc-sample.ts` — what a running task's processes use now

`resourceUsage()` answers only once a task exits. A telemetry sink that
wants a task's CPU and memory over its run (`task.sample`, telemetry.md)
needs a look while it runs: `sampleTrees(roots)` gives each live root pid
the summed CPU time (ms) and resident memory (bytes) of the root and every
descendant. `watchTree(pid)` is the sandbox's, and every Linux task's in the runner (the
wait's peak there carries vx's own): one 250 ms timer looks at
every watched tree, and `stop()` answers the most CPU and the peak memory
any look saw, or nothing when no look landed.

```ts
export interface TreeUsage {
  cpuMs: number
  rssBytes: number
}
export function sampleTrees(
  roots: readonly number[],
  skip?: ReadonlySet<string>, // members not counted (their children are): the tracer
): Promise<Map<number, TreeUsage>>
export function watchTree(pid: number): { stop(): TreeUsage | undefined }
export function psTimeMs(s: string): number | undefined // ps's `time` column, in ms
```

### Invariants

- A tree by parent pid, not a process group: a sandboxed task runs under
  bwrap in a session of its own, so its group is another, but each
  process still has its parent.
- Linux reads `/proc`: every `stat` for the parent map and the CPU
  (USER_HZ ticks, 100 by ABI; a process's own and its reaped children's,
  `cutime` + `cstime`, so a short-lived member's CPU stays counted), and `status` `VmRSS` (its unit written,
  kB) for the tree's members alone. Another namespace's `/proc`
  (`procfsIsOwn()` false) answers nothing rather than strangers.
- Elsewhere one `ps -A -o pid=,ppid=,rss=,time=` per look.
- A root that is gone has no entry; on macOS a descendant that exited
  leaves the CPU sum, and a process re-parented to init leaves the tree.
- Proven by `tests/proc-sample.unsafe.test.ts`: a burning grandchild's
  CPU reads within a bounded factor of the wall it burned (pins the
  tick and the tree walk), and memory within a bounded range;
  `tests/sandbox-usage.unsafe.test.ts`: a Linux sandboxed spin reports
  its CPU and peak.

## `src/exec/env.ts` — child process env builder

### Purpose

Compose the env object passed to every child process. Implements the
**isolated env** policy: tasks see only the essentials allowlist plus
what the user explicitly declared.

### Public surface

```ts
export interface BuildEnvOptions {
  passThrough: readonly string[] // names → values from source
  define: Readonly<Record<string, string>> // explicit literal pairs
  source: NodeJS.ProcessEnv // typically process.env
  binPaths?: readonly string[] // prepended to PATH: the project's bin, then the workspace root's
  workspaceRoot?: string // the inherited PATH drops each node_modules/.bin inside it
}

export function buildIsolatedEnv(opts: BuildEnvOptions): NodeJS.ProcessEnv

// ESSENTIAL_ENV (util/essential-env.ts, so hideEnvFromTasks keeps it too): the allowlist below
export function withoutWorkspaceBins(PATH: string, workspaceRoot: string): string // util/essential-env.ts; runtime probes use it too
export function ownEnv(source: NodeJS.ProcessEnv, name: string): string | undefined // util/essential-env.ts; an inherited name (`constructor`) is unset
export const VX_RUN_WORKSPACE_ENV = 'VX_RUN_WORKSPACE' // set on every task's env by execute-task: the workspace root
export const VX_RUN_TASK_ENV = 'VX_RUN_TASK' // and the task id — a `vx run` inside its own workspace reads them and refuses
export const PM_EXEC_ENV = 'npm_execpath' // set by execute-task unless a layer gives it
export function packageManagerPath(root: string): string | null // the root's manager binary, memoized per root
```

### Composition

Layers, lowest to highest priority:

1. **Essential allowlist** — hard-coded set of env vars copied from
   `source` when present. The list:

   `PATH`, `HOME`, `SHELL`, `USER`, `LOGNAME`, `TMPDIR`, `TEMP`,
   `TMP`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, `COLORTERM`,
   `FORCE_COLOR`, `NO_COLOR`, `CI`, `NODE_OPTIONS`, `COREPACK_HOME`,
   `PNPM_HOME`, `RUSTUP_HOME`, `CARGO_HOME`, `GOPATH`, `GOMODCACHE`,
   `GOCACHE`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`,
   `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`.

2. **`passThrough` names** — for each name, copy its value from
   `source` if present. Missing names are skipped (not assigned to
   empty string).

3. **`define` entries** — literal `name: value` pairs, applied next so
   they override earlier layers (including `PATH` if you want, though
   most users won't).

4. **`binPaths` PATH prefix** — applied last, AFTER `define`. Each
   entry is prepended to the existing `PATH` (joined by `path.delimiter`).
   The orchestrator passes `<projectDir>/node_modules/.bin`, then
   `<workspaceRoot>/node_modules/.bin` (one entry when the root is the
   project), so local tools resolve by name, and a monorepo's shared
   tooling, installed at the root, too. Never a sibling project's bin, so
   project isolation holds; the root is not a sibling. With `workspaceRoot`
   set (the orchestrator sets it), the `PATH` taken from `source` first
   drops each `node_modules/.bin` inside that root: `npm run` in a member
   puts that member's bins on the PATH vx inherits. Inside by spelling, or,
   for an existing directory, by canonical path: one spelled through a
   symlink (macOS's `/tmp`, a linked home, a shell's `$PWD`) beside the
   canonical root kept a sibling's bin. Asked per call, not memoized: a
   task can create the directory or the link. A defined `PATH` is
   kept whole. An `inputs.runtime` probe's PATH drops them too. An entry whose path
   holds `path.delimiter` (`:`) is left out: PATH cannot name it, and split
   it became two entries, the second relative to the task's cwd.

Result: a `NodeJS.ProcessEnv` ready to pass to `Bun.spawn`.

### What this does NOT do

- Doesn't validate that names look reasonable (no `=` in names, etc.).
  Garbage in → garbage out.
- Doesn't read from `.env` files or anywhere except `source`. If you
  want `.env` support, do it at the config-author level (parse the file
  in `vx.config.ts` and feed values into `define`). Bun would load one
  into `process.env` itself; the shipped `vx` starts Bun with that off
  (`index.md`, item 1089).
- Doesn't strip or sanitize values. Whatever's in `source[name]` is
  what the child sees.

### Why an explicit allowlist

Without the allowlist, child processes inherit the full parent env,
which:

- Makes builds non-reproducible across machines (every CI flag, every
  user-installed dotfile thing leaks in).
- Pollutes the cache key (if the user mistakenly tracks env: `*`).
- Hides what a task actually depends on.

With it, the rule is simple: a task depends on whatever its config
declares, plus enough essentials to find binaries and behave normally.

The allowlist is intentionally **not configurable** — a task declares any
extra vars it needs via `passThrough`. Workspace-level env defaults
(`globalEnv` / `globalPassThrough`) are an owner-rejected non-goal; compose
a shared `passThrough` list through a TypeScript preset instead.

### Tests

`env.test.ts` covers (and `env-path-delimiter.test.ts` the left-out entry):

- Essentials passed from source; undeclared vars stripped.
- Essentials omitted when not present in source.
- `passThrough` names forwarded; missing names absent (not empty
  string) in result.
- `define` values applied.
- `define` overrides `passThrough`.
- `define` overrides essentials.

### Replacing this module

Adjusting policy:

- **Different essentials list** — edit `ESSENTIAL_ENV`. Bump
  `CACHE_VERSION` if you think this changes task identity (technically
  it changes what the child sees, but not the cache key directly — env
  values participate via `inputs.env`, not via the essential
  list).
- **No essentials at all** — start with `{}`, only apply `passThrough`
  - `define`. Most tools won't find `PATH`; user must declare it.
    Strict reproducibility at high friction cost.
- **Layered profiles** — workspace-level + task-level merging. Build
  a different `BuildEnvOptions` upstream and feed it through; this
  module stays simple.

## `src/exec/executor.ts` — the per-task execution contract

### Purpose

The seam between "what to run" and "where it runs". `execute-task.ts`
resolves everything about one attempt — command, cwd, env, capture,
timeout, sandbox baselines — into an `ExecuteRequest`; a `TaskExecutor`
runs it and returns an `ExecuteResult` (exit code, streams, rusage,
sandbox violations). Core's own executor, `localExecutor`, is the same
`runCommand` / `runSandboxed` call the orchestrator used to make directly — it lives in `src/orchestrator/local-executor.ts` and is appended to the TAIL of every executor list (`resolveExecutors`, plugin-host.ts), so a task every plugin declines runs here.

### Public surface

- `TaskExecutor { name; remote?; sandbox?; capacity?; accepts?(task); demand?(remaining, missed); footer?(); machines?(); idealMs?(); advice?(); profile?(); running?(id); unneeded?(id); execute(req) }`
  — `idealMs()` is the run's end had it placed its tasks perfectly, from
  the run's start, replayed from what each took (the run summary's
  `idealMs`, shown beside the real time)
  — `advice()` returns the workers that would have run it best, from the
  same replay, as `WorkerAdvice` (`{ of: 'declared' | 'more' | 'any';
endMs; workers: { count; cores; memoryBytes; platform?; size? }[] }`):
  the fewest of the sizes it may start, more than their max when that
  ends sooner, and one shape of any cores (the run summary's `advice`)
  — `machines()` returns a `MachineReport` per machine it ran tasks on
  (`{ name; status; cores; memoryBytes; done; failed; onlineMs; busyMs;
cpuPeak; cpuAvg; memoryPeakBytes; memoryAvgBytes; utilization }`), asked
  once at the end for the run summary when a telemetry sink is on;
  `ExecuteResult.machine` (`{ cores; memoryBytes; cpuShare? }`) is the size of the
  machine `where` names, which the run history keeps, and the share of a
  core the task's threads got there (history divides its CPU by it)
  — `footer()` returns `[label, text]` rows the run's footer shows, live
  and at the end (a bad shape shows none; a throw from any of these
  reports leaves it out and is warned once per executor and method); `ExecuteResult.where`
  is shown on the task's row and frame after its id, as `<id>@<where>`; `running(id)`
  says where a task it was handed runs, for the live row, or `null` while
  it holds the task for a machine (no row; the tasks line counts it `scheduled`;
  under `--continue=never` a failure aborts its `signal` and it is skipped)
  — `remote: true` declares that the executor runs the command somewhere
  else (so it is never offered a `pinnedLocal` task); `sandbox: true`
  says it enforces `req.sandbox` where it runs and returns the
  violations: only such an executor is offered a task that declares
  `exec.sandbox`, here or remote (one that ran it unsandboxed passed a
  boundary it never checked, and cached the output), and for a remote one
  a sandboxed task's dependants are not pinned either (`@vzn/vx-dte`'s workers run them through `localFloor`, which also stops
  a request's children when its `signal` aborts and no run holds them);
  a cached task's `req.sandbox.keyed` lists the project directories its
  key answers for, so such an executor can build the request again on
  its own machine (`sandboxRequestFor`);
  `servers: true` says a remote one starts a task's persistent
  dependencies where it runs the task (`req.servers`, each a `ServerSpec
{ taskId; command; cwd; env; readyWhen?; timeoutMs?; sandbox? }`, in dependency
  order), so their dependants are not pinned for it; `localFloor` starts
  each once, a sandboxed one inside its `exec.sandbox` built there, shares it with every later task, and stops one on `stop(id)` (core calls the executor's `unneeded(id)` once no task left in the run uses it) or all on `close()`; its `onServer` hears each server's pid as it spawns and stops (a worker meters its servers),
  and a server that never became ready, or crashed after it was, fails the task with why,
  and a stop of the request ends its wait on one; `runtime: true`
  says a remote one answers a task's `inputs.runtime` / `workspaceRuntime`
  probes where it runs the task (`answerRuntime`) and fails it when one
  answers otherwise than `req.inputs` says this machine did, so a task
  whose key folds a probe is not pinned for it; `platforms` (a non-empty
  list of `PLATFORMS`, else the run is refused) are the machines it runs
  tasks on: a task naming `exec.platforms` is offered only to it when one
  is shared, and to no other remote executor; `workers` (distinct
  `[name, platforms]` pairs, each platform one of its `platforms`, else
  the run is refused) are its worker types in order of preference: a
  task naming `exec.worker` is offered it only when it has that type on
  one of the task's platforms, and any task it takes carries its type
  in `req.worker`; `capacity` is how
  many tasks it runs at once (a positive integer, else the run is
  refused), which makes its tasks a POOL of that size instead of local
  worker slots. Each flag (`remote`, `sandbox`, `servers`, `runtime`,
  `exclusive`, `timeouts`) is `true`, `false` or absent, else the run is
  refused: core reads it as `=== true`.
- `TaskPlacement { taskId; projectName; projectDir; command; pinnedLocal;
cacheable }` — what `accepts()` sees. Placement happens ONCE per task,
  before scheduling, so it cannot depend on anything resolved per attempt.
- `InputFile { path; digest }` — one entry of `TaskInputs.files`: the
  workspace-relative POSIX path and the git blob OID of the WORKTREE
  bytes (for a symlink, of its target string) — the same digest the key
  folds, so an executor elsewhere reproduces what a hit would match.
- `executorFallback(reason)` / `isExecutorFallback(err)` — a remote
  executor's way to give a task back, and core's test for it (matched by
  name, so another copy of `@vzn/vx` is recognised); see below. Only the
  first is on `@vzn/vx`.
- Runner's `withForwardArgs(command, args)` — the line the local executor runs:
  the args after `--` shell-quoted, before a trailing comment, never on a
  heredoc's terminator. On `@vzn/vx` for an executor that runs
  `ExecuteRequest.command` itself: the example's own join lost the args to
  a trailing comment and split `'a b'` (X-112).
- `hostPlatform()` — this machine as `exec.platforms` names it,
  `${process.platform}-${process.arch}` (`linux-x64`). Placement reads it.
- `ResolvedSandboxConfig` — a task's `exec.sandbox` with every path
  absolute, as the sandbox runs it; `SandboxViolation` — one denial (or
  vx's own `hint`) the sandbox reported. Both are fields of the request
  and result below, so they belong to this contract.
- `ExecuteRequest` — `taskId`, `workspaceRoot`, `command`, `forwardArgs`,
  `cwd`, `env`, `envDefine` (`exec.env.define` verbatim: the host-free
  part of `env`, safe to ship), `capture`, `outputs`, `timeoutMs?`,
  `onStdout`, `onStderr`, `signal?` (aborted when the run stops,
  `timeoutMs` elapses or fail-fast withdraws a task `running` says is not
  begun: an executor ends its work and returns, since core
  cannot reach a process it spawned; any exit after the timeout's
  abort, a 0 included, is recorded `timedOut` and fails (X-125); one that has not returned within the
  kill grace of the abort is abandoned, the attempt settled without it,
  its `where` the executor's name; a `timedOut` it reports on its own
  clock fails the same, the line saying its executor reported it),
  `liveChildren?`, `onSpawn?` (an executor that runs the command as a
  process on this machine calls it with the pid, so a telemetry sink can
  sample the tree's CPU and memory; absent when nothing samples),
  `sandbox?: ExecuteSandbox`, `terminal?: true` (the
  task holds vx's terminal, `exec.interactive` on a TTY: its stdio is
  vx's own and the callbacks hear nothing; placement hands such a task
  to core's local executor alone),
  `inputs?: TaskInputs`, `cacheKey?` (a cacheable task's key, the address
  an executor's own remote record uses), `refresh?` (cache reads are off, or
  remote reads are with a remote layer composed: do not answer from that
  record), `unsaved?` (core saves no entry under the key: the policy
  writes no layer, or an upstream failed under `--continue=always`, ran
  unkeyed or is keyless; or, with a remote layer composed, the policy
  writes no remote; an executor that saves results for dependants keeps
  them off the key too), `remoteOnly?` (`exec.remote: 'only'`:
  leave outputs off this disk), `platform?` (one of the task's
  `exec.platforms` the executor's `platforms` lists: run it there; its key
  folds it), `worker?` (the type of the executor's `workers` to run it
  on: `exec.worker`, else the first with one of its platforms; unkeyed),
  `download?: 'eager' | 'deferred'`.
  `outputs` is the DECLARED output globs (`files` project-relative,
  `workspaceFiles` root-relative) — what an executor running elsewhere has
  to bring back.
- `ExecuteSandbox` — `baseAllowRead`, `baseDenyRead`,
  `reportWithin` (the project: denials there are reported), `reportLinked`
  (the canonical directories of the linked workspace packages core
  withheld from a cached task because its key does not answer for them:
  denials there are reported too), `config`, and for a cached task
  `keyed`, `keyRoot` (the workspace root: a hidden read under it is named
  for `inputs.workspaceFiles` beside its grant) and `keyNested` (the
  projects nested in its own: a hidden read in one is named for
  `inputs.workspaceFiles` too, since `inputs.files` stops there). An executor that ships the
  sandbox elsewhere receives the narrowed `baseAllowRead`; enforcing it
  is its own.
- `TaskInputs` — everything the cache key folds, WITH values: `files`
  (workspace-relative path + git-blob digest of the worktree bytes, or of
  a symlink's target string, own outputs excluded), `env` (declared names + resolved values, `undefined` for an unset name), `runtime` /
  `workspaceRuntime` (command + the output that was folded — a toolchain
  expectation a worker must reproduce), `upstream` (dependency task ids +
  cache keys + each one's declared `outputs`, workspace-relative — already
  restored on disk before this task runs, so an input-shipping executor can
  put them in the input root; a non-cacheable dependency's are its declared
  outputs found on disk, and a cacheable one with no local cache entry has
  none; read up front for a plugin executor, never for the local floor),
  and `configDigest`.
  Present on the miss path of a cacheable task only; a task with no
  `cache` ships nothing. Built by `task-hash.describeTaskInputs` from the
  SAME resolution that produced the key, so it cannot drift from what a
  hit would have matched; held in memory for the attempt and never
  persisted (`env`/`runtime` values may be secrets — `entry_inputs` stores
  digests only).
- `ExecuteResult extends RunResult { violations; outputs?; changed?; where? }` —
  `outputs` is `{ kind: 'disk' }` or `{ kind: 'deferred'; materialize }`
  (outputs left remote, fetched only if a local consumer needs them).
  `spawnFailed: true` says the command never started (its 127 is the
  executor's, so no "command not found" line follows; A-41).
  `leftRunning: true` says a process the command left still ran when
  its shell exited (it held the output past the drain bound, or was
  still in the task's process group): core saves no entry for the task.
  `changed` lists the tracked files (workspace-relative) the command
  changed where an executor ran it elsewhere, and the untracked ones it
  found there: one the key read, or one its inputs declare (this disk
  lacks it, so the key never folded it), withholds core's save under the
  key, with the line an input changed here gets.
  Checked at the
  seam (`assertExecuteResult`): a plugin that resolves something else is
  refused with one line naming the executor, the task and the field
  ("returned an invalid result for <task>: exitCode is undefined (expected
  a number) — a plugin bug, not a task failure"; an `exitCode` that is
  no non-negative integer, or a `durationMs` that is no non-negative
  finite number, the same, X-11), in the task's frame,
  never a TypeError inside core. The optional fields are held to their
  types too: each violation an object with a string `line`, `where` a
  non-empty string, `cpuMs` / `peakRssBytes` non-negative numbers,
  `signal` a name or a positive integer (Bun's number for a signal with
  no name) and never beside an `exitCode` 0 (a killed command exits
  128 + n; that pass was saved), `timedOut` a boolean, `machine` positive `cores`,
  non-negative `memoryBytes` and an optional positive `cpuShare` (a
  `where` object lost the run's history to a bind error). `where` is the
  executor-reported placement label (a REAPI worker id); absent = this
  host. Rides `TaskOutcome.placement.where` into telemetry (OTel:
  `vx.task.where`), the task's row and the run history.
- `selectExecutor(executors, task, label?, pinnedFor?, barred?)` — first executor, in order,
  that may take the task: a `remote` executor is skipped outright for a
  task `pinnedFor` it says is pinned (default `task.pinnedLocal`), any
  executor `barred` names is skipped (the run bars one that does not
  enforce the sandbox from a sandboxed task), then `accepts` decides. An `accepts` that throws
  is a `UserError` naming the executor as `label` does (the run passes
  `executorLabel`, which names its plugin too; item 1022), and so is
  one that answers a Promise (`async accepts`), which read as a yes,
  or any other non-boolean (`'no'` took the task), as `admit` refuses
  one; `undefined` declines.
  The local
  executor is the tail of the list and accepts everything, so the
  throw for "every executor declined" is unreachable from `run()`; it
  stays for a caller that builds its own list.
- An executor's `demand` is first called once the cache has said which
  placed tasks it holds, and leaves those out: a warm run's restores
  are no one's demand (`plugin-capabilities.test.ts` › "a task the
  cache answers is never counted"). A left-out task that executes after
  all is counted again. Its second argument, `missed`, holds the left
  tasks whose keys that probe found in no store, each store answering
  for every key: they will run, so a plan sizes on them rather than a
  guess (`executor-demand.test.ts`). Behind a remote with a batch
  `hasMany`, that first call waits for its answer, however many hits
  the index keeps: a key the index lacks may still be held (main
  7391c93 asked 14 workers for 71 tasks, 17 of which ran, 2026-10-23).
  With no batch probe, the index's kept hits answer it.
- An executor's `demand` is a hint: one that throws, or an `async`
  one that rejects, is warned once, naming the plugin, and that
  executor is asked no more that run (item 1022;
  `placement-async-hints.test.ts`).
- A plugin executor's `execute` that throws fails the task, its message
  prefixed `plugin '<p>' (executor '<e>') failed in execute:` in the
  scheduler's one line, which lands in the task's frame (C-63), plainly, as a refusal: the
  plugin is named, so it is not vx's internal error (C-85). The local
  executor's own throw is vx's and is not renamed.
- `executorFallback(reason)` (on the façade) is how a `remote` executor
  gives a task back: its `execute` rejects with it, core says
  `[vx] <task>: plugin '<p>' (executor '<e>') gave it back: <reason> — running it here` once and runs a fresh request
  (its own timeout) on the local executor. A task placed
  `remote: 'only'` fails naming `reason` instead, as does one an
  `exclusive` executor took. A non-remote executor's
  fallback is an ordinary failure (B-100; `executor-fallback.test.ts`).
  `@vzn/vx-reapi`'s `queueTimeoutMs` is its consumer.

### Rules

- The request is fully resolved; an executor never reads task config.
- Persistent tasks (`exec.persistent`) never reach an executor as tasks
  — a worker cannot hand the submitter a port. A `servers` executor gets
  them as a dependant's `req.servers` instead; a server every dependant
  of which went to one is never spawned here (2026-10-22: nothing
  runs on a DTE run's orchestrator). One with `exec.sandbox` or
  `exec.remote: false`, or one the run holds for itself (requested), is
  not carried.
- A `timeouts` executor enforces `timeoutMs` where it runs the command,
  timed from its start, and reports `timedOut`; core arms no clock for
  it, so the wait for a worker still booting is not the task's run time
  (a 0.5 s task with a 2 s timeout was killed unrun, 2026-10-24). The
  run's stop still aborts its request.
- An `exclusive` executor runs every task of the run (2026-10-24:
  no task ever runs on a DTE run's orchestrator; only hits
  restore there). Nothing is pinned for it: `exec.remote: false`,
  `exec.interactive`, sandboxed and probed tasks and every server a
  dependant needs go to it. A task that would still land on the local
  floor (a platform it does not offer, one it declines, a sandbox or a
  probe it does not enforce, a server requested on its own) refuses the
  run, naming it.
- A task is `pinnedLocal` when it is persistent, transitively depends on a
  persistent task its executor does not carry, is
  sandboxed (the sandbox is this machine's machinery), depends on a
  sandboxed task (both unless the executor declares `sandbox`), declares `exec.remote: false`, or folds a runtime
  probe (`inputs.runtime` / `workspaceRuntime`) into its key unless the
  executor declares `runtime`: the probe is this machine's answer, and a
  worker's output under it is a stale hit (C-2). `placement.ts`
  computes the set once per run (`tests/placement.test.ts`).
- A task naming `exec.platforms` goes to an executor whose `platforms`
  share one, on the host's platform if both list it, else the first of the
  task's the executor runs (`node.platform`, folded into its key). Placed
  anywhere else it runs here when this machine is one of its platforms;
  if not, it is `otherPlatform`: a local run skips it and its dependants,
  green, while CI, or a routing executor that runs none of its platforms
  (`unroutable`), refuses the run before any task starts
  (`platformVerdict`, `tests/task-platforms.test.ts`). On an executor
  with `workers`, the platform is chosen from the task's type
  (`node.worker`): `exec.worker`'s, else the first whose platforms fit.
  An `exclusive` executor with no such type refuses the run; one with no
  `workers` ignores `exec.worker`, as this machine does.
- The executor list is resolved ONCE per run (`plugin-host.resolveExecutors`)
  and each task is PLACED once, before scheduling — every attempt of a task,
  including retries, runs on the executor it was placed on. Placement must
  precede scheduling because the scheduler admits a pooled task against its
  executor's `capacity` rather than a local worker slot.
- `exec.remote` is stripped from the cache key (`task-hash.hashableConfig`):
  placement has no effect on outputs, and a key that moved with it would
  gut the remote hit rate.

### What it does NOT do

- Ship inputs or materialise outputs elsewhere — `inputs` describes the
  set, the executor moves it. A remote executor is responsible for leaving
  the declared outputs under `cwd` when it returns (a later design's
  `outputs` discriminator will say where they are; see
  `docs/design/plugin-executor-reapi-2026-08.md` §4).
- List the AMBIENT files a worker also needs (`tsconfig.json`, `.npmrc`,
  root manifests, `node_modules`): the key treats them as environment, not
  input. Same-checkout workers get them from the checkout; an input-shipping
  executor needs them declared or provided by the worker image / an install
  action.

### Tests

`tests/executor.test.ts` (unit), `tests/plugin-capabilities.test.ts`
(`executor capability — end-to-end via run()`).

### Replacing this module

Contribute `executor(ctx)` from a plugin. `localExecutor()` is not on
`@vzn/vx`; an executor that declines a task (`accepts` → false) hands it
to the local floor.
