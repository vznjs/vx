// What `vx-migrate` does around the mapping so the repo runs vx after it:
// which kind of adoption (native configs, or the runner's config read live),
// and installing vx with the repo's own package manager (solidjs/solid,
// 2026-10-04: the configs were written with no vx installed to run them).
// The repo's own scripts are never edited (owner, 2026-10-06).

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
