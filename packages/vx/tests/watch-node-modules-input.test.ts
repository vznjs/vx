// An input under `node_modules` is an input: one the task names outright
// (`node_modules/.prisma/client/**`, git-ignored) or one git tracks there.
// Both watchers skipped every `node_modules` by name, so its edit started
// no cycle and the outputs stayed stale. A `node_modules` nothing names
// stays unwatched: that skip is what keeps a watch cheap.

import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { makeWatchIgnore } from '../src/cli/watch-filter.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import {
  BIN,
  SETTLE_MS,
  executions,
  initialOnly,
  startWatch,
  until,
  type Watch,
} from './helpers/watch-loop.js'

describe('the ignore filter: node_modules', () => {
  const dir = path.resolve('/w/app')
  const inputs = new Map([[dir, [['src/**', 'node_modules/.gen/client/**', 'fixtures/**']]]])
  const tracked = new Set([path.join(dir, 'fixtures/node_modules/t.txt')])

  it('keeps what an input names or git tracks there, and nothing else', () => {
    const ignore = makeWatchIgnore('/w/.vx', new Map(), inputs, tracked)
    expect({
      nm: ignore(dir, 'node_modules', true),
      gen: ignore(dir, 'node_modules/.gen', true),
      client: ignore(dir, 'node_modules/.gen/client/sub', true),
      file: ignore(dir, 'node_modules/.gen/client/c.txt'),
      fixtures: ignore(dir, 'fixtures/node_modules', true),
      trackedFile: ignore(dir, 'fixtures/node_modules/t.txt'),
      pkg: ignore(dir, 'node_modules/react', true),
      pkgFile: ignore(dir, 'node_modules/react/index.js'),
      untrackedBeside: ignore(dir, 'fixtures/node_modules/u.txt'),
      git: ignore(dir, '.git/node_modules', true),
    }).toEqual({
      nm: false,
      gen: false,
      client: false,
      file: false,
      fixtures: false,
      trackedFile: false,
      pkg: true,
      pkgFile: true,
      untrackedBeside: true,
      git: true,
    })
  })

  it('a broad glob names no node_modules: it stays skipped', () => {
    const ignore = makeWatchIgnore('/w/.vx', new Map(), new Map([[dir, [['**/*']]]]))
    expect([
      ignore(dir, 'node_modules', true),
      ignore(dir, 'pkg/node_modules', true),
      ignore(dir, 'node_modules/react/index.js'),
    ]).toEqual([true, true, true])
  })
})

/** The rows `id` ran in: one is said once its task has ended and its command window closed. */
const ranRows = (w: Watch, id: string): number =>
  w
    .out()
    .split('\n')
    .filter((l) => /^\s*success miss /.test(l) && l.endsWith(` ${id}`)).length

/**
 * Until `id` has run `n` times and the file clock has passed the moment
 * that was seen. A write stamped inside a command's window may be that
 * command's (`ChangeJudge.sawEvent`), and a git-ignored one is then the
 * run's own; the coarse clock stamps a write up to a tick behind
 * `Date.now()`, so an edit made just after the row could carry a time
 * inside the window (the CI flake, 2026-11-08).
 */
async function ranAndPast(w: Watch, id: string, n: number, dir: string): Promise<void> {
  await until(() => ranRows(w, id) === n, `run ${n} of ${id}`)
  const seen = Date.now()
  const probe = path.join(dir, 'clock')
  await until(async () => {
    await writeFile(probe, '')
    return (await stat(probe)).ctimeMs > seen + 1
  }, 'the file clock past the run')
}

