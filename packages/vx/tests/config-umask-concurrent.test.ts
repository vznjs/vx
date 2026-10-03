// Bun's `process.umask()` with no argument reads the mask by setting 0 and
// putting it back, so two threads reading at once see each other's 0 and
// can leave the process at 0: four workers reading it 200,000 times each
// left it there in every run. Config loading read it on the main thread
// around each first load while the config worker read it around each
// repeat load, so a round holding both refused an innocent config as
// "changed process.umask" (show-info.test went red under load) or left vx
// writing world-writable files. Only the main thread reads it now, and
// only when nothing else evaluates.
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { loadProjectConfigs } from '../src/workspace/project-loader.js'

const innocent = 'export default { tasks: {} }\n'

it('a round mixing first and repeat loads keeps the umask and refuses nobody', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-umask-mix-'))
  const mask = process.umask()
  const seen: string[] = []
  try {
    for (let round = 0; round < 8; round++) {
      const files = await Promise.all(
        Array.from({ length: 48 }, async (_, i) => {
          const file = path.join(dir, `r${round}`, `p${i}`, 'vx.config.mjs')
          await Bun.write(file, innocent)
          return file
        }),
      )
      // Half loaded once already: the next round evaluates those in the
      // worker and the rest in this process, at the same time.
      await loadProjectConfigs(files.filter((_, i) => i % 2 === 0))
      const message = await loadProjectConfigs(files).then(
        () => 'loaded',
        (err: Error) => err.message.replaceAll(dir, '<dir>'),
      )
      seen.push(
        `${message}; umask ${process.umask() === mask ? 'kept' : process.umask().toString(8)}`,
      )
    }
  } finally {
    process.umask(mask)
    await rm(dir, { recursive: true, force: true })
  }
  expect(seen).toEqual(Array.from({ length: 8 }, () => 'loaded; umask kept'))
}, 60_000)

// The race is nanoseconds wide, so the rows above pass either way; these
// count the reads that made it. A config evaluated in the worker wraps the
// worker's `process.umask` and logs each later call: the worker read it
// after every repeat load. This thread's reads are counted through its
// own wrapper: it read once per first load, while the worker evaluated.
it('a mixed round reads the umask on the main thread only, before and after', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-umask-reads-'))
  const log = path.join(dir, 'worker-reads.log')
  const spy = `import { isMainThread } from 'node:worker_threads'
import { appendFileSync } from 'node:fs'
if (!isMainThread) {
  const read = process.umask.bind(process)
  process.umask = (...a) => (appendFileSync(${JSON.stringify(log)}, 'read\\n'), read(...a))
}
export default { tasks: {} }
`
  const real = process.umask
  let mainReads = 0
  try {
    const files = await Promise.all(
      Array.from({ length: 6 }, async (_, i) => {
        const file = path.join(dir, `p${i}`, 'vx.config.mjs')
        await Bun.write(file, i % 2 === 0 ? spy : innocent)
        return file
      }),
    )
    await loadProjectConfigs(files.filter((_, i) => i % 2 === 0))
    process.umask = ((...a: [number?]) => {
      mainReads++
      return real.apply(process, a as [number])
    }) as typeof process.umask
    expect(await loadProjectConfigs(files).then(() => 'loaded')).toBe('loaded')
  } finally {
    process.umask = real
  }
  const workerReads = await Bun.file(log)
    .text()
    .catch(() => '')
  await rm(dir, { recursive: true, force: true })
  expect({ mainReads, workerReads: workerReads.split('\n').filter(Boolean).length }).toEqual({
    mainReads: 2,
    workerReads: 0,
  })
})

// A blaming worker is ended once it answers or outlives its budget, and an
// ended worker puts nothing back: the round restores the umask itself after
// each blame. This config moves it everywhere and, in the blaming worker,
// never finishes, so only that restore can keep the mask.
it('a blame that outlives its budget leaves the umask as it found it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-umask-blame-'))
  const mask = process.umask()
  const budget = process.env['VX_CONFIG_WORKER_TIMEOUT_MS']
  process.env['VX_CONFIG_WORKER_TIMEOUT_MS'] = '300'
  const hangs = `import { isMainThread } from 'node:worker_threads'
process.umask(0o777)
if (!isMainThread) await new Promise(() => {})
export default { tasks: {} }
`
  let moved: string
  try {
    const files = await Promise.all(
      [innocent, hangs, innocent].map(async (src, i) => {
        const file = path.join(dir, `p${i}`, 'vx.config.mjs')
        await Bun.write(file, src)
        return file
      }),
    )
    const message = await loadProjectConfigs(files).then(
      () => 'loaded',
      (err: Error) => err.message,
    )
    expect(message).toStartWith('a project config changed process.umask')
    moved =
      process.umask() === mask ? 'umask kept' : `umask moved to ${process.umask().toString(8)}`
  } finally {
    process.umask(mask)
    if (budget === undefined) delete process.env['VX_CONFIG_WORKER_TIMEOUT_MS']
    else process.env['VX_CONFIG_WORKER_TIMEOUT_MS'] = budget
    await rm(dir, { recursive: true, force: true })
  }
  expect(moved).toBe('umask kept')
})
