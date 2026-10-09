// A run whose local cache holds nothing skips the up-front probe: every
// lookup would miss, and a cold 1,090-package run started its first task
// ~90 ms later for it. "Nothing" counts what a lookup can hit: an index row,
// an inline artifact, and an artifact file `adopt` indexes on a hit.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

let root: string
let cacheDir: string
let proj: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-holds-nothing-'))
  cacheDir = path.join(root, 'cache')
  proj = path.join(root, 'p')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function save(cache: Cache, hash: string, body: Uint8Array | 'none'): Promise<void> {
  await mkdir(path.join(proj, 'dist'), { recursive: true })
  const out = path.join(proj, 'dist', 'out.bin')
  if (body !== 'none') await writeFile(out, body)
  await cache.save({
    hash,
    projectDir: proj,
    outputFiles: body === 'none' ? [] : [out],
    entry: { taskId: 'p#build', command: 'build', durationMs: 1, stdout: '' },
  })
}

const small = (): Uint8Array => new TextEncoder().encode('x')
/** Incompressible bytes past INLINE_MAX: an artifact holding them is a file. */
const big = (): Uint8Array => crypto.getRandomValues(new Uint8Array(48 * 1024))

/** After a save of `body` and the removal of its `entries` row, if `dropRow`. */
async function holdsNothingAfter(
  body: Uint8Array | 'none' | null,
  dropRow: boolean,
): Promise<boolean> {
  const writer = new Cache(cacheDir)
  if (body !== null) await save(writer, 'a'.repeat(16), body)
  if (dropRow) writer.dbHandle().query('DELETE FROM entries').run()
  writer.close()
  const cache = new Cache(cacheDir)
  try {
    return cache.holdsNothing()
  } finally {
    cache.close()
  }
}

describe('Cache.holdsNothing', () => {
  it('is true only when no lookup can hit', async () => {
    expect({
      fresh: await holdsNothingAfter(null, false),
      inlineEntry: await holdsNothingAfter(small(), false),
      noOutputEntry: await holdsNothingAfter('none', false),
    }).toEqual({ fresh: true, inlineEntry: false, noOutputEntry: false })
  })

  it('a row-less inline artifact can still hit', async () => {
    expect(await holdsNothingAfter(small(), true)).toBe(false)
  })

  it('a row-less artifact file can still hit (adopt)', async () => {
    expect(await holdsNothingAfter(big(), true)).toBe(false)
  })

  it('a cache that reads nothing holds nothing for this run', async () => {
    const writer = new Cache(cacheDir)
    await save(writer, 'a'.repeat(16), small())
    writer.close()
    const cache = new Cache(cacheDir, { read: false, write: true })
    try {
      expect(cache.holdsNothing()).toBe(true)
    } finally {
      cache.close()
    }
  })
})

describe('a run on an empty local cache', () => {
  const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
  const run = async (ws: string): Promise<string> => {
    const proc = Bun.spawn([process.execPath, BIN, 'run', 'build', '--all'], {
      cwd: ws,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1', VX_TIMING: '1' },
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(`${code}\n${err}`).toStartWith('0\n')
    return out + err
  }
  const probed = (out: string): boolean => /^\s*stable keys\s/m.test(out)

  it('keys no task up front; the next run, with an entry, does', async () => {
    const ws = await makeWorkspace({ prefix: 'vx-holds-nothing-run-' })
    try {
      await addProject(ws, 'a', {
        config: `export default { tasks: { build: {
  exec: { command: 'echo a > out.txt' },
  cache: { inputs: { files: ['package.json'] }, outputs: { files: ['out.txt'] } },
} } }
`,
      })
      const first = await run(ws)
      const second = await run(ws)
      expect({ first: probed(first), second: probed(second) }).toEqual({
        first: false,
        second: true,
      })
      expect(second).toContain('1 up-to-date')
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }, 30_000)
})
