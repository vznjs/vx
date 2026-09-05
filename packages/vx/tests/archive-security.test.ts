// Artifact restore security tests — adapted from Turborepo's
// cache_archive/restore.rs threat model. Each test builds a malicious
// archive in memory and asserts the reader/extractor REJECTS it instead
// of writing files outside the destination dir.
//
// The bug class these protect against is "zip slip" / "tar slip": an
// attacker controls a cache artifact (e.g. via a poisoned remote cache
// or a stale local entry whose contents were tampered with) and uses a
// crafted entry name like `outputs/../../escape.txt` or
// `outputs//etc/passwd` to write outside the project dir.
//
// The container is `Bun.Archive` (libarchive), so tar DIALECT handling —
// long names, PAX records, truncation — is no longer vx's code and is
// pinned in cache-baseline.test.ts. What is pinned HERE is what
// libarchive cannot decide for vx: where an entry may land on disk.
// Hostile fixtures are still hand-built byte by byte, because a writer
// that refuses to emit the attack cannot produce the input under test.

import { existsSync } from 'node:fs'
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { extractArtifactStream, packArtifact, scanArtifact } from '../src/cache/archive.js'
import { streamOf } from './helpers/stream.js'

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
  enc.encodeInto('ustar\0' + '00', buf.subarray(257, 265))
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

/** The composition the cache uses, over odd-sized chunks so entry boundaries never line up. */
async function restore(bytes: Uint8Array, dest: string, wsDest?: string): Promise<void> {
  await extractArtifactStream(streamOf(bytes), dest, wsDest)
}

const scan = (bytes: Uint8Array) => scanArtifact(streamOf(bytes))

// ─── Tests ──────────────────────────────────────────────────────────

describe('archive restore — path-traversal defense', () => {
  let dest: string
  let scratch: string

  beforeEach(async () => {
    dest = await mkdtemp(path.join(os.tmpdir(), 'vx-arc-sec-'))
    scratch = await mkdtemp(path.join(os.tmpdir(), 'vx-arc-scratch-'))
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
    const bytes = await packArtifact({
      stdout: '',
      outputs: new Map([
        ['workspace-outputs/gen/root.txt', await scratchFile(scratch, 'generated')],
      ]),
    })

    await restore(bytes, dest, wsDest)
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

    await expect(restore(tar, dest, path.join(dest, 'ws'))).rejects.toThrow(/symlinked parent/i)
    expect(existsSync(path.join(outside, 'x.txt'))).toBe(false)
  })

  it('rejects entry with `..` segment (outputs/../escape.txt)', async () => {
    const body = new TextEncoder().encode('pwned')
    const tar = tarWithEntry('outputs/../escape.txt', body)
    await expect(restore(tar, dest)).rejects.toThrow(/escape|traversal|unsafe/i)
    // Nothing should land outside dest.
    expect(existsSync(path.join(dest, '..', 'escape.txt'))).toBe(false)
  })

  it('rejects entry with double `..` (outputs/../../escape.txt)', async () => {
    const body = new TextEncoder().encode('pwned')
    const tar = tarWithEntry('outputs/../../escape.txt', body)
    await expect(restore(tar, dest)).rejects.toThrow(/escape|traversal|unsafe/i)
  })

  it('rejects entry with embedded `..` segment (outputs/foo/../../escape.txt)', async () => {
    const body = new TextEncoder().encode('pwned')
    const tar = tarWithEntry('outputs/foo/../../escape.txt', body)
    await expect(restore(tar, dest)).rejects.toThrow(/escape|traversal|unsafe/i)
  })

  it('rejects absolute path entry (outputs//etc/passwd)', async () => {
    // The leading slash after `outputs/` makes the slice an absolute
    // path. path.join(destDir, '/etc/passwd') collapses to relative,
    // but path.resolve would not — defense in depth.
    const body = new TextEncoder().encode('shadow')
    const tar = tarWithEntry('outputs//etc/passwd', body)
    await expect(restore(tar, dest)).rejects.toThrow(/escape|absolute|empty|unsafe/i)
  })

  it('truncates an entry name at its null byte instead of honoring the tail', async () => {
    // Null byte truncation: an attacker prepends `safe.txt\0../../evil`
    // hoping the reader treats it as `safe.txt` but the FS APIs see the
    // full string. The name field is null-terminated, so the honest read
    // stops at the first null — pinned here so a future reader that
    // starts honoring post-null bytes fails loudly.
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
    enc.encodeInto('ustar\0' + '00', buf.subarray(257, 265))
    let cksum = 0
    for (let i = 0; i < 512; i++) cksum += buf[i]!
    enc.encodeInto(octal(cksum, 7), buf.subarray(148, 155))
    buf[155] = 0x20

    const body = new TextEncoder().encode('hello')
    const tar = concatTar([buf, makeDataBlock(body), EOF_BLOCKS])
    await restore(tar, dest)
    expect(existsSync(path.join(dest, 'safe.txt'))).toBe(true)
    expect(existsSync(path.join(dest, '..', 'evil'))).toBe(false)
    expect(existsSync(path.join(dest, 'evil'))).toBe(false)
  })

  it('extracts a benign entry into destDir (sanity)', async () => {
    const body = new TextEncoder().encode('ok')
    const tar = tarWithEntry('outputs/hello.txt', body)
    await restore(tar, dest)
    expect(await readFile(path.join(dest, 'hello.txt'), 'utf8')).toBe('ok')
  })

  it('rejects entry with leading slash on name (after outputs/ strip)', async () => {
    const body = new TextEncoder().encode('x')
    const tar = tarWithEntry('outputs//absolute.txt', body)
    await expect(restore(tar, dest)).rejects.toThrow(/escape|absolute|empty|unsafe/i)
  })

  it('ignores an entry whose resolved path is destDir itself', async () => {
    // An entry that resolves exactly to destDir (without a basename)
    // would clobber the directory. Empty rel after the strip → no file
    // to write; a no-op, not a crash.
    const tar = tarWithEntry('outputs/', new Uint8Array(0))
    await restore(tar, dest)
  })
})

