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
  teardown (`sandbox-runtime.ts`). The sandboxed spawn is
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

## `src/exec/sandbox-runtime.ts` — sandbox wrapper for per-task isolation

### Purpose

Thin wrapper around `@anthropic-ai/sandbox-runtime` (SRT) for running a
single task inside a filesystem + network sandbox with strict isolation,
for a task whose config declares `exec.sandbox`. The local executor
(`local-executor.ts`) calls `runSandboxed` for the attempt
`executeCachedTask` builds; a persistent task's path
(`persistent-task.ts`) wraps its command with `wrapSandboxedCommand` itself.

Policy: **fail on violation, no cache for failed tasks.** The sandbox
enforces the declared grants at the kernel level; a task that reads
outside them is denied (bwrap on Linux, seatbelt on macOS), the denial
is reported (an strace pass on Linux, the unified log on macOS), and a
reported violation inside the project forces a non-zero exit.
`cache.save` only fires when the task succeeded AND no violation was
reported.

### Files

`sandbox-runtime.ts` keeps the lifecycle (`probeSandbox`, `initSandbox`,
`resetSandbox`), the config resolution (`resolveSandboxConfig`) and the
spawn (`runSandboxed`, `wrapSandboxedCommand`, the macOS profile rules).
Three companions hold the rest, split 2026-09-09 as pure code motion:

- `sandbox-violations.ts` — the Linux strace pass (`deniedCalls`,
  `parseStraceViolations`; a call's result is read at its line's end,
  never from an argv string that spells one), the seatbelt record description, and the
  report filters (`reportableViolations`: inside the project or a
  withheld linked package, minus loopback noise, minus the task's
  `ignore`).
- `sandbox-binds.ts` — write grants as bwrap can honour them
  (`bindableWrites`), read grants punched around the write grants
  inside them (`punchWritePaths`), and the SRT custom config.
- `sandbox-paths.ts` — `toRealPath`, `absolutize`, `atOrUnder`,
  `isUnderAny`, `sandboxReads`, `unique`, `grantAlternatives`,
  `replacedBySandbox`.
- `sandbox-deny-scan.ts` — `scopedMandatoryDenies`: SRT's mandatory
  write denies (`.bashrc`, `.mcp.json`, `.vscode/`, `.git/hooks`, …),
  found within each task's write grants instead of the whole root.

#### The mandatory-deny scan, scoped (B-40)

On every wrap SRT walked `process.cwd()`, the workspace root, with
`rg --max-depth 4` (depth 3, files one level deeper; a named directory
such as `.idea` or a repository's `.git/hooks` one level less deep) for
names a task must not write, and kept a hit only
inside an allowed write path (the rest is read-only under `--ro-bind /
/` already). On 1,090 packages that walk was half of a sandboxed run's
wall time (25.4 s → 14.7 s once scoped; interleaved, min of 3). vx now
starts SRT with `mandatoryDenySearchDepth: 1`, so SRT lists only the
root's entries, and each wrap adds the denies `scopedMandatoryDenies`
finds under the task's write grants (SRT's default write paths
included) to `denyWrite`. A deny is the hit or one of its ancestors, so
every hit that counts lies under a write path. It runs per task and is
never cached: it decides refusals. It is stricter than rg: it walks
into `node_modules` and counts a symlink by its name, so such a file inside a write grant is refused where rg missed it.
A deny whose path holds a glob character would be dropped by SRT on
Linux, so the task is refused instead, and a root with one keeps SRT's
own depth-3 scan. `sandbox-deny-scan.unsafe.test.ts` holds the binds
equal to SRT's whole-root scan for three grant sets.

SRT still spawned its `rg` on every wrap for those root entries, and
cannot skip it. At depth 1 a hit lies in the root, which SRT keeps only
inside a write grant, where the scoped walk already reaches, so vx hands
SRT `true` as its ripgrep command (B-75): the spawn's 3.8 ms is 1.0, and
100 sandboxed `true` tasks at concurrency 1 run in 3.50 s against 3.95
(−4.4 ms a task, interleaved, three rounds). Since B-92 the command is
an empty file that cannot be exec'd: `posix_spawn` refuses it (ENOEXEC)
in 0.32 ms against `true`'s 1.06, SRT reads the refusal as an empty
scan, and its dependency check (`Bun.which`) still finds the file. SRT
runs it outside the sandbox, so it lives in this user's own 0700
directory under the OS temp dir (`vx-noscan-<uid>`), never in the shared
`/tmp/claude`. One per user, not per process (B-93): a `mkdtemp` one per
process outlived every SIGKILLed run, and the exit hook that removed it
also fired under a test's emitted `exit` with the process going on. A
directory at the name with another owner or group or other bits (a link
reads 0777), or a file there that is not empty or not executable, is
refused for `true` (`sandbox-noscan-dir.unsafe.test.ts`). The
availability probe hands SRT's dependency check that file made anew if
a temp cleaner took it, not the path SRT's live config holds
(`sandbox-noscan-gone.unsafe.test.ts`). The OS temp dir can itself be
one every task may write (an agent's shell sets `TMPDIR=/tmp/claude`,
which SRT binds writable into each), and there a task rewrote the file
and the next wrap ran it unsandboxed. So its directory, and the socat
wrapper's (whose file is granted back read-only: it is the task's side of
the proxy bridge too), are walled from every task
(`sandbox-host-helpers.unsafe.test.ts`).
100 sandboxed `true` tasks at concurrency 1: 2,846 ms against 2,721
(min of 8, interleaved; medians 2,948 and 2,812). The parity rows arm
SRT as vx does, with a root entry (`.ZshRC`) only a scan finds.

`allow.gitConfig` is read by SRT from the run's config only, so a run
with a task that grants it sets `allowGitConfig` per wrap, one wrap at a
time, as it does the unix-socket lift, and the scoped scan leaves that
task's `.git/config` hits out (B-41). Before, the flag vx passed per task
was never read and `.git/config` stayed read-only to every task.

### User-facing config

The task declares its sandbox policy under `exec.sandbox` in
`vx.config.ts` (the `SandboxConfig` type, exported from `src/config.ts`).
It is capability-shaped, not a mirror of SRT's own config: one vocabulary
says what a task may do, and this module translates it per platform.

```ts
exec: {
  command: 'bun test',
  sandbox: {
    allow: {
      read?: string[]         // paths or globs
      write?: string[]        // paths or globs; a write grant is readable too
      network?: true | string[]
      systemInfo?: string[]   // sysctl names, macOS
      unixSockets?: true | string[]
      localBinding?: boolean | readonly number[]
      machLookup?: string[]   // macOS
      pty?: boolean
      gitConfig?: boolean
    },
    deny?: { network?: string[] },
    ignore?: { read?, write?, systemInfo?, network? }, // what to leave out of the report
    weakerWhenNested?: boolean,       // Linux
    weakerNetworkIsolation?: boolean, // macOS
    hermetic?: boolean,               // refuse reads outside the workspace too
  },
}
```

Paths resolve relative to the project directory, are used as-is when
absolute, and expand `~` against the user's home. Globs are accepted:
macOS passes the pattern into the policy (so it matches files created
during the run); Linux expands it at task start, because a grant there is
a mount. `<dir>/**` and `<dir>/**/*` collapse to `<dir>` on both, so
`read: ['**/*']` lets a task list its own cwd. A write glob makes each
directory it matches writable whole on both: Linux binds the hit, and
macOS grants the glob's subtree beside it, so pnpm 12's lock directory
grant covers the lock file inside it.

There is **no inheritance** from `.vx/workspace.ts`, and nothing is
derived from `cache`. The single grant core makes is dependencies:
`node_modules` for the project and the workspace root, plus the real path
of every workspace package symlinked into them, and into theirs in turn
(pnpm and Bun link a dependency's own under it) — a project never names a
sibling to import what its `package.json` depends on. A link back to the
task's own project, or to a directory holding it, is dropped (compared
canonically): npm and Yarn link every package at the root, and following
that link re-granted the whole project past its `allow.read`.

#### What SRT's config cannot carry

`localBinding`, `unixSockets`, `machLookup`, `weakerNetworkIsolation` (its
`trustd.agent` lookup) and `systemInfo` do not reach
SRT as config, and neither does a `network` domain list. The first four exist as fields, but `sandbox-manager.js`
(0.0.75, still 0.0.81) reads them off the config given to `initialize()` and never off
the per-call one, so a per-task grant is silently dropped; `systemInfo`
has no field at any level (each name becomes both a `system-info` and a
`sysctl-read` rule: Bun reads `hw.optional.neon` as a sysctl). vx is per-task by definition, so it appends
the corresponding SBPL rules to the END of the seatbelt profile SRT
generated — last-match-wins is the only position where a rule of ours
outranks one of SRT's. Measured 2026-09-05: the same rules injected after
the `(deny default …)` header are inert in both directions. Filesystem
grants still go through SRT's config, where they also work on Linux, bar
`gitConfig`: SRT reads `filesystem.allowGitConfig` only at `initialize()`
too, and vx adds no rule for it, so it is inert.

The `network` case has no such workaround: SRT runs ONE filtering proxy
per run and checks every request against `config.network.allowedDomains`
from `initialize()` (`sandbox-manager.js:238` in 0.0.76). `run()` therefore arms it
with the union of every domain any sandboxed task declared. Every
sandboxed task is handed that proxy, so a task that declared no domains
reached the union until 2026-11-06. `deniedDomains` is handed to SRT
empty: each task's front refuses its own `deny.network`; the run's
proxy refused the union of every task's denies to every task until
2026-11-06 (B-21, schema.md § `exec.sandbox`). SRT cannot tell tasks apart: its filter hears a host
and port, and the command's name rides in the proxy username, which the
sandboxed process writes, so one task could claim another's list.

