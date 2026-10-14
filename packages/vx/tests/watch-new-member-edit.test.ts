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

it('an edit in a package added mid-watch, made while its first cycle still runs, is a cycle', async () => {
  root = await makeWorkspace({ prefix: 'vx-watch-newpkg-' })
  outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-newpkg-log-'))
  const log = path.join(outside, 'runs.log')
  const marker = path.join(outside, 'slow-started')
  // Uncached: runs every cycle, so the cycle the new package starts lasts ~3 s.
  const slow = `export default { tasks: { build: { exec: { command: 'touch ${marker}; sleep 3' } } } }`
  const fresh = {
    config: `export default { tasks: { build: {
      exec: { command: 'mkdir -p dist && cp src/a.txt dist/ && echo "fresh $(cat src/a.txt)" >> ${log}' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
    } } }`,
    files: { 'src/a.txt': '1' },
  }
  // A cycle reads configs from the lock. A twin workspace that already
  // holds fresh writes the lock that names it, so fresh's first cycle runs
  // it rather than failing on a lock that does not.
  const twin = await makeWorkspace({ prefix: 'vx-watch-newpkg-twin-', dir: outside })
  await addProject(twin, 'slow', slow)
  await addProject(twin, 'fresh', fresh)
  const locked = Bun.spawnSync([process.execPath, BIN, 'lock'], { cwd: twin, stderr: 'pipe' })
  expect([locked.exitCode, locked.stderr.toString()]).toEqual([0, ''])
  await addProject(root, 'slow', slow)
  w = startWatch(root)
  const ww = w
  await until(() => ww.out().includes('watching '), 'watching')
  // The lock lands first, and fresh only once the lock's cycle has re-armed:
  // added during a cycle, fresh would be armed at that cycle's end, before
  // it ever ran.
  await writeFile(
    path.join(root, '.vx', 'projects.lock.json'),
    await readFile(path.join(twin, '.vx', 'projects.lock.json')),
  )
  await until(
    () => ww.out().split('watching 1 project ').length - 1 === 2,
    're-armed after the cycle the lock started',
  )
  await rm(marker, { force: true })
  await addProject(root, 'fresh', fresh)
  const runs = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean)
  await until(
    async () => (await runs()).includes('fresh 1') && (await Bun.file(marker).exists()),
    'fresh#build in the cycle the package started',
  )
  // The cycle is still in slow#build's sleep: fresh is not armed yet.
  await writeFile(path.join(root, 'packages', 'fresh', 'src', 'a.txt'), '2')
  await until(() => ww.out().includes('watching 2 projects'), 'the re-arm')
  await Bun.sleep(SETTLE_MS * 2)
  expect(await runs()).toEqual(['fresh 1', 'fresh 2'])
}, 40_000)
