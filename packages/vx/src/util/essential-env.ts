import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'

/**
 * Every task gets these (`exec/env.ts`), so `hideEnvFromTasks` leaves
 * them. Exported so the schema doc's enumeration of it can be PINNED against the
 * real list: a hand-copied allowlist is how the two drift, and a reader
 * asking "what does my build script actually see?" is asking a
 * security-shaped question that a stale list answers wrongly.
 */
export const ESSENTIAL_ENV: readonly string[] = [
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'FORCE_COLOR',
  'NO_COLOR',
  'CI',
  'NODE_OPTIONS',
  // Where corepack and pnpm keep their own binaries, as HOME is: a machine
  // path, never task output. Without them a corepack shim re-downloads its
  // manager (offline or sandboxed: fails) and pnpm loses its global dir.
  'COREPACK_HOME',
  'PNPM_HOME',
  // Where rustup, cargo and go keep their toolchains and stores, by the same
  // reasoning: the rust image sets RUSTUP_HOME and CARGO_HOME away from
  // home, and stripped, cargo failed "rustup could not choose a version",
  // in a task and in an `inputs.runtime` probe alike (a probe sees these
  // only). GOROOT is not one: go finds it from its own path, and a value
  // that picks the toolchain (it, GOTOOLCHAIN, RUSTUP_TOOLCHAIN) is for
  // the task to name and key. Nor is a proxy: a setting, and it may hold a
  // login a replayed log would show.
  'RUSTUP_HOME',
  'CARGO_HOME',
  'GOPATH',
  'GOMODCACHE',
  'GOCACHE',
  // The XDG base directories, machine paths as HOME is. Stripped, a task
  // resolved other homes than the shell did: pnpm used another store, and
  // a CLI keeping its login there ran signed out (vercel/turborepo#13145).
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
]

/**
 * `PATH` less each `node_modules/.bin` inside `workspaceRoot`. `npm run`
 * in a member puts that member's bins, its parents' and the root's on the
 * PATH vx inherits; a task that kept them ran a sibling's bin, which no
 * key sees. A task gets back the two it may see (`taskBinDirs`). Inside
 * by spelling, or by canonical path: an entry spelled through a symlink
 * (macOS's `/tmp`, a linked home, a shell's `$PWD`) kept a sibling's bin
 * beside a canonical root.
 */
export function withoutWorkspaceBins(PATH: string, workspaceRoot: string): string {
  const bin = `${path.sep}node_modules${path.sep}.bin`
  const within = (dir: string, root: string): boolean =>
    dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
  let root: string | undefined
  return PATH.split(path.delimiter)
    .filter((entry) => {
      const dir = entry.endsWith(path.sep) ? entry.slice(0, -1) : entry
      if (!dir.endsWith(bin)) return true
      if (within(dir, workspaceRoot)) return false
      // Relative, it is the task's cwd's: not a place this check can name.
      if (!path.isAbsolute(dir)) return true
      const real = canonical(dir)
      if (real === undefined) return true
      root ??= canonical(workspaceRoot) ?? workspaceRoot
      return !within(real, root)
    })
    .join(path.delimiter)
}

/**
 * `p`'s canonical spelling; undefined when it is not there, and a missing
 * directory on PATH resolves nothing. Asked per call, never memoized: a
 * task may create the bin directory (an install) or a link above it, and a
 * fact about a file a task can write is not reused across tasks.
 */
function canonical(p: string): string | undefined {
  // A stat, not a throw: most such entries are npm's ancestors of the
  // root, and an ENOENT thrown per entry was 3 µs a spawn each.
  if (!existsSync(p)) return undefined
  try {
    return realpathSync.native(p)
  } catch {
    return undefined
  }
}

/**
 * `source[name]` when `source` holds it itself. Bun's `process.env`
 * inherits `Object.prototype`: an unset `constructor` or `toString` read
 * as a function, reached a task's env and crashed vx (`.includes`).
 */
export function ownEnv(source: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.hasOwn(source, name) ? source[name] : undefined
}

/** The variables a pipeline's `env` set: vx's and its plugins', never a task's. */
const vxOnly = new Set<string>()

/** Set `name` for vx and its plugins only: every task reads it as unset. */
export function setVxOnlyEnv(name: string, value: string): void {
  process.env[name] = value
  vxOnly.add(name)
  forgetEnvMatches()
}

const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Why `pattern`, an env name holding `*`, is refused, or null. `*` is the one wildcard. */
export function envPatternProblem(pattern: string): string | null {
  if (/^\*+$/.test(pattern)) return 'matches every variable: list the names or a prefix (VITE_*)'
  if (!/^[A-Za-z0-9_*]+$/.test(pattern))
    return 'holds a character no variable name has: a pattern is letters, digits, _ and *'
  if (/^[0-9]/.test(pattern)) return 'starts with a digit, as no variable name does'
  return null
}

function patternRegex(pattern: string): RegExp {
  return new RegExp(`^${pattern.split(/\*+/).map(RegExp.escape).join('[A-Za-z0-9_]*')}$`)
}

/**
 * The run's variable names and each pattern's matches among them. A run
 * matches each pattern once (`forgetEnvMatches` opens the next run), so its
 * key and its spawn agree on the names.
 */
let envNamesNow: readonly string[] | undefined
const envMatches = new Map<string, readonly string[]>()

/** Start matching patterns afresh: a new run, or vx's own env changed. */
export function forgetEnvMatches(): void {
  envNamesNow = undefined
  envMatches.clear()
}

/**
 * `names` with each `*` pattern replaced by the variables of `taskEnvSource()`
 * it matches (shell names only: `sh` drops the rest), sorted, each once.
 */
export function expandEnvNames(names: readonly string[]): readonly string[] {
  if (!names.some((n) => n.includes('*'))) return names
  const out = new Set<string>()
  for (const name of names) {
    if (!name.includes('*')) {
      out.add(name)
      continue
    }
    let hits = envMatches.get(name)
    if (hits === undefined) {
      envNamesNow ??= Object.keys(taskEnvSource()).filter((n) => SHELL_NAME.test(n))
      const re = patternRegex(name)
      hits = envNamesNow.filter((n) => re.test(n))
      envMatches.set(name, hits)
    }
    for (const n of hits) out.add(n)
  }
  return [...out].sort()
}

/**
 * Whether every variable `entry` (a name or a pattern) names, `cover` names
 * too. A star of `entry` is matched only by a star of `cover`.
 */
export function envCovers(cover: string, entry: string): boolean {
  if (!cover.includes('*')) return cover === entry
  if (!entry.includes('*')) return patternRegex(cover).test(entry)
  const c = cover.replace(/\*+/g, '*')
  const e = entry.replace(/\*+/g, '*')
  const memo = new Map<number, boolean>()
  const at = (i: number, j: number): boolean => {
    if (i === c.length) return j === e.length
    const k = i * (e.length + 1) + j
    const known = memo.get(k)
    if (known !== undefined) return known
    const r =
      c[i] === '*'
        ? at(i + 1, j) || (j < e.length && at(i, j + 1))
        : j < e.length && c[i] === e[j] && e[j] !== '*' && at(i + 1, j + 1)
    memo.set(k, r)
    return r
  }
  return at(0, 0)
}

/** `process.env` as a task reads it: its spawn, its key and its run's key. */
export function taskEnvSource(): NodeJS.ProcessEnv {
  if (vxOnly.size === 0) return process.env
  const out: NodeJS.ProcessEnv = { ...process.env }
  for (const name of vxOnly) delete out[name]
  return out
}
