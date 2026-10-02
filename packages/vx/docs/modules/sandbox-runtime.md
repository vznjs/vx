# `src/exec/sandbox-runtime.ts` — sandbox wrapper for per-task isolation

## Purpose

Thin wrapper around `@anthropic-ai/sandbox-runtime` (SRT) for running a
single task inside a filesystem + network sandbox with strict isolation.
Used by `executeCachedTask` when the task's config declares
`exec.sandbox`.

Policy: **fail on violation, no cache for failed tasks.** The sandbox
enforces the declared grants at the kernel level; a task that reads
outside them is denied (bwrap on Linux, seatbelt on macOS), the denial
is reported (an strace pass on Linux, the unified log on macOS), and a
reported violation inside the project forces a non-zero exit.
`cache.save` only fires when the task succeeded AND no violation was
reported.

## Files

`sandbox-runtime.ts` keeps the lifecycle (`probeSandbox`, `initSandbox`,
`resetSandbox`), the config resolution (`resolveSandboxConfig`) and the
spawn (`runSandboxed`, `wrapSandboxedCommand`, the macOS profile rules).
Three companions hold the rest, split 2026-09-09 as pure code motion:

- `sandbox-violations.ts` — the Linux strace pass (`deniedCalls`,
  `parseStraceViolations`), the seatbelt record description, and the
  report filters (`reportableViolations`: inside the project or a
  withheld linked package, minus loopback noise, minus the task's
  `ignore`).
- `sandbox-binds.ts` — write grants as bwrap can honour them
  (`bindableWrites`), read grants punched around the write grants
  inside them (`punchWritePaths`), and the SRT custom config.
- `sandbox-paths.ts` — `toRealPath`, `absolutize`, `atOrUnder`,
  `isUnderAny`, `sandboxReads`, `unique`.
- `sandbox-deny-scan.ts` — `scopedMandatoryDenies`: SRT's mandatory
  write denies (`.bashrc`, `.mcp.json`, `.vscode/`, `.git/hooks`, …),
  found within each task's write grants instead of the whole root.

### The mandatory-deny scan, scoped (B-40)

On every wrap SRT walked `process.cwd()`, the workspace root, with
`rg --max-depth 3` for names a task must not write, and kept a hit only
inside an allowed write path (the rest is read-only under `--ro-bind /
/` already). On 1,090 packages that walk was half of a sandboxed run's
wall time (25.4 s → 14.7 s once scoped; interleaved, min of 3). vx now
starts SRT with `mandatoryDenySearchDepth: 1`, so SRT lists only the
root's entries, and each wrap adds the denies `scopedMandatoryDenies`
finds under the task's write grants (SRT's default write paths
included) to `denyWrite`. A deny is the hit or one of its ancestors, so
every hit that counts lies under a write path. It runs per task and is
never cached: it decides refusals. It is stricter than rg: it does not
read `.gitignore`, walks into `node_modules` and counts a symlink by its
name, so such a file inside a write grant is refused where rg missed it.
A deny whose path holds a glob character would be dropped by SRT on
Linux, so the task is refused instead, and a root with one keeps SRT's
own depth-3 scan. `sandbox-deny-scan.unsafe.test.ts` holds the binds
equal to SRT's whole-root scan for three grant sets.

`allow.gitConfig` is read by SRT from the run's config only, so a run
with a task that grants it sets `allowGitConfig` per wrap, one wrap at a
time, as it does the unix-socket lift, and the scoped scan leaves that
task's `.git/config` hits out (B-41). Before, the flag vx passed per task
was never read and `.git/config` stayed read-only to every task.

