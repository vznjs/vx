// The key fold, pinned byte for byte. Every field `CacheKeyInput` folds is
// set, the list-valued ones out of order, and the input files arrive half
// through the caller's OID map and half from disk, so each branch of the
// fold runs. The expected digest and capture were recorded from
// `Cache.key` before the fold left the class (item 691): the move is
// behaviour-neutral only if both stay exactly these. The digest folds
// `CACHE_VERSION` first, so a bump re-pins it (v31, item 726) while the
// capture, which omits the version, stays byte for byte.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'
import { foldKey } from '../src/cache/key-fold.js'
import { relPosix } from '../src/util/index.js'

const root = mkdtempSync(path.join(tmpdir(), 'vx-key-fold-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
writeFileSync(path.join(root, 'b.ts'), 'export const b = 2\n')
writeFileSync(path.join(root, 'a.ts'), 'export const a = 1\n')

function input(captureInto?: Array<{ kind: string; name: string; hash: string }>) {
  return {
    taskId: 'pkg#build',
    taskConfigHash: 'cfg0123456789abc',
    envValues: [
      ['NODE_ENV', 'production'],
      ['A', 'B=C'],
    ] as Array<[string, string]>,
    runtimeValues: [['node --version', 'v22.12.0']] as Array<[string, string]>,
    workspaceRuntimeValues: [['git rev-parse HEAD', 'deadbeef']] as Array<[string, string]>,
    inputFiles: [path.join(root, 'b.ts'), path.join(root, 'a.ts')],
    workspaceRoot: root,
    upstreamHashes: ['ffff000011112222', '0000aaaabbbbcccc'],
    upstreamIds: new Map([['ffff000011112222', 'dep#build']]),
    workspaceFingerprint: 'fp00112233445566',
    forwardArgs: ['--watch', 'x y'],
    projectPackageJsonHash: 'pkgjson0123456789',
    fileHashes: new Map([[path.join(root, 'b.ts'), '1111111111111111111111111111111111111111']]),
    pluginParts: [['org/p:mode', 'strict']] as const,
    ...(captureInto === undefined ? {} : { captureInto }),
  }
}

describe('the key fold (item 691)', () => {
  it('derives the recorded digest and capture', async () => {
    const cache = new Cache(path.join(root, '.vx-cache'))
    try {
      const captured: Array<{ kind: string; name: string; hash: string }> = []
      const key = await cache.key(input(captured))
      expect(key).toBe('97648072ed6ca1e1')
      expect(captured.map((c) => `${c.kind} ${c.name} ${c.hash}`)).toEqual([
        'workspace fingerprint fp00112233445566',
        'package package.json pkgjson0123456789',
        'config config cfg0123456789abc',
        'forward argv 40a96bf38dd15c24',
        'env NODE_ENV eb15a7d3b00ce14e',
        'env A f5669cc027d6ebce',
        'runtime node --version c1c32dcd2fc8443d',
        'ws-runtime git rev-parse HEAD 5fdf728ed9b25e34',
        'upstream 0000aaaabbbbcccc 0000aaaabbbbcccc',
        'upstream dep#build ffff000011112222',
        'plugin org/p:mode 5a7aeb9f167e8e2b',
        // From disk: `git hash-object` of a.ts's bytes.
        'file a.ts 41715495f45f651e6cf7d38f58a3d512abcfa440',
        // From the caller's map, never read.
        'file b.ts 1111111111111111111111111111111111111111',
      ])
      expect(await cache.key(input())).toBe(key)
    } finally {
      cache.close()
    }
  })

  // What the playground calls: the fold with no `Cache` behind it. Its
  // hasher is asked only for the file the caller's map leaves out.
  it('is the same fold without a Cache, asking the hasher only for unmapped files', async () => {
    const asked: string[] = []
    const key = await foldKey(
      input(),
      async (f) => {
        asked.push(path.basename(f))
        return '41715495f45f651e6cf7d38f58a3d512abcfa440'
      },
      (f) => relPosix(root, f),
    )
    expect(key).toBe('97648072ed6ca1e1')
    expect(asked).toEqual(['a.ts'])
  })
})
