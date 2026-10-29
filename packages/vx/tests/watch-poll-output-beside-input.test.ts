// The poller walks what the native watcher hears: a directory that holds a
// task's outputs AND its inputs (tsc emitting `.js` beside `.ts`) is not
// skipped, or `--poll` never saw a source edit the inotify watcher ran.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import {
  SETTLE_MS,
  executions,
  initialOnly,
  startWatch,
  until,
  type Watch,
} from './helpers/watch-loop.js'

describe('vx watch --poll: outputs beside inputs', () => {
  let root = ''
  let outside = ''
  let w: Watch | undefined
  afterEach(async () => {
    w?.proc.kill('SIGTERM')
    await w?.proc.exited
    w = undefined
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it.each([
    ['--poll', ['--all', '--poll']],
    ['the native watcher', ['--all']],
  ])(
    'a source edit under a directory of outputs re-runs (%s)',
    async (_mode, select) => {
      root = await makeWorkspace({ prefix: 'vx-watch-poll-beside-' })
      outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-count-'))
      const log = path.join(outside, 'runs.log')
      const dir = await addProject(
        root,
        'app',
        `
        export default {
          tasks: {
            build: {
              exec: { command: 'cat src/a.ts > src/a.js && echo run >> ${log}' },
              inputs: { files: ['src/**/*.ts'] }, cache: { outputs: { files: ['src/**/*.js'] } },
            },
          },
        }
      `,
      )
      await mkdir(path.join(dir, 'src'), { recursive: true })
      await writeFile(path.join(dir, 'src', 'a.ts'), 'a1\n')
      w = startWatch(root, select)
      const watch = w
      await until(() => watch.out().includes('watching '), 'the watching marker')
      await initialOnly(watch, log)
      await writeFile(path.join(dir, 'src', 'a.ts'), 'a2\n')
      await until(async () => (await executions(log)) === 2, 'the re-run after a source edit')
      await Bun.sleep(SETTLE_MS)
      expect(watch.cycles()).toBe(1)
    },
    40_000,
  )
})
