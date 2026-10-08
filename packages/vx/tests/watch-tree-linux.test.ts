// On Linux a recursive `fs.watch` is one inotify watch per directory, and
// Bun's descended into `node_modules`, `.git` and `.vx`, whose events the
// loop drops by name (`IGNORED_SEGMENTS`): this repo's root arm held 4,657
// watches where 438 directories can matter, 40–55 ms of the arm, and a
// big monorepo's `node_modules` meets the OS watch limit (8,192 on many
// distros) and falls back to polling. The recursive arm walks the tree
// itself and never enters them; directories that appear are watched, and
// what lands in them before their watch is reported.

import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'bun:test'
import { armWatcher } from '../src/cli/watch-fs.js'

async function until(ok: () => boolean, what: string): Promise<void> {
  const start = Date.now()
  while (!ok()) {
    if (Date.now() - start > 3_000) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}

async function armed(prepare: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-tree-'))
  await prepare(dir)
  const seen: string[] = []
  const w = armWatcher(dir, true, (f) => seen.push(f))
  expect(await w.ready).toBe(true)
  return {
    dir,
    seen,
    async end() {
      w.watcher.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

describe.skipIf(process.platform !== 'linux')('the recursive arm on Linux', () => {
  it('never reports a write under node_modules, .git or .vx; one beside them is', async () => {
    const t = await armed(async (dir) => {
      for (const d of ['node_modules/pkg/lib', '.git/objects', '.vx', 'src'])
        await mkdir(path.join(dir, d), { recursive: true })
    })
    try {
      await writeFile(path.join(t.dir, 'node_modules/pkg/lib/x.js'), 'x')
      await writeFile(path.join(t.dir, '.git/objects/o'), 'x')
      await writeFile(path.join(t.dir, '.vx/cache.db'), 'x')
      await writeFile(path.join(t.dir, 'src/a.ts'), 'x')
      await until(() => t.seen.includes('src/a.ts'), 'the src edit')
      await Bun.sleep(100)
      expect(t.seen.filter((f) => /node_modules|\.git|\.vx/.test(f))).toEqual([])
    } finally {
      await t.end()
    }
  })

  // Controls: what the recursive watcher delivered, it still does.
  it('a directory made after the arm is watched, and a file already in it is reported', async () => {
    const t = await armed(async () => {})
    try {
      await mkdir(path.join(t.dir, 'a/b'), { recursive: true })
      await writeFile(path.join(t.dir, 'a/b/early.txt'), 'x')
      await until(() => t.seen.includes('a/b/early.txt'), 'the file written with its directory')
      await Bun.sleep(50)
      await writeFile(path.join(t.dir, 'a/b/late.txt'), 'x')
      await until(() => t.seen.includes('a/b/late.txt'), 'the later write in the new directory')
    } finally {
      await t.end()
    }
  })

  it('a directory moved within the tree reports under its new name only', async () => {
    const t = await armed(async (dir) => {
      await mkdir(path.join(dir, 'old/sub'), { recursive: true })
    })
    try {
      await rename(path.join(t.dir, 'old'), path.join(t.dir, 'new'))
      await until(() => t.seen.includes('new'), 'the move')
      await Bun.sleep(50)
      t.seen.length = 0
      await writeFile(path.join(t.dir, 'new/sub/f.txt'), 'x')
      await until(() => t.seen.includes('new/sub/f.txt'), 'the write under the new name')
      await Bun.sleep(50)
      expect(t.seen.filter((f) => f.startsWith('old'))).toEqual([])
    } finally {
      await t.end()
    }
  })

  // A watch holds the inode: a directory removed and made again before its
  // event was handled (`rm -rf gen && mkdir gen`, a checkout) still stats
  // as a directory, and the dead watch on the old one stood in for it.
  it('a directory removed and made again at once is watched again', async () => {
    const t = await armed(async (dir) => {
      await mkdir(path.join(dir, 'gen'))
    })
    try {
      fs.rmSync(path.join(t.dir, 'gen'), { recursive: true })
      fs.mkdirSync(path.join(t.dir, 'gen'))
      await until(() => t.seen.includes('gen'), 'the directory made again')
      await Bun.sleep(50)
      await writeFile(path.join(t.dir, 'gen/f.txt'), 'x')
      await until(() => t.seen.includes('gen/f.txt'), 'the write in the new directory')
    } finally {
      await t.end()
    }
  })

  // At the OS watch limit the recursive form threw, and the pool polled
  // instead (E-49). A walk that swallowed the refusal for a subdirectory
  // would arm half a tree without a word.
  describe('at the watch limit', () => {
    afterEach(() => vi.restoreAllMocks())
    it('a subdirectory refused mid-walk fails the arm, its watches closed', async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-tree-limit-'))
      await mkdir(path.join(dir, 'a'))
      const real = fs.watch.bind(fs)
      let closed = 0
      let calls = 0
      vi.spyOn(fs, 'watch').mockImplementation(((...args: Parameters<typeof fs.watch>) => {
        if (++calls === 2)
          throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' })
        const w = real(...args)
        const close = w.close.bind(w)
        w.close = () => {
          closed++
          close()
        }
        return w
      }) as typeof fs.watch)
      try {
        let code: unknown
        try {
          armWatcher(dir, true, () => {})
        } catch (err) {
          code = (err as NodeJS.ErrnoException).code
        }
        expect({ code, closed }).toEqual({ code: 'ENOSPC', closed: 1 })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  })
})
