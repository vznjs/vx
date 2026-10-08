// A bare task name never selects a default `build` (X-102). The default is
// a keyed group that runs nothing, and every project has one, so
// `vx run build` at a root that declares none matched it and ran 0 tasks,
// exit 0, where any other name said "pass --all". Named whole (`lib#build`),
// it still plans, and a dependant's `^build` still reaches it.

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

/** The task ids a `--dry=json` plan holds, sorted. */
async function planned(cwd: string, args: string[]): Promise<string[]> {
  const r = await vx(cwd, ['run', ...args, '--dry=json'])
  expect(r.code).toBe(0)
  const plan = JSON.parse(r.text) as { tasks: Array<{ id: string }> }
  return plan.tasks.map((t) => t.id).sort()
}

describe('a bare name does not select a default build', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-bare-default-' })
    await writeFile(
      path.join(root, 'vx.config.mjs'),
      `export default { tasks: { ci: { exec: { command: 'true' } } } }\n`,
    )
    await addProject(
      root,
      'lib',
      `export default { tasks: { test: { exec: { command: 'true' } } } }\n`,
    )
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('`vx run build` where no project declares build is refused', async () => {
    // At the root (its project alone) and over all: no project outside
    // the selection declares one either, and the list of what a bare name
    // can select leaves the default builds out.
    for (const [args, listed] of [
      [['run', 'build'], 'ci'],
      [['run', 'build', '--all'], 'ci, test'],
    ] as const) {
      const r = await vx(root, [...args])
      expect(r.code).toBe(1)
      expect(r.text).toBe(`vx run: no projects declare task(s): build. Tasks: ${listed}.\n`)
    }
  }, 30_000)

  it('`vx run build` at a root that declares none names the projects that do', async () => {
    await addProject(
      root,
      'app',
      `export default { tasks: { build: { exec: { command: 'true' } } } }\n`,
    )
    const r = await vx(root, ['run', 'build'])
    expect(r.code).toBe(1)
    expect(r.text).toContain('Only projects outside the selection declare build')
  }, 30_000)

  it('--all requests the declared builds; a dependant still reaches the default one', async () => {
    await addProject(root, 'app', {
      deps: { lib: 'workspace:*' },
      config: `export default { tasks: { build: { dependsOn: ['^build'], exec: { command: 'true' } } } }\n`,
    })
    const r = await vx(root, ['run', 'build', '--all', '--dry=json'])
    expect(r.code).toBe(0)
    const plan = JSON.parse(r.text) as { tasks: Array<{ id: string; requested?: boolean }> }
    expect(plan.tasks.map((t) => t.id).sort()).toEqual(['app#build', 'lib#build'])
  }, 30_000)

  it('CONTROL: `lib#build` named whole plans the default build', async () => {
    expect(await planned(root, ['lib#build'])).toEqual(['lib#build'])
  }, 30_000)
})
