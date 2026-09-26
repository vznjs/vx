import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import type { Database } from 'bun:sqlite'
import {
  Cache,
  type CacheKeyInput,
  CorruptArtifactError,
  FULL_CACHE_POLICY,
  type InvocationRecord,
  parseCachePolicy,
  zstdContentSize,
} from '../src/cache/cache.js'
import { decodedTar } from '../src/cache/zstd.js'
import { UserError, xxh3hex } from '../src/util/index.js'
import { skipAsRoot } from './helpers/nonroot-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { run } from '../src/orchestrator/index.js'

describe('zstdContentSize (frame-header parse)', () => {
  const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
  // desc byte = (fcsFlag << 6) | (singleSegment << 5) | dictIdFlag
  it('1-byte FCS (fcsFlag 0, singleSegment) reads the single size byte', () => {
    // desc 0x20 = fcsFlag 0 + singleSegment 1 + dictId 0 → 1-byte FCS, no window desc.
    expect(zstdContentSize(new Uint8Array([...MAGIC, 0x20, 100]))).toBe(100n)
  })
  it('2-byte FCS (fcsFlag 1) applies the spec +256 adjustment', () => {
    // desc 0x60 = fcsFlag 1 + singleSegment 1. Stored value = actual − 256, LE.
    // 744 (0x02E8) stored → 744 + 256 = 1000.
    expect(zstdContentSize(new Uint8Array([...MAGIC, 0x60, 0xe8, 0x02]))).toBe(1000n)
  })
  it('4-byte FCS (fcsFlag 2) reads a little-endian uint32', () => {
    // desc 0xA0 = fcsFlag 2 + singleSegment 1. 65536 = 0x00010000 LE.
    expect(zstdContentSize(new Uint8Array([...MAGIC, 0xa0, 0x00, 0x00, 0x01, 0x00]))).toBe(65536n)
  })
  it('skips the Dictionary_ID bytes before the FCS field', () => {
    // desc 0x21 = fcsFlag 0 + singleSegment 1 + dictIdFlag 1 → 1 dict-id byte,
    // then a 1-byte FCS. The dict byte (0xAB) must be skipped, not read as size.
    expect(zstdContentSize(new Uint8Array([...MAGIC, 0x21, 0xab, 50]))).toBe(50n)
  })
  it('returns null for a streaming frame that omits the content size', () => {
    // desc 0x00 = fcsFlag 0 + singleSegment 0 → FCS field is 0 bytes (absent);
    // one window-descriptor byte follows the desc.
    expect(zstdContentSize(new Uint8Array([...MAGIC, 0x00, 0x40]))).toBeNull()
  })
  it('returns null for a too-short buffer or a wrong magic number', () => {
    expect(zstdContentSize(new Uint8Array([0x28, 0xb5, 0x2f]))).toBeNull()
    expect(zstdContentSize(new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x20, 1]))).toBeNull()
  })
})

describe('parseCachePolicy', () => {
  it('defaults every axis on with an empty spec', () => {
    expect(parseCachePolicy('')).toEqual(FULL_CACHE_POLICY)
  })

  it('local:rw,remote:r → remote read-only (local stays rw)', () => {
    expect(parseCachePolicy('local:rw,remote:r')).toEqual({
      localRead: true,
      localWrite: true,
      remoteRead: true,
      remoteWrite: false,
    })
  })

  it('local:r leaves remote at its base value', () => {
    expect(parseCachePolicy('local:r')).toEqual({
      localRead: true,
      localWrite: false,
      remoteRead: true,
      remoteWrite: true,
    })
  })

  it('remote: with empty flags turns remote fully off', () => {
    expect(parseCachePolicy('remote:')).toEqual({
      localRead: true,
      localWrite: true,
      remoteRead: false,
      remoteWrite: false,
    })
  })

  it('flag order is irrelevant (wr == rw)', () => {
    expect(parseCachePolicy('local:wr')).toEqual(parseCachePolicy('local:rw'))
  })

  it('applies on top of a provided base', () => {
    const base = { localRead: false, localWrite: false, remoteRead: false, remoteWrite: false }
    expect(parseCachePolicy('local:r', base)).toEqual({
      localRead: true,
      localWrite: false,
      remoteRead: false,
      remoteWrite: false,
    })
  })

  it('throws on an unknown layer', () => {
    expect(() => parseCachePolicy('disk:r')).toThrow(UserError)
    expect(() => parseCachePolicy('disk:r')).toThrow(/invalid --cache layer/)
  })

  it('throws on an unknown flag', () => {
    expect(() => parseCachePolicy('local:x')).toThrow(/invalid --cache flag/)
  })

  it('throws on a missing colon', () => {
    expect(() => parseCachePolicy('local')).toThrow(/invalid --cache segment/)
  })

  it('throws on a repeated flag', () => {
    expect(() => parseCachePolicy('local:rr')).toThrow(/repeated/)
  })

  it('throws on a repeated layer', () => {
    expect(() => parseCachePolicy('local:r,local:w')).toThrow(/specified twice/)
  })

  it('skips empty segments (trailing / doubled commas)', () => {
    // A `,,` or trailing `,` yields empty segments that are ignored, not
    // treated as a malformed layer.
    expect(parseCachePolicy('local:r,,remote:')).toEqual(parseCachePolicy('local:r,remote:'))
    expect(parseCachePolicy('local:r,')).toEqual(parseCachePolicy('local:r'))
  })
})

