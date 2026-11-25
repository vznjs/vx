// A package renamed in its package.json keeps its locked name until
// `vx lock` (the `discover` stage is locked). A run reads no package.json
// (owner, 2026-11-25: a run reads only the locks), so the new name names
// nothing until `vx lock`.
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { BIN, vxSync } from './helpers/vx.js'

const vx = (cwd: string, ...args: string[]) => vxSync(cwd, args, { bin: BIN })
const config = "export default { tasks: { build: { exec: { command: 'echo a' } } } }\n"

it('a package keeps its locked name until `vx lock`, and its package.json is not read', async () => {
  const root = await makeWorkspace({ prefix: 'vx-lock-renamed-' })
  try {
    await addProject(root, 'a', config)
    expect(vx(root, 'lock').code).toBe(0)
    await writeFile(
      path.join(root, 'packages/a/package.json'),
      JSON.stringify({ name: 'a2', version: '0.0.0' }),
    )
    for (const args of [
      ['run', 'a2#build'],
      ['run', '--filter', 'a2', 'build'],
      ['show', 'a2'],
      ['show', 'a2#build'],
    ]) {
      const r = vx(root, ...args)
      expect(`${args.join(' ')} ${r.code} ${r.err.includes('package.json')}`).toBe(
        `${args.join(' ')} 1 false`,
      )
    }
    expect(vx(root, 'run', 'a#build').code).toBe(0)
    expect(vx(root, 'lock').code).toBe(0)
    expect(vx(root, 'run', 'a2#build').code).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
