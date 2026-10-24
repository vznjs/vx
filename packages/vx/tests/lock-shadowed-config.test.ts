// Two config files in one directory: precedence reads one, and the other
// was ignored without a word, so an edit to it changed nothing.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { noticed } from './helpers/notice.js'

const BIN = path.join(import.meta.dir, '..', 'src', 'bin.ts')
const CONFIG = `export default { tasks: { build: { exec: { command: 'true' } } } }\n`

let root: string | undefined
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

const lock = (cwd: string, ...args: string[]): { code: number; err: string } => {
  const p = Bun.spawnSync({ cmd: [process.execPath, BIN, 'lock', ...args], cwd, stderr: 'pipe' })
  return { code: p.exitCode, err: p.stderr.toString() }
}

for (const git of ['init', false] as const) {
  it(`vx lock names a config a higher-precedence one beside it hides (git: ${git})`, async () => {
    const r = (root = await makeWorkspace({ prefix: 'vx-lock-shadowed-', git }))
    const a = await addProject(r, 'a', { config: CONFIG })
    await Bun.write(path.join(a, 'vx.config.ts'), CONFIG)
    await Bun.write(path.join(r, '.vx', 'workspace.cjs'), 'module.exports = {}\n')
    expect(lock(r)).toEqual({
      code: 0,
      err:
        noticed(
          'vx lock: .vx/workspace.cjs is not read: workspace.mjs beside it is — delete one\n',
          'warn',
        ) +
        noticed(
          'vx lock: packages/a/vx.config.mjs is not read: vx.config.ts beside it is — delete one\n',
          'warn',
        ),
    })
    // The CI gate passes, as after any clean lock, and says it too.
    expect(lock(r, '--check')).toEqual({
      code: 0,
      err:
        noticed(
          'vx lock --check: .vx/workspace.cjs is not read: workspace.mjs beside it is — delete one\n',
          'warn',
        ) +
        noticed(
          'vx lock --check: packages/a/vx.config.mjs is not read: vx.config.ts beside it is — delete one\n',
          'warn',
        ),
    })
    await rm(path.join(a, 'vx.config.mjs'))
    await rm(path.join(r, '.vx', 'workspace.cjs'))
    expect(lock(r)).toEqual({ code: 0, err: '' })
  })
}
