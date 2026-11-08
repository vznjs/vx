// A Tree may name one subtree under many names. Splitting a `dist/*`
// capture for the record encoded that subtree's Tree once per name: 4000
// names over one 4000-directory subtree took 65 s and 3.9 GB before the
// download's inode refusal. And the split record's entries were each held
// to the free inodes alone, so a replay wrote the sum of them.
// `statfs` and `encodeTree` are wrapped; `mock.module` holds for the whole
// file, so the rows have a file of their own.
import * as fsPromises from 'node:fs/promises'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ExecuteRequest } from '@vzn/vx'
import * as merkle from '../src/merkle.js'
import type { Directory } from '../src/wire.js'
import { CHUNKING_SUPPORTED } from './helpers/bun-floor.js'
import { startFakeReapi, type FakeReapi } from './helpers/fake-reapi.js'

const realFs = { ...fsPromises }
/** The free inodes `statfs` reports; undefined asks the real one. */
let room: number | undefined
await mock.module('node:fs/promises', () => ({
  ...realFs,
  statfs: async (...a: Parameters<typeof realFs.statfs>) =>
    room === undefined ? realFs.statfs(...a) : { files: 1e9, ffree: room, bavail: room },
}))
const realMerkle = { ...merkle }
let encodes = 0
await mock.module('../src/merkle.js', () => ({
  ...realMerkle,
  encodeTree: (...a: Parameters<typeof merkle.encodeTree>) => {
    encodes++
    return realMerkle.encodeTree(...a)
  },
}))
const { execDigestFor } = await import('../src/cache.js')
const { materialiseOutputs, reapiExecutor } = await import('../src/executor.js')
const { ReapiClient } = await import('../src/wire.js')
const { encodeDirectory, encodeTree, sha256 } = realMerkle

let fake: FakeReapi
let root: string
beforeAll(async () => {
  fake = await startFakeReapi()
})
afterAll(() => fake.stop())
beforeEach(async () => {
  encodes = 0
  root = realpathSync(await realFs.mkdtemp(path.join(tmpdir(), 'vx-shared-subtree-')))
  await realFs.mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
  await realFs.writeFile(path.join(root, 'pkg', 'src', 'in.txt'), 'in\n')
})
afterEach(async () => {
  // The mocks outlive this file in a one-process run.
  room = undefined
  await realFs.rm(root, { recursive: true, force: true })
})

const empty = sha256(new Uint8Array())
/** `names` names over one subtree of `width` directories, each one file. */
function shared(names: number, width: number): { top: Directory; children: Directory[] } {
  const kids: Directory[] = Array.from({ length: width }, (_, i) => ({
    files: [{ name: `f${i}`, digest: empty, is_executable: false }],
    directories: [],
    symlinks: [],
  }))
  const sub: Directory = {
    files: [],
    directories: kids.map((k, i) => ({ name: `d${i}`, digest: sha256(encodeDirectory(k)) })),
    symlinks: [],
  }
  const digest = sha256(encodeDirectory(sub))
  const top: Directory = {
    files: [],
    directories: Array.from({ length: names }, (_, i) => ({ name: `n${i}`, digest })),
    symlinks: [],
  }
  return { top, children: [sub, ...kids] }
}

/** The git blob id of `in.txt`'s bytes, as the key folded it. */
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
    outputs: { files: ['dist/*'], workspaceFiles: [] },
    // Nothing comes down: the record is the only reader of the Tree.
    remoteOnly: true,
    inputs: {
      files: [{ path: 'pkg/src/in.txt', digest: IN_OID }],
      env: [],
      runtime: [],
      workspaceRuntime: [],
      upstream: [],
      configDigest: 'y',
    },
  }) as unknown as ExecuteRequest

async function record(key: string, names: number, width: number) {
  const { top, children } = shared(names, width)
  const td = fake.put(encodeTree(top, children))
  fake.onExecute = () => ({
    response: {
      result: {
        exit_code: 0,
        output_directories: [
          { path: 'dist', tree_digest: { hash: td.hash, sizeBytes: td.size_bytes } },
        ],
      },
    },
  })
  const client = new ReapiClient({ endpoint: fake.endpoint })
  try {
    const from = fake.calls.length
    encodes = 0
    expect(
      (await reapiExecutor(client, { warn: () => undefined }).execute(request(key))).exitCode,
    ).toBe(0)
    const dirs = (
      fake.actions.get(execDigestFor(key).hash) as {
        output_directories: { path: string; tree_digest: { hash: string } }[]
      }
    ).output_directories
    const recorded = new Set(dirs.map((d) => d.tree_digest.hash))
    // Each copy of a recorded Tree sent up.
    const uploaded = fake.calls
      .slice(from)
      .filter((c) => c.method === 'BatchUpdateBlobs')
      .flatMap((c) => (c.request['requests'] as { digest: { hash: string } }[]) ?? [])
      .filter((r) => recorded.has(r.digest.hash))
    return { dirs, uploaded: uploaded.length, encodes }
  } finally {
    client.close()
  }
}

describe.if(CHUNKING_SUPPORTED)('a split capture over one shared subtree', () => {
  it("encodes and uploads the subtree's Tree once, not once per name", async () => {
    const { dirs, uploaded, encodes: n } = await record('k-shared', 50, 20)
    expect(dirs.length).toBe(50)
    expect(new Set(dirs.map((d) => d.tree_digest.hash)).size).toBe(1)
    expect(n).toBe(1)
    expect(uploaded).toBe(1)
  })

  it('past the free inodes is recorded whole, unsplit', async () => {
    // 50 names × (1 + 20 directories × 2 entries) = 2101 paths.
    room = 2000
    const { dirs, encodes: n } = await record('k-over', 50, 20)
    expect(dirs.map((d) => d.path)).toEqual(['pkg/dist'])
    expect(n).toBe(0)
  })
})

describe('a replayed record of many output directories', () => {
  const have = new Map<string, Uint8Array>()
  const client = {
    batchReadBlobs: async (ds: { hash: string }[]) =>
      new Map(ds.filter((d) => have.has(d.hash)).map((d) => [d.hash, have.get(d.hash)!])),
    readBlob: async (d: { hash: string }) => have.get(d.hash) ?? null,
    digest: 'SHA256',
  } as unknown as Parameters<typeof materialiseOutputs>[0]

  // Each Tree fits the free inodes; their sum does not. Checked one by one,
  // the replay wrote them all.
  it('is refused when their sum passes the free inodes, before a write', async () => {
    const { children } = shared(0, 20)
    const bytes = encodeTree(children[0]!, children.slice(1))
    const td = sha256(bytes)
    have.set(td.hash, bytes)
    // 41 paths each, 50 of them: 2050.
    room = 2000
    const result = {
      output_directories: Array.from({ length: 50 }, (_, i) => ({
        path: `pkg/dist/n${i}`,
        tree_digest: td,
      })),
    }
    const err = await materialiseOutputs(
      client,
      {
        taskId: 'pkg#gen',
        cwd: root,
        workspaceRoot: root,
        projectRel: 'pkg',
        replay: true,
        outputs: { files: ['dist/*'], workspaceFiles: [] },
      } as unknown as Parameters<typeof materialiseOutputs>[1],
      result as never,
      () => undefined,
    ).then(
      () => 'written',
      (e: Error) => e.message,
    )
    expect(err).toBe(
      `the server's 50 output directories expand to 2050 entries, more than the 2000 this file system has free — refused`,
    )
    expect(existsSync(path.join(root, 'pkg', 'dist'))).toBe(false)
  })
})
