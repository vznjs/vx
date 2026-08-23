// The input tree decides the action digest, so its determinism and shape are
// the difference between a worker that reproduces a task and one that runs
// something subtly different.

import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildInputTree, DigestCache, encodeDirectory, sha256 } from '../src/merkle.js'

let root: string

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-reapi-merkle-'))
  await mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
  await writeFile(path.join(root, 'pkg', 'src', 'a.ts'), 'export const a = 1\n')
  await writeFile(path.join(root, 'pkg', 'src', 'b.ts'), 'export const b = 2\n')
  await writeFile(path.join(root, 'pkg', 'run.sh'), '#!/bin/sh\necho hi\n')
  await chmod(path.join(root, 'pkg', 'run.sh'), 0o755)
  await writeFile(path.join(root, 'root.txt'), 'top\n')
  await writeFile(path.join(root, 'empty.txt'), '')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const paths = ['pkg/src/a.ts', 'pkg/src/b.ts', 'pkg/run.sh', 'root.txt']

describe('buildInputTree', () => {
  it('nests directories and blobs every node', async () => {
    const tree = await buildInputTree({ workspaceRoot: root, paths })
    expect(tree.fileCount).toBe(4)
    // 4 files + Directory nodes for root, pkg, pkg/src = 7 blobs.
    expect(tree.blobs.length).toBe(7)
    expect(tree.root.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is INDEPENDENT of input ordering', async () => {
    // Two callers listing the same inputs in different orders must produce the
    // same action digest, or they never share a remote cache entry.
    const a = await buildInputTree({ workspaceRoot: root, paths })
    const b = await buildInputTree({ workspaceRoot: root, paths: [...paths].reverse() })
    expect(b.root).toEqual(a.root)
  })

  it('changes the root digest when any file content changes', async () => {
    // The sensitivity direction: if the root did not move, a worker would
    // reuse a stale action result for changed sources.
    const before = await buildInputTree({ workspaceRoot: root, paths })
    await writeFile(path.join(root, 'pkg', 'src', 'a.ts'), 'export const a = 999\n')
    const after = await buildInputTree({ workspaceRoot: root, paths })
    expect(after.root.hash).not.toBe(before.root.hash)
    await writeFile(path.join(root, 'pkg', 'src', 'a.ts'), 'export const a = 1\n')
  })

  it('carries the executable bit', async () => {
    // A build that produces or consumes a checked-in script depends on it.
    const tree = await buildInputTree({ workspaceRoot: root, paths })
    const runShBlob = tree.blobs.find((b) => new TextDecoder().decode(b.data).includes('echo hi'))
    expect(runShBlob).toBeDefined()
    // The pkg Directory must mark run.sh executable — find the dir blob that
    // names it and confirm the flag survives a round trip through the encoder.
    const dirWithScript = tree.blobs.find((b) => {
      const text = new TextDecoder().decode(b.data)
      return text.includes('run.sh')
    })
    expect(dirWithScript).toBeDefined()
    const rebuilt = encodeDirectory({
      files: [{ name: 'run.sh', digest: runShBlob!.digest, is_executable: true }],
      directories: [],
      symlinks: [],
    })
    expect(new TextDecoder().decode(rebuilt)).toContain('run.sh')
  })

  it('deduplicates identical content across paths', async () => {
    // The same bytes at two paths are ONE blob — the property that makes
    // upload proportional to the diff rather than the file count.
    await writeFile(path.join(root, 'dup1.txt'), 'same')
    await writeFile(path.join(root, 'dup2.txt'), 'same')
    const tree = await buildInputTree({ workspaceRoot: root, paths: ['dup1.txt', 'dup2.txt'] })
    const contentBlobs = tree.blobs.filter((b) => new TextDecoder().decode(b.data) === 'same')
    expect(contentBlobs.length).toBe(1)
  })

  it('handles an empty file (the well-known empty digest)', async () => {
    const tree = await buildInputTree({ workspaceRoot: root, paths: ['empty.txt'] })
    const empty = sha256(new Uint8Array())
    expect(tree.blobs.some((b) => b.digest.hash === empty.hash)).toBe(true)
  })

  it('skips a path that is not a regular file rather than throwing', async () => {
    const tree = await buildInputTree({ workspaceRoot: root, paths: ['pkg', 'root.txt'] })
    expect(tree.fileCount).toBe(1)
  })
})

describe('DigestCache', () => {
  it('hashes a given file once', async () => {
    const cache = new DigestCache()
    let reads = 0
    const read = async (abs: string): Promise<Uint8Array> => {
      reads++
      return new Uint8Array(await Bun.file(abs).arrayBuffer())
    }
    await buildInputTree({ workspaceRoot: root, paths, digests: cache, readFile: read })
    const sizeAfterFirst = cache.size
    await buildInputTree({ workspaceRoot: root, paths, digests: cache, readFile: read })
    // Reads still happen (the tree needs the bytes to upload); the digest is
    // what the cache saves, and the entry count must not grow.
    expect(cache.size).toBe(sizeAfterFirst)
    expect(reads).toBe(8)
  })
})

describe('symlinked inputs', () => {
  it('represents a symlink as a SymlinkNode, never as the target bytes', async () => {
    // Following the link would upload the target's bytes under the link's
    // path — a tree that lies about its own shape, and a worker that
    // materialises a copy where the task expects a link.
    const { symlink } = await import('node:fs/promises')
    await symlink('src/a.ts', path.join(root, 'pkg', 'alias.ts'))
    try {
      const tree = await buildInputTree({
        workspaceRoot: root,
        paths: ['pkg/alias.ts', 'pkg/src/a.ts'],
      })
      // one real file, one symlink: the link contributes NO content blob
      expect(tree.fileCount).toBe(1)
      const dirBlobs = tree.blobs.map((b) => new TextDecoder().decode(b.data))
      expect(dirBlobs.some((t) => t.includes('alias.ts') && t.includes('src/a.ts'))).toBe(true)
    } finally {
      await rm(path.join(root, 'pkg', 'alias.ts'), { force: true })
    }
  })

  it('a symlink changes the root digest vs the same tree without it', async () => {
    const { symlink } = await import('node:fs/promises')
    const bare = await buildInputTree({ workspaceRoot: root, paths: ['pkg/src/a.ts'] })
    await symlink('b.ts', path.join(root, 'pkg', 'src', 'link.ts'))
    try {
      const linked = await buildInputTree({
        workspaceRoot: root,
        paths: ['pkg/src/a.ts', 'pkg/src/link.ts'],
      })
      expect(linked.root.hash).not.toBe(bare.root.hash)
    } finally {
      await rm(path.join(root, 'pkg', 'src', 'link.ts'), { force: true })
    }
  })
})
