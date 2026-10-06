import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

// Build the environment exposed to a task.
//
// Layers, lowest to highest priority:
//   1. Essentials (hard-coded allowlist for shell tooling).
//   2. passThrough: parent process.env values for the named vars.
//   3. define: explicit name=value pairs from the task config.
//   4. binPaths prepended to PATH (after all the above resolve PATH).

/**
 * Exported so the schema doc's enumeration of it can be PINNED against the
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
]

/**
 * The two variables vx sets on every task it spawns, over the layers
 * above: the workspace root the run is in and the `project#task` running.
 * `run()` reads them back so a task that shells out to `vx run` in its OWN
 * workspace is refused before it forks without bound (a different
 * workspace — a fixture, a benchmark — is fine). Not in the allowlist:
 * they come from this run, never from the parent environment.
 */
export const VX_RUN_WORKSPACE_ENV = 'VX_RUN_WORKSPACE'
export const VX_RUN_TASK_ENV = 'VX_RUN_TASK'

export interface BuildEnvOptions {
  passThrough: readonly string[]
  define: Readonly<Record<string, string>>
  source: NodeJS.ProcessEnv
  /**
   * Directories prepended to the child's PATH (highest priority first).
   * Used to expose the project's own `node_modules/.bin` so user commands
   * (`oxlint`, `tsc`, `vitest`, …) resolve without a PM wrapper. Matches
   * vite-task's behavior — explicit per-project bin, no tree walk, so
   * sibling projects' bins stay invisible per the project-isolation rule.
   * One holding `path.delimiter` is left out: PATH cannot name it.
   */
  binPaths?: readonly string[]
}

export function buildIsolatedEnv(opts: BuildEnvOptions): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}

  for (const name of ESSENTIAL_ENV) {
    const value = opts.source[name]
    if (value !== undefined) out[name] = value
  }
  for (const name of opts.passThrough) {
    const value = opts.source[name]
    if (value !== undefined) out[name] = value
  }
  for (const [name, value] of Object.entries(opts.define)) {
    out[name] = value
  }
  // A task's output is a pipe, so a tool asks no TTY and prints plain. vx
  // forces colour, as Nx and Turbo do, and strips it where its own output
  // is plain (`plainOutput`), so the cache holds one form for every
  // machine. Any FORCE_COLOR the task already sees, or a NO_COLOR, wins.
  if (out['FORCE_COLOR'] === undefined && !out['NO_COLOR']) out['FORCE_COLOR'] = '1'

  // A directory holding the delimiter cannot be named in PATH: split, it
  // became two entries naming nothing, the second RELATIVE, so resolved
  // against the task's cwd. The 127 verdict says why it is missing.
  const bins = opts.binPaths?.filter((dir) => !dir.includes(path.delimiter)) ?? []
  if (bins.length > 0) {
    const prefix = bins.join(path.delimiter)
    out['PATH'] = out['PATH'] ? `${prefix}${path.delimiter}${out['PATH']}` : prefix
  }

  return out
}

/**
 * `npm_execpath`, as the workspace's package manager sets it for a script.
 * A tool that runs other scripts reads it to call the same manager back
 * (npm-run-all's `run-s`, `run-p`) and falls back to `npm` without it:
 * solidjs/solid's `npm-run-all -nl build:*` needed a global npm under vx,
 * where `pnpm run build` passed (owner, 2026-10-06). It names a binary on
 * this machine, so it is not in the key, as PATH is not.
 */
export const PM_EXEC_ENV = 'npm_execpath'

const MANAGERS = ['pnpm', 'yarn', 'bun', 'npm'] as const
const LOCKFILES: ReadonlyArray<readonly [string, (typeof MANAGERS)[number]]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
]

const managerPaths = new Map<string, string | null>()

/**
 * The executable of the workspace's package manager: the root
 * package.json's `packageManager`, else its lockfile, found on the root's
 * `node_modules/.bin` and PATH. Learned once per root; null when the root
 * names none or this machine has none.
 */
export function packageManagerPath(root: string): string | null {
  const known = managerPaths.get(root)
  if (known !== undefined) return known
  let name: string | undefined
  try {
    const field = (
      JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
        packageManager?: unknown
      }
    ).packageManager
    if (typeof field === 'string') name = MANAGERS.find((m) => field.startsWith(`${m}@`))
  } catch {}
  name ??= LOCKFILES.find(([f]) => existsSync(path.join(root, f)))?.[1]
  const found =
    name === undefined
      ? null
      : Bun.which(name, {
          PATH: [path.join(root, 'node_modules', '.bin'), process.env['PATH'] ?? ''].join(
            path.delimiter,
          ),
        })
  managerPaths.set(root, found)
  return found
}
