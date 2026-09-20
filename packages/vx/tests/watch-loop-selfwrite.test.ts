// A task that rewrites a file with DIFFERENT bytes every run — a pid file,
// a timestamped log — is the one undeclared write the state gate cannot
// settle (item 237). Git-ignored, it never starts a cycle: no cache key
// can see it, so a cycle could change nothing. Not ignored and not
// declared, the loop re-runs on it — and after three such cycles in a
// row watch says which path and why, once.
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  SETTLE_MS,
  executions,
  initialOnly,
  startWatch,
  until,
  useWatchFixture,
} from './helpers/watch-loop.js'

const NOTICE = 'has started 3 cycles in a row'

describe('vx watch loop (e2e): a file the task rewrites every run', () => {
  const f = useWatchFixture()

  const selfWriting = (log: string): string =>
    `export default { tasks: { build: { exec: { command: 'echo $$ >> run.pid; mkdir -p dist; cat src/*.txt > dist/out.txt; echo run >> ${log}' } } } }\n`

  it('git-ignored, it never starts a cycle: the edit cycle and its follower, then quiet', async () => {
    await writeFile(path.join(f.dir, 'vx.config.mjs'), selfWriting(f.log))
    if (!existsSync(path.join(f.root, '.git')))
      Bun.spawnSync(['git', 'init', '-q'], { cwd: f.root })
    await writeFile(path.join(f.root, '.gitignore'), 'run.pid\n')
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    await Bun.sleep(SETTLE_MS)
    await initialOnly(w, f.log)

    // The edit cycle and the one redundant follower an undeclared
    // `dist/out.txt` costs (`watch-loop-uncached.test.ts`): three
    // executions, two cycles — and the follower is dist's, never the
    // pid file's. One number for both delivery modes since item 482;
    // the polling fallback used to report two because it never descended
    // into `dist` at all, not because it coalesced the follower.
    // Differential: without the git-ignore gate the pid file's new bytes
    // start a cycle, whose pid file starts the next — executions climb
    // past 3 inside the settle window (29 cycles in 8 s, measured; 24 in
    // 6 s under polling, measured 2026-09-20).
    const runs = 3
    await writeFile(path.join(f.dir, 'src', 'a.txt'), 'a2\n')
    await until(async () => (await executions(f.log)) === runs, 'the edit cycle and its follower')
    await Bun.sleep(SETTLE_MS)
    expect(await executions(f.log)).toBe(runs)
    expect(w.cycles()).toBe(runs - 1)
    expect(w.out()).toContain('vx watch: app dist/out.txt; re-running...')
    expect(w.out()).not.toContain('run.pid; re-running')
  }, 40_000)

  it('not ignored and not declared, the loop re-runs on it and says so once', async () => {
    await writeFile(path.join(f.dir, 'vx.config.mjs'), selfWriting(f.log))
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    await Bun.sleep(SETTLE_MS)
    await initialOnly(w, f.log)

    await writeFile(path.join(f.dir, 'src', 'a.txt'), 'a2\n')
    await until(async () => (await executions(f.log)) >= 6, 'the self-started cycles')
    expect(w.out()).toContain('vx watch: app run.pid; re-running...')
    await until(() => w.out().includes(NOTICE), 'the notice')
    await Bun.sleep(SETTLE_MS)
    // Once: the storm goes on (the remedy is the user's), the line does not.
    expect(w.out().split(NOTICE).length - 1).toBe(1)
    expect(w.out()).toContain('add it to .gitignore')
  }, 40_000)
})
