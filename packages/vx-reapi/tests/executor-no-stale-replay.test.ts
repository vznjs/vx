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
      configDigest: 'y',
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

  // The action cache is the server's too: a record of a FAILED run (a worker
  // that caches one, or one written by another client) replayed as exit 0,
  // its outputs written and saved under the key.
  it('of a failed run executes instead of replaying it as a success', async () => {
    const digest = fake.put(bytes('output of a failed run'))
    fake.actions.set(execDigestFor('k-failed-replay').hash, {
      exit_code: 7,
      output_files: [{ path: 'pkg/out.txt', digest, is_executable: false }],
    })
    expect(await run('k-failed-replay')).toEqual({ exitCode: 0, executed: 1 })
    expect(await out()).toBe('absent')
  })
})

// Core marks a run it will not save under the key `unsaved` (--no-cache, a
// read-only policy, a tainted or keyless upstream). A record written then
// replays under the same key later: a dependant built against a failed
// upstream's outputs, hit once that upstream passes.
it('writes no record for an unsaved request, so the next run executes', async () => {
  const bad = fake.put(bytes('built against a failed upstream\n'))
  fake.onExecute = () => ({
    response: {
      result: {
        exit_code: 0,
        output_files: [
          { path: 'out.txt', digest: { hash: bad.hash, size_bytes: String(bad.size_bytes) } },
        ],
      },
    },
  })
  const client = new ReapiClient({ endpoint: fake.endpoint })
  try {
    const ex = reapiExecutor(client, { warn: () => undefined })
    expect((await ex.execute({ ...request('K-unsaved'), unsaved: true })).exitCode).toBe(0)
    expect(fake.actions.has(execDigestFor('K-unsaved').hash)).toBe(false)
    const before = executes()
    expect((await ex.execute(request('K-unsaved'))).exitCode).toBe(0)
    expect(executes() - before).toBe(1)
  } finally {
    client.close()
  }
})

// A dependant whose upstream's outputs are nowhere on this disk grafts them
// from that upstream's record. A record of a failed run (the action cache is
// the server's) was grafted, and the dependant ran on a failed build's
// outputs and was cached as a success.
describe.if(CHUNKING_SUPPORTED)('an upstream graft', () => {
  const dependant = (hash: string): ExecuteRequest => {
    const req = request(`k-dependant-of-${hash}`)
    return {
      ...req,
      inputs: {
        ...req.inputs!,
        upstream: [{ taskId: 'pkg#up', hash, outputs: ['pkg/up.txt'] }],
      },
    }
  }
  const graft = async (hash: string, exitCode: number) => {
    const digest = fake.put(bytes('upstream output'))
    fake.actions.set(execDigestFor(hash).hash, {
      exit_code: exitCode,
      output_files: [{ path: 'pkg/up.txt', digest, is_executable: false }],
    })
    const client = new ReapiClient({ endpoint: fake.endpoint })
    try {
      const before = executes()
      const res = await reapiExecutor(client, { warn: () => undefined })
        .execute(dependant(hash))
        .then(
          (r) => r.exitCode,
          (err: unknown) => (err instanceof Error ? err.message : String(err)),
        )
      return { res, executed: executes() - before }
    } finally {
      client.close()
    }
  }

  it("refuses a failed run's record", async () => {
    expect(await graft('k-up-failed', 3)).toEqual({
      res: 'upstream pkg#up outputs are in the remote store only as a failed run (exit 3) — re-run it (e.g. --force)',
      executed: 0,
    })
  })

  it("takes a passed run's record (control)", async () => {
    expect(await graft('k-up-passed', 0)).toEqual({ res: 0, executed: 1 })
  })
})
