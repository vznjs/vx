import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
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

// The lock that adds a project is a cycle that re-reads the set before the
// run keys anything (X-138): armed only after, an edit in the new project
// while its first cycle ran fell in the gap and ran nothing.
it('an edit in a project added mid-watch, made while its first cycle still runs, is a cycle', async () => {
  root = await makeWorkspace({ prefix: 'vx-watch-newpkg-' })
  outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-newpkg-log-'))
  const log = path.join(outside, 'runs.log')
  const marker = path.join(outside, 'slow-started')
  // Uncached: runs every cycle, so the cycle the lock starts lasts ~3 s.
  await addProject(
    root,
    'slow',
    `export default { tasks: { build: { exec: { command: 'touch ${marker}; sleep 3' } } } }`,
  )
  w = startWatch(root)
  const ww = w
  await until(() => ww.out().includes('vx watch: watching'), 'watching')
  await rm(marker, { force: true })
  await addProject(root, 'fresh', {
    config: `export default { tasks: { build: {
      exec: { command: 'mkdir -p dist && cp src/a.txt dist/ && echo "fresh $(cat src/a.txt)" >> ${log}' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
    } } }`,
    files: { 'src/a.txt': '1' },
  })
  const locked = Bun.spawnSync([process.execPath, BIN, 'lock'], {
    cwd: root,
    stderr: 'pipe',
    env: { ...process.env, VX_LOCK_REVIEW_FILES: 'false' },
  })
  expect([locked.exitCode, locked.stderr.toString()]).toEqual([0, ''])
  const runs = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean)
  await until(
    async () => (await runs()).includes('fresh 1') && (await Bun.file(marker).exists()),
    'fresh#build in the cycle the lock started',
  )
  // The cycle is still in slow#build's sleep.
  await writeFile(path.join(root, 'packages', 'fresh', 'src', 'a.txt'), '2')
  await until(() => ww.out().includes('watching 2 project(s)'), 'the re-arm')
  await Bun.sleep(SETTLE_MS * 2)
  expect(await runs()).toEqual(['fresh 1', 'fresh 2'])
}, 40_000)
