# Sandbox — design

> **Status: proposal.** Not yet implemented. Captures the decision we
> already reached in conversation so the implementation has a target.

## What we're solving

Today, `cache.inputs.files` is declared by the user but **not enforced**.
The contract is: "this task only reads from this declared set of files."
If the contract is violated — a task quietly reads `package.json` that's
outside its declared `inputs.files` — the cache key is computed without
seeing that file, and the next run produces a **silent false cache hit**.
The user gets stale output and assumes everything's fine.

Sandboxing enforces declarations by making undeclared paths invisible
to the task. Reads outside `inputs.files` fail with `ENOENT`. The
contract becomes structural, not best-effort.

## Why enforcement over observation

Two flavors of "verify the contract" exist:

- **Observation** (NX Cloud's "Task Sandboxing"): trace `openat` /
  `read` syscalls via eBPF after the fact. Detect when a task read a
  path outside the declared set. Warn or kill the task post-hoc.
- **Enforcement** (Bazel sandbox): construct a filesystem view that
  only contains the declared inputs. Undeclared reads fail at the
  kernel level.

We pick enforcement:

- **Correct-by-construction**: false cache hits become impossible.
  Observation is best-effort — strict mode kills _after_ the task
  completed (possibly cached).
- **No allowlist maintenance**: observation generates noise from
  speculative `openat` (tools probing `node_modules/@types/*`, `tsc`
  walking `package.json` ancestors). Maintaining the allowlist is
  ongoing work. Enforcement: a failed `openat` is just a normal
  ENOENT, no special-casing.
- **Lower overhead**: namespaces are kernel-side, sub-5ms. eBPF
  tracing adds per-syscall cost (small, but non-zero).
- **Pre-alpha**: we have no user base to migrate. We can ship strict
  enforcement from day one without grandfathering existing
  under-declared workspaces.

## Mechanism per platform

| Platform | Primitive            | Cost  | Status                                                 |
| -------- | -------------------- | ----- | ------------------------------------------------------ |
| Linux    | `bwrap` (bubblewrap) | <5ms  | ship                                                   |
| macOS    | `sandbox-exec`       | <10ms | ship (Apple-deprecated, may break in a future release) |
| Windows  | —                    | —     | skip in v1                                             |

### Linux: `bwrap`

User namespaces + mount namespaces. The sandbox is a per-task
ephemeral filesystem view assembled from `--bind` / `--ro-bind` /
`--tmpfs` / `--symlink` flags.

Mount strategy per task:

- `--ro-bind <file> <file>` for every file in the resolved
  `cache.inputs.files` set. Read-only — the task can read declared
  inputs but can't modify them.
- `--bind <project-dir> <project-dir>` (read-write). The task needs
  to write its outputs back. Restoring is the orchestrator's job;
  the sandbox just lets the task work.
- `--ro-bind /usr/bin/...` (and similar) for the binaries the task
  needs. Or `--ro-bind /` of common tool roots if we want to be more
  permissive. The minimal set is what `PATH` resolves to, but in
  practice tools have transitive needs (libc, dynamic libraries,
  configuration in `/etc`). Start with `--ro-bind /usr /lib /lib64
/etc` and tighten later.
- `--tmpfs /tmp` so the task has scratch space without leaking onto
  the host's `/tmp`.
- `--unshare-pid` and `--die-with-parent` so subprocesses die with
  the sandbox.
- **No `--unshare-net`** in v1 (see out-of-scope).

Bun spawn invocation:

```ts
Bun.spawn([
  'bwrap',
  '--die-with-parent',
  '--unshare-pid',
  '--ro-bind',
  '/usr',
  '/usr',
  '--ro-bind',
  '/lib',
  '/lib',
  '--ro-bind',
  '/etc',
  '/etc',
  '--tmpfs',
  '/tmp',
  '--bind',
  projectDir,
  projectDir,
  ...inputFiles.flatMap((f) => ['--ro-bind', f, f]),
  'sh',
  '-c',
  task.exec.command,
])
```

### macOS: `sandbox-exec`

Apple-deprecated since macOS 10.12 but still functional. Builds a
seatbelt-language profile:

```
(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow file-read* (regex #"^/usr/.*"))
(allow file-read* (regex #"^/private/var/folders/.*"))
(allow file-read* (literal "/path/to/input1.ts"))
(allow file-read* (literal "/path/to/input2.ts"))
(allow file-read* (regex #"^/path/to/project/.*"))
(allow file-write* (regex #"^/path/to/project/.*"))
(allow network*)
```

Built dynamically per-task from the resolved inputs + project dir.

### Windows

Skip in v1. Windows has no comparable lightweight sandbox primitive
(Job Objects + AppContainer would work but require a real engineering
effort). On Windows, `vzn run --sandbox` logs a warning and falls
through to direct execution.

## CLI surface

```
vzn run --sandbox [TASK]
```

Boolean flag. Off by default. When set:

- Linux: bwrap-wrapped command.
- macOS: sandbox-exec-wrapped command.
- Windows / other: warn, run directly.

Future expansion: `--sandbox=strict|warn|off`:

- `strict` (= the v1 `--sandbox`): enforce; ENOENT on undeclared reads.
- `warn`: observe (would need eBPF on Linux; defer).
- `off`: explicit opt-out when the workspace config sets a default.

Workspace-level default once `defineWorkspace` loading lands:

```ts
defineWorkspace({
  run: { sandbox: 'strict' },
})
```

Out of scope for v1; we keep it env-driven via the CLI flag.

## Implementation outline

New module `src/sandbox.ts`:

```ts
export interface SandboxArgs {
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  forwardArgs?: readonly string[]
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  // sandbox-specific
  projectDir: string // read-write
  inputFiles: readonly string[] // read-only
}

export function isSandboxSupported(): boolean
export async function runSandboxed(args: SandboxArgs): Promise<RunResult>
```

- `isSandboxSupported()`: returns false on Windows; otherwise checks
  for `bwrap` or `sandbox-exec` on PATH via `Bun.spawnSync(['which',
...])`.
- `runSandboxed(args)`: builds the wrapper command (bwrap on Linux,
  sandbox-exec on macOS), then calls `runCommand` (or duplicates its
  spawn logic) with the wrapped command.

Orchestrator `executeTask` integration:

- Add `sandbox` to the `RunOptions` (CLI sets it from the flag).
- After computing input files (`resolved.files`), if `sandbox` is on,
  call `runSandboxed({ ..., inputFiles: resolved.files })`. Otherwise
  call `runCommand` as today.

CLI parser:

- New flag `--sandbox` in `parseRunArgs`. Plumb to `RunOptions`.

## What's out of scope

- **Network isolation.** Tasks legitimately need network for `npm
install`-like operations, fetching from a registry, etc. v1 leaves
  network alone. Future: a `--sandbox-no-network` mode for hermetic
  builds.
- **Environment-variable enforcement.** Already covered by `env.ts`'s
  allowlist + passThrough + define model. The child only sees what
  we explicitly give it.
- **`--sandbox=warn` mode.** Observation-style auditing. Would need
  eBPF on Linux (heavyweight setup) and has no clean macOS analog.
  Defer until someone wants migration-friendly rollout.
- **Windows support.** Job Objects + AppContainer is a real project;
  not justified for a pre-alpha tool's first sandbox PR.
- **Telling the user _what_ was the violation.** When a sandboxed task
  fails because it tried to read an undeclared file, the user sees an
  ENOENT inside the tool's error message. We could trace and report
  the violation, but that needs the observation path. v2.
- **`--sandbox` as the default.** Pre-alpha; opt-in only. Once we have
  a real user base running it for a few weeks, we'll consider
  defaulting it on.

## Why this is the right move

- **Real correctness guarantee.** No more silent false cache hits from
  under-declaration. The contract becomes structural.
- **No new heavy deps.** `bwrap` is a tiny static binary shipped by
  most Linux distros; `sandbox-exec` ships with macOS.
- **Cheap.** <10ms per task on either platform. Doesn't ruin the
  latency of small lint/typecheck tasks.
- **Opt-in.** The default fast path is unchanged. Users who want the
  guarantee pay for it; users who don't aren't slowed down.
- **Matches a proven design.** Bazel has run on this model for a
  decade. We're not inventing the sandbox; we're plugging it in.

## Open questions

- **bwrap availability.** Should `--sandbox` fail loudly when `bwrap`
  isn't installed, or fall through to plain execution with a warning?
  Leaning toward **fail loudly**: silent fall-through breaks the
  guarantee without the user noticing.
- **sandbox-exec longevity.** Apple has marked sandbox-exec deprecated
  since macOS 10.12 but hasn't removed it. If they do, plan B is
  either (a) a Linux VM via Apple Containers, (b) drop macOS sandbox
  support and document. Lean (b) for v1.
- **Reporting violations.** When the task fails with ENOENT in the
  sandbox, the user sees a confusing error. We could shim error
  messages with "this looks like a sandbox violation; check your
  `cache.inputs.files`" but that requires parsing tool output. v2.
- **Tool transitive deps.** Pre-defining the right `--ro-bind` set for
  arbitrary tool chains (tsc, vite, vitest, esbuild, ...) is real
  work. Start permissive (`/usr`, `/lib`, `/etc`) and tighten based
  on real failures.

## Implementation order

1. Decide bwrap-availability behavior (fail-loud vs fallthrough).
2. Write `src/sandbox.ts` with `isSandboxSupported` + `runSandboxed`
   (Linux first; macOS in a follow-up if scope is too big).
3. Add `--sandbox` to `parseRunArgs` + plumb through `RunOptions`.
4. Update `executeTask` to call `runSandboxed` when the flag is set.
5. Tests:
   - Sandboxed task that only reads declared inputs → succeeds.
   - Sandboxed task that tries to read outside the inputs → fails.
   - `--sandbox` on Windows: warns and runs directly (or errors,
     depending on the answered open question).
   - bwrap not on PATH: fail with a clear message (assuming we go
     fail-loud).
6. Docs: `docs/cli.md` `--sandbox` reference; `docs/architecture.md`
   sandbox principle.
7. CLAUDE.md decision log entry + active-workstreams update.

## References

- bwrap manual: <https://github.com/containers/bubblewrap>
- macOS sandbox-exec profile language: Apple System Programming Guide
  (legacy), archived.
- Bazel local sandbox: <https://bazel.build/docs/sandboxing>
- NX Cloud Task Sandboxing (the eBPF alternative we rejected):
  <https://nx.dev/docs/features/ci-features/sandboxing>
