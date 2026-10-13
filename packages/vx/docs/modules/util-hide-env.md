# util/hide-env

`hideEnvFromTasks(env?, load?)`, called once at the start of every verb
(`cli/index.ts`). A task gets only the variables it declares, but vx's
own process still holds the rest, and on Linux an unsandboxed task, which
runs as the same user, can read them from `/proc/<vx pid>/environ`. When
`secretMask` finds a value it would mask in vx's env, this calls
`prctl(PR_SET_DUMPABLE, 0)` through `bun:ffi`: the kernel then closes
vx's `environ` (and ptrace) to every same-user process, root aside.
`/proc/<pid>/stat` stays readable, so the run lock's liveness check
still works, and vx still reads its own `/proc/self`. A child is
dumpable again after `exec`, so tasks are unaffected.

A helper vx keeps running beside its tasks would show the same values:
a spawn with no `env` hands the child vx's startup env, and the child is
dumpable after its `exec`. `helperEnv()` is vx's env without them; the
group guard (`exec/kill-tree.ts`) and the port bridges
(`exec/sandbox-runtime.ts`) start with it. Not covered: a short-lived
`git` vx runs, and the sandbox runtime's own network bridges on Linux
(`socat`, started by the library with its env).

Linux only (glibc; elsewhere it returns `false`). It hides the
environment, not files: an unsandboxed task still reads anything you
can. `exec.sandbox` is the boundary (`docs/security.md`). Loading
`bun:ffi` costs about 0.8 ms, so a run with no secret never loads it;
`tests/hide-env.unsafe.test.ts` holds both directions and that.