describe('archive restore — symlink defense', () => {
  let dest: string

  beforeEach(async () => {
    dest = await mkdtemp(path.join(os.tmpdir(), 'vx-arc-sym-'))
  })

  afterEach(async () => {
    await rm(dest, { recursive: true, force: true })
  })

  it('pre-existing symlink in destination is not followed (TOCTOU defense)', async () => {
    // Setup: an attacker has placed a symlink at <dest>/link.txt that
    // points to a sensitive file outside dest. A naive extractor that
    // writes through the symlink would clobber the target.
    const sensitiveDir = await mkdtemp(path.join(os.tmpdir(), 'vx-arc-sym-target-'))
    const sensitive = path.join(sensitiveDir, 'untouched.txt')
    await writeFile(sensitive, 'do-not-touch')
    await symlink(sensitive, path.join(dest, 'link.txt'))

    const body = new TextEncoder().encode('attacker-controlled')
    const tar = tarWithEntry('outputs/link.txt', body)
    try {
      await restore(tar, dest)
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
    // under dest, but writing it would follow the symlink and escape.
    const sensitiveDir = await mkdtemp(path.join(os.tmpdir(), 'vx-arc-sym-pdir-'))
    await symlink(sensitiveDir, path.join(dest, 'dist'))

    const body = new TextEncoder().encode('attacker-controlled')
    const tar = tarWithEntry('outputs/dist/evil.txt', body)
    await expect(restore(tar, dest)).rejects.toThrow(/escape|symlink|unsafe/i)
    expect(existsSync(path.join(sensitiveDir, 'evil.txt'))).toBe(false)
    await rm(sensitiveDir, { recursive: true, force: true })
  })

  it('a DEEP entry under a symlinked parent is refused (ancestor walk)', async () => {
    // The escaping segment is the symlink `dist`, but the entry names a
    // deeper path whose immediate parent does NOT exist yet — so checking
    // only the immediate parent would pass and mkdir(recursive) would build
    // the whole chain inside the symlink target.
    const sensitiveDir = await mkdtemp(path.join(os.tmpdir(), 'vx-arc-sym-deep-'))
    await symlink(sensitiveDir, path.join(dest, 'dist'))

    const tar = tarWithEntry('outputs/dist/a/b/c.txt', new TextEncoder().encode('x'))
    await expect(restore(tar, dest)).rejects.toThrow(/escape|symlink|unsafe/i)
    expect(existsSync(path.join(sensitiveDir, 'a'))).toBe(false)
    await rm(sensitiveDir, { recursive: true, force: true })
  })

  it('a real file replaces a pre-existing symlink at the same target', async () => {
    // Residue from a user-edited project or a previous restore. The
    // TOCTOU defense unlinks the symlink before writing, so the restore
    // produces a real file instead of following the link.
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'vx-arc-seq-target-'))
    const elsewhereFile = path.join(elsewhere, 'unrelated.txt')
    await writeFile(elsewhereFile, 'unrelated')
    await symlink(elsewhereFile, path.join(dest, 'x.txt'))

    const tar = tarWithEntry('outputs/x.txt', new TextEncoder().encode('fresh'))
    await restore(tar, dest)
    expect(await readFile(path.join(dest, 'x.txt'), 'utf8')).toBe('fresh')
    expect(await readFile(elsewhereFile, 'utf8')).toBe('unrelated')
    await rm(elsewhere, { recursive: true, force: true })
  })
})

