// A save scans the tar it just packed in memory, synchronously
// (`scanTarBytes`); a restore and an ingest scan a stream (`scanArtifact`).
// The save's scan is the one that writes the index rows and refuses an
// unsafe name before they land, so it must read exactly what the stream
// reads: the same entries, sizes, modes, mtimes, stdout, usage and key —
// or the same refusal, class and message — on every name shape, every
// output log (stdout and stderr in one ordered entry since v42), every
// flipped byte and every truncation. Both run one header decoder
// (`TarDecoder` in tar-stream.ts); these rows hold the rest of each path.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import {
  packArtifact,
  packArtifactBytes,
  packArtifactStream,
  planArtifact,
} from '../src/cache/archive.js'
import { Cache } from '../src/cache/cache.js'
import { tarPack, type TarInput } from '../src/cache/tar-stream.js'
import type { CapturedChunk } from '../src/exec/index.js'
import { decodeOutputLog, encodeOutputLog } from '../src/orchestrator/output-log.js'
import { withSum } from './helpers/artifact-sum.js'
import { rng } from './helpers/rng.js'
import { scanBoth, type ScanOutcome } from './helpers/scan-parity.js'

const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-scanbytes-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const enc = new TextEncoder()
const byteLen = (s: string): number => enc.encode(s).byteLength

let sources = 0
function source(body: Uint8Array | string): string {
  const p = path.join(dir, `src-${sources++}`)
  writeFileSync(p, body)
  return p
}

const ATOMS = ['a', 'Z', '0', '_', '.', ' ', '-', '=', '\\', 'é', '日', '😀', '\uFEFF']

function segment(rnd: () => number, maxBytes: number): string {
  const len = 1 + Math.floor(rnd() * (rnd() < 0.2 ? 120 : 12))
  const picks = [rnd() < 0.15 ? '\uFEFF' : '']
  for (let i = 0; i < len; i++) picks.push(ATOMS[Math.floor(rnd() * ATOMS.length)]!)
  while (byteLen(picks.join('')) > maxBytes) picks.pop()
  const s = picks.join('')
  return s === '' || s === '.' || s === '..' ? 'f' : s
}

/** `outputs/` + `rest` padded with `x` to exactly `bytes` bytes in all. */
const exactly = (bytes: number, rest = ''): string =>
  `outputs/${rest}${'x'.repeat(bytes - byteLen(`outputs/${rest}`))}`

/** The name shapes the dialect splits on, then random ones. */
function names(rnd: () => number, seed: number): string[] {
  const fixed = [
    'outputs/a.txt',
    exactly(100), // fits the name field to the byte
    exactly(101), // one past: ustar prefix split (`outputs` / `xxx…`)
    exactly(240, `${'p'.repeat(140)}/`), // a 148-byte ustar prefix and a 91-byte tail
    exactly(300, `${'p'.repeat(200)}/`), // no split fits both fields: pax
    `outputs/${'s'.repeat(255)}`, // a 255-byte segment: pax
    `outputs/${Array.from({ length: 60 }, (_, i) => `d${i}`).join('/')}/leaf`, // deep
    'outputs/\uFEFFbom', // a leading byte-order mark in the name field
    `outputs/${'q'.repeat(120)}/\uFEFFbom`, // and at the start of a split tail
    'outputs/sp ace/trailing ',
    'outputs/back\\slash',
    'workspace-outputs/gen/root.txt',
    `workspace-outputs/${'日'.repeat(60)}/x`, // multibyte past 100 bytes
  ]
  const pick = fixed[seed % fixed.length]!
  const out = new Set([pick])
  const n = 1 + Math.floor(rnd() * 5)
  while (out.size < n + 1) {
    const depth = 1 + Math.floor(rnd() * (rnd() < 0.3 ? 20 : 4))
    const prefix = rnd() < 0.85 ? 'outputs' : 'workspace-outputs'
    out.add(`${prefix}/${Array.from({ length: depth }, () => segment(rnd, 255)).join('/')}`)
  }
  return [...out]
}

const SIZES = [0, 1, 99, 511, 512, 513, 1024, 1500]

function body(rnd: () => number): Uint8Array {
  const n = SIZES[Math.floor(rnd() * SIZES.length)]!
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = Math.floor(rnd() * 256)
  return b
}

