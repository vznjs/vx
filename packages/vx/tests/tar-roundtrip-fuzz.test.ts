// Seeded property rows for vx's own tar: random names (past 100 and 255
// bytes, multibyte, spaces, leading dashes, a leading U+FEFF, deep
// nesting), sizes on and around 512-byte block edges, bodies in every
// input shape, and the stream re-chunked at random. `tarPack` → `tarEntries`
// must return every name, size and byte exactly; Bun.Archive (libarchive)
// is the independent oracle for the same bytes. A failure prints its seed.
//
// The U+FEFF rows are the bug they found: a default `TextDecoder` drops a
// leading byte-order mark, so a ustar name or prefix that began with one
// read back without it, and an output named `<long dir>/<U+FEFF>x` was
// restored as `<long dir>/x`.

import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
  utimesSync,
  chmodSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { extractArtifactStream, packArtifact } from '../src/cache/archive.js'
import { tarEntries, tarPack, tarSize, type TarInput } from '../src/cache/tar-stream.js'
import { streamOf } from './helpers/stream.js'

const enc = new TextEncoder()
const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.compare(a, b) === 0

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ATOMS = ['a', 'Z', '0', '_', '.', ' ', '-', '=', 'é', '日', '😀', '\uFEFF']
const SIZES = [0, 1, 99, 100, 101, 511, 512, 513, 1023, 1024, 1025, 4096, 512 * 7, 512 * 7 + 1]

function segment(rnd: () => number, maxBytes: number): string {
  const len = 1 + Math.floor(rnd() * (rnd() < 0.2 ? 120 : 12))
  let s = rnd() < 0.15 ? '-' : rnd() < 0.15 ? '\uFEFF' : ''
  for (let i = 0; i < len; i++) s += ATOMS[Math.floor(rnd() * ATOMS.length)]!
  while (enc.encode(s).byteLength > maxBytes) s = s.slice(0, -2)
  // `.` and `..` name no file of their own.
  return s === '' || s === '.' || s === '..' ? 'f' : s
}

function name(rnd: () => number): string {
  const depth = 1 + Math.floor(rnd() * (rnd() < 0.3 ? 20 : 4))
  const parts = Array.from({ length: depth }, () => segment(rnd, 255))
  return parts.join('/')
}

function bytes(rnd: () => number, n: number): Uint8Array {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = Math.floor(rnd() * 256)
  return b
}

function size(rnd: () => number): number {
  return rnd() < 0.7 ? SIZES[Math.floor(rnd() * SIZES.length)]! : Math.floor(rnd() * 70_000)
}

async function* chunked(b: Uint8Array, rnd: () => number): AsyncIterable<Uint8Array> {
  for (let i = 0; i < b.byteLength;) {
    const n = 1 + Math.floor(rnd() * 2000)
    yield b.subarray(i, i + n)
    i += n
  }
}

function bodyOf(b: Uint8Array, rnd: () => number): TarInput['body'] {
  const r = rnd()
  if (r < 0.33) return b
  if (r < 0.66) return new Blob([b])
  return chunked(b, rnd)
}

const SEEDS = Array.from({ length: 150 }, (_, i) => 0x7a2 + i * 7919)

