// The tree form (`cache.store.decompress`) keeps each output at its index
// row's path and nothing else: no `.vx-meta.json` sidecar and no `outputs/`
// level, each of which took a 4 KiB block per entry (~8 of the ~16 KiB a
// small entry spent on the file system, 2026-11-07). Every fact the sidecar
// held is in the index, but a link's target, which the tree keeps as the
// link itself; an upload rebuilds the artifact from the rows.
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { scanTarBytes } from '../src/cache/archive.js'
import { Cache, DEFAULT_STORE, type StoreOptions } from '../src/cache/cache.js'
import { tarPack } from '../src/cache/tar-stream.js'
import { withSum } from './helpers/artifact-sum.js'
import { TAR_STORE } from './helpers/tar-store.js'

const HASH = '0123456789abcdef'
const BODY = crypto.getRandomValues(new Uint8Array(48 * 1024))

let root: string
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'vx-tree-layout-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const open = (name: string, store: StoreOptions): Cache =>
  new Cache(path.join(root, name), undefined, undefined, undefined, undefined, undefined, store)

/** Save a task with a file, an executable, a link, an empty and a 0700 directory, and a workspace file. */
async function saved(name: string, store: StoreOptions): Promise<Cache> {
  const ws = path.join(root, `ws-${name}`)
  const proj = path.join(ws, 'p')
  mkdirSync(path.join(proj, 'out/empty'), { recursive: true })
  mkdirSync(path.join(proj, 'out/keys'))
  mkdirSync(path.join(ws, 'gen'))
  writeFileSync(path.join(proj, 'out/a.bin'), BODY)
  writeFileSync(path.join(proj, 'out/keys/k'), 'k')
  writeFileSync(path.join(proj, 'out/run.sh'), '#!/bin/sh\n')
  chmodSync(path.join(proj, 'out/run.sh'), 0o755)
  symlinkSync('a.bin', path.join(proj, 'out/l'))
  writeFileSync(path.join(ws, 'gen/w.txt'), 'w')
  // One mtime for both saves, so two stores' artifacts compare whole.
  const at = new Date(1_700_000_000_123)
  for (const f of ['out/a.bin', 'out/keys/k', 'out/run.sh']) utimesSync(path.join(proj, f), at, at)
  utimesSync(path.join(ws, 'gen/w.txt'), at, at)
  chmodSync(path.join(proj, 'out/keys'), 0o700)
  const cache = open(name, store)
  await cache.save({
    hash: HASH,
    entry: { taskId: 'p#build', command: 'build', durationMs: 1, stdout: 'built\n', cpuMs: 7 },
    projectDir: proj,
    outputFiles: ['out/a.bin', 'out/keys/k', 'out/run.sh', 'out/l'].map((f) => path.join(proj, f)),
    outputDirs: [path.join(proj, 'out/empty')],
    workspaceOutputFiles: [path.join(ws, 'gen/w.txt')],
    workspaceRoot: ws,
  })
  return cache
}

const treeOf = (name: string): string => {
  const rel = readdirSync(path.join(root, name), { recursive: true })
    .map(String)
    .find((n) => n.endsWith(`${HASH}.tree`))!
  return path.join(root, name, rel)
}

