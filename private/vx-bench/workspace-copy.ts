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
 * vouches for no file and every status re-reads them all.
 */
export function copyWorkspace(src: string, dst: string): void {
  for (const cmd of [
    ['cp', '-a', src, dst],
    ['git', 'update-index', '-q', '--refresh'],
  ]) {
    const r = Bun.spawnSync(cmd, { cwd: cmd[0] === 'git' ? dst : process.cwd(), env: benchEnv() })
    if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed:\n${r.stderr.toString()}`)
  }
}

/** Every `packages/<p>/dist` file's mtime in ms, by workspace-relative path. */
export function outputMtimes(ws: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const rel of new Bun.Glob('packages/*/dist/**').scanSync({ cwd: ws, dot: true })) {
    out[rel] = statSync(path.join(ws, rel)).mtimeMs
  }
  return out
}