const LOG_ATOMS = ['ok\n', 'warn: x\n', '\x1e', '\x1ee', '\x1eo', 'a\uFEFF', '日本', '😀', ' ', '']

/** What a task printed, both streams interleaved: the entry's `stdout` stores it encoded (v42). */
function outputChunks(rnd: () => number): CapturedChunk[] {
  const n = Math.floor(rnd() * 6)
  return Array.from({ length: n }, () => ({
    text: Array.from(
      { length: 1 + Math.floor(rnd() * 4) },
      () => LOG_ATOMS[Math.floor(rnd() * LOG_ATOMS.length)]!,
    ).join(''),
    err: rnd() < 0.4,
  }))
}

/** `chunks` as the decoder returns them: empty ones dropped, same-stream neighbours joined. */
function joined(chunks: readonly CapturedChunk[]): CapturedChunk[] {
  const out: CapturedChunk[] = []
  for (const c of chunks) {
    if (c.text.length === 0) continue
    const last = out.at(-1)
    if (last !== undefined && last.err === c.err) last.text += c.text
    else out.push({ ...c })
  }
  return out
}

const kind = (o: ScanOutcome): string => ('ok' in o ? 'ok' : `${o.refused}: ${o.message}`)

describe('a small artifact packed on this thread', () => {
  // The save packs a plan under ON_THREAD_MAX synchronously (`tarPackInto`);
  // the stream path packs the rest. Same plan, same bytes, every name shape.
  it('is byte for byte the streamed pack', async () => {
    for (let i = 0; i < 60; i++) {
      const rnd = rng(0x9ac + i * 104_729)
      const outputs = new Map(names(rnd, i).map((n) => [n, source(body(rnd))]))
      const plan = await planArtifact({ key: `k-${i}`, stdout: `out ${i}\n`, outputs })
      const streamed = new Uint8Array(await new Response(packArtifactStream(plan)).arrayBuffer())
      expect(streamed.byteLength).toBe(plan.size)
      expect(Bun.hash.xxHash3(await packArtifactBytes(plan))).toBe(Bun.hash.xxHash3(streamed))
    }
  })
})

