// The resolved Nx graph, exported by the workspace's own nx: `nx()` keys and
// keeps it, `vx-migrate --from nx` maps it once.

import { existsSync, realpathSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

/**
 * `nx graph --file=<snapshot>` from the workspace's own `nx`. Returns the
 * reason it could not, or null. Nx's daemon setting is the user's: with the
 * daemon up the export is served from memory, without it Nx computes.
 */
export async function exportGraph(root: string, snapshot: string): Promise<string | null> {
  const bin = linkedNx(root)
  const lerna = bin === undefined ? lernasNx(root) : undefined
  if (bin === undefined && lerna === undefined) {
    return `no node_modules/.bin/nx — install nx, or export a graph with \`nx graph --file=<path>\` and pass it as graph: '<path>'`
  }
  // `discover` runs before the run opens (and makes) the cache dir.
  await mkdir(path.dirname(snapshot), { recursive: true })
  const cmd =
    bin !== undefined
      ? [bin, 'graph', `--file=${snapshot}`]
      : ['node', '-e', LERNA_EXPORT, lerna as string, snapshot]
  const proc = Bun.spawn(cmd, { cwd: root, env: process.env, stdout: 'pipe', stderr: 'pipe' })
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (code === 0 && (await Bun.file(snapshot).exists())) return null
  const tail = err.trim().split('\n').slice(-3).join(' ')
  const what = bin !== undefined ? 'nx graph --file' : "Lerna's nx graph export"
  return `${what} exited ${code}${tail ? `: ${tail}` : ''}`
}

// Nx 20+'s bin refuses to run unless `nx` resolves from the workspace root
// ("Could not find Nx modules"), which Lerna's own nx on pnpm does not.
// Lerna calls Nx's API instead (`createProjectGraphAsync`); so does this,
// writing the shape `nx graph --file` writes.
const LERNA_EXPORT = `
const [lerna, file] = process.argv.slice(1)
require('node:module').createRequire(lerna + '/package.json')('nx/src/devkit-exports').createProjectGraphAsync({ exitOnError: false }).then(
  (g) => require('node:fs').writeFileSync(file, JSON.stringify({ graph: { nodes: g.nodes, dependencies: g.dependencies } })),
  (e) => { console.error(e && e.message ? e.message : String(e)); process.exit(1) },
)`

/** Whether the workspace has its own nx: linked, or Lerna's. */
export function hasNx(root: string): boolean {
  return linkedNx(root) !== undefined || lernasNx(root) !== undefined
}

/** The linked bin, else where Nx's wrapper installs it in a repo with no package.json (`.nx/installation`). */
function linkedNx(root: string): string | undefined {
  for (const dir of [root, path.join(root, '.nx', 'installation')]) {
    const bin = path.join(dir, 'node_modules', '.bin', 'nx')
    if (existsSync(bin)) return bin
  }
  return undefined
}

/**
 * Lerna's real directory when the nx Lerna 6+ runs on resolves from it:
 * pnpm links only a root's direct dependencies into `node_modules/.bin`, so
 * a Lerna repo on pnpm has no `nx` there, and `lerna run` uses this one.
 * Nx resolves through its `exports` map (`nx/src/*` is `dist/src/*`).
 */
function lernasNx(root: string): string | undefined {
  try {
    const lerna = realpathSync(path.join(root, 'node_modules', 'lerna'))
    Bun.resolveSync('nx/package.json', lerna)
    return lerna
  } catch {
    return undefined
  }
}
