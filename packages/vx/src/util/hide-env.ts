import { secretMask } from './secret-mask.js'

const PR_SET_DUMPABLE = 4

/**
 * On Linux, when vx's environment holds a value it would mask, make vx
 * non-dumpable: an unsandboxed task, which runs as the same user, then
 * cannot read vx's `/proc/<pid>/environ` (or ptrace it). A task gets only
 * declared variables, but vx itself holds the rest. Not a boundary
 * (`exec.sandbox` is): it hides the environment, not files. A child is
 * dumpable again after `exec`, so tasks are unaffected. `bun:ffi` costs
 * ~0.8 ms to load, so a run with no secret never loads it.
 */
export async function hideEnvFromTasks(
  env: Readonly<Record<string, string | undefined>> = process.env,
  load: () => Promise<typeof import('bun:ffi')> = () => import('bun:ffi'),
): Promise<boolean> {
  if (process.platform !== 'linux' || secretMask([env]) === null) return false
  try {
    const { dlopen, FFIType } = await load()
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

let helper: Record<string, string> | undefined

/**
 * vx's env without the values it would mask, for the helpers vx keeps
 * running beside its tasks (the group guard, a port bridge). Without an
 * `env`, a spawn hands the child vx's startup env, and that child, dumpable
 * after its `exec`, would show a task every secret `hideEnvFromTasks` hid.
 */
export function helperEnv(): Record<string, string> {
  if (helper !== undefined) return helper
  helper = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && secretMask([{ [k]: v }]) === null) helper[k] = v
  }
  return helper
}
