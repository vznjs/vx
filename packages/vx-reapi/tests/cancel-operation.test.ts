// Past `queueTimeoutMs` the operation itself is cancelled (B-101): closing
// the Execute stream left a queued action to the server, which may still
// run it. A server that refuses the cancel still has the task given back.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as grpc from '@grpc/grpc-js'
import type { ExecuteRequest } from '@vzn/vx'
import { reapiExecutor } from '../src/executor.js'
import { ReapiClient } from '../src/wire.js'
import { startFakeReapi, type FakeReapi } from './helpers/fake-reapi.js'

let fake: FakeReapi
let root: string
let release: () => void
beforeAll(async () => {
  fake = await startFakeReapi()
})
afterAll(() => fake.stop())
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-cancel-op-'))
  await mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
  await writeFile(path.join(root, 'pkg', 'src', 'in.txt'), 'in\n')
  const forever = new Promise<void>((r) => {
    release = r
  })
  fake.onExecute = () => ({ stages: ['QUEUED'], hold: forever })
})
afterEach(async () => {
  release()
  await rm(root, { recursive: true, force: true })
})

const request = (): ExecuteRequest =>
  ({
    taskId: 'pkg#gen',
    workspaceRoot: root,
    cwd: path.join(root, 'pkg'),
    command: 'gen',
    forwardArgs: [],
    env: {},
    envDefine: {},
    capture: { stdout: true, stderr: true },
    onStdout: () => undefined,
    onStderr: () => undefined,
    outputs: { files: [], workspaceFiles: [] },
    inputs: {
      files: [{ path: 'pkg/src/in.txt', digest: '4935e88d323e7973308dd73cccf2837fc3c7de22' }],
      env: [],
      runtime: [],
      workspaceRuntime: [],
      upstream: [],
      packageJsonDigest: '',
      configDigest: 'y',
      workspaceFingerprint: 'z',
    },
  }) as unknown as ExecuteRequest

/** The rejection's name, and the operations CancelOperation named. */
async function queueOut(): Promise<{ name: string; cancelled: string[]; executed: string[] }> {
  const client = new ReapiClient({ endpoint: fake.endpoint })
  const from = fake.calls.length
  try {
    const name = await Promise.race([
      reapiExecutor(client, { queueTimeoutMs: 200 })
        .execute(request())
        .then(
          () => 'resolved',
          (e: Error) => e.name,
        ),
      Bun.sleep(5000).then(() => 'unbounded'),
    ])
    const calls = fake.calls.slice(from)
    const named = (m: string) =>
      calls.filter((c) => c.method === m).map((c) => c.request['name'] as string)
    return { name, cancelled: named('CancelOperation'), executed: named('Execute').map(() => 'x') }
  } finally {
    client.close()
  }
}

describe('a queue timeout cancels the operation', () => {
  it('names the operation Execute was given', async () => {
    const r = await queueOut()
    expect(r.name).toBe('ExecutorFallback')
    expect(r.executed).toEqual(['x'])
    expect(r.cancelled).toHaveLength(1)
    expect(r.cancelled[0]).toMatch(/^operations\/\d+$/)
  })

  it('gives the task back when the server refuses the cancel', async () => {
    fake.fail('CancelOperation', grpc.status.UNIMPLEMENTED)
    const r = await queueOut()
    expect([r.name, r.cancelled.length]).toEqual(['ExecutorFallback', 1])
  })
})
