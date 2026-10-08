// Seeded properties of the whole artifact path, zstd included: `Cache.save`
// / `ingest` → `restoreOutputs`. `tar-roundtrip-fuzz.test.ts` holds the tar
// codec and `packArtifact` → `extractArtifactStream` on names, bytes, modes
// and mtimes; this file holds what that one does not reach: symlinked
// outputs (packed as their target's bytes), names with shell- and
// glob-special bytes, the streamed pack and codec past 4 MiB, byte-identical
// artifacts for one tree wherever it sits, and damage. A truncated or
// bit-flipped artifact, at the tar or at the zstd layer, is refused with the
// cache's own error and leaves nothing behind, or restores the exact tree
// (a flip in tar padding changes nothing that is read). The format stores
// regular files only: an empty directory is not an output, a dangling link
// is refused at save. A failure prints its seed.

import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { ArchiveSecurityError, extractArtifactStream } from '../src/cache/archive.js'
import { ArtifactVanishedError, Cache, CorruptArtifactError } from '../src/cache/cache.js'
import { TarFormatError } from '../src/cache/tar-stream.js'
import { UserError } from '../src/util/index.js'
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

// NFC-equals-NFD only (APFS stores names NFD); `\\` is a separator to
// nothing on POSIX and was once dropped (#2857).
const ATOMS = ['a', 'Z', '0', '.', ' ', '-', '日', '😀', '\uFEFF', '\t', '\n', '\\', '#', '%']
const ATOMS2 = ['*', '?', '[', ']', '{', '}', '~', '$', "'", '"', '!', '&', ';', '@', '=', '+']
const SIZES = [0, 1, 511, 512, 513, 1024, 512 * 9 + 1, 65_535, 65_536, 65_537, 262_145]

const nfdBytes = (s: string): number => enc.encode(s.normalize('NFD')).byteLength

function segment(rnd: () => number, long: boolean): string {
  const len = 1 + Math.floor(rnd() * (long ? 140 : 10))
  const picks: string[] = []
  for (let i = 0; i < len; i++) {
    const pool = rnd() < 0.25 ? ATOMS2 : ATOMS
    picks.push(pool[Math.floor(rnd() * pool.length)]!)
  }
  while (nfdBytes(picks.join('')) > 200) picks.pop()
  const s = picks.join('')
  // `.vx-tmp-` is the extractor's staging prefix; `..`/`.` name no file.
  return s === '' || s === '.' || s === '..' || s.startsWith('.vx-tmp-') || s.startsWith('._')
    ? 'f'
    : s
}

/** A relative name a file system holds: under NAME_MAX per part, well under macOS's PATH_MAX. */
function relName(rnd: () => number): string {
  const long = rnd() < 0.4
  const depth = 1 + Math.floor(rnd() * (long ? 4 : 3))
  const parts: string[] = []
  let total = 0
  for (let i = 0; i < depth; i++) {
    const part = segment(rnd, long)
    if (total + nfdBytes(part) > 560) break
    parts.push(part)
    total += nfdBytes(part) + 1
  }
  return parts.length === 0 ? 'f' : parts.join('/')
}

function bytes(rnd: () => number, n: number): Uint8Array {
  const b = new Uint8Array(n)
  // Half the files compress (a short alphabet), half are noise zstd stores raw.
  const span = rnd() < 0.5 ? 4 : 256
  for (let i = 0; i < n; i++) b[i] = Math.floor(rnd() * span)
  return b
}

interface Want {
  data: Uint8Array
  mode: number
  mtimeMs: number
}

const MODES = [0o644, 0o755, 0o600, 0o700, 0o444, 0o555]

/**
 * A project under `root`: files at random names, some outputs symlinks
 * (relative) to another output or to a project file that is not one.
 * Returns the output paths and what each must restore to.
 */
