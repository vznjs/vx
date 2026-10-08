// What `vx watch` hears at the workspace root (hunt 20, X-136, X-137): a
// `.gitignore` edit changes what every key reads, and `//#task` names the
// root project as the run names it.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { BIN, SETTLE_MS, startWatch, until, type Watch } from './helpers/watch-loop.js'

let w: Watch | undefined
let root = ''
let outside = ''
afterEach(async () => {
  if (w) {
    w.proc.kill('SIGTERM')
    await w.proc.exited
    w = undefined
  }
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

const runs = async (log: string): Promise<number> =>
  (await readFile(log, 'utf8').catch(() => '')).split('\n').filter((l) => l === 'run').length

describe('vx watch and .gitignore', () => {
  for (const [where, at] of [
    ['the root', '.gitignore'],
    ['a member base', 'packages/.gitignore'],
  ] as const) {
    it(`un-ignoring an input in ${where} .gitignore re-runs, as \`vx run\` would`, async () => {
      root = await makeWorkspace({ prefix: 'vx-watch-gi-' })
      outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-gi-count-'))
      const log = path.join(outside, 'runs.log')
      const dir = await addProject(
        root,
        'app',
        `export default { tasks: { build: {
          exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt && echo run >> ${log}' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } } } } }`,
      )
      await mkdir(path.join(dir, 'src'), { recursive: true })
      await writeFile(path.join(dir, 'src', 'a.txt'), 'a\n')
      await writeFile(path.join(dir, 'src', 'gen.txt'), 'gen\n')
      await writeFile(path.join(root, at), 'gen.txt\n')
      w = startWatch(root)
      const ww = w
      await until(() => ww.out().includes('vx watch: watching'), 'watching')
      expect(await runs(log)).toBe(1)
      await writeFile(path.join(root, at), '\n')
      await until(async () => (await runs(log)) === 2, 'the re-run')
      await Bun.sleep(SETTLE_MS)
      // The later run hits what the cycle saved: the key it read is the run's.
      Bun.spawnSync([process.execPath, BIN, 'run', 'build', '--all'], { cwd: root })
      expect(await runs(log)).toBe(2)
    }, 30_000)
  }
})

describe('vx watch //#task', () => {
  it('watches the root project, as `vx run //#task` runs it', async () => {
    root = await makeWorkspace({ prefix: 'vx-watch-root-' })
    outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-root-count-'))
    const log = path.join(outside, 'runs.log')
    await writeFile(
      path.join(root, 'vx.config.mjs'),
      `export default { tasks: { check: {
        exec: { command: 'echo run >> ${log}' },
        cache: { inputs: { files: ['tools/**'] }, outputs: { files: [] } } } } }`,
    )
    await mkdir(path.join(root, 'tools'))
    await writeFile(path.join(root, 'tools', 't.txt'), '1\n')
    w = startWatch(root, [], {}, '//#check')
    const ww = w
    const exited = await Promise.race([
      ww.proc.exited,
      until(() => ww.out().includes('vx watch: watching'), 'watching').then(() => 'watching'),
    ])
    expect({ exited, err: ww.err() }).toEqual({ exited: 'watching', err: '' })
    await writeFile(path.join(root, 'tools', 't.txt'), '2\n')
    await until(async () => (await runs(log)) === 2, 'the re-run')
  }, 30_000)
})
