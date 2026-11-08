// What the executor does when Execute does not simply finish: a
// FAILED_PRECONDITION (inputs missing from the CAS, evicted after
// FindMissingBlobs) is healed by uploading them and executing once more,
// as the REAPI spec asks; an operation the client gives up on is cancelled,
// not left running on its worker.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ExecuteRequest } from '@vzn/vx'
import protobuf from 'protobufjs'
import { reapiExecutor } from '../src/executor.js'
import { ReapiClient, reattach } from '../src/wire.js'
import { startFakeReapi, type FakeReapi } from './helpers/fake-reapi.js'

let fake: FakeReapi
let root: string
beforeAll(async () => {
  fake = await startFakeReapi()
})
afterAll(() => fake.stop())
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-exec-retry-'))
  await mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
  await writeFile(path.join(root, 'pkg', 'src', 'in.txt'), 'in\n')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

// A key per task: a finished one leaves an execution record the next would replay.
let keys = 0
const request = (): ExecuteRequest =>
  ({
    taskId: 'pkg#gen',
    cacheKey: `k-retry-${++keys}`,
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

/** The task's outcome, and the methods the fake heard from it. */
async function run(): Promise<{ outcome: string; calls: FakeReapi['calls'] }> {
  const client = new ReapiClient({ endpoint: fake.endpoint })
  const from = fake.calls.length
  try {
    const outcome = await reapiExecutor(client, { warn: () => undefined })
      .execute(request())
      .then(
        (r) => `exit ${r.exitCode}`,
        (e: Error) => e.message,
      )
    return { outcome, calls: fake.calls.slice(from) }
  } finally {
    client.close()
  }
}

/** What was uploaded between the first Execute and the second. */
const uploadedAfterExecute = (calls: FakeReapi['calls']): string[] =>
  calls
    .slice(
      calls.findIndex((c) => c.method === 'Execute'),
      calls.findLastIndex((c) => c.method === 'Execute'),
    )
    .filter((c) => c.method === 'BatchUpdateBlobs')
    .flatMap((c) =>
      (c.request['requests'] as { digest: { hash: string } }[]).map((r) => r.digest.hash),
    )

/** `google.rpc.PreconditionFailure` with one MISSING violation per subject. */
function preconditionFailure(subjects: string[]): Uint8Array {
  const pb = protobuf.Root.fromJSON({
    nested: {
      Violation: {
        fields: { type: { type: 'string', id: 1 }, subject: { type: 'string', id: 2 } },
      },
      PreconditionFailure: {
        fields: { violations: { rule: 'repeated', type: 'Violation', id: 1 } },
      },
    },
  })
  const t = pb.lookupType('PreconditionFailure')
  return t
    .encode(t.fromObject({ violations: subjects.map((subject) => ({ type: 'MISSING', subject })) }))
    .finish()
}

describe('Execute answering FAILED_PRECONDITION', () => {
  it('re-uploads every input without asking FindMissingBlobs, and executes once more', async () => {
    let executes = 0
    fake.onExecute = () =>
      ++executes === 1
        ? { response: { status: { code: 9, message: 'missing inputs' } } }
        : { response: { result: { exit_code: 0 } } }
    const { outcome, calls } = await run()
    const first = calls.findIndex((c) => c.method === 'Execute')
    expect([outcome, executes]).toEqual(['exit 0', 2])
    expect(calls.slice(first).some((c) => c.method === 'FindMissingBlobs')).toBe(false)
    // The input file, three directories (root, pkg, pkg/src), the Command and the Action.
    expect(uploadedAfterExecute(calls)).toHaveLength(6)
  })

  it('re-uploads only the blobs its MISSING violations name', async () => {
    const input = new TextEncoder().encode('in\n')
    const hash = new Bun.CryptoHasher('sha256').update(input).digest('hex')
    let executes = 0
    fake.onExecute = () =>
      ++executes === 1
        ? {
            response: {
              status: {
                code: 9,
                message: 'missing inputs',
                details: [
                  {
                    type_url: 'type.googleapis.com/google.rpc.PreconditionFailure',
                    value: preconditionFailure([`blobs/${hash}/${input.length}`]),
                  },
                ],
              },
            },
          }
        : { response: { result: { exit_code: 0 } } }
    const { outcome, calls } = await run()
    expect([outcome, executes, uploadedAfterExecute(calls)]).toEqual(['exit 0', 2, [hash]])
  })

  it('fails the task when the second Execute is refused the same way', async () => {
    fake.onExecute = () => ({ response: { status: { code: 9, message: 'missing inputs' } } })
    const { outcome, calls } = await run()
    expect([outcome, calls.filter((c) => c.method === 'Execute').length]).toEqual([
      'pkg#gen execution failed: missing inputs',
      2,
    ])
  })
})

describe('an operation the client gives up on', () => {
  it('is cancelled by name', async () => {
    const saved = [...reattach.backoffMs]
    reattach.backoffMs = [1, 2, 4]
    fake.onExecute = () => ({ stages: ['EXECUTING'], endEarly: true })
    // Re-attaches that deliver nothing spend the budget; the client gives up.
    fake.fail('WaitExecution', 14, 4)
    const { outcome, calls } = await run().finally(() => {
      reattach.backoffMs = saved
    })
    const name = calls.find((c) => c.method === 'WaitExecution')!.request['name']
    expect(outcome).toContain('14 UNAVAILABLE')
    expect(
      calls.filter((c) => c.method === 'CancelOperation').map((c) => c.request['name']),
    ).toEqual([name])
  })
})
