// The resolved Nx graph, exported by the workspace's own nx: `nx()` keys and
// keeps it, `vx-migrate --from nx` maps it once.

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

/**
 * `nx graph --file=<snapshot>` from the workspace's own `nx`. Returns the
 * reason it could not, or null. Nx's daemon setting is the user's: with the
 * daemon up the export is served from memory, without it Nx computes.
 */
export async function exportGraph(root: string, snapshot: string): Promise<string | null> {
  const bin = nxBin(root)
  if (bin === undefined) {
    return `no node_modules/.bin/nx — install nx, or export a graph with \`nx graph --file=<path>\` and pass it as graph: '<path>'`
  }
  // `discover` runs before the run opens (and makes) the cache dir.
  await mkdir(path.dirname(snapshot), { recursive: true })
  const proc = Bun.spawn([bin, 'graph', `--file=${snapshot}`], {
    cwd: root,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (code === 0 && (await Bun.file(snapshot).exists())) return null
  const tail = err.trim().split('\n').slice(-3).join(' ')
  return `nx graph --file exited ${code}${tail ? `: ${tail}` : ''}`
}

/**
 * The workspace's own nx: the linked bin, else where Nx's wrapper installs
 * it in a repo with no package.json (`.nx/installation`), else Lerna's.
 */
export function nxBin(root: string): string | undefined {
  for (const dir of [root, path.join(root, '.nx', 'installation')]) {
    const bin = path.join(dir, 'node_modules', '.bin', 'nx')
    if (existsSync(bin)) return bin
  }
  return lernasNx(root)
}

/**
 * The nx Lerna 6+ runs on, from Lerna's own dependencies: pnpm links only
 * a root's direct dependencies into `node_modules/.bin`, so a Lerna repo
 * on pnpm has no `nx` there, and `lerna run` uses this one.
 */
function lernasNx(root: string): string | undefined {
  try {
    const lerna = realpathSync(path.join(root, 'node_modules', 'lerna'))
    const manifest = Bun.resolveSync('nx/package.json', lerna)
    const bin = (JSON.parse(readFileSync(manifest, 'utf8')) as { bin?: { nx?: unknown } }).bin?.nx
    return typeof bin === 'string' ? path.join(path.dirname(manifest), bin) : undefined
  } catch {
    return undefined
  }
}
