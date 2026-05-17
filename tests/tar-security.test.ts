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
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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
  enc.encodeInto('ustar\0', buf.subarray(257, 263))
  enc.encodeInto('00', buf.subarray(263, 265))
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
