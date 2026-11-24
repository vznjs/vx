// Ctrl-C while `vx lock` evaluated a config printed a stack trace: the stop
// handler's `process.exit(130)` met the guard that refuses a config's own
// `process.exit`, and the guard threw `process.exit(130) in a config`.

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

it('a Ctrl-C while a config evaluates ends vx lock by the signal, with no stack', async () => {
  const r = (root = await makeWorkspace({ prefix: 'vx-lock-sigint-' }))
  const marker = path.join(r, 'evaluating')
  await addProject(
    r,
    'a',
    `await Bun.write(${JSON.stringify(marker)}, '')\n` +
      `await new Promise((r) => setTimeout(r, 20_000))\n` +
      `export default { tasks: { build: { exec: { command: 'true' } } } }\n`,
  )
  const child = Bun.spawn(['bun', BIN, 'lock'], { cwd: r, stdout: 'pipe', stderr: 'pipe' })
  const until = Date.now() + 15_000
  while (!(await Bun.file(marker).exists()) && Date.now() < until) await Bun.sleep(5)
  child.kill('SIGINT')
  await child.exited
  const err = await new Response(child.stderr).text()
  expect(err).toBe('')
  expect(child.signalCode).toBe('SIGINT')
}, 30_000)
