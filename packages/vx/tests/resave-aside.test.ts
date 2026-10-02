// A re-save of a key moves the previous artifact aside before the new one
// takes its name: ext4 flushes the incoming file when a rename replaces a
// file (0.55 ms against 0.04 per save, on the main thread with the write
// lock held). `node:fs` is wrapped to record whether each rename's
// destination existed; every call passes through.
import * as fs from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const realFs = { ...fs }
/** Each rename into the cache dir: its destination, and whether it existed. */
const renames: Array<{ to: string; existed: boolean }> = []
let watched = ''
await mock.module('node:fs', () => ({
  ...realFs,
  renameSync: ((from: fs.PathLike, to: fs.PathLike) => {
    if (watched !== '' && String(to).startsWith(watched))
      renames.push({ to: String(to), existed: realFs.existsSync(to) })
    return realFs.renameSync(from, to)
  }) as typeof fs.renameSync,
}))
const { Cache } = await import('../src/cache/index.js')

const HASH = '0123456789abcdef'

describe('a re-save of a key', () => {
  let root: string
  let cacheDir: string
  let projectDir: string
  let cache: InstanceType<typeof Cache>
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-resave-'))
    cacheDir = path.join(root, 'cache')
    projectDir = path.join(root, 'pkg')
    await mkdir(path.join(projectDir, 'dist'), { recursive: true })
    cache = new Cache(cacheDir)
    watched = cacheDir + path.sep
    renames.length = 0
  })
  afterEach(async () => {
    watched = ''
    cache.close()
    await rm(root, { recursive: true, force: true })
  })

  const save = async (body: string): Promise<void> => {
    const out = path.join(projectDir, 'dist', 'out.txt')
    await writeFile(out, body)
    await cache.save({
      hash: HASH,
      projectDir,
      outputFiles: [out],
      entry: { taskId: 'pkg#build', command: 'build', durationMs: 1, stdout: body },
    })
  }

  it('never renames onto an existing artifact, serves the new bytes and leaves no aside', async () => {
    await save('first')
    await save('second')
    const final = path.join(cacheDir, `${HASH}.tar.zst`)
    expect(renames.filter((r) => r.to === final).map((r) => r.existed)).toEqual([false, false])
    expect(renames.filter((r) => r.existed)).toEqual([])

    const names = (await readdir(cacheDir)).filter((n) => !n.startsWith('cache.db'))
    expect(names.sort()).toEqual(['.gitignore', `${HASH}.tar.zst`])
    expect((await cache.get(HASH))?.stdout).toBe('second')
    await rm(path.join(projectDir, 'dist'), { recursive: true, force: true })
    await cache.restoreOutputs(HASH, projectDir)
    expect(await readFile(path.join(projectDir, 'dist', 'out.txt'), 'utf8')).toBe('second')
  })
})