describe('Cache.key', () => {
  let dir: string
  let cache: Cache
  let workspaceRoot: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'nxt-cache-key-'))
    workspaceRoot = dir
    cache = new Cache(path.join(dir, '.vx', 'cache'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function writeInput(name: string, content: string): Promise<string> {
    const p = path.join(dir, name)
    await writeFile(p, content)
    return p
  }

  function baseInput(): CacheKeyInput {
    return {
      taskId: 'pkg#build',
      taskConfigHash: 'config-hash-base',
      projectPackageJsonHash: 'pkg-hash-base',
      envValues: [],
      inputFiles: [],
      workspaceRoot,
      upstreamHashes: [],
      workspaceFingerprint: 'ws-fp-base',
    }
  }

  /**
   * Set mtime to "now + 1 second" so the cache's (path, mtimeMs, size)
   * fast-path treats the file as freshly changed. Used by tests that
   * rewrite a same-size payload — without this they're flaky on fast
   * disks where two writeFile calls land in the same millisecond.
   */
  async function bumpMtime(filePath: string): Promise<void> {
    const t = new Date(Date.now() + 1000)
    await utimes(filePath, t, t)
  }

  it('is deterministic across repeated calls with identical input', async () => {
    const a = await cache.key(baseInput())
    const b = await cache.key(baseInput())
    expect(a).toBe(b)
  })

  it('changes when the resolved task config hash changes', async () => {
    const a = await cache.key({ ...baseInput(), taskConfigHash: 'aaa' })
    const b = await cache.key({ ...baseInput(), taskConfigHash: 'bbb' })
    expect(a).not.toBe(b)
  })

  it('changes when the taskId changes', async () => {
    const a = await cache.key({ ...baseInput(), taskId: 'a#build' })
    const b = await cache.key({ ...baseInput(), taskId: 'b#build' })
    expect(a).not.toBe(b)
  })

  it('changes when forwardArgs differ', async () => {
    const a = await cache.key({ ...baseInput(), forwardArgs: ['--watch'] })
    const b = await cache.key({ ...baseInput(), forwardArgs: [] })
    const c = await cache.key({ ...baseInput(), forwardArgs: ['--watch', '--bail'] })
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
    expect(b).not.toBe(c)
  })

  it('treats empty forwardArgs and omitted forwardArgs as equivalent', async () => {
    const a = await cache.key({ ...baseInput(), forwardArgs: [] })
    const b = await cache.key(baseInput())
    expect(a).toBe(b)
  })

  it('changes when an input file content changes (not just mtime)', async () => {
    const f = await writeInput('a.txt', 'one')
    const a = await cache.key({ ...baseInput(), inputFiles: [f] })
    await writeFile(f, 'two')
    // Bump mtime forward so the cache's (path, mtimeMs, size) fast-
    // path doesn't return the stale hash for `one`. Two writes that
    // complete inside the same ms (fast CI disk) otherwise share an
    // mtime — and 'one' / 'two' are both 3 bytes, so size doesn't
    // disambiguate either.
    await bumpMtime(f)
    const b = await cache.key({ ...baseInput(), inputFiles: [f] })
    expect(a).not.toBe(b)
  })

  it('does not change when only mtime changes (content identical)', async () => {
    const f = await writeInput('a.txt', 'same')
    const a = await cache.key({ ...baseInput(), inputFiles: [f] })
    // Touch file (rewrite same content; mtime updates).
    await writeFile(f, 'same')
    const b = await cache.key({ ...baseInput(), inputFiles: [f] })
    expect(a).toBe(b)
  })

  it('is independent of input file order in the array', async () => {
    const f1 = await writeInput('one.txt', 'first')
    const f2 = await writeInput('two.txt', 'second')
    const a = await cache.key({ ...baseInput(), inputFiles: [f1, f2] })
    const b = await cache.key({ ...baseInput(), inputFiles: [f2, f1] })
    expect(a).toBe(b)
  })

  // `key()` no longer copies and sorts unconditionally — it checks the order
  // first, because the only caller that matters hands it a sorted list and
  // the copy cost 7.4 ms of a 44-task run (2026-09-20). The row above breaks
  // the order at the FIRST pair; this one breaks it at the last, where an
  // off-by-one in that scan would let an unsorted list through unsorted.
  it('sorts a list whose only inversion is at the end', async () => {
    const files = [
      await writeInput('a.txt', '1'),
      await writeInput('b.txt', '2'),
      await writeInput('c.txt', '3'),
      await writeInput('d.txt', '4'),
    ].sort()
    const sorted = await cache.key({ ...baseInput(), inputFiles: files })
    const lastTwoSwapped = [...files.slice(0, -2), files.at(-1)!, files.at(-2)!]
    expect(await cache.key({ ...baseInput(), inputFiles: lastTwoSwapped })).toBe(sorted)
  })

  // The folded name is the file's path RELATIVE to the workspace root, and
  // that relativization is memoized per Cache for the run. A memo that
  // outlived a change of root would fold one workspace's names under
  // another's — the same key for two different trees.
  it('follows the workspace root when it changes under one Cache', async () => {
    // The file sits INSIDE root-a, so the two roots disagree about its name
    // (`in-a.txt` against `root-a/in-a.txt`). A file outside both would be
    // `../in-a.txt` either way and the row would pass with the memo broken —
    // which is how the first draft of it passed (2026-09-20).
    const rootA = path.join(dir, 'root-a')
    const rootB = path.join(dir, 'root-b')
    await mkdir(rootA, { recursive: true })
    await mkdir(rootB, { recursive: true })
    const f = path.join(rootA, 'in-a.txt')
    await writeFile(f, 'bytes')
    const under = async (c: Cache, workspaceRoot: string): Promise<string> =>
      await c.key({ ...baseInput(), inputFiles: [f], workspaceRoot })
    const first = await under(cache, rootA)
    const reused = await under(cache, rootB)
    expect(reused).not.toBe(first)
    const fresh = new Cache(path.join(dir, 'cache-fresh'))
    try {
      expect(reused).toBe(await under(fresh, rootB))
    } finally {
      fresh.close()
    }
  })

  it('changes when an env-input value changes', async () => {
    const a = await cache.key({ ...baseInput(), envValues: [['MODE', 'a']] })
    const b = await cache.key({ ...baseInput(), envValues: [['MODE', 'b']] })
    expect(a).not.toBe(b)
  })

  it('env name/value boundary is unambiguous (no `=` delimiter collision)', async () => {
    // `A` = `B=C` and `A=B` = `C` would both fold the string "A=B=C"
    // under a naive `${name}=${value}` join. Env names with `=` are
    // unreachable from a real POSIX environ, but the key derivation
    // contract is unambiguity, not "unlikely in practice".
    const a = await cache.key({ ...baseInput(), envValues: [['A', 'B=C']] })
    const b = await cache.key({ ...baseInput(), envValues: [['A=B', 'C']] })
    expect(a).not.toBe(b)
  })

  // An unset name folds its bare name, which no `name\0value` can spell. The
  // candidates are the values nearest that encoding: empty, and the name.
  it('an empty value, an unset name and an unlisted one are three keys', async () => {
    const keys = [
      await cache.key({ ...baseInput(), envValues: [['MODE', '']] }),
      await cache.key({ ...baseInput(), envValues: [['MODE', 'MODE']] }),
      await cache.key({ ...baseInput(), envValues: [['MODE', undefined]] }),
      await cache.key({ ...baseInput(), envValues: [] }),
    ]
    expect(new Set(keys).size).toBe(4)
  })

  it('different runtime output → different key', async () => {
    const a = await cache.key({ ...baseInput(), runtimeValues: [['node -v', 'v20']] })
    const b = await cache.key({ ...baseInput(), runtimeValues: [['node -v', 'v22']] })
    expect(a).not.toBe(b)
  })

  it('same runtime output → same key', async () => {
    const a = await cache.key({ ...baseInput(), runtimeValues: [['node -v', 'v20']] })
    const b = await cache.key({ ...baseInput(), runtimeValues: [['node -v', 'v20']] })
    expect(a).toBe(b)
  })

  it('runtime vs workspaceRuntime are namespaced (no aliasing)', async () => {
    const a = await cache.key({ ...baseInput(), runtimeValues: [['cmd', 'out']] })
    const b = await cache.key({ ...baseInput(), workspaceRuntimeValues: [['cmd', 'out']] })
    expect(a).not.toBe(b)
  })

  it('absent runtime fields → key unchanged vs explicit empty', async () => {
    const a = await cache.key(baseInput())
    const b = await cache.key({ ...baseInput(), runtimeValues: [], workspaceRuntimeValues: [] })
    expect(a).toBe(b)
  })

  it('changes when an upstream hash changes', async () => {
    const a = await cache.key({ ...baseInput(), upstreamHashes: ['aaa'] })
    const b = await cache.key({ ...baseInput(), upstreamHashes: ['bbb'] })
    expect(a).not.toBe(b)
  })

  it('is independent of upstream hash order', async () => {
    const a = await cache.key({ ...baseInput(), upstreamHashes: ['aaa', 'bbb'] })
    const b = await cache.key({ ...baseInput(), upstreamHashes: ['bbb', 'aaa'] })
    expect(a).toBe(b)
  })

  it('changes when the workspace fingerprint changes', async () => {
    const a = await cache.key({ ...baseInput(), workspaceFingerprint: 'a' })
    const b = await cache.key({ ...baseInput(), workspaceFingerprint: 'b' })
    expect(a).not.toBe(b)
  })

  it('produces different keys for two projects with identical relative trees', async () => {
    const f = await writeInput('a.txt', 'shared')
    const a = await cache.key({ ...baseInput(), taskId: 'pkg-a#build', inputFiles: [f] })
    const b = await cache.key({ ...baseInput(), taskId: 'pkg-b#build', inputFiles: [f] })
    expect(a).not.toBe(b)
  })

  // v12 — project package.json hash folded into every task's cache key
  // implicitly (Turbo/Nx "implicit dependencies" parity).
  it('changes when the projectPackageJsonHash changes', async () => {
    const a = await cache.key({ ...baseInput(), projectPackageJsonHash: 'aaa' })
    const b = await cache.key({ ...baseInput(), projectPackageJsonHash: 'bbb' })
    expect(a).not.toBe(b)
  })

  it('treats projectPackageJsonHash = "" (no package.json) deterministically', async () => {
    // Empty string is the documented sentinel for "project has no
    // package.json" (impossible in practice — workspace discovery
    // requires one — but we don't fail-loud). Two cold runs with
    // an empty pkg hash must collide on every other axis.
    const a = await cache.key({ ...baseInput(), projectPackageJsonHash: '' })
    const b = await cache.key({ ...baseInput(), projectPackageJsonHash: '' })
    expect(a).toBe(b)
  })

  it('zero-byte input files participate in the key (existence matters)', async () => {
    const f1 = await writeInput('empty.txt', '')
    const f2 = await writeInput('absent.txt', '')
    // First key uses [f1]; second uses [f1, f2]. The second has more inputs.
    const a = await cache.key({ ...baseInput(), inputFiles: [f1] })
    const b = await cache.key({ ...baseInput(), inputFiles: [f1, f2] })
    expect(a).not.toBe(b)
  })

  it('binary input file content participates in the key (byte-for-byte)', async () => {
    const p = path.join(dir, 'bin.dat')
    // Two payloads that differ in a single mid-byte; the hash must
    // distinguish them. Verifies the streaming hash sees raw bytes,
    // not text-decoded content.
    const a = Buffer.from([0, 1, 2, 3, 0xff, 0xfe, 0, 0])
    const b = Buffer.from([0, 1, 2, 3, 0xff, 0xfd, 0, 0])
    await writeFile(p, a)
    const ka = await cache.key({ ...baseInput(), inputFiles: [p] })
    await writeFile(p, b)
    // Same-length payload + sub-ms write timing means the cache's
    // mtime+size fast-path can match `a`'s entry on `b`'s stat.
    // Bump mtime so the fast-path skips and the content hash runs.
    await bumpMtime(p)
    const kb = await cache.key({ ...baseInput(), inputFiles: [p] })
    expect(ka).not.toBe(kb)
  })

  it('hashes large input files correctly (no in-memory truncation)', async () => {
    // 2 MB file. Bun.file().stream() yields chunks lazily; if the
    // hasher ever truncated, two large files differing only in their
    // tail would collide. Property to verify: hash is sensitive to a
    // single byte change at the end.
    const a = Buffer.alloc(2 * 1024 * 1024, 0x41)
    const b = Buffer.from(a)
    b[b.length - 1] = 0x42
    const p = path.join(dir, 'big.bin')
    await writeFile(p, a)
    const ka = await cache.key({ ...baseInput(), inputFiles: [p] })
    await writeFile(p, b)
    // Same size, and on a fast disk possibly the same mtime tick —
    // bump mtime so the (path, mtimeMs, size) fast path can't return
    // the stale hash for `a`.
    await bumpMtime(p)
    const kb = await cache.key({ ...baseInput(), inputFiles: [p] })
    expect(ka).not.toBe(kb)
  })

  it('is stable when inputs / env / upstream are all empty', async () => {
    // Tasks with no file inputs (lint with `cache.inputs.files: []`) still
    // get a deterministic key. Two runs in succession should match.
    const a = await cache.key({ ...baseInput() })
    const b = await cache.key({ ...baseInput() })
    expect(a).toBe(b)
  })

  // Tier-3 capture is a PURE side-channel. These guard the
  // CACHE_VERSION-not-bumped claim: the digest must be byte-identical
  // with and without `captureInto`, across a fully-populated input.
  it('captureInto does not change the derived key (pure side-channel)', async () => {
    const f1 = await writeInput('cap-a.txt', 'alpha')
    const f2 = await writeInput('cap-b.txt', 'beta')
    const full: CacheKeyInput = {
      ...baseInput(),
      taskId: 'pkg#build',
      taskConfigHash: 'cfg-1',
      projectPackageJsonHash: 'pkg-1',
      workspaceFingerprint: 'ws-1',
      forwardArgs: ['--watch', '--bail'],
      envValues: [['MODE', 'prod']],
      runtimeValues: [['node -v', 'v20']],
      workspaceRuntimeValues: [['uname', 'Linux']],
      upstreamHashes: ['up-aaa', 'up-bbb'],
      upstreamIds: new Map([
        ['up-aaa', 'dep-a#build'],
        ['up-bbb', 'dep-b#build'],
      ]),
      inputFiles: [f1, f2],
    }
    const without = await cache.key({ ...full })
    const sink: Array<{ kind: string; name: string; hash: string }> = []
    const withCap = await cache.key({ ...full, captureInto: sink })
    expect(withCap).toBe(without)
    // Re-run to confirm full determinism with capture present.
    const again = await cache.key({ ...full, captureInto: [] })
    expect(again).toBe(without)
  })

  it('captureInto records exactly one row per component, per the fold map', async () => {
    const f1 = await writeInput('one.txt', '1')
    const f2 = await writeInput('two.txt', '2')
    const sink: Array<{ kind: string; name: string; hash: string }> = []
    await cache.key({
      ...baseInput(),
      taskConfigHash: 'cfg-x',
      projectPackageJsonHash: 'pkg-x',
      workspaceFingerprint: 'ws-x',
      forwardArgs: ['--flag'],
      envValues: [
        ['MODE', 'a'],
        ['DEBUG', '1'],
      ],
      runtimeValues: [['node -v', 'v20']],
      workspaceRuntimeValues: [['uname', 'Linux']],
      upstreamHashes: ['up-1'],
      upstreamIds: new Map([['up-1', 'dep#build']]),
      inputFiles: [f1, f2],
      captureInto: sink,
    })

    const byKind = (kind: string): Array<{ name: string; hash: string }> =>
      sink.filter((r) => r.kind === kind).map((r) => ({ name: r.name, hash: r.hash }))

    expect(byKind('workspace')).toEqual([{ name: 'fingerprint', hash: 'ws-x' }])
    expect(byKind('package')).toEqual([{ name: 'package.json', hash: 'pkg-x' }])
    expect(byKind('config')).toEqual([{ name: 'config', hash: 'cfg-x' }])
    // Value-bearing kinds capture a DIGEST, never the plaintext — secrets in
    // env / runtime output / argv must not land in cache.db.
    expect(byKind('forward')).toEqual([{ name: 'argv', hash: xxh3hex(JSON.stringify(['--flag'])) }])
    expect(byKind('env')).toEqual([
      { name: 'MODE', hash: xxh3hex('a') },
      { name: 'DEBUG', hash: xxh3hex('1') },
    ])
    expect(byKind('runtime')).toEqual([{ name: 'node -v', hash: xxh3hex('v20') }])
    expect(byKind('ws-runtime')).toEqual([{ name: 'uname', hash: xxh3hex('Linux') }])
    expect(byKind('upstream')).toEqual([{ name: 'dep#build', hash: 'up-1' }])
    // File rows: workspace-relative name, content OID as hash, one per file.
    const files = byKind('file')
    expect(files.map((r) => r.name).sort()).toEqual(['one.txt', 'two.txt'])
    // Total rows = sum of every component above.
    expect(sink.length).toBe(1 + 1 + 1 + 1 + 2 + 1 + 1 + 1 + 2)
  })

  it('captureInto never stores a plaintext secret value (only digests)', async () => {
    const secret = 'AKIA-super-secret-value'
    const sink: Array<{ kind: string; name: string; hash: string }> = []
    await cache.key({
      ...baseInput(),
      envValues: [['AWS_SECRET_ACCESS_KEY', secret]],
      runtimeValues: [['echo tok', secret]],
      workspaceRuntimeValues: [['echo wtok', secret]],
      forwardArgs: [secret],
      captureInto: sink,
    })
    // No captured row's stored value equals (or contains) the plaintext.
    for (const row of sink) {
      expect(row.hash).not.toContain(secret)
    }
    // But the digest still changes when the secret changes (lossless for the
    // diff's change-detection).
    const other: Array<{ kind: string; name: string; hash: string }> = []
    await cache.key({
      ...baseInput(),
      envValues: [['AWS_SECRET_ACCESS_KEY', 'different-value']],
      captureInto: other,
    })
    const a = sink.find((r) => r.kind === 'env')!.hash
    const b = other.find((r) => r.kind === 'env')!.hash
    expect(a).not.toBe(b)
  })

  it('captureInto omits the forward row when forwardArgs is empty', async () => {
    const sink: Array<{ kind: string; name: string; hash: string }> = []
    await cache.key({ ...baseInput(), forwardArgs: [], captureInto: sink })
    expect(sink.filter((r) => r.kind === 'forward')).toEqual([])
  })

  it('captureInto upstream row falls back to the hash when no upstreamIds map', async () => {
    const sink: Array<{ kind: string; name: string; hash: string }> = []
    await cache.key({ ...baseInput(), upstreamHashes: ['bare-hash'], captureInto: sink })
    expect(sink.filter((r) => r.kind === 'upstream')).toEqual([
      { kind: 'upstream', name: 'bare-hash', hash: 'bare-hash' },
    ])
  })
})

