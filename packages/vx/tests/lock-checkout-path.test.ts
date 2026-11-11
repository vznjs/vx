// A config that builds a command from `import.meta.dir` locks this
// checkout's absolute path: another checkout's `vx lock --check` fails and
// its cache keys differ. `vx lock` names it.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const roots: string[] = []

afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})

async function lock(config: string) {
  // Real: a macOS tmpdir is a symlink the workspace root resolves.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-lock-checkout-path-')))
  roots.push(root)
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource())
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'vx.config.mjs'), config)
  const r = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'lock'],
    cwd: root,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { root, code: r.exitCode, err: r.stderr.toString() }
}

describe('vx lock and a checkout path in an evaluated config', () => {
  it('warns, naming the project and the alternatives', async () => {
    const r = await lock(`export default { tasks: {
  gen: { exec: { command: \`bun \${import.meta.dir}/../../scripts/gen.ts\` } },
} }
`)
    expect(r.code).toBe(0)
    expect(r.err).toContain(
      `packages/a: its config holds this checkout's path (${r.root}), so another checkout locks it otherwise and keys it apart — use a path relative to the project, or $VX_RUN_WORKSPACE in the command`,
    )
  })

  it('says nothing of a relative path', async () => {
    const r = await lock(`export default { tasks: {
  gen: { exec: { command: 'bun ../../scripts/gen.ts' } },
} }
`)
    expect(r).toMatchObject({ code: 0, err: '' })
  })
})
