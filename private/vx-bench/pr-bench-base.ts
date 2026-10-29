// The per-PR bench's second yardstick: the base commit's own vx, built in
// the same job and timed beside this checkout's. The Turbo ratio alone held
// at 1.3× let main grow slower run by run (10-25 to 10-29) with every PR
// passing; a base timed on the same box at the same minute is the reference
// that moves with nothing but the change.

import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** A held arm's vx past its base × this fails: three local checks of one change read restore at 0.96 to 1.09 of its base. */
export const BASE_TOLERANCE = 1.15

/** The held arms whose vx time grew past the tolerance over the base's. */
export function baseFails(
  best: Readonly<Record<string, { vx: number; base?: number | undefined }>>,
  held: readonly string[],
): string[] {
  const fails: string[] = []
  for (const arm of held) {
    const b = best[arm]
    if (b?.base === undefined || b.vx <= b.base * BASE_TOLERANCE) continue
    fails.push(
      `${arm}: vx ${b.vx.toFixed(0)} ms against the base's ${b.base.toFixed(0)} ms, past ${BASE_TOLERANCE}× it`,
    )
  }
  return fails
}

/**
 * The base commit's vx, compiled as this checkout's is, to `outfile`:
 * `packages/vx` at `sha` comes out of git's objects (`git archive`), so no
 * worktree is written into the repository. Throws when the commit is not
 * in the clone: a base the job was told to time and could not is a broken
 * job, not a pass.
 */
export function buildBase(repo: string, sha: string, outfile: string): void {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`VX_BENCH_BASE is not a commit sha: ${sha}`)
  const src = mkdtempSync(path.join(os.tmpdir(), 'vx-prbench-base-'))
  try {
    const run = (cmd: string[], cwd: string): void => {
      const r = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
      if (r.exitCode !== 0)
        throw new Error(`${cmd.join(' ')} failed:\n${r.stderr.toString().slice(-2000)}`)
    }
    run(['git', 'cat-file', '-e', `${sha}^{commit}`], repo)
    run(['sh', '-c', `git archive --format=tar ${sha} packages/vx | tar -x -C "${src}"`], repo)
    // Its dependencies are this checkout's install, reached through the
    // bench's own link to core (the sandbox grants that path, not
    // packages/vx): a base that moved one is timed with the head's copy, as
    // no lockfile lives in packages/vx.
    symlinkSync(
      path.join(import.meta.dir, 'node_modules/@vzn/vx/node_modules'),
      path.join(src, 'packages/vx/node_modules'),
    )
    run(
      [
        'bun',
        'build',
        '--compile',
        '--minify',
        '--bytecode',
        path.join(src, 'packages/vx/src/bin.ts'),
        '--outfile',
        outfile,
      ],
      src,
    )
  } finally {
    rmSync(src, { recursive: true, force: true })
  }
}
