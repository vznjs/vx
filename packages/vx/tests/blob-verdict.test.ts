// The blob-size check (A-60) keeps its verdict, the paths an index
// distrusts, by a hash of the index file, so a warm run reads one row and
// spawns no `--debug` listing. The verdict names paths: `git mv` keeps an
// entry's OID and recorded size, and a key of those alone handed the
// renamed file the old path's verdict, trusting a blob that stands for
// other bytes. The index file's bytes hold the path.

import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import {
  applyGitEnumeration,
  type BlobSizeMemo,
  GitFilesCache,
  startGitEnumeration,
} from '../src/cache/index.js'
import { relPosix } from '../src/util/index.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-verdict-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function git(...args: string[]): void {
  const p = Bun.spawnSync(
    ['git', '-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' },
  )
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
}

function memo(): BlobSizeMemo & { verdictReads: number } {
  const sizes = new Map<string, number>()
  const verdicts = new Map<string, string[]>()
  const m = {
    verdictReads: 0,
    knownBlobSizes: (oids: readonly string[]) =>
      new Map(oids.filter((o) => sizes.has(o)).map((o) => [o, sizes.get(o)!])),
    rememberBlobSizes: (learned: ReadonlyMap<string, number>) => {
      for (const [o, n] of learned) sizes.set(o, n)
    },
    blobVerdict: (digest: string) => {
      const v = verdicts.get(digest)
      if (v !== undefined) m.verdictReads++
      return v
    },
    rememberBlobVerdict: (digest: string, paths: readonly string[]) => {
      verdicts.set(digest, [...paths])
    },
  }
  return m
}

async function trusted(m: BlobSizeMemo, ws: string = root): Promise<string[]> {
  const cache = new GitFilesCache()
  await applyGitEnumeration(await startGitEnumeration(ws, ['.']), ws, [ws], cache, false, m)
  return [...(cache.oidsFor(ws)?.keys() ?? [])].map((p) => relPosix(ws, p)).sort()
}

it('a verdict is read by a digest of the paths too: a renamed resized entry stays distrusted', async () => {
  git('init', '-q')
  await writeFile(path.join(root, 'keep.txt'), 'k\n')
  await writeFile(path.join(root, 'f.txt'), 'aa\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  // The CRLF bytes added under autocrlf: the index keeps the LF blob and
  // records the CRLF file's size. Older than the index, so held clean.
  await writeFile(path.join(root, 'f.txt'), 'aa\r\n')
  const past = new Date(Date.now() - 10_000)
  await utimes(path.join(root, 'f.txt'), past, past)
  git('-c', 'core.autocrlf=true', 'add', 'f.txt')

  // Past the racy window, so the index is old enough to key a verdict.
  await Bun.sleep(150)
  const m = memo()
  expect(await trusted(m)).toEqual(['keep.txt'])
  // Warm: the same index reads its verdict.
  expect(await trusted(m)).toEqual(['keep.txt'])
  expect(m.verdictReads).toBe(1)

  // Committed, so status holds `g.txt` clean: same OID, same size, new path.
  git('mv', 'f.txt', 'g.txt')
  git('commit', '-qm', 'rename')
  await Bun.sleep(150)
  expect(await trusted(m)).toEqual(['keep.txt'])
})

it('an index written as the enumeration starts asks no verdict; an older one does', async () => {
  // The key is read beside the listing, not with it: an index written in
  // between paired one index's verdict with the other's entries. A memo
  // whose verdict says nothing is resized shows which runs ask it.
  git('init', '-q')
  await writeFile(path.join(root, 'keep.txt'), 'k\n')
  await writeFile(path.join(root, 'f.txt'), 'aa\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  await writeFile(path.join(root, 'f.txt'), 'aa\r\n')
  const past = new Date(Date.now() - 10_000)
  await utimes(path.join(root, 'f.txt'), past, past)
  git('-c', 'core.autocrlf=true', 'add', 'f.txt')
  const lying: BlobSizeMemo = { ...memo(), blobVerdict: () => [] }

  // The index was written just now: the lie is not asked.
  expect(await trusted(lying)).toEqual(['keep.txt'])
  // Past the racy window (FILE_HASH_RACY_MS), the index is old enough for
  // its key, and the memo's word is taken: the control that it is asked.
  await Bun.sleep(150)
  expect(await trusted(lying)).toEqual(['f.txt', 'keep.txt'])
})

it('a verdict is keyed by the workspace too: a nested workspace on the same index reads its own', async () => {
  // The verdict names paths relative to the workspace root, so a nested
  // workspace sharing the cache (`VX_CACHE_DIR`) read the outer one's
  // `sub/f.txt` as nothing to distrust and trusted a blob for other bytes.
  git('init', '-q')
  await mkdir(path.join(root, 'sub'))
  await writeFile(path.join(root, 'sub', 'keep.txt'), 'k\n')
  await writeFile(path.join(root, 'sub', 'f.txt'), 'aa\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  await writeFile(path.join(root, 'sub', 'f.txt'), 'aa\r\n')
  const past = new Date(Date.now() - 10_000)
  await utimes(path.join(root, 'sub', 'f.txt'), past, past)
  git('-c', 'core.autocrlf=true', 'add', 'sub/f.txt')
  await Bun.sleep(150)

  const m = memo()
  expect(await trusted(m)).toEqual(['sub/keep.txt'])
  expect(await trusted(m, path.join(root, 'sub'))).toEqual(['keep.txt'])
})
