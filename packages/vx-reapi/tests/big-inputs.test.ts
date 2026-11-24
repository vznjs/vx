// A big input is hashed as it streams past and held by path, not its bytes:
// the input tree of a remote action held every input whole until the upload
// ended (600 MiB of inputs, ~625 MiB of RSS, per action in flight). The
// upload reads it again and refuses bytes that no longer carry the digest.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildInputTree } from '../src/merkle.js'
import { ReapiClient } from '../src/wire.js'
import { startFakeReapi, type FakeReapi } from './helpers/fake-reapi.js'

const MIB = 1024 * 1024
let fake: FakeReapi
let root: string
beforeAll(async () => {
  fake = await startFakeReapi()
})
afterAll(() => fake.stop())
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-reapi-big-'))
  fake.caps.maxBatchBytes = 4 * MIB
})
// Not a function beforeEach returns: Bun ignores it, and each test left
// 600 MiB in TMPDIR.
afterEach(() => rm(root, { recursive: true, force: true }))

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const oid = (b: Uint8Array) =>
  createHash('sha1').update(`blob ${b.byteLength}\0`).update(b).digest('hex')
const pattern = (n: number, seed: number) => {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff
  return b
}

async function withClient<T>(f: (c: ReapiClient) => Promise<T>): Promise<T> {
  const c = new ReapiClient({ endpoint: fake.endpoint })
  try {
    return await f(c)
  } finally {
    c.close()
  }
}

describe('big inputs', () => {
  it('build in bounded memory', async () => {
    for (const n of [1, 2, 3, 4])
      Bun.spawnSync(['sh', '-c', `head -c ${150 * MIB} /dev/urandom > ${root}/big${n}.bin`])
    const script = `
      import { buildInputTree } from ${JSON.stringify(path.join(import.meta.dir, '../src/merkle.ts'))}
      const t = await buildInputTree({ workspaceRoot: ${JSON.stringify(root)}, paths: ['big1.bin', 'big2.bin', 'big3.bin', 'big4.bin'] })
      const hwm = (await Bun.file('/proc/self/status').text()).match(/VmHWM:\\s+(\\d+)/)
      await Bun.write(${JSON.stringify(path.join(root, 'out.txt'))}, \`\${t.fileCount} \${hwm ? Math.round(Number(hwm[1]) / 1024) : 0}\`)`
    await writeFile(path.join(root, 'probe.ts'), script)
    const probe = Bun.spawnSync([process.execPath, path.join(root, 'probe.ts')])
    expect([probe.exitCode, probe.stderr.toString()]).toEqual([0, ''])
    // Written to a file: the probe's stdout came back empty on CI.
    const [files, peak] = (await Bun.file(path.join(root, 'out.txt')).text()).split(' ').map(Number)
    expect(files).toBe(4)
    // ~625 MiB held whole; a Bun process and the grpc imports sit near 60.
    if (process.platform === 'linux') expect(peak!).toBeLessThan(200)
  }, 60_000)

  it('carry the digest and the key OID they were read with, and upload whole', async () => {
    const big = pattern(9 * MIB + 7, 1) // past the batch budget: a ByteStream write
    const mid = pattern(2 * MIB + 3, 2) // under it: batched
    await writeFile(path.join(root, 'big'), big)
    await writeFile(path.join(root, 'mid'), mid)
    const tree = await buildInputTree({
      workspaceRoot: root,
      paths: ['big', 'mid'],
      expected: new Map([
        ['big', oid(big)],
        ['mid', oid(pattern(2 * MIB + 3, 9))],
      ]),
    })
    expect(tree.moved).toEqual(['mid'])
    expect(
      tree.blobs
        .filter((b) => 'file' in b)
        .map((b) => b.digest.hash)
        .sort(),
    ).toEqual([sha(big), sha(mid)].sort())
    await withClient((c) => c.uploadBlobs(tree.blobs))
    expect(fake.blobs.get(sha(big))).toEqual(big)
    expect(fake.blobs.get(sha(mid))).toEqual(mid)
  })

  it('changed after the tree was built are refused, never stored', async () => {
    for (const [name, size] of [
      ['big', 9 * MIB],
      ['mid', 2 * MIB],
    ] as const) {
      const before = pattern(size, 3)
      await writeFile(path.join(root, name), before)
      const tree = await buildInputTree({ workspaceRoot: root, paths: [name] })
      await writeFile(path.join(root, name), pattern(size, 4))
      const err = await withClient((c) => c.uploadBlobs(tree.blobs)).then(
        () => null,
        (e: Error) => e.message,
      )
      expect(err).toContain(`${name} changed since it was hashed`)
      expect(fake.blobs.has(sha(before))).toBe(false)
    }
  })
})
