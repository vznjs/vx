// The blob-size check (A-60) reads each entry's OID, recorded size and
// stamps from the index bytes instead of `ls-files -s --debug`. Held to
// that listing over the shapes an index takes; a layout the reader does not
// take (v4, split index, a path not UTF-8) answers undefined and the
// listing asks git.

import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { indexBlobsOf } from '../src/cache/git-inputs.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-index-blobs-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(
    ['git', '-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
    { cwd, stdout: 'pipe', stderr: 'pipe' },
  )
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
  return p.stdout.toString()
}

/** What `ls-files -s -z --debug` lists from `cwd`: stage-0 regular entries. */
function listed(cwd: string, pathspecs: readonly string[], writtenSec: number) {
  const out = git(cwd, 'ls-files', '-s', '-z', '--debug', '--', ...pathspecs)
  const want = {
    paths: [] as string[],
    oids: [] as string[],
    sizes: [] as number[],
    sameSecond: [] as string[],
  }
  const segs = out.split('\0')
  let record = segs[0]!
  for (let i = 1; i < segs.length; i++) {
    const lines = segs[i]!.split('\n')
    const [meta, rel] = record.split('\t') as [string, string]
    const [mode, oid, stage] = meta.split(' ')
    const ctime = Number(lines[0]!.split(':')[1])
    const mtime = Number(lines[1]!.split(':')[1])
    const size = Number(/size: (\d+)/.exec(lines[4]!)![1])
    if ((mode === '100644' || mode === '100755') && stage === '0') {
      want.paths.push(rel)
      want.oids.push(oid!)
      want.sizes.push(size)
      if (ctime >= writtenSec && mtime < writtenSec) want.sameSecond.push(rel)
    }
    record = lines.slice(5).join('\n')
  }
  return want
}

async function indexOf(repo: string): Promise<{ bytes: Uint8Array; writtenSec: number }> {
  const file = path.join(repo, '.git', 'index')
  return {
    bytes: new Uint8Array(await readFile(file)),
    writtenSec: Math.floor((await stat(file)).mtimeMs / 1000),
  }
}

async function fixture(format: 'sha1' | 'sha256' = 'sha1'): Promise<string> {
  const repo = path.join(root, format)
  await mkdir(path.join(repo, 'ws', 'packages', 'a'), { recursive: true })
  await mkdir(path.join(repo, 'ws', 'packages', 'ab'), { recursive: true })
  git(repo, 'init', '-q', `--object-format=${format}`)
  await writeFile(path.join(repo, 'top.txt'), 'outside the workspace\n')
  await writeFile(path.join(repo, 'ws', 'packages', 'a', 'f.txt'), 'a\n')
  await writeFile(path.join(repo, 'ws', 'packages', 'a', 'run.sh'), '#!/bin/sh\n', { mode: 0o755 })
  await writeFile(path.join(repo, 'ws', 'packages', 'ab', 'g.txt'), 'ab\n')
  await writeFile(path.join(repo, 'ws', 'packages', 'a', 'naïve.txt'), 'utf-8 name\n')
  await writeFile(path.join(repo, 'ws', 'skip.txt'), 'skip\n')
  await writeFile(path.join(repo, 'ws', 'conflict.txt'), 'c\n')
  await symlink('f.txt', path.join(repo, 'ws', 'packages', 'a', 'link'))
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'fixture')
  // An intent-to-add entry, a skip-worktree one (v3's extended flags), an
  // assume-unchanged one, a gitlink, and an unmerged path in three stages.
  await writeFile(path.join(repo, 'ws', 'later.txt'), 'later\n')
  git(repo, 'add', '-N', 'ws/later.txt')
  git(repo, 'update-index', '--skip-worktree', 'ws/skip.txt')
  git(repo, 'update-index', '--assume-unchanged', 'ws/packages/a/f.txt')
  const head = git(repo, 'rev-parse', 'HEAD').trim()
  git(repo, 'update-index', '--add', '--cacheinfo', `160000,${head},ws/packages/a/sub`)
  const blob = git(repo, 'rev-parse', 'HEAD:ws/conflict.txt').trim()
  const info = [1, 2, 3].map((n) => `100644 ${blob} ${n}\tws/conflict.txt`).join('\n') + '\n'
  git(repo, 'update-index', '--force-remove', 'ws/conflict.txt')
  const p = Bun.spawnSync(['git', 'update-index', '--index-info'], {
    cwd: repo,
    stdin: new TextEncoder().encode(info),
  })
  expect(p.exitCode).toBe(0)
  return repo
}

it('reads what `ls-files --debug` lists, from the root and below a prefix, whole and scoped', async () => {
  const repo = await fixture()
  const { bytes, writtenSec } = await indexOf(repo)
  expect(bytes[7]).toBe(3)
  const ws = path.join(repo, 'ws')
  for (const [cwd, prefix, specs] of [
    [repo, '', ['.']],
    [ws, 'ws/', ['.']],
    [ws, 'ws/', ['packages/a']],
    [ws, 'ws/', ['packages/ab', 'skip.txt']],
  ] as const) {
    const want = listed(
      cwd,
      specs.map((s) => (s === '.' ? s : `:(literal)${s}`)),
      writtenSec,
    )
    expect(want.paths.length).toBeGreaterThan(0)
    expect(indexBlobsOf(bytes, 20, prefix, specs, writtenSec)).toEqual(want)
  }
  // Every second the index could have been written: the stamps agree too.
  for (const sec of [writtenSec - 1, writtenSec + 1]) {
    expect(indexBlobsOf(bytes, 20, '', ['.'], sec)).toEqual(listed(repo, ['.'], sec))
  }
})

it('reads a sha256 index', async () => {
  const repo = await fixture('sha256')
  const { bytes, writtenSec } = await indexOf(repo)
  expect(indexBlobsOf(bytes, 32, '', ['.'], writtenSec)).toEqual(listed(repo, ['.'], writtenSec))
})

it('leaves a v4, split or non-UTF-8 index to git', async () => {
  const repo = await fixture()
  git(repo, 'update-index', '--index-version', '4')
  expect(indexBlobsOf((await indexOf(repo)).bytes, 20, '', ['.'], 0)).toBeUndefined()
  git(repo, 'update-index', '--index-version', '2')
  expect(indexBlobsOf((await indexOf(repo)).bytes, 20, '', ['.'], 0)).toBeDefined()
  git(repo, 'update-index', '--split-index')
  expect(indexBlobsOf((await indexOf(repo)).bytes, 20, '', ['.'], 0)).toBeUndefined()
  git(repo, 'update-index', '--no-split-index')
  expect(indexBlobsOf((await indexOf(repo)).bytes, 20, '', ['.'], 0)).toBeDefined()
  const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9])
  const p = Bun.spawnSync(['git', 'update-index', '-z', '--index-info'], {
    cwd: repo,
    stdin: Buffer.concat([
      Buffer.from(`100644 ${git(repo, 'rev-parse', 'HEAD:top.txt').trim()} 0\t`),
      latin1,
      Buffer.from([0]),
    ]),
  })
  expect(p.exitCode).toBe(0)
  expect(indexBlobsOf((await indexOf(repo)).bytes, 20, '', ['.'], 0)).toBeUndefined()
})