describe('Cache storage (v10)', () => {
  let workspaceRoot: string
  let cacheDir: string
  let projectDir: string
  let cache: Cache

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'vx-cache-v10-'))
    cacheDir = path.join(workspaceRoot, '.vx', 'cache')
    projectDir = path.join(workspaceRoot, 'project')
    cache = new Cache(cacheDir)
  })

  afterEach(async () => {
    cache.close()
    await rm(workspaceRoot, { recursive: true, force: true })
  })

  it('creates a SQLite db at <cacheDir>/cache.db', async () => {
    expect(existsSync(path.join(cacheDir, 'cache.db'))).toBe(true)
  })

  it('save() + get() round-trips an entry through SQLite + filesystem', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(projectDir, { recursive: true })
    const outFile = path.join(projectDir, 'dist', 'index.js')
    await mkdir(path.dirname(outFile), { recursive: true })
    await writeFile(outFile, 'console.log("hi")')

    await cache.save({
      hash: 'h1',
      projectDir,
      outputFiles: [outFile],
      entry: {
        taskId: 'pkg#build',
        command: 'tsc',
        durationMs: 42,
        stdout: 'compiling…\n',
      },
    })

    // Filesystem layout v17: single zstd-compressed tar archive per
    // entry. The artifact carries stdout + outputs/ — entry metadata
    // (command, exitCode, durationMs) lives in the SQLite entries row.
    expect(existsSync(path.join(cacheDir, 'h1.tar.zst'))).toBe(true)
    // No legacy <hash>/ directory layout.
    expect(existsSync(path.join(cacheDir, 'h1'))).toBe(false)
    expect(existsSync(path.join(cacheDir, 'h1', 'stdout'))).toBe(false)
    // No legacy v12-style sibling logs/ dir.
    expect(existsSync(path.join(cacheDir, 'logs'))).toBe(false)

    const got = await cache.get('h1')
    expect(got).not.toBeNull()
    expect(got?.command).toBe('tsc')
    expect(got?.exitCode).toBe(0)
    expect(got?.durationMs).toBe(42)
    expect(got?.stdout).toBe('compiling…\n')
    expect(got?.outputFiles).toEqual(['dist/index.js'])
  })

  it('restoreOutputs() copies the on-disk artifact back into the project dir', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(projectDir, { recursive: true })
    const outFile = path.join(projectDir, 'dist', 'out.txt')
    await mkdir(path.dirname(outFile), { recursive: true })
    await writeFile(outFile, 'produced')

    await cache.save({
      hash: 'h2',
      projectDir,
      outputFiles: [outFile],
      entry: {
        taskId: 'pkg#build',
        command: 'echo produced > dist/out.txt',
        durationMs: 1,
        stdout: '',
      },
    })

    // Wipe the project's output, then restore from cache.
    await rm(path.join(projectDir, 'dist'), { recursive: true, force: true })
    await cache.restoreOutputs('h2', projectDir)
    expect(await readFile(path.join(projectDir, 'dist', 'out.txt'), 'utf8')).toBe('produced')
  })

  // Root writes anywhere, so the case skips there — unless VX_REQUIRE_NONROOT says CI
  // expected to run it (helpers/nonroot-gate.ts).
  it.skipIf(
    skipAsRoot(
      'restoreOutputs() into a directory this user cannot write names the tree, not the artifact',
    ),
  )(
    'restoreOutputs() into a directory this user cannot write names the tree, not the artifact',
    async () => {
      const { chmod, mkdir, writeFile } = await import('node:fs/promises')
      const dist = path.join(projectDir, 'dist')
      await mkdir(dist, { recursive: true })
      const outFile = path.join(dist, 'out.txt')
      await writeFile(outFile, 'produced')
      await cache.save({
        hash: 'h-ro',
        projectDir,
        outputFiles: [outFile],
        entry: {
          taskId: 'pkg#build',
          command: 'echo produced > dist/out.txt',
          durationMs: 1,
          stdout: '',
        },
      })
      // The clean already emptied the tree; the directory itself stays and
      // is not this user's to write into.
      await rm(outFile)
      await chmod(dist, 0o500)
      try {
        const restore = cache.restoreOutputs('h-ro', projectDir)
        await expect(restore).rejects.toBeInstanceOf(UserError)
        await expect(cache.restoreOutputs('h-ro', projectDir)).rejects.toThrow(
          /^restore of h-ro into .* could not write its outputs \(EACCES: /,
        )
      } finally {
        await chmod(dist, 0o700)
      }
    },
  )

  // Item 670: a legal entry under a destination deep enough that the two
  // together pass PATH_MAX is the workspace's location, not a bad artifact.
  it('restoreOutputs() into a directory too deep for its output names says so, as a user error', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const PATH_MAX = process.platform === 'darwin' ? 1024 : 4096
    const name = 'n'.repeat(200)
    const outFile = path.join(projectDir, 'dist', name)
    await mkdir(path.dirname(outFile), { recursive: true })
    await writeFile(outFile, 'produced')
    await cache.save({
      hash: 'h-deep',
      projectDir,
      outputFiles: [outFile],
      entry: { taskId: 'pkg#build', command: 'x', durationMs: 1, stdout: '' },
    })
    // A destination short of PATH_MAX that the output's name then passes.
    let deep = projectDir
    while (deep.length < PATH_MAX - 150) deep = path.join(deep, 'd'.repeat(100))
    await mkdir(deep, { recursive: true })
    const err = await cache.restoreOutputs('h-deep', deep).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err).toBeInstanceOf(UserError)
    expect(err?.message).toMatch(
      /^restore of h-deep into .* could not write its outputs \(ENAMETOOLONG: .*\)\. An output path under this directory is longer than the file system allows — move the workspace to a shorter path\.$/,
    )
    // CONTROL: the same artifact restores into the shallow directory.
    await rm(outFile)
    await cache.restoreOutputs('h-deep', projectDir)
    expect(await Bun.file(outFile).text()).toBe('produced')
  })

  it('assertWritable() passes on a cache this user owns', () => {
    expect(() => cache.assertWritable()).not.toThrow()
  })

  // Root writes anywhere, so the case skips there — unless VX_REQUIRE_NONROOT says CI
  // expected to run it (helpers/nonroot-gate.ts).
  it.skipIf(skipAsRoot('assertWritable() names a cache directory this user cannot write into'))(
    'assertWritable() names a cache directory this user cannot write into',
    async () => {
      const { chmod, readdir } = await import('node:fs/promises')
      // The handle SQLite opens on an unwritable file is read-only from the
      // start, so the probe needs a cache opened AFTER the mode changed.
      for (const f of await readdir(cacheDir)) await chmod(path.join(cacheDir, f), 0o444)
      await chmod(cacheDir, 0o555)
      const later = new Cache(cacheDir)
      try {
        // A reader's stores are quiet no-ops on it: the eval cache and the
        // file-hash memo skip their upserts, nothing reaches SQLite.
        expect(() => later.putConfigEval('ro-key', '{}')).not.toThrow()
        expect(later.getConfigEval('ro-key')).toBeNull()
        const fresh = path.join(projectDir, 'fresh.txt')
        await mkdir(projectDir, { recursive: true })
        await writeFile(fresh, 'fresh')
        expect(await later.hashFile(fresh)).toMatch(/^[0-9a-f]{40}$/)
        expect(() => later.assertWritable()).toThrow(UserError)
        expect(() => later.assertWritable()).toThrow(
          /^cache directory .* is not writable \(EACCES: .*\) — every run records its history there; make it writable by this user, or pass --cache-dir <path>$/,
        )
      } finally {
        later.close()
        await chmod(cacheDir, 0o755)
        for (const f of await readdir(cacheDir)) await chmod(path.join(cacheDir, f), 0o644)
      }
    },
  )

  // Root creates anywhere, so the case skips there — unless VX_REQUIRE_NONROOT says CI
  // expected to run it (helpers/nonroot-gate.ts).
  it.skipIf(skipAsRoot('a cache directory that cannot be created is named with its remedies'))(
    'a cache directory that cannot be created is named with its remedies',
    async () => {
      const { chmod } = await import('node:fs/promises')
      const parent = path.join(projectDir, 'sealed')
      await mkdir(parent, { recursive: true })
      await chmod(parent, 0o555)
      try {
        expect(() => new Cache(path.join(parent, '.vx', 'cache'))).toThrow(UserError)
        expect(() => new Cache(path.join(parent, '.vx', 'cache'))).toThrow(
          /^cannot create cache directory .*sealed\/\.vx\/cache \(EACCES: .*\) — vx keeps its cache there; make the workspace writable, set `cacheDir` in vx\.workspace\.ts, or pass --cache-dir <path>$/,
        )
      } finally {
        await chmod(parent, 0o755)
      }
    },
  )

  // The open asks `access` of the directory before anything makes it, and a
  // FILE passes that; it is still refused as the directory it cannot be.
  it('a file where the cache directory goes is refused with its remedies', async () => {
    const file = path.join(projectDir, 'not-a-dir')
    await mkdir(projectDir, { recursive: true })
    await writeFile(file, 'x')
    let thrown: unknown
    try {
      new Cache(file).close()
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(UserError)
    expect((thrown as Error).message).toBe(
      `cannot create cache directory ${file} (EEXIST: file already exists, mkdir '${file}') — vx keeps its cache there; make the workspace writable, set \`cacheDir\` in vx.workspace.ts, or pass --cache-dir <path>`,
    )
  })

  it('a restore whose staged files another process removes is named an interruption, not a corrupt artifact', async () => {
    // Two runs on one workspace: the other one's clean of `dist/**` takes
    // the `.vx-tmp-*` files this restore staged, and its commit meets
    // ENOENT. A deleter loop plays the other run for the whole restore.
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { readdirSync, unlinkSync } = await import('node:fs')
    const dist = path.join(projectDir, 'dist')
    await mkdir(dist, { recursive: true })
    const files: string[] = []
    for (let i = 0; i < 1500; i++) {
      const f = path.join(dist, `out${i}.txt`)
      await writeFile(f, 'hi'.repeat(100))
      files.push(f)
    }
    await cache.save({
      hash: 'h-race',
      projectDir,
      outputFiles: files,
      entry: { taskId: 'pkg#build', command: 'build', durationMs: 1, stdout: '' },
    })
    let stop = false
    let removed = 0
    // The other run strikes SYNCHRONOUSLY on each turn of the loop — one
    // readdirSync and every unlinkSync in the same tick — so whatever the
    // restore has staged when it yields is gone before its commit renames
    // the next batch. A 1 ms timer with an awaited unlink per file got one
    // unlink per commit yield, aimed at a name in directory order, and 2
    // restores in 60 under a 12-way load renamed every file it aimed at
    // first (the gate, 2026-09-16).
    const deleter = (async () => {
      while (!stop) {
        let names: string[] = []
        try {
          names = readdirSync(dist)
        } catch {}
        for (const name of names) {
          if (!name.includes('.vx-tmp-')) continue
          try {
            unlinkSync(path.join(dist, name))
            removed++
          } catch {}
        }
        await new Promise<void>((r) => setImmediate(r))
      }
    })()
    let caught: unknown
    try {
      await cache.restoreOutputs('h-race', projectDir)
    } catch (err) {
      caught = err
    } finally {
      stop = true
      await deleter
    }
    expect(caught).toBeInstanceOf(UserError)
    expect((caught as Error).message).toMatch(
      /^restore of h-race into .* was interrupted: a file it had just written vanished \(ENOENT: .*\.vx-tmp-.*\)\. Another vx run is using this workspace — re-run once it is done\.$/,
    )
    // The loop did play the other run: it took staged files out from under both restores.
    expect(removed).toBeGreaterThan(0)
  }, 30_000)

  it('get() returns null when the entry has never been written', async () => {
    expect(await cache.get('never-written')).toBeNull()
  })

  it('get() returns null when DB row exists but on-disk artifact was deleted', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(projectDir, { recursive: true })
    const outFile = path.join(projectDir, 'a.txt')
    await writeFile(outFile, 'x')

    await cache.save({
      hash: 'h-orphan',
      projectDir,
      outputFiles: [outFile],
      entry: {
        taskId: 'pkg#build',
        command: 'noop',
        durationMs: 0,
        stdout: '',
      },
    })

    // Simulate someone deleting the cached artifact without touching the DB.
    await rm(path.join(cacheDir, 'h-orphan.tar.zst'), { force: true })
    expect(await cache.get('h-orphan')).toBeNull()
  })

  it("indexes the producing execution's usage from the artifact, on save and on ingest alike", async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(projectDir, { recursive: true })
    const outFile = path.join(projectDir, 'dist', 'out.txt')
    await mkdir(path.dirname(outFile), { recursive: true })
    await writeFile(outFile, 'produced')
    await cache.save({
      hash: 'h-usage',
      projectDir,
      outputFiles: [outFile],
      entry: {
        taskId: 'pkg#build',
        command: 'tsc',
        durationMs: 3000,
        stdout: '',
        cpuMs: 7500,
        peakRssBytes: 512 * 1024 * 1024,
      },
    })
    const saved = await cache.get('h-usage')
    expect(saved?.cpuMs).toBe(7500)
    expect(saved?.peakRssBytes).toBe(512 * 1024 * 1024)

    // A second machine ingests the same bytes with only the wire's
    // metadata (taskId, command, durationMs): the usage must come out of
    // the artifact itself, or a fresh runner learns nothing.
    const otherDir = path.join(workspaceRoot, 'other-cache')
    const other = new Cache(otherDir)
    try {
      const bytes = await Bun.file(path.join(cacheDir, 'h-usage.tar.zst')).bytes()
      await other.ingest('h-usage', new Blob([bytes]), {
        taskId: 'pkg#build',
        command: 'tsc',
        durationMs: 3000,
      })
      const ingested = await other.get('h-usage')
      expect(ingested?.cpuMs).toBe(7500)
      expect(ingested?.peakRssBytes).toBe(512 * 1024 * 1024)
    } finally {
      other.close()
    }

    // An execution that reported nothing leaves the columns NULL, and the
    // entry says undefined — never 0.
    await cache.save({
      hash: 'h-quiet',
      projectDir,
      outputFiles: [outFile],
      entry: { taskId: 'pkg#build', command: 'tsc', durationMs: 1, stdout: '' },
    })
    const quiet = await cache.get('h-quiet')
    expect(quiet?.cpuMs).toBeUndefined()
    expect(quiet?.peakRssBytes).toBeUndefined()
  })

  it('ingest() rejects corrupt zstd bytes — no artifact on disk, no SQL row', async () => {
    const garbage = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4, 5, 6, 7, 8])
    await expect(
      cache.ingest('h-corrupt', new Blob([garbage]), {
        taskId: 'pkg#build',
        command: 'tsc',
        durationMs: 1,
      }),
    ).rejects.toThrow(CorruptArtifactError)
    expect(existsSync(path.join(cacheDir, 'h-corrupt.tar.zst'))).toBe(false)
    expect(await cache.get('h-corrupt')).toBeNull()
  })

  // Renamed by item 486's rule and item 488's measurement. This row's
  // payload is `not a tar archive at all`, which fails in the TAR READER;
  // it never reaches the `stdout === null` check its old name claimed for
  // it — and that check had nothing, which is how the miss went unseen.
  // The real stdout row is directly below.
  it('ingest() rejects valid zstd whose bytes are not a tar at all', async () => {
    const notTar = await Bun.zstdCompress(new TextEncoder().encode('not a tar archive at all'))
    await expect(
      cache.ingest('h-not-tar', new Blob([new Uint8Array(notTar)]), {
        taskId: 'pkg#build',
        command: 'tsc',
        durationMs: 1,
      }),
    ).rejects.toThrow(CorruptArtifactError)
    expect(existsSync(path.join(cacheDir, 'h-not-tar.tar.zst'))).toBe(false)
    expect(await cache.get('h-not-tar')).toBeNull()
  })

  // Item 487. The ceiling has two LIVE halves and the four ingest rows
  // above assert only `CorruptArtifactError`, which both produce — so
  // removing either one left the repo green. The declared half is cheap to
  // reach (a forged header, 20 bytes, the row below); the STREAMING half
  // needs a frame that actually expands past the cap, and the cap is 2 GiB.
  // That is why it had nothing: not a gap in reasoning, a gap in what a
  // test can afford. `decodedTar` takes the cap as a parameter for exactly
  // this row and nothing else.
  //
  // A sizeless frame is the one a streamed producer emits — vx's own, above
  // 4 MiB — so this is the bomb shape the module's comment promises has
  // "nowhere to expand", asserted by its own message rather than by the
  // class the declared half shares with it.
  it('a SIZELESS frame is refused by the streaming count, naming that half', async () => {
    const body = new Uint8Array(64 * 1024)
    const sizeless = new Uint8Array(
      await new Response(
        new Blob([body]).stream().pipeThrough(new CompressionStream('zstd')),
      ).arrayBuffer(),
    )
    expect(zstdContentSize(sizeless)).toBeNull() // CONTROL: it really declares nothing

    const stream = await decodedTar(sizeless, 'h-stream-bomb', 4096)
    const reader = stream.getReader()
    const drain = (async () => {
      for (;;) {
        const { done } = await reader.read()
        if (done) break
      }
    })()
    await expect(drain).rejects.toThrow(/decompresses past 4096 bytes/)

    // CONTROL: under a cap it fits, the same frame decodes and yields the
    // bytes — so the row above is the ceiling firing, not a broken decode.
    const ok = await decodedTar(sizeless, 'h-stream-ok', 1024 * 1024)
    const okReader = ok.getReader()
    let n = 0
    for (;;) {
      const { done, value } = await okReader.read()
      if (done) break
      n += value.byteLength
    }
    expect(n).toBe(body.byteLength)
  })

  it('ingest() rejects a WELL-FORMED archive carrying no stdout entry, and leaves no file', async () => {
    // The v17 invariant: every artifact carries a `stdout` entry, and its
    // absence means the bytes decompressed and parsed but are not a vx
    // artifact. `ingest()` is the UNTRUSTED boundary — these bytes came
    // from a remote — so this is the shape an attacker actually sends: a
    // real tar.zst, correct in every way the reader checks, minus the one
    // entry that makes it ours.
    //
    // The refusal is held twice: with the guard deleted the SQL insert
    // still fails (`NOT NULL constraint failed: entries.stdout`). What the
    // guard carries ALONE is the class AND the timing, and the timing is
    // the part that bites — it runs BEFORE the rename, so without it the
    // temp is already renamed into place and the catch's `unlink(tmpPath)`
    // no longer names the file that exists. Measured:
    //
    //   with the guard:  CorruptArtifactError | missing stdout entry
    //                    artifact on disk: false
    //   without it:      Error | NOT NULL constraint failed
    //                    artifact on disk: TRUE   <- an orphan in the cache
    //
    // So the disk assertion below is not decoration; it is the half no
    // other row covers.
    const tar = await new Bun.Archive({ 'outputs/dist/app.js': 'BUILT' }).bytes()
    const bytes = new Uint8Array(await Bun.zstdCompress(tar))
    await expect(
      cache.ingest('h-no-stdout', new Blob([bytes]), {
        taskId: 'pkg#build',
        command: 'tsc',
        durationMs: 1,
      }),
    ).rejects.toThrow(CorruptArtifactError)
    await expect(
      cache.ingest('h-no-stdout', new Blob([bytes]), {
        taskId: 'pkg#build',
        command: 'tsc',
        durationMs: 1,
      }),
    ).rejects.toThrow(/missing stdout entry/)
    expect(existsSync(path.join(cacheDir, 'h-no-stdout.tar.zst'))).toBe(false)
    expect(await cache.get('h-no-stdout')).toBeNull()
  })

  it('a second flush does not re-bump what the first already wrote', async () => {
    // `accessed_at` bumps are deferred into `touched` and written by
    // flushAccessed (from stats/prune/close). Clearing the set is what
    // makes a flush idempotent: left in place, every later flush rewrites
    // the same rows with the CURRENT time, so an entry touched once looks
    // freshly used for as long as the process lives — and retention
    // pruning, which is exactly an `accessed_at` cutoff, never reclaims
    // it. Date.now is pinned so the two flushes carry different stamps
    // and the difference is unambiguous.
    await cache.save({
      hash: 'h-flush',
      projectDir,
      outputFiles: [],
      entry: { taskId: 'pkg#build', command: 'tsc', durationMs: 1, stdout: '' },
    })
    await cache.get('h-flush')
    const readAccessed = (): number =>
      (
        cache
          .dbHandle()
          .query('SELECT accessed_at AS a FROM entries WHERE hash = ?')
          .get('h-flush') as {
          a: number
        }
      ).a

    const clock = spyOn(Date, 'now')
    try {
      clock.mockReturnValue(1_700_000_000_000)
      cache.stats()
      const first = readAccessed()
      expect(first).toBe(1_700_000_000_000)

      // Nothing touched in between, so the second flush has nothing to do.
      clock.mockReturnValue(1_700_000_099_000)
      cache.stats()
      expect(readAccessed()).toBe(first)
    } finally {
      clock.mockRestore()
    }
  })

  // The flush has three sites, and the row above drives `stats()` alone.
  // A run reaches neither `stats()` nor `prune()`: its hits bump
  // `accessed_at` only through close, so with that flush gone no run
  // ever marks an entry used and a TTL prune evicts what is hit daily.
  // Each row below is red with its site's flush deleted (item 629).
  it("a hit's accessed_at bump survives close and is what the next process reads", async () => {
    await cache.save({
      hash: 'h-close',
      projectDir,
      outputFiles: [],
      entry: { taskId: 'pkg#build', command: 'tsc', durationMs: 1, stdout: '' },
    })
    cache.dbHandle().query('UPDATE entries SET accessed_at = 1 WHERE hash = ?').run('h-close')
    const before = Date.now()
    await cache.get('h-close')
    cache.close()
    cache = new Cache(cacheDir)
    const accessed = (
      cache
        .dbHandle()
        .query('SELECT accessed_at AS a FROM entries WHERE hash = ?')
        .get('h-close') as {
        a: number
      }
    ).a
    expect(accessed).toBeGreaterThanOrEqual(before)
  })

  it('a prune in the same process does not evict an entry hit since the last flush', async () => {
    await cache.save({
      hash: 'h-hit',
      projectDir,
      outputFiles: [],
      entry: { taskId: 'pkg#build', command: 'tsc', durationMs: 1, stdout: '' },
    })
    cache.dbHandle().query('UPDATE entries SET accessed_at = 1 WHERE hash = ?').run('h-hit')
    await cache.get('h-hit')
    // The cutoff is above the ancient stamp and below the hit's: the bump
    // pending in memory is the only thing that keeps the entry.
    const result = await cache.prune({ olderThanMs: Date.now() - 60_000 })
    expect(result.evicted).toBe(0)
    expect(await cache.get('h-hit')).not.toBeNull()
  })

  it('ingest() rejects a zstd frame declaring an oversize decompressed length (bomb)', async () => {
    // A minimal zstd frame header: magic + descriptor (8-byte FCS, not
    // single-segment) + window byte + an 8-byte Frame_Content_Size of 3 GiB.
    // The declared-size guard fires BEFORE decompression, so the (absent)
    // body never matters.
    const threeGiB = 3n * 1024n * 1024n * 1024n
    const fcs = new Uint8Array(8)
    for (let i = 0; i < 8; i++) fcs[i] = Number((threeGiB >> BigInt(8 * i)) & 0xffn)
    const frame = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0xc0, 0x00, ...fcs, 0, 0, 0, 0])
    await expect(
      cache.ingest('h-bomb', new Blob([frame]), {
        taskId: 'pkg#build',
        command: 'tsc',
        durationMs: 1,
      }),
    ).rejects.toThrow(CorruptArtifactError)
    expect(existsSync(path.join(cacheDir, 'h-bomb.tar.zst'))).toBe(false)
    expect(await cache.get('h-bomb')).toBeNull()
  })

  it('ingest() decodes a sizeless zstd frame as a stream: a valid one indexes, garbage is refused', async () => {
    // A streaming producer (CompressionStream — vx's own save above 4 MiB)
    // writes no Frame_Content_Size. Such a frame used to be refused at the
    // untrusted boundary as a bomb shape; now it is decoded under the
    // running count instead, so vx's own artifacts ingest anywhere and a
    // sizeless bomb still has nowhere to expand.
    const tar = await new Bun.Archive({ stdout: 'streamed', 'outputs/dist/a.js': 'a' }).bytes()
    const sizeless = new Uint8Array(
      await new Response(
        new Blob([tar]).stream().pipeThrough(new CompressionStream('zstd')),
      ).arrayBuffer(),
    )
    expect(zstdContentSize(sizeless)).toBeNull() // CONTROL: the frame really is sizeless
    await cache.ingest('h-sizeless', new Blob([sizeless]), {
      taskId: 'pkg#build',
      command: 'tsc',
      durationMs: 1,
    })
    expect((await cache.get('h-sizeless'))?.stdout).toBe('streamed')

    const garbage = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x01, 0x00, 0x00])
    await expect(
      cache.ingest('h-garbage', new Blob([garbage]), {
        taskId: 'pkg#build',
        command: 'tsc',
        durationMs: 1,
      }),
    ).rejects.toThrow(CorruptArtifactError)
    expect(existsSync(path.join(cacheDir, 'h-garbage.tar.zst'))).toBe(false)
  })

  it('ingest() reads a 4-byte Frame_Content_Size (fcsFlag 2) and rejects an oversize declaration', async () => {
    // Descriptor 0x80: fcsFlag=2 (4-byte FCS), single_segment=0 (so a
    // Window_Descriptor byte follows), dictIdFlag=0. Header offset =
    // magic(4) + desc(1) + window(1) = 6, then a 4-byte little-endian FCS.
    // 3 GiB (0xC0000000) exceeds the 2 GiB decompression cap, so the
    // declared-size guard fires before a byte is allocated — exercising
    // the fcsFlag===2 branch of zstdContentSize (only fcsFlag 3 and the
    // sizeless flag-0 path were covered before).
    const threeGiB = 3 * 1024 * 1024 * 1024
    const fcs = new Uint8Array(4)
    for (let i = 0; i < 4; i++) fcs[i] = (threeGiB >>> (8 * i)) & 0xff
    const frame = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x80, 0x00, ...fcs])
    await expect(
      cache.ingest('h-bomb4', new Blob([frame]), {
        taskId: 'pkg#build',
        command: 'tsc',
        durationMs: 1,
      }),
    ).rejects.toThrow(/declares .* decompressed bytes/)
    expect(existsSync(path.join(cacheDir, 'h-bomb4.tar.zst'))).toBe(false)
    expect(await cache.get('h-bomb4')).toBeNull()
  })

  it('recordRun() + stats() captures run history', async () => {
    const startedAt = Date.now() - 100
    const endedAt = Date.now()
    cache.recordRun({
      hash: 'h3',
      project: 'pkg',
      task: 'build',
      status: 'success',
      exitCode: 0,
      durationMs: 100,
      startedAt,
      endedAt,
    })
    cache.recordRun({
      hash: 'h3',
      project: 'pkg',
      task: 'build',
      status: 'cache-hit',
      exitCode: 0,
      durationMs: 0,
      startedAt: endedAt,
      endedAt: endedAt + 1,
    })

    const stats = cache.stats()
    expect(stats.runCountLast24h).toBe(2)
    expect(stats.hitCountLast24h).toBe(1)
  })

  it('stats() reports entry count and total bytes', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(projectDir, { recursive: true })
    const f = path.join(projectDir, 'tiny.txt')
    await writeFile(f, 'abc')

    await cache.save({
      hash: 'h-tiny',
      projectDir,
      outputFiles: [f],
      entry: {
        taskId: 'pkg#build',
        command: 'noop',
        durationMs: 0,
        stdout: '',
      },
    })

    const stats = cache.stats()
    expect(stats.entryCount).toBe(1)
    // 3 bytes of file + 0 + 0 for stdout/stderr.
    expect(stats.totalBytes).toBeGreaterThanOrEqual(3)
  })

  it('prune() with olderThanMs evicts entries last accessed before the cutoff', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(projectDir, { recursive: true })
    const f = path.join(projectDir, 'a.txt')
    await writeFile(f, 'aaa')

    await cache.save({
      hash: 'h-old',
      projectDir,
      outputFiles: [f],
      entry: {
        taskId: 'pkg#build',
        command: 'noop',
        durationMs: 0,
        stdout: '',
      },
    })

    // Wait a tick so olderThanMs = now strictly exceeds h-old's accessed_at.
    await new Promise((r) => setTimeout(r, 10))

    // The artifact is on disk BEFORE the prune — without this control the
    // unlink assertion below passes against a path that was never written.
    // Which is what the old one did: it named `<cacheDir>/h-old`, a
    // directory from the layout before artifacts became a single
    // `<hash>.tar.zst`, so deleting prune's whole artifact unlink left the
    // suite green and the evicted bytes stayed on disk until some LATER
    // prune's orphan sweep found them, a grace window later.
    expect(existsSync(cache.outputsPath('h-old'))).toBe(true)

    const result = await cache.prune({ olderThanMs: Date.now() })
    expect(result.evicted).toBe(1)
    expect(result.bytesFreed).toBeGreaterThanOrEqual(3)

    // DB row gone, and the artifact with it.
    expect(await cache.get('h-old')).toBeNull()
    expect(existsSync(cache.outputsPath('h-old'))).toBe(false)
  })

  it('prune() with maxBytes evicts LRU until under the cap', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(projectDir, { recursive: true })

    // Three entries, accessed in order h1 < h2 < h3.
    for (const [name, content] of [
      ['h1.txt', 'x'.repeat(100)],
      ['h2.txt', 'x'.repeat(100)],
      ['h3.txt', 'x'.repeat(100)],
    ] as const) {
      const f = path.join(projectDir, name)
      await writeFile(f, content)
      await cache.save({
        hash: name.replace('.txt', ''),
        projectDir,
        outputFiles: [f],
        entry: {
          taskId: 'pkg#build',
          command: 'noop',
          durationMs: 0,
          stdout: '',
        },
      })
      // Force a measurable accessed_at gap between writes.
      await new Promise((r) => setTimeout(r, 5))
    }

    // Cap = exactly what the two survivors occupy. Measured, and measured
    // per entry: a hardcoded byte count silently becomes "evict everything"
    // the next time the artifact layout gains a record, and `size(h3) * 2`
    // is a DIFFERENT number — each artifact carries its own duration and
    // timestamps, so the three compress to sizes that differ by a few bytes
    // and differ again run to run (198/193/193, then 199/193/190, over six
    // reps of this fixture). A cap below h2 + h3 makes evicting h2 correct,
    // which is the reading this row exists to exclude; under the full file
    // that drew `evicted: 2` from unmutated code (item 491).
    const { statSync } = await import('node:fs')
    const survivors =
      statSync(cache.outputsPath('h2')).size + statSync(cache.outputsPath('h3')).size
    const result = await cache.prune({ maxBytes: survivors })
    // Item 491. `>= 1` and the two endpoints cannot tell "evicted exactly
    // enough" from "evicted one too many": h2 was unasserted, so an
    // off-by-one in the budget break (`remaining < maxBytes` instead of
    // `<=`) survived the whole suite. Measured, same fixture:
    //
    //   correct:     evicted=1, survivors=[h2, h3]
    //   off-by-one:  evicted=2, survivors=[h3]
    //
    // Both leave h1 gone and h3 alive, which is all this row used to ask.
    // A prune that over-evicts is not a stale hit — a pruned entry is a
    // miss — but it silently throws away cache the user asked to keep,
    // every run, and hit rate is what the cache is for. So the count is
    // exact and the MIDDLE entry is named.
    expect(result.evicted).toBe(1)
    // h3 (most recently accessed) survives.
    expect(await cache.get('h3')).not.toBeNull()
    // h2 fits under the cap once h1 is gone, so it must NOT be evicted.
    expect(await cache.get('h2')).not.toBeNull()
    // h1 (oldest accessed) is gone.
    expect(await cache.get('h1')).toBeNull()
  })

  it('prune() cutoff is exclusive: an entry accessed exactly at it survives', async () => {
    // Rows straight into the index so accessed_at is EXACT. Every other
    // prune fixture here lets `save()` stamp it and passes `Date.now()`,
    // which puts the cutoff strictly above every row — so `accessed_at <`
    // and `accessed_at <=` pick the same victims and the boundary has no
    // witness. `olderThanMs` is documented as a cutoff, not a floor:
    // "older THAN" excludes equality, and the entry touched at the very
    // instant of the cutoff is the one a user racing a prune expects to
    // keep.
    // @ts-expect-error: private member access for testing
    const db = cache.db as import('bun:sqlite').Database
    const insert = db.prepare(
      `INSERT INTO entries(hash, project, task, command, exit_code, duration_ms, size_bytes, stdout, created_at, accessed_at)
       VALUES (?, 'pkg', 'build', 'noop', 0, 0, 10, '', 1, ?)`,
    )
    insert.run('h-below', 999)
    insert.run('h-at', 1000)

    const remaining = (): string[] =>
      (db.prepare('SELECT hash FROM entries ORDER BY hash').all() as Array<{ hash: string }>).map(
        (r) => r.hash,
      )

    const result = await cache.prune({ olderThanMs: 1000 })
    expect(result.evicted).toBe(1)
    // The index is the oracle, not `get()`: these rows have no artifact on
    // disk, so `get()` reads null for a survivor too.
    expect(remaining()).toEqual(['h-at'])
  })

  it('prune() counts TTL-freed bytes against maxBytes before evicting any LRU', async () => {
    // The two policies compose through one `remaining`: what the TTL
    // sweep already freed is subtracted before the byte budget decides
    // whether anything else has to go. Drop that subtraction and the
    // budget sees the PRE-prune total, so it evicts entries the user's
    // own cap says fit — here both survivors, silently, on every
    // `vx cache prune --older-than ... --max-bytes ...`.
    //
    //   correct:  remaining = 200 - 100 = 100, not > 100 → evicted 1
    //   mutated:  remaining = 200            > 100 → evicted 3
    //
    // Sizes and timestamps go in directly: the artifacts compress to
    // sizes that differ run to run (see the maxBytes row above), and the
    // arithmetic this pins is exact.
    // @ts-expect-error: private member access for testing
    const db = cache.db as import('bun:sqlite').Database
    const insert = db.prepare(
      `INSERT INTO entries(hash, project, task, command, exit_code, duration_ms, size_bytes, stdout, created_at, accessed_at)
       VALUES (?, 'pkg', 'build', 'noop', 0, 0, ?, '', 1, ?)`,
    )
    insert.run('h-stale', 100, 1)
    insert.run('h-warm-a', 50, 10)
    insert.run('h-warm-b', 50, 20)

    const result = await cache.prune({ olderThanMs: 5, maxBytes: 100 })
    expect(result.evicted).toBe(1)
    expect(result.bytesFreed).toBe(100)
    expect(
      (db.prepare('SELECT hash FROM entries ORDER BY hash').all() as Array<{ hash: string }>).map(
        (r) => r.hash,
      ),
    ).toEqual(['h-warm-a', 'h-warm-b'])
  })

  it('prune() picks LRU victims by accessed_at, not by the order rows were written', async () => {
    // `ORDER BY accessed_at ASC` had no witness: the maxBytes row above
    // saves h1, h2, h3 in that order AND touches them in that order, so
    // SQLite's own rowid scan returns exactly the LRU order and dropping
    // the ORDER BY changes nothing (`DESC` is caught; no clause at all is
    // not). The 559 shape — the storage layer answering for the sort. So
    // the rows go in LAST-used-first, which is the one order a rowid scan
    // gets wrong.
    // @ts-expect-error: private member access for testing
    const db = cache.db as import('bun:sqlite').Database
    const insert = db.prepare(
      `INSERT INTO entries(hash, project, task, command, exit_code, duration_ms, size_bytes, stdout, created_at, accessed_at)
       VALUES (?, 'pkg', 'build', 'noop', 0, 0, 100, '', 1, ?)`,
    )
    insert.run('h-newest', 30)
    insert.run('h-oldest', 10)
    insert.run('h-middle', 20)

    // 300 bytes held, cap 200 → exactly one entry goes, and it is the
    // least recently accessed one, which is the SECOND row written.
    const result = await cache.prune({ maxBytes: 200 })
    expect(result.evicted).toBe(1)
    expect(result.bytesFreed).toBe(100)
    expect(
      (db.prepare('SELECT hash FROM entries ORDER BY hash').all() as Array<{ hash: string }>).map(
        (r) => r.hash,
      ),
    ).toEqual(['h-middle', 'h-newest'])
  })

  it('prune() does not re-count a TTL victim as an LRU candidate', async () => {
    // The LRU scan reads every entry, including the ones the TTL sweep
    // already picked, and filters them in JS (a SQL NOT-IN would blow the
    // bound-parameter ceiling). Drop that filter and the budget "frees"
    // the stale entry a second time: `bytesFreed` inflates and `remaining`
    // falls by bytes nothing is holding, so a live entry the cap has no
    // room for survives.
    //
    //   correct:  evict h-stale (TTL) + h-warm-a (LRU) → evicted 2, freed 200
    //   mutated:  h-stale counted twice → evicted 1, freed 300, 200 bytes
    //             still on disk under a 100-byte cap
    // @ts-expect-error: private member access for testing
    const db = cache.db as import('bun:sqlite').Database
    const insert = db.prepare(
      `INSERT INTO entries(hash, project, task, command, exit_code, duration_ms, size_bytes, stdout, created_at, accessed_at)
       VALUES (?, 'pkg', 'build', 'noop', 0, 0, 100, '', 1, ?)`,
    )
    insert.run('h-stale', 1)
    insert.run('h-warm-a', 10)
    insert.run('h-warm-b', 20)

    const result = await cache.prune({ olderThanMs: 5, maxBytes: 100 })
    expect(result.evicted).toBe(2)
    expect(result.bytesFreed).toBe(200)
    expect(
      (db.prepare('SELECT hash FROM entries ORDER BY hash').all() as Array<{ hash: string }>).map(
        (r) => r.hash,
      ),
    ).toEqual(['h-warm-b'])
  })

  it('prune({ dryRun }) reports the victims and orphans and deletes nothing', async () => {
    const { mkdir, writeFile, utimes } = await import('node:fs/promises')
    await mkdir(projectDir, { recursive: true })
    const f = path.join(projectDir, 'a.txt')
    await writeFile(f, 'aaa')
    await cache.save({
      hash: 'h-dry',
      projectDir,
      outputFiles: [f],
      entry: { taskId: 'pkg#build', command: 'noop', durationMs: 0, stdout: '' },
    })
    const aged = path.join(cacheDir, 'deadbeefdeadbeef.tar.zst')
    await writeFile(aged, 'x'.repeat(64))
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000
    await utimes(aged, twoHoursAgo, twoHoursAgo)
    await new Promise((r) => setTimeout(r, 10))

    const dry = await cache.prune({ olderThanMs: Date.now(), dryRun: true })
    expect(dry.evicted).toBe(1)
    expect(dry.bytesFreed).toBeGreaterThanOrEqual(3)
    expect(dry.orphans).toBe(1)
    expect(dry.orphanBytes).toBe(64)
    // Nothing moved: the row and artifact are still there (has() does not
    // refresh the access time, so the same cutoff still applies below).
    expect(await cache.has('h-dry')).toBe('local')
    expect(existsSync(aged)).toBe(true)

    // The real prune with the same policy reaps exactly what the dry run named.
    const wet = await cache.prune({ olderThanMs: Date.now() })
    expect({ evicted: wet.evicted, orphans: wet.orphans, orphanBytes: wet.orphanBytes }).toEqual({
      evicted: 1,
      orphans: 1,
      orphanBytes: 64,
    })
    expect(await cache.get('h-dry')).toBeNull()
    expect(existsSync(aged)).toBe(false)
  })

  it('prune() rejects empty options', async () => {
    await expect(cache.prune({})).rejects.toThrow(/at least one of/)
  })

  it('the orphan sweep will not unlink anything but a regular <hash>.tar.zst or its temp', async () => {
    // The sweep DELETES, so what it declines to look at is the whole
    // safety of it — and the row above proves none of that: every control
    // there is FRESH, so the grace window alone keeps them, and each of
    // the three narrowing guards could be deleted with the suite green.
    // Measured, each on its own:
    //
    //   drop `endsWith('.tar.zst')`  → `cache.db` becomes an orphan and the
    //                                  INDEX is unlinked
    //   drop `st.isFile()`           → a directory is counted and its bytes
    //                                  reported, then the unlink fails
    //   `indexOf(...) >= 0`          → a name that is nothing BUT the temp
    //                                  suffix, belonging to no hash, is reaped
    //
    // So every control here is AGED past the window: the only thing left
    // holding them is the guard each one names.
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000
    const age = async (p: string) => utimes(p, twoHoursAgo, twoHoursAgo)
    const agedFile = async (name: string, bytes: string) => {
      const file = path.join(cacheDir, name)
      await writeFile(file, bytes)
      await age(file)
      return file
    }

    const orphan = await agedFile('h-real-orphan.tar.zst', 'x'.repeat(11))
    // Not an artifact name at all.
    const foreign = await agedFile('notes.txt', 'n')
    // The temp suffix with no hash in front of it.
    const hashless = await agedFile('.tar.zst.tmp-1-2-3', 't')
    // A directory wearing the artifact name.
    const dir = path.join(cacheDir, 'h-dir.tar.zst')
    await mkdir(dir, { recursive: true })
    await age(dir)
    // The index itself, aged: prune's own writes go to the -wal, so
    // `cache.db`'s mtime stays where this put it.
    await age(path.join(cacheDir, 'cache.db'))

    expect(await cache.orphanStats()).toEqual({ orphans: 1, orphanBytes: 11 })
    const result = await cache.prune({ olderThanMs: 1 })
    expect({ orphans: result.orphans, orphanBytes: result.orphanBytes }).toEqual({
      orphans: 1,
      orphanBytes: 11,
    })
    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(foreign)).toBe(true)
    expect(existsSync(hashless)).toBe(true)
    expect(existsSync(dir)).toBe(true)
    expect(existsSync(path.join(cacheDir, 'cache.db'))).toBe(true)
  })

  it('the orphan scan swallows a readdir failure instead of rejecting', async () => {
    // `vx info` calls this, and a prune ends with it, so a directory that
    // cannot be read must report nothing rather than throw. Nothing
    // exercised the swallow — readdir does not fail in a fixture — so
    // replacing its `return []` with a rethrow left the suite green.
    //
    // The scan reads the directory BEFORE it queries the index, which is
    // what makes this row platform-independent: a readdir that fails
    // never reaches SQLite. The first version asked the bigger question —
    // that a prune still EVICTS with the directory gone — and that is a
    // LINUX-ONLY claim. `close()` already documents the other half of it:
    // on macOS a write through an unlinked file answers
    // SQLITE_IOERR_VNODE where Linux writes on. The READ does too, and
    // darwin CI said so.
    await rm(cacheDir, { recursive: true, force: true })

    expect(await cache.orphanStats()).toEqual({ orphans: 0, orphanBytes: 0 })
  })

  it('prune() handles more than 900 victims (chunked DELETE, no bound-parameter blowup)', async () => {
    // Insert 1000 stale rows straight into the index — artifacts absent
    // on disk is fine (prune rm's with force:true). Exercises the
    // multi-chunk DELETE path plus the JS-side victims filter.
    // @ts-expect-error: private member access for testing
    const db = cache.db as import('bun:sqlite').Database
    const insert = db.prepare(
      `INSERT INTO entries(hash, project, task, command, exit_code, duration_ms, size_bytes, stdout, created_at, accessed_at)
       VALUES (?, 'pkg', 'build', 'noop', 0, 0, 10, '', 1, 1)`,
    )
    db.transaction(() => {
      for (let i = 0; i < 1000; i++) insert.run(`h-bulk-${i}`)
    })()

    const result = await cache.prune({ olderThanMs: 2 })
    expect(result.evicted).toBe(1000)
    expect(await cache.get('h-bulk-0')).toBeNull()
    expect(await cache.get('h-bulk-999')).toBeNull()
  })

  it('prune() reaps an aged artifact or temp the index does not know, and nothing younger', async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(projectDir, { recursive: true })
    const f = path.join(projectDir, 'keep.txt')
    await writeFile(f, 'keep')
    await cache.save({
      hash: 'h-indexed',
      projectDir,
      outputFiles: [f],
      entry: { taskId: 'pkg#build', command: 'noop', durationMs: 0, stdout: '' },
    })
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000
    const aged = async (name: string, bytes: string) => {
      const file = path.join(cacheDir, name)
      await writeFile(file, bytes)
      await utimes(file, twoHoursAgo, twoHoursAgo)
      return file
    }
    // Orphans: an artifact with no row and a temp a crashed save left.
    const orphanTar = await aged('h-orphan.tar.zst', 'x'.repeat(10))
    const orphanTmp = await aged('h-inflight.tar.zst.tmp-123-456-abc', 'y'.repeat(5))
    // Controls: the indexed artifact (aged too — age alone is not the
    // rule), a fresh row-less artifact (a save between rename and
    // commit), a fresh temp (a save mid-write), and the index itself.
    await utimes(cache.outputsPath('h-indexed'), twoHoursAgo, twoHoursAgo)
    const freshTar = path.join(cacheDir, 'h-fresh.tar.zst')
    await writeFile(freshTar, 'z')
    const freshTmp = path.join(cacheDir, 'h-fresh.tar.zst.tmp-1-2-3')
    await writeFile(freshTmp, 'z')

    // What `vx info` reports before anyone prunes is exactly what prune reaps.
    expect(await cache.orphanStats()).toEqual({ orphans: 2, orphanBytes: 15 })
    const result = await cache.prune({ olderThanMs: 1 })
    expect(result.evicted).toBe(0)
    expect({ orphans: result.orphans, orphanBytes: result.orphanBytes }).toEqual({
      orphans: 2,
      orphanBytes: 15,
    })
    expect(await cache.orphanStats()).toEqual({ orphans: 0, orphanBytes: 0 })
    expect(existsSync(orphanTar)).toBe(false)
    expect(existsSync(orphanTmp)).toBe(false)
    expect(existsSync(cache.outputsPath('h-indexed'))).toBe(true)
    expect(await cache.get('h-indexed')).not.toBeNull()
    expect(existsSync(freshTar)).toBe(true)
    expect(existsSync(freshTmp)).toBe(true)
    expect(existsSync(path.join(cacheDir, 'cache.db'))).toBe(true)

    // Two prunes over one directory (two vx processes, one cache) both scan
    // the same orphan; only the unlink that lands counts it. `rm({ force })`
    // swallowed the loser's ENOENT and both reported the bytes. Nothing may
    // be EVICTABLE here: an eviction deletes the row before the file, and a
    // scan between the two sees the file as an orphan — darwin CI landed
    // there once with `olderThanMs: 1` and the aged indexed entry.
    //
    // Linux only: on darwin, Bun 1.4.0 returned success from BOTH concurrent
    // unlinks of the one path (measured on CI 2026-09-10: counts [1, 1],
    // 14 bytes, the directory otherwise exactly right), where POSIX and
    // Linux give the loser ENOENT. The code is right for the rule; the
    // runtime there is not, and the Linux job is the gate for this claim.
    const again = await aged('h-orphan-2.tar.zst', 'w'.repeat(7))
    const other = new Cache(cacheDir, { read: true, write: true })
    if (process.platform !== 'linux') {
      other.close()
      return
    }
    try {
      const aYear = 365 * 24 * 60 * 60 * 1000
      const [r1, r2] = await Promise.all([
        cache.prune({ olderThanMs: aYear }),
        other.prune({ olderThanMs: aYear }),
      ])
      // One assertion over both results and what the directory still holds:
      // a failure names WHICH prune counted WHAT, on the platform it failed.
      const artifacts = (await readdir(cacheDir)).filter((n) => n.includes('.tar.zst')).sort()
      expect({
        evicted: r1.evicted + r2.evicted,
        orphans: [r1.orphans, r2.orphans].sort((x, y) => x - y),
        orphanBytes: r1.orphanBytes + r2.orphanBytes,
        artifacts,
      }).toEqual({
        evicted: 0,
        orphans: [0, 1],
        orphanBytes: 7,
        artifacts: [
          'h-fresh.tar.zst',
          'h-fresh.tar.zst.tmp-1-2-3',
          path.basename(cache.outputsPath('h-indexed')),
        ].sort(),
      })
      expect(existsSync(again)).toBe(false)
    } finally {
      other.close()
    }
  })

  it('stats() counts remote cache hits in hitCountLast24h', () => {
    const now = Date.now()
    cache.recordRun({
      hash: 'h-remote-hit',
      project: 'pkg',
      task: 'build',
      status: 'cache-hit-remote',
      exitCode: 0,
      durationMs: 0,
      startedAt: now,
      endedAt: now,
    })
    const stats = cache.stats()
    expect(stats.hitCountLast24h).toBe(1)
  })

  it('recordRun() persists the v11 analytics columns when provided', async () => {
    const started = Date.now() - 50
    const ended = Date.now()
    cache.recordRun({
      hash: 'h-v11',
      project: 'pkg',
      task: 'build',
      status: 'success',
      exitCode: 0,
      durationMs: 50,
      startedAt: started,
      endedAt: ended,
      runId: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
      cpuMs: 42,
      peakRssBytes: 1024 * 1024 * 32,
      wallclockStartNs: 0n,
      wallclockEndNs: 50_000_000n,
      cacheHit: false,
    })
    // Read back via the underlying DB to confirm the columns were stored.
    // Reaches past the public API on purpose — this is a schema test.
    // @ts-expect-error: private member access for testing
    const row = cache.db.prepare('SELECT * FROM runs WHERE hash = ?').get('h-v11') as {
      run_id: string
      cpu_ms: number
      peak_rss_bytes: number
      cache_hit: number
    }
    expect(row.run_id).toBe('01JZZZZZZZZZZZZZZZZZZZZZZZ')
    expect(row.cpu_ms).toBe(42)
    expect(row.peak_rss_bytes).toBe(1024 * 1024 * 32)
    expect(row.cache_hit).toBe(0)
  })

  it('recordRun() omitting v11 columns stores NULL', async () => {
    cache.recordRun({
      hash: 'h-v11-null',
      project: 'pkg',
      task: 'build',
      status: 'cache-hit',
      exitCode: 0,
      durationMs: 0,
      startedAt: Date.now(),
      endedAt: Date.now() + 1,
    })
    // @ts-expect-error: private member access for testing
    const row = cache.db.prepare('SELECT * FROM runs WHERE hash = ?').get('h-v11-null') as {
      run_id: unknown
      cpu_ms: unknown
      cache_hit: unknown
    }
    expect(row.run_id).toBeNull()
    expect(row.cpu_ms).toBeNull()
    expect(row.cache_hit).toBeNull()
  })

  it('two concurrent writers do not crash with SQLITE_BUSY', async () => {
    // B1 from Agent A's real-world test: without PRAGMA busy_timeout,
    // two parallel `vx run` invocations would race on the small INSERT
    // and one would die with `SQLiteError: database is locked`. With the
    // 5s busy_timeout the second one waits and succeeds.
    const second = new Cache(cacheDir)
    try {
      const now = Date.now()
      const writeMany = async (label: string, c: Cache): Promise<void> => {
        for (let i = 0; i < 20; i++) {
          c.recordRun({
            hash: `${label}-${i}`,
            project: 'pkg',
            task: 'build',
            status: 'success',
            exitCode: 0,
            durationMs: 1,
            startedAt: now,
            endedAt: now + 1,
          })
        }
      }
      await Promise.all([writeMany('a', cache), writeMany('b', second)])
      // Both wrote successfully.
      expect(cache.stats().runCountLast24h).toBe(40)
    } finally {
      second.close()
    }
  })

  it('two concurrent save()s on the same hash leave a valid artifact', async () => {
    // Stress the atomic-rename / overwrite path: two writers racing
    // on the same hash with identical content. After both complete,
    // the on-disk artifact must be parseable and restoreOutputs must
    // produce the expected file. Catches the bug where the second
    // writer truncates the first's in-flight tar mid-write.
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(projectDir, { recursive: true })
    const outFile = path.join(projectDir, 'dist', 'out.txt')
    await mkdir(path.dirname(outFile), { recursive: true })
    await writeFile(outFile, 'concurrent-payload')
    const second = new Cache(cacheDir)
    try {
      const saveOnce = (c: Cache): Promise<void> =>
        c.save({
          hash: 'h-concurrent',
          projectDir,
          outputFiles: [outFile],
          entry: {
            taskId: 'pkg#build',
            command: 'same',
            durationMs: 1,
            stdout: '',
          },
        })
      await Promise.all([saveOnce(cache), saveOnce(second)])
      // Either writer's result is fine — content is identical.
      const hit = await cache.get('h-concurrent')
      expect(hit).not.toBeNull()
      // Restore must produce the expected file (not a truncated /
      // corrupt one from a partial concurrent write).
      const restoreDir = await mkdtemp(path.join(os.tmpdir(), 'vx-cc-restore-'))
      try {
        await cache.restoreOutputs('h-concurrent', restoreDir)
        const restored = await readFile(path.join(restoreDir, 'dist/out.txt'), 'utf8')
        expect(restored).toBe('concurrent-payload')
      } finally {
        await rm(restoreDir, { recursive: true, force: true })
      }
    } finally {
      second.close()
    }
  })

  it('save() overwrites a prior entry at the same hash (idempotent re-save)', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(projectDir, { recursive: true })
    const outFile = path.join(projectDir, 'dist', 'out.txt')
    await mkdir(path.dirname(outFile), { recursive: true })

    await writeFile(outFile, 'first')
    await cache.save({
      hash: 'h-overwrite',
      projectDir,
      outputFiles: [outFile],
      entry: {
        taskId: 'pkg#build',
        command: 'first',
        durationMs: 1,
        stdout: '',
      },
    })

    // Second save at the same hash with different content. Must
    // succeed (idempotent) and the read must reflect the latest write.
    await writeFile(outFile, 'second-version-longer')
    await cache.save({
      hash: 'h-overwrite',
      projectDir,
      outputFiles: [outFile],
      entry: {
        taskId: 'pkg#build',
        command: 'second',
        durationMs: 2,
        stdout: 'replaced',
      },
    })

    const got = await cache.get('h-overwrite')
    expect(got?.command).toBe('second')
    expect(got?.durationMs).toBe(2)
    expect(got?.stdout).toBe('replaced')
    // Stored payload reflects the second-write content. Restore into a
    // sibling dir and read the materialized file.
    const restoreDir = path.join(workspaceRoot, 'restore-target')
    await cache.restoreOutputs('h-overwrite', restoreDir)
    const stored = await readFile(path.join(restoreDir, 'dist', 'out.txt'), 'utf8')
    expect(stored).toBe('second-version-longer')
  })

  it('recordRun() persists cache-hit-remote with cache_hit=1', async () => {
    cache.recordRun({
      hash: 'h-remote',
      project: 'pkg',
      task: 'build',
      status: 'cache-hit-remote',
      exitCode: 0,
      durationMs: 5,
      startedAt: Date.now(),
      endedAt: Date.now() + 5,
      runId: '01ABCDEFG',
      cacheHit: true,
    })
    // @ts-expect-error: private member access for testing
    const row = cache.db.prepare('SELECT * FROM runs WHERE hash = ?').get('h-remote') as {
      status: string
      cache_hit: number
      run_id: string
    }
    expect(row.status).toBe('cache-hit-remote')
    expect(row.cache_hit).toBe(1)
    expect(row.run_id).toBe('01ABCDEFG')
  })

  it('prune() handles a DB row whose on-disk dir was deleted out of band', async () => {
    // Race: someone `rm -rf .vx/cache/<hash>/` while the DB row still
    // points at it. prune() should not crash; the row is removed and
    // the missing dir is a no-op rm.
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(projectDir, { recursive: true })
    const f = path.join(projectDir, 'a.txt')
    await writeFile(f, 'x')

    await cache.save({
      hash: 'h-orphan-row',
      projectDir,
      outputFiles: [f],
      entry: {
        taskId: 'pkg#build',
        command: 'noop',
        durationMs: 0,
        stdout: '',
      },
    })
    await rm(path.join(cacheDir, 'h-orphan-row'), { recursive: true, force: true })

    const result = await cache.prune({ olderThanMs: Date.now() + 1000 })
    expect(result.evicted).toBe(1)
    // DB row should be gone.
    expect(await cache.get('h-orphan-row')).toBeNull()
  })

  // ─── §6 functionality: temp file lifecycle ──────────────────────

  it('save() that throws mid-pack leaves no `.tar.zst.tmp-*` debris', async () => {
    // Trigger a save failure by passing an outputFile that doesn't
    // exist — Bun.write inside the staging step will reject. The
    // tmp tar file (if any was created) must be cleaned up. After
    // the failed save, the cache dir should contain neither a final
    // `.tar.zst` nor any `.tar.zst.tmp-*` siblings for this hash.
    const { mkdir, readdir } = await import('node:fs/promises')
    await mkdir(projectDir, { recursive: true })
    await expect(
      cache.save({
        hash: 'h-bad-save',
        projectDir,
        outputFiles: [path.join(projectDir, 'does-not-exist.txt')],
        entry: {
          taskId: 'pkg#build',
          command: 'oops',
          durationMs: 1,
          stdout: '',
        },
      }),
    ).rejects.toThrow()
    const entries = await readdir(path.join(cacheDir))
    const debris = entries.filter((e) => e.startsWith('h-bad-save'))
    expect(debris).toEqual([])
  })

  it('save() rename is atomic from a concurrent reader (no half-written .tar.zst)', async () => {
    // A reader that polls `cache.get(hash)` while a save is in
    // flight must observe one of two states: NULL (no entry yet) or
    // a complete, parseable entry. Never a half-written tar that
    // breaks decompression. We exercise this by running a save in
    // parallel with rapid get() probes — and decoding each
    // non-null result.
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(projectDir, { recursive: true })
    const outFile = path.join(projectDir, 'dist', 'out.txt')
    await mkdir(path.dirname(outFile), { recursive: true })
    await writeFile(outFile, 'payload-for-atomicity-test')
    const second = new Cache(cacheDir)
    try {
      const savePromise = cache.save({
        hash: 'h-atomic',
        projectDir,
        outputFiles: [outFile],
        entry: {
          taskId: 'pkg#build',
          command: 'atomic',
          durationMs: 1,
          stdout: '',
        },
      })
      // Hammer get() while the save runs. Each non-null result must
      // be a fully-formed entry (no decompression error).
      const polls: Array<Promise<unknown>> = []
      for (let i = 0; i < 20; i++) polls.push(second.get('h-atomic'))
      await Promise.all([savePromise, ...polls])
      const final = await second.get('h-atomic')
      expect(final).not.toBeNull()
    } finally {
      second.close()
    }
  })

  // "vx caches only successes" is the invariant that makes a cache hit safe to
  // replay. It used to be enforced by every call site remembering to gate on
  // `effectiveExitCode === 0`, while the contract advertised `entry.exitCode:
  // number` and `writeArtifactAndIndex` hard-coded 0 over whatever arrived.
  //
  // That combination is the one shape that LAUNDERS a failure: cache a failing
  // task's outputs, read the entry back as exit 0, and execute-task's
  // classifier calls it `cache-hit` — a green run that restores a broken
  // build's files over a good tree. Reproduced before the fix: `exitCode: 42`
  // in, `0` out, verdict `cache-hit`, `dist/app.js` from the failed build
  // listed as restorable.
  describe('a failure cannot enter the cache', () => {
    it('is unrepresentable in the save contract, not merely gated by callers', async () => {
      const cache = new Cache(cacheDir)
      try {
        await cache.save({
          hash: 'exitcode-refused',
          projectDir,
          outputFiles: [],
          // The directive below IS the assertion: `oxlint --type-aware
          // --type-check` reports an UNUSED @ts-expect-error (TS2578), so
          // re-widening the type fails the gate here rather than silently
          // reopening the laundering path. `bun test` is transpile-only and
          // cannot see this — the lint gate can, which is why it lives here.
          // @ts-expect-error `exitCode` is omitted from the save args on purpose.
          entry: { taskId: 'pkg#build', command: 'x', exitCode: 42, durationMs: 1, stdout: '' },
        })
        // It still SAVED — the excess property is a type error, not a runtime
        // one — so the row is real and pins what actually landed.
        expect((await cache.get('exitcode-refused'))?.exitCode).toBe(0)
      } finally {
        cache.close()
      }
    })

    it('the remote-hit path cannot express one either', async () => {
      // `IngestMeta` never carried an exitCode, so `save` and `ingest` now
      // agree. Without this the invariant would hold on one path and not the
      // other, which is how the asymmetry went unnoticed for as long as it did.
      const donor = new Cache(cacheDir)
      let bytes: Uint8Array
      try {
        bytes = await donor.packArtifactBytes({
          hash: 'ingest-symmetry',
          projectDir,
          outputFiles: [],
          entry: { taskId: 'pkg#build', command: 'x', durationMs: 7, stdout: 'hi' },
        })
      } finally {
        donor.close()
      }
      const cache = new Cache(path.join(workspaceRoot, 'cache-ingest'))
      try {
        await cache.ingest('ingest-symmetry', new Blob([bytes]), {
          taskId: 'pkg#build',
          command: 'x',
          durationMs: 7,
          // @ts-expect-error `IngestMeta` has no `exitCode` — same guarantee,
          // reached from the other direction.
          exitCode: 42,
        })
        expect((await cache.get('ingest-symmetry'))?.exitCode).toBe(0)
      } finally {
        cache.close()
      }
    })
  })
})

