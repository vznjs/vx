// A repo-wide text replace once rewrote bytes inside three tracked PNGs
// (#3634): same size, broken CRC and zlib stream, so the site served
// garbled images. Every tracked PNG must decode.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { inflateSync } from 'node:zlib'
import { expect, it } from 'bun:test'

const ROOT = path.resolve(import.meta.dir, '..', '..', '..')

function broken(file: string): string | null {
  const d = readFileSync(path.join(ROOT, file))
  const idat: Buffer[] = []
  let i = 8
  while (i < d.length) {
    const n = d.readUInt32BE(i)
    const type = d.subarray(i + 4, i + 8)
    const body = d.subarray(i + 8, i + 8 + n)
    const crc = d.readUInt32BE(i + 8 + n)
    if (Bun.hash.crc32(Buffer.concat([type, body])) >>> 0 !== crc) return `${type} CRC`
    if (type.toString() === 'IDAT') idat.push(body)
    i += 12 + n
  }
  try {
    inflateSync(Buffer.concat(idat))
  } catch {
    return 'image data'
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
