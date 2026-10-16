// A restore whose outputs sit on another filesystem than `.vx/tmp/` copies
// each file to a temp beside its target first, and renames none until
// every copy landed: a copy that failed (ENOSPC) left the files renamed
// before it new and the rest old (Growth's restore-exdev-partial.sh,
// 2026-10-16). `copyFile` is wrapped to fail on one entry; `mock.module`
// holds for the whole file, so the row has a file of its own.
import * as fsPromises from 'node:fs/promises'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, mock } from 'bun:test'
import { tarPack } from '../src/cache/tar-stream.js'
import { withSum } from './helpers/artifact-sum.js'
import { streamOf } from './helpers/stream.js'

const real = { ...fsPromises }
let failOn = ''
await mock.module('node:fs/promises', () => ({
  ...real,
  copyFile: async (src: string, dest: string, ...rest: unknown[]) => {
    if (failOn !== '' && readFileSync(src, 'utf8') === failOn) {
      throw Object.assign(new Error('ENOSPC: no space left on device, copyfile'), {
        code: 'ENOSPC',
      })
    }
    return (real.copyFile as (...a: unknown[]) => Promise<void>)(src, dest, ...rest)
  },
}))
const { extractArtifactStream } = await import('../src/cache/archive.js')

const made: string[] = []
afterEach(() => {
  failOn = ''
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

function dir(prefix: string, under = os.tmpdir()): string {
  const d = mkdtempSync(path.join(under, prefix))
  made.push(d)
  return d
}

async function artifact(files: Record<string, string>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  const entries = Object.entries(files).map(([name, body]) => ({
    name: `outputs/${name}`,
    size: Buffer.byteLength(body),
    body,
  }))
  for await (const c of tarPack(entries)) parts.push(c)
  return withSum(new Uint8Array(await new Blob(parts).arrayBuffer()))
}

// A tmpfs beside the disk: the only second filesystem a test reaches
// without a mount.
const otherFs =
  process.platform === 'linux' &&
  existsSync('/dev/shm') &&
  statSync('/dev/shm').dev !== statSync(os.tmpdir()).dev

it.skipIf(!otherFs)(
  'a copy that fails across filesystems leaves every output as it was',
  async () => {
    const ws = dir('vx-exdev-', '/dev/shm')
    const dest = dir('vx-exdev-dest-')
    const out = path.join(dest, 'dist')
    mkdirSync(out)
    for (const f of ['a.txt', 'm.txt', 'z.txt']) writeFileSync(path.join(out, f), `OLD-${f}\n`)
    failOn = 'NEW-m.txt\n'
    const err = await extractArtifactStream(
      streamOf(
        await artifact({
          'dist/a.txt': 'NEW-a.txt\n',
          'dist/m.txt': 'NEW-m.txt\n',
          'dist/z.txt': 'NEW-z.txt\n',
        }),
      ),
      dest,
      undefined,
      undefined,
      undefined,
      ws,
    ).then(
      () => null,
      (e: unknown) => e,
    )
    expect(String(err)).toContain('ENOSPC')
    const now = ['a.txt', 'm.txt', 'z.txt'].map((f) => readFileSync(path.join(out, f), 'utf8'))
    expect(now).toEqual(['OLD-a.txt\n', 'OLD-m.txt\n', 'OLD-z.txt\n'])
    // No temp is left beside the outputs, where the next save would take it.
    expect(readdirSync(out).sort()).toEqual(['a.txt', 'm.txt', 'z.txt'])
  },
)
