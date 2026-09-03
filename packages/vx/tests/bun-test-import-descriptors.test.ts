// TRIPWIRE on the Bun test runner, not on vx. Under `bun test` every
// dynamically imported module pins descriptors for the life of the process —
// measured on Bun 1.4.0 / darwin (2026-09-03): 50 modules from 50 directories
// cost 115, 50 from one directory cost 100, and a forced GC releases none.
// The same code under plain `bun` pins zero. The descriptors are the
// directories the modules live in, which is the shape of a kqueue-backed
// module watcher that the runner keeps armed without `--watch`.
//
// vx cares because a test that loads thousands of configs (scale-graph) then
// parks the process at the 10 240-descriptor macOS cap and the next spawn in
// any later file fails with EBADF. tests/helpers/shard.ts gives such a file
// its own process (`@vx-shard-isolate`). When THIS test fails, Bun has fixed
// the leak and the isolate hint can go. Scoped to darwin, the platform it
// was measured on and where the cap bites; the linux job does not need it.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

describe.skipIf(process.platform !== 'darwin')('bun test import descriptors', () => {
  it('pins at least one descriptor per dynamically imported module', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'vx-fd-tripwire-'))
    try {
      // Collect BEFORE the baseline too: in a shared process the GC below
      // also runs finalizers that close descriptors earlier files leaked,
      // and that offset once read 20 imports as +12 (2026-09-03).
      Bun.gc(true)
      const before = readdirSync('/dev/fd').length
      for (let i = 0; i < 40; i++) {
        const dir = path.join(root, `d${i}`)
        mkdirSync(dir)
        writeFileSync(path.join(dir, 'm.mjs'), `export const v = ${i}\n`)
        await import(path.join(dir, 'm.mjs'))
      }
      Bun.gc(true)
      const after = readdirSync('/dev/fd').length
      // A quarter of the measured ~90 for 40 modules: the count per module
      // is the runner's business, the pin is only that imports are not free
      // (plain `bun` measures exactly 0).
      expect(after - before).toBeGreaterThanOrEqual(10)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