## User-facing config

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
  },
}
```

Paths resolve relative to the project directory, are used as-is when
absolute, and expand `~` against the user's home. Globs are accepted:
macOS passes the pattern into the policy (so it matches files created
during the run); Linux expands it at task start, because a grant there is
a mount. `<dir>/**` and `<dir>/**/*` collapse to `<dir>` on both, so
`read: ['**/*']` lets a task list its own cwd.

There is **no inheritance** from `vx.workspace.ts`, and nothing is
derived from `cache`. The single grant core makes is dependencies:
`node_modules` for the project and the workspace root, plus the real path
of every workspace package symlinked into them — a project never names a
sibling to import what its `package.json` depends on. A link back to the
task's own project, or to a directory holding it, is dropped (compared
canonically): npm and Yarn link every package at the root, and following
that link re-granted the whole project past its `allow.read`.

### What SRT's config cannot carry

`localBinding`, `unixSockets`, `machLookup` and `systemInfo` do not reach
SRT as config, and neither does a `network` domain list. The first three exist as fields, but `sandbox-manager.js`
(0.0.75, still 0.0.76) reads them off the config given to `initialize()` and never off
the per-call one, so a per-task grant is silently dropped; `systemInfo`
has no field at any level. vx is per-task by definition, so it appends
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
still reaches the union. `deniedDomains` is the union of every task's
`deny.network` (`sandboxRunUnion`), refused to every task; it was always
empty, and a deny refused nothing, until B-21 (schema.md §
`exec.sandbox`). Per-task filtering is out of reach: SRT's filter hears a
host and port, and the command's name rides in the proxy username, which
the sandboxed process writes, so one task could claim another's list.

## Public surface

```ts
export interface SandboxAvailability {
  available: boolean
  reason: string // empty when available
}

export function probeSandbox(opts?: { weakerNested?: boolean }): Promise<SandboxAvailability>
export function initSandbox(opts?: {
  allowedDomains?: readonly string[] // the run's union
  deniedDomains?: readonly string[] // every task's deny.network, refused to all (B-21)
  allowAllUnixSockets?: boolean // some task asks; the lift is set per task's wrap
}): Promise<void>
export function resetSandbox(): Promise<void>
// why sandboxed tasks run untraced (no working strace), or null; `vx info` says it
export function untracedReason(): Promise<string | null>

export interface ResolvedSandboxConfig {
  /* same shape as SandboxConfig, paths absolute */
}
export function resolveSandboxConfig(cfg: SandboxConfig, projectDir: string): ResolvedSandboxConfig
// scratchWrites judged, the mountless reported once each; the scratch returned
export function pendingWriteGrants(config, fs, anchors): string[]

export interface SandboxedRunArgs {
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  forwardArgs?: readonly string[]
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  liveChildren?: Set<ReturnType<typeof Bun.spawn>>
  signal?: AbortSignal // ExecuteRequest.signal: once aborted, no tracer retry (B-36)
  timeoutMs?: number
  capture?: CaptureConfig
  baseAllowRead: readonly string[] // node_modules + resolved workspace links
  baseDenyRead: readonly string[] // [workspaceRoot] — the task may not leave its project
  reportWithin: string // projectDir — only denials in here are worth reporting
  reportLinked: readonly string[] // withheld linked packages (canonical) — reported too
  config: ResolvedSandboxConfig // its allowWrite is the whole write set: none is derived
}

