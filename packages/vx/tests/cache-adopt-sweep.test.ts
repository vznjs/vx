import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'

// Adopting a row-less artifact hard-links it to a temp name, and a link
// shares the artifact's inode, so the temp carried the artifact's old
// mtime. Another process's orphan sweep in that window judged the temp a
// crashed save's leftover and unlinked it: the adopt then moved the
// artifact aside, failed its rename with ENOENT, deleted the aside and
// threw out of `get()` — the artifact gone and the lookup an error, not a
// miss.
describe('an adopt beside another process sweeping orphans', () => {
  it('keeps the artifact and hits', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-adopt-sweep-'))
    try {
      const dir = path.join(root, 'cache')
      const projectDir = path.join(root, 'pkg')
      await mkdir(path.join(projectDir, 'dist'), { recursive: true })
      const outFile = path.join(projectDir, 'dist', 'out.txt')
      await writeFile(outFile, 'built\n')
      const hash = '0123456789abcdef'
      const saver = new Cache(dir)
      await saver.save({
        hash,
        projectDir,
        outputFiles: [outFile],
        entry: { taskId: 'pkg#build', command: 'tsc', durationMs: 1, stdout: '' },
      })
      saver.dbHandle().query('DELETE FROM entries WHERE hash = ?').run(hash)
      saver.close()
      const artifact = path.join(dir, `${hash}.tar.zst`)
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
      await utimes(artifact, old, old)

      const adopter = new Cache(dir)
      const sweeper = new Cache(dir)
      const index = adopter as unknown as {
        writeArtifactAndIndex: (...args: unknown[]) => Promise<void>
      }
      const original = index.writeArtifactAndIndex.bind(adopter)
      let swept = false
      index.writeArtifactAndIndex = async (...args: unknown[]) => {
        // CONTROL: the sweep runs while the adopt's temp link exists.
        expect(
          (await readdir(dir)).filter((f) => f.startsWith(`${hash}.tar.zst.tmp-`)),
        ).toHaveLength(1)
        await sweeper.prune({ maxBytes: Number.MAX_SAFE_INTEGER })
        swept = true
        return original(...args)
      }
      try {
        const entry = await adopter.get(hash, { taskId: 'pkg#build', command: 'tsc' })
        expect(swept).toBe(true)
        expect(entry?.hash).toBe(hash)
        expect((await readdir(dir)).filter((f) => f.includes('.tar.zst'))).toEqual([
          `${hash}.tar.zst`,
        ])
      } finally {
        adopter.close()
        sweeper.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
