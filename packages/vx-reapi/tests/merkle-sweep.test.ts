// Item 820's sweep of merkle.ts: each row fails with one line undone. The
// encoder rows compare bytes with protobufjs over the SAME vendored .proto
// files, as encoding.test.ts does; the tree rows build real input trees.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import protobuf from 'protobufjs'
import {
  buildInputTree,
  canDigest,
  concat,
  decodeDirectory,
  decodeTreeWithBytes,
  DigestCache,
  digestWith,
  encodeAction,
  encodeCommand,
  encodeDigest,
  encodeDirectory,
  encodeTree,
  hasherFor,
  sha256,
} from '../src/merkle.js'
import type { Directory } from '../src/wire.js'

const PROTOS = path.join(import.meta.dir, '..', 'protos')
const WELL_KNOWN = path.dirname(
  Bun.resolveSync('protobufjs/google/protobuf/descriptor.proto', import.meta.dir),
)
const proto = new protobuf.Root()
proto.resolvePath = (_origin, target) =>
  target.startsWith('google/protobuf/')
    ? path.join(WELL_KNOWN, path.basename(target))
    : path.join(PROTOS, target)
await proto.load('build/bazel/remote/execution/v2/remote_execution.proto')

/** encoding.test.ts's `camel`: protobufjs names, proto3 defaults stripped. */
const camel = (o: unknown): unknown => {
  if (Array.isArray(o)) return o.map(camel)
  if (o instanceof Uint8Array) return o
  if (o === null || typeof o !== 'object') return o
  return Object.fromEntries(
    Object.entries(o as Record<string, unknown>)
      .filter(([, v]) => v !== false && v !== 0 && v !== '')
      .map(([k, v]) => [k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()), camel(v)]),
  )
}
const ref = (name: string, obj: unknown): string => {
  const bytes = proto
    .lookupType(`build.bazel.remote.execution.v2.${name}`)
    .encode(camel(obj) as object)
    .finish()
  if (bytes.length === 0) throw new Error(`reference encoding of ${name} was EMPTY — harness bug`)
  return hex(bytes)
}
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')
const D = (hash: string, size_bytes: number) => ({ hash, size_bytes })

describe('the encoders against protobufjs', () => {
  it('a digest size at a varint boundary, and one past 2^31', () => {
    for (const size of [128, 2 ** 31 + 5]) {
      expect(hex(encodeDigest(D('a', size)))).toBe(ref('Digest', D('a', size)))
    }
  })

  it('a file’s node properties: the unix mode and an mtime past the half second', () => {
    const dir: Directory = {
      files: [
        {
          name: 'f',
          digest: D('a'.repeat(64), 3),
          is_executable: true,
          node_properties: { unixMode: 0o755, mtimeMs: 1_700_000_000_623 },
        },
      ],
      directories: [],
      symlinks: [],
    }
    expect(hex(encodeDirectory(dir))).toBe(
      ref('Directory', {
        files: [
          {
            name: 'f',
            digest: D('a'.repeat(64), 3),
            is_executable: true,
            node_properties: {
              unix_mode: { value: 0o755 },
              mtime: { seconds: 1_700_000_000, nanos: 623_000_000 },
            },
          },
        ],
      }),
    )
  })

  it('a command sorts its platform, legacy outputs and node properties', () => {
    const ours = encodeCommand({
      arguments: ['sh'],
      environmentVariables: [],
      outputPaths: ['out'],
      workingDirectory: '',
      platform: [
        { name: 'z', value: '1' },
        { name: 'a', value: '2' },
      ],
      legacyOutputFiles: ['f2', 'f1'],
      legacyOutputDirectories: ['d2', 'd1'],
      outputNodeProperties: ['unix_mode', 'mtime'],
    })
    expect(hex(ours)).toBe(
      ref('Command', {
        arguments: ['sh'],
        output_files: ['f1', 'f2'],
        output_directories: ['d1', 'd2'],
        platform: {
          properties: [
            { name: 'a', value: '2' },
            { name: 'z', value: '1' },
          ],
        },
        output_paths: ['out'],
        output_node_properties: ['mtime', 'unix_mode'],
      }),
    )
  })

  it('an action floors its timeout, omits an empty salt, and sorts its platform', () => {
    const ours = encodeAction({
      commandDigest: D('c', 1),
      inputRootDigest: D('r', 2),
      timeoutSeconds: 1.9,
      salt: new Uint8Array(0),
      platform: [
        { name: 'z', value: '1' },
        { name: 'a', value: '2' },
      ],
    })
    expect(hex(ours)).toBe(
      ref('Action', {
        command_digest: D('c', 1),
        input_root_digest: D('r', 2),
        timeout: { seconds: 1 },
        platform: {
          properties: [
            { name: 'a', value: '2' },
            { name: 'z', value: '1' },
          ],
        },
      }),
    )
  })

  it('a tree puts its children in field 2', () => {
    const child: Directory = { files: [], directories: [], symlinks: [{ name: 'l', target: 't' }] }
    const root: Directory = {
      files: [],
      directories: [{ name: 'c', digest: D('x', 1) }],
      symlinks: [],
    }
    expect(hex(encodeTree(root, [child]))).toBe(ref('Tree', { root, children: [child] }))
  })
})

