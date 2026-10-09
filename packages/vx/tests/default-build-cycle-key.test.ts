// Two default builds on one package cycle pass through each other (X-100),
// so neither takes the other as an edge. A task behind one of them must
// still re-run when the other's files change.

import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

async function vx(cwd: string, args: string[]): Promise<{ code: number; text: string }> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd,
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

describe('default builds on a package cycle', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-cycle-key-' })
    await addProject(root, 'a', {
      deps: { b: 'workspace:*' },
      config: `export default { tasks: { test: {
        dependsOn: ['build'],
        exec: { command: 'cat ../b/src/index.js' },
        cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
      } } }\n`,
      files: { 'src/index.js': 'a-1\n' },
    })
    await addProject(root, 'b', {
      deps: { a: 'workspace:*' },
      files: { 'src/index.js': 'b-1\n' },
    })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("a task behind one re-runs when the other's files change", async () => {
    const first = await vx(root, ['run', 'a#test'])
    expect(first.code).toBe(0)
    expect((await vx(root, ['run', 'a#test'])).text).toContain('all cached')
    await writeFile(path.join(root, 'packages', 'b', 'src', 'index.js'), 'b-2\n')
    const after = await vx(root, ['run', 'a#test'])
    expect(after.code).toBe(0)
    expect(after.text).toContain('b-2')
  }, 30_000)

  it("CONTROL: a change in its own project's files re-runs it", async () => {
    expect((await vx(root, ['run', 'a#test'])).code).toBe(0)
    await writeFile(path.join(root, 'packages', 'a', 'src', 'index.js'), 'a-2\n')
    const after = await vx(root, ['run', 'a#test'])
    expect(after.text).not.toContain('all cached')
  }, 30_000)
})
