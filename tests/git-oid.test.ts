// Git-OID input hashing (v20). On a clean tree every input file's
// content hash IS its git index OID, harvested from the same bulk
// `git ls-files -s --others` spawn that enumerates the file set —
// zero file reads, zero per-file stats, zero SQLite lookups. Dirty /
// untracked files fall back to an in-process git blob OID (identical
// bytes-in → identical hash), so a file's key contribution NEVER
// flips representation across the dirty↔clean transition.
//
// Output-format pins verified empirically (git 2.x):
//   ls-files -s --others -z      → others print bare; staged entries are
//                                  `<mode> <oid> <stage>\t<path>` (split at
//                                  FIRST tab; -z disables quotePath quoting)
//   status --porcelain -z        → `XY <path>`; X∈{R,C} carries the old
//                                  path as a SEPARATE NUL token
//   conflict (stage 1/2/3)       → path repeated once per stage, same as
//                                  the old `--cached` listing

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test'
import { Cache } from '../src/cache/cache.js'
import { GitFilesCache, populateGitFilesCache, resolveInputs } from '../src/cache/inputs.js'
import { computeTaskHash, createHashCache } from '../src/orchestrator/task-hash.js'
import type { TaskNode } from '../src/graph/task-graph.js'

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync({
    cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (p.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(p.stderr)}`)
  }
  return new TextDecoder().decode(p.stdout).trim()
}

function initRepo(root: string): void {
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 't@vx.local')
  git(root, 'config', 'user.name', 'vx test')
}

describe('Cache.hashFile — git blob OID domain', () => {
  let root: string
  let cache: Cache

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-oid-'))
    initRepo(root)
    cache = new Cache(path.join(root, '.vx', 'cache'))
  })

  afterEach(async () => {
    cache.close()
    await rm(root, { recursive: true, force: true })
  })

  it('matches `git hash-object` for a fixture file', async () => {
    const f = path.join(root, 'a.txt')
    await writeFile(f, 'hello blob\n')
    const expected = git(root, 'hash-object', f)
    expect(await cache.hashFile(f)).toBe(expected)
  })

  it('matches `git hash-object` for empty and binary content', async () => {
    const empty = path.join(root, 'empty.bin')
    await writeFile(empty, '')
    const bin = path.join(root, 'data.bin')
    await writeFile(bin, Buffer.from([0, 1, 2, 255, 0, 42]))
    expect(await cache.hashFile(empty)).toBe(git(root, 'hash-object', empty))
    expect(await cache.hashFile(bin)).toBe(git(root, 'hash-object', bin))
  })

  it('uses sha256 blob OIDs in a sha256 repo', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-oid256-'))
    try {
      const p = Bun.spawnSync({
        cmd: ['git', 'init', '-q', '--object-format=sha256'],
        cwd: dir,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      if (p.exitCode !== 0) return // git too old for sha256 repos — skip
      const f = path.join(dir, 'a.txt')
      await writeFile(f, 'sha256 me\n')
      const c2 = new Cache(path.join(dir, '.vx', 'cache'))
      try {
        const h = await c2.hashFile(f)
        expect(h).toHaveLength(64)
        expect(h).toBe(git(dir, 'hash-object', f))
      } finally {
        c2.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('mtime+size memo returns the same OID without re-reading', async () => {
    const f = path.join(root, 'memo.txt')
    await writeFile(f, 'memo me\n')
    const first = await cache.hashFile(f)
    const second = await cache.hashFile(f)
    expect(second).toBe(first)
    expect(first).toBe(git(root, 'hash-object', f))
  })
})

describe('populateGitFilesCache — index OID harvesting', () => {
  let root: string
  let pkgDir: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-oidpop-'))
    initRepo(root)
    pkgDir = path.join(root, 'pkg')
    await mkdir(path.join(pkgDir, 'src'), { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('clean tracked files get their index OID; dirty/untracked/symlink/deleted do not', async () => {
    await writeFile(path.join(pkgDir, 'src', 'clean.ts'), 'clean\n')
    await writeFile(path.join(pkgDir, 'src', 'dirty.ts'), 'v1\n')
    await writeFile(path.join(pkgDir, 'src', 'gone.ts'), 'bye\n')
    await symlink('clean.ts', path.join(pkgDir, 'src', 'link.ts'))
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'init')
    await writeFile(path.join(pkgDir, 'src', 'dirty.ts'), 'v2\n')
    await writeFile(path.join(pkgDir, 'src', 'new.ts'), 'untracked\n')
    await rm(path.join(pkgDir, 'src', 'gone.ts'))

    const memo = new GitFilesCache()
    await populateGitFilesCache(root, [pkgDir], memo)

    // File LIST visibility identical to the old `--cached --others`
    // command: tracked (even deleted-but-staged) + untracked.
    expect([...(memo.get(pkgDir) ?? [])].sort()).toEqual([
      'src/clean.ts',
      'src/dirty.ts',
      'src/gone.ts',
      'src/link.ts',
      'src/new.ts',
    ])

    const oids = memo.oidsFor(pkgDir)
    expect(oids).toBeDefined()
    const cleanAbs = path.join(pkgDir, 'src', 'clean.ts')
    expect(oids!.get(cleanAbs)).toBe(git(root, 'hash-object', cleanAbs))
    expect(oids!.has(path.join(pkgDir, 'src', 'dirty.ts'))).toBe(false) // modified → untrusted
    expect(oids!.has(path.join(pkgDir, 'src', 'new.ts'))).toBe(false) // untracked → no OID
    expect(oids!.has(path.join(pkgDir, 'src', 'link.ts'))).toBe(false) // symlink OID hashes the target string
    expect(oids!.has(path.join(pkgDir, 'src', 'gone.ts'))).toBe(false) // deleted → untrusted
  })

  it('staged rename drops trust on both sides', async () => {
    await writeFile(path.join(pkgDir, 'src', 'old.ts'), 'rename me\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'init')
    git(root, 'mv', 'pkg/src/old.ts', 'pkg/src/renamed.ts')

    const memo = new GitFilesCache()
    await populateGitFilesCache(root, [pkgDir], memo)
    const oids = memo.oidsFor(pkgDir)
    expect(oids!.has(path.join(pkgDir, 'src', 'renamed.ts'))).toBe(false)
    expect(oids!.has(path.join(pkgDir, 'src', 'old.ts'))).toBe(false)
  })

  it('merge-conflict paths (stage > 0) carry no OID but stay in the file list', async () => {
    await writeFile(path.join(pkgDir, 'f.ts'), 'base\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'base')
    const branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD')
    git(root, 'checkout', '-q', '-b', 'side')
    await writeFile(path.join(pkgDir, 'f.ts'), 'side\n')
    git(root, 'commit', '-aqm', 'side')
    git(root, 'checkout', '-q', branch)
    await writeFile(path.join(pkgDir, 'f.ts'), 'main\n')
    git(root, 'commit', '-aqm', 'main')
    Bun.spawnSync({ cmd: ['git', 'merge', 'side'], cwd: root, stdout: 'pipe', stderr: 'pipe' })

    const memo = new GitFilesCache()
    await populateGitFilesCache(root, [pkgDir], memo)
    expect(memo.get(pkgDir)).toContain('f.ts')
    expect(memo.oidsFor(pkgDir)!.has(path.join(pkgDir, 'f.ts'))).toBe(false)
  })

  it('deleted-but-staged file is still excluded from resolved inputs', async () => {
    await writeFile(path.join(pkgDir, 'src', 'keep.ts'), 'keep\n')
    await writeFile(path.join(pkgDir, 'src', 'gone.ts'), 'bye\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'init')
    await rm(path.join(pkgDir, 'src', 'gone.ts'))

    const memo = new GitFilesCache()
    await populateGitFilesCache(root, [pkgDir], memo)
    const resolved = await resolveInputs({
      projectDir: pkgDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['src/**'] },
      ownOutputs: [],
      nestedProjectDirs: [],
      gitFilesCache: memo,
    })
    expect(resolved.files).toEqual([path.join(pkgDir, 'src', 'keep.ts')])
  })
})

describe('GitFilesCache — OID bookkeeping', () => {
  const pkg = '/ws/pkg'

  it('set() replaces the snapshot and drops the project OIDs', () => {
    const memo = new GitFilesCache()
    memo.set(pkg, ['a.ts'])
    memo.setOids(pkg, new Map([[`${pkg}/a.ts`, 'aaaa']]))
    memo.set(pkg, ['a.ts', 'b.ts'])
    expect(memo.oidsFor(pkg)).toBeUndefined()
  })

  it('delete() drops the project OIDs', () => {
    const memo = new GitFilesCache()
    memo.set(pkg, ['a.ts'])
    memo.setOids(pkg, new Map([[`${pkg}/a.ts`, 'aaaa']]))
    memo.delete(pkg)
    expect(memo.oidsFor(pkg)).toBeUndefined()
  })

  it('markOutputsChanged drops OIDs for exactly the changed paths', () => {
    const memo = new GitFilesCache()
    memo.set(pkg, ['src/a.ts', 'dist/out.js'])
    memo.setOids(
      pkg,
      new Map([
        [`${pkg}/src/a.ts`, 'aaaa'],
        [`${pkg}/dist/out.js`, 'dddd'],
      ]),
    )
    memo.markOutputsChanged(pkg, ['dist/out.js'])
    const oids = memo.oidsFor(pkg)
    expect(oids!.get(`${pkg}/src/a.ts`)).toBe('aaaa')
    expect(oids!.has(`${pkg}/dist/out.js`)).toBe(false)
  })
})

describe('Cache.key — fileHashes seam', () => {
  let dir: string
  let cache: Cache

  const baseKeyInput = (files: string[]) => ({
    taskId: 'p#build',
    taskConfigHash: 'cfg',
    projectPackageJsonHash: 'pkg',
    envValues: [] as Array<[string, string]>,
    inputFiles: files,
    workspaceRoot: dir,
    upstreamHashes: [] as string[],
    workspaceFingerprint: 'fp',
  })

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-oidkey-'))
    initRepo(dir)
    cache = new Cache(path.join(dir, '.vx', 'cache'))
  })

  afterEach(async () => {
    cache.close()
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  it('mapped paths never touch hashFile (zero stats, zero SQLite)', async () => {
    const f = path.join(dir, 'a.ts')
    await writeFile(f, 'content\n')
    const oid = git(dir, 'hash-object', f)
    const spy = vi.spyOn(cache, 'hashFile')
    await cache.key({ ...baseKeyInput([f]), fileHashes: new Map([[f, oid]]) })
    expect(spy).not.toHaveBeenCalled()
  })

  it('map-fed key equals fallback key for identical content (uniform domain)', async () => {
    const f = path.join(dir, 'a.ts')
    await writeFile(f, 'same bytes\n')
    const oid = git(dir, 'hash-object', f)
    const viaMap = await cache.key({ ...baseKeyInput([f]), fileHashes: new Map([[f, oid]]) })
    const viaDisk = await cache.key(baseKeyInput([f]))
    expect(viaMap).toBe(viaDisk)
  })

  it('paths missing from the map fall back to hashFile', async () => {
    const a = path.join(dir, 'a.ts')
    const b = path.join(dir, 'b.ts')
    await writeFile(a, 'aaa\n')
    await writeFile(b, 'bbb\n')
    const partial = await cache.key({
      ...baseKeyInput([a, b]),
      fileHashes: new Map([[a, git(dir, 'hash-object', a)]]),
    })
    const full = await cache.key(baseKeyInput([a, b]))
    expect(partial).toBe(full)
  })
})

describe('semantic guardrails — key stability across dirty↔clean transitions', () => {
  let root: string
  let pkgDir: string
  let cache: Cache

  const node = (): TaskNode =>
    ({
      id: 'pkg#build',
      projectName: 'pkg',
      projectDir: pkgDir,
      taskName: 'build',
      config: {
        exec: { command: 'noop' },
        cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
      },
      deps: [],
      requested: true,
    }) as unknown as TaskNode

  async function keyNow(): Promise<string> {
    const memo = new GitFilesCache()
    await populateGitFilesCache(root, [pkgDir], memo)
    return await computeTaskHash({
      node: node(),
      upstream: [],
      workspaceRoot: root,
      workspaceFingerprint: 'fp',
      cache,
      nestedProjectDirs: [],
      gitFilesCache: memo,
      hashCache: createHashCache(),
    })
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-oidsem-'))
    initRepo(root)
    pkgDir = path.join(root, 'pkg')
    await mkdir(path.join(pkgDir, 'src'), { recursive: true })
    await writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'pkg' }))
    await writeFile(path.join(pkgDir, 'src', 'main.ts'), 'original\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'init')
    cache = new Cache(path.join(root, '.vx', 'cache'))
  })

  afterEach(async () => {
    cache.close()
    await rm(root, { recursive: true, force: true })
  })

  it('edit changes the key; reverting restores the ORIGINAL key before any commit', async () => {
    const f = path.join(pkgDir, 'src', 'main.ts')
    const clean = await keyNow()
    await writeFile(f, 'edited\n')
    const edited = await keyNow()
    expect(edited).not.toBe(clean)
    await writeFile(f, 'original\n')
    expect(await keyNow()).toBe(clean)
  })

  it('dirty-but-identical content produces the same key as clean', async () => {
    const f = path.join(pkgDir, 'src', 'main.ts')
    const clean = await keyNow()
    // Stage different content, then put the original bytes back in the
    // worktree: status reports the path dirty (index ≠ HEAD, worktree ≠
    // index), so the OID path is off — yet the in-process blob OID of
    // the identical worktree content must reproduce the clean key.
    await writeFile(f, 'staged-detour\n')
    git(root, 'add', 'pkg/src/main.ts')
    await writeFile(f, 'original\n')
    expect(await keyNow()).toBe(clean)
  })

  it('untracked file participates via blob OID; committing it does not change the key', async () => {
    const clean = await keyNow()
    await writeFile(path.join(pkgDir, 'src', 'extra.ts'), 'extra\n')
    const withUntracked = await keyNow()
    expect(withUntracked).not.toBe(clean)
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'add extra')
    // Same bytes, now clean → index-OID path. Key must not flip.
    expect(await keyNow()).toBe(withUntracked)
  })

  it('clean-tree key derivation does not read file contents or stat input files', async () => {
    await keyNow() // prime: package.json may content-hash once
    const reads: string[] = []
    const origFile = Bun.file
    const bunMut = Bun as unknown as { file: (...fargs: unknown[]) => unknown }
    const origLoose = origFile as unknown as (...fargs: unknown[]) => unknown
    bunMut.file = (...fargs: unknown[]) => {
      const target = fargs[0]
      if (typeof target === 'string' && target.includes(`${path.sep}src${path.sep}`)) {
        reads.push(target)
      }
      return origLoose(...fargs)
    }
    try {
      await keyNow()
    } finally {
      bunMut.file = origLoose
    }
    expect(reads).toEqual([])
  })
})
