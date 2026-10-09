// A remote cache answers a key with bytes of its choosing, so restore is
// the boundary: whatever the archive says (traversal atoms, links, pax
// renames, absurd sizes, flipped bytes), it writes nothing outside the
// destination and leaves only regular files and directories inside it.
// archive-security.test.ts pins each known shape; this drives seeded
// mixtures of them. A failure prints its seed.
import { lstatSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { extractArtifactStream, packArtifact } from '../src/cache/archive.js'
import { streamOf } from './helpers/stream.js'
import { withSum } from './helpers/artifact-sum.js'
import { rng } from './helpers/rng.js'

const CASES = 250
const enc = new TextEncoder()

// Weighted toward names that pass the cheap checks, so the deeper layers
// (containment, links, the commit) see traversal too.
const ATOMS = [
  'a',
  'b.txt',
  '..',
  '..',
  '..',
  '.',
  'a',
  '',
  '/',
  '\\',
  'C:',
  '\0',
  'x'.repeat(300),
  '…',
  'outputs',
  'workspace-outputs',
]
const TYPES = ['0', '0', '0', '1', '2', '5', '6', 'x', 'g', 'L', 'K', '7']

const pick = <T>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!

function name(rnd: () => number): string {
  const parts: string[] = []
  const n = 1 + Math.floor(rnd() * 5)
  for (let i = 0; i < n; i++) parts.push(pick(rnd, ATOMS))
  const joined = parts.join(rnd() < 0.9 ? '/' : '')
  const r = rnd()
  return r < 0.4 ? `outputs/${joined}` : r < 0.6 ? `workspace-outputs/${joined}` : joined
}

function octal(n: number, width: number): string {
  return (
    n
      .toString(8)
      .padStart(width - 1, '0')
      .slice(-(width - 1)) + '\0'
  )
}

function header(rnd: () => number, entryName: string, size: number, type: string): Uint8Array {
  const buf = new Uint8Array(512)
  enc.encodeInto(entryName, buf.subarray(0, 100))
  enc.encodeInto(octal(pick(rnd, [0o644, 0o755, 0o4777, 0]), 8), buf.subarray(100, 108))
  enc.encodeInto(octal(0, 8), buf.subarray(108, 116))
  enc.encodeInto(octal(0, 8), buf.subarray(116, 124))
  // An absurd declared size must be refused, not allocated or awaited.
  const declared = rnd() < 0.1 ? 0o77777777777 : size
  enc.encodeInto(octal(declared, 12), buf.subarray(124, 136))
  enc.encodeInto(octal(0, 12), buf.subarray(136, 148))
  for (let i = 148; i < 156; i++) buf[i] = 0x20
  buf[156] = type.charCodeAt(0)
  if (type === '1' || type === '2') enc.encodeInto(name(rnd), buf.subarray(157, 257))
  if (rnd() < 0.3) enc.encodeInto(name(rnd).slice(0, 155), buf.subarray(345, 500))
  enc.encodeInto('ustar\x0000', buf.subarray(257, 265))
  let sum = 0
  for (let i = 0; i < 512; i++) sum += buf[i]!
  enc.encodeInto(octal(sum, 7), buf.subarray(148, 155))
  buf[155] = 0x20
  return buf
}

function padded(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(b.length / 512) * 512)
  out.set(b)
  return out
}

function crafted(rnd: () => number): Uint8Array {
  const parts: Uint8Array[] = []
  const n = 1 + Math.floor(rnd() * 4)
  for (let i = 0; i < n; i++) {
    const type = pick(rnd, TYPES)
    const body =
      type === 'x' || type === 'g'
        ? enc.encode(`${(name(rnd).length + 8).toString()} path=${name(rnd)}\n`)
        : type === 'L' || type === 'K'
          ? enc.encode(`${name(rnd)}\0`)
          : enc.encode('payload'.repeat(Math.floor(rnd() * 3)))
    parts.push(header(rnd, name(rnd), body.length, type), padded(body))
  }
  if (rnd() < 0.9) parts.push(new Uint8Array(1024))
  return new Uint8Array(Buffer.concat(parts))
}

let base: string
let valid: Uint8Array

beforeAll(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'vx-restore-fuzz-'))
  const src = path.join(base, 'src')
  await mkdir(path.join(src, 'dist'), { recursive: true })
  await writeFile(path.join(src, 'dist', 'a.js'), 'export {}\n')
  await writeFile(path.join(src, 'dist', 'b.txt'), 'x'.repeat(2000))
  valid = await packArtifact({
    stdout: '',
    outputs: new Map([
      ['outputs/dist/a.js', path.join(src, 'dist', 'a.js')],
      ['workspace-outputs/gen/b.txt', path.join(src, 'dist', 'b.txt')],
    ]),
  })
})
afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

/** Every path under `root`, with what it is. */
function tree(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      const p = path.join(dir, e)
      const st = lstatSync(p)
      const kind = st.isSymbolicLink()
        ? 'link'
        : st.isDirectory()
          ? 'dir'
          : st.isFile()
            ? 'file'
            : 'other'
      out.push(`${path.relative(root, p)}:${kind}`)
      if (kind === 'dir') walk(p)
    }
  }
  walk(root)
  return out.sort()
}

function flipped(rnd: () => number): Uint8Array {
  const b = valid.slice()
  const n = 1 + Math.floor(rnd() * 8)
  for (let i = 0; i < n; i++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256)
  return b
}

it('a hostile archive writes only regular files and directories, only inside the destination', async () => {
  const seed = Number(process.env['VX_FUZZ_SEED'] ?? Date.now() % 1_000_000)
  const rnd = rng(seed)
  let restored = 0
  for (let i = 0; i < CASES; i++) {
    const ws = path.join(base, `ws-${i}`)
    const dest = path.join(ws, 'proj')
    await mkdir(dest, { recursive: true })
    await writeFile(path.join(ws, 'secret.txt'), 'outside')
    const bytes = rnd() < 0.3 ? flipped(rnd) : await withSum(crafted(rnd))
    const wsDest = path.join(ws, 'wsout')
    const chunk = 1 + Math.floor(rnd() * 900)
    const ok = await extractArtifactStream(streamOf(bytes, chunk), dest, wsDest).then(
      () => true,
      () => false,
    )
    if (ok) restored++
    const outside = tree(ws).filter((p) => !/^(proj|wsout)(\/|:dir$)/.test(p))
    const inside = tree(ws).filter(
      (p) => /^(proj|wsout)\//.test(p) && !p.endsWith(':file') && !p.endsWith(':dir'),
    )
    expect({ seed, i, outside, inside }).toEqual({
      seed,
      i,
      outside: ['secret.txt:file'],
      inside: [],
    })
    await rm(ws, { recursive: true, force: true })
  }
  // CONTROL: the mixture is not all refusals, so the invariant was
  // checked on archives that wrote something too.
  const control = path.join(base, 'control')
  await mkdir(path.join(control, 'proj'), { recursive: true })
  await extractArtifactStream(
    streamOf(valid),
    path.join(control, 'proj'),
    path.join(control, 'wsout'),
  )
  expect(tree(control).filter((p) => p.endsWith(':file'))).toEqual([
    'proj/dist/a.js:file',
    'wsout/gen/b.txt:file',
  ])
  expect({ seed, restored: restored > 0 }).toEqual({ seed, restored: true })
}, 60_000)
