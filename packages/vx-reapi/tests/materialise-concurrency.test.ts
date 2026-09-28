// Output files are fetched and written several at once (F-37): one at a
// time, 2 000 small outputs restored in ~1.2 s, 0.25 s at once.

import { afterEach, beforeEach, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { materialiseOutputs } from '../src/executor.js'
import { encodeTree, sha256 } from '../src/merkle.js'
import type { Directory } from '../src/wire.js'

const enc = new TextEncoder()
const have = new Map<string, Uint8Array>()
let ws: string
let inFlight = 0
let peak = 0

// No batch: every file is a readBlob, so the reads in flight are the files in flight.
const client = {
  batchReadBlobs: async () => new Map<string, Uint8Array>(),
  readBlob: async (d: { hash: string }) => {
    peak = Math.max(peak, ++inFlight)
    await Bun.sleep(2)
    inFlight--
    return have.get(d.hash) ?? null
  },
  digest: 'SHA256',
} as unknown as Parameters<typeof materialiseOutputs>[0]

const blob = (s: string) => {
  const b = enc.encode(s)
  const d = sha256(b)
  have.set(d.hash, b)
  return d
}

beforeEach(async () => {
  ws = await mkdtemp(path.join(tmpdir(), 'vx-mat-conc-'))
  inFlight = 0
  peak = 0
})
afterEach(() => rm(ws, { recursive: true, force: true }))

const req = () =>
  ({
    taskId: 'pkg#build',
    cwd: ws,
    workspaceRoot: ws,
    outputs: { files: ['**'], workspaceFiles: [] },
  }) as unknown as Parameters<typeof materialiseOutputs>[1]

const names = ['a', 'b', 'c', 'd', 'e']

it('output files are fetched and written at once, each with its own bytes', async () => {
  const result = {
    output_files: names.map((n) => ({
      path: `out/${n}.js`,
      digest: blob(n),
      is_executable: false,
    })),
  }
  await materialiseOutputs(client, req(), result as never, () => undefined)
  expect(peak).toBe(5)
  const got = await Promise.all(names.map((n) => readFile(path.join(ws, 'out', `${n}.js`), 'utf8')))
  expect(got).toEqual(names)
})

it("a Tree's files are fetched and written at once, each with its own bytes", async () => {
  const root: Directory = {
    files: names.map((n) => ({ name: `${n}.js`, digest: blob(`t${n}`), is_executable: false })),
    directories: [],
    symlinks: [],
  }
  const bytes = encodeTree(root, [])
  const treeDigest = sha256(bytes)
  have.set(treeDigest.hash, bytes)
  await materialiseOutputs(
    client,
    req(),
    { output_directories: [{ path: 'dist', tree_digest: treeDigest }] } as never,
    () => undefined,
  )
  // The Tree's own read comes first and alone; then the five files.
  expect(peak).toBe(5)
  const got = await Promise.all(
    names.map((n) => readFile(path.join(ws, 'dist', `${n}.js`), 'utf8')),
  )
  expect(got).toEqual(names.map((n) => `t${n}`))
})
