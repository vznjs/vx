// `--filter '...app'` follows every edge the task graph knows. `e2e`
// depends on `app#build` through `dependsOn` and on nothing through
// package.json; until 2026-09-10 the dependents walk read the manifest
// alone, so a CI that ran "what changed and everything depending on it"
// silently left `e2e` out. Fails without the task edges.

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

async function vx(root: string, args: string[]): Promise<{ code: number; text: string }> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, text: out + err }
}

describe('selection follows cross-project dependsOn edges', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-task-edge-' })
    const task = (name: string) => `
      export default { tasks: {
        build: { exec: { command: 'echo build ${name}' } },
        test: { exec: { command: 'echo test ${name}' } },
      } }
    `
    await addProject(root, 'lib', task('lib'))
    await addProject(root, 'app', { config: task('app'), deps: { lib: 'workspace:*' } })
    await addProject(
      root,
      'e2e',
      `
        export default { tasks: {
          test: { dependsOn: ['app#build'], exec: { command: 'echo test e2e' } },
        } }
      `,
    )
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("...lib selects app (package.json) AND e2e (dependsOn: ['app#build'])", async () => {
    const r = await vx(root, ['run', 'test', '--filter', '...lib'])
    expect(r.code).toBe(0)
    const ran = [...r.text.matchAll(/success no-cache\s+(\S+)/g)]
      .map((m) => m[1]!)
      .sort((a, b) => (a < b ? -1 : 1))
    expect(ran).toEqual(['app#build', 'app#test', 'e2e#test', 'lib#test'])
  }, 30_000)

  it('e2e... reaches app and lib through the task edge; e2e^... excludes e2e', async () => {
    const r = await vx(root, ['run', 'test', '--filter', 'e2e^...'])
    expect(r.code).toBe(0)
    const ran = [...r.text.matchAll(/success no-cache\s+(\S+)/g)]
      .map((m) => m[1]!)
      .sort((a, b) => (a < b ? -1 : 1))
    expect(ran).toEqual(['app#test', 'lib#test'])
  }, 30_000)

  it('a plain name filter still selects only the name (control)', async () => {
    const r = await vx(root, ['run', 'test', '--filter', 'lib'])
    expect(r.code).toBe(0)
    const ran = [...r.text.matchAll(/success no-cache\s+(\S+)/g)]
      .map((m) => m[1]!)
      .sort((a, b) => (a < b ? -1 : 1))
    expect(ran).toEqual(['lib#test'])
  }, 30_000)
})