export interface SandboxViolation {
  line: string
  timestamp: Date
  target?: string
  hint?: true // vx's own note, shown but never counted (B-20)
  path?: string
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
// dependencies, a temp dir too long for the socket path.
export function unavailableReason(exitCode: number | null, stderr: string): string
export function dependencyReason(errors: readonly string[]): string
export function socketPathRefusal(tmpdir?: string): string | undefined

// The port bridge (Linux; § Port bridge)
export function bridgedPorts(c: Pick<ResolvedSandboxConfig, 'localBinding'>): number[]
export function portBridgeSocket(tag: string, port: number): string
export function portBridgeInner(ports: readonly number[], tag: string): string
export function portBridgeHostArgv(tag: string, port: number): string[]

// macOS: the per-task seatbelt rules vx emits, and a path refused, never escaped
export function macProfileRules(c: ResolvedSandboxConfig): string[]
export function sbplResolvedPath(value: string, field: string): string

// sandbox-paths.ts: the wildcard alphabet of a GRANT. Smaller than
// util/paths.ts's BUN_GLOB_WILDCARDS on purpose — `{}` is a literal to a
// grant (a brace grant gets a placeholder and is widened to its
// directory; scanned, it matches nothing before the task writes). The
// request builder reads it to decide whether an output grant is a glob.
export const MOUNT_WILDCARDS: RegExp
export function isMountableLiteral(grant: string): boolean
// A path with its existing prefix realpath'd and the rest re-appended.
export function toRealPath(p: string): string
export function absolutize(p: string, cwd?: string): string
// `p` is `dir` or below it, by path (a name-prefix sibling is not): the
// one copy of the check the sandbox code makes.
export function atOrUnder(p: string, dir: string): boolean
export function isUnderAny(abs: string, allow: Set<string>): boolean
// Whether a sandboxed task may read a file: a read, write or baseline
// grant at or above its canonical path (the shell verdict asks it).
export function sandboxReads(sandbox: ExecuteSandbox, file: string): boolean
export function unique(arr: readonly string[]): string[]
export function localBindingOn(c: { localBinding?: boolean | readonly number[] }): boolean

// sandbox-binds.ts: the binds a write grant becomes on Linux (a file grant
// widened to its directory), and a read grant cut around the walls a
// project stops at (item 1010). The request builder refuses a write bind
// that would hold a wall and punches the read grants.
export function bindableWrites(paths: readonly string[]): string[]
export function punchWalls(readPath: string, walls: readonly string[]): string[]
export function punchWritePaths(readPath: string, writePaths: readonly string[]): string[]
// The write globs that matched nothing at the start, split by whether a
// bind holds their directory (below, "A write grant that mounts nothing")
export function scratchWrites(pending, fs, anchors): { scratch: string[]; mountless: string[] }
// The SRT customConfig: the baselines merged with the resolved block
export function buildCustomConfig(args, baselines): SrtCustomConfig

// sandbox-violations.ts: what a trace or a seatbelt log reports
export interface DeniedCall {
  syscall: string
  rawPath: string
  errno: string
}
export function deniedCalls(text: string): DeniedCall[] // strace lines, split calls paired
export function parseStraceViolations(logPath, args, baselines): Promise<SandboxViolation[]>
export function reportableViolations(
  violations: readonly SandboxViolation[],
  opts: { within: string; linked?: readonly string[]; config: ResolvedSandboxConfig },
): SandboxViolation[]
export function refusedWrites(
  records: readonly string[],
  writable: readonly string[],
  scratch?: readonly string[], // pending write globs a write may land under
): SandboxViolation[]
// the writes refused past the wall, as paths: a failed task's hint
export function refusedWritesOutside(violations, opts: { within; linked?; config; skip }): string[]
```

## How it works

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
   Linux and 104 on macOS): past it the runtime said ENAMETOOLONG on
   macOS and "Failed to create bridge sockets after 5 attempts" on
   Linux, neither naming the directory; the verdict now gives the path,
   its length, the limit and "point TMPDIR at a shorter path".
2. **`initSandbox`** is called at most once per `vx run`, lazily: the
   first sandboxed execution arms the run's `prepareSandbox` armer
   (sandbox-request.md), which probes and then inits. It calls `SandboxManager.initialize`
   with a deny-all baseline (network blocked, no filesystem allows);
   per-task wrapping overrides those defaults.
3. **`runSandboxed`** is called once per sandboxed task:
   - Prepends a unique `: 'vx-<hash>';` shell no-op to the command so
     SRT's `getViolationsForCommand` can disambiguate concurrent tasks
     with identical commands (it keys by base64 of the first 100 chars).
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
     `runner.ts:runCommand`, except that on Linux it reports no CPU and
     no peak: what bwrap's pid namespace used never reaches vx's wait (a
     500 ms busy loop read 2 ms), and the peak read was vx's own mark
     (B-3).
   - After `proc.exited`, reads back any violations from the macOS
     log monitor (macOS only — see the Linux row below for why the
     store's Linux feed is ignored) AND (on Linux) from the strace log
     the spawn wrote,
     then calls `SandboxManager.cleanupAfterCommand()`.
   - On Linux, an attempt whose stderr holds a line of strace's own
     (strace names itself by its argv[0], `/usr/bin/strace: …`) is run
     once more unless it timed out or the run is stopping: the trace
     stopped short, and under `--seccomp-bpf` (which implies
     `--kill-on-exit`) a dying strace SIGKILLs the task (exit 137; M-18).
4. **Filtering.** Enforcement anchors at the workspace root, but only
   denials on a path inside `reportWithin` (the project) or one of
   `reportLinked` (the linked packages a cached task was denied because
   its key does not answer for them) are reported — every process walks
   from `/` down to its own cwd, and being stopped at the wall is the
   sandbox working. A record with no path (a `system-info` probe) is
   kept. The task's `ignore` patterns are applied last: each list
   silences the operations of its kind, a pattern matching a record's
   target exactly or as a glob. A relative pattern anchors at the
   project, a `~` one at the home directory (kept as written, it matched
   no recorded path, B-13), and a pattern's literal head is canonicalized as the
   records are, so a project reached through a link (macOS's `/var`)
   is silenced where it lands (B-2).
5. **`resetSandbox`** tears down SRT's proxy servers + (on macOS) the
   log monitor at the end of `vx run`.

## Platform behaviour

| Platform | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | sandbox-exec + Seatbelt. Structured violations land in `SandboxViolationStore` via the system log monitor; we force exit 1 when any are recorded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Linux    | bwrap mount namespaces. Denied paths are structurally invisible → child sees `ENOENT`. The command runs under `strace -DD -f --seccomp-bpf -e trace=openat,chdir,fchdir,clone,…` INSIDE the sandbox and the trace is parsed for denials against the task's own baselines, each relative path resolved against the cwd its process had (`chdir` followed per process, a child starting in its parent's; B-61) (`--seccomp-bpf` keeps the ptrace stops to the traced calls; without it every syscall stopped and a stat-heavy task ran many times slower — the cache perf baselines failed on the Linux job for that reason until 2026-09-09; strace < 5.3 gets the slow form). Inside, strace follows the command alone: wrapped around bwrap it followed the namespace's setup too, and a sandboxed `true` cost 41 ms against 30 (min of 40, A/B interleaved, A/A within 2 ms; B-11). It writes to the host's log through fd 5, which the command's shell closes first. It is started from a fresh fork of the shell, with SIGINT and SIGQUIT put back (an async list starts with them ignored, and a task's `trap … INT` would never fire), because `-DD`'s process waits for ANY child to hear the tracer attached: an inherited one that exited first (the watcher, SRT's network bridges) sent the command on untraced, and its `execve` failed `ENOSYS` under the seccomp filter. `-DD` puts strace off the command's line, so a `sleep 10 &` the command leaves is not a tracee strace waits for; the namespace ends with the command and takes strace along, and a tracee stops at each `openat` until its line is written, so none is lost. SRT ≥ 0.0.75 also feeds its store on Linux from the seccomp helper's write observer, but judges those reports against the GLOBAL `allowWrite` from `initialize` (empty; the per-task list is in `customConfig`, which the monitor never sees), so every declared-output write arrives as `deny openat <output>`; vx judges those records against the task's own binds (`refusedWrites`, the write grants as bwrap binds them), and what no bind covers is a violation. strace never sees a write: the observer's USER_NOTIF takes precedence over strace's TRACE, so a refused write (`EROFS` under a read-only bind) or one into the anchor's scratch went unreported and a task that swallowed it exited 0 (B-5). The store is a 100-record ring shared by the run, so vx subscribes once and keeps each record for a command still running (`collectRecords`): read at exit, a refused write followed by 150 declared ones was already gone (B-7). |
| Windows  | Not supported by SRT. `probeSandbox` reports unavailable; declaring `exec.sandbox` triggers a UserError before the run starts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

`wrapSandboxedCommand` is the enforcement half on its own — the tagged command under SRT's wrapper, vx's seatbelt rules appended on macOS — and the persistent path spawns through it (`executePersistentTask`): a dev server declaring `exec.sandbox` gets the same walls and no violation report, since the report reads the trace after exit.

On Linux the command runs in a session, and so a process group, of its own inside the sandbox: `: 'vx-<tag>'; { read -r s <&3 && kill -s "$s" -- -$$; } & exec setsid sh -c '<command>' 3<&-`, both tools resolved on vx's own PATH. `sh`, the shell an unsandboxed task runs: it was `bash`, and brace expansion, `[[ … ]]` and `echo 'a\tb'` read one way with the block and another without it where `/bin/sh` is dash (item 964). bwrap's `--new-session` puts the runtime's shells (the proxy bridges' script, the seccomp step's) in one group with the command, and `kill 0` reaches a group's members across the nested pid namespace, so a command that signalled its own group ended the runtime's shell: bwrap exited 143 and the namespace's teardown SIGKILLed the rest mid-trap (item 751). The shell `exec`s `setsid`, which is no group leader there, so it execs without a fork and the command keeps the shell's pid: an exit status and a signal death (137) are the command's, as before. The cost is a `setsid` exec and a second shell, about 3 ms on a 35 ms sandboxed `true` (min of 15, three interleaved pairs). A cancellation reaches the command the same way (item 752): vx's group signal would end bwrap's monitor, and `--die-with-parent` SIGKILLs the namespace, so a `trap … TERM` never ran. The watcher forked before the `exec` reads a signal's name off fd 3, which vx writes for SIGINT and SIGTERM (`signalThrough`, `kill-tree.md`), and signals the command's group, `$$`; SIGKILL at the grace's end still goes to bwrap's group. The command runs in the foreground because an `&` command starts with SIGINT ignored, which a shell cannot trap; it does not get fd 3. `wrapSandboxedCommand` says so in `forwardsSignals`, and both spawns (`runSandboxed`, and `runPersistent` with `signalChannel`) pass fd 3 when it is set.

On Linux the wrapped command is `exec /abs/bwrap …`: SRT wrote a bare `bwrap` into a command the task's shell runs with the TASK's environment, so a dependency's `node_modules/.bin/bwrap` ran in its place and the task ran unsandboxed, exit 0; `initSandbox` now hands SRT vx's own paths for `bwrap` and `socat` (B-19). the spawn's shell execs bwrap, so bwrap is vx's own child and its `--die-with-parent` fires when vx dies, a `kill -9` included. The pid namespace then takes every descendant, one that called `setsid` too. Behind a shell that waited on it, bwrap's parent was that shell, which outlived vx, and a sandboxed server's whole tree ran on under init (turborepo#9666; item 801, `sandbox-runtime.unsafe.test.ts` › "a sandboxed server’s backgrounded and setsid children die with vx"). A one-shot task traced for violations is the same `exec bwrap …`: its strace runs inside (B-11). A persistent task is never traced. strace failing on its own (a stderr line of its own, `strace: …`) ends only the attempt: the task runs once more, with a line saying why, and the second attempt is its verdict — unless the run is stopping (`ExecuteRequest.signal` aborted): its kill already took the children it held, and a retry would be spawned after it (B-36). Its exit is no longer the task's — a tracer that dies leaves the command running untraced — so the line, not the exit, is the sign: the trace stopped short, and a denial after it would go unreported. Inside, the tracer shares the task's pid namespace and uid, so a task can end it or reach its log through `/proc`: the violation REPORT is at the task's mercy, as it never is for enforcement, which is bwrap's mounts. The sandbox kept the first attempt's writes to what it declared, so the second redoes rather than doubles them (STATUS Next 24, `sandbox-tracer-retry.unsafe.test.ts`). The trace log is the task's own file beside the task directories (L-25), removed once it is read; a second signal's exit (`process.exit`) never reaches that read, so the process's `exit` event removes every log still listed (item 848, `sandbox-runtime.unsafe.test.ts` › "a second signal exit leaves no strace log behind"). A first signal lets the run end and read the log itself (item 849).

A write grant under a directory with SYMLINKED entries (Bun's isolated `node_modules` layout: every package is a link into `.bun/`) punches the read grant into that directory's children, and bwrap mounts a linked child as the directory it points at — inside the sandbox the link is gone and a package resolved through it cannot see the `.bun/` siblings its own dependencies live in (`Cannot find package 'yargs-parser'`, the docs build, 2026-09-05 → 09-09). `punchWritePaths` warns naming the grant; the fix is to keep writable caches out of `node_modules` (astro's `cacheDir`, vite's `cacheDir`), since SRT's config has no `--symlink`.

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
(B-61). A path is
strace's C string, decoded: read raw, `q"t.txt` was cut at `q\` and
`é.txt` named `\303\251.txt`, so the report and every `ignore` pattern
missed the file (B-54). Without `strace`
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

bwrap enters the task's cwd only if a mount holds it, and otherwise
`$HOME`, with no word: a project granted no read (`sandbox: {}`, its own
`node_modules` absent) ran in the home directory, where `cat x.txt` read
`~/x.txt` and a `mkdir dist` met `Read-only file system`. On Linux, when
no grant holds the cwd (`cwdMounted`: one at or above it, or an existing
one below it), vx denies the cwd too: the task
enters an empty directory, its reads there are refused and reported, and
its writes are the scratch the write observer reports (B-53).

SRT reads any Linux read path holding `[` as a glob, where a bracket
opens a class. By the time vx hands the policy over, every grant is a
path, so it spells each `[` in a read or deny path as `[[]`, a class of
one bracket (`literalReadPaths`): a route granted as
`pages/\[id\].tsx` matched and was never mounted (its denial unreported,
a listed grant), and a workspace under a bracketed directory was never
walled (B-57).

SRT drops every Linux write path holding a bracket (it reads one as a
glob), with no spelling that keeps it, so `bindableWrites` drops it
first and says so once, naming the directory above it: left in, the read
grants were punched around a bind that never came, the directory
vanished from the task's view ("Directory nonexistent"), and the refused
write went unreported, judged against the grant (B-59).

SRT's in-sandbox network bridge is `socat TCP-LISTEN:3128` (and 1080),
which socat 1.8 opens as an IPv6 socket. On a host without IPv6 it
failed ("Address family not supported by protocol") into /dev/null, and
every networked task met only a refused connection on the proxy. There
the wrapped command sets `SOCAT_DEFAULT_LISTEN_IP=4`, socat's own switch
for the listen family (`hostHasIpv6`: `/proc/net/if_inet6`, asked once);
a host with IPv6 is untouched (B-22).

`initSandbox` names the JVM proxy agent SRT ships (`javaAgentJarPath`,
`bundledJavaAgent`). SRT's own search builds its candidate list with
`npm root -g` in it before trying the bundled path, so every init
spawned npm, about 110 ms of `vx info` and of a run's first sandboxed
task. Where the jar is not on disk (a compiled vx), SRT searches as
before (B-25).

## A task's temp directory

SRT points every sandboxed task's `TMPDIR` at one host directory
(`CLAUDE_CODE_TMPDIR`, else `/tmp/claude`), bound read-write and kept
across runs. A file one task wrote there was the next task's, and the
next run's, undeclared input: a cached reader replayed the first value it
saw after the writer changed it (item 965). Each task now gets its own,
`vx-tasks/vx-task-<pid>-<tag>` under it, exported as `TMPDIR` after the command's
tag (SRT keys violations by the first 100 characters), created before the
spawn and removed with the task's bridges at its end, or at exit. A
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

## The environment SRT sets

With the network restricted, SRT sets its own values over the ones vx
built for the task: `SANDBOX_RUNTIME`, `TMPDIR` (above), the proxy
variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `GRPC_PROXY`,
`FTP_PROXY`, `NO_PROXY` and their lowercase forms, `RSYNC_PROXY`,
`DOCKER_HTTP(S)_PROXY`, `CLOUDSDK_PROXY_*`,
`CLAUDE_CODE_HOST_*_PROXY_PORT`), `GIT_SSH_COMMAND`,
`GIT_CONFIG_PARAMETERS`, `JAVA_TOOL_OPTIONS` (below), and the CA-bundle variables when it has a CA
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

