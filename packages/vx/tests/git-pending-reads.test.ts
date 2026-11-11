import { expect, it } from 'bun:test'
import { GitFilesCache } from '../src/cache/index.js'

it('reads each changed path once per input glob, across the tasks that ask', () => {
  const cache = new GitFilesCache()
  cache.set('/p', ['a.txt'])
  let reads = 0
  const glob = new Bun.Glob('src/**')
  const counted = Object.assign(Object.create(glob) as Bun.Glob, {
    match: (rel: string) => (reads++, glob.match(rel)),
  })
  for (let t = 0; t < 200; t++) {
    cache.markOutputsChanged('/p', [`out/d${t}/v`])
    expect(cache.snapshotFor('/p', [counted])).toEqual(['a.txt'])
  }
  // Read from the start for each task: 20 100 reads for 200 tasks, 10 s
  // of a 9000-task run writing into one project (2026-10-25).
  expect(reads).toBe(200)
  cache.markOutputsChanged('/p', ['src/x.ts'])
  expect(cache.snapshotFor('/p', [counted])).toBeUndefined()
  expect(cache.snapshotFor('/p', [counted])).toBeUndefined()
  expect(reads).toBe(201)
  cache.set('/p', ['a.txt'])
  expect(cache.snapshotFor('/p', [counted])).toEqual(['a.txt'])
})

it('keeps a file identity until a write to it, and none hashed before one', () => {
  const cache = new GitFilesCache()
  cache.set('/p', ['a.txt'])
  const at = cache.factsEpoch
  cache.learnIdentities(new Map([['/p/a.txt', '100644:aa']]), at)
  expect(cache.identityOf('/p/a.txt')).toBe('100644:aa')
  // A marked write takes its own paths' identities, not the others'.
  cache.markOutputsChanged('/p', ['out/x'])
  expect(cache.identityOf('/p/a.txt')).toBe('100644:aa')
  cache.markOutputsChanged('/p', ['a.txt'])
  expect(cache.identityOf('/p/a.txt')).toBeUndefined()
  // Hashed while the facts stood at `at`, learned after the write: the
  // bytes it names may be gone.
  cache.learnIdentities(new Map([['/p/a.txt', '100644:aa']]), at)
  expect(cache.identityOf('/p/a.txt')).toBeUndefined()
  cache.learnIdentities(new Map([['/p/a.txt', '100644:bb']]), cache.factsEpoch)
  expect(cache.identityOf('/p/a.txt')).toBe('100644:bb')
  // A listing again writes nothing; an undeclared write may have moved anything.
  cache.set('/p', ['a.txt'])
  expect(cache.identityOf('/p/a.txt')).toBe('100644:bb')
  cache.delete('/p')
  expect(cache.identityOf('/p/a.txt')).toBeUndefined()
  cache.learnIdentities(new Map([['/p/a.txt', '100644:bb']]), cache.factsEpoch)
  cache.clear()
  expect(cache.identityOf('/p/a.txt')).toBeUndefined()
})
