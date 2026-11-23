// vx's Linux helpers (vx-observe, vx-measure) are committed as binaries
// (`scripts/build-observe.ts`), embedded in every vx, and one of them runs
// beside every Linux task. A review reads the C, never the bytes: this
// builds each again and refuses committed bytes the source does not give.
// The build is reproducible (no libc, no build id, stripped). CI has clang
// 18 with lld (GitHub's Ubuntu images) and sets VX_REQUIRE_CLANG, so a
// missing one fails there; elsewhere a machine without it skips.

import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { ARCHES, buildHelper, clang, HELPERS } from '../scripts/build-observe.js'

const cc = clang()
it('VX_REQUIRE_CLANG makes a missing clang 18 a failure', () => {
  if (process.env['VX_REQUIRE_CLANG'] === '1') expect(cc).toBeDefined()
})

describe.skipIf(cc === undefined)('the committed helper binaries', () => {
  let tmp: string
  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'vx-helpers-'))
  })
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  for (const { dir, name } of HELPERS)
    for (const [arch, target] of ARCHES)
      it(`${name}-${arch} is what its source builds`, () => {
        const out = path.join(tmp, `${name}-${arch}`)
        expect(buildHelper(cc!, path.join(dir, `${name}.c`), target, out)).toBe(0)
        expect(
          Buffer.compare(readFileSync(out), readFileSync(path.join(dir, `${name}-${arch}`))),
        ).toBe(0)
      })
})
