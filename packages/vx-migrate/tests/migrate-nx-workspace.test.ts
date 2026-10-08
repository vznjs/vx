// `nx()` applies nx.json's `parallel`, `defaultBase` and `maxCacheSize`
// live; a migration writes them into the `vx.workspace.ts` it writes, and
// names each field to add to one already there. Silent, nx-examples'
// `parallel: 1` ran on every core once migrated; nartc/mapper's migration
// wrote the file and still told the user to add `affectedBase` to it.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { migrateNx } from '../src/migrate-nx.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-migrate-nx-ws-'))
  await mkdir(path.join(root, '.nx', 'workspace-data'), { recursive: true })
  await writeFile(
    path.join(root, '.nx', 'workspace-data', 'project-graph.json'),
    JSON.stringify({ nodes: {}, dependencies: {} }),
  )
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const notes = async (nxJson: unknown): Promise<string[]> => {
  await writeFile(path.join(root, 'nx.json'), JSON.stringify(nxJson))
  return (await migrateNx(root, [])).notes
}

it('names each nx.json run setting the written workspace file needs', async () => {
  expect(await notes({ parallel: 1, defaultBase: 'master', maxCacheSize: '10GB' })).toEqual([
    'nx.json `parallel: 1`: add `concurrency: 1` to vx.workspace.ts',
    'nx.json `defaultBase` "master": add `affectedBase: "master"` to vx.workspace.ts',
    'nx.json `maxCacheSize`: add `cacheRetention: { maxSize: "10GB" }` to vx.workspace.ts',
  ])
  // The legacy spellings Nx still reads.
  expect(
    await notes({
      tasksRunnerOptions: { default: { options: { parallel: 3 } } },
      affected: { defaultBase: 'develop' },
    }),
  ).toEqual([
    'nx.json `parallel: 3`: add `concurrency: 3` to vx.workspace.ts',
    'nx.json `defaultBase` "develop": add `affectedBase: "develop"` to vx.workspace.ts',
  ])
  // CONTROL: none set, `0` is no cap, and the environment is not read.
  process.env['NX_PARALLEL'] = '2'
  try {
    expect(await notes({ maxCacheSize: '0' })).toEqual([])
  } finally {
    delete process.env['NX_PARALLEL']
  }
})

it('writes them into the vx.workspace.ts it writes; one it cannot read stays a note', async () => {
  await writeFile(
    path.join(root, 'nx.json'),
    JSON.stringify({ parallel: 2, defaultBase: 'main', maxCacheSize: '10GB' }),
  )
  await writeFile(
    path.join(root, 'package.json'),
    '{"name":"r","private":true,"workspaces":["libs/*"]}\n',
  )
  await mkdir(path.join(root, 'libs', 'a'), { recursive: true })
  await writeFile(path.join(root, 'libs', 'a', 'package.json'), '{"name":"a"}\n')
  await writeFile(
    path.join(root, '.nx', 'workspace-data', 'project-graph.json'),
    JSON.stringify({
      nodes: { a: { name: 'a', data: { root: 'libs/a', targets: { build: { command: 'tsc' } } } } },
      dependencies: {},
    }),
  )
  const bin = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
  const proc = Bun.spawn([process.execPath, '--no-install', bin, '--no-install'], {
    cwd: root,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  const ws = await readFile(path.join(root, 'vx.workspace.ts'), 'utf8')
  expect([ws.match(/^ {2}\w+: .*,$/gm), out.includes('to vx.workspace.ts')]).toEqual([
    ['  concurrency: 2,', "  affectedBase: 'main',", "  cacheRetention: { maxSize: '10GB' },"],
    false,
  ])
  // A size vx cannot read is not written: the note keeps it.
  await writeFile(path.join(root, 'nx.json'), JSON.stringify({ maxCacheSize: '1.5 TB' }))
  expect(
    (await migrateNx(root, [], 'ts', undefined, true)).notes.filter((n) => n.startsWith('nx.json')),
  ).toEqual([
    'nx.json `maxCacheSize`: add `cacheRetention: { maxSize: "1.5 TB" }` to vx.workspace.ts',
  ])
})

// CONTROL: a workspace file of the user's is left alone, and each setting is a note.
it('names them where the workspace file is already there', async () => {
  await writeFile(path.join(root, 'nx.json'), '{"parallel":1,"defaultBase":"master"}')
  await writeFile(
    path.join(root, 'package.json'),
    '{"name":"r","private":true,"workspaces":["libs/*"]}\n',
  )
  await mkdir(path.join(root, 'libs', 'a'), { recursive: true })
  await writeFile(path.join(root, 'libs', 'a', 'package.json'), '{"name":"a"}\n')
  await writeFile(
    path.join(root, '.nx', 'workspace-data', 'project-graph.json'),
    JSON.stringify({
      nodes: { a: { name: 'a', data: { root: 'libs/a', targets: { build: { command: 'tsc' } } } } },
      dependencies: {},
    }),
  )
  await writeFile(path.join(root, 'vx.workspace.mjs'), 'export default { plugins: [] }\n')
  const bin = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
  const proc = Bun.spawn([process.execPath, '--no-install', bin, '--no-install'], {
    cwd: root,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  expect(out).toContain('nx.json `parallel: 1`: add `concurrency: 1` to vx.workspace.ts')
  expect(out).toContain(
    'nx.json `defaultBase` "master": add `affectedBase: "master"` to vx.workspace.ts',
  )
  expect(await readFile(path.join(root, 'vx.workspace.mjs'), 'utf8')).toBe(
    'export default { plugins: [] }\n',
  )
  expect(await Bun.file(path.join(root, 'vx.workspace.ts')).exists()).toBe(false)
})
