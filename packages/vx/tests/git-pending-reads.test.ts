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
