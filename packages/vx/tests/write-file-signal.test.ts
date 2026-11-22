// Ctrl-C during `vx lock` left `vx.lock.json.tmp-*` beside the review copies
// (161 after 15 interrupts in an 800-project workspace): the default SIGINT
// action ends the process with no exit hook, and `git status` then offered
// the temps for commit.
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'

const HELPER = path.join(import.meta.dir, 'helpers', 'write-interrupted.ts')
let root = ''
afterEach(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true })
})

it.each(['SIGINT', 'SIGTERM'] as const)(
  'a %s mid-write leaves no temp file, and vx dies of it',
  async (signal) => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-wsig-'))
    // 32 MiB a file: nearly all the loop's time is inside a write, temp open.
    const child = Bun.spawn(['bun', HELPER, root, String(32 * 1024 * 1024)], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const reader = child.stdout.getReader()
    await reader.read()
    // Until a temp stands: the signal lands while one is being written.
    const until = Date.now() + 10_000
    while (!(await readdir(root)).some((n) => n.includes('.tmp-')) && Date.now() < until)
      await Bun.sleep(1)
    child.kill(signal)
    await child.exited
    expect(child.signalCode).toBe(signal)
    expect((await readdir(root)).filter((n) => n.includes('.tmp-'))).toEqual([])
  },
  20_000,
)
