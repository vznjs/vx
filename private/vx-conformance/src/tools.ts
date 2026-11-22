// Where each tool under test is installed. The rivals run at npm's latest,
// installed once per process right before a run and never pinned
// (2026-11-21): the site scores what a user gets today. The install starts
// from an empty cache, so nothing older is reused. vx is this checkout.
import { realpathSync, rmSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const LATEST = ['turbo', 'nx', 'vite-plus', '@moonrepo/cli']

const LOCAL = path.join(import.meta.dir, '..', 'node_modules')
// Inside this package: the sandbox mounts its own /tmp over the host's, so a
// tool installed there would be no file to the runs that link it. One
// directory per process: two runs at once must not empty each other's tools.
const ROOT = path.join(LOCAL, `.latest-${process.pid}`)
let latest: string | undefined

/** Install `pkgs` (some of {@link LATEST}) at npm's latest into an emptied directory. */
export async function installLatest(pkgs: string[]): Promise<void> {
  if (pkgs.length === 0) return
  const root = ROOT
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, 'package.json'), '{ "private": true }\n')
  const specs = pkgs.map((p) => `${p}@latest`)
  const proc = Bun.spawn([process.execPath, 'add', ...specs], {
    cwd: root,
    env: { ...process.env, BUN_INSTALL_CACHE_DIR: path.join(root, '.bun-cache') },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`bun add ${specs.join(' ')} failed:\n${out}${err}`)
  latest = path.join(root, 'node_modules')
  process.on('exit', () => rmSync(root, { recursive: true, force: true }))
}

/** The node_modules directory `pkg` is installed in. */
export function modulesOf(pkg: string): string {
  if (!LATEST.includes(pkg)) return LOCAL
  if (latest === undefined) throw new Error(`${pkg}: installLatest() first`)
  return latest
}

/** The real path of `pkg`'s installed directory. */
export function pkgDir(pkg: string): string {
  return realpathSync(path.join(modulesOf(pkg), pkg))
}
