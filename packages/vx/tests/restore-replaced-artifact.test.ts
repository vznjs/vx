// A restore reads ONE artifact file whole while another process saves the
// same key over it (two checkouts on one shared store, a `--force` beside a
// hit). By path, `Bun.file` took the size from one stat and read the bytes
// from a second open, so a re-save renamed in between was read at the old
// length: "artifact is not a readable archive", and the restore dropped the
// other process's good entry. Seen on six runs sharing a cache dir.

import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-restore-replaced-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function race(bytes: (variant: number) => Uint8Array, rounds: number): Promise<void> {
  const cache = new Cache(path.join(dir, 'cache'))
  const projectDir = path.join(dir, 'proj')
  const out = path.join(projectDir, 'dist', 'out.bin')
  await mkdir(path.dirname(out), { recursive: true })
  const artifact = cache.outputsPath('k')
  const variants: string[] = []
  // Two good artifacts of one key whose sizes differ.
  for (const v of [0, 1]) {
    await writeFile(out, bytes(v))
    await cache.save({
      hash: 'k',
      projectDir,
      outputFiles: [out],
      entry: { taskId: 'p#build', command: 'build', durationMs: 1, stdout: '' },
    })
    variants.push(path.join(dir, `variant-${v}`))
    copyFileSync(artifact, variants[v]!)
  }
  const stop = path.join(dir, 'stop')
  const saver = Bun.spawn([
    process.execPath,
    '-e',
    `const { copyFileSync, existsSync, renameSync } = require('node:fs')
const variants = ${JSON.stringify(variants)}
for (let i = 0; !existsSync(${JSON.stringify(stop)}); i++) {
  copyFileSync(variants[i % 2], ${JSON.stringify(artifact)} + '.next')
  renameSync(${JSON.stringify(artifact)} + '.next', ${JSON.stringify(artifact)})
}`,
  ])
  const failures: string[] = []
  try {
    for (let i = 0; i < rounds; i++) {
      await rm(path.dirname(out), { recursive: true, force: true })
      try {
        await cache.restoreOutputs('k', projectDir)
        const got = new Uint8Array(await readFile(out))
        if (!(Bun.deepEquals(got, bytes(0)) || Bun.deepEquals(got, bytes(1)))) {
          failures.push('restored bytes of neither save')
        }
      } catch (err) {
        failures.push((err as Error).message)
      }
    }
  } finally {
    await writeFile(stop, '')
    await saver.exited
    cache.close()
  }
  expect(failures).toEqual([])
  expect(existsSync(artifact)).toBe(true)
}

it('a small artifact replaced under a restore is read whole, never as a corrupt one', async () => {
  await race((v) => new Uint8Array(v === 0 ? 1_000 : 30_000).fill(v + 1), 300)
}, 30_000)

it('a streamed artifact replaced under a restore is read whole, never as a corrupt one', async () => {
  // Past STREAM_DECODE_FROM compressed: random bytes do not compress.
  const random = [randomBytes(4_400_000), randomBytes(4_800_000)]
  await race((v) => random[v]!, 200)
}, 60_000)