describe('vx watch: an input under node_modules', () => {
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
    'an edit to a named or tracked file there re-runs (%s)',
    async (_mode, select) => {
      root = await makeWorkspace({ prefix: 'vx-watch-nm-' })
      outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-count-'))
      const log = path.join(outside, 'runs.log')
      await writeFile(path.join(root, '.gitignore'), 'node_modules\n')
      const dir = await addProject(root, 'app', {
        config: `
        export default {
          tasks: {
            build: {
              exec: { command: 'mkdir -p dist && cat src/x.txt node_modules/.gen/client/c.txt fixtures/node_modules/t.txt > dist/out.txt && echo run >> ${log}' },
              inputs: { files: ['src/**', 'node_modules/.gen/client/**', 'fixtures/**'] },
              outputs: { files: ['dist/**'] }, cache: true,
            },
          },
        }
      `,
        files: {
          'src/x.txt': 'one\n',
          'node_modules/.gen/client/c.txt': 'C1\n',
          'node_modules/react/index.js': 'r1\n',
          'fixtures/node_modules/t.txt': 'T1\n',
        },
      })
      const git = gitIn(root)
      git('add', '-A')
      git('add', '-f', 'packages/app/fixtures/node_modules/t.txt')
      git('commit', '-q', '-m', 'init')
      w = startWatch(root, select)
      const watch = w
      await until(() => watch.out().includes('watching '), 'the watching marker')
      await initialOnly(watch, log)
      await writeFile(path.join(dir, 'node_modules/.gen/client/c.txt'), 'C2\n')
      await until(async () => (await executions(log)) === 2, 'the re-run for the named file')
      await writeFile(path.join(dir, 'fixtures/node_modules/t.txt'), 'T2\n')
      await until(async () => (await executions(log)) === 3, 'the re-run for the tracked file')
      // A package nothing names: no input, so no cycle.
      await mkdir(path.join(dir, 'node_modules/react/lib'), { recursive: true })
      await writeFile(path.join(dir, 'node_modules/react/index.js'), 'r2\n')
      await Bun.sleep(SETTLE_MS)
      expect(watch.cycles()).toBe(2)
      expect(await Bun.file(path.join(dir, 'dist/out.txt')).text()).toBe('one\nC2\nT2\n')
    },
    40_000,
  )

  // A git-ignored input written while a cycle runs was taken for the run's
  // own write and dropped, even after its task's command had ended: the
  // edit never re-ran. Another project's task holds the run open past the
  // edit, gated on a file outside the workspace rather than a sleep.
  it.each([
    ['--poll', ['--all', '--poll']],
    ['the native watcher', ['--all']],
  ])(
    'an edit made mid-run, after its task ran, re-runs (%s)',
    async (_mode, select) => {
      root = await makeWorkspace({ prefix: 'vx-watch-nm-mid-' })
      outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-count-'))
      const log = path.join(outside, 'runs.log')
      const gate = path.join(outside, 'gate')
      await writeFile(gate, '')
      await writeFile(path.join(root, '.gitignore'), 'node_modules\n')
      const dir = await addProject(root, 'app', {
        config: `
        export default {
          tasks: {
            build: {
              exec: { command: 'mkdir -p dist && cat src/x.txt node_modules/.gen/c.txt > dist/out.txt && echo run >> ${log}' },
              inputs: { files: ['src/**', 'node_modules/.gen/**'] }, outputs: { files: ['dist/**'] }, cache: true,
            },
          },
        }
      `,
        files: { 'src/x.txt': 'one\n', 'node_modules/.gen/c.txt': 'C1\n' },
      })
      await addProject(root, 'slow', {
        config: `
        export default {
          tasks: { build: { exec: { command: 'while [ ! -e ${gate} ]; do sleep 0.02; done; rm ${gate}' } } },
        }
      `,
      })
      w = startWatch(root, select)
      const watch = w
      await until(() => watch.out().includes('watching '), 'the watching marker')
      await initialOnly(watch, log)
      await writeFile(path.join(dir, 'src/x.txt'), 'two\n')
      await ranAndPast(watch, 'app#build', 2, outside)
      await writeFile(path.join(dir, 'node_modules/.gen/c.txt'), 'C2\n')
      await writeFile(gate, '')
      await until(async () => (await executions(log)) === 3, 'the re-run for the mid-run edit')
      expect(await Bun.file(path.join(dir, 'dist/out.txt')).text()).toBe('two\nC2\n')
    },
    40_000,
  )

  // The Linux tree watcher decides which `node_modules` to enter when it arms.
  it('an input newly named there re-arms, so its edit re-runs', async () => {
    root = await makeWorkspace({ prefix: 'vx-watch-nm-new-' })
    outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-count-'))
    const log = path.join(outside, 'runs.log')
    await writeFile(path.join(root, '.gitignore'), 'node_modules\n')
    const config = (inputs: string): string => `
      export default {
        tasks: {
          build: {
            exec: { command: 'mkdir -p dist && cat src/x.txt node_modules/.gen/c.txt > dist/out.txt && echo run >> ${log}' },
            inputs: { files: [${inputs}] }, outputs: { files: ['dist/**'] }, cache: true,
          },
        },
      }
    `
    const dir = await addProject(root, 'app', {
      config: config(`'src/**'`),
      files: { 'src/x.txt': 'one\n', 'node_modules/.gen/c.txt': 'C1\n' },
    })
    w = startWatch(root, ['--all'])
    const watch = w
    await until(() => watch.out().includes('watching '), 'the watching marker')
    await initialOnly(watch, log)
    await writeFile(path.join(dir, 'vx.config.mjs'), config(`'src/**', 'node_modules/.gen/**'`))
    const locked = Bun.spawnSync([process.execPath, BIN, 'lock'], {
      cwd: root,
      stderr: 'pipe',
      env: { ...process.env, VX_LOCK_REVIEW_FILES: 'false' },
    })
    expect([locked.exitCode, locked.stderr.toString()]).toEqual([0, ''])
    // Not a count of arms: the config edit and the lock are one cycle or
    // two as the debounce falls, and each re-read says one. The run that
    // read the new lock armed the new input first, or a re-lock it missed
    // starts one more cycle that keys the edit (watch.ts).
    await ranAndPast(watch, 'app#build', 2, outside)
    await writeFile(path.join(dir, 'node_modules/.gen/c.txt'), 'C2\n')
    await until(async () => (await executions(log)) === 3, 'the re-run for the newly named file')
    expect(await Bun.file(path.join(dir, 'dist/out.txt')).text()).toBe('one\nC2\n')
  }, 40_000)
})
