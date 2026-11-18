// One workspace copy per runner. A runner's writes must never reach the
// outputs another one is timed against: Turbo rewrites every output on a warm
// hit, so a vx "noop" timed in the same tree found them changed and restored
// all of them (pr-bench, 2026-10-28).
import { statSync } from 'node:fs'
import path from 'node:path'
import { benchEnv } from './bench-env.js'

/**
 * `cp -a` (never tar: it drops sub-second mtimes), then the index refreshed
 * under the bench's git config: a copy has new ctimes, so until then git
 * vouches for no file and every status re-reads them all. The refresh waits
 * for the next second: an index written in the second its entries' ctimes
 * fall in, over older mtimes, is one git cannot see a same-second rewrite
 * in, so vx trusted none of its OIDs and hashed every input from disk (14
 * stats a file a cold 9,603-task run against 5, 2026-11-11). A checkout
 * leaves no such entry. The copies run side by side, with one wait for
 * them all: in turn, the site's workspace took 9 s a copy (2026-11-18).
 */
export async function copyWorkspaces(src: string, dsts: readonly string[]): Promise<void> {
  const sh = async (cmd: string[], cwd: string): Promise<void> => {
    const p = Bun.spawn(cmd, { cwd, env: benchEnv(), stdout: 'ignore', stderr: 'pipe' })
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited])
    if (code !== 0) throw new Error(`${cmd.join(' ')} failed:\n${err}`)
  }
  await Promise.all(dsts.map((dst) => sh(['cp', '-a', src, dst], process.cwd())))
  await Bun.sleep(1000 - (Date.now() % 1000) + 50)
  await Promise.all(dsts.map((dst) => sh(['git', 'update-index', '-q', '--refresh'], dst)))
}

/** Every `packages/<p>/dist` file's mtime in ms, by workspace-relative path. */
export function outputMtimes(ws: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const rel of new Bun.Glob('packages/*/dist/**').scanSync({ cwd: ws, dot: true })) {
    out[rel] = statSync(path.join(ws, rel)).mtimeMs
  }
  return out
}
