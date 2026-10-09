// listTasks narrows by `filter` and `affected` as `vx show` does: the CLI
// makes the selection, so a filter cannot mean one thing to `vx run` and
// another through MCP.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { handleToolCall } from '../src/tools.js'

const CORE_BIN = path.resolve(import.meta.dir, '../../vx/src/bin.ts')

let root: string
const ctx = () => ({
  cacheDir: path.join(root, '.vx', 'cache'),
  workspaceRoot: root,
  vx: [process.execPath, CORE_BIN],
})
const git = (...args: string[]) =>
  Bun.spawnSync({
    cmd: ['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    cwd: root,
  })
const names = (r: Record<string, unknown>) =>
  (r['projects'] as Array<{ name: string }>).map((p) => p.name)

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-mcp-list-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  for (const name of ['a', 'b']) {
    const pkg = path.join(root, 'packages', name)
    await mkdir(pkg, { recursive: true })
    await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name }))
    await writeFile(
      path.join(pkg, 'vx.config.mjs'),
      `export default { tasks: { build: { exec: { command: 'true' } } } }\n`,
    )
  }
  git('init', '-q')
  git('add', '.')
  git('commit', '-qm', 'init')
  await writeFile(path.join(root, 'packages', 'b', 'x.js'), 'x')
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it('no scope lists every project', async () => {
  expect(names(await handleToolCall('listTasks', {}, ctx()))).toEqual(['a', 'b'])
}, 30_000)

it("filter narrows to the CLI's selection", async () => {
  const got = await handleToolCall('listTasks', { filter: ['b'] }, ctx())
  expect(names(got)).toEqual(['b'])
  expect((got['projects'] as Array<{ tasks: unknown[] }>)[0]!.tasks).toEqual([
    expect.objectContaining({ id: 'b#build' }),
  ])
}, 30_000)

it('affected narrows to the changed projects', async () => {
  expect(names(await handleToolCall('listTasks', { affected: 'HEAD' }, ctx()))).toEqual(['b'])
}, 30_000)

it("a filter the CLI refuses is the CLI's refusal", async () => {
  const got = await handleToolCall('listTasks', { filter: ['[nope-ref]'] }, ctx())
  expect(got['projects']).toBeUndefined()
  expect(got['exitCode']).toBe(1)
  expect(got['error']).toContain('nope-ref')
}, 30_000)

it('project beside filter is refused at the boundary', async () => {
  await expect(handleToolCall('listTasks', { project: 'a', filter: ['b'] }, ctx())).rejects.toThrow(
    'listTasks: project and filter/affected exclude each other',
  )
}, 30_000)