describe('the decoders', () => {
  const file = { name: 'f', digest: D('h', 70_000), is_executable: false }

  it('a file’s node properties, as protobufjs writes them, are read back', () => {
    const bytes = proto
      .lookupType('build.bazel.remote.execution.v2.Directory')
      .encode(
        camel({
          files: [
            {
              name: 'f',
              digest: D('h', 1),
              node_properties: {
                unix_mode: { value: 0o640 },
                mtime: { seconds: 1_700_000_000, nanos: 623_000_000 },
              },
            },
          ],
        }) as object,
      )
      .finish()
    expect(decodeDirectory(bytes).files).toEqual([
      {
        name: 'f',
        digest: D('h', 1),
        is_executable: false,
        node_properties: { unixMode: 0o640, mtimeMs: 1_700_000_000_623 },
      },
    ])
  })

  it('a digest size past two varint bytes survives the round trip', () => {
    const dir: Directory = { files: [file], directories: [], symlinks: [] }
    expect(decodeDirectory(encodeDirectory(dir)).files[0]!.digest).toEqual(D('h', 70_000))
  })

  it('an explicit is_executable = 0 reads as false', () => {
    const name = [0x0a, 0x01, 0x66]
    const digest = [...encodeDigest(D('h', 1))]
    const fileNode = [...name, 0x12, digest.length, ...digest, 0x20, 0x00]
    const dir = new Uint8Array([0x0a, fileNode.length, ...fileNode])
    expect(decodeDirectory(dir).files[0]!.is_executable).toBe(false)
  })

  it('a file node stops at a wire type it does not read', () => {
    // A fixed32 field (wire 5) before the digest: read past, its four bytes
    // would parse as keys and the digest after them would land.
    const digest = [...encodeDigest(D('h', 1))]
    const fileNode = [0x0a, 0x01, 0x66, 0x35, 0, 0, 0, 0, 0x12, digest.length, ...digest]
    const dir = new Uint8Array([0x0a, fileNode.length, ...fileNode])
    expect(decodeDirectory(dir).files[0]!.digest).toEqual(D('', 0))
  })

  it('a tree stops at a field that is not length-delimited', () => {
    const root = encodeDirectory({ files: [file], directories: [], symlinks: [] })
    const buf = new Uint8Array([0x08, 0x01, 0x0a, root.length, ...root])
    expect(decodeTreeWithBytes(buf)).toEqual({ children: [], childDigests: [] })
  })

  it('a child’s digest is over the bytes sent, not our re-encoding of them', () => {
    // Symlink before file: valid protobuf, not the order our encoder writes.
    const raw = concat([
      encodeDirectory({ files: [], directories: [], symlinks: [{ name: 'l', target: 't' }] }),
      encodeDirectory({ files: [file], directories: [], symlinks: [] }),
    ])
    const buf = new Uint8Array([0x12, raw.length, ...raw])
    const tree = decodeTreeWithBytes(buf)
    expect(tree.childDigests).toEqual([sha256(raw).hash])
    expect(sha256(encodeDirectory(tree.children[0]!)).hash).not.toBe(sha256(raw).hash)
  })
})

describe('digest functions', () => {
  it('SHA1 is computed; an unsupported function is refused, and has no hasher', () => {
    const data = new TextEncoder().encode('x')
    expect(digestWith('SHA1', data)).toEqual({
      hash: createHash('sha1').update(data).digest('hex'),
      size_bytes: 1,
    })
    expect(() => digestWith('VSO', data)).toThrow('@vzn/vx-reapi: unsupported digest function VSO')
    expect(hasherFor('VSO')).toBeUndefined()
  })

  it('canDigest agrees with what this runtime’s createHash can do', () => {
    let blake3 = true
    try {
      createHash('blake3')
    } catch {
      blake3 = false
    }
    expect(canDigest('BLAKE3')).toBe(blake3)
  })
})

