// vercel/turborepo#14373: a task's output was cut when it exited non-zero.
// A failure prints its whole output, the last line included, in either
// mode that prints failures.
import { rm } from 'node:fs/promises'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { vx } from './helpers/parity.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

let root = ''
beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-failed-output-' })
  await addProject(root, 'app', {
    config: `export default { tasks: { t: { exec: { command: "printf %262144s | tr ' ' x; echo; echo LAST LINE; exit 42" } } } }\n`,
  })
  gitIn(root)('add', '-A')
  gitIn(root)('commit', '-q', '-m', 'init')
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it.each(['full', 'errors-only'])(
  '--output-logs=%s prints all 256 KiB of a failed task and its last line',
  async (mode) => {
    const r = await vx(root, ['run', 't', '--all', `--output-logs=${mode}`])
    const all = r.out + r.err
    expect(r.code).toBe(1)
    expect(all).toContain(`${'x'.repeat(262144)}\nLAST LINE\n`)
    expect(all).toContain('exit 42')
  },
  30_000,
)
