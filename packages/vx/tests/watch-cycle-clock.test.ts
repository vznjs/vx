// A cycle's start was read off `Date.now()`, while a file's mtime comes
// from the kernel's coarse clock, which runs up to a tick behind it (and
// further under load; `fsClockNow` in watch-fs.ts has the measurement). A
// write the cycle made in that window carried an mtime BEFORE the start,
// so "written during the last cycle" missed it and the run's own write to
// an ignored file an uncached task reads started a cycle as a user's edit.
// The start is read off the mtime clock now, as the arm is (WD-20).
//
// The lag is made deterministic: `Date.now` runs ahead of the file clock
// by more than a cycle takes to write, as the coarse clock's lag does for
// a write within a tick of the start.

import { readFile, writeFile } from 'node:fs/promises'
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

describe('vx watch cycle window (e2e)', () => {
  const f = useWatchFixture()

  it("a cycle's own write is the run's though the fine clock runs ahead of mtimes", async () => {
    const shim = path.join(path.dirname(f.log), 'clock-ahead.ts')
    await writeFile(shim, 'const real = Date.now\nDate.now = () => real() + 5_000\n')
    await writeFile(path.join(f.dir, '.gitignore'), '.env.local\nshown.txt\n')
    await writeFile(path.join(f.dir, '.env.local'), 'A=1\n')
    await writeFile(
      path.join(f.dir, 'vx.config.mjs'),
      `export default { tasks: {
        show: { exec: { command: 'cat .env.local > shown.txt && echo run >> ${f.log}' } },
      } }\n`,
    )
    f.watch = startWatch(f.root, ['--all'], { BUN_OPTIONS: `--preload ${shim}` }, 'show')
    const w = f.watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    await initialOnly(w, f.log)

    await writeFile(path.join(f.dir, '.env.local'), 'A=2\n')
    await until(async () => (await executions(f.log)) === 2, 'the re-run after the edit')
    expect(await readFile(path.join(f.dir, 'shown.txt'), 'utf8')).toBe('A=2\n')
    await Bun.sleep(SETTLE_MS)
    expect(
      w
        .out()
        .split('\n')
        .filter((l) => l.includes('re-running')),
    ).toEqual(['vx watch: app .env.local; re-running...'])
  }, 40_000)
})
