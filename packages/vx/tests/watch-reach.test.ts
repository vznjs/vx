// A watch cycle runs again only what the change can reach. A cached task
// already had that answer from its key; an uncached one, and a cached one
// that failed (no entry), ran on every cycle whatever the edit: editing the
// app re-ran the uncached generator it builds on (turborepo#13347), and an
// edit to one project re-ran another project's failing lint. Now each keeps
// its last result in this watch while its key is the same and no path in its
// project changed.

import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { SETTLE_MS, startWatch, until, type Watch } from './helpers/watch-loop.js'

describe('vx watch reruns only what a change reaches (e2e)', () => {
  let root = ''
  let outside = ''
  let log = ''
  let watch: Watch | undefined

  const ran = async (): Promise<string[]> =>
    (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean)
  const count = async (id: string): Promise<number> => (await ran()).filter((l) => l === id).length

  beforeEach(async () => {
    root = await realpath(await makeWorkspace({ prefix: 'vx-watch-reach-' }))
    outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-watch-reach-log-')))
    log = path.join(outside, 'runs.log')
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

  it('an uncached dependency is not run again when only its dependant changed', async () => {
    await addProject(root, 'lib', {
      config: `export default { tasks: { gen: {
        exec: { command: 'mkdir -p gen && cat src/*.txt > gen/out.txt && echo lib#gen >> ${log}' },
        inputs: { files: ['src/**'] },
      } } }\n`,
      files: { 'src/a.txt': 'l1\n', '.gitignore': 'gen/\n' },
    })
    await addProject(root, 'app', {
      config: `export default { tasks: { build: {
        dependsOn: ['lib#gen'],
        exec: { command: 'cat ../lib/gen/out.txt src/*.txt > out.txt && echo app#build >> ${log}' },
        inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] }, cache: true,
      } } }\n`,
      files: { 'src/a.txt': 'a1\n', '.gitignore': 'out.txt\n' },
    })
    watch = startWatch(root, [], {}, 'app#build')
    const w = watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    expect(await ran()).toEqual(['lib#gen', 'app#build'])

    await writeFile(path.join(root, 'packages/app/src/a.txt'), 'a2\n')
    await until(async () => (await count('app#build')) === 2, 'the app rebuilt')
    await Bun.sleep(SETTLE_MS)
    expect(await count('lib#gen')).toBe(1)
    expect(await readFile(path.join(root, 'packages/app/out.txt'), 'utf8')).toBe('l1\na2\n')

    // CONTROL: its own edit runs it, and its dependant after it.
    await writeFile(path.join(root, 'packages/lib/src/a.txt'), 'l2\n')
    await until(async () => (await count('app#build')) === 3, 'the app rebuilt on the lib')
    expect(await count('lib#gen')).toBe(2)
    expect(await readFile(path.join(root, 'packages/app/out.txt'), 'utf8')).toBe('l2\na2\n')
  }, 40_000)

  it('a failed task is not run again by an edit in an unrelated project', async () => {
    const lint = (id: string, cmd: string): string => `export default { tasks: { lint: {
        exec: { command: '${cmd} && echo ${id} >> ${log}; echo ${id} >> ${log}.all; ${cmd}' },
        inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true,
      } } }\n`
    await addProject(root, 'bad', {
      config: lint('bad#lint', 'grep -qx ok src/a.txt'),
      files: { 'src/a.txt': 'broken\n' },
    })
    await addProject(root, 'good', {
      config: lint('good#lint', 'true'),
      files: { 'src/a.txt': 'ok\n' },
    })
    const all = async (id: string): Promise<number> =>
      (await readFile(`${log}.all`, 'utf8').catch(() => '')).split('\n').filter((l) => l === id)
        .length
    watch = startWatch(root, ['--all'], {}, 'lint')
    const w = watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    expect(await all('bad#lint')).toBe(1)

    await writeFile(path.join(root, 'packages/good/src/a.txt'), 'ok 2\n')
    await until(async () => (await all('good#lint')) === 2, 'good linted again')
    await Bun.sleep(SETTLE_MS)
    expect(await all('bad#lint')).toBe(1)

    // CONTROL: the fix in its own project runs it.
    await writeFile(path.join(root, 'packages/bad/src/a.txt'), 'ok\n')
    await until(async () => (await all('bad#lint')) === 2, 'bad linted again')
    await Bun.sleep(SETTLE_MS)
    expect(await count('bad#lint')).toBe(1)
  }, 40_000)

  it('a dependant runs again when its uncached dependency ran, though its own key is the same', async () => {
    // lib#gen reads schema.json without declaring it: the edit is in its
    // project, so it runs, and what app#check reads moved under the same key.
    await addProject(root, 'lib', {
      config: `export default { tasks: { gen: {
        exec: { command: 'mkdir -p gen && cat schema.json > gen/out.txt && echo lib#gen >> ${log}' },
        inputs: { files: ['src/**'] },
      } } }\n`,
      files: { 'src/a.txt': 'l1\n', 'schema.json': 's1\n', '.gitignore': 'gen/\n' },
    })
    await addProject(root, 'app', {
      config: `export default { tasks: { check: {
        dependsOn: ['lib#gen'],
        exec: { command: 'cat ../lib/gen/out.txt > seen.txt && echo app#check >> ${log}' },
        inputs: { files: ['src/**'] },
      } } }\n`,
      files: { 'src/a.txt': 'a1\n', '.gitignore': 'seen.txt\n' },
    })
    watch = startWatch(root, [], {}, 'app#check')
    const w = watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await writeFile(path.join(root, 'packages/lib/schema.json'), 's2\n')
    await until(async () => (await count('lib#gen')) === 2, 'the generator ran again')
    await until(async () => (await count('app#check')) === 2, 'the dependant ran again')
    expect(await readFile(path.join(root, 'packages/app/seen.txt'), 'utf8')).toBe('s2\n')
  }, 40_000)
})
