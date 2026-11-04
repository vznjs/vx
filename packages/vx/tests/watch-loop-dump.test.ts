// A wait on a watch that times out shows what the watch said, and a watch
// that already exited is shown with its code: a Mac flake timed out on the
// watching marker and showed nothing, the watch gone from the dump.
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { startWatch, until } from './helpers/watch-loop.js'

it('a timed-out wait shows a watch that exited, with its code and output', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-dump-'))
  try {
    const w = startWatch(dir)
    const code = await w.proc.exited
    expect(code).not.toBe(0)
    await until(() => w.err() !== '', 'the refusal')
    const error = await until(() => false, 'nothing', 100).catch((e: Error) => e)
    expect(String(error)).toContain(`watch ${w.proc.pid} (exited ${code}) stdout:`)
    expect(String(error)).toContain(w.err().trim().split('\n').at(-1)!)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