describe('archive restore — non-regular entries are never materialized', () => {
  // Build outputs are regular files. Symlinks (typeflag 2), hardlinks
  // (1), devices (3/4), FIFOs (6) and contiguous files (7) are not
  // surfaced by `Bun.Archive.files()` at all, so an artifact that
  // smuggles one cannot act on it — the entry simply does not exist as
  // far as the restore is concerned. (The previous hand-rolled reader
  // threw on these; being unable to see them is the stronger property,
  // but the pin has to assert the outcome rather than the throw.)
  let dest: string

  beforeEach(async () => {
    dest = await mkdtemp(path.join(os.tmpdir(), 'vx-arc-flag-'))
  })

  afterEach(async () => {
    await rm(dest, { recursive: true, force: true })
  })

  const SMUGGLED: Array<{ label: string; typeFlag: string; linkname?: string }> = [
    { label: 'symlink to an absolute path', typeFlag: '2', linkname: '/etc/passwd' },
    { label: 'symlink escaping the anchor', typeFlag: '2', linkname: '../../etc/passwd' },
    { label: 'hardlink', typeFlag: '1', linkname: '/etc/passwd' },
    { label: 'character device', typeFlag: '3' },
    { label: 'block device', typeFlag: '4' },
    { label: 'fifo', typeFlag: '6' },
  ]

  for (const { label, typeFlag, linkname } of SMUGGLED) {
    it(`ignores a ${label} (typeflag '${typeFlag}')`, async () => {
      const tar = concatTar([
        makeHeader({
          name: 'outputs/smuggled',
          size: 0,
          typeFlag,
          ...(linkname ? { linkname } : {}),
        }),
        EOF_BLOCKS,
      ])
      expect((await scan(tar)).entries).toEqual([])
      await restore(tar, dest)
      expect(existsSync(path.join(dest, 'smuggled'))).toBe(false)
    })
  }

  it('a directory-only archive materializes nothing (outputs are files)', async () => {
    // Declared outputs are globbed FILES, so an empty directory was never
    // part of the restored contract; directory records are not surfaced.
    const tar = concatTar([
      makeHeader({ name: 'outputs/dist/nested/', size: 0, typeFlag: '5', mode: 0o755 }),
      EOF_BLOCKS,
    ])
    await restore(tar, dest)
    expect(existsSync(path.join(dest, 'dist', 'nested'))).toBe(false)
  })
})

