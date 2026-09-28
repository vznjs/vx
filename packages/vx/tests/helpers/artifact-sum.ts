// A test's hand-built tar with the checksum entry an artifact carries
// (v36, L-19), computed here independently of src/cache/archive.ts as its
// oracle: a CRC-32 over each regular entry's name, a NUL and its body,
// in order, as 8 lowercase hex digits in a last `.vx-sum` entry. A tar
// this cannot read, or one that already carries the entry, is returned as
// it came.
import { tarEntries, tarPack } from '../../src/cache/tar-stream.js'
import { streamOf } from './stream.js'

export async function withSum(tar: Uint8Array): Promise<Uint8Array> {
  const eof = tar.subarray(tar.length - 1024)
  if (tar.length < 1024 || eof.some((b) => b !== 0)) return tar
  let crc = 0
  try {
    for await (const e of tarEntries(streamOf(tar))) {
      const chunks: Uint8Array[] = []
      for await (const c of e.body) chunks.push(c)
      if (e.type !== '0') continue
      if (e.name === '.vx-sum') return tar
      crc = Bun.hash.crc32(new TextEncoder().encode(`${e.name}\0`), crc)
      for (const c of chunks) crc = Bun.hash.crc32(c, crc)
    }
  } catch {
    return tar
  }
  const hex = (crc >>> 0).toString(16).padStart(8, '0')
  // The end-of-archive zeros, however many a writer pads to (Bun.Archive
  // pads to 10 KiB): the sum goes before them.
  let end = tar.length
  while (end >= 512 && tar.subarray(end - 512, end).every((b) => b === 0)) end -= 512
  const parts: Uint8Array[] = [tar.subarray(0, end)]
  for await (const c of tarPack([{ name: '.vx-sum', size: 8, body: hex }])) parts.push(c)
  return new Uint8Array(await new Blob(parts).arrayBuffer())
}