// Schema-version + cache-version recovery paths. These exercise the
// "previous run wrote with an old version; rebuild cleanly" scenario.
// We don't currently expose a public knob to change CACHE_VERSION /
// SCHEMA_VERSION mid-test, so we simulate by writing a bad sentinel
// directly to schema_meta via a second handle.
describe('Cache.close() is best-effort', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-close-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('survives the cache dir being removed under a live handle', async () => {
    // The retention prune in close() was already guarded with "best-effort;
    // never block closing the handle" while its sibling flushAccessed() was
    // not — so a throw there skipped `db.close()` too, leaking the handle AND
    // failing a run whose work was already recorded. `accessed_at` is LRU
    // bookkeeping, never correctness.
    //
    // Honest limit: only macOS makes this reachable today (SQLITE_IOERR_VNODE
    // on a write to an unlinked file); Linux writes on happily, so there this
    // is a control that passes either way.
    const cacheDir = path.join(dir, 'cache')
    const cache = new Cache(cacheDir)
    const outFile = path.join(dir, 'out.txt')
    await writeFile(outFile, 'produced')
    await cache.save({
      hash: 'h-close',
      projectDir: dir,
      outputFiles: [outFile],
      entry: { taskId: 'pkg#build', command: 'c', durationMs: 1, stdout: '' },
    })
    expect(await cache.get('h-close')).not.toBeNull()

    await rm(cacheDir, { recursive: true, force: true })
    expect(() => {
      cache.close()
    }).not.toThrow()
  })
})

