// A task that rewrites its own input in place with a tool that writes even
// when nothing changed (`sort -o`, `sed -i`): every run moves the input
// under its key, the entry is withheld, and the moved input started the
// next cycle, which rewrote it again: ~9 cycles a second, forever, from one
// edit. Two runs in a row from the same bytes that each leave them as they
// were are the task's own rewrite: the second settles. A user's edit while
// such a run runs still starts a cycle (`watch-loop-edit-undone.test.ts`
// holds the edit put back).

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { SETTLE_MS, startWatch, until, type Watch } from './helpers/watch-loop.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const made: string[] = []
let watch: Watch | undefined
afterEach(async () => {
  watch?.proc.kill('SIGTERM')
  await watch?.proc.exited
  watch = undefined
  await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const runs = async (log: string): Promise<number> =>
  (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).length

async function fixture(command: (outside: string) => string) {
  const root = await makeWorkspace({ prefix: 'vx-watch-own-rewrite-' })
  const outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-own-rewrite-out-'))
  made.push(root, outside)
  const log = path.join(outside, 'log')
  const dir = await addProject(
    root,
    'app',
    `export default { tasks: { fmt: {
      exec: { command: '${command(outside)}' },
      inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true,
    } } }`,
  )
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(path.join(dir, 'src', 'a.txt'), 'b\na\n')
  return { root, outside, log, src: path.join(dir, 'src', 'a.txt') }
}

it('a task that always rewrites its input in place settles after an edit', async () => {
  const f = await fixture((o) => `sort -o src/a.txt src/a.txt; echo run >> ${o}/log`)
  watch = startWatch(f.root, ['--all'], {}, 'fmt')
  const w = watch
  await until(() => w.out().includes('watching '), 'the watching marker')
  await until(async () => (await runs(f.log)) >= 1, 'the initial run')
  await Bun.sleep(SETTLE_MS)
  const initial = await runs(f.log)

  await writeFile(f.src, 'd\nc\n')
  await until(async () => (await runs(f.log)) > initial, 'the edit cycle')
  await Bun.sleep(3 * SETTLE_MS)
  const settled = await runs(f.log)
  // The edit's run and the one that finds the rewrite its own; the loop
  // ran ~9 a second.
  expect(settled - initial).toBeLessThanOrEqual(2)
  await Bun.sleep(SETTLE_MS)
  expect(await runs(f.log)).toBe(settled)
  expect(await readFile(f.src, 'utf8')).toBe('c\nd\n')
  // Its line said the next cycle runs on it: watch says why none did, once.
  const notice = 'packages/app/src/a.txt is rewritten in place by its own task every run'
  expect(w.out().split(notice).length - 1).toBe(1)
}, 40_000)

it('an editor saving over its rewrite mid-run still starts a cycle', async () => {
  const f = await fixture(
    (o) =>
      `sort -o src/a.txt src/a.txt; echo run >> ${o}/log; if [ -f ${o}/gate ]; then touch ${o}/started; while [ ! -f ${o}/go ]; do sleep 0.02; done; fi`,
  )
  watch = startWatch(f.root, ['--all'], {}, 'fmt')
  const w = watch
  await until(() => w.out().includes('watching '), 'the watching marker')
  await until(async () => (await runs(f.log)) >= 1, 'the initial run')
  await Bun.sleep(SETTLE_MS)
  await writeFile(path.join(f.outside, 'gate'), '')
  await writeFile(f.src, 'd\nc\n')
  await until(() => Bun.file(path.join(f.outside, 'started')).exists(), 'the edit cycle to run')
  // The editor saves its buffer again over the task's rewrite: the bytes the
  // judgement that started the cycle saw, so no state differs.
  await writeFile(f.src, 'd\nc\n')
  await rm(path.join(f.outside, 'gate'))
  await writeFile(path.join(f.outside, 'go'), '')
  await until(async () => (await readFile(f.src, 'utf8')) === 'c\nd\n', 'a cycle that sorts it')
  const sorted = await runs(f.log)
  await Bun.sleep(3 * SETTLE_MS)
  expect(await runs(f.log)).toBeLessThanOrEqual(sorted + 1)
}, 40_000)
