// A config may key a group (X-208): `cache` with no `exec` is a key a
// dependant folds, with nothing spawned and nothing counted. @vzn/vx-migrate
// writes one per Nx `^name` input and Turbo transit node; as `true` tasks
// they ran a process each and a TanStack/query trial counted 36 tasks
// where Nx ran 25.

import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

async function vx(root: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect({ code: await proc.exited, err }).toEqual({ code: 0, err: expect.any(String) })
  return out
}

async function lastTasks(root: string): Promise<Record<string, boolean | undefined>> {
  const json = JSON.parse(await vx(root, ['last', '--format', 'json'])) as {
    tasks: { project: string; task: string; cacheHit?: boolean }[]
  }
  return Object.fromEntries(json.tasks.map((t) => [`${t.project}#${t.task}`, t.cacheHit]))
}

describe('a keyed group in a config', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-keyed-group-' })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('re-keys its dependant on its inputs, spawns nothing and is not counted', async () => {
    const dir = await addProject(
      root,
      'a',
      `
        export default { tasks: {
          fixtures: { cache: { inputs: { files: ['fixtures/**'] }, outputs: { files: [] } } },
          test: {
            exec: { command: 'echo ran' },
            dependsOn: ['fixtures'],
            cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } },
          },
        } }
      `,
    )
    await writeFile(path.join(dir, 'fixtures.txt'), 'outside the key\n')
    await Bun.write(path.join(dir, 'fixtures', 'one.json'), '1\n')

    const first = await vx(root, ['run', 'test', '--all'])
    expect(first).toContain('1 task · 0 cached')
    expect(await lastTasks(root)).toEqual({ 'a#test': false })

    await vx(root, ['run', 'test', '--all'])
    expect(await lastTasks(root)).toEqual({ 'a#test': true })

    // Outside the group's inputs: still a hit.
    await writeFile(path.join(dir, 'fixtures.txt'), 'edited\n')
    await vx(root, ['run', 'test', '--all'])
    expect(await lastTasks(root)).toEqual({ 'a#test': true })

    await Bun.write(path.join(dir, 'fixtures', 'one.json'), '2\n')
    await vx(root, ['run', 'test', '--all'])
    expect(await lastTasks(root)).toEqual({ 'a#test': false })
  }, 30_000)
})
