// The watch loop end to end, on markers rather than sleeps (the fixture
// and the markers: `helpers/watch-loop.ts`). The three claims the 2026-07
// parity doc left unpinned (M8, L5, and M7's documented converse): an
// edit re-runs exactly once; a same-content rewrite re-executes nothing;
// a `git checkout` that rewrites many inputs at once is one cycle. The
// member and uncached-output cases are `watch-loop-members.test.ts` and
// `watch-loop-uncached.test.ts`: one file was a 24 s serial chain of
// settle windows, a shard on its own (2026-09-16).

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { PLUGIN_IMPORT, pluginSource } from './helpers/plugin.js'
import { gitIn } from './helpers/workspace.js'
import {
  BIN,
  SETTLE_MS,
  executions,
  initialOnly,
  startWatch,
  until,
  useWatchFixture,
} from './helpers/watch-loop.js'

describe('vx watch loop (e2e)', () => {
  const f = useWatchFixture()

  it('an edit re-runs once; the same bytes again re-execute nothing; a new edit re-runs', async () => {
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    await initialOnly(w, f.log)
    // The cycle's invocation row names the verb, as `vx run`'s does; the
    // process.argv fallback recorded the bin's absolute path in its place.
    const last = Bun.spawnSync([process.execPath, BIN, 'last', '--list'], { cwd: f.root })
    expect(last.stdout.toString()).toContain('$ vx watch build --all')

    await writeFile(path.join(f.dir, 'src', 'a.txt'), 'a2\n')
    await until(async () => (await executions(f.log)) === 2, 'the re-run after an edit')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(1)
    expect(await readFile(path.join(f.dir, 'dist', 'out.txt'), 'utf8')).toBe('a2\n')

    // M8: the same bytes written again are not a change — no cycle at
    // all, so no execution. Without the content gate the loop re-ran
    // (a cache hit, but a cycle) on every such write.
    await writeFile(path.join(f.dir, 'src', 'a.txt'), 'a2\n')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(1)
    expect(await executions(f.log)).toBe(2)

    await writeFile(path.join(f.dir, 'src', 'a.txt'), 'a3\n')
    await until(async () => (await executions(f.log)) === 3, 'the re-run after a second edit')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(2)
  }, 40_000)

  it('an edit to vx.workspace.mjs is one cycle that runs under the new workspace config', async () => {
    // The workspace config is no task's input, so no project arm sees it;
    // its plugins, `config` stage and concurrency shape every cycle all the
    // same. Before 2026-09-10 the root arm listened for fingerprint files
    // only, and a plugin added under `vx watch` waited for a restart.
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    await initialOnly(w, f.log)

    await writeFile(
      path.join(f.root, 'vx.workspace.mjs'),
      `${PLUGIN_IMPORT}export default { plugins: [${pluginSource(
        'org/greeter',
        `{ config(_ws, ctx) { ctx.warn('WS-EDIT-SEEN') } }`,
      )}] }\n`,
    )
    await until(
      () => w.out().includes('WS-EDIT-SEEN'),
      'the cycle under the edited workspace config',
    )
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(1)
    // The config is not key material: the task is a hit under it.
    expect(await executions(f.log)).toBe(1)
  }, 40_000)

  it('a git checkout that rewrites twenty inputs is one cycle with the new content (L5)', async () => {
    const git = gitIn(f.root)
    const names = Array.from({ length: 20 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`)
    for (const n of names) await writeFile(path.join(f.dir, 'src', n), `${n} v1\n`)
    git('add', '-A')
    git('commit', '-q', '-m', 'v1')
    const base = git('branch', '--show-current').trim()
    git('checkout', '-q', '-b', 'feat')
    for (const n of names) await writeFile(path.join(f.dir, 'src', n), `${n} v2\n`)
    git('add', '-A')
    git('commit', '-q', '-m', 'v2')
    git('checkout', '-q', base)

    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    await initialOnly(w, f.log)

    git('checkout', '-q', 'feat')
    await until(async () => (await executions(f.log)) === 2, 'the re-run after the checkout')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(1)
    const out = await readFile(path.join(f.dir, 'dist', 'out.txt'), 'utf8')
    expect(out).toBe(['a1\n', ...names.map((n) => `${n} v2\n`)].join(''))
  }, 40_000)
})
