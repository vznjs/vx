// A failed task's frame is written at the run's end as fast as stdout's
// reader takes it. A reader that never reads (`vx run | less`, paused) held
// vx in that wait, and Ctrl-C did not end it.

import { closeSync, openSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { BIN } from './helpers/vx.js'

let root: string | undefined
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

it('a Ctrl-C ends vx while a stalled reader holds its frames', async () => {
  const r = (root = await makeWorkspace({ prefix: 'vx-stalled-reader-' }))
  const marker = path.join(r, 'packages', 'a', 'printed')
  const command = 'yes x | head -c 16000000; touch printed; exit 1'
  await addProject(
    r,
    'a',
    `export default { tasks: { out: { exec: { command: ${JSON.stringify(command)} } } } }\n`,
  )
  const lock = Bun.spawnSync(['bun', BIN, 'lock'], {
    cwd: r,
    env: { ...process.env, VX_LOCK_REVIEW_FILES: 'false' },
    stderr: 'pipe',
  })
  expect(lock.stderr.toString()).toBe('')
  // vx's stdout is a FIFO its reader holds open and never reads: a pipe
  // Bun spawns is read by Bun.
  const fifo = path.join(r, 'stdout')
  expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0)
  const reader = Bun.spawn(['sh', '-c', `exec sleep 60 < '${fifo}'`])
  const out = openSync(fifo, 'w')
  const child = Bun.spawn(['bun', BIN, 'run', 'a#out', '--no-cache', '--output-logs=errors-only'], {
    cwd: r,
    stdout: out,
    stderr: 'pipe',
  })
  closeSync(out)
  const until = Date.now() + 15_000
  while (!(await Bun.file(marker).exists()) && Date.now() < until) await Bun.sleep(5)
  // Past the task's end, into the frame's write.
  await Bun.sleep(1000)
  child.kill('SIGINT')
  const ended = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(10_000).then(() => false),
  ])
  if (!ended) child.kill('SIGKILL')
  reader.kill('SIGKILL')
  expect({ printed: await Bun.file(marker).exists(), ended }).toEqual({
    printed: true,
    ended: true,
  })
}, 40_000)
