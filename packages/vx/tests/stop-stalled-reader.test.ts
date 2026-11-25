// A frame is written as fast as stdout's reader takes it. A Ctrl-C ends vx
// while a reader that never reads (`vx run | less`, paused) holds a frame,
// and its exit still writes what is queued for a reader that comes late.

import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
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

it('a Ctrl-C exit writes a paced frame and the summary to a late reader', async () => {
  // The exit ended stdout once the run had left, with the frame's rest and
  // the summary still waiting their turn: CI lost END-OF-BIG.
  const r = (root = await makeWorkspace({ prefix: 'vx-late-reader-' }))
  const dir = await addProject(
    r,
    'app',
    `export default { tasks: { big: { exec: {
    command: "trap 'yes | head -c 2097152; echo END-OF-BIG; exit 0' INT; echo $$ > pid.txt; while :; do sleep 0.05; done",
  } } } }`,
  )
  Bun.spawnSync(['bun', BIN, 'lock'], {
    cwd: r,
    env: { ...process.env, VX_LOCK_REVIEW_FILES: 'false' },
  })
  const fifo = path.join(r, 'stdout')
  const got = path.join(r, 'got')
  expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0)
  // Opened read-write, so vx's writes fill the FIFO until the reader comes.
  const out = openSync(fifo, 'r+')
  const child = Bun.spawn([process.execPath, BIN, 'run', 'app#big'], {
    cwd: r,
    env: { ...process.env, VX_RUN_KILL_GRACE: '5000ms', CI: 'true', NO_COLOR: '1' },
    stdout: out,
    stderr: 'pipe',
  })
  closeSync(out)
  const pid = path.join(dir, 'pid.txt')
  const until = Date.now() + 15_000
  while (!(existsSync(pid) && readFileSync(pid, 'utf8').trim() !== '') && Date.now() < until)
    await Bun.sleep(10)
  child.kill('SIGINT')
  await Bun.sleep(500)
  const reader = Bun.spawn(['sh', '-c', `cat < '${fifo}' > '${got}'`])
  expect(await child.exited).toBe(130)
  await reader.exited
  const text = readFileSync(got, 'utf8')
  expect(text).toContain('\nEND-OF-BIG\n')
  expect(text.slice(text.indexOf('\nEND-OF-BIG\n'))).toContain(
    '\n  tasks     1 aborted · 1 total\n',
  )
}, 40_000)
