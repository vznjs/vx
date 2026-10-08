// `vx watch`'s stop closes the pool while the cycle in flight may still be
// re-arming (`rearm`: a re-read, new arms, their proofs). Until the pool
// held its own closed state, an arm made after `closeAll` was a live
// watcher, and one closed before its proof settled failed that proof and
// had a poller swapped in: a 250 ms interval nothing closes, and a
// "polling instead" line after the stop.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'bun:test'
import { WatcherPool } from '../src/cli/watch-fs.js'

const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'vx-pool-'))
  dirs.push(d)
  return d
}

/** Past two poll intervals (250 ms): a poller left running has sampled the write. */
const SAMPLED_MS = 700

it('a watcher closed before its proof settled is not replaced by a poller', async () => {
  const dir = await tempDir()
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const closed = new WatcherPool(() => false)
  const control = new WatcherPool(() => false)
  const seen: string[] = []
  const controlSeen: string[] = []
  closed.arm(dir, false, (f) => seen.push(f))
  closed.closeAll()
  await closed.proved()
  control.arm(dir, false, (f) => controlSeen.push(f))
  await control.proved()
  await writeFile(path.join(dir, 'edit.txt'), 'x')
  await Bun.sleep(SAMPLED_MS)
  control.closeAll()
  expect(controlSeen).toContain('edit.txt')
  expect(seen).toEqual([])
  // Only the pool's own lines: they name the dir. Another file in the shard
  // writes to stderr from its own async work while this row waits.
  expect(stderr.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(dir))).toEqual([])
}, 10_000)

it('an arm made after closeAll watches nothing', async () => {
  const dir = await tempDir()
  const pool = new WatcherPool(() => false)
  const control = new WatcherPool(() => false)
  const seen: string[] = []
  const controlSeen: string[] = []
  pool.closeAll()
  pool.arm(dir, false, (f) => seen.push(f))
  control.arm(dir, false, (f) => controlSeen.push(f))
  await Promise.all([pool.proved(), control.proved()])
  await writeFile(path.join(dir, 'edit.txt'), 'x')
  await Bun.sleep(SAMPLED_MS)
  control.closeAll()
  expect(controlSeen).toContain('edit.txt')
  expect(seen).toEqual([])
}, 10_000)
