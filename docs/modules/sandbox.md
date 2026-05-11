# `sandbox.ts` — filesystem-enforcing task sandbox

## Purpose

Runs a task inside a constrained filesystem view where only the
declared `cache.inputs.files` (read-only) and the project dir
(read-write) are visible. Undeclared reads fail with `ENOENT`.

This is the **enforcement** half of the input-tracking discussion —
the kernel makes the contract structural rather than relying on
post-hoc auditing. See `docs/design/sandbox.md` for the design
rationale (in particular, why we picked enforcement over NX-style
eBPF observation).

## Public surface

```ts
export type SandboxPlatform = 'linux' | 'darwin' | 'unsupported'

export interface SandboxArgs {
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  forwardArgs?: readonly string[]
  projectDir: string         // bound read-write
  inputFiles: readonly string[] // bound read-only
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

export function detectPlatform(): SandboxPlatform
export function isSandboxSupported(): boolean
export async function runSandboxed(args: SandboxArgs): Promise<RunResult>

export class SandboxUnsupportedError extends Error // platform: NodeJS.Platform
export class SandboxToolMissingError extends Error // tool: string
```

`RunResult` is the same shape `runner.runCommand` returns.

## Per-platform mechanism

### Linux: bwrap (bubblewrap)

User namespaces + mount namespaces. Per-task ephemeral filesystem:

- `--ro-bind /usr /usr`
- `--ro-bind-try /lib /lib`, `/lib64`, `/lib32`, `/etc`, `/bin`,
  `/sbin` — `-try` silently skips when a source doesn't exist
  (handles usr-merged distros where `/lib` is a symlink).
- `--tmpfs /tmp`, `--proc /proc`, `--dev /dev`.
- `--bind <projectDir> <projectDir>` — read-write for outputs.
- `--ro-bind-try <inputFile> <inputFile>` for each declared input.
- `--unshare-pid`, `--unshare-ipc`, `--unshare-uts`,
  `--die-with-parent`.
- `--chdir <cwd>`, then `sh -c "<command + forwardArgs>"`.

Network is **not** isolated in v1; tasks legitimately need
package-registry / DNS / git access.

### macOS: sandbox-exec

Apple-deprecated but functional. A seatbelt profile is generated per
task and written to a temp file:

```
(version 1)
(deny default)
(allow process-exec) (allow process-fork) (allow signal)
(allow sysctl-read) (allow mach-lookup) (allow ipc-posix-shm)
(allow network*)
(allow file-read* (regex #"^/usr/.*"))
(allow file-read* (regex #"^/bin/.*"))
...
(allow file-read* file-write* (regex #"^<projectDir>(/|$)"))
(allow file-read* (literal "<inputFile1>"))
(allow file-read* (literal "<inputFile2>"))
```

Passed to `sandbox-exec -f <profile> sh -c "<command + forwardArgs>"`.

### Other platforms

`detectPlatform()` returns `'unsupported'`; `runSandboxed` throws
`SandboxUnsupportedError`. The orchestrator surfaces this to the user
rather than silently running unsandboxed.

## Helper detection

`isSandboxSupported()` checks both that the platform is Linux/macOS
AND that `bwrap` / `sandbox-exec` is on `PATH`. Detection uses
`sh -c 'command -v <tool>'` (POSIX-portable; doesn't rely on the
non-POSIX `which`).

`runSandboxed()` throws `SandboxToolMissingError` when the helper
isn't installed. The orchestrator passes this up unchanged — silent
fall-through would defeat the contract.

## I/O model

Identical to `runner.runCommand`:

- Streams stdout/stderr via `onStdout` / `onStderr` callbacks.
- Captures the full streams for cache replay.
- Returns `{ exitCode, durationMs, stdout, stderr }`.

## What this does NOT do

- No network isolation.
- No environment-variable enforcement (that's `env.ts`'s job).
- No "warn but don't fail" mode (would need observation, not
  enforcement). See `docs/design/sandbox.md` for the future
  `--sandbox=warn` path via eBPF.
- No graceful fallback when the helper is missing. Fail-loud by
  design.
- No Windows support.

## Tests

`src/sandbox.test.ts` runs against real bwrap (CI installs
bubblewrap). The suite uses `describe.skipIf(!onLinux ||
!sandboxAvailable)` so it's portable.

Cases:

- Simple command runs and captures stdout.
- Declared input is readable.
- **Undeclared file outside the project dir is invisible (ENOENT)** —
  the headline guarantee.
- Project dir is read-write.
- Declared inputs are read-only (writes fail).
- `/root` and `/home` are not leaked.
- `forwardArgs` path runs cleanly through shell quoting.

Plus platform/error-class tests that run everywhere.

## Replacing this module

To swap in a different sandbox primitive (e.g. landlock on Linux,
sandbox-exec replacement on macOS, or Job Objects on Windows), keep
the four public exports (`detectPlatform`, `isSandboxSupported`,
`runSandboxed`, and the two error classes). The orchestrator and CLI
don't know what's under the hood.
