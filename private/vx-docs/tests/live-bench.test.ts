// scripts/live-bench.ts against a fake GitHub: main's deploy builds the
// site from the newest numbers Bench measured on main.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { expect, it } from 'bun:test'
import { zipStored } from '../scripts/deploy-pages.js'
import { newestBench, unzipOne } from '../scripts/live-bench.js'

/** A zip as upload-artifact writes one: deflated, sizes only in the central directory. */
function zipDeflated(name: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const file = new TextEncoder().encode(name)
  const packed = deflateRawSync(data)
  const crc = Bun.hash.crc32(data)
  const local = new DataView(new ArrayBuffer(30))
  local.setUint32(0, 0x04034b50, true)
  local.setUint16(6, 0x08, true)
  local.setUint16(8, 8, true)
  local.setUint16(26, file.length, true)
  const central = new DataView(new ArrayBuffer(46))
  central.setUint32(0, 0x02014b50, true)
  central.setUint16(8, 0x08, true)
  central.setUint16(10, 8, true)
  central.setUint32(16, crc, true)
  central.setUint32(20, packed.length, true)
  central.setUint32(24, data.length, true)
  central.setUint16(28, file.length, true)
  const centralAt = 30 + file.length + packed.length
  const end = new DataView(new ArrayBuffer(22))
  end.setUint16(8, 1, true)
  end.setUint16(10, 1, true)
  end.setUint32(0, 0x06054b50, true)
  end.setUint32(12, 46 + file.length, true)
  end.setUint32(16, centralAt, true)
  return Buffer.concat([
    new Uint8Array(local.buffer),
    file,
    packed,
    new Uint8Array(central.buffer),
    file,
    new Uint8Array(end.buffer),
  ])
}

const BENCH = new TextEncoder().encode(JSON.stringify({ rows: [1, 2, 3] }).repeat(50))

it('reads the one file of a stored or a deflated zip', () => {
  expect(unzipOne(zipStored('bench.json', BENCH), 'bench.json')).toEqual(BENCH)
  expect(unzipOne(zipDeflated('bench.json', BENCH), 'bench.json')).toEqual(BENCH)
  expect(() => unzipOne(zipStored('other.json', BENCH), 'bench.json')).toThrow(
    'no bench.json in the zip (other.json)',
  )
  expect(() => unzipOne(new Uint8Array(40), 'bench.json')).toThrow('not a zip')
})

function fake(artifacts: (origin: string) => object[]) {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      expect(req.headers.get('authorization')).toBe('Bearer gh')
      if (url.pathname === '/repos/o/r/actions/artifacts') {
        expect(url.searchParams.get('name')).toBe('bench-data')
        return Response.json({ artifacts: artifacts(url.origin) })
      }
      const zip = /^\/zip\/(\d+)$/.exec(url.pathname)
      if (zip) {
        const json = JSON.stringify({ run: Number(zip[1]) })
        return new Response(zipDeflated('bench.json', new TextEncoder().encode(json)))
      }
      return new Response('no', { status: 404 })
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  return { server, env: { GITHUB_TOKEN: 'gh', GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: origin } }
}

const artifact = (origin: string, run: number, branch: string, expired = false) => ({
  archive_download_url: `${origin}/zip/${run}`,
  expired,
  workflow_run: { id: run, head_branch: branch },
})

// The API lists the newest first; a dispatch's run on a branch and an
// expired artifact are skipped.
it('takes the newest unexpired numbers measured on main', async () => {
  const { server, env } = fake((origin) => [
    artifact(origin, 4, 'feature'),
    artifact(origin, 3, 'main', true),
    artifact(origin, 2, 'main'),
    artifact(origin, 1, 'main'),
  ])
  try {
    expect(await newestBench(env)).toEqual({ run: 2, json: '{"run":2}' })
  } finally {
    await server.stop(true)
  }
})

// Never the committed copy, older than the live one (2026-11-01).
it('fails when main has no measured numbers', async () => {
  const { server, env } = fake(() => [])
  try {
    await expect(newestBench(env)).rejects.toThrow('no bench-data artifact from main')
  } finally {
    await server.stop(true)
  }
})

// Every page reads the figures through src/bench/data.ts, the markdown
// plugin too, which astro.config.mjs loads outside Vite: the deploy's
// numbers reach it by VX_DOCS_BENCH, never by a Vite alias, which left
// every markdown page on the committed copy (2026-11-06).
it('fills every figure from VX_DOCS_BENCH when it is set', () => {
  const dir = path.join(import.meta.dir, '..')
  const committed = JSON.parse(readFileSync(path.join(dir, 'src/data/bench.json'), 'utf8'))
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'live-bench-'))
  const live = path.join(tmp, 'live.json')
  writeFileSync(live, JSON.stringify({ ...committed, packages: 7777 }))
  const read = (env: Record<string, string>): string =>
    Bun.spawnSync(
      [
        'bun',
        '-e',
        "import { fillBench } from './src/bench/data.ts'; console.log(fillBench('%bench.projects%'))",
      ],
      { cwd: dir, env: { ...process.env, ...env } },
    )
      .stdout.toString()
      .trim()
  expect(read({ VX_DOCS_BENCH: live })).toBe('7,777')
  expect(read({})).toBe(Number(committed.packages).toLocaleString('en-US'))
})

// Astro's content store keeps each markdown page as rendered: the deploy
// renders into a store of its own, emptied first, or the build's copy
// with the committed figures ships (2026-11-06).
it('renders the deploy from an empty content store of its own', () => {
  const dir = path.join(import.meta.dir, '..')
  const config = readFileSync(path.join(dir, 'astro.config.mjs'), 'utf8')
  expect(config).toContain(
    "cacheDir: process.env.VX_DOCS_BENCH ? './.astro/live' : './.astro/cache'",
  )
  const tasks = readFileSync(path.join(dir, 'vx.config.ts'), 'utf8')
  expect(tasks).toContain('bun scripts/live-bench.ts && rm -rf .astro/live && ${ASTRO_BUILD}')
})

// The build's store too: a page whose figures come from data (the real
// repos page, real-repos.json) is the same text with new numbers, and the
// store served its old render, which the build task's cache then kept
// under the new key (2026-11-11).
it('renders the build from an empty content store', () => {
  const tasks = readFileSync(path.join(import.meta.dir, '..', 'vx.config.ts'), 'utf8')
  expect(tasks).toContain('command: `rm -rf .astro/cache && ${ASTRO_BUILD}`')
})
