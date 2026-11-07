// A dependency's directory removed failed the cycle's config load, and the
// re-read that followed fell back to no task edges: the watched set shrank
// to the scope alone. The other dependency's edits ran nothing, and the
// removed one coming back was no event, until a `vx lock`.

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { ARMS, arms, startWatch, until } from './helpers/watch-loop.js'

describe('vx watch over a dependency removed and restored', () => {
  it("the scope's dependencies stay watched, and the restored one is heard", async () => {
    const root = await makeWorkspace({ prefix: 'vx-watch-dep-gone-' })
    const outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-dep-gone-log-'))
    const log = path.join(outside, 'runs.log')
    const build = (id: string, deps = '') =>
      `export default { tasks: { build: { exec: { command: 'echo ${id} >> ${log}' }, inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true${deps} } } }\n`
    const app = await addProject(root, 'a', {
      config: build('a', ", dependsOn: ['b#build', 'c#build']"),
      files: { 'src/a.txt': 'a1\n' },
    })
    await addProject(root, 'b', { config: build('b'), files: { 'src/a.txt': 'b1\n' } })
    await addProject(root, 'c', { config: build('c'), files: { 'src/a.txt': 'c1\n' } })
    const ran = async (id: string): Promise<number> =>
      (await readFile(log, 'utf8').catch(() => '')).split('\n').filter((l) => l === id).length
    const b = path.join(root, 'packages', 'b')
    const copy = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-dep-gone-copy-'))
    const w = startWatch(app, [], ARMS)
    try {
      await until(() => w.out().includes('watching '), 'the watching marker')
      expect(w.out()).toContain('watching 3 projects')
      await cp(b, path.join(copy, 'b'), { recursive: true })
      const armed = arms(w)
      await rm(b, { recursive: true, force: true })
      await until(() => arms(w) > armed, 'the re-arm after the failed cycle')
      // The re-read that failed kept all three: it is no proof of fewer.
      expect(arms(w, 1)).toBe(0)
      const restoredFrom = arms(w)
      await cp(path.join(copy, 'b'), b, { recursive: true })
      await until(() => arms(w) > restoredFrom, 'the re-arm after b came back')
      const before = await ran('c')
      await writeFile(path.join(root, 'packages', 'c', 'src', 'a.txt'), 'c2\n')
      await until(async () => (await ran('c')) > before, 'the c edit after b came back')
    } finally {
      w.proc.kill('SIGTERM')
      await w.proc.exited
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
      await rm(copy, { recursive: true, force: true })
    }
  }, 40_000)
})
