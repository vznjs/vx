// A save and an ingest index the same artifact the same way: both read
// the rows out of the bytes — the save its own, the ingest a remote's —
// so `isOutputsCurrent` compares the restored tree against rows that
// name what the restore materialises, whichever path stored the entry.
// Item 616 tried indexing a save from its pack plan instead (no decode of
// its own bytes) and measured a 2–3 % tie on the cold run, so the decode
// stays as the save path's self-check; this is the agreement it must
// keep, held in both directions: the rows a save writes, the rows a scan
// of its bytes reads, and the rows an ingest of those bytes writes.
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { scanArtifact } from '../src/cache/archive.js'
import { Cache } from '../src/cache/cache.js'
import { decodedTar } from '../src/cache/zstd.js'

let root: string
let cache: Cache

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-save-plan-'))
  cache = new Cache(path.join(root, 'cache'))
})
afterEach(async () => {
  cache.close()
  await rm(root, { recursive: true, force: true })
})

interface Row {
  path: string
  size_bytes: number
  mode: number
  mtime_ms: number
}

function rows(c: Cache, hash: string): Row[] {
  return c
    .dbHandle()
    .query(
      'SELECT path, size_bytes, mode, mtime_ms FROM output_files WHERE entry_hash = ? ORDER BY path',
    )
    .all(hash) as Row[]
}

describe('a save and an ingest of the same bytes index the same rows', () => {
  it('output rows, stdout and usage are identical across save, a scan of the saved bytes, and an ingest of them', async () => {
    const projectDir = path.join(root, 'proj')
    await mkdir(path.join(projectDir, 'dist', 'bin'), { recursive: true })
    const text = path.join(projectDir, 'dist', 'a.txt')
    const script = path.join(projectDir, 'dist', 'bin', 'run.sh')
    await writeFile(text, 'alpha\n')
    await writeFile(script, '#!/bin/sh\necho hi\n')
    // Explicit modes: the gate's shards run as a user whose umask leaves a
    // fresh file 0o664, and the row must not depend on who runs the suite.
    await chmod(text, 0o644)
    await chmod(script, 0o755)
    // Distinct, old, sub-second-free mtimes: the rows carry milliseconds.
    await utimes(text, new Date('2020-01-02T03:04:05.678Z'), new Date('2020-01-02T03:04:05.678Z'))
    await utimes(script, new Date('2021-06-07T08:09:10.123Z'), new Date('2021-06-07T08:09:10.123Z'))
    await cache.save({
      hash: 'h-plan',
      projectDir,
      outputFiles: [text, script],
      entry: {
        taskId: 'pkg#build',
        command: 'make',
        durationMs: 42,
        stdout: 'built\n',
        cpuMs: 7500,
        peakRssBytes: 512 * 1024 * 1024,
      },
    })
    const saved = rows(cache, 'h-plan')
    expect(saved.map((r) => r.path)).toEqual(['dist/a.txt', 'dist/bin/run.sh'])
    expect(saved.map((r) => [r.mode, r.mtime_ms])).toEqual([
      [0o644, Date.parse('2020-01-02T03:04:05.678Z')],
      [0o755, Date.parse('2021-06-07T08:09:10.123Z')],
    ])

    // The scan of the bytes the save wrote says the same.
    const bytes = await Bun.file(cache.outputsPath('h-plan')).bytes()
    const scanned = await scanArtifact(await decodedTar(bytes, 'h-plan'))
    const fromScan = scanned.entries
      .filter((e) => e.name.startsWith('outputs/'))
      .map((e) => ({
        path: e.name.slice('outputs/'.length),
        size_bytes: e.size,
        mode: e.mode,
        mtime_ms: e.mtimeMs,
      }))
      .sort((a, b) => (a.path < b.path ? -1 : 1))
    expect(fromScan).toEqual(saved)
    expect({ stdout: scanned.stdout, exec: scanned.exec }).toEqual({
      stdout: 'built\n',
      exec: { cpuMs: 7500, peakRssBytes: 512 * 1024 * 1024 },
    })

    // And an ingest of those bytes — the path that DOES scan — lands the
    // same rows and the same entry.
    const other = new Cache(path.join(root, 'other'))
    try {
      await other.ingest('h-plan', bytes, { taskId: 'pkg#build', command: 'make', durationMs: 42 })
      expect(rows(other, 'h-plan')).toEqual(saved)
      const [a, b] = [await cache.get('h-plan'), await other.get('h-plan')]
      expect({ stdout: b?.stdout, cpuMs: b?.cpuMs, peakRssBytes: b?.peakRssBytes }).toEqual({
        stdout: a?.stdout,
        cpuMs: a?.cpuMs,
        peakRssBytes: a?.peakRssBytes,
      })
    } finally {
      other.close()
    }
  })

  it('a saved entry with no outputs and no usage indexes nothing but the entry, as an ingest of it does', async () => {
    const projectDir = path.join(root, 'empty')
    await mkdir(projectDir, { recursive: true })
    await cache.save({
      hash: 'h-empty',
      projectDir,
      outputFiles: [],
      entry: { taskId: 'pkg#lint', command: 'lint', durationMs: 1, stdout: '' },
    })
    expect(rows(cache, 'h-empty')).toEqual([])
    const got = await cache.get('h-empty')
    expect({ stdout: got?.stdout, cpuMs: got?.cpuMs, rss: got?.peakRssBytes }).toEqual({
      stdout: '',
      cpuMs: undefined,
      rss: undefined,
    })
    const other = new Cache(path.join(root, 'other-empty'))
    try {
      const bytes = await Bun.file(cache.outputsPath('h-empty')).bytes()
      await other.ingest('h-empty', bytes, { taskId: 'pkg#lint', command: 'lint', durationMs: 1 })
      expect(rows(other, 'h-empty')).toEqual([])
      expect((await other.get('h-empty'))?.stdout).toBe('')
    } finally {
      other.close()
    }
  })
})