describe('tarPack → tarEntries, seeded', () => {
  it('round-trips names, sizes, bytes and header modes, and matches libarchive', async () => {
    for (const seed of SEEDS) {
      const rnd = mulberry32(seed)
      const files = new Map<string, { data: Uint8Array; mode: number }>()
      const count = 1 + Math.floor(rnd() * 6)
      while (files.size < count) {
        const n = name(rnd)
        files.set(n, { data: bytes(rnd, size(rnd)), mode: rnd() < 0.5 ? 0o755 : 0o644 })
      }
      const inputs = (): TarInput[] =>
        [...files].map(([n, f]) => ({
          name: n,
          size: f.data.byteLength,
          mode: f.mode,
          body: bodyOf(f.data, rnd),
        }))
      const parts: Uint8Array[] = []
      for await (const c of tarPack(inputs())) parts.push(new Uint8Array(c))
      const tar = new Uint8Array(Buffer.concat(parts))
      const ctx = `seed ${seed}`
      expect(tar.byteLength, ctx).toBe(tarSize(inputs()))

      const got = new Map<string, Uint8Array>()
      for await (const e of tarEntries(streamOf(tar, 1 + Math.floor(rnd() * 3000)))) {
        expect(e.type, ctx).toBe('0')
        const body: Uint8Array[] = []
        for await (const c of e.body) body.push(new Uint8Array(c))
        got.set(e.name, new Uint8Array(Buffer.concat(body)))
      }
      expect([...got.keys()], ctx).toEqual([...files.keys()])
      for (const [n, f] of files)
        expect(same(got.get(n)!, f.data), `${ctx}: ${JSON.stringify(n)}`).toBe(true)

      const oracle = await new Bun.Archive(tar).files()
      expect([...oracle.keys()].sort(), ctx).toEqual([...files.keys()].sort())
      for (const [n, f] of files) {
        const file = oracle.get(n)!
        expect(
          same(new Uint8Array(await file.arrayBuffer()), f.data),
          `${ctx}: ${JSON.stringify(n)}`,
        ).toBe(true)
      }
    }
  })

  it('keeps a leading U+FEFF in a ustar name and in a prefix-split tail', async () => {
    const names = [
      '\uFEFFshort',
      'outputs/' + 'd'.repeat(120) + '/\uFEFFtail',
      '\uFEFF' + 'p'.repeat(110) + '/x',
    ]
    const parts: Uint8Array[] = []
    for await (const c of tarPack(names.map((n) => ({ name: n, size: 1, body: 'x' }))))
      parts.push(c)
    const got: string[] = []
    for await (const e of tarEntries(streamOf(new Uint8Array(Buffer.concat(parts)))))
      got.push(e.name)
    expect(got).toEqual(names)
  })
})

describe('packArtifact → extractArtifactStream, seeded, on disk', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vx-tarfuzz-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('restores every output at its own path with its bytes, mode and millisecond mtime', async () => {
    for (const seed of SEEDS.slice(0, 40)) {
      const rnd = mulberry32(seed)
      const src = path.join(root, `s${seed}`)
      const dest = path.join(root, `d${seed}`)
      const outputs = new Map<string, string>()
      const want = new Map<string, { data: Uint8Array; mode: number; mtimeMs: number }>()
      const count = 1 + Math.floor(rnd() * 5)
      for (let i = 0; i < count; i++) {
        // A directory per file keeps one output's name from being another's parent.
        const rel = `${i}/${name(rnd)}`
        const abs = path.join(src, rel)
        mkdirSync(path.dirname(abs), { recursive: true })
        const data = bytes(rnd, size(rnd))
        const mode = [0o644, 0o755, 0o600, 0o700][Math.floor(rnd() * 4)]!
        const mtimeMs = 1_600_000_000_000 + Math.floor(rnd() * 1e11)
        writeFileSync(abs, data)
        chmodSync(abs, mode)
        utimesSync(abs, mtimeMs / 1000, mtimeMs / 1000)
        outputs.set(`outputs/${rel}`, abs)
        want.set(rel, { data, mode, mtimeMs: Math.floor(statSync(abs).mtimeMs) })
      }
      const tar = await packArtifact({ stdout: '', outputs })
      mkdirSync(dest)
      await extractArtifactStream(streamOf(tar, 1 + Math.floor(rnd() * 3000)), dest, undefined)
      const ctx = `seed ${seed}`
      const restored = (readdirSync(dest, { recursive: true }) as string[]).filter((p) =>
        statSync(path.join(dest, p)).isFile(),
      )
      expect(restored.sort(), ctx).toEqual([...want.keys()].sort())
      for (const [rel, w] of want) {
        const abs = path.join(dest, rel)
        const st = statSync(abs)
        expect(same(readFileSync(abs), w.data), `${ctx}: ${JSON.stringify(rel)}`).toBe(true)
        expect(st.mode & 0o777, ctx).toBe(w.mode)
        expect(Math.floor(st.mtimeMs), ctx).toBe(w.mtimeMs)
      }
    }
  })
})