describe('scanTarBytes reads what scanArtifact reads', () => {
  it('on every name shape, seeded: same entries, stdout, usage and key', async () => {
    const SEEDS = Array.from({ length: 120 }, (_, i) => 0x5ca + i * 7919)
    for (const [i, seed] of SEEDS.entries()) {
      const rnd = rng(seed)
      const ns = names(rnd, i)
      const outputs = new Map(ns.map((n) => [n, source(body(rnd))]))
      const chunks = outputChunks(rnd)
      const log = encodeOutputLog(chunks)
      // A leading byte-order mark: both scanners must drop it alike (the
      // decoder's default; the log rows below are the BOM-free seeds).
      const bom = i % 10 === 3
      const tar = await packArtifact({
        key: `k-${seed}`,
        stdout: bom ? `\uFEFF${log}` : log,
        outputs,
        exec: rnd() < 0.5 ? { cpuMs: seed, peakRssBytes: 4096 } : undefined,
      })
      // Odd chunks, one byte at a time on a few, and the whole tar in one.
      const chunk = i < 4 ? 1 : [7, 513, 700, tar.byteLength][i % 4]!
      const o = await scanBoth(tar, chunk)
      if (!('ok' in o)) throw new Error(`seed ${seed}: ${o.message}`)
      // Not vacuous: the names the scan reads are the ones packed.
      expect(o.ok.entries.map((e) => e.name).sort()).toEqual(['stdout', ...ns].sort())
      expect(o.ok.key).toBe(`k-${seed}`)
      // The stored output log reads back byte for byte, and decodes to what ran.
      if (!bom) {
        expect(o.ok.stdout).toBe(log)
        expect(decodeOutputLog(o.ok.stdout!)).toEqual(joined(chunks))
      }
    }
  }, 60_000)

  // One artifact with every header shape in it: a pax record, a ustar
  // split, a short name, an empty body, the sidecar and the sum.
  const fixture = () =>
    packArtifact({
      key: 'k-flip',
      stdout: 'out\n',
      outputs: new Map([
        [exactly(300, `${'p'.repeat(200)}/`), source('pax body')],
        [exactly(120, `${'p'.repeat(60)}/`), source('split body')],
        ['outputs/empty', source('')],
        ['outputs/short.txt', source('x'.repeat(700))],
      ]),
      exec: { cpuMs: 1 },
    })

  it('on every flipped byte: the same result or the same refusal', async () => {
    const tar = await fixture()
    const seen = new Map<string, number>()
    for (const mask of [0x01, 0x80]) {
      for (let at = 0; at < tar.byteLength; at++) {
        const m = tar.slice()
        m[at] = m[at]! ^ mask
        const o = await scanBoth(m, tar.byteLength)
        const cls = 'ok' in o ? 'ok' : o.refused
        seen.set(cls, (seen.get(cls) ?? 0) + 1)
      }
    }
    // Every class a flip can end in, each reached: a flip in padding
    // reads clean, one in a header fails its sum, one in a body fails the
    // artifact's, one in the sidecar breaks its JSON, and one in a pax
    // record can name an unsafe path, refused before the sum is read.
    expect([...seen.keys()].sort()).toEqual([
      'ArchiveSecurityError',
      'SyntaxError',
      'TarFormatError',
      'ok',
    ])
  }, 60_000)

  it('on every truncation: the same refusal, word for word', async () => {
    const tar = await fixture()
    const messages = new Set<string>()
    for (let n = 0; n < tar.byteLength; n++) {
      const o = await scanBoth(tar.subarray(0, n), 700)
      messages.add(
        kind(o)
          .replace(/ (after|entry) \S+/, ' $1 …')
          .replace(/\(\d+ of \d+ bytes\)/, '(…)'),
      )
    }
    // Each place the bytes can end, reached: inside a header, an extended
    // header (at its start and part-way), a body, its padding (at its start
    // and part-way), and at a block edge before any end marker. An end
    // after the first zero block reads clean, as tar allows.
    expect([...messages].sort()).toEqual([
      'TarFormatError: archive ends inside a header (…)',
      'TarFormatError: archive ends inside an extended header',
      'TarFormatError: archive ends inside an extended header (…)',
      'TarFormatError: archive ends inside entry … (…)',
      'TarFormatError: archive ends inside padding after …',
      'TarFormatError: archive ends inside padding after … (…)',
      'TarFormatError: archive has no end-of-archive marker',
      'ok',
    ])
  }, 60_000)

  it('on every truncation of entries it skips (a symlink, a pax global header)', async () => {
    const parts: Uint8Array[] = []
    const inputs: TarInput[] = [
      { name: 'stdout', size: 3, body: 'ok\n' },
      { name: 'outputs/link', size: 700, body: 'l'.repeat(700) },
      { name: 'PaxHeaders/g', size: 300, body: 'g'.repeat(300) },
      { name: 'outputs/a', size: 10, body: 'a'.repeat(10) },
    ]
    for await (const c of tarPack(inputs)) parts.push(c)
    const raw = new Uint8Array(await new Blob(parts).arrayBuffer())
    // Retype two entries in place, header sum and all: tarPack writes regular files only.
    const retype = (name: string, type: string) => {
      const at = Buffer.from(raw).indexOf(Buffer.from(`${name}\0`))
      expect(at % 512).toBe(0)
      raw[at + 156] = type.charCodeAt(0)
      raw.fill(32, at + 148, at + 156)
      let sum = 0
      for (let i = at; i < at + 512; i++) sum += raw[i]!
      raw.set(enc.encode(`${sum.toString(8).padStart(6, '0')}\0 `), at + 148)
    }
    retype('outputs/link', '2')
    retype('PaxHeaders/g', 'g')
    const tar = await withSum(raw)
    const whole = await scanBoth(tar)
    expect('ok' in whole && whole.ok.entries.map((e) => e.name)).toEqual(['stdout', 'outputs/a'])
    const messages = new Set<string>()
    for (let n = 0; n < tar.byteLength; n++) {
      const o = await scanBoth(tar.subarray(0, n), 700)
      messages.add(kind(o).replace(/\(\d+ of \d+ bytes\)/, '(…)'))
    }
    expect(messages).toContain('TarFormatError: archive ends inside entry outputs/link (…)')
    expect(messages).toContain('TarFormatError: archive ends inside a global header (…)')
  }, 60_000)

  it('on a missing checksum, and an entry after it', async () => {
    const tar = await fixture()
    const sumAt = Buffer.from(tar).indexOf(Buffer.from('.vx-sum\0'))
    expect(sumAt % 512).toBe(0)
    const cut = new Uint8Array([...tar.subarray(0, sumAt), ...new Uint8Array(1024)])
    const extra: Uint8Array[] = []
    for await (const c of tarPack([{ name: 'outputs/late.txt', size: 1, body: 'x' }])) extra.push(c)
    const late = new Uint8Array([
      ...tar.subarray(0, tar.byteLength - 1024),
      ...Buffer.concat(extra),
    ])
    expect([kind(await scanBoth(cut)), kind(await scanBoth(late))]).toEqual([
      'TarFormatError: artifact carries no checksum',
      "TarFormatError: entry outputs/late.txt follows the artifact's checksum",
    ])
  })

  it('on hostile names: the same ArchiveSecurityError', async () => {
    const PATH_MAX = 4096
    const hostile = [
      'outputs/../escape',
      '../escape',
      'outputs/..',
      '/etc/passwd',
      'outputs//double',
      'C:/Users/evil',
      'C:\\Users\\evil',
      `outputs/${'n'.repeat(120)}\0byte`, // past 100 bytes, unsplittable: in a pax record
      `outputs/${'n/'.repeat(PATH_MAX / 2)}x`,
      '',
    ]
    const refused: string[] = []
    for (const name of hostile) {
      const parts: Uint8Array[] = []
      // tarPack writes what it is given: a pax record carries any name.
      const inputs: TarInput[] = [
        { name: 'stdout', size: 0, body: '' },
        { name, size: 2, body: 'hi' },
      ]
      for await (const c of tarPack(inputs)) parts.push(c)
      const tar = await withSum(new Uint8Array(await new Blob(parts).arrayBuffer()))
      const o = await scanBoth(tar)
      // Cut inside the hostile entry's body: the name is refused before
      // the body is read, by both.
      const bodyAt = Buffer.from(tar).indexOf(Buffer.from('hi\0'))
      expect(bodyAt % 512).toBe(0)
      const cut = await scanBoth(tar.subarray(0, bodyAt + 1))
      refused.push(`${'ok' in o ? 'ok' : o.refused} ${'ok' in cut ? 'ok' : cut.refused}`)
    }
    expect(refused).toEqual(hostile.map(() => 'ArchiveSecurityError ArchiveSecurityError'))
  })
})

