// A TRIPWIRE on the Bun API the v27 artifact container sits on, not a test of
// vx code.
//
// The recorded open item is that a v27 restore holds the decompressed archive
// AND a copy of every entry at once, because `files()` hands back File objects
// that own their bytes. `extract()` is the streaming path that would fix it,
// and the reason we do not use it is a CAPABILITY claim about Bun — exactly
// the kind of claim that rots silently when the dependency moves. So it is
// asserted here: when Bun gains what is missing, THIS FILE FAILS and the open
// item can be closed on evidence instead of re-measured from scratch.
//
// Measured on Bun 1.4.0.

import { existsSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

/** The v27 shape: outputs under a namespace prefix, beside sidecar entries. */
const ENTRIES = {
  'outputs/sub/a.txt': 'alpha',
  'outputs/b.txt': 'bravo',
  stdout: 'captured stdout',
  '.vx-meta.json': '{"mode":{},"mtime":{}}',
}

describe('Bun.Archive capabilities the v27 container depends on', () => {
  let dir: string
  let bytes: Uint8Array

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-arch-cap-'))
    bytes = await new Bun.Archive(ENTRIES).bytes()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('TRIPWIRE: extract() cannot strip the namespace prefix', async () => {
    // THE blocker. Streaming `outputs/**` straight into the project dir needs
    // the `outputs/` segment dropped; `ArchiveExtractOptions` exposes only
    // `glob`, so entries land under their full archive path and the candidate
    // design has to extract-then-rename instead. If a future Bun honours a
    // strip option, the first assertion below flips and this test fails.
    const stripish = { stripComponents: 1, strip: 1 } as unknown as { glob?: string }
    const dest = path.join(dir, 'strip')
    await new Bun.Archive(bytes).extract(dest, stripish)
    expect(existsSync(path.join(dest, 'outputs', 'sub', 'a.txt'))).toBe(true)
    expect(existsSync(path.join(dest, 'sub', 'a.txt'))).toBe(false)
  })

  it('glob DOES select just the outputs subtree', async () => {
    // The half that already works, and what makes extract-then-rename viable
    // at all: the sidecar and stdout entries stay behind.
    const dest = path.join(dir, 'globbed')
    const count = await new Bun.Archive(bytes).extract(dest, { glob: 'outputs/**' })
    expect(count).toBe(2)
    expect(existsSync(path.join(dest, 'outputs', 'b.txt'))).toBe(true)
    expect(existsSync(path.join(dest, 'stdout'))).toBe(false)
    expect(existsSync(path.join(dest, '.vx-meta.json'))).toBe(false)
  })

  it('the container carries no per-entry mode, which is why the sidecar exists', async () => {
    // `Bun.Archive.write(path, data)` takes in-memory content (`ArchiveInput`),
    // with no way to archive a file FROM DISK carrying its metadata — so mode
    // and mtime cannot ride this container even in principle. v27 puts them in
    // `.vx-meta.json` and applies them after extraction. That makes mtime NOT
    // a blocker for a streaming restore, which is the correction this test
    // pins: the only blocker is the prefix above.
    const dest = path.join(dir, 'modes')
    await new Bun.Archive(bytes).extract(dest)
    expect(statSync(path.join(dest, 'outputs', 'b.txt')).mode & 0o777).toBe(0o644)
  })
})