async function scanOfUpload(cache: Cache) {
  const pinned = await cache.pinArtifact(HASH)
  const bytes = new Uint8Array(await pinned.body.arrayBuffer())
  await pinned.release()
  const scan = scanTarBytes(Bun.zstdDecompressSync(bytes))
  return {
    ...scan,
    entries: scan.entries
      .map((e) => ({ ...e, mtimeMs: Math.floor(e.mtimeMs) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    dirs: [...scan.dirs].sort(),
    dirModes: [...scan.dirModes].sort(([a], [b]) => a.localeCompare(b)),
  }
}

it('a saved tree holds each output at its row path, with no sidecar and no outputs/ level', async () => {
  const cache = await saved('t', DEFAULT_STORE)
  try {
    const tree = treeOf('t')
    const names = readdirSync(tree, { recursive: true }).map(String).sort()
    expect(names).not.toContain('.vx-meta.json')
    expect(names).not.toContain('outputs')
    expect(names).toEqual(
      expect.arrayContaining([
        'out/a.bin',
        'out/keys/k',
        'out/run.sh',
        'workspace-outputs/gen/w.txt',
      ]),
    )
    expect(readlinkSync(path.join(tree, 'out/l'))).toBe('a.bin')
  } finally {
    cache.close()
  }
})

it('a tree uploads every fact the tar form of the same save carries', async () => {
  const tree = await saved('t', DEFAULT_STORE)
  const tar = await saved('z', TAR_STORE)
  try {
    expect(await scanOfUpload(tree)).toEqual(await scanOfUpload(tar))
  } finally {
    tree.close()
    tar.close()
  }
})

it('an ingested tree has the saved layout and restores what was saved', async () => {
  const from = await saved('t', DEFAULT_STORE)
  const into = open('o', DEFAULT_STORE)
  try {
    const pinned = await from.pinArtifact(HASH)
    await into.ingest(HASH, pinned.body, { taskId: 'p#build', command: 'build', durationMs: 1 })
    await pinned.release()
    const names = readdirSync(treeOf('o'), { recursive: true }).map(String)
    expect(names).not.toContain('.vx-meta.json')
    expect(names).not.toContain('outputs')
    const ws = path.join(root, 'restored')
    const proj = path.join(ws, 'p')
    await into.restoreOutputs(HASH, proj, ws)
    expect(readlinkSync(path.join(proj, 'out/l'))).toBe('a.bin')
    expect(lstatSync(path.join(proj, 'out/run.sh')).mode & 0o777).toBe(0o755)
    expect(lstatSync(path.join(proj, 'out/keys')).mode & 0o777).toBe(0o700)
    expect(lstatSync(path.join(proj, 'out/empty')).isDirectory()).toBe(true)
    expect(lstatSync(path.join(ws, 'gen/w.txt')).size).toBe(1)
    expect(await scanOfUpload(into)).toEqual(await scanOfUpload(from))
  } finally {
    from.close()
    into.close()
  }
})

it('a stored link retargeted at rest is not uploaded, and is named corrupt', async () => {
  const cache = await saved('t', DEFAULT_STORE)
  try {
    const link = path.join(treeOf('t'), 'out/l')
    unlinkSync(link)
    symlinkSync('keys/k', link)
    const pinned = await cache.pinArtifact(HASH).then(
      async (p) => {
        await p.release()
        return 'packed'
      },
      (e: Error) => e.name,
    )
    expect(pinned).toBe('CorruptArtifactError')
  } finally {
    cache.close()
  }
})

// A tree keeps a project output at its rel and a workspace one under
// `workspace-outputs/`: a project output by that name would be read back as
// a workspace output. The pack refuses one; so does the ingest.
it('an artifact naming a project output under workspace-outputs/ is refused at ingest', async () => {
  const meta = JSON.stringify({ version: 1, key: HASH, files: {} })
  const parts: Uint8Array[] = []
  for await (const c of tarPack([
    { name: 'stdout', size: 0, body: '' },
    { name: 'outputs/workspace-outputs/x', size: 1, body: 'x' },
    { name: '.vx-meta.json', size: Buffer.byteLength(meta), body: meta },
  ])) {
    parts.push(c)
  }
  const tar = await withSum(new Uint8Array(await new Blob(parts).arrayBuffer()))
  const cache = open('o', DEFAULT_STORE)
  try {
    const err = await cache
      .ingest(HASH, new Blob([Bun.zstdCompressSync(tar)]), {
        taskId: 'p#build',
        command: 'build',
        durationMs: 1,
      })
      .then(
        () => null,
        (e: Error) => e,
      )
    expect(String(err)).toContain('workspace-outputs/')
    expect(await cache.get(HASH)).toBeNull()
  } finally {
    cache.close()
  }
})