describe("a save's index rows are the rows a restore reads", () => {
  it('saved from disk, and ingested from the same bytes by the stream scan: same rows', async () => {
    const root = mkdtempSync(path.join(dir, 'save-'))
    const proj = path.join(root, 'proj')
    const rels = [
      'dist/\uFEFFbom.js',
      'dist/back\\slash',
      'dist/trailing ',
      `dist/${'日'.repeat(40)}/x`,
      `dist/${'s'.repeat(200)}/${'t'.repeat(200)}`,
    ]
    for (const [i, rel] of rels.entries()) {
      const p = path.join(proj, rel)
      await Bun.write(p, `body ${i}`)
    }
    const saved = new Cache(path.join(root, 'a'))
    const ingested = new Cache(path.join(root, 'b'))
    try {
      await saved.save({
        hash: 'h-rows',
        projectDir: proj,
        outputFiles: rels.map((r) => path.join(proj, r)),
        entry: { taskId: 'p#build', command: 'make', durationMs: 1, stdout: 'ok\n' },
      })
      const bytes = await Bun.file(saved.outputsPath('h-rows')).bytes()
      await ingested.ingest('h-rows', new Blob([bytes]), {
        taskId: 'p#build',
        command: 'make',
        durationMs: 1,
      })
      const rows = (c: Cache) =>
        c
          .dbHandle()
          .query(
            'SELECT path, size_bytes, mode, mtime_ms FROM output_files WHERE entry_hash = ? ORDER BY path',
          )
          .all('h-rows')
      expect((rows(saved) as Array<{ path: string }>).map((r) => r.path).sort()).toEqual(
        [...rels].sort(),
      )
      expect(rows(ingested)).toEqual(rows(saved))
    } finally {
      saved.close()
      ingested.close()
    }
  })
})