describe('Cache schema/version recovery', () => {
  let workspaceRoot: string
  let cacheDir: string

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'vx-cache-recover-'))
    cacheDir = path.join(workspaceRoot, '.vx', 'cache')
  })

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true })
  })

  it('a SCHEMA_VERSION reset leaves NO row behind but the two that may stay', async () => {
    // Item 504. The row below names two tables; this one quantifies over
    // every table the schema creates, because the hazard is a table ADDED
    // later and left out of the DROP list — stale rows under a new schema,
    // read by code that assumes they match it.
    //
    // Measured, and the drop list is NOT the whole mechanism: two tables
    // are absent from it and only one of them survives.
    //   output_dirs      absent from the list, still CLEARED — with
    //                    foreign_keys on, DROP TABLE fires the ON DELETE
    //                    CASCADE from its entries(hash) reference.
    //   config_closures  absent, and it SURVIVES. That is safe rather than
    //                    lucky: a closure is a stat-index feeding config
    //                    key derivation, so a stale one changes the KEY (a
    //                    miss, then a rewrite), never the answer.
    //   schema_meta      holds the sentinel the gate just wrote; dropping
    //                    it would lose the version it is recording.
    //
    // The first probe of this said nothing survived, because it planted
    // `created_at = 1` and the config TTL sweep removes anything that old —
    // the payload has to be one the code would really see (item 488).
    const { Database } = await import('bun:sqlite')
    const c1 = new Cache(cacheDir)
    c1.close()
    const dbPath = path.join(cacheDir, 'cache.db')

    const raw = new Database(dbPath)
    const tables = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string
      }>
    )
      .map((r) => r.name)
      .filter((n) => !n.startsWith('sqlite_'))
      .sort()
    const now = Date.now()
    for (const t of tables) {
      if (t === 'schema_meta') continue
      const cols = raw.prepare(`PRAGMA table_info(${t})`).all() as Array<{
        name: string
        type: string
      }>
      const vals = cols.map((col) =>
        col.type === 'INTEGER' || col.type === 'REAL'
          ? /_at$|_ms$/.test(col.name)
            ? String(now)
            : '1'
          : `'x'`,
      )
      raw
        .prepare(
          `INSERT OR REPLACE INTO ${t}(${cols.map((c) => c.name).join(',')}) VALUES (${vals.join(',')})`,
        )
        .run()
    }
    // Every table now holds a row, so the assertion below cannot pass by
    // planting nothing.
    const before = Object.fromEntries(
      tables.map((t) => [
        t,
        (raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
      ]),
    )
    // `schema_meta` holds the schema version and the cache format (item 671).
    expect(before).toEqual(Object.fromEntries(tables.map((t) => [t, t === 'schema_meta' ? 2 : 1])))
    raw.prepare("UPDATE schema_meta SET value = 'v0-ancient' WHERE key = 'version'").run()
    raw.close()

    const c2 = new Cache(cacheDir)
    expect(c2.schemaReset).toEqual({ from: 'v0-ancient', to: expect.stringMatching(/^v\d+$/) })
    c2.close()

    const after = new Database(dbPath)
    const survivors = tables
      .filter((t) => (after.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n > 0)
      .sort()
    after.close()
    expect(survivors).toEqual(['config_closures', 'schema_meta'])
  })

  it('SCHEMA_VERSION mismatch wipes entries + runs and recreates cleanly', async () => {
    // Round 1: write a real entry to a fresh cache.
    const c1 = new Cache(cacheDir)
    const projectDir = path.join(workspaceRoot, 'pkg')
    await mkdir(projectDir, { recursive: true })
    expect(c1.schemaReset).toBeNull()
    try {
      await writeFile(path.join(projectDir, 'out.txt'), 'built')
      await c1.save({
        hash: 'h-artifact',
        projectDir,
        outputFiles: [path.join(projectDir, 'out.txt')],
        entry: { taskId: 'pkg#build', command: 'noop', durationMs: 0, stdout: '' },
      })
      c1.recordRun({
        hash: 'h-old',
        project: 'pkg',
        task: 'build',
        status: 'success',
        exitCode: 0,
        durationMs: 1,
        startedAt: Date.now(),
        endedAt: Date.now() + 1,
      })
      expect(c1.stats().runCountLast24h).toBe(1)
    } finally {
      c1.close()
    }

    // Simulate schema upgrade: bump the stored version sentinel.
    // `Database` import has to match `Cache`'s internal handle since
    // they share a single underlying file via WAL.
    const { Database } = await import('bun:sqlite')
    const db = new Database(path.join(cacheDir, 'cache.db'))
    db.prepare(
      "UPDATE schema_meta SET value = 'unknown-future-version' WHERE key = 'version'",
    ).run()
    db.close()

    // Round 2: opening a fresh Cache detects the mismatch, drops the
    // tables, recreates them, and updates the sentinel. The old run
    // row is gone; new writes succeed.
    const c2 = new Cache(cacheDir)
    try {
      // The open that dropped the tables is the one that knows; the next
      // open sees the current version and reports nothing.
      expect(c2.schemaReset).toEqual({
        from: 'unknown-future-version',
        to: expect.stringMatching(/^v\d+$/),
      })
      const c3 = new Cache(cacheDir)
      expect(c3.schemaReset).toBeNull()
      c3.close()
      expect(c2.stats().runCountLast24h).toBe(0)
      // The Tier-3 tables are recreated as part of the gate.
      const db = c2.dbHandle()
      const tables = (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('invocations','entry_inputs')",
          )
          .all() as Array<{ name: string }>
      )
        .map((r) => r.name)
        .sort()
      expect(tables).toEqual(['entry_inputs', 'invocations'])
      // Write succeeds (tables exist).
      c2.recordRun({
        hash: 'h-new',
        project: 'pkg',
        task: 'build',
        status: 'success',
        exitCode: 0,
        durationMs: 1,
        startedAt: Date.now(),
        endedAt: Date.now() + 1,
      })
      expect(c2.stats().runCountLast24h).toBe(1)
      // The drop orphaned round 1's artifact: no row knows it, so a
      // lookup misses, and prune's sweep is what reclaims the bytes
      // once the file is past the in-flight grace window.
      const orphan = c2.outputsPath('h-artifact')
      expect(await c2.get('h-artifact')).toBeNull()
      expect(existsSync(orphan)).toBe(true)
      const aged = (Date.now() - 2 * 60 * 60 * 1000) / 1000
      await utimes(orphan, aged, aged)
      const pruned = await c2.prune({ olderThanMs: 1 })
      expect(pruned.orphans).toBe(1)
      expect(existsSync(orphan)).toBe(false)
    } finally {
      c2.close()
    }
  })

  it('CACHE_VERSION mismatch orphans old entries (key derivation changes)', async () => {
    // We can't easily change CACHE_VERSION at runtime, but we can
    // verify the property: the constant participates in every key,
    // so a hash computed with a different prefix would never collide
    // with a real entry. We simulate by writing a fabricated row at
    // an "old-version" hash and confirming get() can find it (DB
    // doesn't care about derivation), but `key()` for the same inputs
    // won't reproduce that hash. The test guards against accidentally
    // dropping the CACHE_VERSION prefix from the hash composition.
    const cache = new Cache(cacheDir)
    try {
      const input: CacheKeyInput = {
        taskId: 'pkg#build',
        taskConfigHash: 'cfg',
        projectPackageJsonHash: 'pkg',
        envValues: [],
        inputFiles: [],
        workspaceRoot: cacheDir,
        upstreamHashes: [],
        workspaceFingerprint: 'fp',
      }
      const realKey = await cache.key(input)
      // xxh3 hex = 16 chars
      expect(realKey).toHaveLength(16)
      // A hash derived from the same logical inputs WITHOUT the
      // CACHE_VERSION sentinel (the trivial xxh3 over a different
      // prefix) must differ.
      const noPrefixHash = Bun.hash.xxHash3('no-prefix').toString(16).padStart(16, '0')
      expect(realKey).not.toBe(noPrefixHash)
    } finally {
      cache.close()
    }
  })
})

