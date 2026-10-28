// The executor asks Capabilities once per run and keeps the answer. A FAILED
// ask was kept too: one call that hit its deadline failed every later task
// of the run with the same error, never asking again.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as grpc from '@grpc/grpc-js'
import type { ExecuteRequest } from '@vzn/vx'
import { reapiExecutor } from '../src/executor.js'
import { ReapiClient } from '../src/wire.js'
import { CHUNKING_SUPPORTED } from './helpers/bun-floor.js'
import { startFakeReapi, type FakeReapi } from './helpers/fake-reapi.js'

let fake: FakeReapi
let root: string
beforeAll(async () => {
  fake = await startFakeReapi()
})
afterAll(() => fake.stop())
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-caps-retry-'))
  await mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
  await writeFile(path.join(root, 'pkg', 'src', 'in.txt'), 'in\n')
  fake.onExecute = () => ({ response: { result: { exit_code: 0 } } })
})
afterEach(async () => {
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
      configDigest: 'y',
    },
  }) as unknown as ExecuteRequest

describe.if(CHUNKING_SUPPORTED)('the executor’s Capabilities answer', () => {
  it('is asked again after a failed ask', async () => {
    const client = new ReapiClient({ endpoint: fake.endpoint })
    const ex = reapiExecutor(client, { warn: () => undefined })
    try {
      fake.fail('GetCapabilities', grpc.status.DEADLINE_EXCEEDED)
      const first = await ex.execute(request()).then(
        (r) => `exit ${r.exitCode}`,
        () => 'failed',
      )
      const second = await ex.execute(request()).then(
        (r) => `exit ${r.exitCode}`,
        (e: Error) => e.message,
      )
      expect([first, second]).toEqual(['failed', 'exit 0'])
    } finally {
      client.close()
    }
  })
})
