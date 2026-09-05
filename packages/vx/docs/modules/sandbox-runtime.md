# `src/exec/sandbox-runtime.ts` — sandbox wrapper for per-task isolation

## Purpose

Thin wrapper around `@anthropic-ai/sandbox-runtime` (SRT) for running a
single task inside a filesystem + network sandbox with strict isolation.
Used by `executeCachedTask` when the task's config declares
`exec.sandbox`.

Policy: **fail on violation, no cache for failed tasks.** The sandbox
enforces the declared grants at the kernel level; any task that reads
outside them either fails naturally (Linux structural deny)
or is detected via the macOS violation store and forced to exit
non-zero. `cache.save` only fires when the task succeeded AND the
violation store is empty.

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
      localBinding?: boolean
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
sibling to import what its `package.json` depends on.

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
  baseAllowWrite: readonly string[] // empty — writes are declared, never derived
  baseDenyRead: readonly string[] // [workspaceRoot] — the task may not leave its project
  reportWithin: string // projectDir — only denials in here are worth reporting
  config: ResolvedSandboxConfig
}

export interface SandboxViolation {
  line: string
  timestamp: Date
}
export interface SandboxedRunResult extends RunResult {
  violations: SandboxViolation[]
}
export function runSandboxed(args: SandboxedRunArgs): Promise<SandboxedRunResult>
```

## How it works

1. **`probeSandbox`** asks SRT whether the platform is supported and
   whether its runtime deps (bwrap + socat on Linux, sandbox-exec on
   macOS) are present, then on Linux runs ONE sandboxed `true` through
   SRT's own wrapper — bwrap with the runtime's namespace flags plus its
   vendored `apply-seccomp` helper, which creates a nested user
   namespace. A bare `bwrap … /bin/true` passed on hosts where every
   task then failed (root inside a container: the helper's
   `write /proc/self/uid_map` is EPERM under `--cap-drop ALL`); the
   wrapper probe refuses up front, naming the fix (a non-root user, or
   `sandbox.weakerWhenNested: true` on every sandboxed task —
   `run()` probes the weaker mode only when every sandboxed task opts
   in). Memoized per mode.
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
     string, spawns it via `Bun.spawn(['sh', '-c', wrapped])`, and
     captures stdout/stderr + resource usage exactly like
     `runner.ts:runCommand`.
   - After `proc.exited`, reads back any violations from the macOS
     log monitor (macOS only — see the Linux row below for why the
     store's Linux feed is ignored) AND (on Linux) from the strace log
     the spawn wrote,
     then calls `SandboxManager.cleanupAfterCommand()`.
4. **Filtering.** Enforcement anchors at the workspace root, but only
   denials on a path inside `reportWithin` (the project) are reported —
   every process walks from `/` down to its own cwd, and being stopped at
   the wall is the sandbox working. A record with no path (a `system-info`
   probe) is kept. The task's `ignore` patterns are applied last.
5. **`resetSandbox`** tears down SRT's proxy servers + (on macOS) the
   log monitor at the end of `vx run`.

## Platform behaviour

| Platform | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | sandbox-exec + Seatbelt. Structured violations land in `SandboxViolationStore` via the system log monitor; we force exit 1 when any are recorded.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Linux    | bwrap mount namespaces. Denied paths are structurally invisible → child sees `ENOENT`. The spawn is wrapped in `strace -f -e trace=openat` and the trace is parsed for denials against the task's own baselines. SRT ≥ 0.0.75 also feeds its store on Linux from the seccomp helper's write observer, but judges those reports against the GLOBAL `allowWrite` from `initialize` (empty; the per-task list is in `customConfig`, which the monitor never sees), so every declared-output write arrives as `deny openat <output>` — vx reads the store on macOS only. |
| Windows  | Not supported by SRT. `probeSandbox` reports unavailable; declaring `exec.sandbox` triggers a UserError before the run starts.                                                                                                                                                                                                                                                                                                                                                                                                                                       |

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

## macOS cannot nest

`sandbox_apply` is refused inside a sandboxed process, at any permission
level — an inner `sandbox-exec` with a `(allow default)` profile still
dies with `sandbox_apply: Operation not permitted` (exit 71, measured
2026-09-05, pinned by `tests/sandbox-runtime.test.ts`). A task that
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

- `src/orchestrator.ts` calls `probeSandbox` + `initSandbox` at the
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
