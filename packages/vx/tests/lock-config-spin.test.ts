// A config spinning in a loop held vx lock against Ctrl-C and SIGTERM: the
// stop handlers ran on the event loop, which the loop never yielded, so
// only SIGKILL ended it (a CI cancel waited out its grace period).

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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  it(`${signal} ends vx lock while a config spins`, async () => {
    const r = (root = await makeWorkspace({ prefix: 'vx-lock-spin-' }))
    const marker = path.join(r, 'evaluating')
    await addProject(
      r,
      'a',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')\n` +
        `while (true) {}\n` +
        `export default { tasks: {} }\n`,
    )
    const child = Bun.spawn(['bun', BIN, 'lock'], { cwd: r, stdout: 'pipe', stderr: 'pipe' })
    const until = Date.now() + 15_000
    while (!(await Bun.file(marker).exists()) && Date.now() < until) await Bun.sleep(5)
    child.kill(signal)
    const ended = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(5_000).then(() => false),
    ])
    if (!ended) child.kill('SIGKILL')
    expect(ended).toBe(true)
    expect(child.signalCode).toBe(signal)
  }, 30_000)
}
