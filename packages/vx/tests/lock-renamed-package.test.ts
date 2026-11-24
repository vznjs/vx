// A package renamed in its package.json keeps its locked name until
// `vx lock` (the `discover` stage is locked). Naming it by the new name
// said "no projects declare a2#build" and hinted the old name, not the fix.
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { BIN, vxSync } from './helpers/vx.js'

const vx = (cwd: string, ...args: string[]) => vxSync(cwd, args, { bin: BIN })
const config = "export default { tasks: { build: { exec: { command: 'echo a' } } } }\n"

it('naming a package by the name its package.json took since the lock asks for `vx lock`', async () => {
  const root = await makeWorkspace({ prefix: 'vx-lock-renamed-' })
  try {
    await addProject(root, 'a', config)
    expect(vx(root, 'lock').code).toBe(0)
    await writeFile(
      path.join(root, 'packages/a/package.json'),
      JSON.stringify({ name: 'a2', version: '0.0.0' }),
    )
    const line = 'packages/a/package.json names it "a2", the lock "a" — run `vx lock`'
    for (const args of [
      ['run', 'a2#build'],
      ['run', '--filter', 'a2', 'build'],
      ['show', 'a2'],
      ['show', 'a2#build'],
    ]) {
      const r = vx(root, ...args)
      expect(`${args.join(' ')} ${r.code} ${r.err.includes(line)}`).toBe(`${args.join(' ')} 1 true`)
    }
    expect(vx(root, 'lock').code).toBe(0)
    expect(vx(root, 'run', 'a2#build').code).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('a project named by its path is not hinted by its package.json name', async () => {
  const root = await makeWorkspace({ prefix: 'vx-lock-renamed-', workspaceFile: false })
  try {
    await addProject(root, 'a', config)
    expect(vx(root, 'lock').code).toBe(0)
    const r = vx(root, 'run', 'a#build')
    expect(r.code).toBe(1)
    expect(r.err).not.toContain('package.json names it')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
