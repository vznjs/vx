// A defect in vx printed its stack and stopped: the reader was not told
// that the fix is a bug report, nor where to file it.
import { expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

it('a defect in vx ends with where to report it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-internal-'))
  try {
    const preload = path.join(dir, 'break.ts')
    await writeFile(preload, "process.cwd = () => { throw new TypeError('boom') }\n")
    const p = Bun.spawnSync([process.execPath, '--preload', preload, BIN, 'show'], {
      cwd: dir,
      stderr: 'pipe',
    })
    const err = p.stderr.toString()
    expect([p.exitCode, err.split('\n')[0], err.trimEnd().split('\n').at(-1)]).toEqual([
      1,
      'vx: TypeError: boom',
      'vx: this is a bug in vx — report it with the lines above at https://github.com/vznjs/vx/issues',
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
