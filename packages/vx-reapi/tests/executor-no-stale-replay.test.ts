// An execution record replays its outputs from CAS without running the task:
// it is the remote executor's cache hit. A blob whose bytes do not hash to
// the digest the record names must make the replay a miss that executes,
// never a hit that writes the forged bytes (B-99).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ExecuteRequest } from '@vzn/vx'
import { execDigestFor } from '../src/cache.js'
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
  root = await mkdtemp(path.join(tmpdir(), 'vx-exec-replay-'))
  await mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
  await writeFile(path.join(root, 'pkg', 'src', 'in.txt'), 'in\n')
  fake.onExecute = () => ({ response: { result: { exit_code: 0 } } })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const bytes = (s: string) => new TextEncoder().encode(s)
/** The git blob id of `in.txt`'s bytes, as the key folds it. */
const IN_OID = '4935e88d323e7973308dd73cccf2837fc3c7de22'

const request = (cacheKey: string): ExecuteRequest =>
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
    outputs: { files: ['out.txt'], workspaceFiles: [] },
    inputs: {
      files: [{ path: 'pkg/src/in.txt', digest: IN_OID }],
      env: [],
      runtime: [],
      workspaceRuntime: [],
      upstream: [],
      packageJsonDigest: '',
      configDigest: 'y',
      workspaceFingerprint: 'z',
    },
  }) as unknown as ExecuteRequest

const executes = () => fake.calls.filter((c) => c.method === 'Execute').length
const out = () => readFile(path.join(root, 'pkg', 'out.txt'), 'utf8').catch(() => 'absent')

async function run(cacheKey: string): Promise<{ exitCode: number; executed: number }> {
  const client = new ReapiClient({ endpoint: fake.endpoint })
  const ex = reapiExecutor(client, { warn: () => undefined })
  try {
    const before = executes()
    const res = await ex.execute(request(cacheKey))
    return { exitCode: res.exitCode, executed: executes() - before }
  } finally {
    client.close()
  }
}

describe.if(CHUNKING_SUPPORTED)('a record replay', () => {
  it('meets a forged output blob and executes instead of writing it', async () => {
    const digest = fake.put(bytes('good output'))
    fake.actions.set(execDigestFor('k-forged-replay').hash, {
      exit_code: 0,
      output_files: [{ path: 'pkg/out.txt', digest, is_executable: false }],
    })
    // Same length, other bytes, under the honest digest.
    fake.blobs.set(digest.hash, bytes('evil output'))
    expect(await run('k-forged-replay')).toEqual({ exitCode: 0, executed: 1 })
    // The execution wrote nothing, and the replay took back what it wrote.
    expect(await out()).toBe('absent')
  })

  it('with the honest blob replays without executing (control)', async () => {
    const digest = fake.put(bytes('good output'))
    fake.actions.set(execDigestFor('k-honest-replay').hash, {
      exit_code: 0,
      output_files: [{ path: 'pkg/out.txt', digest, is_executable: false }],
    })
    expect(await run('k-honest-replay')).toEqual({ exitCode: 0, executed: 0 })
    expect(await out()).toBe('good output')
  })
})
