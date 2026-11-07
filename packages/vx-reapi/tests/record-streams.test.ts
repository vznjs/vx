// An execution record is the remote executor's cache hit: what it replays
// must be what the execution printed, both streams, and a replay the run
// has stopped must stop with it.
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ExecuteRequest } from '@vzn/vx'
import { execDigestFor } from '../src/cache.js'
import { materialiseOutputs, reapiExecutor } from '../src/executor.js'
import { ReapiClient } from '../src/wire.js'
import { startFakeReapi, type FakeReapi } from './helpers/fake-reapi.js'

let fake: FakeReapi
let root: string
beforeAll(async () => {
  fake = await startFakeReapi()
})
afterAll(() => fake.stop())
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-record-streams-'))
  await mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
  await writeFile(path.join(root, 'pkg', 'src', 'in.txt'), 'in\n')
  fake.holdReads = false
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The git blob id of `in.txt`'s bytes, as the key folds it. */
const IN_OID = '4935e88d323e7973308dd73cccf2837fc3c7de22'
const executes = () => fake.calls.filter((c) => c.method === 'Execute').length

const request = (
  cacheKey: string,
  printed: { out: string; err: string } = { out: '', err: '' },
  signal?: AbortSignal,
): ExecuteRequest =>
  ({
    taskId: 'pkg#gen',
    cacheKey,
    ...(signal === undefined ? {} : { signal }),
    workspaceRoot: root,
    cwd: path.join(root, 'pkg'),
    command: 'gen',
    forwardArgs: [],
    env: {},
    envDefine: {},
    capture: { stdout: true, stderr: true },
    onStdout: (s: string) => (printed.out += s),
    onStderr: (s: string) => (printed.err += s),
    outputs: { files: ['out.bin'], workspaceFiles: [] },
    inputs: {
      files: [{ path: 'pkg/src/in.txt', digest: IN_OID }],
      env: [],
      runtime: [],
      workspaceRuntime: [],
      upstream: [],
      configDigest: 'y',
    },
  }) as unknown as ExecuteRequest

const twice = async (cacheKey: string) => {
  const runs = []
  for (let i = 0; i < 2; i++) {
    const client = new ReapiClient({ endpoint: fake.endpoint })
    const printed = { out: '', err: '' }
    const ret = await reapiExecutor(client, { warn: () => undefined }).execute(
      request(cacheKey, printed),
    )
    client.close()
    runs.push({ printed, stdout: ret.stdout, stderr: ret.stderr })
  }
  return runs
}

it('a record replays stderr as the execution printed it, inline or from CAS', async () => {
  const big = `${'w'.repeat(99)}\n`.repeat(1000)
  for (const [key, err] of [
    ['streams-small', 'WARN: deprecated\n'],
    ['streams-big', big],
  ] as const) {
    fake.onExecute = () => ({
      response: {
        result: { exit_code: 0, stdout_raw: Buffer.from('OUT\n'), stderr_raw: Buffer.from(err) },
      },
    })
    const before = executes()
    const [fresh, replayed] = await twice(key)
    expect(executes() - before).toBe(1)
    expect(fresh).toEqual({ printed: { out: 'OUT\n', err }, stdout: 'OUT\n', stderr: err })
    expect(replayed).toEqual(fresh!)
  }
})

// A record from before stderr was kept cannot tell "printed nothing" from
// "not recorded", so it is never read: the task executes once more.
it('a record written before stderr was kept is not replayed', async () => {
  const payload = Buffer.from('vx-reapi-exec-v1\0streams-old', 'utf8')
  const v1 = createHash('sha256').update(payload).digest('hex')
  fake.actions.set(v1, { exit_code: 0, stdout_raw: Buffer.from('OUT\n') })
  fake.onExecute = () => ({
    response: {
      result: { exit_code: 0, stdout_raw: Buffer.from('OUT\n'), stderr_raw: Buffer.from('E\n') },
    },
  })
  const before = executes()
  const client = new ReapiClient({ endpoint: fake.endpoint })
  const printed = { out: '', err: '' }
  await reapiExecutor(client, { warn: () => undefined }).execute(request('streams-old', printed))
  client.close()
  expect([executes() - before, printed.err]).toEqual([1, 'E\n'])
})

// The README's promise: a fresh execution's stream that cannot be read fails
// the task. Read as '', it succeeded printing nothing and was recorded so.
it('a fresh execution whose stdout blob is gone fails, naming it, and records nothing', async () => {
  const body = Buffer.from('build log line\n')
  const hash = createHash('sha256').update(body).digest('hex')
  fake.onExecute = () => ({
    response: { result: { exit_code: 0, stdout_digest: { hash, size_bytes: body.length } } },
  })
  const client = new ReapiClient({ endpoint: fake.endpoint })
  const outcome = await reapiExecutor(client, { warn: () => undefined })
    .execute(request('streams-gone'))
    .then(
      (r) => `exit ${r.exitCode}`,
      (e: Error) => e.message,
    )
  client.close()
  expect(outcome).toContain(`stdout ${hash.slice(0, 12)}`)
  expect(outcome).toContain('missing from the CAS')
  expect(fake.actions.has(execDigestFor('streams-gone').hash)).toBe(false)
})

// Core settles the attempt on abort (the run's stop, `exec.timeout`) and
// may retry it; a replay still reading wrote its outputs over the retry's.
it('an abort during a record replay returns promptly and writes nothing', async () => {
  const digest = fake.put(new Uint8Array(2 * 1024 * 1024).fill(7))
  fake.actions.set(execDigestFor('streams-abort').hash, {
    exit_code: 0,
    output_files: [{ path: 'pkg/out.bin', digest, is_executable: false }],
  })
  fake.holdReads = true
  const client = new ReapiClient({ endpoint: fake.endpoint, callTimeoutMs: 8000 })
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 200)
  const t0 = performance.now()
  const before = executes()
  const ret = await reapiExecutor(client, { warn: () => undefined }).execute(
    request('streams-abort', undefined, ac.signal),
  )
  const ms = performance.now() - t0
  fake.holdReads = false
  client.close()
  expect(ms).toBeLessThan(2000)
  expect([ret.exitCode, executes() - before]).toEqual([143, 0])
  expect(existsSync(path.join(root, 'pkg', 'out.bin'))).toBe(false)
}, 30_000)

// The Read an abort abandons still answers later; its bytes must not land.
it('a restore whose attempt was aborted writes nothing', async () => {
  const digest = fake.put(Buffer.from('late\n'))
  const client = new ReapiClient({ endpoint: fake.endpoint })
  const ac = new AbortController()
  ac.abort()
  const outcome = await materialiseOutputs(
    client,
    { ...request('streams-late'), stop: ac.signal } as Parameters<typeof materialiseOutputs>[1],
    { exit_code: 0, output_files: [{ path: 'out.bin', digest, is_executable: false }] },
    () => undefined,
  ).then(
    () => 'written',
    () => 'refused',
  )
  client.close()
  expect([outcome, existsSync(path.join(root, 'pkg', 'out.bin'))]).toEqual(['refused', false])
})
