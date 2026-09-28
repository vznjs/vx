// A file system that keeps whole seconds (ext3, HFS+, FAT/exFAT, some NFS
// mounts) stamps a write at 12:00:00.900 as 12:00:00. The racy windows were
// 50 ms, which assumes a finer clock: a file written and hashed 120 ms apart
// had a ctime 120 ms old, so its digest was memoised, and a same-size rewrite
// later in that second kept every stat field the memo keys on. The next run
// was a hit on the first bytes' output (A-2, reproduced on an ext2 loop
// mount). A whole-second stamp now widens each window by that second.
//
// No such file system mounts in the gate, so its stamps are simulated: the
// ctime the stat reports (`spyOn(fs, 'lstatSync')`, which reaches the named
// imports) or a directory mtime set with `utimes`, and the clock
// (`setSystemTime`). Each row has a control on a sub-second stamp at the same
// age, which a 50 ms window still trusts.

import * as fs from 'node:fs'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn } from 'bun:test'
import { Cache } from '../src/cache/index.js'
import { movedInput } from '../src/orchestrator/task-hash.js'

/** A whole second, well in the past so no real file carries it. */
const SECOND = 1_700_000_000_000

let root: string
let cache: Cache
let stamp: number
const realLstat = fs.lstatSync

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'vx-second-'))
  cache = new Cache(path.join(root, 'cache'))
  // Every stat of a file under the root reports `stamp` for ctime and mtime.
  spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, o?: fs.StatOptions) => {
    const st = realLstat(p, o as never)
    if (st === undefined || !String(p).startsWith(root) || !st.isFile()) return st
    return Object.assign(st, { ctimeMs: stamp, mtimeMs: stamp })
  }) as typeof fs.lstatSync)
})

afterEach(() => {
  setSystemTime()
  ;(fs.lstatSync as unknown as { mockRestore(): void }).mockRestore()
  cache.close()
  rmSync(root, { recursive: true, force: true })
})

/** Write `AAAA`, hash it at `stamp + at` ms, rewrite it `BBBB`, hash again. */
async function rewriteInOneSecond(
  hash: (f: string) => Promise<string>,
  at = 120,
  again = 700,
): Promise<boolean> {
  const f = path.join(root, 'x.txt')
  writeFileSync(f, 'AAAA')
  setSystemTime(new Date(stamp + at))
  const first = await hash(f)
  writeFileSync(f, 'BBBB')
  setSystemTime(new Date(stamp + again))
  const second = await hash(f)
  return second !== first
}

describe('a whole-second stamp', () => {
  it('keeps a file written 120 ms before its hash out of the memo', async () => {
    stamp = SECOND
    expect(await rewriteInOneSecond((f) => cache.hashFile(f))).toBe(true)
    // Control: the same age on a sub-second stamp is memoised, and the memo
    // is what answers the rewrite (its stat did not move).
    stamp = SECOND + 7
    expect(await rewriteInOneSecond((f) => cache.hashFile(f))).toBe(false)
  })

  it('does the same in the batched hash', async () => {
    const batch = async (f: string) => (await cache.hashFiles([f])).get(f)!
    stamp = SECOND
    expect(await rewriteInOneSecond(batch)).toBe(true)
    stamp = SECOND + 7
    expect(await rewriteInOneSecond(batch)).toBe(false)
  })

  // FAT32 keeps even seconds (2 s): a write at 12:00:01.990 is stamped
  // 12:00:00, so a hash 1.99 s after the stamp passed a one-second widening
  // and a same-size rewrite later in those two seconds kept every field. The
  // stamp is an even second that is not a multiple of four, and the hash sits
  // near the pair's end, so a narrower rule or widening is caught too.
  it('keeps a file written 1.99 s before its hash out of the memo on an even second', async () => {
    const one = (f: string) => cache.hashFile(f)
    const batch = async (f: string) => (await cache.hashFiles([f])).get(f)!
    stamp = SECOND + 2000
    expect([stamp % 2000, stamp % 4000]).toEqual([0, 2000])
    expect(await rewriteInOneSecond(one, 1990, 1995)).toBe(true)
    expect(await rewriteInOneSecond(batch, 1990, 1995)).toBe(true)
    // Control: an odd second at the same age is past its window; FAT never
    // writes one, and ext3's second ended 990 ms before the hash.
    stamp = SECOND + 1000
    expect(await rewriteInOneSecond(one, 1990, 1995)).toBe(false)
  })

  it('makes a file stamped in the second of its fact a suspect of the re-check', async () => {
    const f = path.join(root, 'in.txt')
    writeFileSync(f, 'AAAA')
    stamp = SECOND
    setSystemTime(new Date(SECOND + 500))
    const fact = { path: f, digest: await cache.hashFile(f), since: SECOND + 500 }
    // Rewritten later in the same second: the stamp stays SECOND, 500 ms
    // before the fact, outside a 50 ms window.
    writeFileSync(f, 'BBBB')
    setSystemTime(new Date(SECOND + 900))
    expect(await movedInput([fact], cache)).toBe(f)
    // Control: a sub-second stamp 500 ms before the fact is trusted unread.
    stamp = SECOND + 7
    expect(await movedInput([{ ...fact, since: SECOND + 507 }], cache)).toBeUndefined()
  })

  it('makes a file stamped in the second the command started a moved input', async () => {
    const f = path.join(root, 'in.txt')
    writeFileSync(f, 'AAAA')
    stamp = SECOND
    setSystemTime(new Date(SECOND + 300))
    const digest = await cache.hashFile(f)
    // Edited and edited back while the command ran (item 1015): the content
    // matches, only the stamp says it was written, and it reads 300 ms
    // before the command began.
    setSystemTime(new Date(SECOND + 900))
    const fact = { path: f, digest, since: SECOND - 5_000 }
    expect(await movedInput([fact], cache, SECOND + 300)).toBe(f)
    stamp = SECOND + 7
    expect(await movedInput([fact], cache, SECOND + 307)).toBeUndefined()
  })

  it('refuses a directory snapshot whose mtime is in the current second', async () => {
    const proj = path.join(root, 'proj')
    mkdirSync(path.join(proj, 'dist'), { recursive: true })
    writeFileSync(path.join(proj, 'dist', 'a.js'), 'x')
    await cache.save({
      hash: 'h1',
      projectDir: proj,
      outputFiles: [path.join(proj, 'dist', 'a.js')],
      entry: { taskId: 'p#build', command: 'x', durationMs: 1, stdout: '' },
    })
    const snapshotAt = async (mtime: number): Promise<number> => {
      utimesSync(path.join(proj, 'dist'), mtime / 1000, mtime / 1000)
      setSystemTime(new Date(mtime + 120))
      await cache.recordOutputDirs('h1', proj, ['dist'])
      return (cache.loadOutputDirsBatch(['h1']).get('h1') ?? []).length
    }
    expect(await snapshotAt(SECOND)).toBe(0)
    expect(await snapshotAt(SECOND + 7)).toBe(1)
  })
})
