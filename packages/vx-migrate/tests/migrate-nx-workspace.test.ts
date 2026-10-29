// `nx()` applies nx.json's `parallel` and `defaultBase`
// live; a migration writes them into the `.vx/workspace.ts` it writes, and
// names each field to add to one already there. Silent, nx-examples'
// `parallel: 1` ran on every core once migrated; nartc/mapper's migration
// wrote the file and still told the user to add `baseBranch` to it.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { migrateNx, nxWorkspaceFields } from '../src/migrate-nx.js'

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
  expect(await notes({ parallel: 1, defaultBase: 'master' })).toEqual([
    'nx.json `parallel: 1`: add `run: { concurrency: 1 }` to .vx/workspace.ts',
    'nx.json `defaultBase` "master": add `baseBranch: "master"` to .vx/workspace.ts',
  ])
  // The legacy spellings Nx still reads.
  expect(
    await notes({
      tasksRunnerOptions: { default: { options: { parallel: 3 } } },
      affected: { defaultBase: 'develop' },
    }),
  ).toEqual([
    'nx.json `parallel: 3`: add `run: { concurrency: 3 }` to .vx/workspace.ts',
    'nx.json `defaultBase` "develop": add `baseBranch: "develop"` to .vx/workspace.ts',
  ])
  // CONTROL: none set, and the environment is not read.
  process.env['NX_PARALLEL'] = '2'
  try {
    expect(await notes({})).toEqual([])
  } finally {
    delete process.env['NX_PARALLEL']
  }
})

it('writes them into the .vx/workspace.ts it writes', async () => {
  await writeFile(path.join(root, 'nx.json'), JSON.stringify({ parallel: 2, defaultBase: 'main' }))
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
  const ws = await readFile(path.join(root, '.vx/workspace.ts'), 'utf8')
  // Beside it, the ignore that keeps only the machine-local cache and staging out of git.
  expect(await readFile(path.join(root, '.vx/.gitignore'), 'utf8')).toBe('/cache\n/tmp\n')
  expect([ws.match(/^ {2}\w+: .*,$/gm), out.includes('to .vx/workspace.ts')]).toEqual([
    ["  baseBranch: 'main',", '  run: { concurrency: 2 },'],
    false,
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
  await Bun.write(path.join(root, '.vx/workspace.mjs'), 'export default { plugins: [] }\n')
  const bin = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
  const proc = Bun.spawn([process.execPath, '--no-install', bin, '--no-install'], {
    cwd: root,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  expect(out).toContain('nx.json `parallel: 1`: add `run: { concurrency: 1 }` to .vx/workspace.ts')
  expect(out).toContain(
    'nx.json `defaultBase` "master": add `baseBranch: "master"` to .vx/workspace.ts',
  )
  expect(await readFile(path.join(root, '.vx/workspace.mjs'), 'utf8')).toBe(
    'export default { plugins: [] }\n',
  )
  expect(await Bun.file(path.join(root, '.vx/workspace.ts')).exists()).toBe(false)
})

// A `defaultBase` with a line break (JSON allows one) was written as a
// single-quoted literal spanning two lines: `.vx/workspace.ts` did not parse.
it('writes a defaultBase as a literal that evaluates to it', async () => {
  for (const [i, base] of ['a\nb', 'a\rb', "it's\\"].entries()) {
    const field = nxWorkspaceFields({ defaultBase: base }).find((f) => f.field === 'baseBranch')!
    const file = path.join(root, `literal-${i}.mjs`)
    await writeFile(file, `export default ${field.source}\n`)
    expect((await import(file)).default).toBe(base)
  }
})
