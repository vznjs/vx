// The resolved Nx graph, exported by the workspace's own nx: `nx()` keys and
// keeps it, `vx-migrate --from nx` maps it once.

import { mkdir } from 'node:fs/promises'
import path from 'node:path'

/**
 * `nx graph --file=<snapshot>` from the workspace's own `nx`. Returns the
 * reason it could not, or null. Nx's daemon setting is the user's: with the
 * daemon up the export is served from memory, without it Nx computes.
 */
export async function exportGraph(root: string, snapshot: string): Promise<string | null> {
  const bin = path.join(root, 'node_modules', '.bin', 'nx')
  if (!(await Bun.file(bin).exists())) {
    return `no ${path.relative(root, bin)} — install nx, or export a graph with \`nx graph --file=<path>\` and pass it as graph: '<path>'`
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