describe('name rejections', () => {
  let dest: string

  beforeEach(async () => {
    dest = await mkdtemp(path.join(os.tmpdir(), 'vx-arc-names-'))
  })

  afterEach(async () => {
    await rm(dest, { recursive: true, force: true })
  })

  it('rejects a name containing a `..` segment', async () => {
    await expect(restore(tarWithEntry('outputs/../evil', new Uint8Array(1)), dest)).rejects.toThrow(
      /escape|traversal|unsafe/i,
    )
  })

  it('rejects an absolute name', async () => {
    await expect(restore(tarWithEntry('/etc/passwd', new Uint8Array(1)), dest)).rejects.toThrow(
      /escape|absolute|unsafe/i,
    )
  })

  it('rejects backslash separators', async () => {
    // A producer on Windows might emit `\` separators or a `C:\...`
    // drive letter. On POSIX those become one legal-but-surprising
    // filename; refuse rather than materialize it.
    await expect(
      restore(tarWithEntry('outputs\\foo\\bar.txt', new Uint8Array(1)), dest),
    ).rejects.toThrow(/windows|backslash|unsafe/i)
  })

  it('rejects a Windows drive-letter prefix', async () => {
    await expect(
      restore(tarWithEntry('C:/Users/admin/evil.txt', new Uint8Array(1)), dest),
    ).rejects.toThrow(/windows|drive|unsafe/i)
  })

  it('rejects a Windows extended-length prefix', async () => {
    await expect(restore(tarWithEntry('//?/C:/evil', new Uint8Array(1)), dest)).rejects.toThrow(
      /escape|empty|windows|absolute|unsafe/i,
    )
  })

  it('rejects a truncated archive rather than serving short bytes', async () => {
    // A clamped read would install a short, NUL-padded body as a cache
    // HIT instead of degrading to a miss.
    const tar = concatTar([
      makeHeader({ name: 'outputs/truncated.js', size: 4096, typeFlag: '0' }),
      makeDataBlock(new TextEncoder().encode('REAL-BYTES')),
      EOF_BLOCKS,
    ])
    await expect(restore(tar, dest)).rejects.toThrow(/truncat|ends inside/i)
    expect(existsSync(path.join(dest, 'truncated.js'))).toBe(false)
  })

  it('accepts an entry whose data is fully present (control)', async () => {
    const body = new TextEncoder().encode('REAL-BYTES')
    await restore(
      concatTar([
        makeHeader({ name: 'outputs/whole.js', size: body.length, typeFlag: '0' }),
        makeDataBlock(body),
        EOF_BLOCKS,
      ]),
      dest,
    )
    expect(await readFile(path.join(dest, 'whole.js'))).toEqual(Buffer.from(body))
  })
})

