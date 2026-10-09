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
    return readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
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

/**
 * This package's release version; null in the source tree (`0.0.0`), where
 * nothing is pinned. Every @vzn package releases in lockstep, and each
 * plugin's peer is `^<version>`, which on 0.0.x is that version alone.
 */
export function ownVersion(): string | null {
  const v = (
    JSON.parse(readText(path.join(import.meta.dir, '..', 'package.json')) || '{}') as {
      version?: unknown
    }
  ).version
  return typeof v === 'string' && v !== '0.0.0' ? v : null
}

/**
 * The `wanted` packages the root does not both list and have installed
 * (at `version`, given one). Either alone is not adopted: a reset
 * package.json leaves node_modules behind, and a listing is not an
 * install; on solidjs/solid vx-migrate 0.0.512 skipped @vzn/vx that
 * package.json did not list (owner, 2026-10-06).
 */
export function missingPackages(
  root: string,
  wanted: readonly string[],
  version: string | null = null,
): string[] {
  const listed = new Set(listedPackages(root, wanted))
  return wanted.filter((p) => {
    if (!listed.has(p)) return true
    const installed = readText(path.join(root, 'node_modules', p, 'package.json'))
    if (installed === '') return true
    if (version === null) return false
    return (JSON.parse(installed) as { version?: unknown }).version !== version
  })
}

/** argv that removes `packages` from the root's dev dependencies. */
export function removeArgv(
  root: string,
  pm: PackageManager,
  packages: readonly string[],
): string[] {
  switch (pm) {
    case 'pnpm':
      return ['pnpm', 'remove', '-w', ...packages]
    case 'yarn':
      return readText(path.join(root, 'yarn.lock')).includes('__metadata:')
        ? ['yarn', 'remove', ...packages]
        : ['yarn', 'remove', '-W', ...packages]
    case 'bun':
      return ['bun', 'remove', ...packages]
    case 'npm':
      return ['npm', 'uninstall', ...packages]
  }
}

/** The `packages` the root package.json lists. */
export function listedPackages(root: string, packages: readonly string[]): string[] {
  const pj = JSON.parse(readText(path.join(root, 'package.json')) || '{}') as Record<
    string,
    Record<string, unknown> | undefined
  >
  return packages.filter((p) =>
    ['dependencies', 'devDependencies'].some((f) => pj[f]?.[p] !== undefined),
  )
}

/** Install `packages` (at `version`, given one) with the repo's manager, its output on the terminal. */
export function install(
  root: string,
  packages: readonly string[],
  version: string | null = null,
): Promise<string> {
  const pm = packageManagerOf(root, process.env['npm_config_user_agent'])
  return runManager(
    root,
    installArgv(root, pm, version === null ? packages : packages.map((p) => `${p}@${version}`)),
    'installing vx',
    // pnpm 12 refuses a version younger than minimumReleaseAge, and vx
    // releases daily; its words scroll by above, so the way out is named.
    pm === 'pnpm'
      ? `; if pnpm refused a version published within its minimumReleaseAge, list ${packages.join(', ')} under minimumReleaseAgeExclude in pnpm-workspace.yaml`
      : '',
  )
}

/** Remove `packages` with the repo's manager. */
export function uninstall(root: string, packages: readonly string[]): Promise<string> {
  return runManager(
    root,
    removeArgv(root, packageManagerOf(root, process.env['npm_config_user_agent']), packages),
    `removing ${packages.join(' ')}`,
  )
}

/**
 * The command that runs `argv`'s manager when its name on PATH cannot be
 * spawned: the one that launched us (`npm_execpath`), if it is that
 * manager. Under `pnpm exec`, PATH can hold a pnpm placeholder with no
 * shebang that exec refuses (ENOEXEC), while `npm_execpath` is the pnpm
 * running now. PATH stays first: it is what the user's shell would run.
 */
export function managerArgv(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): string[] {
  const exec = env['npm_execpath']
  const manager = argv[0]!
  if (exec === undefined || exec === '' || !path.basename(exec).startsWith(manager))
    return [...argv]
  // A JS entry (pnpm.cjs, npm-cli.js) runs under the Node that runs it.
  return /\.[cm]?js$/.test(exec) ? ['node', exec, ...argv.slice(1)] : [exec, ...argv.slice(1)]
}

async function runManager(
  root: string,
  argv: string[],
  what: string,
  ranHint = '',
): Promise<string> {
  const line = argv.join(' ')
  process.stdout.write(`vx-migrate: ${line}\n`)
  const spawn = (cmd: string[]) =>
    Bun.spawn(cmd, { cwd: root, stdio: ['inherit', 'inherit', 'inherit'] }).exited
  let code: number
  let why = ''
  try {
    code = await spawn(argv)
  } catch (e) {
    const launcher = managerArgv(argv, process.env)
    try {
      if (launcher[0] === argv[0]) throw e
      code = await spawn(launcher)
    } catch (e2) {
      code = -1
      why = `: ${(e2 as Error).message}`
    }
  }
  if (code !== 0) {
    throw new UserError(
      `${what} failed (${line} exited ${code}${why}); run it, then vx-migrate again${code > 0 ? ranHint : ''}`,
    )
  }
  return line
}