So in a run whose proxy allows any host, each task with a network list,
or none, gets a front of its own
(`task-proxy.ts`, built from SRT's own proxy modules): it filters by the
task's lists and passes what it allows on to the run's proxy as its
parent, which applies the union and its address guard again. The socket
the task was given is what names it. Linux: the front listens on a
socket in the task's tmpdir, bound over SRT's bridge path after the
root's read-only bind (a bind before it is masked). macOS: it listens on
a loopback port of its own, and the task's proxy variables and profile
name it in place of the run's. A refusal is recorded as SRT's own
violation line. `network: true` keeps the run's proxy. A task the front
cannot take fails instead of running on the run's proxy.

### Public surface

```ts
export interface SandboxAvailability {
  available: boolean
  reason: string // empty when available
}

export function probeSandbox(opts?: { weakerNested?: boolean }): Promise<SandboxAvailability>
export function initSandbox(opts?: {
  allowedDomains?: readonly string[] // the run's union
  deniedDomains?: readonly string[] // every task's deny.network: checked, never handed to SRT
  allowAllUnixSockets?: boolean // some task asks; the lift is set per task's wrap
}): Promise<void>
export function resetSandbox(): Promise<void>
// why sandboxed tasks run untraced (no working strace), or null; `vx info` says it
export function untracedReason(): Promise<string | null>

export interface ResolvedSandboxConfig {
  /* same shape as SandboxConfig, paths absolute */
}
export function resolveSandboxConfig(
  cfg: SandboxConfig,
  projectDir: string,
  walls?: readonly string[], // canonical dirs a glob's hits stop at (sandbox-request.ts `wallOff`)
): ResolvedSandboxConfig
// scratchWrites judged, the mountless reported once each; the scratch returned
export function pendingWriteGrants(config, fs, anchors, within): string[]

export interface SandboxedRunArgs {
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  forwardArgs?: readonly string[]
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  liveChildren?: Set<ReturnType<typeof Bun.spawn>>
  onSpawn?: (pid: number) => void // RunOptions.onSpawn
  signal?: AbortSignal // ExecuteRequest.signal: once aborted, no tracer retry (B-36)
  timeoutMs?: number
  capture?: CaptureConfig
  baseAllowRead: readonly string[] // node_modules + resolved workspace links
  baseDenyRead: readonly string[] // [workspaceRoot, ...credential stores] — not its project's neighbours, nor ~/.ssh (L-41)
  reportWithin: string // projectDir — only denials in here are worth reporting
  reportLinked: readonly string[] // withheld linked packages (canonical) — reported too
  keyRoot?: string // a cached task's workspace root: a hidden read under it is named for inputs.workspaceFiles too
  keyNested?: readonly string[] // the projects nested in its own: a hidden read in one is named for inputs.workspaceFiles, never inputs.files
  upstreamOutputs?: readonly string[] // the dependencies' outputs: a write refused there gets a note to run their task, no grant
  config: ResolvedSandboxConfig // its allowWrite is the whole write set: none is derived
}

export interface SandboxViolation {
  line: string
  timestamp: Date
  target?: string
  hint?: true // vx's own note, shown but never counted (B-20)
  path?: string
  via?: string // Linux: the unmounted directory holding a link the task opened through
  opened?: 'read' | 'write' // Linux: what a refused openat's flags asked for
  ignorable?: readonly ('read' | 'write' | 'network' | 'systemInfo')[]
}
export interface SandboxedRunResult extends RunResult {
  violations: SandboxViolation[]
}
export function runSandboxed(args: SandboxedRunArgs): Promise<SandboxedRunResult>

// The wrap without the run: the sandboxed command line, the tag its
// violations are reported under, and the canonical baselines it was
// built from. What an executor running the command ITSELF needs.
export function wrapSandboxedCommand(
  args: Pick<SandboxedRunArgs, 'command' | 'cwd' | 'forwardArgs' | 'config' | 'env'> &
    Pick<SandboxedRunArgs, 'baseAllowRead' | 'baseDenyRead'> & { server?: boolean },
): Promise<{
  wrapped: string
  tag: string
  taggedCommand: string
  srtCommand: string
  baselines: CanonicalBaselines
  forwardsSignals: boolean // the command reads its polite signals off fd 3 (item 752)
}>

// Release the port bridges a tagged run held. Paired with the wrap above:
// runSandboxed does it itself, a caller that wrapped must do it.
export function releaseBridges(tag: string): void

// A thrown value as a line a user can read — an FS refusal keeps its
// errno, anything else its message. The sandbox never reports a stack.
export function thrownReason(err: unknown, what?: string): string
// The probe's verdicts as one line each: a failed start, missing
// dependencies, a temp dir too long for the socket path or one the
// runtime cannot carry unquoted.
export function unavailableReason(exitCode: number | null, stderr: string): string
export function dependencyReason(errors: readonly string[]): string
export function socketPathRefusal(tmpdir?: string, taskTmp?: string): string | undefined

// The port bridge (Linux; § Port bridge)
export function bridgedPorts(c: Pick<ResolvedSandboxConfig, 'localBinding'>): number[]
export function portBridgeSocket(tag: string, port: number): string
export function portBridgeInner(ports: readonly number[], tag: string): string
export function portBridgeHostArgv(tag: string, port: number): string[]

// macOS: the per-task seatbelt rules vx emits, and a path refused, never escaped
export function macProfileRules(c: ResolvedSandboxConfig): string[]
export function sbplResolvedPath(value: string, field: string): string

// sandbox-paths.ts: the wildcard alphabet of a GRANT. Smaller than
// util/paths.ts's BUN_GLOB_WILDCARDS on purpose — a grant's braces are
// expanded first, so one left is escaped and literal (scanned, it would
// match nothing before the task writes). The request builder reads it to
// decide whether an output grant is a glob.
export const MOUNT_WILDCARDS: RegExp
export function isMountableLiteral(grant: string): boolean
// The grants one declared grant stands for: braces expanded as a task
// glob's are, and an escaped brace or comma in a literal read as itself.
export function grantAlternatives(grant: string): string[]
// Linux: `dir` is under `/dev`, which the sandbox mounts afresh, so no
// sandboxed task runs there (refused by the request builder; `vx info`).
export function replacedBySandbox(dir: string): boolean
// The one path a grant names: a literal, or one whose only brackets are
// escaped (`out/\[id\]` names `out/[id]`); undefined for a pattern.
export function namedPath(grant: string): string | undefined
// A path with its existing prefix realpath'd and the rest re-appended.
export function toRealPath(p: string): string
export function absolutize(p: string, cwd?: string): string
// `p` is `dir` or below it, by path (a name-prefix sibling is not): the
// one copy of the check the sandbox code makes.
export function atOrUnder(p: string, dir: string): boolean
export function isUnderAny(abs: string, allow: Set<string>): boolean
// Whether a sandboxed task may read a file: no denial, or a read, write or
// baseline grant, at or above its canonical path (the shell verdict asks it).
export function sandboxReads(sandbox: ExecuteSandbox, file: string): boolean
export function unique(arr: readonly string[]): string[]
export function localBindingOn(c: { localBinding?: boolean | readonly number[] }): boolean
// The host loopback ports a `network` list names (`localhost:4173`,
// `127.0.0.1:4173`, `[::1]:4173`): relayed into the namespace on Linux,
// allowed by name in the profile on macOS.
export function loopbackPorts(network: true | readonly string[] | undefined): number[]

// sandbox-binds.ts: the binds a write grant becomes on Linux (a file grant
// widened to its directory), and a read grant cut around the walls a
// project stops at (item 1010). The request builder refuses a write bind
// that would hold a wall and punches the read grants.
export function bindableWrites(paths: readonly string[]): string[]
export function punchWalls(readPath: string, walls: readonly string[]): string[]
// The files a key holds (workspace-relative) no read, write or baseline
// grant of the request reaches, canonical: hidden inside the sandbox. A
// wildcard grant reaches its literal head; `ignore.read` leaves one out.
export function keyedOutsideGrants(
  sandbox: { baseAllowRead; config },
  workspaceRoot: string,
  rels: readonly string[],
): string[]
export function punchWritePaths(
  readPath: string,
  writePaths: readonly string[],
  reachable?: (real: string) => boolean, // may a linked child's target be reached
): string[]
// Linux: the links a punch handed over as read grants, taken out of
// `allowRead` as `[text, at]` and laid by vx with `--symlink` before
// bwrap's `--` (a grant in `granted` is left as it is)
export function punchedLinks(
  granted: readonly string[],
  allowRead: string[],
): Array<[string, string]>
export function withPunchedLinks(wrapped: string, links: ReadonlyArray<[string, string]>): string
// The write globs that matched nothing at the start, split by whether a
// bind holds their directory (below, "A write grant that mounts nothing");
// one a write bind holds is in neither
export function scratchWrites(pending, fs, anchors): { scratch: string[]; mountless: string[] }
// The directory a write glob's matches land in: its head's
export const globDir: (glob: string) => string
// The SRT customConfig: the baselines merged with the resolved block
export function buildCustomConfig(args, baselines): SrtCustomConfig
// Linux: SRT's bwrap line with its --tmpfs masks remounted read-only, the
// deepest one a scratch glob's directory lies in left writable
export function readOnlyMasks(wrapped: string, scratch?: readonly string[]): string

// sandbox-violations.ts: what a trace or a seatbelt log reports
export interface DeniedCall {
  syscall: string
  rawPath: string
  errno: string
  read?: true // a read that succeeded (`reads`)
  writes?: true // an openat whose flags ask to write or create
  dir?: string // the dir a relative rawPath was opened from, after a chdir
}
export function deniedCalls(text: string, cwd?: string, reads?: boolean): DeniedCall[] // strace lines, split calls paired; paths follow each chdir from cwd; reads: successful opens too
export function parseStraceViolations(
  logPath,
  args,
  baselines,
  widened?,
): Promise<SandboxViolation[]> // widened: `widenedEntries` at task start; none, no read parse. Judges each distinct call once and yields every 500: a worker's heartbeat is not held
export function reportableViolations(
  violations: readonly SandboxViolation[],
  opts: { within: string; linked?: readonly string[]; config: ResolvedSandboxConfig },
): SandboxViolation[]
export function refusedWrites(
  records: readonly string[],
  writable: readonly string[],
  scratch?: readonly string[], // pending write globs a write may land under; one left in the scratch at the end is reported
  readable?: readonly string[], // what the sandbox mounts readable: a mkdir, openat2 or timestamp change there wrote nothing
  widened?: { entries; granted }, // `widenedEntries` at task start and the write grants: a write there is judged by the grants
): SandboxViolation[]
// the writes refused past the wall, as paths: a failed task's hint
export function refusedWritesOutside(violations, opts: { within; linked?; config; skip }): string[]
// the reads the wall hid of paths that exist on the host, files first: a failed task's hint
export function hiddenReadsOutside(violations, opts: { within; linked?; config; skip }): string[]
// Linux: the proxy's `deny network-outbound <host>:<port> (<reason>)` records
export function refusedConnections(records: readonly string[]): SandboxViolation[]
```

### How it works

1. **`probeSandbox`** asks SRT whether the platform is supported and
   whether its runtime deps (bwrap, socat and ripgrep on Linux — the
   runtime expands its mandatory deny globs with `rg`; sandbox-exec on
   macOS) are present — a missing one is named with the whole set and
   the install (`dependencyReason`) — then on Linux runs ONE sandboxed
   `true` through
   SRT's own wrapper — bwrap with the runtime's namespace flags plus its
   vendored `apply-seccomp` helper, which creates a nested user
   namespace. A bare `bwrap … /bin/true` passed on hosts where every
   task then failed (root inside a container: the helper's
   `write /proc/self/uid_map` is EPERM under `--cap-drop ALL`); the
   wrapper probe refuses up front, naming the fix (a non-root user, or
   `sandbox.weakerWhenNested: true` on every sandboxed task —
   `run()` probes the weaker mode only when every sandboxed task opts
   in). Memoized per mode. A throw from the runtime itself is the same
   one-line verdict, and one about its own temp files (the observer
   directory and the bridge sockets live under `os.tmpdir()`; the strace
   log beside the task directories, which every sandbox replaces with its
   own, since a concurrent task read it there, L-25) names the knob: the sandbox runtime needs a writable
   temp directory and the one it has is not one, point TMPDIR at a
   writable directory. The probe also refuses up front a temp directory
   whose socket path is past the OS limit (`sun_path`, 108 bytes on
   Linux and 104 on macOS; on Linux the longest name is the network
   bridge's, `claude-http-<16 hex>.sock`): past it the runtime said ENAMETOOLONG on
   macOS and "Failed to create bridge sockets after 5 attempts" on
   Linux, neither naming the directory; the verdict now gives the path,
   its length, the limit and "point TMPDIR at a shorter path". It also
   refuses a TMPDIR, or a CLAUDE_CODE_TMPDIR (the parent of the task temp
   directories, which hold vx's own bridge sockets), that is not absolute
   or holds anything but ASCII letters, digits and `. _ - / + @`: the
   runtime pastes the socket path unquoted into the shell script it runs
   in the sandbox and into socat addresses on the host, and vx splices its
   own into bwrap's command line. A `;` hung the run, a space cost every
   task ~7 s and its network proxy, `,` `:` `'` `"` `(` failed "Failed to
   create bridge sockets after 5 attempts", a relative path failed "a
   mount went away", and a non-ASCII letter failed a networked task; the
   verdict names the variable and the path.
2. **`initSandbox`** is called at most once per `vx run`, lazily: the
   first sandboxed execution arms the run's `prepareSandbox` armer
   (sandbox-request.md), which probes and then inits. It calls `SandboxManager.initialize`
   with a deny-all baseline (network blocked, no filesystem allows);
   per-task wrapping overrides those defaults.
3. **`runSandboxed`** is called once per sandboxed task:
   - Prepends a unique `: 'vx-<hash>';` shell no-op to the command so
     SRT's `getViolationsForCommand` can disambiguate concurrent tasks
     with identical commands (it keys by base64 of the first 100 chars).
     On Linux the tag also leads the wrap SRT keys write records by, ahead
     of the proxy-bridge wait every task shares
     (`tests/sandbox-records-key.unsafe.test.ts`).
   - Builds a `customConfig` by merging the baseline (dependency dirs
     and the workspace-root deny anchor) with the user's resolved
     sandbox block, then appends the rules SRT's config cannot carry.
   - Calls `SandboxManager.wrapWithSandbox` to get the wrapped command
     string, spawns it via `sh -c wrapped` — on Linux with the trace
     log on fd 5 for the strace inside — with `sh`, `strace`, and (through SRT's
     `bwrapPath` / `socatPath`) `bwrap` and the network bridge's `socat` resolved on vx's own PATH
     (`util/which.ts`), so neither Bun nor strace walks the task's PATH,
     whose `node_modules/.bin` comes first, for the shell; and
     captures stdout/stderr + resource usage like
     `runner.ts:runCommand`, except that on Linux what bwrap's pid
     namespace used never reaches vx's wait (a 500 ms busy loop read
     2 ms, and the peak read was vx's own mark, B-3): the CPU and peak
     are `watchTree`'s looks at the task's tree while it runs (strace not
     counted), none for a task over before the first look.
   - After `proc.exited`, reads back any violations from the macOS
     log monitor (macOS only — see the Linux row below for why the
     store's Linux feed is ignored) AND (on Linux) from the strace log
     the spawn wrote,
     then calls `SandboxManager.cleanupAfterCommand()`. A wrap that
     spawned nothing (a spawn that failed, a stop before it, a macOS
     profile refused for its shape) calls it too, and drops its task
     dir: SRT removes the empty mount-point stubs bwrap made on the host
     (`.bashrc`, `.vscode`, … under a write grant) only once every wrap
     has, and one missed call kept every later task's stubs until the
     reset. A held `localBinding` port is refused before the wrap.
   - On Linux, an attempt whose stderr holds a line of strace's own
     (strace names itself by its argv[0], `/usr/bin/strace: …`) is run
     once more unless it timed out or the run is stopping: the trace
     stopped short, and under `--seccomp-bpf` (which implies
     `--kill-on-exit`) a dying strace SIGKILLs the task (exit 137; M-18).
   - On Linux, every task the run's proxy bridge reaches waits, in front
     of its command, until SRT's in-sandbox proxy bridges (`socat TCP-LISTEN`
     on 3128 and 1080, started in the background) listen, read off
     `/proc/net/tcp{,6}`, at most ~5 s: its first dial met "connection
     refused" on a loaded box (M-20). A task with no `allow.network` waits
     too: its dial must reach the proxy, whose refusal names the host and
     fails it; without the wait it met the closed port under load and
     passed with nothing reported. The wait costs ~4 ms, the socat's start.
     A bridge that never listens is said on the task's stderr (`[vx] the
sandbox's network proxy bridges (ports 3128 and 1080) did not listen
within 5 s; …`) and the command runs anyway.
4. **Filtering.** Enforcement anchors at the workspace root, but only
   denials on a path inside `reportWithin` (the project) or one of
   `reportLinked` (the linked packages a cached task was denied because
   its key does not answer for them) are reported — every process walks
   from `/` down to its own cwd, and being stopped at the wall is the
   sandbox working. A record with no path (a `system-info` probe) is
   kept. The task's `ignore` patterns are applied last: each list
   silences the operations of its kind, a pattern matching a record's
   target exactly or as a glob — for `read` and `write`, the record's
   canonical path, which the boundary above judges too: a seatbelt
   record named through a link was reported and its pattern, matched
   against the path as logged, silenced nothing. A relative pattern anchors at the
   project, a `~` one at the home directory (kept as written, it matched
   no recorded path, B-13), and a pattern's literal head is canonicalized as the
   records are, so a project reached through a link (macOS's `/var`)
   is silenced where it lands (B-2).
5. **`resetSandbox`** tears down SRT's proxy servers + (on macOS) the
   log monitor at the end of `vx run`.

### Platform behaviour

| Platform | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | sandbox-exec + Seatbelt. Structured violations land in `SandboxViolationStore` via the system log monitor; we force exit 1 when any are recorded. A task may list each directory above a grant inside the workspace, and each a glob grant names (`darwinAncestorRules`), as Linux's mounts allow: `../vx-*/package.json` globbed from `..` was EPERM on macOS only (2026-10-17). Seatbelt shows such a listing whole, where Linux shows only what it mounted: the task sees its siblings' names, never their data. Not the workspace root: Bun read the root `package.json` it saw there.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Linux    | bwrap mount namespaces. Denied paths are structurally invisible → child sees `ENOENT`. The command runs under `strace -DD -f --seccomp-bpf -e trace=openat,?open,execve,?access,faccessat,?faccessat2,?readlink,?readlinkat,chdir,fchdir,clone,…` INSIDE the sandbox and the trace is parsed for denials against the task's own baselines, each relative path resolved against the cwd its process had (`chdir` followed per process, a child starting in its parent's; B-61) (`--seccomp-bpf` keeps the ptrace stops to the traced calls; without it every syscall stopped and a stat-heavy task ran many times slower — the cache perf baselines failed on the Linux job for that reason until 2026-09-09; strace < 5.3 gets the slow form). Inside, strace follows the command alone: wrapped around bwrap it followed the namespace's setup too, and a sandboxed `true` cost 41 ms against 30 (min of 40, A/B interleaved, A/A within 2 ms; B-11). It writes to the host's log through fd 5, which the command's shell closes first. It is started from a fresh fork of the shell, with SIGINT and SIGQUIT put back (an async list starts with them ignored, and a task's `trap … INT` would never fire), because `-DD`'s process waits for ANY child to hear the tracer attached: an inherited one that exited first (the watcher, SRT's network bridges) sent the command on untraced, and its `execve` failed `ENOSYS` under the seccomp filter. `-DD` puts strace off the command's line, so a `sleep 10 &` the command leaves is not a tracee strace waits for; the namespace ends with the command and takes strace along, and a tracee stops at each `openat` until its line is written, so none is lost. The wrapper's `wait` prints nothing: bash reported a job a signal killed on the task's stderr, so a task whose shell died of SIGKILL showed the whole wrapper (X-111). SRT ≥ 0.0.75 also feeds its store on Linux from the seccomp helper's write observer, but judges those reports against the GLOBAL `allowWrite` from `initialize` (empty; the per-task list is in `customConfig`, which the monitor never sees), so every declared-output write arrives as `deny openat <output>`; vx judges those records against the task's own binds (`refusedWrites`, the write grants as bwrap binds them), and what no bind covers is a violation, save a `mkdir` of a directory a bind lies in: bwrap made it to mount the bind, so the call met EEXIST and wrote nothing (`mkdir -p node_modules/.cache/tool` under a grant of `node_modules/.cache/` failed a clean task, 2026-10-03), or of a path that exists inside the sandbox through a read grant (at or under one that exists): `mkdir -p src` under `read: ['src']` failed a clean task the same way (X-82). strace never sees a write: the observer's USER_NOTIF takes precedence over strace's TRACE, so a refused write (`EROFS` under a read-only bind) or one into the anchor's scratch went unreported and a task that swallowed it exited 0 (B-5). The store is a 100-record ring shared by the run, so vx subscribes once and keeps each record for a command still running (`collectRecords`): read at exit, a refused write followed by 150 declared ones was already gone (B-7). The records arrive over a Unix socket vx serves, not with the exit: a task that refused a write and ended at once was seen to exit before its connection was read, so vx gives the event loop two turns first, one to accept and one to read (38 of 200 such tasks, 16 at a time, went unreported). |
| Windows  | Unsupported: vx has no native Windows build or branch (#2227); under WSL the Linux row applies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

`wrapSandboxedCommand` is the enforcement half on its own — the tagged command under SRT's wrapper, vx's seatbelt rules appended on macOS — and the persistent path spawns through it (`executePersistentTask`): a dev server declaring `exec.sandbox` gets the same walls and no violation report, since the report reads the trace after exit. One that exits failing before it is ready is told so beside its failure (`executePersistentTask`): a refusal reads there only as the tool's own "not found".

On Linux the command runs in a session, and so a process group, of its own inside the sandbox: `: 'vx-<tag>'; { while read -r s; do kill -s "$s" -- -$$; done; kill -s KILL -- -$$ 0; } <&3 & exec setsid sh -c '<command>' 3<&-`, both tools resolved on vx's own PATH. `sh`, the shell an unsandboxed task runs: it was `bash`, and brace expansion, `[[ … ]]` and `echo 'a\tb'` read one way with the block and another without it where `/bin/sh` is dash (item 964). bwrap's `--new-session` puts the runtime's shells (the proxy bridges' script, the seccomp step's) in one group with the command, and `kill 0` reaches a group's members across the nested pid namespace, so a command that signalled its own group ended the runtime's shell: bwrap exited 143 and the namespace's teardown SIGKILLed the rest mid-trap (item 751). The shell `exec`s `setsid`, which is no group leader there, so it execs without a fork and the command keeps the shell's pid: an exit status and a signal death (137) are the command's, as before. The cost is a `setsid` exec and a second shell, about 3 ms on a 35 ms sandboxed `true` (min of 15, three interleaved pairs). A cancellation reaches the command the same way (item 752): vx's group signal would end bwrap's monitor, and `--die-with-parent` SIGKILLs the namespace, so a `trap … TERM` never ran. The watcher forked before the `exec` reads a signal's name off fd 3, which vx writes for SIGINT and SIGTERM (`signalThrough`, `exec.md`), and signals the command's group, `$$`; SIGKILL at the grace's end still goes to bwrap's group. When fd 3 ends (vx closes it once the task has exited, or vx is gone), the watcher SIGKILLs the command's group and its own, the runtime's shells and bridges, and the namespace's init exits with no child left. bwrap sets `--die-with-parent` in the namespace only after its monitor forks it, so a monitor killed in those milliseconds (a `kill -9` of vx, a task stopped as it starts) left init, the command and its bridges under the host's init, a port held for hours (2026-11-12, `sandbox-lifecycle.unsafe.test.ts` › "a sandboxed persistent task’s children die with vx when bwrap’s parent-death signal missed"). The command runs in the foreground because an `&` command starts with SIGINT ignored, which a shell cannot trap; it does not get fd 3. `wrapSandboxedCommand` says so in `forwardsSignals`, and both spawns (`runSandboxed`, and `runPersistent` with `signalChannel`) pass fd 3 when it is set.

On Linux the wrapped command is `exec /abs/bwrap …`, behind `GIT_DISCOVERY_ACROSS_FILESYSTEM=${…-1}` for a task whose grants name a `.git`: every mask and bind is a mount point, and git's discovery stops at one, so such a task read "Stopping at filesystem boundary" (2026-10-03, `sandbox-git-discovery.unsafe.test.ts`). Only such a task: git-aware tools read the variable, vx's own repo probe among them. The bwrap: SRT wrote a bare `bwrap` into a command the task's shell runs with the TASK's environment, so a dependency's `node_modules/.bin/bwrap` ran in its place and the task ran unsandboxed, exit 0; `initSandbox` now hands SRT vx's own paths for `bwrap` and `socat` (B-19). the spawn's shell execs bwrap, so bwrap is vx's own child and its `--die-with-parent` fires when vx dies, a `kill -9` included. The pid namespace then takes every descendant, one that called `setsid` too. Behind a shell that waited on it, bwrap's parent was that shell, which outlived vx, and a sandboxed server's whole tree ran on under init (turborepo#9666; item 801, `sandbox-runtime.unsafe.test.ts` › "a sandboxed server’s backgrounded and setsid children die with vx"). A one-shot task traced for violations is the same `exec bwrap …`: its strace runs inside (B-11). A persistent task is never traced. strace failing on its own (a stderr line of its own, `strace: …`) ends only the attempt: the task runs once more, with a line saying why, and the second attempt is its verdict — unless the run is stopping (`ExecuteRequest.signal` aborted): its kill already took the children it held, and a retry would be spawned after it (B-36). The second attempt runs in what the first left of `timeoutMs`, not a fresh window: `timeout` bounds the task's whole run (`schema.md`), and a fresh one let a task run near twice its timeout. Its exit is no longer the task's — a tracer that dies leaves the command running untraced — so the line, not the exit, is the sign: the trace stopped short, and a denial after it would go unreported. Inside, the tracer shares the task's pid namespace and uid, so a task can end it or reach its log through `/proc`: the violation REPORT is at the task's mercy, as it never is for enforcement, which is bwrap's mounts. The sandbox kept the first attempt's writes to what it declared, so the second redoes rather than doubles them (STATUS Next 24, `sandbox-tracer-retry.unsafe.test.ts`). A mount gone as bwrap set the sandbox up (`bwrap: Can't …: No such file or directory`: a `docker build` beside the task left a transient mount under /tmp, read from the mount table and gone by its remount; `… remount "…": Invalid argument` when the mount is gone but its directory is not yet) is retried the same way, once: the command never started (`sandbox-mount-race.unsafe.test.ts`). The trace log is the task's own file beside the task directories (L-25), removed once it is read; a second signal's exit (`process.exit`) never reaches that read, so the process's `exit` event removes every log still listed (item 848, `sandbox-runtime.unsafe.test.ts` › "a second signal exit leaves no strace log behind"). A first signal lets the run end and read the log itself (item 849).

A write grant under a directory with SYMLINKED entries (Bun's isolated `node_modules` layout: every package is a link into `.bun/`) punches the read grant into that directory's children, and bwrap mounts a linked child as the directory it points at — inside the sandbox the link is gone and a package resolved through it cannot see the `.bun/` siblings its own dependencies live in (`Cannot find package 'yargs-parser'`, the docs build, 2026-09-05 → 09-09). SRT's config has no `--symlink`, so the punch hands a linked child over by its name and vx lays it as the link it is, before bwrap's `--` and the masks' read-only remount (`punchedLinks`, `withPunchedLinks`): pnpm's Vite template, whose `tsc -b` writes `node_modules/.tmp/*.tsbuildinfo`, failed `Cannot find package 'picomatch'` under the grant the fix line named, and a warning said to move the grant (`sandbox-write-through-link.unsafe.test.ts`). A linked child that points INTO a write grant writes through to it. A write grant spelled through a link in the project (`gen/` over `gen -> real`) resolves to `real`, and SRT skips a sibling link as a write path, so `resolveSandboxConfig` records it (`linkedWrites`) and vx binds the target at the link's spelling itself, last before bwrap's `--` (`linkedWriteBinds`, `withLinkedWrites`); the read punch goes around that bind too. A linked child whose target lies under the deny anchor (the workspace root) and inside no read grant is dropped, not bound: `node_modules -> ..` or `shared -> ../b` under a `read: ['.']` punched around `dist/` bound the root or a sibling no key answers for, where the grant bound whole keeps the link a link into the deny (item 1006's glob hit, through the punch).

The strace pass closes the silent-swallow gap on Linux (tools that read
an undeclared path, catch the `ENOENT`, and keep running): the denial is
reported as a violation even though the task exited 0. Trace parsing
pairs `<unfinished ...>` with its `<... resumed>` line, so a denial in a
forked child is reported too — a single-line match dropped those, which
made the violation list incomplete under concurrency. A relative path is
resolved against the cwd its process had moved to: the parse follows
each `chdir` and starts a child in its parent's cwd at the fork (a
thread, `CLONE_FS`, shares it instead), after
the whole pass, since a `vfork` child's lines precede its parent's
`resumed` line. Against the starting cwd, a denial after `cd src` named
a file that does not exist and no `ignore` for the real one matched.
strace's `-y` names the directory on every line, but cost 40% on 2,000
opens (min 240 → 337 ms); the extra stops here cost nothing measurable
(B-61). Without `-y` a call through a directory descriptor
(`openat(3, "f")`) is placed by the traced `openat` that last returned
that descriptor in its process or the one it was forked from; placed in
the cwd, Python's `os.open('f', dir_fd=d)` inside its grant failed the
task as a refused `./f`, and a real denial through one named the wrong
file. A descriptor no traced open returned keeps the cwd. A
refused `chdir` is a denial of its own, a read of the directory: `cd src`
into a directory no grant holds failed with no violation, and
`cd src || …` passed and cached (B-67). An `execve` or an access probe
(`access`, `faccessat`, `faccessat2`) is traced too: a refused
`./gen.sh || fallback` or `test -x src/gen.sh` went unreported. So is
`readlink` / `readlinkat`, judged as a read of the link itself, never its
target: git hashes a link by its target string, and `readlink cfg` read
an input no open showed (a stop costs ~9 µs: 2,000 links 14 → 51 ms,
oxlint and vx itself within A/A noise, 2026-11-08). A hidden
path answers `ENOENT`, as a missing one does, so a probe's `ENOENT` counts
only where the host has the path; `EACCES` and `EPERM` always count. A
`chdir` is judged as a probe: `mkdir -p gen/deep`, refused at `gen`, then
cds into it, and that `ENOENT` was reported, judged a write (nothing on
the host) and fixed with a file grant `gen` that vx refuses beside `gen/`. The
stat family stays untraced: a stop per stat cost `oxlint --type-aware`
19% (min of 7, 679 → 811 ms) and `git status` 30% (57 → 74), where the
execs and probes cost nothing measurable (688 and 58). Tracing it was tried
again on 2026-10-23 and cost vx's own no-op run 69% (pr-bench, 495 → 835
ms). So `test -e`, bash's PATH search and a tool that stats before it
opens (Ubuntu 26's `cat`, uutils) still go unreported: a read through
the shell (`cat < x`) or any tool that opens first is reported. A failed
task whose last output (the last two chunks of each stream, kept by
reference) calls missing a path the sandbox hides and the host has (tsc's
`TS5058: The specified path does not exist: 'tsconfig.json'`, on stdout)
gets a hint naming it and its grant (`statedHiddenHint`,
`sandbox-hidden-reads.unsafe.test.ts`). A task that passes on its
fallback (`existsSync('build.json')` false) is not caught: hidden, the
file answers the same `ENOENT` every run, so the cache replays what the
sandbox built, but the build differs from an unsandboxed one. macOS
reports the stat: seatbelt's `file-read*` deny covers a file's
`file-read-metadata`. A path is
strace's C string, decoded: read raw, `q"t.txt` was cut at `q\` and
`é.txt` named `\303\251.txt`, so the report and every `ignore` pattern
missed the file (B-54). A miss under a grant is the task's own missing
file, not a denial, and is not reported: a read grant's, and a write
grant's (GNU `cp` opens its destination before creating it, tsc probes
its buildinfo; counted until X-63). A grant the sandbox mounts no bind
for permits nothing. Without `strace`
on PATH, or one whose `--version` fails, the sandbox still ENFORCES; only
the structured list is lost, and that is said once on stderr (B-51):
before, a task that tolerated the miss passed and cached with no word.
The same holds where strace is present but may not attach (Yama's
`ptrace_scope` 2 or 3, a container's seccomp profile): `--version`
answers there, so detection also traces `true` once per run with a
task's own flags (about 9 ms), and a refusal means no tracing, said once
on stderr. Before, every sandboxed task failed twice on
`attach: ptrace(PTRACE_SEIZE…): Operation not permitted` (B-18). A
probe that exits 0 having said something of strace's own counts too:
a strace that cannot check the seccomp filter's order (it is itself
traced) says `check_seccomp_order_tracer: …` and traces on without the
filter, and inside the sandbox that line was the retry key, so every
sandboxed task ran twice. Then the plain form is probed and used if it
is quiet; if it speaks too, tasks run untraced, said once (B-64).
The memo is the probe's promise, not its answer: a wave of tasks that
started together each ran their own probe before the first answer
landed (`sandbox-run-direct.unsafe.test.ts` › "tasks that start together
ask once").

A task that failed with nothing to show gets vx's own notes beside the
failure, each a `SandboxViolation` marked `hint`: the cwd it cannot read
(the one denial macOS never logs), a write placeholder it never wrote, a
dependency read through a withheld link. They are shown with the denials
and never counted as one, so the `(N sandbox violations)` label and
fail-on-violation count denials only; the placeholder's note had read
"1 sandbox violation" beside a failure of the task's own. The cwd note
asks whether a read grant covers the cwd, and on Linux also whether one
lies inside it: bwrap builds the path to a bind, so the cwd lists, and a
root's `read: ['.']`, bound as its children around the walls, drew the
note on every failure (B-20).

A failed task's note also names the paths outside the project the wall
hid that exist on the host (`hiddenReadsOutside`), with a grant to add,
spelled as the refused-writes note spells one: from the project inside
the workspace, `~/…` under home, else absolute. A path under a deny
entry other than the ones holding the project (a credential store or its
link's target, `~/.vx` or a cache directory outside the workspace, the
repository's git data outside it) is named but never the suggested
grant: an agent applies a suggestion as given, and `cat ~/.npmrc` was
told to grant `../../home/.npmrc` until 2026-11-08. For a cached task
(`keyRoot`) a grant inside the workspace comes with the
`inputs.workspaceFiles` entry that keys it: applied alone, the grant
read the file unkeyed and an edit there was a stale hit. Inside the
project it is `inputs.files`, except in a project nested in it
(`keyNested`): `vx lock` refuses a `files` glob into one, so a root
`tsc -b` reading a member was told an entry it could not declare. The entry is
spelled by `taskGlobOf`, as the fix's is: `'\\!cfg'` for a file `!cfg`,
which raw is a negation that keyed nothing.

A cached task whose key holds a file outside the project that no grant
reaches is failed before it runs (execute-task.ts, `keyedOutsideGrants`), on both platforms: the
trace records no stat, and oxlint `statx`es its `.oxlintrc.json` before
opening it, so with the file hidden it passed on its defaults and was
saved under a key holding the file. A hidden read of a file the key does
not hold stays silent on a pass: tools probe many paths.

bwrap enters the task's cwd only if a mount holds it, and otherwise
`$HOME`, with no word: a project granted no read (`sandbox: {}`, its own
`node_modules` absent) ran in the home directory, where `cat x.txt` read
`~/x.txt` and a `mkdir dist` met `Read-only file system`. On Linux, when
no grant holds the cwd (`cwdMounted`: one at or above it, or an existing
one below it), vx denies the cwd too: the task
enters an empty directory, its reads there are refused and reported, and
its writes are refused (`readOnlyMasks`) and reported (B-53).

SRT hides a read-denied directory under a bwrap `--tmpfs`, which is
writable: a write into one (the workspace root, a sibling's tree, the
cwd above) succeeded and vanished with the sandbox, so a task writing
`../../out.txt` went green with its output gone, where seatbelt refuses
it. `readOnlyMasks` adds a `--remount-ro` for each before bwrap's `--`,
after the mounts beneath it, and a write there is `EROFS` on both
platforms; a failed task's hint names one outside the project. The
deepest mask a pending write glob's directory lies in stays writable:
that is its scratch (`scratchWrites`).

SRT reads any Linux read path holding `[` as a glob, where a bracket
opens a class. By the time vx hands the policy over, every grant is a
path, so it spells each `[` in a read or deny path as `[[]`, a class of
one bracket (`literalReadPaths`): a route granted as
`pages/\[id\].tsx` matched and was never mounted (its denial unreported,
a listed grant), and a workspace under a bracketed directory was never
walled (B-57).

A `*` or `?` in a Linux read path has no such spelling: SRT's rewrite of
each runs inside a class too, so a grant of `a*b.txt` granted `aXb.txt`.
`bindableReads` leaves such a grant out, says so once, and the strace
pass judges against what is left, so a read of it is refused and
reported. In a deny path the match is only a wider wall. A backslash
SRT skips outright: Bun's `realpathSync` throws ENOENT on a path holding
one (Node's does not; `stat` finds it), and SRT mounts no path it cannot
resolve, so such a read or write grant is left out the same way, and a
project under such a directory is refused on Linux: its task saw no
project and ran in `$HOME`.

SRT drops every Linux write path holding `[`, `]`, `*` or `?` (it reads
one as a glob), with no spelling that keeps it, so `bindableWrites` drops it
first and says so once, naming the directory above it: left in, the read
grants were punched around a bind that never came, the directory
vanished from the task's view ("Directory nonexistent"), and the refused
write went unreported, judged against the grant (B-59).

On macOS vx hands seatbelt's SRT the grant as written, and SRT compiles
a spelling holding `[` as a regex in which a backslash is a literal one,
so the escaped `pages/\[id\].tsx` named no file. vx spells `\[` as `[[]`
and `\]` as `]` there (`seatbeltBrackets`), and a deny path's `[` as
`[[]`: a nested project's wall under `[legacy]/` matched nothing. A
baseline read (a `node_modules`, a linked dependency) is a name, so its
`[` is spelled `[[]` and its subtree granted beside it: raw, a dependency
under `packages/[legacy]/` was a class that matched `packages/l`, and an
exact regex grants a directory's entry and none of its files. A task's
read grant whose only brackets are escaped names one path the same way and
gets the same subtree, as Linux's bind gives it: `out/\[id\]` read the
directory and none of its files. A baseline
inside a wall a glob reaches is carved out whatever its name holds. A project under a bracketed
directory is refused on both platforms (B-60, B-65): seatbelt compiled
vx's own workspace wall as a class too, so it matched nothing. So is one
under a directory holding `*` or `?`, whose grants matched its siblings.

A `*` or `?` meant as itself, escaped in a grant (`a\*.txt`) or in a
baseline's name, has no seatbelt spelling either: SRT compiled the
escape's backslash as a literal one, so `a\*.txt` granted `a\bc.txt`, a
name the task never declared, and never `a*.txt`. `seatbeltBrackets`
leaves such a grant out and says so once, naming the directory above it,
as `bindableReads` does on Linux.

SRT's in-sandbox network bridge is `socat TCP-LISTEN:3128` (and 1080),
which socat 1.8 opens as an IPv6 socket. On a host without IPv6 it
failed ("Address family not supported by protocol") into /dev/null, and
every networked task met only a refused connection on the proxy. There
the wrapped command sets `SOCAT_DEFAULT_LISTEN_IP=4`, socat's own switch
for the listen family (`hostHasIpv6`: `/proc/net/if_inet6`, asked once);
a host with IPv6 is untouched (B-22).

### A task's temp directory

SRT points every sandboxed task's `TMPDIR` at one host directory
(`CLAUDE_CODE_TMPDIR`, else `/tmp/claude`), bound read-write and kept
across runs. A file one task wrote there was the next task's, and the
next run's, undeclared input: a cached reader replayed the first value it
saw after the writer changed it (item 965). Each task now gets its own,
`vx-tasks/vx-task-<pid>-<tag>` under it, exported as `TMPDIR` after the command's
tag (SRT keys violations by the first 100 characters), and as `TMP` and
`TEMP` when the task's env has them: passed through from the host, they
named a temp directory the sandbox mounts read-only, and a tool reading
them failed to write (`tests/sandbox-temp-vars.unsafe.test.ts`). Created before the
spawn and removed with the task's bridges at its end, or at exit; a wrap
that throws (a held port) removes it at once, as a failed spawn does its
strace log, or a `vx watch` kept one per refusal until it quit. A
`kill -9` runs no exit hook and leaves it. A sweep of the directories whose
owner's pid is gone was tried and refused: a nested vx (this repo's own
test shards) sees another pid namespace, where the outer vx's pid reads as
dead, and the sweep removed the outer task's `TMPDIR` mid-run. The shared
directory itself stays writable (SRT's policy grants it): a command that
names it outright still reaches it. `vx-tasks` is walled from every
sandboxed task, each granted its own directory inside (L-10): under the
shared directory a task listed a concurrent task's `TMPDIR`, read what it
kept there, and could replace its port bridge's socket, which lives in the
task's own directory too.
`vx-tasks` and each task directory are mode 0700, and `vx-tasks` must be
this user's own real directory in a parent no other user may rewrite
(others' write needs the sticky bit, as `/tmp` has): the shared directory
is shared across users too, and one who made `vx-tasks` first renamed a
running task's directory and planted their own under the name the host
bridge dials (L-13). Anything else refuses the sandboxed task and names
the directory; one of ours left open is closed.

### The environment SRT sets

With the network restricted, SRT sets its own values over the ones vx
built for the task: `SANDBOX_RUNTIME`, `TMPDIR` (above), the proxy
variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `GRPC_PROXY`,
`FTP_PROXY`, `NO_PROXY` and their lowercase forms, `RSYNC_PROXY`,
`DOCKER_HTTP(S)_PROXY`, `CLOUDSDK_PROXY_*`,
`CLAUDE_CODE_HOST_*_PROXY_PORT`), `GIT_SSH_COMMAND`,
`GIT_CONFIG_PARAMETERS`, `SOCAT_DEFAULT_LISTEN_IP`, `SHLVL`, `JAVA_TOOL_OPTIONS` (below), and the CA-bundle variables when it has a CA
(`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and the others in its
`CA_TRUST_VARS`). A task's `define` or `passThrough` of one of these
names does not reach a sandboxed task: the sandbox's network goes through
SRT's proxy and nowhere else.

`JAVA_TOOL_OPTIONS` is the exception vx repairs. SRT composes its proxy
agent's flag with the value in VX'S environment, so a host value that no
layer passes reached the task out of its key, and a changed host value
replayed the old output; a task's own value never arrived (item 995).
The command's prefix now cuts the host's value out of what SRT set and
appends the task's own, so the task sees the agent flag plus exactly what
its layers gave it. Where SRT left the variable alone it already holds
the task's value and the prefix changes nothing, and where the task's
value IS the host's (passed through, or neither has one) SRT's own
composition is right and no prefix is written (item 1007).

### Path canonicalization

Every path the policy is expressed in is canonicalized (`realpath`, with
non-existent suffixes re-appended) before it reaches SRT — the user's
`allow.read` / `allow.write`, the orchestrator's dependency dirs, and the
workspace-root deny anchor. The sandbox matches on
canonical paths (macOS Seatbelt evaluates real vnode paths; bwrap mounts
inside a new root), so a workspace reached through a symlink must not
express half its policy in link paths and half in real ones. Before this
was applied to the orchestrator baselines, such a workspace made every
sandboxed task die with `bwrap: Can't mount tmpfs on /newroot/<link>`.

Canonicalizing a WRITE grant is also how a link moved it: `out.txt ->
../b/src/x`, committed or planted by the task's own previous run, bound
project b's directory writable, and vx, unsandboxed, created the empty
placeholder at the link's target first (item 1003). A project-relative
write grant whose path through its links (a dangling last one included)
leaves the project is now refused before anything is created, a
placeholder is made only where nothing is (an exclusive create after an
`lstat`), and the sweep takes back only a regular file. A read grant may
still resolve out through a link: `node_modules` links into the store.

A grant is mounted at its real path and bwrap mounts no link, so
`read: ['config.json']` over `config.json -> conf/real.json` bound the
target and left out the name the task opens. The trace judged the ENOENT
by its real path, which the grant covers, and dropped it: a tool that fell
back on the missing file went green and cached the fallback. An ENOENT
whose real path is granted and exists on the host is now a violation when
a link on the opened path sits in the deny anchor in a directory no grant
mounts (`hiddenLink`). A link in a mounted directory, or outside the
anchor, is there inside; a target missing on the host is missing outside
too (`sandbox-grant-through-link.unsafe.test.ts`).

A GLOB grant is expanded on Linux to its hits, each bound, and bwrap binds
a link by its target: `read: ['*']` over `shared -> ../b/src` bound
project b readable where `read: ['.']` did not, and a cached task
replayed b's old bytes (item 1006). A hit whose real path leaves the
directory holding the pattern's first wildcard is now dropped, so a glob
reaches no further through a link than the directory grant would. The
baseline `node_modules` reads are granted apart and are unaffected.

### The walls a project stops at

The key of a project excludes the projects nested in it, and the deny
anchor is the workspace root, which is a ROOT project's own directory: its
`read: ['.']` bound every nested project, `.git` and `.vx/cache` readable, and a
cached root task replayed a nested file's old bytes; a file grant there
(`write: ['out.txt']`) is widened to its directory, which bound the whole
workspace writable, `.git` included (item 1010). The request now carries
the node's nested project directories, and with the root's `.git`, `.vx/cache`
and the run's cache directory when it lies in the workspace (a `cache.dir`
inside a project was writable to a task granted it, L-24) they are walls: on Linux a read grant containing one is punched
around it (`punchWalls`, the write-path punch with the wall dropped), on
macOS each wall is a read deny, which SRT emits after a literal grant
holding it so that the deny wins (B-4), and
a write grant whose bind, widened or not, would hold one is refused,
naming the wall. A grant that names a wall or a path inside it is the
user's on purpose and stays, as does a bind outside the workspace (`/tmp`,
`~`) unless it reaches the repository's git dir there (a workspace below
the top-level, a linked worktree: `orchestrator.md`). A glob's hit that is a wall or lies inside one was matched, not
named, and is dropped before the bind (`resolveSandboxConfig` takes the
walls): `read: ['*']` in a root project binds neither `.git` nor `.vx/cache`,
`packages/*` no nested project, and `write: ['.*']` is refused for no wall
(B-1). Seatbelt matches a glob as a path regex, with no hit to drop, and
SRT re-emits a wall's deny after the allows only under a literal grant:
a root project's `read: ['**/*.txt']` read nested projects and `.git` on
macOS. Each wall a glob grant reaches (one at or under the glob's literal
head) is denied at the profile's tail, reads as `file-read-data` like
SRT's own wall denies, writes as `file-write*`, with a literal grant at
or inside the wall carved out, a baseline's included (`darwinWallRules`,
B-12). A grant whose only brackets are escaped names one path and counts
as a literal on both sides (`namedPath`): `packages/\[legacy\]/src`
reaches no wall, is carved out of one, and its hit inside a wall binds on
Linux, as `packages/legacy/src` does. A custom `cache.dir` inside a project
is not a wall.

### A write grant that names a file

On Linux a grant is a bind mount, and a grant naming a FILE binds that
file — you cannot rename onto an active mount point. Every tool that
writes its output by staging beside it and renaming (`bun build
--compile`, most compilers, any atomic writer) then dies with EBUSY.
Minimal repro, 2026-09-05: under `bwrap --bind /w/dist/out.bin
/w/dist/out.bin`, `mv /w/s /w/dist/out.bin` is "Device or resource busy";
binding `/w/dist` instead succeeds.

`bindableWrites` therefore widens a file-shaped write grant to its
directory ON LINUX ONLY. It is a widening — the task may write that
file's siblings — and it is the narrowest thing the mechanism can
express; the alternative is a declared output the task cannot produce.
macOS matches paths rather than mounting, so the grant stays exact there.

A read under the widened directory is never refused either: a task
granted `write: ['out.txt']` read an undeclared `secret.txt` with no
violation, and a cached run replayed its old bytes after it changed. So
when a grant was widened, vx lists the directory as the task starts
(`widenedEntries`), the strace pass also reads the `openat` and `open`
calls (musl's open() is `open`; traced as `openat` alone, its reads went
unreported) that succeeded and were not for writing alone, and each
`readlink` that succeeded (a link's target string is its bytes in git:
`readlink cfg > out.txt` cached `v1` and replayed it after `cfg` moved to
`v2`), and reports one of those
entries that no grant covers — and the directory's listing while it
holds one, since it names every sibling. The declared files, other
grants and what the task made there itself stay readable. `grep -r` and
`find` open each entry relative to a directory's descriptor, which the
trace names only by number, so such a task's strace runs with `-y`,
which prints the path each descriptor opened (40% slower on 2,000
opens). The parse takes a descriptor's printed path up to the `, "` that
opens the file argument, since a directory's name may hold a quote
(`4</ws/q"d>`). No widened grant, no `-y` and no extra parse. strace
never sees an `openat2`: SRT's write observer takes every one, read or
write (its flags lie in a struct its filter cannot read), its
USER_NOTIF wins over strace's TRACE, and its record names no flags. So
`refusedWrites` takes an `openat2` record as either: where the sandbox
can read the path (`inSandbox`), or a read grant covers it under a
widened directory, it says nothing, since a write there met the
read-only bind and landed nothing; elsewhere it reports `= an open no
grant covers`, ignorable as a read or a write, and the fix names a read
grant, the cheaper one (a granted `openat2(O_RDONLY)` read failed a
clean task as a write until 2026-11-07,
`sandbox-openat2.unsafe.test.ts`). A refused timestamp change
(`utimensat`, `utimes`, `futimesat`, `utime`) where the sandbox can read
is nothing too: the read-only bind took no byte and no time. `tsc -b`
touches an up-to-date dependency's buildinfo when its sources are newer
than it (a branch switched and back, the dependency a hit, whose restore
keeps the outputs' times) and swallows the refusal; judged a write, the
dependant failed every run until `--force` (2026-11-12,
`sandbox-dependency-outputs.unsafe.test.ts`). So is a refused `open` or
`openat` of an existing file a refused timestamp change of the same path
follows: `touch` opens its file for writing first, GNU's without `-c`,
uutils' (Ubuntu 26.04) with it too, and on the refusal sets the times by
path. On macOS a seatbelt `file-write-times` denial on a path a read
grant covers is dropped the same way.

The directory is writable in full too, and a hard link reads without an
open: `ln -f README.md out.txt` beside `write: ['out.txt']` passed
unreported and cached README's bytes, replayed after README changed, and
`echo x > other.txt` wrote the host unreported. SRT's write observer
records every write-intent call there, a link's or a move's source as
well as its destination, so `refusedWrites` judges a record under the
widened directory by the grants themselves, against the listing taken as
the task started (taken whether or not strace runs). An entry that was
there and no write grant covers is reported, written, removed, moved or
linked; a link or move is reported as one (`= a link or move no grant
covers`), ignorable as a read or a write, and while its path is there
the fix names it for a read. A granted read as a link's source is the
read its grant allows. What the task made there is its own unless it
outlives the task, since an atomic writer stages beside its target and
renames; a directory it made holds nothing of its own, so only a new
one left behind is reported. A report, not a refusal: the write has
landed by then, and the task fails on it. No new traced call: the
observer already saw each write, so this costs a `lstat` per new path
left, nothing where no grant was widened.

macOS has no widened directory, and seatbelt's `file-read*` deny covers a
link's own `readlink` (SRT re-allows metadata on directories only), so an
ungranted link is refused and recorded there as any read is.

A `stat` there is not seen: the trace leaves the stat family out (above),
so a task can learn a sibling's size, times or presence unreported
(`stat -c %s README.md > out.txt`). An output that depends on such
metadata is the residual stale-hit risk of a file grant at a project's
root; grant a directory for outputs and the siblings are not in the
sandbox at all.

### A write grant cannot be removed (Linux)

A directory grant is a bind mount, and a mount point cannot be removed or
renamed: under `write: ['dist/']`, `rm -rf dist && tsc` empties `dist`,
then fails with `Read-only file system` (EBUSY under a writable parent).
macOS allows it. No bind makes it work and keeps "a task writes only its
grants": binding the parent lets the task write beside the grant. So a
failed task whose stderr names a grant root (absolute, or
relative to the cwd, `./` allowed) on a line holding `Read-only file
system`, `EROFS`, `EBUSY` or `resource busy` gets a hint naming the grant
and the removal that works, `rm -rf dist/*` (`grantRemovalHint`; X-90,
`sandbox-grant-remove.unsafe.test.ts`). The lines are kept as stderr
streams, as `GIT_NO_REPO`'s are: a run captures no output.

### git and a hidden `.git`

git finds its repository by `stat`ing `.git` up from the cwd, and the
trace leaves the stat family out, so a task denied `.git` fails with
git's own `not a git repository` and no record. A failed task whose
stderr said those words (watched as the stream goes, as strace's own
errors are, so a passing task pays one regex per stderr line) gets a
hint naming the nearest `.git` above its cwd and its grant
(`'../../.git'`), or, when that `.git` lies outside the workspace or is
a worktree's file pointing outside, saying it is walled on purpose
(`hiddenGitHint`; `sandbox-git-discovery.unsafe.test.ts`,
`sandbox-outside-git.unsafe.test.ts`).

### A write grant that mounts nothing

A bind covers what exists when the task STARTS, so a Linux write grant
whose pattern matches nothing yet binds nothing at all. Measured, one
task per spelling, each writing the files it declares:

| `allow.write` | outcome                                            |
| ------------- | -------------------------------------------------- |
| `g/**`        | ok — collapses to the directory                    |
| `g/a.txt`     | ok — a file-shaped grant, widened to its directory |
| `g/*`         | `bash: g/a.txt: Read-only file system`             |
| `g/*.txt`     | same                                               |
| `g/?.txt`     | same                                               |
| `g/[ab].txt`  | same                                               |

(`g/*` and its siblings ran with `read: ['.']`, which mounts `g`
read-only.) That is the documented contract rather than a defect, but
the failure names neither vx nor the grant, so `expandGrants` hands the
grant over as `pendingWrites`, and `pendingWriteGrants` reports it —
once per grant, before the task runs — and names the directory to grant
instead (`grantPrefix`, the directory the pattern was in, not the scan's
anchor one component above it). Both are spelled as a committed config
spells them: from the task's directory (`'*.log'`, then
`allow: { write: ['.'] }`), from `~`, or whole outside both; the
absolute path held only on the machine that printed it (B-97,
`sandbox-empty-grant-spelling.unsafe.test.ts`). Read grants are not
reported: a read matching nothing is ordinary.

Where no bind holds the glob's directory, it is the deny anchor's
scratch, the mask `readOnlyMasks` leaves writable: the task creates,
writes and removes there, and nothing it leaves outlives the sandbox
(`scratchWrites`). That is a tool's temp
directory — `bun build --compile` extracts a cross-compile runtime into
`<cwd>/.<hash>-00000000.tmp/` and moves it into its cache — and such a
grant is not reported; `refusedWrites` takes a write under it as
granted, and the strace pass a missed read under any pending glob (cp
probes its destination before creating it, which failed a clean task
until 2026-10-08). Before 2026-09-29 it was reported as a write no grant covers
and failed the task. An output never belongs there: grant its directory.
What the task leaves there (written, never removed or moved out, in the
observer's records) went with the sandbox, so `refusedWrites` reports it:
`out.log` under `*.log` with only `read: ['src/']` vanished under a green
run.

A read grant the punch split is not scratch: `read: ['.']` beside
`write: ['dist/', '*.log']` binds the project's children around `dist`,
not the project, so `*.log` lay under no bind and `out.log`, a declared
output, vanished under a green run (`['dist/', '*.tsbuildinfo']` the
same). `buildCustomConfig` binds such a glob's directory writable, as a
file grant there is widened to it (`punchedWriteGlobs`); a write there
the glob does not cover is judged as one under a widened grant
(`refusedWrites`), and `bun build --compile`'s temp directory beside
`dist/` lands on the host and is removed there.

On macOS a collapsed `<glob>/**` keeps `<glob>/**/*` beside the
directory: seatbelt reads a glob as an exact regex and a literal as a
subpath, so `.*.tmp` alone covered the directory and nothing inside it,
and SRT strips a trailing `/**` before compiling, so `<glob>/**` was the
same regex again.

A write refused OUTSIDE the project is no violation (nothing a key
reads), but it may be why the task failed: a failed task gets one note
naming those paths and the directory to grant, or, for a path under the
host's shared temp directory (`/tmp`, `/var/tmp`, `os.tmpdir()`) that no
wall holds, `$TMPDIR` instead: the task has an empty temp directory of
its own, and a grant would open the shared one to every write (#2424)
(`refusedWritesOutside`;
`/dev`, `/proc`, `/sys` and the task's own temp root left out, since
Linux's observer records every write attempt). `bun build --compile`
said only "Failed to extract executable" when its cache was not
writable.

A grant's braces are expanded first (`grantAlternatives`, both
platforms, as a task glob's are; an escaped `\{`, `\}` or `\,` in a
grant that names a path then reads as itself), so
`write: ['g/{a,b}.txt']` is two file grants, each placed, then widened to
its directory. Kept as written, `read: ['c{a,b}']` named a literal no
project holds and granted nothing. The classifier here counts only
`*?[]`, so an escaped brace stays a literal. It deliberately does NOT read
`BUN_GLOB_WILDCARDS`, `Bun.Glob`'s own set, which also counts `{}`
(nor `isLiteralPattern`, the task-glob predicate item 495 unified): doing so would move that spelling into the scan and turn a
working grant into `Read-only file system`. The two predicates answer
different questions — whether a declaration must be MATCHED against
other declarations, and whether a grant can be MOUNTED.

### macOS cannot nest

`sandbox_apply` is refused inside a sandboxed process, at any permission
level — an inner `sandbox-exec` with a `(allow default)` profile still
dies with `sandbox_apply: Operation not permitted` (exit 71, measured
2026-09-05, pinned by `tests/sandbox-grants.unsafe.test.ts`). A task that
itself sandboxes something therefore cannot be sandboxed on macOS, which
is why `@vzn/vx#test.bun.shard-*` is the one task in this repo with no
`sandbox` block. `weakerWhenNested` covers the Linux case; SRT offers no
macOS equivalent because there is none to offer.

### Network entries

`initSandbox` checks the run's domain union against SRT's own
`NetworkConfigSchema` before `initialize`, which does not: a URL or a
dotless host matched nothing, and an allowed `*` opened every host for
the run. The refusal names each entry. It is thrown past the Linux probe,
which brings the runtime up, and only an armed run resets it, so
`prepareSandbox`'s `arm()` resets the runtime on any failure; before
that the process hung after the summary (2026-10-02).

### Descriptor records

The write observer records strace's own log as `deny openat /dev/fd/5`.
`refusedWrites` resolved each record's path in vx's process, so that one
named vx's fd 5: `/dev/urandom` as a rule, but a vx started with
`5>out.log` in a single-package workspace reported a write to `out.log`
and failed a clean task. A record under `/dev/` or `/proc/` names the
task's descriptor or pseudo-file, never a place vx can resolve, and is
skipped (2026-10-02).

### Loopback

A runtime that opens a dual-stack socket reaches 127.0.0.1 as
`::ffff:127.0.0.1`, and seatbelt's only host tokens are `localhost` and
`*` — no rule can name that form. The first loopback connect is therefore
denied, the runtime retries on AF_INET and succeeds, leaving one
addressless `deny(1) network-outbound` record behind. It happens for a
task's own server under `localBinding`, and again for SRT's proxy
whenever the task declared any network at all, so under either grant the
record is dropped: no config can silence it and it carries no
information. It is not a hole — a connection that actually left the
machine goes through that proxy, which reports it WITH host and port.

That proxy record, `deny network-outbound <host>:<port> (<reason>)`,
lands in SRT's store on both platforms. On Linux vx read only the write
observer's records there, so a refused host failed a task through its
own `403` and nothing else, and passed one that survived it;
`refusedConnections` reads it now. It carries no `deny(<n>)`, so the
seatbelt classifier left it without a target and `ignore.network` could
not silence it on macOS; `describe` reads its shape first (2026-10-02).

### What a sandboxed task costs (Linux, 2026-10-02)

A sandboxed `true` costs ~28 ms in `runSandboxed` and ~35 ms per task in
`vx run --concurrency 1` (100 tasks; an unsandboxed one costs ~2 ms, a
bare spawn's floor). Measured by stripping one layer at a time from the
wrapped command, min of 20–25:

| part                                                                   | cost           | whose                                          |
| ---------------------------------------------------------------------- | -------------- | ---------------------------------------------- |
| bwrap with SRT's binds                                                 | ~6 ms (4 bare) | SRT, bwrap                                     |
| SRT's chain inside: bash three times, two socat bridges, apply-seccomp | ~6.5 ms        | SRT                                            |
| strace's own start (a bare `strace true` is 5.7 ms)                    | ~5 ms          | the denial report                              |
| SRT's per-wrap `rg`                                                    | 2.8 ms         | gone (B-75, B-92: a refused exec in its place) |
| vx's wrapper: the signal watcher, `setsid`, `sh`                       | ~1.3 ms        | vx                                             |
| vx's JS: request, wrap, parse, scheduling                              | ~3 ms          | vx                                             |

Inside `vx run` the request and the walls add binds, so `runSandboxed`
reads 28–30 ms there. What is vx's is at its floor: removing the watcher
or `setsid` saves under 0.5 ms (noise), and both are correctness
(signal forwarding, `kill 0`). A CPU profile names `rmSync` (947 ms per
100 tasks) and `realpathSync` (250 ms) as the top cost; timed in place
they are 0.4 ms and 0.23 ms a task: the profiler charges the main
thread's wait on child processes to the last native call. Time a
suspect in place before cutting it.

The wrap itself (~3 ms with B-75's `true`, 1 ms of which was that spawn, 0.3 since B-92)
is SRT's `generateFilesystemArgs` resolving each deny path (realpath,
lstat, a symlink walk) and a `mkdtemp` per wrap; vx's own share of it
is a sliver of a 400-wrap profile. What is left is SRT's to cut: one shell in place of three, and the
bridges only for a task granted network. Neither is an option today,
and dash cannot stand in for bash there (SRT's `trap "kill %1 %2"` kills
no job under dash).

### Integration points

- `src/orchestrator/run.ts` calls `prepareSandbox(nodes)`
  (`sandbox-request.ts`): null when no node declares `exec.sandbox`,
  else an armer whose `arm()` runs `probeSandbox` + `initSandbox` once,
  on the first sandboxed execution (`execute-task.ts` awaits it before
  the request), or earlier when one is sure to execute (C-76).
  `resetSandbox` runs at the end if it was armed.
- Execution goes through the placed `TaskExecutor`; the local floor
  (`exec/local-executor.ts`) calls `runSandboxed` instead of
  `runCommand` when the request carries `sandbox`. On violations
  `execute-task.ts` forces exit 1, appends violation lines to stderr,
  and surfaces the count on `TaskOutcome.sandboxViolations`.

### Why fail-on-violation?

The user-facing contract: "if your task can succeed without an
undeclared path, the sandbox is invisible; if it tries to reach one,
you find out immediately." Without fail-on-violation, a task that
tolerates `ENOENT` (e.g. probes for an optional `~/.foorc` then
proceeds without it) would silently mask a leaked dependency — the
cache would store output as if no undeclared read happened. Failing
the task surfaces the problem early so users can update their
`sandbox.allow.read` (or accept the leak by adding the path) before
shipping a build that depended on it.

### Port bridge (Linux)

A `localBinding` port LIST is bridged out of the task's network namespace
(`bwrap --unshare-net` sees no host port either way). `wrapSandboxedCommand`
prefixes the sandboxed command with `portBridgeInner`: one
`socat UNIX-LISTEN:<tmpdir>/vx-port-<tag>-<port>.sock,fork 'SYSTEM:sh <tmpdir>/vx-port-dial-<tag>.sh <port>'`
per port, backgrounded and reaped with the shell (as SRT starts its own
proxy bridges). The dial script (`PORT_DIAL_SCRIPT`, written beside the
sockets) reads the namespace's `/proc/net/tcp` and `tcp6` per
connection, before any byte moves, and dials `::1` when only `::1`
listens on the port, else 127.0.0.1: a fixed 127.0.0.1 dial refused a
server bound to `::1` alone, Vite's `localhost` on a host that resolves
`::1` first (X-91, `port-bridge-dial.test.ts`; the live `::1` row in
`sandbox-lifecycle.unsafe.test.ts` skips on a box with no IPv6). It is a
file, not inline, so the socat address holds no `:` or `,` of its own.
vx then spawns the host side, `portBridgeHostArgv`: one
`socat TCP-LISTEN:<port>,bind=127.0.0.1,fork UNIX-CONNECT:<sock>,retry=…`
per port, socat resolved on vx's PATH. The task starts once each host
socat listens (`/proc/net/tcp`, 5 s bound, skipped where /proc is not
vx's, ended by a bridge that exited): a server that said it was ready
inside could meet a refusal on the host first (M-22). That table cannot
tell the bridge from another listener: a port the host already held
counted as the bridge's, whose own bind failed unseen, so the task passed
and a client of the port reached the other process. `portsHeld` reads the
table first and the wrap refuses such a port by name (2026-10-03,
`sandbox-port-held.unsafe.test.ts`). Two tasks of one run granted the
same port both read that table before either bridge bound, so the
second passed the same way; the wrap now claims its ports in `hostBridges`
before it awaits and refuses a port another live wrap of this process
claims (2026-10-08). The unix socket lives in the sandbox tmpdir, bound read-write on
both sides. The task's side has to CREATE a unix socket under SRT's seccomp
filter, so `prepareSandbox` passes `allowAllUnixSockets` when any task
declares a port list (or `unixSockets`), and `wrapSandboxedCommand` then
sets SRT's lift for each task's own wrap, one wrap at a time: SRT reads it
from its run-wide config, and a run-wide lift let a task that declared no
socket reach the host's docker or ssh-agent socket (L-6). `releaseBridges(tag)`
stops the host side: `runSandboxed` calls it after the child exits (and
when the spawn itself fails), the persistent path on the server's exit,
`resetSandbox` for whatever is left. Each host socat is spawned through
`spawnGuarded`, in a group of its own, and its group is SIGTERMed and
struck from the guard's list once it has exited (`exec.md`): a plain
child of vx was in no group the guard lists, and a `kill -9` of vx left it
listening under init, where the next run's bridge could not bind the port
(item 873, `sandbox-lifecycle.unsafe.test.ts` › "a kill -9 of vx takes the
host side of a port bridge with it"). The runtime's own network bridge, a
socat SRT spawns in vx's group, is listed by pid with its sockets and
the observer directory when `initSandbox` brings a session up, and struck
when the reset finishes (`guardSession`, `exec.md`;
`sandbox-session-guard.unsafe.test.ts`).

A loopback port a task's `network` list names (`localhost:4173`) is
relayed the other way, into the task's namespace: a client there dials
its own empty loopback, and the proxy that serves `allow.network` is
skipped for loopback by `NO_PROXY` and by every browser, so a sandboxed
e2e was refused by a server its dependency ran whatever it granted
(2026-11-12). In front of the command, one
`socat TCP4-LISTEN:<port>,bind=127.0.0.1,fork UNIX-CONNECT:<tmpdir>/vx-reach-<tag>-<port>.sock,retry=…`
per port (and one on `[::1]` where the host has IPv6), then a wait
until each listens; on the host, one
`socat UNIX-LISTEN:<sock>,fork 'SYSTEM:sh <dial script> <port>'`, so a
server on `::1` alone is reached as through a port bridge. Both sides
are a port bridge's: spawned guarded, released and unlinked with it,
and the unix-socket lift is set for the task's wrap. A port the task
also bridges out (`localBinding: [p]`) is its own and not relayed. On
macOS the profile allows `(remote ip "localhost:<port>")` for each
(`macProfileRules`), and the lookup of configd, which curl makes for
the proxy settings before it dials: refused, its record failed a client
that had its answer. `sandbox-loopback-reach.unsafe.test.ts` holds a
sandboxed client reaching an unsandboxed server and one behind a port
bridge, and refused with no grant or another port's.

A failed Linux task whose output's tail says a loopback port refused it
(`ECONNREFUSED 127.0.0.1:<port>`, `ERR_CONNECTION_REFUSED at
http://localhost:<port>/`, curl's `localhost port <port>: Couldn't
connect` or, since 8.7, `Could not connect`, `[::1]:<port>`) gets a hint naming the grant
(`refusedLoopbackHint`) when the host listens on that port, on loopback
or every address (`/proc/net/tcp`, `tcp6`), and the task neither grants
nor binds it. Before, it got a bare refusal and no word of vx
(`sandbox-loopback-hint.unsafe.test.ts`).

`releaseBridges` also unlinks each port's socket. The task's socat dies
with the namespace and never removes it, so every bridged run left one
socket in the tmpdir (176 on one box, item 877). The sockets are listed
with the exit hook that removes strace logs, so a Ctrl-C mid-task takes
them too (`sandbox-bridge-socket.unsafe.test.ts`).

A persistent task's sandbox outlives its run. `wrapSandboxedCommand`
takes `server: true` from the persistent path and lists the tag as a
live server. `resetSandbox`, which every run calls at its end, releases
only the bridges no live server owns, and while one runs it defers SRT's
reset. That server's `releaseBridges`, on its exit, runs the deferred
reset, and hands SRT the server's `cleanupAfterCommand`: SRT removes
bwrap's empty host stubs (`.bashrc`, `.vscode`, … under a write grant)
only once every wrap has made that call, and a stopped server's never
came, so every later task left its stubs in the workspace. Before item
882, a foreground `vx run dev` or a `vx watch` held a
server past a reset that had already released its port and SRT's
proxies, and the port went dark ~40 ms after the summary.

That deferred reset runs unawaited from the server's exit, and a watch
cycle stops its server and starts its next run at once. `initSandbox`
therefore waits for a reset in flight: an init under it found SRT up,
hot-reloaded it, and had it torn down after (item 884).
An init also takes the session over: it cancels a reset an earlier run
deferred, so that run's last server, released later, no longer tears SRT
down under this run's tasks; this run's own end resets it (M-25).
SRT's first `initialize` registers its own once-only `exit`, SIGINT and
SIGTERM listeners, each an unawaited `reset()` that kills the bridges at
once and clears SRT's init promise only after its proxies close. vx
takes those listeners over at that init: each still runs SRT's reset,
once, but as a reset `initSandbox` waits for, so an init under it no
longer returns early on the dying session ("Linux HTTP bridge socket
does not exist", M-35).
A SIGINT or SIGTERM during `initialize` ran that reset before the
session existed: it found no bridge, the start then made one, and the
socat outlived vx for good (an early Ctrl-C, 9 of 20 tries). `initSandbox`
listens for both while it starts, and after a signal resets what the
start finished (`sandbox-session-guard.unsafe.test.ts`).
Pinned in the unsafe suite on Linux: a sandboxed server on a listed port
answers a downstream task's fetch and the host's, and after the run the
port is closed; the control with `localBinding: true` is refused.

macOS has no network namespace to bridge out of: `localBinding`, a list
or `true`, lets the task bind any loopback port and reach any, the
host's own services included (`macProfileRules`). Narrowing a list to its
ports would refuse the ephemeral port a task's own test server binds,
which Linux allows inside the namespace, so the list stays wide there:
on macOS a task under `localBinding` can read a local service vx does
not key on (B-13).

## `src/exec/executor.ts` — the per-task execution contract

### Purpose

The seam between "what to run" and "where it runs". `execute-task.ts`
resolves everything about one attempt — command, cwd, env, capture,
timeout, sandbox baselines — into an `ExecuteRequest`; a `TaskExecutor`
runs it and returns an `ExecuteResult` (exit code, streams, rusage,
sandbox violations). Core's own executor, `localExecutor`, is the same
`runCommand` / `runSandboxed` call the orchestrator used to make directly — it lives in `src/exec/local-executor.ts` and is appended to the TAIL of every executor list (`resolveExecutors`, plugin-host.ts), so a task every plugin declines runs here.

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
- `localExecutor()` — the floor at the tail of every executor list.
  Runs the command on this machine; what a plugin declining a task
  hands it back to. A request whose `signal` is already aborted (a stop
  that landed during the output clean) spawns nothing and returns the
  signal's exit: the command ran after the teardown had swept the run's
  children, and a Ctrl-C took 7.6 s (B-55). A sandboxed request asks
  again after its own awaits (the runtime, the tracer probe, the wrap),
  just before the spawn: a stop landing there ran the task (B-72). Internal (`src/exec/local-executor.ts`), not on
  `@vzn/vx`.
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
- `isLocalExecutor(executor)` — whether it is core's own, by identity (a
  plugin may name its executor 'local'): core bounds a plugin's
  `execute` after the request's abort, never the local one's (H-14).
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
  host. Rides `TaskOutcome.where` into telemetry (OTel:
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