describe('Cache.recordRunBundle (Tier 3)', () => {
  let workspaceRoot: string
  let cacheDir: string

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'vx-cache-bundle-'))
    cacheDir = path.join(workspaceRoot, '.vx', 'cache')
  })

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true })
  })

  function invocation(runId: string): InvocationRecord {
    return {
      runId,
      command: 'vx run build --all',
      requestedTasks: JSON.stringify(['build']),
      cachePolicy: 'lR,lW,rR,rW',
      concurrency: 4,
      flow: 'broad',
      startedAt: Date.now() - 100,
      endedAt: Date.now(),
      totalDurationMs: 100,
      taskCount: 2,
      failedCount: 0,
      hitCount: 1,
      hitLocalCount: 1,
      hitRemoteCount: 0,
      exitOk: true,
      commitSha: 'abc123',
      branch: 'main',
      dirty: false,
      ci: true,
      ciProvider: 'github',
      host: 'runner',
      os: 'linux',
      arch: 'x64',
      vxVersion: '0.0.0',
      tags: JSON.stringify({ team: 'core' }),
    }
  }

  // Save an entry carrying Tier-3 input components. Mirrors the
  // orchestrator's miss/save path — `entry_inputs` rides this
  // transaction, not `recordRunBundle`.
  async function saveWithInputs(
    cache: Cache,
    hash: string,
    components: ReadonlyArray<{ kind: string; name: string; hash: string }>,
  ): Promise<void> {
    const projectDir = path.join(workspaceRoot, `proj-${hash}`)
    await cache.save({
      hash,
      projectDir,
      outputFiles: [],
      inputComponents: components.map((c) => ({ entryHash: hash, ...c })),
      entry: { taskId: 'pkg#build', command: 'build', durationMs: 1, stdout: '' },
    })
  }

  it('writes the invocation header row atomically (no input rows here)', async () => {
    const cache = new Cache(cacheDir)
    const runId = 'run-1'
    const runs = [
      {
        hash: 'h-a',
        project: 'pkg-a',
        task: 'build',
        status: 'success' as const,
        exitCode: 0,
        durationMs: 50,
        startedAt: Date.now() - 50,
        endedAt: Date.now(),
        runId,
      },
      {
        hash: 'h-b',
        project: 'pkg-b',
        task: 'build',
        status: 'cache-hit' as const,
        exitCode: 0,
        durationMs: 1,
        startedAt: Date.now() - 1,
        endedAt: Date.now(),
        runId,
      },
    ]
    try {
      cache.recordRunBundle({ runs, invocation: invocation(runId) })
      const db = cache.dbHandle()

      const inv = db.prepare('SELECT * FROM invocations WHERE run_id = ?').get(runId) as Record<
        string,
        unknown
      >
      expect(inv.command).toBe('vx run build --all')
      expect(inv.branch).toBe('main')
      expect(inv.commit_sha).toBe('abc123')
      expect(inv.ci).toBe(1)
      expect(inv.ci_provider).toBe('github')
      expect(inv.dirty).toBe(0)
      expect(inv.exit_ok).toBe(1)
      expect(inv.hit_local_count).toBe(1)
      expect(inv.hit_remote_count).toBe(0)
      expect(inv.tags).toBe(JSON.stringify({ team: 'core' }))

      // recordRunBundle does NOT touch entry_inputs — those ride the
      // save transaction (a warm run that only hits writes none).
      const total = db.prepare('SELECT COUNT(*) AS n FROM entry_inputs').get() as { n: number }
      expect(total.n).toBe(0)

      // The runs rows landed in the same transaction.
      expect(cache.stats().runCountLast24h).toBe(2)
    } finally {
      cache.close()
    }
  })

  it('keeps exactly the append-only indexes on runs and sheds the dropped ones', async () => {
    // A (project, task) index scattered every run's inserts over one leaf
    // per pair (record stage 57–79 ms vs 14–19 ms at 1,000 hits); the
    // history reader bounds its scan by rowid instead. Any index added here
    // must be append-only under a run's inserts — `runs_failed` is PARTIAL
    // over failed rows, so a green run's inserts only evaluate its
    // predicate — and the DROPs must still clear a database created before
    // they left.
    const indexesOnRuns = (db: Database): string[] =>
      (
        db
          .query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'runs'")
          .all() as { name: string }[]
      )
        .map((r) => r.name)
        .sort()
    const cache = new Cache(cacheDir)
    try {
      expect(indexesOnRuns(cache.dbHandle())).toEqual([
        'runs_failed',
        'runs_run_id',
        'runs_started_at',
      ])
      cache.dbHandle().exec('CREATE INDEX runs_project ON runs(project, task)')
      cache.dbHandle().exec('CREATE INDEX runs_ended ON runs(ended_at)')
    } finally {
      cache.close()
    }
    const reopened = new Cache(cacheDir)
    try {
      expect(indexesOnRuns(reopened.dbHandle())).toEqual([
        'runs_failed',
        'runs_run_id',
        'runs_started_at',
      ])
    } finally {
      reopened.close()
    }
  })

  it('close() prunes runs and invocations older than 30 days (header never outlives its runs)', async () => {
    const cache = new Cache(cacheDir)
    const old = 40 * 24 * 60 * 60 * 1000
    const runRow = (runId: string, endedAt: number) => ({
      hash: `h-${runId}`,
      project: 'p',
      task: 't',
      status: 'success' as const,
      exitCode: 0,
      durationMs: 1,
      startedAt: endedAt - 1,
      endedAt,
      runId,
    })
    cache.recordRunBundle({
      runs: [runRow('old-run', Date.now() - old)],
      invocation: {
        ...invocation('old-run'),
        startedAt: Date.now() - old - 100,
        endedAt: Date.now() - old,
      },
    })
    cache.recordRunBundle({
      runs: [runRow('recent-run', Date.now())],
      invocation: invocation('recent-run'),
    })
    // The prune runs on close.
    cache.close()

    const reopened = new Cache(cacheDir)
    try {
      const db = reopened.dbHandle()
      const ids = (
        db.prepare('SELECT run_id FROM invocations ORDER BY run_id').all() as { run_id: string }[]
      ).map((r) => r.run_id)
      expect(ids).toEqual(['recent-run'])
      // The runs half: this row asserted the header alone until item 633,
      // and the `DELETE FROM runs` beside it survived deletion.
      const hashes = (
        db.prepare('SELECT hash FROM runs ORDER BY hash').all() as { hash: string }[]
      ).map((r) => r.hash)
      expect(hashes).toEqual(['h-recent-run'])
    } finally {
      reopened.close()
    }
  })

  it('close() prunes config evals and closures not loaded in 30 days and keeps the rest', async () => {
    // The third duty of close(), beside the history prune and the two
    // flushes: a config not loaded in 30 days was edited or its project
    // left, and its rows would otherwise grow the index forever. Held by
    // nothing until item 633.
    const cache = new Cache(cacheDir)
    cache.putConfigEvals([
      ['k-old', '{"old":true}'],
      ['k-new', '{"new":true}'],
    ])
    cache.putConfigClosures([
      ['/w/old/vx.config.ts', ['/w/old/a.ts']],
      ['/w/new/vx.config.ts', ['/w/new/b.ts']],
    ])
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000
    const db = cache.dbHandle()
    db.prepare('UPDATE config_evals SET created_at = ? WHERE key = ?').run(old, 'k-old')
    db.prepare('UPDATE config_closures SET created_at = ? WHERE config_path = ?').run(
      old,
      '/w/old/vx.config.ts',
    )
    cache.close()

    const reopened = new Cache(cacheDir)
    try {
      expect([...reopened.getConfigEvals(['k-old', 'k-new']).keys()]).toEqual(['k-new'])
      expect([
        ...reopened.getConfigClosures(['/w/old/vx.config.ts', '/w/new/vx.config.ts']).keys(),
      ]).toEqual(['/w/new/vx.config.ts'])
    } finally {
      reopened.close()
    }
  })

  it('persists entry_inputs inside the entry-save transaction (miss path)', async () => {
    const cache = new Cache(cacheDir)
    try {
      await saveWithInputs(cache, 'h-save', [
        { kind: 'config', name: 'config', hash: 'cfg-a' },
        { kind: 'file', name: 'src/a.ts', hash: 'oid-a' },
        { kind: 'env', name: 'MODE', hash: 'prod' },
        { kind: 'upstream', name: 'pkg-a#build', hash: 'up-a' },
      ])
      const db = cache.dbHandle()
      const rows = db
        .prepare('SELECT kind, name, hash FROM entry_inputs WHERE entry_hash = ? ORDER BY kind')
        .all('h-save') as Array<{ kind: string; name: string; hash: string }>
      expect(rows).toHaveLength(4)
      expect(rows.map((r) => r.kind).sort()).toEqual(['config', 'env', 'file', 'upstream'])
    } finally {
      cache.close()
    }
  })

  it('a warm cache hit writes NOTHING to entry_inputs (idempotent re-save)', async () => {
    const cache = new Cache(cacheDir)
    try {
      const db = cache.dbHandle()
      // Cold: a miss/save populates the rows for this hash.
      await saveWithInputs(cache, 'h-warm', [
        { kind: 'config', name: 'config', hash: 'cfg' },
        { kind: 'file', name: 'src/x.ts', hash: 'oid-x' },
      ])
      const after1 = (db.prepare('SELECT COUNT(*) AS n FROM entry_inputs').get() as { n: number }).n
      expect(after1).toBe(2)

      // Warm: a cache hit never calls save, so it writes nothing. We
      // assert the invariant directly — recording the run touches only
      // runs + invocations.
      cache.recordRunBundle({
        runs: [
          {
            hash: 'h-warm',
            project: 'pkg',
            task: 'build',
            status: 'cache-hit',
            exitCode: 0,
            durationMs: 1,
            startedAt: Date.now() - 1,
            endedAt: Date.now(),
            runId: 'warm-run',
          },
        ],
        invocation: invocation('warm-run'),
      })
      const after2 = (db.prepare('SELECT COUNT(*) AS n FROM entry_inputs').get() as { n: number }).n
      expect(after2).toBe(after1)

      // And even a defensive re-save of the same hash (INSERT OR IGNORE)
      // adds no rows — identical inputs derive the identical hash.
      await saveWithInputs(cache, 'h-warm', [
        { kind: 'config', name: 'config', hash: 'cfg' },
        { kind: 'file', name: 'src/x.ts', hash: 'oid-x' },
      ])
      const after3 = (db.prepare('SELECT COUNT(*) AS n FROM entry_inputs').get() as { n: number }).n
      expect(after3).toBe(after1)
    } finally {
      cache.close()
    }
  })

  it('a null dirty flag stays null (distinct from 0)', async () => {
    const cache = new Cache(cacheDir)
    const runId = 'run-nogit'
    try {
      const inv = { ...invocation(runId), dirty: null, commitSha: null, branch: null }
      cache.recordRunBundle({ runs: [], invocation: inv })
      const row = cache
        .dbHandle()
        .prepare('SELECT dirty, commit_sha, branch FROM invocations WHERE run_id = ?')
        .get(runId) as { dirty: number | null; commit_sha: string | null; branch: string | null }
      expect(row.dirty).toBeNull()
      expect(row.commit_sha).toBeNull()
      expect(row.branch).toBeNull()
    } finally {
      cache.close()
    }
  })

  it('survives a close/reopen round-trip', async () => {
    const runId = 'run-persist'
    const c1 = new Cache(cacheDir)
    c1.recordRunBundle({ runs: [], invocation: invocation(runId) })
    await saveWithInputs(c1, 'h-persist', [{ kind: 'config', name: 'config', hash: 'c' }])
    c1.close()

    const c2 = new Cache(cacheDir)
    try {
      const n = c2
        .dbHandle()
        .prepare('SELECT COUNT(*) AS n FROM entry_inputs WHERE entry_hash = ?')
        .get('h-persist') as { n: number }
      expect(n.n).toBe(1)
      const inv = c2
        .dbHandle()
        .prepare('SELECT command FROM invocations WHERE run_id = ?')
        .get(runId)
      expect(inv).not.toBeNull()
    } finally {
      c2.close()
    }
  })
})

