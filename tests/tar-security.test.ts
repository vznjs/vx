// Tar restore security tests — adapted from Turborepo's
// cache_archive/restore.rs threat model. Each test builds a malicious
// tar in memory and asserts the extractor REJECTS it instead of
// writing files outside the destination dir.
//
// The bug class these protect against is "zip slip" / "tar slip": an
// attacker controls a cache artifact (e.g. via a poisoned remote
// cache or a stale local entry whose contents were tampered with) and
// uses a crafted entry name like `outputs/../../escape.txt` or
// `outputs//etc/passwd` to write outside the project dir.

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { extractOutputs, parseTarHeaders } from '../src/cache/tar.js'

// ─── tar fixture helpers (same pattern as cache-baseline.test.ts) ────

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0'
}

function makeHeader(opts: {
  name: string
  size: number
  mode?: number
  typeFlag: string
  linkname?: string
  /** POSIX-ustar `prefix` field (bytes 345..499). */
  prefix?: string
  /** Magic+version at bytes 257..265. Defaults to POSIX ustar. */
  magic?: string
  /** Raw bytes to plant at 345..499 regardless of format (GNU atime/ctime). */
  tail?: string
}): Uint8Array {
  const buf = new Uint8Array(512)
  const enc = new TextEncoder()
  enc.encodeInto(opts.name, buf.subarray(0, 100))
  enc.encodeInto(octal(opts.mode ?? 0o644, 8), buf.subarray(100, 108))
  enc.encodeInto(octal(0, 8), buf.subarray(108, 116))
  enc.encodeInto(octal(0, 8), buf.subarray(116, 124))
  enc.encodeInto(octal(opts.size, 12), buf.subarray(124, 136))
  enc.encodeInto(octal(0, 12), buf.subarray(136, 148))
  for (let i = 148; i < 156; i++) buf[i] = 0x20
  buf[156] = opts.typeFlag.charCodeAt(0)
  if (opts.linkname) enc.encodeInto(opts.linkname, buf.subarray(157, 257))
  enc.encodeInto(opts.magic ?? 'ustar\0' + '00', buf.subarray(257, 265))
  if (opts.prefix) enc.encodeInto(opts.prefix, buf.subarray(345, 500))
  if (opts.tail) enc.encodeInto(opts.tail, buf.subarray(345, 500))
  let cksum = 0
  for (let i = 0; i < 512; i++) cksum += buf[i]!
  enc.encodeInto(octal(cksum, 7), buf.subarray(148, 155))
  buf[155] = 0x20
  return buf
}

function makeDataBlock(bytes: Uint8Array): Uint8Array {
  const padded = Math.ceil(bytes.length / 512) * 512
  const out = new Uint8Array(padded)
  out.set(bytes, 0)
  return out
}

