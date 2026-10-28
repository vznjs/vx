// `RequestMetadata.action_id` is how a server groups an action's CAS and AC
// calls. It was one field on the client, set just before Execute: each
// action's uploads went out under the action before it, and two tasks at
// once named each other's.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ExecuteRequest } from '@vzn/vx'
import { reapiExecutor } from '../src/executor.js'
import { ReapiClient } from '../src/wire.js'
import { CHUNKING_SUPPORTED } from './helpers/bun-floor.js'
import { startFakeReapi, type FakeCall, type FakeReapi } from './helpers/fake-reapi.js'

let fake: FakeReapi
let root: string
/** Fresh inputs per test, so each uploads its blobs rather than finding them held. */
let run = 0
beforeAll(async () => {
  fake = await startFakeReapi()
})
afterAll(() => fake.stop())
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-request-metadata-'))
  run++
  for (const p of ['a', 'b']) {
    await mkdir(path.join(root, p), { recursive: true })
    await writeFile(path.join(root, p, 'in.txt'), `${p} ${run}\n`)
  }
  fake.onExecute = () => ({ response: { result: { exit_code: 0 } } })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const request = (p: string): ExecuteRequest =>
  ({
    taskId: `${p}#gen`,
    workspaceRoot: root,
    cwd: path.join(root, p),
    command: 'gen',
    forwardArgs: [],
    env: {},
    envDefine: {},
    capture: { stdout: true, stderr: true },
    onStdout: () => undefined,
    onStderr: () => undefined,
    outputs: { files: [], workspaceFiles: [] },
    inputs: {
      files: [{ path: `${p}/in.txt`, digest: 'unused' }],
      env: [],
      runtime: [],
      workspaceRuntime: [],
      upstream: [],
      configDigest: 'y',
    },
  }) as unknown as ExecuteRequest

const header = (c: FakeCall): Buffer =>
  Buffer.from(c.metadata.get('build.bazel.remote.execution.v2.requestmetadata-bin')[0] as Buffer)

/** For each Execute, whether every upload sent since the client began names its action. */
function uploadsNameTheirAction(calls: readonly FakeCall[]): boolean[] {
  const executes = calls.filter((c) => c.method === 'Execute')
  return executes.map((e) => {
    const action = (e.request['action_digest'] as { hash: string }).hash
    const uploads = calls.filter(
      (c) =>
        c.method === 'BatchUpdateBlobs' &&
        (c.request['requests'] as { digest: { hash: string } }[]).some(
          (r) => r.digest.hash === action,
        ),
    )
    return uploads.length > 0 && [e, ...uploads].every((c) => header(c).includes(action))
  })
}

describe.if(CHUNKING_SUPPORTED)('RequestMetadata.action_id', () => {
  it('names the action whose blobs a call uploads, one task after another', async () => {
    const client = new ReapiClient({ endpoint: fake.endpoint })
    const before = fake.calls.length
    try {
      const ex = reapiExecutor(client, { warn: () => undefined })
      await ex.execute(request('a'))
      await ex.execute(request('b'))
    } finally {
      client.close()
    }
    expect(uploadsNameTheirAction(fake.calls.slice(before))).toEqual([true, true])
  })

  it('names each action when two run at once', async () => {
    const client = new ReapiClient({ endpoint: fake.endpoint })
    const before = fake.calls.length
    try {
      const ex = reapiExecutor(client, { warn: () => undefined })
      await Promise.all([ex.execute(request('a')), ex.execute(request('b'))])
    } finally {
      client.close()
    }
    expect(uploadsNameTheirAction(fake.calls.slice(before))).toEqual([true, true])
  })
})
