import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { ESSENTIAL_ENV } from './essential-env.js'

const PR_SET_DUMPABLE = 4

/**
 * Hide vx's environment from a same-user task. A task gets only declared
 * variables, but vx itself holds the rest. Not a boundary (`exec.sandbox`
 * is): it hides the environment, not files. On every verb
 * (2026-10-13).
 *
 * Linux: make vx non-dumpable, so its `/proc/<pid>/environ` (and ptrace)
 * close to the task. A child is dumpable again after `exec`, so tasks are
 * unaffected. Loading `bun:ffi` costs ~0.8 ms. `VX_DEBUG_DUMPABLE` keeps vx
 * observable: strace cannot read a non-dumpable tracee's memory, nor a
 * debugger `/proc/<pid>/fd`.
 *
 * macOS: `ps eww` reads the env strings the kernel copied above the
 * stack, and no flag closes that to the same user, so vx zeroes the
 * values there (2026-10-13: "Do the override then on macOS").
 * Bun copied the env at startup, so `process.env`, and every task built
 * from it, keeps them.
 */
export async function hideEnvFromTasks(): Promise<boolean> {
  if (process.platform === 'darwin') return wipeStartupEnv()
  // `debug.dumpable` is a bool (util sits below src/settings.ts, so it reads
  // it itself, as util/timing.ts does): `0` and `false` hide too.
  const dumpable = process.env['VX_DEBUG_DUMPABLE']
  if (process.platform !== 'linux' || dumpable === 'true' || dumpable === '1') return false
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
 * Zero the value of every startup variable a task does not see by
 * default (`ESSENTIAL_ENV` stays: every task gets it anyway). The
 * original `envp` array follows `argv`'s NULL on the stack and is never
 * moved, unlike `environ`, which `setenv` may reallocate. libc's
 * `getenv` reads that block, so it answers `''` for a wiped name; vx
 * reads `process.env`.
 */
async function wipeStartupEnv(): Promise<boolean> {
  try {
    const { dlopen, FFIType, read, toArrayBuffer, CString } = await import('bun:ffi')
    const sys = dlopen('/usr/lib/libSystem.B.dylib', {
      _NSGetArgv: { args: [], returns: FFIType.ptr },
      _NSGetArgc: { args: [], returns: FFIType.ptr },
    })
    const argv = read.ptr(sys.symbols._NSGetArgv()!, 0)
    const argc = read.i32(sys.symbols._NSGetArgc()!, 0)
    sys.close()
    const keep = new Set(ESSENTIAL_ENV)
    for (let i = argc + 1; ; i++) {
      const p = read.ptr(argv, i * 8)
      if (!p) break
      const entry = new CString(p as never).toString()
      const eq = entry.indexOf('=')
      if (eq < 0 || keep.has(entry.slice(0, eq))) continue
      new Uint8Array(toArrayBuffer(p as never, 0, Buffer.byteLength(entry))).fill(0, eq + 1)
    }
    return true
  } catch {
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

/**
 * The env for a `git` vx runs: what git reads (`GIT_*`, the locale,
 * `XDG_CONFIG_HOME`, the essentials: `HOME`, `PATH`) and nothing else.
 * A git child is readable after its `exec` like any helper, and `vx
 * watch` runs git while its tasks run.
 */
export function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (
      name.startsWith('GIT_') ||
      name.startsWith('LC_') ||
      name === 'XDG_CONFIG_HOME' ||
      name === 'LANGUAGE' ||
      ESSENTIAL_ENV.includes(name)
    )
      env[name] = value
  }
  if (env['GIT_DIR'] !== undefined && env['GIT_WORK_TREE'] === undefined) {
    if (rediscovers(env['GIT_DIR'])) delete env['GIT_DIR']
  }
  return env
}

const rediscovered = new Map<string, boolean>()

/**
 * Whether a plain `git` where vx started finds the repository `gitDir`
 * names anyway. A linked worktree's hook exports its gitdir as GIT_DIR and
 * no GIT_WORK_TREE, and git then takes ITS cwd as the work tree's top: vx
 * runs git in the workspace root, a subfolder there, and git read every
 * file as untracked. Without the variable git finds the top itself. A
 * GIT_DIR naming any other repository (a bare one, dotfiles) is kept.
 */
function rediscovers(gitDir: string): boolean {
  const cwd = process.cwd()
  const key = `${cwd}\0${gitDir}`
  let hit = rediscovered.get(key)
  if (hit === undefined) {
    hit = false
    try {
      const abs = path.resolve(cwd, gitDir)
      let dotGit = abs
      // A linked worktree's admin dir names its checkout's `.git` file.
      try {
        dotGit = path.resolve(abs, readFileSync(path.join(abs, 'gitdir'), 'utf8').trim())
      } catch {}
      if (path.basename(dotGit) === '.git') {
        const rel = path.relative(realpathSync(path.dirname(dotGit)), realpathSync(cwd))
        hit = !rel.startsWith('..') && !path.isAbsolute(rel)
      }
    } catch {}
    rediscovered.set(key, hit)
  }
  return hit
}