function makeTree(
  rnd: () => number,
  root: string,
  big: boolean,
): { outputs: string[]; want: Map<string, Want> } {
  const want = new Map<string, Want>()
  const outputs: string[] = []
  const regular: string[] = []
  const count = 1 + Math.floor(rnd() * 6)
  const put = (rel: string, data: Uint8Array): Want => {
    const abs = path.join(root, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, data)
    const mode = MODES[Math.floor(rnd() * MODES.length)]!
    const mtimeMs = 1_500_000_000_000 + Math.floor(rnd() * 2e11)
    utimesSync(abs, mtimeMs / 1000, mtimeMs / 1000)
    chmodSync(abs, mode)
    return { data, mode, mtimeMs: Math.floor(statSync(abs).mtimeMs) }
  }
  for (let i = 0; i < count; i++) {
    // A directory per output keeps one output's name from being another's parent.
    const rel = `out/${i}/${relName(rnd)}`
    const linkTo = regular.length > 0 && rnd() < 0.3 ? rnd() : null
    if (linkTo === null) {
      const n =
        big && i === 0
          ? 4 * 1024 * 1024 + 4097
          : rnd() < 0.7
            ? SIZES[Math.floor(rnd() * SIZES.length)]!
            : Math.floor(rnd() * 9000)
      want.set(rel, put(rel, bytes(rnd, n)))
      regular.push(rel)
    } else {
      // To another output, or to a source file the outputs do not name.
      let target: string
      if (linkTo < 0.5) target = regular[Math.floor(linkTo * 2 * regular.length)]!
      else {
        target = `src/${i}.txt`
        put(target, bytes(rnd, Math.floor(rnd() * 2000)))
      }
      const abs = path.join(root, rel)
      mkdirSync(path.dirname(abs), { recursive: true })
      symlinkSync(path.relative(path.dirname(abs), path.join(root, target)), abs)
      const st = statSync(abs)
      want.set(rel, {
        data: new Uint8Array(readFileSync(abs)),
        mode: st.mode & 0o777,
        mtimeMs: Math.floor(st.mtimeMs),
      })
    }
    outputs.push(path.join(root, rel))
  }
  // An empty directory beside the outputs: no output, never restored.
  if (rnd() < 0.5) mkdirSync(path.join(root, 'out', 'empty', relName(rnd)), { recursive: true })
  return { outputs, want }
}

/** Every regular file under `dir` (none may be a link), as rel → Want. */
function snapshot(dir: string): Map<string, Want> {
  const out = new Map<string, Want>()
  let rels: string[]
  try {
    rels = readdirSync(dir, { recursive: true }) as string[]
  } catch {
    return out
  }
  for (const rel of rels.sort()) {
    const st = lstatSync(path.join(dir, rel))
    if (st.isDirectory()) continue
    expect(st.isFile(), `${rel} restored as a non-file`).toBe(true)
    out.set(rel.split(path.sep).join('/'), {
      data: new Uint8Array(readFileSync(path.join(dir, rel))),
      mode: st.mode & 0o777,
      mtimeMs: Math.floor(st.mtimeMs),
    })
  }
  return out
}

function expectTree(got: Map<string, Want>, want: Map<string, Want>, ctx: string): void {
  expect([...got.keys()].sort(), ctx).toEqual([...want.keys()].sort())
  for (const [rel, w] of want) {
    const g = got.get(rel)!
    const at = `${ctx}: ${JSON.stringify(rel)}`
    expect(same(g.data, w.data), at).toBe(true)
    expect([g.mode, g.mtimeMs], at).toEqual([w.mode, w.mtimeMs])
  }
}