describe('archive restore — mixed valid + malicious entries', () => {
  let dest: string

  beforeEach(async () => {
    dest = await mkdtemp(path.join(os.tmpdir(), 'vx-arc-mixed-'))
  })

  afterEach(async () => {
    await rm(dest, { recursive: true, force: true })
  })

  it('rejects the WHOLE archive when any entry is malicious (no partial extract)', async () => {
    // A partial extract is a TOCTOU escape vector: neither the benign
    // nor the malicious file may land.
    const tar = concatTar([
      makeHeader({ name: 'outputs/good.txt', size: 3, typeFlag: '0' }),
      makeDataBlock(new TextEncoder().encode('ok\n')),
      makeHeader({ name: 'outputs/../evil.txt', size: 4, typeFlag: '0' }),
      makeDataBlock(new TextEncoder().encode('bad\n')),
      EOF_BLOCKS,
    ])
    await expect(restore(tar, dest)).rejects.toThrow(/escape|traversal|unsafe/i)
    expect(existsSync(path.join(dest, 'good.txt'))).toBe(false)
    expect(existsSync(path.join(dest, '..', 'evil.txt'))).toBe(false)
  })

  it('abort prunes the empty directories it created but leaves one a concurrent writer filled', async () => {
    // Entry 1 lands under a fresh `dist/new/`; entry 2 is a traversal, so
    // the archive is rejected after entry 1 was staged. Between the two,
    // another process writes into `dist/new/` — the abort must remove the
    // staged temp and the directories it created ONLY while they are
    // empty, never a neighbour's file. The control (no concurrent writer)
    // pins that the whole created chain is pruned.
    const tar = concatTar([
      makeHeader({ name: 'outputs/dist/new/a.txt', size: 3, typeFlag: '0' }),
      makeDataBlock(new TextEncoder().encode('ok\n')),
      makeHeader({ name: 'outputs/../evil.txt', size: 4, typeFlag: '0' }),
      makeDataBlock(new TextEncoder().encode('bad\n')),
      EOF_BLOCKS,
    ])
    const withWriter = (plant: boolean): ReadableStream<Uint8Array> => {
      let sent = 0
      return new ReadableStream({
        async pull(c) {
          if (sent === 0) {
            c.enqueue(tar.subarray(0, 1024)) // entry 1, header + body
          } else if (sent === 1) {
            // A stream pulls ahead of its consumer, so wait for the
            // extractor to have created entry 1's directory, then a
            // neighbour appears in it before entry 2 is delivered.
            if (plant) {
              const dir = path.join(dest, 'dist/new')
              for (let i = 0; !existsSync(dir) && i < 2000; i++) await Bun.sleep(1)
              await writeFile(path.join(dir, 'keep.txt'), 'theirs')
            }
            c.enqueue(tar.subarray(1024))
          } else {
            c.close()
          }
          sent++
        },
      })
    }
    await expect(extractArtifactStream(withWriter(true), dest, undefined)).rejects.toThrow(
      /escape|traversal|unsafe/i,
    )
    expect(await readFile(path.join(dest, 'dist/new/keep.txt'), 'utf8')).toBe('theirs')
    expect(await readdir(path.join(dest, 'dist/new'))).toEqual(['keep.txt']) // no a.txt, no temp
    await rm(path.join(dest, 'dist'), { recursive: true, force: true })

    await expect(extractArtifactStream(withWriter(false), dest, undefined)).rejects.toThrow(
      /escape|traversal|unsafe/i,
    )
    expect(await readdir(dest)).toEqual([]) // CONTROL: the created chain is pruned

    // A pre-existing sibling whose name shares the created directory's
    // prefix (`dist2` beside a created `dist`) is not the chain's.
    await mkdir(path.join(dest, 'dist2'))
    await writeFile(path.join(dest, 'dist2', 'keep.txt'), 'theirs')
    await expect(extractArtifactStream(withWriter(false), dest, undefined)).rejects.toThrow(
      /escape|traversal|unsafe/i,
    )
    expect(await readdir(dest)).toEqual(['dist2'])
    expect(await readFile(path.join(dest, 'dist2', 'keep.txt'), 'utf8')).toBe('theirs')
  })

  it('a pax `path` record that renames a benign header to a traversal is refused', async () => {
    // The ustar name field is clean; the pax extended header (what a
    // producer emits for a long path) overrides it. The check must see
    // the name the entry would actually land under.
    const pax = new TextEncoder().encode('28 path=outputs/../evil.txt\n')
    const tar = concatTar([
      makeHeader({ name: 'PaxHeaders/benign', size: pax.length, typeFlag: 'x' }),
      makeDataBlock(pax),
      makeHeader({ name: 'outputs/benign.txt', size: 4, typeFlag: '0' }),
      makeDataBlock(new TextEncoder().encode('bad\n')),
      EOF_BLOCKS,
    ])
    await expect(restore(tar, dest)).rejects.toThrow(/escape|traversal|unsafe/i)
    expect(existsSync(path.join(dest, '..', 'evil.txt'))).toBe(false)
    expect(existsSync(path.join(dest, 'benign.txt'))).toBe(false)
  })

  it('a containment failure anywhere writes NOTHING, even for benign siblings', async () => {
    // Containment is proven for every entry before any is written, so a
    // symlinked-parent escape on one entry cannot leave its neighbours
    // half-restored.
    const sensitiveDir = await mkdtemp(path.join(os.tmpdir(), 'vx-arc-mixed-sym-'))
    await symlink(sensitiveDir, path.join(dest, 'dist'))
    const tar = concatTar([
      makeHeader({ name: 'outputs/fine.txt', size: 3, typeFlag: '0' }),
      makeDataBlock(new TextEncoder().encode('ok\n')),
      makeHeader({ name: 'outputs/dist/evil.txt', size: 4, typeFlag: '0' }),
      makeDataBlock(new TextEncoder().encode('bad\n')),
      EOF_BLOCKS,
    ])
    await expect(restore(tar, dest)).rejects.toThrow(/escape|symlink|unsafe/i)
    expect(existsSync(path.join(dest, 'fine.txt'))).toBe(false)
    expect(existsSync(path.join(sensitiveDir, 'evil.txt'))).toBe(false)
    await rm(sensitiveDir, { recursive: true, force: true })
  })
})
describe('archive restore — concurrent restores to the same anchor', () => {
  let dest: string

  beforeEach(async () => {
    dest = await mkdtemp(path.join(os.tmpdir(), 'vx-arc-conc-'))
  })

  afterEach(async () => {
    await rm(dest, { recursive: true, force: true })
  })

  it('two parallel extracts of the same payload produce a consistent tree', async () => {
    // A regression guard, and honestly a weak one: this loop did NOT
    // reproduce the pre-fix failure locally in 3 x 400 rounds, though a
    // loaded darwin CI runner hit it in a single round. The measured
    // differential lives in the decision log instead (a standalone probe:
    // 3/400 ENOENT with the unlink-then-write, 0/400 with the rename,
    // 0/400 with the symlink-only unlink that predates it). The
    // failure mode was an unlink-then-write leaving the target momentarily
    // ABSENT, so the other extract's chmod hit ENOENT; the write is a
    // rename now, and rename never leaves a gap.
    const body = new TextEncoder().encode('payload-payload-payload\n')
    const tar = tarWithEntry('outputs/concurrent.txt', body)
    for (let i = 0; i < 400; i++) {
      // Both restores begin on the same tick; the reader streams, so
      // nothing is parsed ahead of the first write.
      await Promise.all([restore(tar, dest), restore(tar, dest)])
      const restored = await readFile(path.join(dest, 'concurrent.txt'))
      expect(restored).toEqual(Buffer.from(body))
    }
    // …and no scratch file survived to be swept into the next artifact.
    const leftovers = [...new Bun.Glob('**/*.vx-tmp-*').scanSync({ cwd: dest })]
    expect(leftovers).toEqual([])
    // 400 rounds run ~2 s idle and past the 5 s default under the ubuntu
    // gate's four parallel shards (red main, 2026-09-03); the bound is the
    // rounds, not the clock.
  }, 30_000)
})

