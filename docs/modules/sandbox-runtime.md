# `src/exec/sandbox-runtime.ts` — sandbox wrapper for violation detection

## Purpose

Thin wrapper around `@anthropic-ai/sandbox-runtime` (SRT) for running a
single task inside a filesystem sandbox and reading back any violations
the sandbox observed. Used by `executeCachedTask` when `--sandbox` is
set.

Policy: **detect-and-skip-cache**. Violations don't fail the task — the
exit code passes through unchanged. They DO cause `cache.save()` to be
skipped, so a tainted run can't be replayed from cache on a future
invocation.

## Public surface

```ts
export interface SandboxAvailability {
  available: boolean
  reason: string // empty when available
}

export function probeSandbox(): Promise<SandboxAvailability>
export function initSandbox(args: { workspaceRoot: string }): Promise<void>
export function resetSandbox(): Promise<void>

export interface SandboxViolation {
  line: string // raw log entry from SRT
  timestamp: Date
}

export interface SandboxedRunResult extends RunResult {
  violations: SandboxViolation[]
}

export function runSandboxed(args: SandboxedRunArgs): Promise<SandboxedRunResult>
```

`SandboxedRunArgs` mirrors `runner.ts:RunOptions` plus three filesystem
fields:

- `allowRead` — absolute paths the task may read freely (its project
  dir, the resolved input files, the workspace's `node_modules`).
- `allowWrite` — absolute paths the task may write to (project dir +
  `/tmp`; the cache writes happen outside the sandbox).
- `denyRead` — absolute paths to flag reads against. Typically just
  `[workspaceRoot]`: combined with `allowRead`, this says "deny reading
  anywhere in the workspace except for these specific paths."

## How it works

1. **`probeSandbox`** asks SRT whether the platform is supported and
   whether its runtime deps (bwrap on Linux, sandbox-exec on macOS)
   are present. Memoized — the result doesn't change within a process.
2. **`initSandbox`** is called once per `vx run`. It calls
   `SandboxManager.initialize` with `enableWeakerNetworkIsolation:
true` (we don't restrict network) and starts the macOS log monitor
   so violations land in the `SandboxViolationStore`.
3. **`runSandboxed`** is called once per cached task:
   - Prepends a unique `: 'vx-<hash>';` shell no-op to the command.
     SRT keys violations by base64 of the first 100 chars of the
     command; without this, two parallel `tsc` invocations across
     packages would share the same key.
   - Calls `SandboxManager.wrapWithSandbox` with a `customConfig` that
     scopes `filesystem.denyRead` / `allowRead` / `allowWrite` to the
     calling task.
   - Spawns the wrapped string via `Bun.spawn(['sh', '-c', wrapped])`
     and captures stdout/stderr + resource usage exactly like
     `runner.ts:runCommand`.
   - After `proc.exited`, reads back
     `SandboxViolationStore.getViolationsForCommand(tagged)` and
     returns the list alongside the `RunResult`.
   - Calls `SandboxManager.cleanupAfterCommand()` so bwrap mount-point
     files don't accumulate.
4. **`resetSandbox`** tears down SRT's proxy servers and log monitor
   at the end of `vx run`.

## Platform reality check

- **macOS:** `SandboxViolationStore` is populated in real time from
  the system sandbox log. Violations carry the offending command +
  syscall line; we get structured detection.
- **Linux:** bwrap denies the read at the kernel boundary; the child
  sees EPERM/EACCES. SRT doesn't surface a structured event for that,
  so detection is enforcement-only. Tasks that genuinely needed an
  undeclared input will fail naturally (and a failed task doesn't
  cache anyway). Tasks that swallow the EPERM keep running with no
  visible violation.
- **Windows:** not supported by SRT. `probeSandbox` returns
  `{ available: false }`; `--sandbox` errors out with a clear message.

## Integration points

- `src/orchestrator.ts` calls `probeSandbox` + `initSandbox` once at
  the start of `run()` when `options.sandbox` is set, and
  `resetSandbox` at the end.
- `src/orchestrator/execute-task.ts:executeCachedTask` calls
  `runSandboxed` instead of `runCommand` when
  `args.sandbox && cacheEnabled`. On violations: skip `cache.save`,
  surface a `vx: <task> — N sandbox violation(s); cache.save() skipped`
  status line, attach `sandboxViolations: N` to the `TaskOutcome`.

## Why not enforce-on-violation?

The user-facing contract is "your build is correct OR your cache is
fresh, never both wrong." Skipping `cache.save` gives that: a task
with violations always re-runs next time, so the cache never returns
output derived from undeclared inputs. Failing the task on violations
would block the build for noisy violations (e.g. a tool that probes
many candidate paths and tolerates EPERM); detect-only keeps the
loop usable while still protecting the cache.
