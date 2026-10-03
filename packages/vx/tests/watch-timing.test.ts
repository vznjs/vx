// `VX_TIMING` under `vx watch`: the stage table is per cycle. The marks
// lived for the process, so each cycle's table reprinted every earlier
// cycle's rows, and its `startup` row ran from the previous one's last
// mark, the idle wait included (1.4 s and 3.4 s for a 10 ms cycle).

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { startWatch, until, useWatchFixture } from './helpers/watch-loop.js'

const TABLE = '[vx timing]  stage'

const stageRows = (table: string): string[] =>
  table
    .split('\n')
    .slice(1)
    .filter((l) => l.startsWith('             ') && /ms\s+[\d.]+ms$/.test(l))
    .map((l) => l.trim().split(/\s{2,}/)[0]!)

describe('vx watch with VX_TIMING', () => {
  const f = useWatchFixture()

  it("a cycle's table holds that cycle's stages alone, timed from its own start", async () => {
    f.watch = startWatch(f.root, ['--all'], { VX_TIMING: '1' })
    const w = f.watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    await until(() => w.err().includes(TABLE), 'the initial table')
    const idleFrom = Date.now()
    await Bun.sleep(1_000)
    await writeFile(path.join(f.dir, 'src', 'a.txt'), 'a2\n')
    await until(() => w.err().split(TABLE).length === 3, 'the cycle table')
    const idle = Date.now() - idleFrom
    const [, first, second] = w.err().split(TABLE)
    const rows = stageRows(second!)
    expect(rows.filter((r) => r === 'startup')).toEqual(['startup'])
    expect(rows).toEqual(stageRows(first!))
    const startup = second!.split('\n').find((l) => l.trim().startsWith('startup '))!
    const ms = Number(/startup\s+([\d.]+)ms/.exec(startup)![1])
    expect(ms).toBeLessThan(idle)
  }, 40_000)
})
