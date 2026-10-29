// An ActionResult read back through GetActionResult carries each digest's
// `size_bytes` as a STRING (proto-loader, `longs: String`). Sums over them
// concatenated: a record replay put each output file in a batch of its own,
// one BatchReadBlobs round trip per file, in sequence.
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
  root = await mkdtemp(path.join(tmpdir(), 'vx-record-sizes-'))
  await mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
  await writeFile(path.join(root, 'pkg', 'src', 'in.txt'), 'in\n')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

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
    outputs: { files: ['out/**'], workspaceFiles: [] },
    inputs: {
      files: [{ path: 'pkg/src/in.txt', digest: '4935e88d323e7973308dd73cccf2837fc3c7de22' }],
      env: [],
      runtime: [],
      workspaceRuntime: [],
      upstream: [],
      configDigest: 'y',
    },
  }) as unknown as ExecuteRequest

describe.if(CHUNKING_SUPPORTED)('a record replay', () => {
  it('reads its small output files in one batch', async () => {
    const files = Array.from({ length: 10 }, (_, i) => ({
      path: `pkg/out/f${i}.txt`,
      digest: fake.put(new TextEncoder().encode(`output ${i}\n`)),
      is_executable: false,
    }))
    fake.actions.set(execDigestFor('k-record-sizes').hash, { exit_code: 0, output_files: files })
    const client = new ReapiClient({ endpoint: fake.endpoint })
    const before = fake.calls.length
    try {
      const res = await reapiExecutor(client, { warn: () => undefined }).execute(
        request('k-record-sizes'),
      )
      expect(res.exitCode).toBe(0)
    } finally {
      client.close()
    }
    const calls = fake.calls.slice(before).map((c) => c.method)
    expect([
      calls.filter((m) => m === 'Execute').length,
      calls.filter((m) => m === 'BatchReadBlobs').length,
      await readFile(path.join(root, 'pkg', 'out', 'f9.txt'), 'utf8'),
    ]).toEqual([0, 1, 'output 9\n'])
  })

  it('reads an empty output as size 0, which a grafted Directory omits', async () => {
    const empty = fake.put(new Uint8Array())
    fake.actions.set(execDigestFor('k-record-empty').hash, {
      exit_code: 0,
      output_files: [{ path: 'pkg/out/e', digest: empty, is_executable: false }],
    })
    const client = new ReapiClient({ endpoint: fake.endpoint })
    try {
      const record = await client.getActionResult(execDigestFor('k-record-empty'))
      expect(record?.output_files?.map((f) => f.digest.size_bytes)).toEqual([0])
    } finally {
      client.close()
    }
  })
})