## Path canonicalization

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

A GLOB grant is expanded on Linux to its hits, each bound, and bwrap binds
a link by its target: `read: ['*']` over `shared -> ../b/src` bound
project b readable where `read: ['.']` did not, and a cached task
replayed b's old bytes (item 1006). A hit whose real path leaves the
directory holding the pattern's first wildcard is now dropped, so a glob
reaches no further through a link than the directory grant would. The
baseline `node_modules` reads are granted apart and are unaffected.

## The walls a project stops at

The key of a project excludes the projects nested in it, and the deny
anchor is the workspace root, which is a ROOT project's own directory: its
`read: ['.']` bound every nested project, `.git` and `.vx` readable, and a
cached root task replayed a nested file's old bytes; a file grant there
(`write: ['out.txt']`) is widened to its directory, which bound the whole
workspace writable, `.git` included (item 1010). The request now carries
the node's nested project directories, and with the root's `.git`, `.vx`
and the run's cache directory when it lies in the workspace (a `cacheDir`
inside a project was writable to a task granted it, L-24) they are walls: on Linux a read grant containing one is punched
around it (`punchWalls`, the write-path punch with the wall dropped), on
macOS each wall is a read deny, which SRT emits after a literal grant
holding it so that the deny wins (B-4), and
a write grant whose bind, widened or not, would hold one is refused,
naming the wall. A grant that names a wall or a path inside it is the
user's on purpose and stays, as does a bind outside the workspace (`/tmp`,
`~`). A glob's hit that is a wall or lies inside one was matched, not
named, and is dropped before the bind (`resolveSandboxConfig` takes the
walls): `read: ['*']` in a root project binds neither `.git` nor `.vx`,
`packages/*` no nested project, and `write: ['.*']` is refused for no wall
(B-1). Seatbelt matches a glob as a path regex, with no hit to drop, and
SRT re-emits a wall's deny after the allows only under a literal grant:
a root project's `read: ['**/*.txt']` read nested projects and `.git` on
macOS. Each wall a glob grant reaches (one at or under the glob's literal
head) is denied at the profile's tail, reads as `file-read-data` like
SRT's own wall denies, writes as `file-write*`, with a literal grant at
or inside the wall carved out, a baseline's included (`darwinWallRules`,
B-12). A custom `cacheDir` inside a project is not a wall.

## A write grant that names a file

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

## A write grant that mounts nothing

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
anchor one component above it). Read grants are not reported: a read
matching nothing is ordinary.

Where no bind holds the glob's directory, it is the deny anchor's
scratch: the task creates, writes and removes there, and nothing it
leaves outlives the sandbox (`scratchWrites`). That is a tool's temp
directory — `bun build --compile` extracts a cross-compile runtime into
`<cwd>/.<hash>-00000000.tmp/` and moves it into its cache — and such a
grant is not reported; `refusedWrites` takes a write under it as
granted. Before 2026-09-29 it was reported as a write no grant covers
and failed the task. An output never belongs there: grant its directory.

On macOS a collapsed `<glob>/**` keeps `<glob>/**/*` beside the
directory: seatbelt reads a glob as an exact regex and a literal as a
subpath, so `.*.tmp` alone covered the directory and nothing inside it,
and SRT strips a trailing `/**` before compiling, so `<glob>/**` was the
same regex again.

A write refused OUTSIDE the project is no violation (nothing a key
reads), but it may be why the task failed: a failed task gets one note
naming those paths and the directory to grant (`refusedWritesOutside`;
`/dev`, `/proc`, `/sys` and the task's own temp root left out, since
Linux's observer records every write attempt). `bun build --compile`
said only "Failed to extract executable" when its cache was not
writable.

`write: ['g/{a,b}.txt']` is ok, because the classifier here counts only
`*?[]` and a brace-spelled grant is therefore treated as a file — placed,
then widened to its directory. It deliberately does NOT read
`BUN_GLOB_WILDCARDS`, `Bun.Glob`'s own set, which also counts `{}`
(nor `isLiteralPattern`, the task-glob predicate item 495 unified, where
a bracket is literal since item 667): doing so would move that spelling into the scan and turn a
working grant into `Read-only file system`. The two predicates answer
different questions — whether a declaration must be MATCHED against
other declarations, and whether a grant can be MOUNTED.

## macOS cannot nest

`sandbox_apply` is refused inside a sandboxed process, at any permission
level — an inner `sandbox-exec` with a `(allow default)` profile still
dies with `sandbox_apply: Operation not permitted` (exit 71, measured
2026-09-05, pinned by `tests/sandbox-runtime.unsafe.test.ts`). A task that
itself sandboxes something therefore cannot be sandboxed on macOS, which
is why `@vzn/vx#test.bun.shard-*` is the one task in this repo with no
`sandbox` block. `weakerWhenNested` covers the Linux case; SRT offers no
macOS equivalent because there is none to offer.

## Loopback

A runtime that opens a dual-stack socket reaches 127.0.0.1 as
::ffff:127.0.0.1, and seatbelt's only host tokens are `localhost` and
`*` — no rule can name that form. The first loopback connect is therefore
denied, the runtime retries on AF_INET and succeeds, leaving one
addressless `deny(1) network-outbound` record behind. It happens for a
task's own server under `localBinding`, and again for SRT's proxy
whenever the task declared any network at all, so under either grant the
record is dropped: no config can silence it and it carries no
information. It is not a hole — a connection that actually left the
machine goes through that proxy, which reports it WITH host and port.

## Integration points

- `src/orchestrator/run.ts` calls `prepareSandbox(nodes)`
  (`sandbox-request.ts`): null when no node declares `exec.sandbox`,
  else an armer whose `arm()` runs `probeSandbox` + `initSandbox` once,
  on the first sandboxed execution (`execute-task.ts` awaits it before
  the request). `resetSandbox` runs at the end if it was armed.
- Execution goes through the placed `TaskExecutor`; the local floor
  (`exec/local-executor.ts`) calls `runSandboxed` instead of
  `runCommand` when the request carries `sandbox`. On violations
  `execute-task.ts` forces exit 1, appends violation lines to stderr,
  and surfaces the count on `TaskOutcome.sandboxViolations`.

## Why fail-on-violation?

The user-facing contract: "if your task can succeed without an
undeclared path, the sandbox is invisible; if it tries to reach one,
you find out immediately." Without fail-on-violation, a task that
tolerates `ENOENT` (e.g. probes for an optional `~/.foorc` then
proceeds without it) would silently mask a leaked dependency — the
cache would store output as if no undeclared read happened. Failing
the task surfaces the problem early so users can update their
`sandbox.allow.read` (or accept the leak by adding the path) before
shipping a build that depended on it.

## Port bridge (Linux)

A `localBinding` port LIST is bridged out of the task's network namespace
(`bwrap --unshare-net` sees no host port either way). `wrapSandboxedCommand`
prefixes the sandboxed command with `portBridgeInner`: one
`socat UNIX-LISTEN:<tmpdir>/vx-port-<tag>-<port>.sock,fork TCP:127.0.0.1:<port>`
per port, backgrounded and reaped with the shell (as SRT starts its own
proxy bridges), and spawns the host side, `portBridgeHostArgv`: one
`socat TCP-LISTEN:<port>,bind=127.0.0.1,fork UNIX-CONNECT:<sock>,retry=…`
per port. The unix socket lives in the sandbox tmpdir, bound read-write on
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
struck from the guard's list once it has exited (`kill-tree.md`): a plain
child of vx was in no group the guard lists, and a `kill -9` of vx left it
listening under init, where the next run's bridge could not bind the port
(item 873, `sandbox-runtime.unsafe.test.ts` › "a kill -9 of vx takes the
host side of a port bridge with it").

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
reset. Before item 882, a foreground `vx run dev` or a `vx watch` held a
server past a reset that had already released its port and SRT's
proxies, and the port went dark ~40 ms after the summary.

That deferred reset runs unawaited from the server's exit, and a watch
cycle stops its server and starts its next run at once. `initSandbox`
therefore waits for a reset in flight: an init under it found SRT up,
hot-reloaded it, and had it torn down after (item 884).
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
