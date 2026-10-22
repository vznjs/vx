// `check.build-cold`: every package's build under this machine's sandbox,
// no cache read, as a developer runs it after a fresh clone. Not run
// in this checkout: core refuses `vx run` inside the workspace of the task
// running it (a nested run escapes the outer schedule), so the build runs
// in a detached worktree of HEAD with its own install.
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const repo = path.resolve(import.meta.dir, '..', '..', '..')
const tree = path.join(mkdtempSync(path.join(os.tmpdir(), 'vx-build-cold-')), 'repo')

const run = (cmd: string[], cwd: string): void => {
  const r = Bun.spawnSync(cmd, { cwd, stdio: ['ignore', 'inherit', 'inherit'] })
  if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')} exited ${r.exitCode}`)
}

try {
  run(['git', 'worktree', 'add', '--detach', '--quiet', tree, 'HEAD'], repo)
  run(['bun', 'install', '--frozen-lockfile'], tree)
  run(
    ['bun', 'packages/vx/src/bin.ts', 'run', 'build', '--all', '--cache-policy=local:,remote:'],
    tree,
  )
} finally {
  Bun.spawnSync(['git', 'worktree', 'remove', '--force', tree], { cwd: repo })
  rmSync(path.dirname(tree), { recursive: true, force: true })
}