describe('skip-restore staleness — millisecond mtimes (the v22 KNOWN-OPEN fix)', () => {
  let workspaceRoot: string
  let projectDir: string
  let cache: Cache

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'vx-cache-ms-'))
    projectDir = path.join(workspaceRoot, 'project')
    cache = new Cache(path.join(workspaceRoot, '.vx', 'cache'))
    const { mkdir } = await import('node:fs/promises')
    await mkdir(path.join(projectDir, 'dist'), { recursive: true })
  })

  afterEach(async () => {
    cache.close()
    await rm(workspaceRoot, { recursive: true, force: true })
  })

  const saveOne = async (hash: string, content: string): Promise<string> => {
    const outFile = path.join(projectDir, 'dist', 'o.txt')
    await writeFile(outFile, content)
    await cache.save({
      hash,
      projectDir,
      outputFiles: [outFile],
      entry: { taskId: 'pkg#build', command: 'b', durationMs: 1, stdout: '' },
    })
    // What the miss path does after every save (miss-save.ts).
    cache.recordOutputStamps(hash, projectDir, workspaceRoot)
    return outFile
  }

  const rowsOf = (hash: string) => cache.loadOutputFilesBatch([hash]).get(hash)!
  /** A restore as the hit path runs it: extract, then stamp (hit-restore.ts). */
  const restore = async (hash: string) => {
    await cache.restoreOutputs(hash, projectDir)
    cache.recordOutputStamps(hash, projectDir, workspaceRoot)
  }

  it('a same-size different-content rewrite is detected (was invisible within one second)', async () => {
    const outFile = await saveOne('ms1', 'AAAA')
    // Unchanged: current.
    expect(await cache.isOutputsCurrent(projectDir, rowsOf('ms1'))).toBe(true)
    // Same-size rewrite inside the same wall-clock second, which the old
    // seconds-granularity compare could not see. The rewrite's mtime is
    // STAMPED one millisecond past the recorded one: a file's mtime comes
    // from the kernel's coarse clock (one tick, 4 ms at HZ=250), so a short
    // sleep before the write can land in the recorded tick and the claim
    // would ride on the scheduler — it did, once, under a loaded gate.
    await writeFile(outFile, 'BBBB')
    const bumped = new Date(rowsOf('ms1')[0]!.mtimeMs + 1)
    await utimes(outFile, bumped, bumped)
    expect(await cache.isOutputsCurrent(projectDir, rowsOf('ms1'))).toBe(false)
  })

  it('restoreOutputs re-syncs mtimes to the rows, so the next probe skips', async () => {
    const outFile = await saveOne('ms2', 'CCCC')
    await rm(outFile)
    await restore('ms2')
    expect(await readFile(outFile, 'utf8')).toBe('CCCC')
    expect(await cache.isOutputsCurrent(projectDir, rowsOf('ms2'))).toBe(true)
  })

  it('an INGESTED (remote-sourced) artifact indexes ms mtimes too', async () => {
    // The artifact's own sidecar carries mode + ms mtime, so the ingest
    // path — which has no filesystem to stat — records exactly what the
    // producer measured. Before the sidecar it could only read tar
    // headers, i.e. SECONDS, and a same-second edit after a remote hit
    // was invisible to the skip-restore probe.
    // The precondition is a sub-second stamp on the saved file. Sampling the
    // clock for it fails whenever the write lands on an exact second — one
    // run in a thousand, and darwin CI found that run (2026-09-03). Stamp
    // it, so the precondition is MADE true rather than hoped for.
    const outFile = path.join(projectDir, 'dist', 'o.txt')
    await writeFile(outFile, 'DDDD')
    const stamp = new Date(Math.floor(Date.now() / 1000) * 1000 + 250)
    await utimes(outFile, stamp, stamp)
    await cache.save({
      hash: 'ms3',
      projectDir,
      outputFiles: [outFile],
      entry: { taskId: 'pkg#build', command: 'b', durationMs: 1, stdout: '' },
    })
    const recorded = rowsOf('ms3')[0]!.mtimeMs
    expect(recorded % 1000).toBe(250)

    const bytes = await Bun.file(cache.outputsPath('ms3')).bytes()
    await cache.ingest('ms3-remote', new Blob([bytes]), {
      taskId: 'pkg#build',
      command: 'b',
      durationMs: 1,
    })
    expect(rowsOf('ms3-remote')[0]!.mtimeMs).toBe(recorded)

    // An ingest has no file of this machine's to stamp: its rows are never
    // current until a restore writes and stamps them (item 886).
    expect(await cache.isOutputsCurrent(projectDir, rowsOf('ms3-remote'))).toBe(false)
    // …and restoring the ingested copy reproduces that stamp on disk, so
    // the next probe skips instead of restoring again.
    await rm(outFile)
    await restore('ms3-remote')
    expect(await cache.isOutputsCurrent(projectDir, rowsOf('ms3-remote'))).toBe(true)
  })

  it('a forged mtime is caught: the rewrite moved the ctime (item 886)', async () => {
    const outFile = await saveOne('ms4', 'EEEE')
    const recorded = rowsOf('ms4')[0]!.mtimeMs
    // Past the coarse clock's tick since the stamp (4 ms at HZ=250, 10 at
    // HZ=100): a rewrite inside it keeps the stamped ctime (item 886).
    await Bun.sleep(25)
    await writeFile(outFile, 'FFFF')
    // Forge the mtime back to the recorded value (touch -r). Until item
    // 886 this was the documented blind spot; the utimes itself moves
    // the ctime, which no task can set.
    await utimes(outFile, recorded / 1000, recorded / 1000)
    expect(await cache.isOutputsCurrent(projectDir, rowsOf('ms4'))).toBe(false)
  })

  it('two entries with one size and one fixed mtime are told apart (item 886)', async () => {
    // `tar -x`, `cp -p`, SOURCE_DATE_EPOCH: the task sets its outputs'
    // mtime, so v1 and v2 carry identical (size, mode, mtime) rows. With
    // v2's bytes on disk, v1's rows matched, and a v1 → v2 → v1 round
    // trip reported up-to-date over v2's bytes.
    const fixed = new Date(1_000_000_000_000)
    const outFile = path.join(projectDir, 'dist', 'o.txt')
    for (const [hash, content] of [
      ['v1', 'one1'],
      ['v2', 'two2'],
    ] as const) {
      // The two writes land in separate runs in life; within one tick of
      // the first stamp an in-place rewrite keeps its ctime (item 886's
      // documented residual), so the second waits the tick out.
      await Bun.sleep(25)
      await writeFile(outFile, content)
      await utimes(outFile, fixed, fixed)
      await cache.save({
        hash,
        projectDir,
        outputFiles: [outFile],
        entry: { taskId: 'pkg#build', command: 'b', durationMs: 1, stdout: '' },
      })
      cache.recordOutputStamps(hash, projectDir, workspaceRoot)
    }
    // The control: the rows really are identical but for the stamp.
    const strip = (h: string) => rowsOf(h).map(({ ino: _i, ctimeMs: _c, ...r }) => r)
    expect(strip('v1')).toEqual(strip('v2'))
    expect(await readFile(outFile, 'utf8')).toBe('two2')
    expect(await cache.isOutputsCurrent(projectDir, rowsOf('v2'))).toBe(true)
    expect(await cache.isOutputsCurrent(projectDir, rowsOf('v1'))).toBe(false)
    // Restored, v1 is current and v2 is not.
    await restore('v1')
    expect(await readFile(outFile, 'utf8')).toBe('one1')
    expect(await cache.isOutputsCurrent(projectDir, rowsOf('v1'))).toBe(true)
    expect(await cache.isOutputsCurrent(projectDir, rowsOf('v2'))).toBe(false)
  })

  it('a permission (mode-only) change is detected even with size + mtime unchanged', async () => {
    const { chmod } = await import('node:fs/promises')
    const outFile = await saveOne('ms5', 'GGGG')
    expect(await cache.isOutputsCurrent(projectDir, rowsOf('ms5'))).toBe(true)
    // Toggle the execute bits: chmod changes ctime only, so size + mtime
    // stay identical to the recorded row — the mode compare is the only
    // thing that can catch it.
    const recordedMode = rowsOf('ms5')[0]!.mode & 0o777
    await chmod(outFile, recordedMode ^ 0o111)
    expect(await cache.isOutputsCurrent(projectDir, rowsOf('ms5'))).toBe(false)
  })
})