describe('packArtifact → restore round trip', () => {
  let src: string
  let dest: string

  beforeEach(async () => {
    src = await mkdtemp(path.join(os.tmpdir(), 'vx-arc-rt-src-'))
    dest = await mkdtemp(path.join(os.tmpdir(), 'vx-arc-rt-dst-'))
  })

  afterEach(async () => {
    await rm(src, { recursive: true, force: true })
    await rm(dest, { recursive: true, force: true })
  })

  it('carries the executable bit and the millisecond mtime', async () => {
    // The v25 class: a lost executable bit builds cold and breaks warm.
    // Neither mode nor mtime is expressible through `Bun.Archive`'s entry
    // map, so both ride the `.vx-meta.json` sidecar — this is the pin
    // that the sidecar is actually consulted on the way back out.
    const exe = path.join(src, 'run.sh')
    await writeFile(exe, '#!/bin/sh\necho hi\n')
    await Bun.$`chmod 755 ${exe}`.quiet()
    const plain = path.join(src, 'data.txt')
    await writeFile(plain, 'data')

    const srcExe = await stat(exe)
    const bytes = await packArtifact({
      stdout: 'log',
      outputs: new Map([
        ['outputs/run.sh', exe],
        ['outputs/data.txt', plain],
      ]),
    })
    await restore(bytes, dest)

    const outExe = await stat(path.join(dest, 'run.sh'))
    expect(outExe.mode & 0o777).toBe(0o755)
    const srcPlain = await stat(plain)
    expect((await stat(path.join(dest, 'data.txt'))).mode & 0o777).toBe(srcPlain.mode & 0o777)
    // Millisecond fidelity: the restored stamp equals the packed one, so
    // `isOutputsCurrent` compares equal instead of restoring forever.
    expect(Math.abs(outExe.mtimeMs - Math.floor(srcExe.mtimeMs))).toBeLessThan(1)
  })

  it('round-trips a path longer than 100 bytes and a >100-byte component', async () => {
    // ustar splits a >100-byte name across prefix+name and REFUSES a
    // single component over 100 bytes outright — the reason vx had to
    // pin a tar dialect at all. libarchive picks an encoding that fits;
    // what vx pins is that the name comes back byte-identical.
    const longComponent = 'c'.repeat(140) + '.js'
    const deepRel = path.join('a'.repeat(60), 'b'.repeat(60), longComponent)
    const abs = path.join(src, deepRel)
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, 'long')
    expect(Buffer.byteLength(deepRel)).toBeGreaterThan(100)

    const bytes = await packArtifact({
      stdout: '',
      outputs: new Map([[`outputs/${deepRel}`, abs]]),
    })
    const { entries } = await scan(bytes)
    expect(entries.map((e) => e.name).sort()).toEqual([`outputs/${deepRel}`, 'stdout'].sort())

    await restore(bytes, dest)
    expect(await readFile(path.join(dest, deepRel), 'utf8')).toBe('long')
  })
})