const root = mkdtempSync(path.join(os.tmpdir(), 'vx-artprop-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0
const fresh = (tag: string): string => path.join(root, `${tag}${n++}`)

const SEEDS = Array.from({ length: 16 }, (_, i) => 0x51a7 + i * 104_729)
const entry = { taskId: 'p#build', command: 'build', durationMs: 1, stdout: 'built\n' }
const meta = { taskId: 'p#build', command: 'build', durationMs: 1 }

describe('Cache.save → restoreOutputs, seeded', () => {
  it('restores the tree, matches libarchive, and packs one tree to one artifact', async () => {
    const cache = new Cache(fresh('cache'))
    try {
      for (const [i, seed] of SEEDS.entries()) {
        const ctx = `seed ${seed}`
        const rnd = mulberry32(seed)
        const proj = fresh('p')
        const { outputs, want } = makeTree(rnd, proj, i === 0)
        const hash = `h${seed}`
        const args = { hash, entry, projectDir: proj, outputFiles: outputs }
        const compressed = await cache.packArtifactBytes(args)
        expect(same(await cache.packArtifactBytes(args), compressed), ctx).toBe(true)

        // The same tree under another root packs to the same bytes.
        const twin = fresh('t')
        cpSync(proj, twin, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
        const twinOut = outputs.map((o) => path.join(twin, path.relative(proj, o)))
        expect(
          same(
            await cache.packArtifactBytes({ ...args, projectDir: twin, outputFiles: twinOut }),
            compressed,
          ),
          `${ctx}: twin`,
        ).toBe(true)

        // libarchive reads vx's tar to the same entries and bytes.
        const tar = Bun.zstdDecompressSync(compressed)
        const oracle = await new Bun.Archive(tar).files()
        expect([...oracle.keys()].sort(), ctx).toEqual(
          [
            'stdout',
            '.vx-meta.json',
            '.vx-sum',
            ...[...want.keys()].map((r) => `outputs/${r}`),
          ].sort(),
        )
        for (const [rel, w] of want) {
          const f = oracle.get(`outputs/${rel}`)!
          expect(same(new Uint8Array(await f.arrayBuffer()), w.data), `${ctx}: ${rel}`).toBe(true)
        }

        await cache.save(args)
        const stored = new Uint8Array(readFileSync(cache.outputsPath(hash)))
        expect(same(stored, compressed), `${ctx}: stored`).toBe(true)
        const dest = fresh('d')
        await cache.restoreOutputs(hash, dest)
        expectTree(snapshot(dest), want, ctx)
      }
    } finally {
      cache.close()
    }
  })

  it('refuses a dangling symlinked output and stores nothing', async () => {
    const cache = new Cache(fresh('cache'))
    try {
      const proj = fresh('p')
      mkdirSync(path.join(proj, 'out'), { recursive: true })
      writeFileSync(path.join(proj, 'out', 'ok.txt'), 'ok')
      symlinkSync('../gone.txt', path.join(proj, 'out', 'dead'))
      const outputFiles = [path.join(proj, 'out', 'ok.txt'), path.join(proj, 'out', 'dead')]
      const err = await cache
        .save({ hash: 'dangling', entry, projectDir: proj, outputFiles })
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(UserError)
      expect((err as Error).message).toStartWith('output out/dead is a dangling symlink')
      expect(await cache.get('dangling')).toBeNull()
      // CONTROL: the same save without the link stores.
      await cache.save({
        hash: 'dangling',
        entry,
        projectDir: proj,
        outputFiles: outputFiles.slice(0, 1),
      })
      expect((await cache.get('dangling'))?.stdout).toBe('built\n')
    } finally {
      cache.close()
    }
  })
})

type Damage = { layer: 'tar' | 'zstd'; kind: 'cut' | 'flip'; at: number; bit: number }

/** A damage site: uniform, or in the first or last few blocks, where headers, pax, sidecar and sum sit. */
function damage(rnd: () => number, len: number, layer: Damage['layer']): Damage {
  const r = rnd()
  const near = Math.min(len, 3072)
  const at =
    r < 0.4
      ? Math.floor(rnd() * len)
      : r < 0.7
        ? Math.floor(rnd() * near)
        : len - 1 - Math.floor(rnd() * near)
  return { layer, kind: rnd() < 0.35 ? 'cut' : 'flip', at, bit: Math.floor(rnd() * 8) }
}

function apply(b: Uint8Array, d: Damage): Uint8Array {
  if (d.kind === 'cut') return b.slice(0, d.at)
  const m = b.slice()
  m[d.at] = m[d.at]! ^ (1 << d.bit)
  return m
}

describe('a damaged artifact, seeded', () => {
  it('is refused with the cache error and leaves nothing, or restores the exact tree', async () => {
    // The remote side only ingests: an accepted artifact is replaced by a fresh cache.
    let cache = new Cache(fresh('cache'))
    const local = new Cache(fresh('cache'))
    const outcomes = { refused: 0, exact: 0 }
    try {
      for (const seed of SEEDS.slice(1, 9)) {
        const rnd = mulberry32(seed)
        const proj = fresh('p')
        const { outputs, want } = makeTree(rnd, proj, false)
        const hash = `h${seed}`
        const args = { hash, entry, projectDir: proj, outputFiles: outputs }
        const compressed = await cache.packArtifactBytes(args)
        const tar = Bun.zstdDecompressSync(compressed)
        for (let k = 0; k < 8; k++) {
          const d =
            k % 2 === 0
              ? damage(rnd, tar.byteLength, 'tar')
              : damage(rnd, compressed.byteLength, 'zstd')
          const ctx = `seed ${seed} ${JSON.stringify(d)}`
          const bad = d.layer === 'tar' ? Bun.zstdCompressSync(apply(tar, d)) : apply(compressed, d)

          // The tar reader alone: its own error, or the tree.
          if (d.layer === 'tar') {
            const dest = fresh('x')
            const err = await extractArtifactStream(
              streamOf(apply(tar, d), 1 + Math.floor(rnd() * 3000)),
              dest,
              undefined,
            ).then(
              () => null,
              (e: Error) => e,
            )
            if (err === null) expectTree(snapshot(dest), want, ctx)
            else {
              expect(
                err instanceof TarFormatError || err instanceof ArchiveSecurityError,
                `${ctx}: ${String(err)}`,
              ).toBe(true)
              expect(snapshot(dest).size, ctx).toBe(0)
            }
          }

          // Remote: ingest refuses, or the entry restores the tree.
          const err = await cache.ingest(hash, new Blob([bad]), meta).then(
            () => null,
            (e: Error) => e,
          )
          if (err !== null) {
            expect(
              err instanceof CorruptArtifactError || err instanceof ArchiveSecurityError,
              `${ctx}: ${String(err)}`,
            ).toBe(true)
            expect(await cache.get(hash), ctx).toBeNull()
            const artifacts = readdirSync(path.dirname(cache.outputsPath(hash))).filter((f) =>
              f.includes('.tar.zst'),
            )
            expect(artifacts, ctx).toEqual([])
            outcomes.refused++
          } else {
            const dest = fresh('r')
            await cache.restoreOutputs(hash, dest)
            expectTree(snapshot(dest), want, ctx)
            outcomes.exact++
            cache.close()
            cache = new Cache(fresh('cache'))
          }

          // Local: bytes damaged on disk after a good save, every other pair.
          if (k % 4 < 2) continue
          await local.save(args)
          writeFileSync(local.outputsPath(hash), bad)
          const dest = fresh('l')
          const lerr = await local.restoreOutputs(hash, dest).then(
            () => null,
            (e: Error) => e,
          )
          if (lerr !== null) {
            expect(lerr, `${ctx}: ${String(lerr)}`).toBeInstanceOf(ArtifactVanishedError)
            expect(lerr.cause, ctx).toBeInstanceOf(CorruptArtifactError)
            expect(snapshot(dest).size, ctx).toBe(0)
            expect(await local.get(hash), ctx).toBeNull()
          } else {
            expectTree(snapshot(dest), want, ctx)
          }
        }
      }
    } finally {
      cache.close()
      local.close()
    }
    // The sweep reached both answers: damage that is read, and padding that is not.
    expect(outcomes.refused, JSON.stringify(outcomes)).toBeGreaterThan(50)
    expect(outcomes.exact, JSON.stringify(outcomes)).toBeGreaterThan(0)
  })
})
