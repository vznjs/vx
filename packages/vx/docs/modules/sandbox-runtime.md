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
- `sandbox-paths.ts` — `toRealPath`, `absolutize`, `isUnderAny`,
  `unique`.

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
    ignore?: /* same shape as allow — what to leave out of the report */,
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
(0.0.75) reads them off the config given to `initialize()` and never off
the per-call one, so a per-task grant is silently dropped; `systemInfo`
has no field at any level. vx is per-task by definition, so it appends
the corresponding SBPL rules to the END of the seatbelt profile SRT
generated — last-match-wins is the only position where a rule of ours
outranks one of SRT's. Measured 2026-09-05: the same rules injected after
the `(deny default …)` header are inert in both directions. Filesystem
grants still go through SRT's config, where they also work on Linux.

The `network` case has no such workaround: SRT runs ONE filtering proxy
per run and checks every request against `config.network.allowedDomains`
from `initialize()` (`sandbox-manager.js:228`). `run()` therefore arms it
with the union of every domain any sandboxed task declared. Per-task
enforcement survives where it counts — a task that declared no domains is
never handed the proxy's port, so it reaches nothing at all.

## Public surface

```ts
export interface SandboxAvailability {
  available: boolean
  reason: string // empty when available
}

export function probeSandbox(): Promise<SandboxAvailability>
export function initSandbox(): Promise<void>
export function resetSandbox(): Promise<void>

export interface ResolvedSandboxConfig {
  /* same shape as SandboxConfig, paths absolute */
}
export function resolveSandboxConfig(cfg: SandboxConfig, projectDir: string): ResolvedSandboxConfig

export interface SandboxedRunArgs {
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  forwardArgs?: readonly string[]
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  baseAllowRead: readonly string[] // node_modules + resolved workspace links
  baseDenyRead: readonly string[] // [workspaceRoot] — the task may not leave its project
  reportWithin: string // projectDir — only denials in here are worth reporting
  reportLinked: readonly string[] // withheld linked packages (canonical) — reported too
  config: ResolvedSandboxConfig // its allowWrite is the whole write set: none is derived
}

export interface SandboxViolation {
  line: string
  timestamp: Date
}
export interface SandboxedRunResult extends RunResult {
  violations: SandboxViolation[]
}
export function runSandboxed(args: SandboxedRunArgs): Promise<SandboxedRunResult>

// The wrap without the run: the sandboxed command line, the tag its
// violations are reported under, and the canonical baselines it was
// built from. What an executor running the command ITSELF needs.
export function wrapSandboxedCommand(
  args: Pick<SandboxedRunArgs, 'command' | 'cwd' | 'forwardArgs' | 'config'> &
    Pick<SandboxedRunArgs, 'baseAllowRead' | 'baseDenyRead'>,
): Promise<{
  wrapped: string
  tag: string
  taggedCommand: string
  baselines: CanonicalBaselines
  forwardsSignals: boolean // the command reads its polite signals off fd 3 (item 752)
}>

// Release the port bridges a tagged run held. Paired with the wrap above:
// runSandboxed does it itself, a caller that wrapped must do it.
export function releaseBridges(tag: string): void

// A thrown value as a line a user can read — an FS refusal keeps its
// errno, anything else its message. The sandbox never reports a stack.
export function thrownReason(err: unknown, what?: string): string

// sandbox-paths.ts: the wildcard alphabet of a GRANT. Smaller than
// util/paths.ts's BUN_GLOB_WILDCARDS on purpose — `{}` is a literal to a
// grant (a brace grant gets a placeholder and is widened to its
// directory; scanned, it matches nothing before the task writes). The
// request builder reads it to decide whether an output grant is a glob.
export const MOUNT_WILDCARDS: RegExp
export function isMountableLiteral(grant: string): boolean
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
   directory, the bridge sockets, the strace log all live under
   `os.tmpdir()`) names the knob: the sandbox runtime needs a writable
   temp directory and the one it has is not one, point TMPDIR at a
   writable directory. The probe also refuses up front a temp directory
   whose socket path is past the OS limit (`sun_path`, 108 bytes on
   Linux and 104 on macOS): past it the runtime said ENAMETOOLONG on
   macOS and "Failed to create bridge sockets after 5 attempts" on
   Linux, neither naming the directory; the verdict now gives the path,
   its length, the limit and "point TMPDIR at a shorter path".
2. **`initSandbox`** is called once per `vx run` IF at least one task
   in the graph declares `sandbox`. It calls `SandboxManager.initialize`
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
     string, spawns it via `sh -c wrapped` — under `strace -f … --` on
     Linux — with `sh` and `strace` resolved on vx's own PATH
     (`util/which.ts`), so neither Bun nor strace walks the task's PATH,
     whose `node_modules/.bin` comes first, for the shell; and
     captures stdout/stderr + resource usage exactly like
     `runner.ts:runCommand`.
   - After `proc.exited`, reads back any violations from the macOS
     log monitor (macOS only — see the Linux row below for why the
     store's Linux feed is ignored) AND (on Linux) from the strace log
     the spawn wrote,
     then calls `SandboxManager.cleanupAfterCommand()`.
4. **Filtering.** Enforcement anchors at the workspace root, but only
   denials on a path inside `reportWithin` (the project) or one of
   `reportLinked` (the linked packages a cached task was denied because
   its key does not answer for them) are reported — every process walks
   from `/` down to its own cwd, and being stopped at the wall is the
   sandbox working. A record with no path (a `system-info` probe) is
   kept. The task's `ignore` patterns are applied last.
5. **`resetSandbox`** tears down SRT's proxy servers + (on macOS) the
   log monitor at the end of `vx run`.

## Platform behaviour

| Platform | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS    | sandbox-exec + Seatbelt. Structured violations land in `SandboxViolationStore` via the system log monitor; we force exit 1 when any are recorded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Linux    | bwrap mount namespaces. Denied paths are structurally invisible → child sees `ENOENT`. The spawn is wrapped in `strace -f --seccomp-bpf -e trace=openat` and the trace is parsed for denials against the task's own baselines (`--seccomp-bpf` keeps the ptrace stops to `openat`; without it every syscall stopped and a stat-heavy task ran many times slower — the cache perf baselines failed on the Linux job for that reason until 2026-09-09; strace < 5.3 gets the slow form). SRT ≥ 0.0.75 also feeds its store on Linux from the seccomp helper's write observer, but judges those reports against the GLOBAL `allowWrite` from `initialize` (empty; the per-task list is in `customConfig`, which the monitor never sees), so every declared-output write arrives as `deny openat <output>` — vx reads the store on macOS only. |
| Windows  | Not supported by SRT. `probeSandbox` reports unavailable; declaring `exec.sandbox` triggers a UserError before the run starts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

`wrapSandboxedCommand` is the enforcement half on its own — the tagged command under SRT's wrapper, vx's seatbelt rules appended on macOS — and the persistent path spawns through it (`executePersistentTask`): a dev server declaring `exec.sandbox` gets the same walls and no violation report, since the report reads the trace after exit.

On Linux the command runs in a session, and so a process group, of its own inside the sandbox: `: 'vx-<tag>'; { read -r s <&3 && kill -s "$s" -- -$$; } & exec setsid bash -c '<command>' 3<&-`, both tools resolved on vx's own PATH. bwrap's `--new-session` puts the runtime's shells (the proxy bridges' script, the seccomp step's) in one group with the command, and `kill 0` reaches a group's members across the nested pid namespace, so a command that signalled its own group ended the runtime's shell: bwrap exited 143 and the namespace's teardown SIGKILLed the rest mid-trap (item 751). The shell `exec`s `setsid`, which is no group leader there, so it execs without a fork and the command keeps the shell's pid: an exit status and a signal death (137) are the command's, as before. The cost is a `setsid` exec and a second `bash`, about 3 ms on a 35 ms sandboxed `true` (min of 15, three interleaved pairs). A cancellation reaches the command the same way (item 752): vx's group signal would end bwrap's monitor, and `--die-with-parent` SIGKILLs the namespace, so a `trap … TERM` never ran. The watcher forked before the `exec` reads a signal's name off fd 3, which vx writes for SIGINT and SIGTERM (`signalThrough`, `kill-tree.md`), and signals the command's group, `$$`; SIGKILL at the grace's end still goes to bwrap's group. The command runs in the foreground because an `&` command starts with SIGINT ignored, which a shell cannot trap; it does not get fd 3. `wrapSandboxedCommand` says so in `forwardsSignals`, and both spawns (`runSandboxed`, and `runPersistent` with `signalChannel`) pass fd 3 when it is set.

On Linux the wrapped command is `exec bwrap …`: the spawn's shell execs bwrap, so bwrap is vx's own child and its `--die-with-parent` fires when vx dies, a `kill -9` included. The pid namespace then takes every descendant, one that called `setsid` too. Behind a shell that waited on it, bwrap's parent was that shell, which outlived vx, and a sandboxed server's whole tree ran on under init (turborepo#9666; item 801, `sandbox-runtime.unsafe.test.ts` › "a sandboxed server’s backgrounded and setsid children die with vx"). A one-shot task traced for violations (`strace -f -- sh -c 'exec bwrap …'`) keeps strace as bwrap's parent, so a `kill -9` of vx does not reach it; a persistent task is never traced. The trace log is the task's own file under `os.tmpdir()`, removed once it is read; a signal exit (`process.exit`) never reaches that read, so the process's `exit` event removes every log still listed (item 848, `sandbox-runtime.unsafe.test.ts` › "a signal exit leaves no strace log behind").

A write grant under a directory with SYMLINKED entries (Bun's isolated `node_modules` layout: every package is a link into `.bun/`) punches the read grant into that directory's children, and bwrap mounts a linked child as the directory it points at — inside the sandbox the link is gone and a package resolved through it cannot see the `.bun/` siblings its own dependencies live in (`Cannot find package 'yargs-parser'`, the docs build, 2026-09-05 → 09-09). `punchWritePaths` warns naming the grant; the fix is to keep writable caches out of `node_modules` (astro's `cacheDir`, vite's `cacheDir`), since SRT's config has no `--symlink`.

The strace pass closes the silent-swallow gap on Linux (tools that read
an undeclared path, catch the `ENOENT`, and keep running): the denial is
reported as a violation even though the task exited 0. Trace parsing
pairs `<unfinished ...>` with its `<... resumed>` line, so a denial in a
forked child is reported too — a single-line match dropped those, which
made the violation list incomplete under concurrency. Without `strace`
on PATH the sandbox still ENFORCES; only the structured list is lost.

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

That is the documented contract rather than a defect, but the failure
names neither vx nor the grant, so `expandGrants` reports the grant
itself — once per grant, before the task runs — and names the directory
to grant instead (`grantPrefix`, the directory the pattern was in, not
the scan's anchor one component above it). Read grants are not reported:
a read matching nothing is ordinary.

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

- `src/orchestrator/run.ts` calls `probeSandbox` + `initSandbox` at the
  top of `run()` IFF any node in the graph has `node.config.exec.sandbox`.
  `resetSandbox` runs at the end.
- `src/orchestrator/execute-task.ts:executeCachedTask` calls
  `runSandboxed` instead of `runCommand` when `cfg.exec.sandbox` is set.
  On violations: forces exit 1, appends violation lines to stderr,
  surfaces the count on `TaskOutcome.sandboxViolations`.

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
filter, so `prepareSandbox` arms `allowAllUnixSockets` for the run whenever
a task declares a port list (or `unixSockets`) — per run, like the proxy
allowlist, because SRT reads it at `initialize()` only. `releaseBridges(tag)`
stops the host side: `runSandboxed` calls it after the child exits, the
persistent path on the server's exit, `resetSandbox` for whatever is left.
Pinned in the unsafe suite on Linux: a sandboxed server on a listed port
answers a downstream task's fetch and the host's, and after the run the
port is closed; the control with `localBinding: true` is refused.