/** Write a file with `content` into `dir` and return its absolute path. */
async function scratchFile(dir: string, content: string): Promise<string> {
  const p = path.join(dir, `src-${content.length}-${content.slice(0, 4)}.txt`)
  await writeFile(p, content)
  return p
}

describe('pre-planted links at the extraction target', () => {
  it('a HARDLINK at the target is broken, not truncated through', async () => {
    // The symlink defense's own threat model, minus the link-shaped tell:
    // `Bun.write` truncates a hardlink's shared inode in place, so writing
    // "through" an attacker-planted hardlink replaces the linked file's
    // content everywhere it is linked. The target must be unlinked first —
    // which breaks the link — and the linked-to file must keep its bytes.
    const d = await mkdtemp(path.join(os.tmpdir(), 'vx-hardlink-'))
    try {
      const secret = path.join(d, 'secret.txt')
      await writeFile(secret, 'PRECIOUS')
      const dest = path.join(d, 'proj')
      await mkdir(dest, { recursive: true })
      await link(secret, path.join(dest, 'out.txt'))
      const src = path.join(d, 'src-out.txt')
      await writeFile(src, 'ARTIFACT-BYTES')
      const bytes = await packArtifact({
        stdout: '',
        outputs: new Map([['outputs/out.txt', src]]),
      })
      await restore(bytes, dest)
      expect(await readFile(secret, 'utf8')).toBe('PRECIOUS')
      expect(await readFile(path.join(dest, 'out.txt'), 'utf8')).toBe('ARTIFACT-BYTES')
    } finally {
      await rm(d, { recursive: true, force: true })
    }
  })

  it('a corrupt sidecar surfaces as a parse failure, never a partial read', async () => {
    // vx-eb's unexecuted probe #2, executed: a sidecar that is present but
    // not JSON throws out of the scan (cache.ts wraps every
    // non-security throw in CorruptArtifactError → the re-run path).
    const d = await mkdtemp(path.join(os.tmpdir(), 'vx-sidecar-'))
    try {
      const src = path.join(d, 'x.txt')
      await writeFile(src, 'x')
      const good = await packArtifact({ stdout: 's', outputs: new Map([['outputs/x.txt', src]]) })
      const files = await new Bun.Archive(good).files()
      const entries: Record<string, Uint8Array | string> = {}
      for (const [n, f] of files) entries[n] = new Uint8Array(await f.arrayBuffer())
      entries['.vx-meta.json'] = 'NOT JSON {{{'
      const evil = await new Bun.Archive(entries).bytes()
      await expect(scan(evil)).rejects.toThrow()
    } finally {
      await rm(d, { recursive: true, force: true })
    }
  })
})
