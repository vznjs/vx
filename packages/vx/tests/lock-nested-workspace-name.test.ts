// A project holding `.vx/workspace.ts.orig` (a merge leftover) is no nested
// workspace: findWorkspaceRoot reads only the six WORKSPACE_CONFIG_FILENAMES,
// so a run from inside it reaches the outer root. `vx lock` drops the project.
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const CONFIG = `export default { tasks: { build: { exec: { command: 'true' } } } }\n`

for (const git of ['init', false] as const)
  it(`a stray .vx/workspace.* that marks no workspace keeps its project locked (git: ${git})`, async () => {
    const root = await makeWorkspace({ prefix: 'vx-lock-nested-prefix-', git })
    const a = await addProject(root, 'a', CONFIG)
    await addProject(root, 'b', CONFIG)
    await mkdir(path.join(a, '.vx'))
    await writeFile(path.join(a, '.vx', 'workspace.ts.orig'), 'export default {}\n')
    const r = Bun.spawnSync({ cmd: [process.execPath, BIN, 'lock'], cwd: root })
    const out = r.stdout.toString()
    await rm(root, { recursive: true, force: true })
    expect(r.exitCode).toBe(0)
    expect(out).toContain('2 project configs')
  })
