// A project's boundary is hard: a root project owns its own files, never
// a nested project's, and its key leaves them out. `vx watch` on a root
// project watched its whole tree and ran a cycle for every edit inside a
// nested project the run never reads (X-42).

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { SETTLE_MS, startWatch, until, type Watch } from './helpers/watch-loop.js'

describe('vx watch on a root project with a nested project (e2e)', () => {
  let root = ''
  let outside = ''
  let log = ''
  let watch: Watch | undefined

  const ran = async (): Promise<string[]> =>
    (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean)
  const rootConfig = (inputs: string) => `
    export default {
      tasks: {
        build: {
          exec: { command: 'echo root >> ${log}' },
          cache: { inputs: ${inputs}, outputs: { files: [] } },
        },
      },
    }
  `

  beforeEach(async () => {
    root = await realpath(await makeWorkspace({ prefix: 'vx-watch-nested-' }))
    outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-watch-nested-log-')))
    log = path.join(outside, 'runs.log')
    await writeFile(
      path.join(root, 'pnpm-workspace.yaml'),
      'packages:\n  - "."\n  - "packages/*"\n',
    )
    await mkdir(path.join(root, 'src'), { recursive: true })
    await writeFile(path.join(root, 'src', 'r.txt'), 'r1\n')
    await addProject(root, 'a', {
      config: `export default { tasks: { build: { exec: { command: 'echo a >> ${log}' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } } } } }\n`,
      files: { 'src/a.txt': 'a1\n' },
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

  const edits = async (): Promise<void> => {
    const w = watch!
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    await writeFile(path.join(root, 'packages', 'a', 'src', 'a.txt'), 'a2\n')
    await Bun.sleep(SETTLE_MS)
    expect({ cycles: w.cycles(), ran: await ran() }).toEqual({ cycles: 0, ran: ['root'] })
    // CONTROL: an edit to the root project's own file is heard.
    await writeFile(path.join(root, 'src', 'r.txt'), 'r2\n')
    await until(() => w.cycles() === 1, 'the cycle the root edit starts')
    await until(async () => (await ran()).length === 2, 'the root build the edit runs')
    await Bun.sleep(SETTLE_MS)
    expect({ cycles: w.cycles(), ran: await ran() }).toEqual({
      cycles: 1,
      ran: ['root', 'root'],
    })
  }

  it('an edit inside a nested project starts no cycle on the root project (X-42)', async () => {
    await writeFile(path.join(root, 'vx.config.mjs'), rootConfig(`{ files: ['**/*.txt'] }`))
    watch = startWatch(root, ['--filter', 'fixture-root'])
    await edits()
  }, 40_000)

  it('the workspace-wide arm keeps the nested project out too (X-42)', async () => {
    await writeFile(
      path.join(root, 'vx.config.mjs'),
      rootConfig(`{ files: ['**/*.txt'], workspaceFiles: ['tsconfig.base.json'] }`),
    )
    watch = startWatch(root, ['--filter', 'fixture-root'])
    await until(() => watch!.out().includes('watching the workspace root'), 'the root arm')
    await edits()
  }, 40_000)

  it("a nested project's config stays an edit; a config-less package's file is none (X-57)", async () => {
    await writeFile(path.join(root, 'vx.config.mjs'), rootConfig(`{ files: ['**/*.txt'] }`))
    await addProject(root, 'b', { files: { 'src/b.txt': 'b1\n' } })
    watch = startWatch(root, ['--filter', 'fixture-root'])
    const w = watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    // Its config coming or going moves the boundary, so the set is re-read.
    const config = path.join(root, 'packages', 'a', 'vx.config.mjs')
    await writeFile(config, `${await readFile(config, 'utf8')}// edited\n`)
    await until(() => w.cycles() === 1, 'the cycle the nested config edit starts')
    // A config-less package is a project too: the root's key leaves
    // `packages/b/src/b.txt` out, so its edit is no cycle.
    await writeFile(path.join(root, 'packages', 'b', 'src', 'b.txt'), 'b2\n')
    await Bun.sleep(SETTLE_MS)
    expect({ cycles: w.cycles(), ran: await ran() }).toEqual({ cycles: 1, ran: ['root'] })
    // CONTROL: the root's own file is still heard.
    await writeFile(path.join(root, 'src', 'r.txt'), 'r2\n')
    await until(() => w.cycles() === 2, 'the cycle the root edit starts')
    await until(async () => (await ran()).length === 2, 'the root build the edit runs')
  }, 40_000)
})
