// A remote execution that never wrote a literal output passed: core leaves
// the check to a remote executor, and this one made none, so the run went
// green where a run here fails (2026-11-23). Checked by core's rule once the
// outputs land here, on the execute path and on a record's replay.
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ExecuteRequest } from '@vzn/vx'
import { execDigestFor } from '../src/cache.js'
import { reapiExecutor } from '../src/executor.js'
import { ReapiClient } from '../src/wire.js'
import { startFakeReapi, type FakeReapi } from './helpers/fake-reapi.js'

let fake: FakeReapi
let root: string
beforeAll(async () => {
  fake = await startFakeReapi()
})
afterAll(() => fake.stop())
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-exec-missing-'))
  await mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
  await writeFile(path.join(root, 'pkg', 'src', 'in.txt'), 'in\n')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const request = (cacheKey: string, files: string[]): ExecuteRequest =>
  ({
    taskId: 'pkg#gen',
    cacheKey,
    workspaceRoot: root,
    cwd: path.join(root, 'pkg'),
    command: 'gen',
    forwardArgs: [],
    env: {},
    envDefine: {},
    capture: { stdout: true, stderr: true },
    onStdout: () => undefined,
    onStderr: () => undefined,
    outputs: { files, workspaceFiles: [] },
    inputs: {
      files: [{ path: 'pkg/src/in.txt', digest: '4935e88d323e7973308dd73cccf2837fc3c7de22' }],
      env: [],
      runtime: [],
      workspaceRuntime: [],
      upstream: [],
      configDigest: 'y',
    },
  }) as unknown as ExecuteRequest

const execute = async (req: ExecuteRequest) => {
  const client = new ReapiClient({ endpoint: fake.endpoint })
  try {
    return await reapiExecutor(client, { warn: () => undefined }).execute(req)
  } finally {
    client.close()
  }
}

it('names a literal output an execution never wrote', async () => {
  const digest = fake.put(new TextEncoder().encode('b\n'))
  fake.onExecute = () => ({
    response: { result: { exit_code: 0, output_files: [{ path: 'b.txt', digest }] } },
  })
  const res = await execute(request('k-missing-exec', ['out.txt', 'b.txt', 'gen/**']))
  expect([res.exitCode, res.outputsMissing]).toEqual([0, ['out.txt']])
})

it('names nothing when the declared outputs landed (control)', async () => {
  const digest = fake.put(new TextEncoder().encode('o\n'))
  fake.onExecute = () => ({
    response: { result: { exit_code: 0, output_files: [{ path: 'out.txt', digest }] } },
  })
  const res = await execute(request('k-landed-exec', ['out.txt', 'gen/**']))
  expect([res.exitCode, res.outputsMissing]).toEqual([0, undefined])
})

it('names a literal output a replayed record lacks', async () => {
  fake.actions.set(execDigestFor('k-missing-replay').hash, { exit_code: 0 })
  const before = fake.calls.filter((c) => c.method === 'Execute').length
  const res = await execute(request('k-missing-replay', ['out.txt']))
  expect([
    res.exitCode,
    res.outputsMissing,
    fake.calls.filter((c) => c.method === 'Execute').length - before,
  ]).toEqual([0, ['out.txt'], 0])
})