// nx#35403: artifacts copied into a cache directory without the index that
// named them failed the run. The index is authoritative (caching.md): an
// artifact with no row is never a hit, and the save that follows replaces
// it and indexes it.
describe('an artifact on disk with no index row, through a run', () => {
  it('is a silent miss; the task runs, the save takes the file over, and the next run hits', async () => {
    const root = await makeWorkspace({ prefix: 'vx-rowless-' })
    try {
      await addProject(root, 'app', {
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'mkdir -p dist && cat src/a.txt > dist/out.txt' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
        files: { 'src/a.txt': 'a1\n' },
      })
      const lines: string[] = []
      const log = {
        status: (l: string) => lines.push(l),
        taskStdout() {},
        taskStderr() {},
        taskComplete() {},
      }
      const once = async () => {
        const r = await run({ cwd: root, tasks: ['build'], log })
        return { ok: r.ok, statuses: r.outcomes.map((o) => o.status) }
      }
      const cacheDir = path.join(root, '.vx', 'cache')
      const artifacts = async () => (await readdir(cacheDir)).filter((f) => f.endsWith('.tar.zst'))

      expect(await once()).toEqual({ ok: true, statuses: ['success'] })
      const [artifact] = await artifacts()
      expect(artifact).toBeDefined()
      for (const f of await readdir(cacheDir)) {
        if (f.startsWith('cache.db')) await rm(path.join(cacheDir, f))
      }
      await rm(path.join(root, 'packages', 'app', 'dist'), { recursive: true })

      lines.length = 0
      expect(await once()).toEqual({ ok: true, statuses: ['success'] })
      // Notices, not the summary block every run prints.
      expect(lines.filter((l) => /^\[?vx[\]:]/.test(l))).toEqual([])
      expect(await artifacts()).toEqual([artifact!])
      expect(await once()).toEqual({ ok: true, statuses: ['cache-hit'] })
      const { Database: Db } = await import('bun:sqlite')
      const db = new Db(path.join(cacheDir, 'cache.db'), { readonly: true })
      try {
        expect(db.query('SELECT count(*) AS n FROM entries').get()).toEqual({ n: 1 })
      } finally {
        db.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
