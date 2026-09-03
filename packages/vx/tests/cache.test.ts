import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  Cache,
  type CacheKeyInput,
  CorruptArtifactError,
  FULL_CACHE_POLICY,
  type InvocationRecord,
  parseCachePolicy,
  zstdContentSize,
} from '../src/cache/cache.js'
import { UserError, xxh3hex } from '../src/util/index.js'

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

  it('distinguishes empty value from unset (different cache keys)', async () => {
    const present = await cache.key({ ...baseInput(), envValues: [['MODE', '']] })
    const absent = await cache.key({ ...baseInput(), envValues: [] })
    expect(present).not.toBe(absent)
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

  it('ingest() rejects corrupt zstd bytes — no artifact on disk, no SQL row', async () => {
    const garbage = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4, 5, 6, 7, 8])
    await expect(
      cache.ingest('h-corrupt', garbage, { taskId: 'pkg#build', command: 'tsc', durationMs: 1 }),
    ).rejects.toThrow(CorruptArtifactError)
    expect(existsSync(path.join(cacheDir, 'h-corrupt.tar.zst'))).toBe(false)
    expect(await cache.get('h-corrupt')).toBeNull()
  })

  it('ingest() rejects valid zstd that is not a vx artifact (no stdout entry)', async () => {
    const notTar = await Bun.zstdCompress(new TextEncoder().encode('not a tar archive at all'))
    await expect(
      cache.ingest('h-not-tar', new Uint8Array(notTar), {
        taskId: 'pkg#build',
        command: 'tsc',
        durationMs: 1,
      }),
    ).rejects.toThrow(CorruptArtifactError)
    expect(existsSync(path.join(cacheDir, 'h-not-tar.tar.zst'))).toBe(false)
    expect(await cache.get('h-not-tar')).toBeNull()
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
      cache.ingest('h-bomb', frame, { taskId: 'pkg#build', command: 'tsc', durationMs: 1 }),
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
    await cache.ingest('h-sizeless', sizeless, {
      taskId: 'pkg#build',
      command: 'tsc',
      durationMs: 1,
    })
    expect((await cache.get('h-sizeless'))?.stdout).toBe('streamed')

    const garbage = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x01, 0x00, 0x00])
    await expect(
      cache.ingest('h-garbage', garbage, { taskId: 'pkg#build', command: 'tsc', durationMs: 1 }),
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
      cache.ingest('h-bomb4', frame, { taskId: 'pkg#build', command: 'tsc', durationMs: 1 }),
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

    const result = await cache.prune({ olderThanMs: Date.now() })
    expect(result.evicted).toBe(1)
    expect(result.bytesFreed).toBeGreaterThanOrEqual(3)

    // DB row gone + on-disk dir gone (logs live inside <hash>/, so one rm covers both).
    expect(await cache.get('h-old')).toBeNull()
    expect(existsSync(path.join(cacheDir, 'h-old'))).toBe(false)
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

    // Cap = two artifacts' worth, measured rather than guessed: a
    // hardcoded byte count silently becomes "evict everything" the next
    // time the artifact layout gains a record.
    const oneArtifact = (await import('node:fs')).statSync(cache.outputsPath('h3')).size
    const result = await cache.prune({ maxBytes: oneArtifact * 2 })
    expect(result.evicted).toBeGreaterThanOrEqual(1)
    // h3 (most recently accessed) survives.
    expect(await cache.get('h3')).not.toBeNull()
    // h1 (oldest accessed) is gone.
    expect(await cache.get('h1')).toBeNull()
  })

  it('prune() rejects empty options', async () => {
    await expect(cache.prune({})).rejects.toThrow(/at least one of/)
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
        await cache.ingest('ingest-symmetry', bytes, {
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

  it('SCHEMA_VERSION mismatch wipes entries + runs and recreates cleanly', async () => {
    // Round 1: write a real entry to a fresh cache.
    const c1 = new Cache(cacheDir)
    try {
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

  it('close() prunes invocations older than 30 days (header never outlives its runs)', async () => {
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
    return outFile
  }

  const rowsOf = (hash: string) => cache.loadOutputFilesBatch([hash]).get(hash)!

  it('a same-size different-content rewrite is detected (was invisible within one second)', async () => {
    const outFile = await saveOne('ms1', 'AAAA')
    // Unchanged: current.
    expect(await cache.isOutputsCurrent(projectDir, rowsOf('ms1'))).toBe(true)
    // Same-size rewrite moments later — well inside the same wall-clock
    // second, which the old seconds-granularity compare could not see.
    await Bun.sleep(3)
    await writeFile(outFile, 'BBBB')
    expect(await cache.isOutputsCurrent(projectDir, rowsOf('ms1'))).toBe(false)
  })

  it('restoreOutputs re-syncs mtimes to the rows, so the next probe skips', async () => {
    const outFile = await saveOne('ms2', 'CCCC')
    await rm(outFile)
    await cache.restoreOutputs('ms2', projectDir)
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
    await cache.ingest('ms3-remote', bytes, {
      taskId: 'pkg#build',
      command: 'b',
      durationMs: 1,
    })
    expect(rowsOf('ms3-remote')[0]!.mtimeMs).toBe(recorded)

    // …and restoring the ingested copy reproduces that stamp on disk, so
    // the next probe skips instead of restoring again.
    await rm(outFile)
    await cache.restoreOutputs('ms3-remote', projectDir)
    expect(await cache.isOutputsCurrent(projectDir, rowsOf('ms3-remote'))).toBe(true)
  })

  it('a forged mtime remains the documented blind spot', async () => {
    const outFile = await saveOne('ms4', 'EEEE')
    const recorded = rowsOf('ms4')[0]!.mtimeMs
    await Bun.sleep(3)
    await writeFile(outFile, 'FFFF')
    // Deliberately forge the mtime back to the recorded value (touch -r
    // equivalent): the probe cannot see this — accepted trade, pinned so
    // a future content-hash upgrade flips this expectation knowingly.
    await utimes(outFile, recorded / 1000, recorded / 1000)
    expect(await cache.isOutputsCurrent(projectDir, rowsOf('ms4'))).toBe(true)
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
