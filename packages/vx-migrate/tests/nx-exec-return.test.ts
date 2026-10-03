// `nx run` reads an executor's outcome with Nx's
// `getLastValueFromAsyncIterableIterator`: the generator's RETURN value
// when it has one, else the last yield. `nx-exec` iterated with
// `for await`, which drops the return: an executor that only returns
// `{ success: true }` exited 1, and a server that yields success and
// returns failure when it dies (@nx/web:file-server) exited 0.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { fakeNx } from './helpers/fake-nx.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'nx-exec.cjs')
const GRAPH = {
  nodes: { app: { name: 'app', type: 'app', data: { root: 'packages/app', targets: {} } } },
  dependencies: { app: [] },
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-exec-ret-'))
  await mkdir(path.join(root, 'packages', 'app'), { recursive: true })
  await mkdir(path.join(root, '.nx', 'workspace-data'), { recursive: true })
  await writeFile(path.join(root, 'package.json'), '{"name":"ws","private":true}')
  await writeFile(path.join(root, 'nx.json'), '{}')
  await writeFile(
    path.join(root, '.nx', 'workspace-data', 'project-graph.json'),
    JSON.stringify(GRAPH),
  )
  await fakeNx(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function exitOf(options: Record<string, unknown>): Promise<number> {
  const clean = { ...process.env }
  delete clean['NX_DAEMON']
  const p = Bun.spawn(
    ['node', BIN, 'x:y', '--project', 'app', '--target', 't', '--options', JSON.stringify(options)],
    { cwd: path.join(root, 'packages', 'app'), env: clean, stdout: 'ignore', stderr: 'ignore' },
  )
  return p.exited
}

describe('nx-exec reads the outcome as nx run does', () => {
  it('a returned result with no yield is the outcome', async () => {
    expect(await exitOf({ results: [], returns: { success: true } })).toBe(0)
    expect(await exitOf({ results: [], returns: { success: false } })).toBe(1)
  })

  it('a return beats the last yield', async () => {
    expect(await exitOf({ results: [{ success: true }], returns: { success: false } })).toBe(1)
    expect(await exitOf({ results: [{ success: false }], returns: { success: true } })).toBe(0)
  })

  // Controls: no return value leaves the last yield deciding, and nothing at all fails.
  it('no return: the last yield; nothing: a failure', async () => {
    expect(await exitOf({ results: [{ success: false }, { success: true }] })).toBe(0)
    expect(await exitOf({ results: [{ success: true }, { success: false }] })).toBe(1)
    expect(await exitOf({ results: [] })).toBe(1)
  })
})
