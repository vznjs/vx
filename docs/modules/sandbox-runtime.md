# `src/exec/sandbox-runtime.ts` — sandbox wrapper for per-task isolation

## Purpose

Thin wrapper around `@anthropic-ai/sandbox-runtime` (SRT) for running a
single task inside a filesystem + network sandbox with strict isolation.
Used by `executeCachedTask` when the task's config declares
`sandbox: {}` (or `sandbox: { ... }`).

Policy: **fail on violation, no cache for failed tasks.** The sandbox
enforces declared inputs at the kernel level; any task that reads
outside the allowed set either fails naturally (Linux structural deny)
or is detected via the macOS violation store and forced to exit
non-zero. `cache.save` only fires when the task succeeded AND the
violation store is empty.

## User-facing config

The task declares its sandbox policy in `vx.config.ts` (the
`SandboxConfig` type, exported from `src/config.ts`). Path lists
(`allowRead`, `denyRead`, `allowWrite`, `denyWrite`,
`network.allowUnixSockets`, `network.allowMachLookup`) accept:

- **relative paths** → resolved against the project directory
- **absolute paths** → used as-is (`/etc/passwd`, `/tmp`)
- **tilde paths** → expanded against the user's home (`~/.npmrc`)

No globs in path lists — bwrap on Linux only accepts path prefixes.

The full SRT-mirroring surface:

```ts
sandbox: {
  // Filesystem
  allowRead?: string[]                  // added to resolved cache.inputs.files
  denyRead?: string[]                   // additional deny anchors
  allowWrite?: string[]                 // added to static-prefix of cache.outputs.files
  denyWrite?: string[]                  // additional deny anchors
  allowGitConfig?: boolean              // permit writes to .git/config

  // Network — false (default) blocks all egress; true allows all; object
  // gives fine-grained control mirroring SRT's NetworkConfig.
  network?: boolean | {
    allowedDomains?: string[]           // wildcards: '*.example.com', '*'
    deniedDomains?: string[]
    allowUnixSockets?: string[]
    allowAllUnixSockets?: boolean
    allowLocalBinding?: boolean         // permit binding localhost ports
    allowMachLookup?: string[]          // macOS only
  }

  // Process
  allowPty?: boolean                    // permit pseudo-terminal
  enableWeakerNestedSandbox?: boolean   // Linux: allow nested sandboxes
  enableWeakerNetworkIsolation?: boolean // macOS: skip network namespace

  // Violation policy
  ignoreViolations?: Record<string, string[]>  // command-pattern → paths to ignore
}
```

There is **no inheritance** from `vx.workspace.ts` and **no built-in
escapes** for `node_modules` or `/tmp` — declare them in `allowRead` /
`allowWrite` if you need them.

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
  baseAllowRead: readonly string[] // resolved cache.inputs.files
  baseAllowWrite: readonly string[] // static prefix of cache.outputs.files
  baseDenyRead: readonly string[] // typically [workspaceRoot]
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
   `sandbox.enableWeakerNestedSandbox: true` on every sandboxed task —
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
   - Builds a `customConfig` by merging the baseline (declared inputs,
     declared outputs, workspace-root deny anchor) with the user's
     resolved sandbox block.
   - Calls `SandboxManager.wrapWithSandbox` to get the wrapped command
     string, spawns it via `Bun.spawn(['sh', '-c', wrapped])`, and
     captures stdout/stderr + resource usage exactly like
     `runner.ts:runCommand`.
   - After `proc.exited`, reads back any violations from the macOS
     log monitor (macOS only — see the Linux row below for why the
     store's Linux feed is ignored) AND (on Linux) from the strace log
     the spawn wrote,
     then calls `SandboxManager.cleanupAfterCommand()`.
4. **`resetSandbox`** tears down SRT's proxy servers + (on macOS) the
   log monitor at the end of `vx run`.

## Platform behaviour

| Platform | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | sandbox-exec + Seatbelt. Structured violations land in `SandboxViolationStore` via the system log monitor; we force exit 1 when any are recorded.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Linux    | bwrap mount namespaces. Denied paths are structurally invisible → child sees `ENOENT`. The spawn is wrapped in `strace -f -e trace=openat` and the trace is parsed for denials against the task's own baselines. SRT ≥ 0.0.75 also feeds its store on Linux from the seccomp helper's write observer, but judges those reports against the GLOBAL `allowWrite` from `initialize` (empty; the per-task list is in `customConfig`, which the monitor never sees), so every declared-output write arrives as `deny openat <output>` — vx reads the store on macOS only. |
| Windows  | Not supported by SRT. `probeSandbox` reports unavailable; declaring `sandbox: {}` triggers a UserError before the run starts.                                                                                                                                                                                                                                                                                                                                                                                                                                        |

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
`allowRead` / `allowWrite`, the orchestrator's resolved inputs and output
prefixes, and the workspace-root deny anchor. The sandbox matches on
canonical paths (macOS Seatbelt evaluates real vnode paths; bwrap mounts
inside a new root), so a workspace reached through a symlink must not
express half its policy in link paths and half in real ones. Before this
was applied to the orchestrator baselines, such a workspace made every
sandboxed task die with `bwrap: Can't mount tmpfs on /newroot/<link>`.

## Integration points

- `src/orchestrator.ts` calls `probeSandbox` + `initSandbox` at the
  top of `run()` IFF any node in the graph has `node.config.sandbox`.
  `resetSandbox` runs at the end.
- `src/orchestrator/execute-task.ts:executeCachedTask` calls
  `runSandboxed` instead of `runCommand` when `cfg.sandbox` is set.
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
`sandbox.allowRead` (or accept the leak by adding the path) before
shipping a build that depended on it.
