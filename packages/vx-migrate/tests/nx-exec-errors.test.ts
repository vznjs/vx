// A thrown error (an executor's own, or Nx's "Unable to resolve" for a
// missing executor package) is reported as `nx run` reports it
// (`handleErrors`): the message, and the stack only under verbose
// logging. nx-exec printed a stack of Nx internals every time.
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
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-exec-err-'))
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

async function run(env: Record<string, string>): Promise<{ code: number; err: string }> {
  const clean = { ...process.env }
  delete clean['NX_DAEMON']
  delete clean['NX_VERBOSE_LOGGING']
  const options = JSON.stringify({ throws: 'Unable to resolve @acme/gone:build' })
  const p = Bun.spawn(
    ['node', BIN, '@acme/gone:build', '--project', 'app', '--target', 't', '--options', options],
    {
      cwd: path.join(root, 'packages', 'app'),
      env: { ...clean, ...env },
      stdout: 'ignore',
      stderr: 'pipe',
    },
  )
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited])
  return { code, err }
}

describe('nx-exec reports a thrown error as nx run does', () => {
  it('the message and a hint, no stack, by default', async () => {
    expect(await run({})).toEqual({
      code: 1,
      err: 'nx-exec: Unable to resolve @acme/gone:build\nSet NX_VERBOSE_LOGGING=true to see the stack trace.\n',
    })
  })

  it('the stack under NX_VERBOSE_LOGGING=true', async () => {
    const r = await run({ NX_VERBOSE_LOGGING: 'true' })
    expect(r.code).toBe(1)
    expect(r.err.startsWith('nx-exec: Unable to resolve @acme/gone:build\nError: ')).toBe(true)
    expect(r.err).toContain('\n    at ')
  })
})
