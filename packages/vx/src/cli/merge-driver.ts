// `.vx/.gitattributes` names the `vx-lock` merge driver for both locks; git
// reads a driver's command from the clone's own config, never from a
// committed file, so `vx lock` (and `vx init` through it) writes it there.
// Unregistered, git merges the locks as text.

import { executablePath, gitEnv } from '../util/index.js'

/**
 * The command git runs: this vx, as it was started, so a clone needs nothing
 * on PATH. git keeps it, so it can outlive what it names (bun upgraded away,
 * the checkout moved, the bunx cache cleared); then git's own text merge runs
 * instead, whose conflict markers a run refuses. A command that could not
 * start left ours with no marker, and the lock lost the other side.
 */
function mergeDriverCommand(): string {
  const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
  // A compiled binary's entry is inside it.
  const self = Bun.main.startsWith('/$bunfs/') || Bun.main.startsWith('B:/~BUN/')
  const there = self
    ? `[ -x ${quote(process.execPath)} ]`
    : `[ -x ${quote(process.execPath)} ] && [ -f ${quote(Bun.main)} ]`
  const vx = self ? quote(process.execPath) : `${quote(process.execPath)} ${quote(Bun.main)}`
  return `if ${there}; then exec ${vx} lock --merge %O %A %B %P; fi; exec git merge-file -L ours -L base -L theirs %A %O %B`
}

/** Sets `merge.vx-lock.*` in the clone at `root` when it differs; anything git refuses is skipped. */
export function registerMergeDriver(root: string): void {
  const git = (...args: string[]) => {
    try {
      return Bun.spawnSync({
        cmd: [executablePath('git'), 'config', '--local', ...args],
        cwd: root,
        env: gitEnv(),
        stdout: 'pipe',
        stderr: 'ignore',
      })
    } catch {
      return undefined
    }
  }
  const driver = mergeDriverCommand()
  const now = git('--get', 'merge.vx-lock.driver')
  if (now === undefined || now.stdout.toString().trimEnd() === driver) return
  // Outside a clone `--get` fails as an unset key does: the set fails too.
  if (git('merge.vx-lock.driver', driver)?.exitCode === 0)
    git('merge.vx-lock.name', 'vx lock: merges the locks by project')
}
