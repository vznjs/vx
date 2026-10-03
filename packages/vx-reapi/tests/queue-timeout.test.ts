// `queueTimeoutMs` (B-100): an action no worker starts within the bound has
// its Execute stream cancelled and is given back to vx, which runs it here
// (core's half: packages/vx/tests/executor-fallback.test.ts). The bound ends
// at EXECUTING: a started action is the stall timer's, not this one's.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ExecuteRequest } from '@vzn/vx'
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
  root = await mkdtemp(path.join(tmpdir(), 'vx-queue-timeout-'))
  await mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
  await writeFile(path.join(root, 'pkg', 'src', 'in.txt'), 'in\n')
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
      packageJsonDigest: '',
      configDigest: 'y',
      workspaceFingerprint: 'z',
    },
  }) as unknown as ExecuteRequest

/** What the execute settled as: its exit code, or the rejection's name and message. */
async function settle(stages: string[], hold: Promise<void>): Promise<string> {
  fake.onExecute = () => ({ stages, hold, response: { result: { exit_code: 0 } } })
  const client = new ReapiClient({ endpoint: fake.endpoint })
  try {
    // Not `expect(…).rejects`: it holds a call that needs gRPC I/O (item 827).
    return await Promise.race([
      reapiExecutor(client, { queueTimeoutMs: 300 })
        .execute(request())
        .then(
          (r) => `exit ${r.exitCode}`,
          (e: Error) => `${e.name}: ${e.message}`,
        ),
      Bun.sleep(5000).then(() => 'unbounded'),
    ])
  } finally {
    client.close()
  }
}

describe('queueTimeoutMs', () => {
  it('cancels an action no worker started and gives it back', async () => {
    let release!: () => void
    const forever = new Promise<void>((r) => {
      release = r
    })
    const cancelled = fake.executesCancelled
    try {
      const settled = await settle(['QUEUED'], forever)
      const deadline = Date.now() + 3_000
      while (fake.executesCancelled === cancelled && Date.now() < deadline) await Bun.sleep(5)
      expect([settled, fake.executesCancelled - cancelled]).toEqual([
        'ExecutorFallback: vx/reapi: no worker started the action within queueTimeoutMs (300ms); its operation was cancelled',
        1,
      ])
    } finally {
      release()
    }
  })

  it('stops counting once a worker starts it', async () => {
    // Control: the same bound, an action that runs past it once started.
    expect(await settle(['QUEUED', 'EXECUTING'], Bun.sleep(700))).toBe('exit 0')
  })
})
