// `vx dte init`: the whole CI of a distributed run, written from
// `dte()` itself: the run's job and its workers', never copied by hand.
// Each adapter writes its own (`DteAdapter.init`); one that starts workers
// on this machine (`local()`, `docker()`) needs none.

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { UserError, type Platform } from '@vzn/vx'

export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm'

/** What `vx dte init` hands an adapter that writes CI files. */
export interface DteSetup {
  readonly workspaceRoot: string
  /** The relay `dte()` names, if any. */
  readonly relay?: string
  /** `dte()`'s sizes in declared order, with the platform each names. */
  readonly sizes: readonly { readonly name: string; readonly platform?: Platform }[]
  /** The workspace's package manager, by its lockfile. */
  readonly manager: PackageManager
  /** The tasks a push to the default branch runs (with `--all`) and a change request runs (with `--affected`), space separated; '' is none named yet, so the run fails until they are. */
  readonly tasks: { readonly main: string; readonly change: string }
  /** `owner/repo` (a GitLab project's full path) of the `origin` remote, if it has one. */
  readonly repository?: string
}

/** What an adapter's `init` gives back: files to write (workspace-relative path to text), then lines to print. */
export interface DteInit {
  readonly files: Readonly<Record<string, string>>
  readonly next: readonly string[]
}

/** `owner/repo` of the `origin` remote: what the relay's ALLOW names. */
export function repositoryOf(root: string): string | undefined {
  const r = Bun.spawnSync(['git', 'config', '--get', 'remote.origin.url'], { cwd: root })
  const url = r.exitCode === 0 ? r.stdout.toString().trim() : ''
  const m = /[:/]([^:]+?\/[^/]+?)(?:\.git)?\/?$/.exec(url.replace(/^[a-z+]+:\/\/[^/]+\//, '/'))
  return m?.[1]
}

const TASKS = /^[\w@/#.:*-]+( [\w@/#.:*-]+)*$/

/**
 * Asks, in a terminal, what main runs and what a change request runs (main's
 * by default). Elsewhere none are named, and the written run fails until
 * its owner names them.
 */
export function askTasks(): { main: string; change: string } {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return { main: '', change: '' }
  const ask = (q: string, fallback: string): string => {
    const a = (prompt(q) ?? '').trim().replace(/\s+/g, ' ') || fallback
    if (a !== '' && !TASKS.test(a))
      throw new UserError(`vx dte init: ${JSON.stringify(a)} is not a list of task names`)
    return a
  }
  const main = ask('Tasks to run on main (such as build test):', '')
  const change = ask(
    `Tasks to run on a pull or merge request${main === '' ? '' : ` [${main}]`}:`,
    main,
  )
  return { main, change }
}

export function managerOf(root: string): PackageManager {
  const has = (f: string): boolean => existsSync(path.join(root, f))
  if (has('pnpm-lock.yaml')) return 'pnpm'
  if (has('bun.lock') || has('bun.lockb')) return 'bun'
  if (has('yarn.lock')) return 'yarn'
  if (has('package-lock.json') || has('npm-shrinkwrap.json')) return 'npm'
  throw new UserError(
    'vx dte init: no lockfile at the workspace root (bun.lock, pnpm-lock.yaml, yarn.lock, package-lock.json): workers install from it',
  )
}

/** The frozen install a fresh runner does, as shell lines. */
export function installLines(manager: PackageManager): readonly string[] {
  if (manager === 'bun') return ['bun install --frozen-lockfile']
  if (manager === 'pnpm') return ['pnpm install --frozen-lockfile']
  if (manager === 'yarn') return ['corepack enable', 'yarn install --immutable']
  return ['npm ci']
}

/** How a runner calls the workspace's own vx: Yarn's PnP has no `node_modules/.bin`. */
export function vxCommand(manager: PackageManager): string {
  return manager === 'yarn' ? 'yarn vx' : 'bun vx'
}

/**
 * Writes what `init` returned. A file that exists with other bytes is kept
 * (a step its owner added, such as a cache restore) unless `force`.
 */
export async function writeInit(
  root: string,
  init: DteInit,
  force: boolean,
  out: (line: string) => void,
): Promise<number> {
  const kept: string[] = []
  for (const [rel, text] of Object.entries(init.files)) {
    const at = path.join(root, rel)
    const had = await readFile(at, 'utf8').catch(() => undefined)
    if (had === text) {
      out(`vx dte init: ${rel} is up to date`)
      continue
    }
    if (had !== undefined && !force) {
      kept.push(rel)
      continue
    }
    await mkdir(path.dirname(at), { recursive: true })
    await writeFile(at, text)
    out(`vx dte init: wrote ${rel}`)
  }
  if (kept.length > 0) {
    throw new UserError(
      `vx dte init: ${kept.join(', ')} already exists with other contents: compare it with vx dte init --dry, or overwrite it with --force`,
    )
  }
  for (const line of init.next) out(line)
  return 0
}
