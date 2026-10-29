# util/hide-env

`hideEnvFromTasks()`, called once at the start of every verb
(`cli/index.ts`, 2026-10-13). A task gets only the variables it
declares, but vx's own process still holds the rest, and an unsandboxed
task, which runs as the same user, could read them: on Linux from
`/proc/<vx pid>/environ`, on macOS through `ps eww`.

**Linux.** `prctl(PR_SET_DUMPABLE, 0)` through `bun:ffi`: the kernel then
closes vx's `environ` (and ptrace) to every same-user process, root
aside. `/proc/<pid>/stat` stays readable, so the run lock's liveness
check still works, and vx still reads its own `/proc/self`. A child is
dumpable again after `exec`, so tasks are unaffected. About 0.8 ms per
command, the `bun:ffi` load.

`VX_DEBUG_DUMPABLE=1` (or `true`) skips it: strace cannot read a non-dumpable
tracee's memory, so it prints no paths, and a debugger cannot list
`/proc/<pid>/fd`. The strace tests, `vx-bench`'s `strace-vx.ts` and
`sandbox-session-guard.unsafe.test.ts` set it.

**macOS.** No flag closes `ps eww` (sysctl `KERN_PROCARGS2`) to the same
user: it reads the env strings the kernel copied above vx's stack. vx
zeroes the value of every variable there except `ESSENTIAL_ENV`
(`util/essential-env.ts`), which every task gets anyway
(2026-10-13). It finds them through the original `envp` array, which
follows `argv` (`_NSGetArgv`) and never moves, unlike `environ`. Bun
copied the env at startup, so `process.env`, and every task env built
from it, keeps the values; libc's `getenv` answers `''` for a wiped name.
Cost: 0.65 ms per command on macOS CI (`bun:ffi` load included).

A helper vx keeps running beside its tasks would show the same values:
a spawn with no `env` hands the child vx's startup env, and the child is
readable after its `exec`. `helperEnv()` is `PATH` alone; the group
guard (`exec/kill-tree.ts`) and the port bridges (`exec/sandbox-runtime.ts`)
start with it. `gitEnv()` is what git reads (`GIT_*`, the locale,
`XDG_CONFIG_HOME`) plus the essentials; every `git` vx runs gets it
(`tests/git-env.test.ts`). Not covered: the sandbox runtime's own network
bridges on Linux (`socat`, started by the library with its env).

Elsewhere (musl, other systems) it returns `false`. It hides the
environment, not files: an unsandboxed task still reads anything you
can. `exec.sandbox` is the boundary (`docs/security.md`).
`tests/hide-env.unsafe.test.ts` holds both directions on both systems
and prints the cost; `tests/sandbox-parent-env.unsafe.test.ts` holds a
real run.

## util/env-flag

```ts
// A flag-like variable (`CI`, `GITHUB_ACTIONS`) is on: set, and not '', '0' or 'false' in any case.
export function envFlagOn(v: string | undefined): boolean
```

Every reader of `CI` asks this one, so a run cannot be CI to one part of
vx and a laptop to another.
