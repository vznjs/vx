// A restore never writes into Git's metadata (vercel/turborepo#14808).
// A `.git/` entry name is refused by name; a link on disk that resolves
// into `.git` (`dist/g -> ../.git`, inside the workspace, so containment
// passed it) carried `dist/g/hooks/pre-commit` into `.git/hooks`. The
// resolved path is held to the same rule, and an artifact's own link
// into `.git` is refused.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'
import { tarPack } from '../src/cache/tar-stream.js'
import { withSum } from './helpers/artifact-sum.js'
import { TAR_STORE } from './helpers/tar-store.js'

const HASH = '0123456789abcdef'
let root = ''
afterEach(() => rmSync(root, { recursive: true, force: true }))

// Past the inline threshold, so the artifact is a file a test can replace.
const BIG = crypto.getRandomValues(new Uint8Array(48 * 1024)).toBase64()
const OUT = { files: ['dist/**'], workspaceFiles: [] }

async function tarOf(files: Record<string, string>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  const inputs = Object.entries(files).map(([name, body]) => ({
    name,
    size: Buffer.byteLength(body),
    body,
  }))
  for await (const c of tarPack(inputs)) parts.push(c)
  return withSum(new Uint8Array(await new Blob(parts).arrayBuffer()))
}

/** A saved entry whose artifact is replaced by `files`; the restore base holds `.git/hooks`. */
async function forged(files: Record<string, string>): Promise<{ cache: Cache; dest: string }> {
  root = mkdtempSync(path.join(tmpdir(), 'vx-link-git-'))
  const src = path.join(root, 'src')
  mkdirSync(path.join(src, 'dist'), { recursive: true })
  writeFileSync(path.join(src, 'dist', 'a.txt'), BIG)
  const cache = new Cache(
    path.join(root, 'cache'),
    { read: true, write: true },
    undefined,
    undefined,
    undefined,
    undefined,
    TAR_STORE,
  )
  await cache.save({
    hash: HASH,
    entry: { taskId: 'p#build', command: 'build', durationMs: 1, stdout: '' },
    projectDir: src,
    outputFiles: [path.join(src, 'dist', 'a.txt')],
  })
  writeFileSync(cache.outputsPath(HASH), Bun.zstdCompressSync(await tarOf(files)))
  const dest = path.join(root, 'repo')
  mkdirSync(path.join(dest, '.git', 'hooks'), { recursive: true })
  mkdirSync(path.join(dest, 'dist'))
  return { cache, dest }
}

for (const [what, to] of [
  ['a link into .git', '../.git'],
  ['a link into a .git directory not there yet', '../.git/new'],
  ['a link into .git spelled in another case', '../.GIT'],
] as const) {
  it(`an entry is not written through ${what}`, async () => {
    const { cache, dest } = await forged({
      'outputs/dist/a.txt': BIG,
      'outputs/dist/g/hooks/pre-commit': '#!/bin/sh\necho pwned\n',
    })
    if (to === '../.GIT' && !existsSync(path.join(dest, '.GIT'))) mkdirSync(path.join(dest, '.GIT'))
    symlinkSync(to, path.join(dest, 'dist', 'g'))
    try {
      const err = await cache.restoreOutputs(HASH, dest, dest, OUT).then(
        () => null,
        (e: Error) => e.message,
      )
      expect(err).toStartWith(`${path.join(dest, 'dist', 'g')} is a symbolic link to `)
      expect(err).toContain("Git's metadata")
      expect(readdirSync(path.join(dest, '.git', 'hooks'))).toEqual([])
      expect(existsSync(path.join(dest, '.git', 'new'))).toBe(false)
    } finally {
      cache.close()
    }
  })
}

it("an artifact's link into .git is refused", async () => {
  const { cache, dest } = await forged({
    '.vx-meta.json': JSON.stringify({ files: {}, links: { 'outputs/dist/g': '../.git' } }),
    'outputs/dist/a.txt': BIG,
  })
  try {
    await expect(cache.restoreOutputs(HASH, dest, dest, OUT)).rejects.toThrow(
      'points into .git: ../.git',
    )
    expect(existsSync(path.join(dest, 'dist', 'g'))).toBe(false)
  } finally {
    cache.close()
  }
})

it('a .git-like name and a link to one restore', async () => {
  const { cache, dest } = await forged({
    '.vx-meta.json': JSON.stringify({ files: {}, links: { 'outputs/dist/l': '../.github' } }),
    'outputs/dist/a.txt': BIG,
    'outputs/dist/.gitkeep': 'x',
    'outputs/dist/h/.gitignore': 'x',
  })
  mkdirSync(path.join(dest, '.github'))
  symlinkSync('../.github', path.join(dest, 'dist', 'h'))
  try {
    await cache.restoreOutputs(HASH, dest, dest, OUT)
    expect(readdirSync(path.join(dest, '.github'))).toEqual(['.gitignore'])
    expect(existsSync(path.join(dest, 'dist', '.gitkeep'))).toBe(true)
  } finally {
    cache.close()
  }
})
