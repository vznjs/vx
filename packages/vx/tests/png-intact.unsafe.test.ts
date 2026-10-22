// A repo-wide text replace once rewrote bytes inside three tracked PNGs
// (#3634): same size, broken CRC and zlib stream, so the site served
// garbled images. Every tracked PNG must decode: each chunk fits the file
// and its CRC matches. The CRC covers every byte of the image data, so
// inflating it as well found nothing more and took ~0.9 s of the test's
// 5 s budget alone, over 5 s under a loaded gate.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'

const ROOT = path.resolve(import.meta.dir, '..', '..', '..')

function broken(file: string): string | null {
  const d = readFileSync(path.join(ROOT, file))
  let i = 8
  while (i < d.length) {
    const n = d.readUInt32BE(i)
    const type = d.subarray(i + 4, i + 8).toString()
    if (i + 12 + n > d.length) return `${type} truncated`
    const crc = d.readUInt32BE(i + 8 + n)
    if (Bun.hash.crc32(d.subarray(i + 4, i + 8 + n)) >>> 0 !== crc) return `${type} CRC`
    i += 12 + n
  }
  return null
}

it('every tracked PNG decodes', () => {
  const files = execFileSync('git', ['ls-files', '*.png'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
  expect(files.length).toBeGreaterThan(0)
  const bad = files.flatMap((f) => {
    const why = broken(f)
    return why === null ? [] : [`${f}: ${why}`]
  })
  expect(bad).toEqual([])
})
