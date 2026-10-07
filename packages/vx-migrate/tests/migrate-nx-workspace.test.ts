// `nx()` applies nx.json's `parallel`, `defaultBase` and `maxCacheSize`
// live. A migration writes them into the `vx.workspace.ts` it writes, and
// names each field where the file is already there. Silent, nx-examples'
// `parallel: 1` ran on every core once migrated; as a note, the written
// file needed a hand edit to run as Nx ran.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { nxWorkspaceFields } from '../src/migrate-nx.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

const notes = (nxJson: Record<string, unknown>): string[] =>
  nxWorkspaceFields(nxJson).map((f) => f.note)

it('names each nx.json run setting as a workspace field', () => {
  expect(nxWorkspaceFields({ parallel: 1, defaultBase: 'master', maxCacheSize: '10GB' })).toEqual([
    {
      field: 'concurrency: 1',
      note: 'nx.json `parallel: 1`: add `concurrency: 1` to vx.workspace.ts',
    },
    {
      field: 'affectedBase: "master"',
      note: 'nx.json `defaultBase` "master": add `affectedBase: "master"` to vx.workspace.ts',
    },
    {
      field: 'cacheRetention: { maxSize: "10GB" }',
      note: 'nx.json `maxCacheSize`: add `cacheRetention: { maxSize: "10GB" }` to vx.workspace.ts',
    },
  ])
  // The legacy spellings Nx still reads.
  expect(
    notes({
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
    expect(notes({ maxCacheSize: '0' })).toEqual([])
  } finally {
    delete process.env['NX_PARALLEL']
  }
})

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-migrate-nx-ws-'))
  await writeFile(path.join(root, 'package.json'), '{"name":"root","private":true}')
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, 'nx.json'), '{"parallel":1,"defaultBase":"master"}')
  await mkdir(path.join(root, 'packages', 'a'), { recursive: true })
  await writeFile(path.join(root, 'packages', 'a', 'package.json'), '{"name":"a"}')
  await mkdir(path.join(root, '.nx', 'workspace-data'), { recursive: true })
  const graph = {
    nodes: {
      a: { name: 'a', data: { root: 'packages/a', targets: { build: { command: 'tsc' } } } },
    },
    dependencies: {},
  }
  await writeFile(
    path.join(root, '.nx', 'workspace-data', 'project-graph.json'),
    JSON.stringify(graph),
  )
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function migrate(): Promise<string> {
  const proc = Bun.spawn([process.execPath, BIN, '--no-install'], {
    cwd: root,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  expect(code).toBe(0)
  return out
}

it('writes them into the vx.workspace.ts it writes, and says nothing of them', async () => {
  const out = await migrate()
  const ws = await Bun.file(path.join(root, 'vx.workspace.ts')).text()
  expect(ws.split('\n').slice(3, 6)).toEqual([
    'export default {',
    '  concurrency: 1,',
    '  affectedBase: "master",',
  ])
  expect(out).not.toContain('to vx.workspace.ts')
})

// CONTROL: a workspace file of the user's is left alone, and each setting is a note.
it('names them where the workspace file is already there', async () => {
  await writeFile(path.join(root, 'vx.workspace.mjs'), 'export default { plugins: [] }\n')
  const out = await migrate()
  expect(out).toContain('nx.json `parallel: 1`: add `concurrency: 1` to vx.workspace.ts')
  expect(out).toContain('add `affectedBase: "master"` to vx.workspace.ts')
  expect(await Bun.file(path.join(root, 'vx.workspace.ts')).exists()).toBe(false)
})
