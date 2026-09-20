// The watch loop under a task with NO cache block, end to end: its own
// writes are undeclared, and the price is one redundant cycle per edit —
// never a loop, with or without a gap between a delete and the rebuild.
// Fixture and markers: `helpers/watch-loop.ts`; the edit-cycle claims are
// `watch-loop.test.ts`.

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

describe('vx watch loop (e2e): undeclared outputs', () => {
  const f = useWatchFixture()

  it('an UNCACHED task that writes into its project costs exactly one extra execution per edit, then quiet', async () => {
    // No cache block declares no outputs, so the task's own `dist/out.txt`
    // is an undeclared write the watcher sees. Its bytes are unknown until
    // seen, and a user's edit during the run is indistinguishable from the
    // task's write without the task's write set — so the price is one
    // redundant cycle per edit (the second run writes the same bytes and
    // the content gate stops it), never a loop. Measured 2026-09-10; the
    // fix is to declare the output. Nothing after the initial run: its
    // write landed before the watchers were armed.
    await writeFile(
      path.join(f.dir, 'vx.config.mjs'),
      `export default { tasks: { build: { exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt && echo run >> ${f.log}' } } } }\n`,
    )
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    await Bun.sleep(SETTLE_MS)
    await initialOnly(w, f.log)
    expect(w.cycles()).toBe(0)

    // One number for BOTH delivery modes. It used to be three under events
    // and two under polling, explained as the edit and the task's own write
    // landing in the same 250 ms sample. That explanation was wrong: the
    // poller never sampled the write at all, because `POLL_SKIP` refused to
    // descend into `dist` whether or not a task declared it (item 482). With
    // the poller reading the run's own ignore filter instead of a hard-coded
    // name, the two watchers report the same tree and cost the same cycles.
    const runs = 3
    await writeFile(path.join(f.dir, 'src', 'a.txt'), 'a2\n')
    await until(
      async () => (await executions(f.log)) === runs,
      'the edit cycle and its one redundant follower',
    )
    await Bun.sleep(SETTLE_MS)
    expect(await executions(f.log)).toBe(runs)
    expect(w.cycles()).toBe(runs - 1)
    expect(w.out()).toContain('vx watch: app dist/out.txt; re-running...')
  }, 40_000)

  it.each([
    ['no gap', ''],
    ['a gap between the delete and the rebuild, as rimraf && tsc has', 'sleep 0.3; '],
  ])(
    'an UNCACHED task that deletes and recreates its output settles after one redundant cycle (%s)',
    async (_shape, gap) => {
      // The shape of most build scripts — `rm -rf dist && tsc` — with no
      // outputs declared. Before this pin the loop never settled: a
      // deletion and a directory each passed the content gate
      // unconditionally, and with a gap the debounce fired mid-run on a
      // `dist` that was gone and not yet rebuilt (2026-09-10, one edit:
      // 780 executions in two minutes). Now a path is judged on its
      // SETTLED state, one window after the run — a directory's entries'
      // names and sizes — so the rebuilt `dist` is the `dist` the loop
      // last saw. Differential: with the gate passing directories
      // through, executions climb past 3 within the settle window.
      await writeFile(
        path.join(f.dir, 'vx.config.mjs'),
        `export default { tasks: { build: { exec: { command: 'rm -rf dist; ${gap}mkdir -p dist; cat src/*.txt > dist/out.txt; echo run >> ${f.log}' } } } }\n`,
      )
      f.watch = startWatch(f.root)
      const w = f.watch
      await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
      await Bun.sleep(SETTLE_MS)
      await initialOnly(w, f.log)

      const runs = 3 // both modes; see the row above
      await writeFile(path.join(f.dir, 'src', 'a.txt'), 'a2\n')
      await until(
        async () => (await executions(f.log)) === runs,
        'the edit cycle and its one redundant follower',
      )
      await Bun.sleep(SETTLE_MS * 2)
      expect(await executions(f.log)).toBe(runs)
      expect(w.cycles()).toBe(runs - 1)
      // The follower is labelled by what arrived — the task's own dist —
      // not by the edit that started the cycle it landed in. Asserted in
      // both modes since item 482: the poller sees the same write now.
      {
        expect(w.out().split('re-running...')[2]).not.toContain('src/a.txt')
        expect(w.out()).toContain('vx watch: app dist')
      }
    },
    40_000,
  )
})
