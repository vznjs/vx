// What `vx watch` hears at the workspace root (hunt 20, X-136, X-137): a
// `.gitignore` edit changes what every key reads, and `//#task` names the
// root project as the run names it.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { BIN, NOT_CI, SETTLE_MS, startWatch, until, type Watch } from './helpers/watch-loop.js'

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
    ["a project's parent", 'packages/.gitignore'],
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
          inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } } } } }`,
      )
      await mkdir(path.join(dir, 'src'), { recursive: true })
      await writeFile(path.join(dir, 'src', 'a.txt'), 'a\n')
      await writeFile(path.join(dir, 'src', 'gen.txt'), 'gen\n')
      await writeFile(path.join(root, at), 'gen.txt\n')
      w = startWatch(root)
      const ww = w
      await until(() => ww.out().includes('watching '), 'watching')
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
        inputs: { files: ['tools/**'] }, cache: { outputs: { files: [] } } } } }`,
    )
    await mkdir(path.join(root, 'tools'))
    await writeFile(path.join(root, 'tools', 't.txt'), '1\n')
    w = startWatch(root, [], {}, '//#check')
    const ww = w
    const exited = await Promise.race([
      ww.proc.exited,
      until(() => ww.out().includes('watching '), 'watching').then(() => 'watching'),
    ])
    expect({ exited, err: ww.err() }).toEqual({ exited: 'watching', err: '' })
    await writeFile(path.join(root, 'tools', 't.txt'), '2\n')
    await until(async () => (await runs(log)) === 2, 'the re-run')
  }, 30_000)

  // Started with no lock, the root had no name yet: `//` resolved once, to
  // nothing, and the lock `vx lock` wrote armed no project.
  it('watches the root project once `vx lock` writes the lock it started without', async () => {
    root = await makeWorkspace({ prefix: 'vx-watch-root-unlocked-' })
    outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-root-unlocked-count-'))
    const log = path.join(outside, 'runs.log')
    await writeFile(
      path.join(root, 'vx.config.mjs'),
      `export default { tasks: { check: {
        exec: { command: 'echo run >> ${log}' },
        inputs: { files: ['tools/**'] }, cache: { outputs: { files: [] } } } } }`,
    )
    await mkdir(path.join(root, 'tools'))
    await writeFile(path.join(root, 'tools', 't.txt'), '1\n')
    const proc = Bun.spawn([process.execPath, BIN, 'watch', '//#check'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...NOT_CI, VX_TEST_KILL_GRACE: '200ms' },
    })
    let out = ''
    void (async () => {
      for await (const c of proc.stdout) out += new TextDecoder().decode(c)
    })()
    void (async () => {
      for await (const _ of proc.stderr);
    })()
    w = { proc, out: () => out, err: () => '', cycles: () => 0 }
    await until(() => out.includes('watching '), 'watching')
    const lock = Bun.spawnSync([process.execPath, BIN, 'lock'], {
      cwd: root,
      env: { ...process.env, VX_LOCK_REVIEW_FILES: 'false' },
    })
    expect(lock.exitCode).toBe(0)
    await until(async () => (await runs(log)) === 1, 'the locked run')
    await Bun.sleep(SETTLE_MS)
    // The cache's own `.vx/.gitignore` write starts no cycle: the lock's is the one.
    expect({ runs: await runs(log), cycles: out.split('\nchanged ').length - 1 }).toEqual({
      runs: 1,
      cycles: 1,
    })
    await writeFile(path.join(root, 'tools', 't.txt'), '2\n')
    await until(async () => (await runs(log)) === 2, 'the re-run')
  }, 30_000)
})
