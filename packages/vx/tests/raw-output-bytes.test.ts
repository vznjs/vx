// A task's output reaches the terminal as the bytes it wrote, live and in a
// hit's replay. A plain UTF-8 decode turned each byte that is not UTF-8
// into U+FFFD (EF BF BD), so `printf '\377\376'` printed two replacement
// characters on the miss and the stored log replayed them on every hit.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { packArtifact } from '../src/cache/archive.js'
import { decodeRaw, rawEncode, RawUtf8Decoder } from '../src/util/raw-utf8.js'
import { scanBothOrThrow } from './helpers/scan-parity.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const RAW = Buffer.from([0x78, 0x20, 0xff, 0xfe, 0x20, 0xe2, 0x82, 0x20, 0xed, 0xa0, 0x80, 0x0a])
const FFFD = Buffer.from([0xef, 0xbf, 0xbd])

async function vx(cwd: string, args: string[]): Promise<{ code: number; out: Buffer }> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  })
  const [out, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited])
  return { code, out: Buffer.from(out) }
}

describe('bytes that are not UTF-8', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-raw-output-' })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reach the terminal unchanged on the miss and on the hit, a secret still masked', async () => {
    await addProject(
      root,
      'q',
      `
      export default {
        tasks: {
          uni: {
            exec: {
              command: "printf 'x \\\\377\\\\376 \\\\342\\\\202 \\\\355\\\\240\\\\200\\\\n'; printf 'tok=%s\\\\377\\\\n' \\"$API_TOKEN\\"",
              env: { define: { API_TOKEN: 'sekritvalue42' } },
            },
            inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true,
          },
        },
      }
    `,
    )
    await Bun.write(path.join(root, 'packages', 'q', 'src', 'x.txt'), 'x')
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    for (const pass of ['miss', 'hit']) {
      const r = await vx(root, ['run', 'q#uni', '--output-logs', 'full'])
      expect(`${pass} ${r.code}`).toBe(`${pass} 0`)
      expect(r.out.includes(RAW)).toBe(true)
      expect(r.out.includes(Buffer.from([0x74, 0x6f, 0x6b, 0x3d, 0x2a, 0x2a, 0x2a, 0xff]))).toBe(
        true,
      )
      if (pass === 'hit') expect(r.out.toString()).toContain('local 1✓')
      expect(r.out.includes(FFFD)).toBe(false)
      expect(r.out.includes(Buffer.from('sekrit'))).toBe(false)
    }
  }, 30_000)
})

describe('decodeRaw / rawEncode', () => {
  it('round-trip every byte, valid UTF-8 decoded as text', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect(Buffer.from(rawEncode(decodeRaw(all))).equals(Buffer.from(all))).toBe(true)
    const text = 'héllo — 💀 �'
    expect(decodeRaw(new TextEncoder().encode(text))).toBe(text)
  })

  it('a sequence split across chunks is held for the next', () => {
    const bytes = new TextEncoder().encode('a💀é€')
    for (let cut = 0; cut <= bytes.length; cut++) {
      const d = new RawUtf8Decoder()
      const text =
        d.decode(bytes.subarray(0, cut), { stream: true }) +
        d.decode(bytes.subarray(cut)) +
        d.decode()
      expect(text).toBe('a💀é€')
    }
    const d = new RawUtf8Decoder()
    const cut = d.decode(Uint8Array.of(0x61, 0xe2, 0x82), { stream: true }) + d.decode()
    expect(Buffer.from(rawEncode(cut)).equals(Buffer.from([0x61, 0xe2, 0x82]))).toBe(true)
  })
})

it('an artifact keeps the log’s bytes through its pack and both scans', async () => {
  const stdout = decodeRaw(RAW)
  const tar = await packArtifact({ key: 'k', stdout, outputs: new Map() })
  expect(Buffer.from(tar).includes(RAW)).toBe(true)
  expect((await scanBothOrThrow(tar)).stdout).toBe(stdout)
})
