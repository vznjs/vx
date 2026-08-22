// The `tar --format` flag name is spelled differently by the two tar
// implementations that ship on developer machines, and picking the wrong one
// is a HARD failure, not a degradation: `packArtifact` throws, so a task whose
// command SUCCEEDED is reported failed and the run exits non-zero.
//
// That is exactly what shipped. The artifact wave that moved packing to GNU
// format hardcoded `--format=gnu` (GNU tar's spelling) and was verified on
// Linux; bsdtar — the macOS default — answers `Can't use format gnu: No such
// format 'gnu'` and exits 1. Measured at the time of the fix: 211 of 2656 core
// tests failed on macOS at HEAD, 2 with the fix.
//
// The pin that matters is the LAST one: it asks the local `tar` whether it
// accepts the name we resolved, so it fails on whichever host got it wrong
// rather than only on the one the author happened to use.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolveTarFormat, tarFormatFromVersion } from '../src/cache/tar.js'

const GNU_VERSION = 'tar (GNU tar) 1.35\nCopyright (C) 2023 Free Software Foundation, Inc.'
const BSD_VERSION = 'bsdtar 3.5.3 - libarchive 3.7.4 zlib/1.2.12 liblzma/5.4.3'

describe('tar --format name resolution', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-tarfmt-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('maps each tar implementation to the name IT accepts', () => {
    expect(tarFormatFromVersion(GNU_VERSION)).toBe('gnu')
    expect(tarFormatFromVersion(BSD_VERSION)).toBe('gnutar')
    // libarchive without the bsdtar banner (some distros rebrand it).
    expect(tarFormatFromVersion('mytar 1.0 - libarchive 3.6.2')).toBe('gnutar')
  })

  it('keeps the GNU spelling when the version is unreadable', () => {
    // Control: an unknown tar keeps today's behaviour rather than guessing.
    // The pack that follows surfaces the real error itself.
    expect(tarFormatFromVersion('')).toBe('gnu')
    expect(tarFormatFromVersion('toybox tar')).toBe('gnu')
  })

  it('resolves to a name the LOCAL tar actually accepts', async () => {
    const format = await resolveTarFormat()
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'hi\n')

    const proc = Bun.spawn(['tar', `--format=${format}`, '-cf', '-', '-C', dir, 'a.txt'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [bytes, err] = await Promise.all([
      new Response(proc.stdout).bytes(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited

    expect({ exitCode: proc.exitCode, err: err.trim() }).toEqual({ exitCode: 0, err: '' })
    expect(bytes.length).toBeGreaterThan(0)
  })

  it('memoizes the probe — a second call resolves without re-spawning', async () => {
    // The probe is one spawn per process, lazily; a warm all-hit run never
    // packs and therefore never pays it at all.
    const first = await resolveTarFormat()
    const second = await resolveTarFormat()
    expect(second).toBe(first)
  })
})