function concatTar(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

const EOF_BLOCKS = new Uint8Array(1024)

function tarWithEntry(name: string, body: Uint8Array, typeFlag = '0'): Uint8Array {
  return concatTar([
    makeHeader({ name, size: body.length, typeFlag }),
    makeDataBlock(body),
    EOF_BLOCKS,
  ])
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('tar extractOutputs — path-traversal defense', () => {
  let dest: string
  let scratch: string

  beforeEach(async () => {
    dest = await mkdtemp(path.join(os.tmpdir(), 'vx-tar-sec-'))
    scratch = await mkdtemp(path.join(os.tmpdir(), 'vx-tar-scratch-'))
  })

  afterEach(async () => {
    await rm(dest, { recursive: true, force: true })
    await rm(scratch, { recursive: true, force: true })
  })

  it('a lazily-created base UNDER a symlinked ancestor is not a false escape', async () => {
    // The containment gate resolves the base and each existing ancestor and
    // requires the ancestor to stay inside. But the workspace-outputs anchor
    // is created lazily by the first entry, so at gate time `realpath(base)`
    // FAILS — and falling back to the un-resolved path compared a real
    // ancestor against a symlinked base and refused every entry. macOS makes
    // this the DEFAULT shape (`/tmp` is a symlink to `/private/tmp`), which
    // is why it is built explicitly here rather than left to the platform.
    const real = path.join(scratch, 'real')
    const link = path.join(scratch, 'link')
    await mkdir(real, { recursive: true })
    await symlink(real, link)

    const wsDest = path.join(link, 'ws-out') // deliberately NOT created
    const body = new TextEncoder().encode('generated')
    // The directory entry is load-bearing: it is what makes `gen/` EXIST by
    // the time the file entry's gate runs, which is the only state in which
    // the base's own resolution is compared against a real ancestor. A real
    // `tar -cf` always emits these; a fixture without one cannot see the bug.
    const tar = concatTar([
      makeHeader({ name: 'workspace-outputs/gen/', size: 0, typeFlag: '5' }),
      makeHeader({ name: 'workspace-outputs/gen/root.txt', size: body.length, typeFlag: '0' }),
      makeDataBlock(body),
      EOF_BLOCKS,
    ])

    await extractOutputs(tar, dest, wsDest)
    expect(await Bun.file(path.join(real, 'ws-out', 'gen', 'root.txt')).text()).toBe('generated')
  })

  it('still refuses an entry that escapes through a REAL symlinked parent', async () => {
    // Control for the fix above: resolving the base must not stop the gate
    // catching a symlinked directory INSIDE the tree pointing back out.
    const outside = path.join(scratch, 'outside')
    await mkdir(outside, { recursive: true })
    await mkdir(path.join(dest, 'ws'), { recursive: true })
    await symlink(outside, path.join(dest, 'ws', 'dist'))

    const body = new TextEncoder().encode('pwned')
    const tar = concatTar([
      makeHeader({ name: 'workspace-outputs/dist/x.txt', size: body.length, typeFlag: '0' }),
      makeDataBlock(body),
      EOF_BLOCKS,
    ])

    await expect(extractOutputs(tar, dest, path.join(dest, 'ws'))).rejects.toThrow(
      /symlinked parent/i,
    )
    expect(existsSync(path.join(outside, 'x.txt'))).toBe(false)
  })

  it('rejects entry with `..` segment (outputs/../escape.txt)', async () => {
    const body = new TextEncoder().encode('pwned')
    const tar = tarWithEntry('outputs/../escape.txt', body)
    await expect(extractOutputs(tar, dest)).rejects.toThrow(/escape|traversal|unsafe/i)
    // Nothing should land outside dest.
    expect(existsSync(path.join(dest, '..', 'escape.txt'))).toBe(false)
  })

  it('rejects entry with double `..` (outputs/../../escape.txt)', async () => {
    const body = new TextEncoder().encode('pwned')
    const tar = tarWithEntry('outputs/../../escape.txt', body)
    await expect(extractOutputs(tar, dest)).rejects.toThrow(/escape|traversal|unsafe/i)
  })

  it('rejects entry with embedded `..` segment (outputs/foo/../../escape.txt)', async () => {
    const body = new TextEncoder().encode('pwned')
    const tar = tarWithEntry('outputs/foo/../../escape.txt', body)
    await expect(extractOutputs(tar, dest)).rejects.toThrow(/escape|traversal|unsafe/i)
  })

  it('rejects absolute path entry (outputs//etc/passwd)', async () => {
    // The leading slash after `outputs/` makes the slice an absolute
    // path. path.join(destDir, '/etc/passwd') collapses to relative,
    // but path.resolve would not — defense in depth.
    const body = new TextEncoder().encode('shadow')
    const tar = tarWithEntry('outputs//etc/passwd', body)
    await expect(extractOutputs(tar, dest)).rejects.toThrow(/escape|absolute|unsafe/i)
  })

  it('rejects entry whose name contains a null byte', async () => {
    // Null byte truncation: an attacker prepends `safe.txt\0../../evil`
    // hoping the parser treats it as `safe.txt` but the FS APIs see
    // the full string. Our parser stops at the first null, so the name
    // would be `safe.txt` — still safe, but the test pins that
    // behavior and prevents a regression where the parser starts
    // honoring post-null bytes.
    const buf = new Uint8Array(512)
    const enc = new TextEncoder()
    enc.encodeInto('outputs/safe.txt', buf.subarray(0, 16))
    // Embed `\0../evil` after the safe prefix.
    enc.encodeInto('\0../evil', buf.subarray(16, 24))
    enc.encodeInto(octal(0o644, 8), buf.subarray(100, 108))
    enc.encodeInto(octal(0, 8), buf.subarray(108, 116))
    enc.encodeInto(octal(0, 8), buf.subarray(116, 124))
    enc.encodeInto(octal(5, 12), buf.subarray(124, 136))
    enc.encodeInto(octal(0, 12), buf.subarray(136, 148))
    for (let i = 148; i < 156; i++) buf[i] = 0x20
    buf[156] = 0x30 // '0' regular file
    enc.encodeInto('ustar\0', buf.subarray(257, 263))
    enc.encodeInto('00', buf.subarray(263, 265))
    let cksum = 0
    for (let i = 0; i < 512; i++) cksum += buf[i]!
    enc.encodeInto(octal(cksum, 7), buf.subarray(148, 155))
    buf[155] = 0x20

    const body = new TextEncoder().encode('hello')
    const tar = concatTar([buf, makeDataBlock(body), EOF_BLOCKS])
    await extractOutputs(tar, dest)
    // The name truncates at the null → only `outputs/safe.txt` is
    // extracted. No `evil` file should appear.
    expect(existsSync(path.join(dest, 'safe.txt'))).toBe(true)
    expect(existsSync(path.join(dest, '..', 'evil'))).toBe(false)
    expect(existsSync(path.join(dest, 'evil'))).toBe(false)
  })

  it('extracts a benign entry into destDir (sanity)', async () => {
    const body = new TextEncoder().encode('ok')
    const tar = tarWithEntry('outputs/hello.txt', body)
    await extractOutputs(tar, dest)
    expect(await readFile(path.join(dest, 'hello.txt'), 'utf8')).toBe('ok')
  })

  it('rejects entry with leading slash on name (after outputs/ strip)', async () => {
    // Entry `outputs/`+absolute → after stripping `outputs/` the rel
    // is `/foo` which path.join treats as relative but path.resolve
    // wouldn't. Pin the rejection.
    const body = new TextEncoder().encode('x')
    const tar = tarWithEntry('outputs//absolute.txt', body)
    await expect(extractOutputs(tar, dest)).rejects.toThrow(/escape|absolute|unsafe/i)
  })

  it('rejects entry whose resolved path is destDir itself', async () => {
    // An entry that resolves exactly to destDir (without a basename)
    // would clobber the directory. Block.
    const body = new Uint8Array(0)
    const tar = tarWithEntry('outputs/', body)
    // Empty rel after strip → no file to write; should be a no-op,
    // not a crash. Just verify we don't blow up.
    await extractOutputs(tar, dest)
  })
})

describe('tar extractOutputs — symlink defense', () => {
  let dest: string

  beforeEach(async () => {
    dest = await mkdtemp(path.join(os.tmpdir(), 'vx-tar-sym-'))
  })

  afterEach(async () => {
    await rm(dest, { recursive: true, force: true })
  })

  it('pre-existing symlink in destination is not followed (TOCTOU defense)', async () => {
    // Setup: an attacker has placed a symlink at <dest>/link.txt that
    // points to a sensitive file outside dest. A naive extractor that
    // writes through the symlink would clobber the target. We expect
    // the write to either replace the symlink OR error — NOT clobber
    // the target.
    const sensitiveDir = await mkdtemp(path.join(os.tmpdir(), 'vx-tar-sym-target-'))
    const sensitive = path.join(sensitiveDir, 'untouched.txt')
    await writeFile(sensitive, 'do-not-touch')
    await symlink(sensitive, path.join(dest, 'link.txt'))

    const body = new TextEncoder().encode('attacker-controlled')
    const tar = tarWithEntry('outputs/link.txt', body)
    // The extractor must NOT write through the existing symlink to
    // the sensitive target. Either it overwrites the symlink in place
    // (replacing it with a regular file) or it errors. Both are safe.
    try {
      await extractOutputs(tar, dest)
    } catch {
      // erroring is acceptable
    }
    expect(await readFile(sensitive, 'utf8')).toBe('do-not-touch')
    await rm(sensitiveDir, { recursive: true, force: true })
  })

  it('pre-existing symlinked PARENT directory is refused, not followed', async () => {
    // Attacker planted `<dest>/dist -> <sensitiveDir>` (a symlinked ancestor,
    // e.g. committed in the repo or created by a dependency postinstall). A
    // poisoned artifact entry `outputs/dist/evil.txt` is lexically contained
    // under dest, but writing it would follow the symlink and escape. The
    // realpath-parent check must refuse it and leave the sensitive dir intact.
    const sensitiveDir = await mkdtemp(path.join(os.tmpdir(), 'vx-tar-sym-pdir-'))
    await symlink(sensitiveDir, path.join(dest, 'dist'))

    const body = new TextEncoder().encode('attacker-controlled')
    const tar = tarWithEntry('outputs/dist/evil.txt', body)
    await expect(extractOutputs(tar, dest)).rejects.toThrow(/escape|symlink|unsafe/i)
    // Nothing was written into the symlink target.
    expect(existsSync(path.join(sensitiveDir, 'evil.txt'))).toBe(false)
    await rm(sensitiveDir, { recursive: true, force: true })
  })

  it('a DIRECTORY entry under a symlinked parent is refused, not created', async () => {
    // The dir pass called `mkdir(recursive)` with no containment check at
    // all, and mkdir follows a pre-existing symlink exactly like a file
    // write does — so directories were created OUTSIDE the destination
    // (file bytes were still refused, but the tree escape was real).
    const sensitiveDir = await mkdtemp(path.join(os.tmpdir(), 'vx-tar-sym-ddir-'))
    await symlink(sensitiveDir, path.join(dest, 'dist'))

    const tar = concatTar([
      makeHeader({ name: 'outputs/dist/planted/', size: 0, typeFlag: '5', mode: 0o755 }),
      EOF_BLOCKS,
    ])
    await expect(extractOutputs(tar, dest)).rejects.toThrow(/escape|symlink|unsafe/i)
    expect(existsSync(path.join(sensitiveDir, 'planted'))).toBe(false)
    await rm(sensitiveDir, { recursive: true, force: true })
  })

  it('a DEEP directory entry under a symlinked parent is refused (ancestor walk)', async () => {
    // The escaping segment is the symlink `dist`, but the entry names a
    // deeper path whose immediate parent does NOT exist yet — so checking
    // only the immediate parent would pass and mkdir(recursive) would build
    // the whole chain inside the symlink target.
    const sensitiveDir = await mkdtemp(path.join(os.tmpdir(), 'vx-tar-sym-deep-'))
    await symlink(sensitiveDir, path.join(dest, 'dist'))

    const tar = concatTar([
      makeHeader({ name: 'outputs/dist/a/b/c/', size: 0, typeFlag: '5', mode: 0o755 }),
      EOF_BLOCKS,
    ])
    await expect(extractOutputs(tar, dest)).rejects.toThrow(/escape|symlink|unsafe/i)
    expect(existsSync(path.join(sensitiveDir, 'a'))).toBe(false)
    await rm(sensitiveDir, { recursive: true, force: true })
  })

  it('a benign directory entry still extracts (control)', async () => {
    const tar = concatTar([
      makeHeader({ name: 'outputs/dist/nested/', size: 0, typeFlag: '5', mode: 0o755 }),
      EOF_BLOCKS,
    ])
    await extractOutputs(tar, dest)
    expect(existsSync(path.join(dest, 'dist', 'nested'))).toBe(true)
  })
})

describe('parseTarHeaders — security-relevant parse rejections', () => {
  it('rejects entries whose name contains a `..` segment', () => {
    const body = new TextEncoder().encode('x')
    const tar = tarWithEntry('outputs/../evil', body)
    expect(() => parseTarHeaders(tar)).toThrow(/escape|traversal|unsafe/i)
  })

  it('rejects entries whose name is absolute', () => {
    const body = new TextEncoder().encode('x')
    const tar = tarWithEntry('/etc/passwd', body)
    expect(() => parseTarHeaders(tar)).toThrow(/escape|absolute|unsafe/i)
  })
})

// ─── §5 gaps: typeflag + Windows + symlink + path-length defenses ────

describe('parseTarHeaders — typeflag rejections (hardlink / chardev / blockdev / fifo)', () => {
  // Build outputs ALWAYS produce regular files / directories. tar
  // typeflags for hardlinks (1), char devices (3), block devices (4),
  // FIFOs (6), and contiguous files (7) are out of scope and a
  // potential vector for surprising filesystem state inside the
  // destination. Reject at parse time.
  const REJECTED: Array<{ name: string; typeFlag: string; reason: RegExp }> = [
    { name: 'outputs/hard.bin', typeFlag: '1', reason: /typeflag|hardlink|unsupported/i },
    { name: 'outputs/chr.dev', typeFlag: '3', reason: /typeflag|device|unsupported/i },
    { name: 'outputs/blk.dev', typeFlag: '4', reason: /typeflag|device|unsupported/i },
    { name: 'outputs/pipe', typeFlag: '6', reason: /typeflag|fifo|unsupported/i },
    { name: 'outputs/cont.bin', typeFlag: '7', reason: /typeflag|contiguous|unsupported/i },
  ]
  for (const { name, typeFlag, reason } of REJECTED) {
    it(`rejects typeflag '${typeFlag}'`, () => {
      const tar = tarWithEntry(name, new Uint8Array(0), typeFlag)
      expect(() => parseTarHeaders(tar)).toThrow(reason)
    })
  }
})

describe('parseTarHeaders — symlink entries (typeflag 2)', () => {
  // Symlinks ARE a typeflag we could in principle support (build
  // outputs sometimes include them — e.g. node_modules symlink
  // farms). For v1 we reject all symlink entries explicitly so a
  // malicious archive can't smuggle a symlink-to-`/etc/passwd` past
  // our path-traversal checks via the linkname field.
  it('rejects symlink entries (typeflag 2) regardless of target', () => {
    const tar = concatTar([
      makeHeader({
        name: 'outputs/link.txt',
        size: 0,
        typeFlag: '2',
        linkname: 'plain-target.txt',
      }),
      EOF_BLOCKS,
    ])
    expect(() => parseTarHeaders(tar)).toThrow(/symlink|typeflag|unsupported/i)
  })

  it('rejects symlinks pointing outside the anchor (../escape)', () => {
    const tar = concatTar([
      makeHeader({
        name: 'outputs/link.txt',
        size: 0,
        typeFlag: '2',
        linkname: '../../etc/passwd',
      }),
      EOF_BLOCKS,
    ])
    expect(() => parseTarHeaders(tar)).toThrow(/symlink|typeflag|unsafe/i)
  })

  it('rejects symlinks with an empty link target', () => {
    const tar = concatTar([
      makeHeader({ name: 'outputs/link.txt', size: 0, typeFlag: '2' }),
      EOF_BLOCKS,
    ])
    expect(() => parseTarHeaders(tar)).toThrow(/symlink|typeflag|unsupported/i)
  })
})

describe('parseTarHeaders — Windows-shaped entry names', () => {
  // A producer on Windows might emit paths with `\` separators or
  // `C:\...` drive letters. POSIX consumers should treat these as
  // malformed — they could let an unwary extractor write to unusual
  // locations (the Windows path becomes a single Linux filename
  // containing `\`, which is legal-but-surprising). Reject.
  it('rejects entries with backslash separators', () => {
    const tar = tarWithEntry('outputs\\foo\\bar.txt', new TextEncoder().encode('x'))
    expect(() => parseTarHeaders(tar)).toThrow(/windows|backslash|unsafe/i)
  })

  it('rejects entries with Windows drive-letter prefix', () => {
    const tar = tarWithEntry('C:/Users/admin/evil.txt', new TextEncoder().encode('x'))
    expect(() => parseTarHeaders(tar)).toThrow(/windows|drive|unsafe/i)
  })

  it('rejects entries with Windows extended-length prefix', () => {
    const tar = tarWithEntry('//?/C:/evil', new TextEncoder().encode('x'))
    // The `//` empty-component check catches this; verify the path
    // here AS WELL — defense in depth.
    expect(() => parseTarHeaders(tar)).toThrow(/escape|empty|windows|unsafe/i)
  })
})

describe('parseTarHeaders — pathological lengths', () => {
  it('handles ustar paths up to 100 chars without crashing', () => {
    // ustar name field is 100 bytes. Test the boundary.
    const longName = 'outputs/' + 'a'.repeat(91) // 100 chars total
    const tar = tarWithEntry(longName, new TextEncoder().encode('x'))
    const headers = parseTarHeaders(tar)
    expect(headers.length).toBe(1)
    expect(headers[0]?.name).toBe(longName)
  })

  it('handles GNU longname extension for paths > 100 chars', () => {
    // GNU longname: a typeflag 'L' record with the full path in its
    // body, followed by the real header (which may truncate at 100).
    // parseTarHeaders already supports this — pin the round-trip.
    const longName = 'outputs/' + 'a'.repeat(200) + '/file.txt'
    const longNameBytes = new TextEncoder().encode(longName + '\0')
    const tar = concatTar([
      makeHeader({ name: '././@LongLink', size: longNameBytes.length, typeFlag: 'L' }),
      makeDataBlock(longNameBytes),
      makeHeader({
        name: longName.slice(0, 100), // truncated in the regular header
        size: 1,
        typeFlag: '0',
      }),
      makeDataBlock(new TextEncoder().encode('x')),
      EOF_BLOCKS,
    ])
    const headers = parseTarHeaders(tar)
    expect(headers.length).toBe(1)
    expect(headers[0]?.name).toBe(longName)
  })

  it('joins the ustar `prefix` field with `name` for paths > 100 bytes', () => {
    // POSIX ustar splits a long name across prefix + name. Reading only
    // `name` yields the bare basename — which no longer starts with
    // `outputs/`, so the entry is invisible to the restore AND to the
    // output_files index: a silently INCOMPLETE cache hit that never
    // self-heals, because the truncated expectation matches the truncated
    // tree forever.
    const prefix = 'outputs/packages/design-system-components/dist/esm/react/primitives/button'
    const base = 'index.esm.production.min.js'
    expect(Buffer.byteLength(`${prefix}/${base}`)).toBeGreaterThan(100)
    const tar = concatTar([
      makeHeader({ name: base, size: 1, typeFlag: '0', prefix }),
      makeDataBlock(new TextEncoder().encode('x')),
      EOF_BLOCKS,
    ])
    const headers = parseTarHeaders(tar)
    expect(headers.length).toBe(1)
    expect(headers[0]?.name).toBe(`${prefix}/${base}`)
  })

  it('does NOT read bytes 345+ as a prefix on a GNU-format header', () => {
    // GNU headers reuse 345.. for atime/ctime. Reading them as a prefix
    // would fabricate a garbage parent directory for every GNU entry — so
    // the prefix read is gated on the POSIX magic, and this pins the gate.
    const tar = concatTar([
      makeHeader({
        name: 'outputs/app.js',
        size: 1,
        typeFlag: '0',
        magic: 'ustar  \0',
        tail: '00000000000 00000000000 ',
      }),
      makeDataBlock(new TextEncoder().encode('x')),
      EOF_BLOCKS,
    ])
    const headers = parseTarHeaders(tar)
    expect(headers.length).toBe(1)
    expect(headers[0]?.name).toBe('outputs/app.js')
  })
})

describe('parseTarHeaders — truncated archive', () => {
  it('rejects an entry whose declared size runs past the end of the archive', () => {
    // `subarray` CLAMPS, so an oversized `size` yields a short, NUL-padded
    // body — WRONG file content installed and reported as a cache hit,
    // instead of degrading to a miss. Exactly the threat model the trust
    // scopes exist for.
    const tar = concatTar([
      makeHeader({ name: 'outputs/truncated.js', size: 4096, typeFlag: '0' }),
      makeDataBlock(new TextEncoder().encode('REAL-BYTES')),
      EOF_BLOCKS,
    ])
    expect(() => parseTarHeaders(tar)).toThrow(/ends early|truncated/i)
  })

  it('accepts an entry whose data is fully present (control)', () => {
    const body = new TextEncoder().encode('REAL-BYTES')
    const tar = concatTar([
      makeHeader({ name: 'outputs/whole.js', size: body.length, typeFlag: '0' }),
      makeDataBlock(body),
      EOF_BLOCKS,
    ])
    const headers = parseTarHeaders(tar)
    expect(headers.length).toBe(1)
    expect(headers[0]?.size).toBe(body.length)
  })
})

describe('extractOutputs — mixed valid + malicious entries', () => {
  let dest: string

  beforeEach(async () => {
    dest = await mkdtemp(path.join(os.tmpdir(), 'vx-tar-mixed-'))
  })

  afterEach(async () => {
    await rm(dest, { recursive: true, force: true })
  })

  it('rejects the WHOLE archive when any entry is malicious (no partial extract)', async () => {
    // First a benign entry, then a malicious one. The current parser
    // throws at parse time when it hits the bad entry. We assert
    // neither the benign nor the malicious file lands on disk —
    // partial extracts are a TOCTOU escape vector.
    const tar = concatTar([
      makeHeader({ name: 'outputs/good.txt', size: 3, typeFlag: '0' }),
      makeDataBlock(new TextEncoder().encode('ok\n')),
      makeHeader({ name: 'outputs/../evil.txt', size: 4, typeFlag: '0' }),
      makeDataBlock(new TextEncoder().encode('bad\n')),
      EOF_BLOCKS,
    ])
    await expect(extractOutputs(tar, dest)).rejects.toThrow(/escape|traversal|unsafe/i)
    expect(existsSync(path.join(dest, 'good.txt'))).toBe(false)
    expect(existsSync(path.join(dest, '..', 'evil.txt'))).toBe(false)
  })
})

describe('extractOutputs — concurrent restores to the same anchor', () => {
  let dest: string

  beforeEach(async () => {
    dest = await mkdtemp(path.join(os.tmpdir(), 'vx-tar-conc-'))
  })

  afterEach(async () => {
    await rm(dest, { recursive: true, force: true })
  })

  it('two parallel extracts of the same payload produce a consistent tree', async () => {
    // Same payload, two extractors racing on the same destination.
    // Either writer's bytes are fine (identical content), but the
    // final on-disk state must be a complete valid tree — not a
    // truncated file from one extractor's in-flight write being
    // overwritten by the other's open-truncate.
    const body = new TextEncoder().encode('payload-payload-payload\n')
    const tar = tarWithEntry('outputs/concurrent.txt', body)
    await Promise.all([extractOutputs(tar, dest), extractOutputs(tar, dest)])
    const restored = await readFile(path.join(dest, 'concurrent.txt'))
    expect(restored).toEqual(Buffer.from(body))
  })
})

describe('extractOutputs — sequential restores: symlink → real directory transition', () => {
  let dest: string

  beforeEach(async () => {
    dest = await mkdtemp(path.join(os.tmpdir(), 'vx-tar-seq-'))
  })

  afterEach(async () => {
    await rm(dest, { recursive: true, force: true })
  })

  it('a real file replaces a pre-existing symlink at the same target', async () => {
    // Setup: pre-existing symlink at <dest>/x.txt (residue from a
    // user-edited project or previous restore that included one).
    // The TOCTOU defense added earlier unlinks the symlink before
    // writing, so the second restore must produce a real file
    // (not following the link to clobber its target).
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'vx-tar-seq-target-'))
    const elsewhereFile = path.join(elsewhere, 'unrelated.txt')
    await writeFile(elsewhereFile, 'unrelated')
    await symlink(elsewhereFile, path.join(dest, 'x.txt'))

    const tar = tarWithEntry('outputs/x.txt', new TextEncoder().encode('fresh'))
    await extractOutputs(tar, dest)
    // The link is gone; x.txt is a real file with the new content.
    const real = await readFile(path.join(dest, 'x.txt'), 'utf8')
    expect(real).toBe('fresh')
    // The link's former target is untouched.
    expect(await readFile(elsewhereFile, 'utf8')).toBe('unrelated')
    await rm(elsewhere, { recursive: true, force: true })
  })
})
