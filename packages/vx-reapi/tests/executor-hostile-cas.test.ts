// A server whose execution's outputs or logs cannot be fetched as their
// digests name (bytes that hash to another digest, a size that lies, a blob
// the CAS lacks) failed the task with the integrity error, naming no next
// step, though the action itself may have built fine. The bytes are refused
// as before; the task is given back to vx, which runs it here and says so.
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'bun:test'
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

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const ghost = { hash: createHash('sha256').update('ghost').digest('hex'), size_bytes: 5 }
const outcome = async (key: string, files: string[]) => {
  const err = await execute(request(key, files)).then(
    () => null,
    (e: unknown) => e as Error,
  )
  return {
    name: err?.name,
    reason: err?.message.split(':')[0],
    written: existsSync(path.join(root, 'pkg', 'out.txt')),
  }
}

it('outputs served as other bytes are given back to vx, none written', async () => {
  const good = fake.put(enc('good\n'))
  fake.blobs.set(good.hash, enc('evil\n'))
  fake.onExecute = () => ({
    response: { result: { exit_code: 0, output_files: [{ path: 'out.txt', digest: good }] } },
  })
  expect(await outcome('k-hostile-bytes', ['out.txt'])).toEqual({
    name: 'ExecutorFallback',
    reason: 'its outputs or logs could not be fetched as the server named them',
    written: false,
  })
})

it('an output whose digest names the wrong size is given back to vx', async () => {
  const d = fake.put(enc('three\n'))
  fake.onExecute = () => ({
    response: {
      result: {
        exit_code: 0,
        output_files: [{ path: 'out.txt', digest: { hash: d.hash, size_bytes: 3 } }],
      },
    },
  })
  expect((await outcome('k-hostile-size', ['out.txt'])).name).toBe('ExecutorFallback')
})

it('an output, a Tree or a stdout the CAS lacks is given back to vx', async () => {
  const results = [
    { exit_code: 0, output_files: [{ path: 'out.txt', digest: ghost }] },
    { exit_code: 0, output_directories: [{ path: 'gen', tree_digest: ghost }] },
    { exit_code: 0, stdout_digest: ghost },
  ]
  for (const [i, result] of results.entries()) {
    fake.onExecute = () => ({ response: { result } })
    expect((await outcome(`k-hostile-gone-${i}`, ['out.txt', 'gen/**'])).name).toBe(
      'ExecutorFallback',
    )
  }
})

// Size 0 was read as "no output" whatever the hash: a server that leaves
// size_bytes unset lost a task's log without a word. Only the empty blob's
// own digest is taken unread, as for output files.
it('a stdout or stderr of size 0 under a hash that is not the empty blob is given back', async () => {
  const d = fake.put(enc('the real log\n'))
  for (const field of ['stdout_digest', 'stderr_digest']) {
    fake.onExecute = () => ({
      response: { result: { exit_code: 0, [field]: { hash: d.hash, size_bytes: 0 } } },
    })
    expect((await outcome(`k-hostile-zero-${field}`, [])).name).toBe('ExecutorFallback')
  }
  const empty = fake.put(enc(''))
  fake.onExecute = () => ({ response: { result: { exit_code: 0, stdout_digest: empty } } })
  expect((await outcome('k-hostile-zero-empty', [])).name).toBeUndefined()
})

it('CONTROL: honest outputs land, nothing given back', async () => {
  const d = fake.put(enc('honest\n'))
  fake.onExecute = () => ({
    response: { result: { exit_code: 0, output_files: [{ path: 'out.txt', digest: d }] } },
  })
  expect(await outcome('k-hostile-control', ['out.txt'])).toEqual({
    name: undefined,
    reason: undefined,
    written: true,
  })
})