let root: string
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-reapi-merkle-sweep-'))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Every DirectoryNode reachable from `rootDigest` names a blob the tree carries. */
function dangling(
  rootDigest: string,
  blobs: readonly { digest: { hash: string }; data: Uint8Array }[],
) {
  const byHash = new Map(blobs.map((b) => [b.digest.hash, b.data]))
  const missing: string[] = []
  const walk = (hash: string, at: string) => {
    const data = byHash.get(hash)
    if (data === undefined) return void missing.push(at)
    for (const d of decodeDirectory(data).directories) walk(d.digest.hash, `${at}/${d.name}`)
  }
  walk(rootDigest, '')
  return missing
}

describe('buildInputTree and DigestCache', () => {
  it('a grafted Tree whose child bytes are not ours still resolves every directory', async () => {
    const file = { name: 'f', digest: sha256(new Uint8Array()), is_executable: false }
    const raw = concat([
      encodeDirectory({ files: [], directories: [], symlinks: [{ name: 'l', target: 't' }] }),
      encodeDirectory({ files: [file], directories: [], symlinks: [] }),
    ])
    const treeRoot: Directory = {
      files: [],
      directories: [{ name: 'sub', digest: sha256(raw) }],
      symlinks: [],
    }
    const blob = concat([encodeTree(treeRoot, []), new Uint8Array([0x12, raw.length]), raw])
    const decoded = decodeTreeWithBytes(blob)
    const tree = await buildInputTree({
      workspaceRoot: root,
      paths: [],
      treeGrafts: [
        {
          path: 'out',
          root: decoded.root!,
          children: decoded.children,
          childDigests: decoded.childDigests,
        },
      ],
    })
    expect(dangling(tree.root.hash, tree.blobs)).toEqual([])
  })

  it('a grafted child keeps its symlinks, and its blob ships', async () => {
    const child: Directory = { files: [], directories: [], symlinks: [{ name: 'l', target: 't' }] }
    const treeRoot: Directory = {
      files: [],
      directories: [{ name: 'sub', digest: sha256(encodeDirectory(child)) }],
      symlinks: [],
    }
    const tree = await buildInputTree({
      workspaceRoot: root,
      paths: [],
      treeGrafts: [{ path: 'out', root: treeRoot, children: [child] }],
    })
    expect(tree.blobs.map((b) => b.digest.hash)).toContain(sha256(encodeDirectory(child)).hash)
    expect(dangling(tree.root.hash, tree.blobs)).toEqual([])
  })

  it('a graft wins over a disk directory of the same name', async () => {
    await mkdir(path.join(root, 'out'), { recursive: true })
    await writeFile(path.join(root, 'out', 'stale.txt'), 'stale')
    const graftRoot: Directory = {
      files: [],
      directories: [],
      symlinks: [{ name: 'l', target: 't' }],
    }
    const tree = await buildInputTree({
      workspaceRoot: root,
      paths: ['out/stale.txt'],
      treeGrafts: [{ path: 'out', root: graftRoot, children: [] }],
    })
    const top = decodeDirectory(tree.blobs.find((b) => b.digest.hash === tree.root.hash)!.data)
    expect(top.directories).toEqual([{ name: 'out', digest: sha256(encodeDirectory(graftRoot)) }])
  })

  it('ensured directories sort, and an empty one is the root itself', async () => {
    const tree = (ensureDirs: string[]) =>
      buildInputTree({ workspaceRoot: root, paths: [], ensureDirs })
    expect((await tree(['b', 'a', ''])).root).toEqual((await tree(['a', 'b'])).root)
  })

  it('a file graft counts as a file', async () => {
    const tree = await buildInputTree({
      workspaceRoot: root,
      paths: [],
      fileGrafts: [{ path: 'g.txt', digest: D('a', 1), isExecutable: false }],
    })
    expect(tree.fileCount).toBe(1)
  })

  it('only the owner’s execute bit makes a file executable', async () => {
    await writeFile(path.join(root, 'grp.sh'), 'x')
    await chmod(path.join(root, 'grp.sh'), 0o655)
    const tree = await buildInputTree({ workspaceRoot: root, paths: ['grp.sh'] })
    const top = decodeDirectory(tree.blobs.find((b) => b.digest.hash === tree.root.hash)!.data)
    expect(top.files.map((f) => f.is_executable)).toEqual([false])
  })

  it('DigestCache: a hit is the stored digest; a new mtime at the same size is a miss', async () => {
    const file = path.join(root, 'cached.txt')
    await writeFile(file, 'aaaa')
    const cache = new DigestCache()
    const first = await cache.digestOf(file, new TextEncoder().encode('aaaa'))
    expect(await cache.digestOf(file, new TextEncoder().encode('zzzz'))).toEqual(first)
    await writeFile(file, 'bbbb')
    const later = new Date(Date.now() + 10_000)
    await utimes(file, later, later)
    const bbbb = new TextEncoder().encode('bbbb')
    expect(await cache.digestOf(file, bbbb)).toEqual(sha256(bbbb))
  })
})
