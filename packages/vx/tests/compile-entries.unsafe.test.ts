// The sandbox runtime (with zod and node-forge, ~530 KB) is an entry of its
// own in the compiled binary: bundled into src/bin.ts, its bytecode loaded
// on every boot, ~2 ms of a warm no-op's start (2026-10-22). Unsafe: it reads
// the bench package's build scripts.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'

const CORE = path.resolve(import.meta.dir, '..')

it("src/bin.ts's bundle holds no sandbox runtime", async () => {
  const r = await Bun.build({
    entrypoints: [path.join(CORE, 'src', 'bin.ts')],
    target: 'bun',
    metafile: true,
  })
  expect(r.success).toBe(true)
  const srt = Object.keys(r.metafile!.inputs).filter((i) => i.includes('sandbox-runtime/dist'))
  expect(srt).toEqual([])
})

it('every compile of the binary names the sandbox entry', () => {
  const read = (rel: string): string => readFileSync(path.join(CORE, rel), 'utf8')
  const config = read('vx.config.ts')
  const targets = config.match(/--outfile dist\/vx-/g)?.length ?? 0
  expect(targets).toBe(4)
  expect(config.match(/src\/bin\.ts src\/exec\/srt\.ts --outfile dist\/vx-/g)?.length).toBe(targets)
  for (const site of [
    'scripts/check-binary.ts',
    '../vx-bench/compare.ts',
    '../vx-bench/pr-bench.ts',
    '../vx-bench/real/nightly.ts',
  ]) {
    const text = read(site)
    expect(`${site}: ${text.includes("'--compile'") && text.includes('srt.ts')}`).toBe(
      `${site}: true`,
    )
  }
})
