// Where each tool under test is installed. The rivals run at npm's latest,
// installed once per process right before a run and never pinned
// (2026-11-21): the site scores what a user gets today. The install starts
// from an empty cache, so nothing older is reused. vx is this checkout.
import { realpathSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const LATEST = ['turbo', 'nx', 'vite-plus', '@moonrepo/cli']

const LOCAL = path.join(import.meta.dir, '..', 'node_modules')
let latest: string | undefined

/** Install `pkgs` (some of {@link LATEST}) at npm's latest into a fresh directory. */
export async function installLatest(pkgs: string[]): Promise<void> {
  if (pkgs.length === 0) return
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-conformance-tools-'))
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
