// What `vx-migrate` does around the mapping so the repo runs vx after it:
// which kind of adoption (native configs, or the runner's config read live),
// installing vx with the repo's own package manager, and pointing the root
// scripts that called the runner at vx (solidjs/solid, 2026-10-04: the
// configs were written, and `pnpm run build` still ran turbo, with no vx
// installed to run them).

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { UserError } from '@vzn/vx'

export type AdoptionMode = 'native' | 'keep'

/** The question a TTY run asks; `null` (no answer, EOF) is the default. */
export const MODE_QUESTION = (runner: 'turbo' | 'nx', source: string) =>
  `${source} found. How should vx run this repo?\n` +
  `  1) native: write a vx.config.ts per package from ${source} (recommended)\n` +
  `  2) keep: keep ${source} as the source; vx reads it on every run through ${runner}()\n` +
  'Choose 1 or 2 [1]:'

/** `1`/`native` (or nothing) → native, `2`/`keep` → keep; anything else asks again. */
export function parseModeAnswer(answer: string | null): AdoptionMode | undefined {
  const a = (answer ?? '').trim().toLowerCase()
  if (a === '' || a === '1' || a === 'native' || a === 'n') return 'native'
  if (a === '2' || a === 'keep' || a === 'k') return 'keep'
  return undefined
}

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm'

const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
]

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * The repo's manager: package.json's `packageManager` (corepack's field),
 * else the lockfile, else the one that started this process, else npm.
 */
export function packageManagerOf(root: string, userAgent?: string): PackageManager {
  const field = (
    JSON.parse(readText(path.join(root, 'package.json')) || '{}') as { packageManager?: unknown }
  ).packageManager
  const declared =
    typeof field === 'string'
      ? (/^(pnpm|yarn|bun|npm)@/.exec(field)?.[1] as PackageManager | undefined)
      : undefined
  if (declared !== undefined) return declared
  const locked = LOCKFILES.find(([f]) => existsSync(path.join(root, f)))?.[1]
  if (locked !== undefined) return locked
  return (
    (/^(pnpm|yarn|bun|npm)\//.exec(userAgent ?? '')?.[1] as PackageManager | undefined) ?? 'npm'
  )
}

/** argv that adds `packages` as root dev dependencies. */
export function installArgv(
  root: string,
  pm: PackageManager,
  packages: readonly string[],
): string[] {
  switch (pm) {
    case 'pnpm':
      return ['pnpm', 'add', '-D', '-w', ...packages]
    case 'yarn':
      // Yarn 1 refuses `add` at a workspace root without `-W`; Berry has no
      // such flag. A Berry lockfile carries `__metadata`.
      return readText(path.join(root, 'yarn.lock')).includes('__metadata:')
        ? ['yarn', 'add', '-D', ...packages]
        : ['yarn', 'add', '-D', '-W', ...packages]
    case 'bun':
      return ['bun', 'add', '-d', ...packages]
    case 'npm':
      return ['npm', 'install', '-D', ...packages]
  }
}

/** The packages a mode's files import that the root neither lists nor has installed. */
export function missingPackages(root: string, mode: AdoptionMode): string[] {
  const pj = JSON.parse(readText(path.join(root, 'package.json')) || '{}') as Record<
    string,
    Record<string, unknown> | undefined
  >
  const listed = (name: string) =>
    ['dependencies', 'devDependencies'].some((f) => pj[f]?.[name] !== undefined)
  const wanted = mode === 'keep' ? ['@vzn/vx', '@vzn/vx-migrate'] : ['@vzn/vx']
  return wanted.filter(
    (p) => !listed(p) && !existsSync(path.join(root, 'node_modules', p, 'package.json')),
  )
}

/** Install `packages` with the repo's manager, its output on the terminal. */
export async function install(root: string, packages: readonly string[]): Promise<string> {
  const argv = installArgv(
    root,
    packageManagerOf(root, process.env['npm_config_user_agent']),
    packages,
  )
  const line = argv.join(' ')
  process.stdout.write(`vx-migrate: ${line}\n`)
  let code: number
  try {
    code = await Bun.spawn(argv, { cwd: root, stdio: ['inherit', 'inherit', 'inherit'] }).exited
  } catch {
    code = -1
  }
  if (code !== 0) {
    throw new UserError(
      `installing vx failed (${line} exited ${code}); run it, then vx-migrate again`,
    )
  }
  return line
}

/**
 * A root script that is only `turbo run <tasks>`, or
 * Nx's `nx run-many -t <tasks>`, as the same run under vx. Flags, a chain or
 * anything else is left alone: only what reads the same both ways is moved.
 */
export function vxScript(command: string): string | undefined {
  const words = command.trim().split(/\s+/)
  let tasks: string[] | undefined
  // `turbo <tasks>` is left: `turbo watch dev` is a verb, not a task.
  if (words[0] === 'turbo' && words[1] === 'run') {
    const rest = words.slice(2)
    if (rest.length > 0 && rest.every((w) => /^[\w:.@/-]+$/.test(w) && !w.startsWith('-')))
      tasks = rest
  } else if (words[0] === 'nx' && words[1] === 'run-many') {
    const rest = words.slice(2)
    if (
      (rest[0] === '-t' || rest[0] === '--target' || rest[0] === '--targets') &&
      rest.length === 2
    )
      tasks = rest[1]!.split(',')
    else if (rest.length === 1 && /^--targets?=/.test(rest[0]!))
      tasks = rest[0]!.replace(/^--targets?=/, '').split(',')
    if (tasks?.some((t) => !/^[\w:.@/-]+$/.test(t))) tasks = undefined
  }
  return tasks === undefined ? undefined : `vx run ${tasks.join(' ')} --all`
}

/**
 * Point the root package.json scripts that call the runner at vx, editing
 * the text in place (key order, indent and the rest kept). Returns each
 * `name: old → new`; writes nothing under `dry`.
 */
export async function rewriteRootScripts(root: string, dry: boolean): Promise<string[]> {
  const file = path.join(root, 'package.json')
  let text = readText(file)
  const scripts = (JSON.parse(text || '{}') as { scripts?: Record<string, unknown> }).scripts ?? {}
  const changed: string[] = []
  for (const [name, value] of Object.entries(scripts)) {
    if (typeof value !== 'string') continue
    const next = vxScript(value)
    if (next === undefined) continue
    const key = JSON.stringify(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const old = JSON.stringify(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(${key}\\s*:\\s*)${old}`)
    if (!re.test(text)) continue
    text = text.replace(re, (_, lead: string) => `${lead}${JSON.stringify(next)}`)
    changed.push(`${name}: ${value} → ${next}`)
  }
  if (!dry && changed.length > 0) await Bun.write(file, text)
  return changed
}
