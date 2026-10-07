// What `vx watch` watches when a task is anchored (`pkg#task`): the
// anchored task's own project joins the bare tasks' scope, and with only
// anchored tasks it is the whole scope. The scope came from `--filter` /
// the cwd alone, so `vx watch lib#build` watched every project and
// `vx watch test other#test` run in `lib` never heard an edit in `other`.

import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { SETTLE_MS, startWatch, until, type Watch } from './helpers/watch-loop.js'

describe('vx watch with anchored tasks (e2e)', () => {
  let root = ''
  let outside = ''
  let log = ''
  let watch: Watch | undefined

  const task = (id: string) =>
    `{ exec: { command: 'echo ${id} >> ${log}' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } } }`
  const ran = async (): Promise<string[]> =>
    (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean)

  beforeEach(async () => {
    root = await realpath(await makeWorkspace({ prefix: 'vx-watch-anchored-' }))
    outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-watch-anchored-log-')))
    log = path.join(outside, 'runs.log')
    await addProject(root, 'lib', {
      config: `export default { tasks: { build: ${task('lib#build')}, test: ${task('lib#test')} } }\n`,
      files: { 'src/a.txt': 'a1\n' },
    })
    await addProject(root, 'other', {
      config: `export default { tasks: { test: ${task('other#test')} } }\n`,
      files: { 'src/a.txt': 'o1\n' },
    })
  })
  afterEach(async () => {
    if (watch !== undefined) {
      watch.proc.kill('SIGTERM')
      await watch.proc.exited
      watch = undefined
    }
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it('only anchored tasks watch their own projects, not every project (X-38)', async () => {
    watch = startWatch(root, [], {}, 'lib#build')
    const w = watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    expect(w.out()).toContain('vx watch: watching 1 project(s)')

    await writeFile(path.join(root, 'packages', 'other', 'src', 'a.txt'), 'o2\n')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(0)
    // CONTROL: an edit in the anchored project is heard.
    await writeFile(path.join(root, 'packages', 'lib', 'src', 'a.txt'), 'a2\n')
    await until(() => w.cycles() === 1, 'the cycle the lib edit starts')
    await Bun.sleep(SETTLE_MS)
    expect({ cycles: w.cycles(), ran: await ran() }).toEqual({
      cycles: 1,
      ran: ['lib#build', 'lib#build'],
    })
  }, 40_000)

  it("a bare task beside an anchored one watches the anchored task's project too (X-38)", async () => {
    watch = startWatch(path.join(root, 'packages', 'lib'), ['other#test'], {}, 'test')
    const w = watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    expect(w.out()).toContain('vx watch: watching 2 project(s)')

    await writeFile(path.join(root, 'packages', 'other', 'src', 'a.txt'), 'o2\n')
    await until(() => w.cycles() === 1, 'the cycle the other edit starts')
    await until(async () => (await ran()).length === 3, 'the other#test the edit runs')
    await Bun.sleep(SETTLE_MS)
    expect({ cycles: w.cycles(), ran: (await ran()).toSorted() }).toEqual({
      cycles: 1,
      ran: ['lib#test', 'other#test', 'other#test'],
    })
  }, 40_000)

  it("a pkg#task naming no project exits 1 with the run's own refusal (X-38)", async () => {
    watch = startWatch(root, [], {}, 'lbi#build')
    const w = watch
    expect(await w.proc.exited).toBe(1)
    await until(() => w.err().length > 0, 'the refusal')
    expect(w.err()).toBe(
      'vx watch: no projects declare task(s): lbi#build. Did you mean lib#build?\n',
    )
  }, 40_000)
})
