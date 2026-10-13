const PR_SET_DUMPABLE = 4

/**
 * On Linux, make vx non-dumpable: an unsandboxed task, which runs as the
 * same user, then cannot read vx's `/proc/<pid>/environ` (or ptrace it).
 * A task gets only declared variables, but vx itself holds the rest. Not
 * a boundary (`exec.sandbox` is): it hides the environment, not files. A
 * child is dumpable again after `exec`, so tasks are unaffected. On every
 * verb (owner, 2026-10-13); loading `bun:ffi` costs ~0.8 ms. `VX_DUMPABLE`
 * keeps vx observable: strace cannot read a non-dumpable tracee's memory,
 * nor a debugger `/proc/<pid>/fd`.
 */
export async function hideEnvFromTasks(): Promise<boolean> {
  if (process.platform !== 'linux' || process.env['VX_DUMPABLE']) return false
  try {
    const { dlopen, FFIType } = await import('bun:ffi')
    const libc = dlopen('libc.so.6', {
      prctl: {
        args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
        returns: FFIType.i32,
      },
    })
    const ok = libc.symbols.prctl(PR_SET_DUMPABLE, 0n, 0n, 0n, 0n) === 0
    libc.close()
    return ok
  } catch {
    // No glibc (musl names it otherwise): the env stays as readable as
    // any process's, as it was.
    return false
  }
}

/**
 * The env for a helper vx keeps running beside its tasks (the group
 * guard, a port bridge): PATH alone. Without an `env`, a spawn hands the
 * child vx's startup env, and that child, dumpable after its `exec`,
 * would show a task what `hideEnvFromTasks` hid.
 */
export function helperEnv(): Record<string, string> {
  return { PATH: process.env['PATH'] ?? '' }
}
