// A key is taken BEFORE the command runs, and a miss files the command's
// outputs under it. When an input changes in between — the task rewrites
// its own input (a formatter, turborepo#10111), the user edits one mid-run
// (turborepo#1146) — the entry holds bytes built from one state under the
// key of another, and restoring the old state replays them as up-to-date.
// The miss re-checks its inputs before the save and withholds the entry
// when one moved (item 743). Every row but the controls failed on the tree
// before the fix.

import { existsSync, lstatSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  Cache,
  type CacheLayer,
  FILE_HASH_RACY_MS,
  GitFilesCache,
  applyGitEnumeration,
  startGitEnumeration,
} from '../src/cache/index.js'
import type { TaskNode } from '../src/graph/index.js'
import type { RunSummary } from '../src/orchestrator/index.js'
import type { Logger } from '../src/report/index.js'
import { failedLabel } from '../src/report/events.js'
import { run } from './helpers/orchestrator.js'
import { describeTaskInputs, movedInput } from '../src/orchestrator/task-hash.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { writeLocalWorkspace, workspaceWith } from './helpers/local-workspace.js'
import { edgesSource } from './helpers/plugin.js'

const TIMEOUT = 30_000
const MOVED = /changed after its key was taken/

let root: string
let status: string[]

const logger: Logger = {
  status: (line) => status.push(line),
  taskStdout: () => {},
  taskStderr: () => {},
  taskComplete: () => {},
}

// `VX_CACHE_INPUT_STABILITY_STRATEGY(_SEVERITY)` set the defaults the rows below judge; each row
// starts without it and sets it only to say so.
const saved = {
  stability: process.env['VX_CACHE_INPUT_STABILITY_STRATEGY'],
  severity: process.env['VX_CACHE_INPUT_STABILITY_SEVERITY'],
}
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-moved-', edges: { app: ['lib'] } })
  status = []
  delete process.env['VX_CACHE_INPUT_STABILITY_STRATEGY']
  delete process.env['VX_CACHE_INPUT_STABILITY_SEVERITY']
})

afterEach(async () => {
  if (saved.stability === undefined) delete process.env['VX_CACHE_INPUT_STABILITY_STRATEGY']
  else process.env['VX_CACHE_INPUT_STABILITY_STRATEGY'] = saved.stability
  if (saved.severity === undefined) delete process.env['VX_CACHE_INPUT_STABILITY_SEVERITY']
  else process.env['VX_CACHE_INPUT_STABILITY_SEVERITY'] = saved.severity
  await rm(root, { recursive: true, force: true })
})

function commit(): void {
  gitIn(root)('add', '-A')
  gitIn(root)('commit', '-q', '-m', 'fixture')
}

async function runTask(task: string): Promise<RunSummary> {
  status = []
  const r = await run({ cwd: root, tasks: [task], log: logger })
  expect(r.ok).toBe(true)
  return r
}

const statusOf = (r: RunSummary, id: string): string | undefined =>
  r.outcomes.find((o) => o.node.id === id)?.status

/** Resolves once `file` exists: the task under test has reached that line. */
async function reached(file: string): Promise<void> {
  while (!existsSync(file)) await Bun.sleep(5)
}

describe('a task that rewrites its own input', () => {
  it(
    'is not saved under the key of the bytes it rewrote, so restoring them re-runs it',
    async () => {
      const app = await addProject(root, 'app', {
        config: `
          export default {
            tasks: {
              format: {
                exec: { command: "sed -i.bak 's/unformatted/formatted/' a.ts && rm a.ts.bak" },
                inputs: { files: ['a.ts'] }, cache: { outputs: { files: [] } },
              },
            },
          }
        `,
        files: { 'a.ts': 'const x = "unformatted"\n' },
      })
      await writeFile(path.join(root, '.gitignore'), '.vx/cache/\n')
      commit()

      await runTask('format')
      expect(status.filter((l) => MOVED.test(l))).toEqual([
        '[vx] app#format: `packages/app/a.ts` changed after its key was taken — the result stands, but is not saved under a key that no longer describes it; if the task writes it, declare it in cache.outputs',
      ])
      gitIn(root)('checkout', '--', 'packages/app/a.ts')
      const again = await runTask('format')
      // Before the fix: `up-to-date`, and a.ts stayed unformatted.
      expect(statusOf(again, 'app#format')).toBe('success')
      expect(await readFile(path.join(app, 'a.ts'), 'utf8')).toBe('const x = "formatted"\n')
    },
    TIMEOUT,
  )

  it(
    'a rewrite to the SAME bytes while the command runs is not saved either',
    async () => {
      // sed -i rewrites the file (a new inode, a new ctime) even when it
      // changes nothing. Its bytes match the key, but a write during the
      // command is indistinguishable from an edit reverted while it ran,
      // whose output the entry would have filed under the key (item 1015):
      // the write withholds the save. A formatter that rewrites what it
      // does not change pays a re-run, never a stale hit.
      await addProject(root, 'app', {
        config: `
          export default {
            tasks: {
              format: {
                exec: { command: "sed -i.bak 's/unformatted/formatted/' a.ts && rm a.ts.bak" },
                inputs: { files: ['a.ts'] }, cache: { outputs: { files: [] } },
              },
            },
          }
        `,
        files: { 'a.ts': 'const x = "formatted"\n' },
      })
      await writeFile(path.join(root, '.gitignore'), '.vx/cache/\n')
      commit()
      await runTask('format')
      expect(status.filter((l) => MOVED.test(l))).toEqual([
        '[vx] app#format: `packages/app/a.ts` changed after its key was taken — the result stands, but is not saved under a key that no longer describes it; if the task writes it, declare it in cache.outputs',
      ])
      expect(statusOf(await runTask('format'), 'app#format')).toBe('success')
    },
    TIMEOUT,
  )
})

describe('cache.inputStability: what a write during the command means', () => {
  const WITHHELD = [
    '[vx] app#format: `packages/app/a.ts` changed after its key was taken — the result stands, but is not saved under a key that no longer describes it; if the task writes it, declare it in cache.outputs',
  ]
  const formatter = (from: string, stability?: object) => ({
    config: `
      export default {
        tasks: {
          format: {
            exec: { command: "sed -i.bak 's/unformatted/formatted/' a.ts && rm a.ts.bak" },
            inputs: { files: ['a.ts'] },
            cache: {
              outputs: { files: [] },
              ${stability === undefined ? '' : `inputStability: ${JSON.stringify(stability)},`}
            },
          },
        },
      }
    `,
    files: { 'a.ts': `const x = "${from}"\n` },
  })
  async function fixture(from: string, stability?: object): Promise<void> {
    await addProject(root, 'app', formatter(from, stability))
    await writeFile(path.join(root, '.gitignore'), '.vx/cache/\n')
    commit()
  }

  it(
    "'mutable', the same bytes rewritten: saved, and the next run is a hit",
    async () => {
      await fixture('formatted', { strategy: 'mutable' })
      await runTask('format')
      expect(status.filter((l) => MOVED.test(l))).toEqual([])
      expect(statusOf(await runTask('format'), 'app#format')).toBe('cache-hit')
    },
    TIMEOUT,
  )

  it(
    "'mutable', different bytes: still withheld",
    async () => {
      await fixture('unformatted', { strategy: 'mutable' })
      await runTask('format')
      expect(status.filter((l) => MOVED.test(l))).toEqual(WITHHELD)
    },
    TIMEOUT,
  )

  it(
    'VX_CACHE_INPUT_STABILITY_STRATEGY=mutable is the default for a task that does not say',
    async () => {
      process.env['VX_CACHE_INPUT_STABILITY_STRATEGY'] = 'mutable'
      await fixture('formatted')
      await runTask('format')
      expect(status.filter((l) => MOVED.test(l))).toEqual([])
      expect(statusOf(await runTask('format'), 'app#format')).toBe('cache-hit')
    },
    TIMEOUT,
  )

  it(
    "'mutable': another task that writes an input and puts it back during the command withholds the save",
    async () => {
      // The bytes match the key, but `meddle` held other bytes while `read`
      // ran: the save filed what `read` saw under the key of what is there
      // now (STATUS item 28). Control: the same write, finished before
      // `read` starts (dependsOn), is saved. Files order the overlap, not
      // sleeps: on a slow runner `read` was keyed after `meddle` put the
      // bytes back, which saw nothing to withhold (macOS CI, #3683).
      const signals = await mkdtemp(path.join(os.tmpdir(), 'vx-moved-signals-'))
      const waitFor = (file: string) =>
        `i=0; while [ ! -f ${signals}/${file} ] && [ $i -lt 1000 ]; do sleep 0.01; i=$((i+1)); done`
      const swap = 'cp a.ts a.keep && printf bad > a.ts && cat a.keep > a.ts && rm a.keep'
      const project = (ordered: boolean) => ({
        config: `
          export default {
            tasks: {
              read: {
                exec: { command: ${JSON.stringify(ordered ? 'true' : `touch ${signals}/started; ${waitFor('restored')}`)} },
                ${ordered ? "dependsOn: ['meddle']," : ''}
                inputs: { files: ['a.ts'] },
                cache: {
                  outputs: { files: [] },
                  inputStability: { strategy: 'mutable' },
                },
              },
              meddle: {
                exec: { command: ${JSON.stringify(ordered ? swap : `${waitFor('started')}; ${swap} && touch ${signals}/restored`)} },
                inputs: { files: [] },
              },
            },
          }
        `,
        files: { 'a.ts': 'const x = 1\n' },
      })
      await addProject(root, 'app', project(false))
      await writeFile(path.join(root, '.gitignore'), '.vx/cache/\n')
      commit()
      status = []
      const r = await run({ cwd: root, tasks: ['read', 'meddle'], log: logger })
      expect(r.ok).toBe(true)
      expect(status.filter((l) => MOVED.test(l))).toEqual([
        '[vx] app#read: `packages/app/a.ts` changed after its key was taken while app#meddle ran — the result stands, but is not saved under a key that no longer describes it',
      ])
      await addProject(root, 'app', project(true))
      commit()
      status = []
      expect((await run({ cwd: root, tasks: ['read'], log: logger })).ok).toBe(true)
      expect(status.filter((l) => MOVED.test(l))).toEqual([])
      expect(statusOf(await runTask('read'), 'app#read')).toBe('cache-hit')
      await rm(signals, { recursive: true, force: true })
    },
    TIMEOUT,
  )

  it(
    "'mutable': a server held from an earlier run that writes an input and puts it back withholds the save",
    async () => {
      // `vx watch` hands a run's server to the next run; it runs through
      // that run too, so its write is another task's, not `read`'s own.
      await addProject(root, 'app', {
        config: `
          export default {
            tasks: {
              read: {
                exec: { command: 'touch go && sleep 0.8' },
                inputs: { files: ['a.ts'] },
                cache: {
                  outputs: { files: [] },
                  inputStability: { strategy: 'mutable' },
                },
              },
              srv: {
                exec: {
                  command: 'echo READY; while [ ! -f go ]; do sleep 0.02; done; sleep 0.2; cp a.ts a.keep; printf bad > a.ts; sleep 0.2; cat a.keep > a.ts; rm a.keep; exec sleep 30',
                  persistent: { readyWhen: 'READY' },
                },
              },
            },
          }
        `,
        files: { 'a.ts': 'const x = 1\n' },
      })
      await writeFile(path.join(root, '.gitignore'), '.vx/cache/\n')
      commit()
      const first = await run({ cwd: root, tasks: ['srv'], log: logger, holdPersistent: true })
      status = []
      const second = await run({
        cwd: root,
        tasks: ['srv', 'read'],
        log: logger,
        holdPersistent: true,
        keep: first.persistent!,
      })
      await second.persistent?.stop()
      await first.persistent!.stop()
      expect(second.ok).toBe(true)
      expect(status.filter((l) => MOVED.test(l))).toEqual([
        '[vx] app#read: `packages/app/a.ts` changed after its key was taken while app#srv ran — the result stands, but is not saved under a key that no longer describes it',
      ])
    },
    TIMEOUT,
  )

  it(
    "the env var wins over a task's own setting, for the run",
    async () => {
      process.env['VX_CACHE_INPUT_STABILITY_STRATEGY'] = 'mutable'
      await fixture('formatted', { strategy: 'immutable' })
      await runTask('format')
      expect(status.filter((l) => MOVED.test(l))).toEqual([])
    },
    TIMEOUT,
  )

  it(
    "the workspace's inputStability is the default; a task's own field wins over it",
    async () => {
      await fixture('formatted')
      const ws = path.join(root, '.vx/workspace.mjs')
      await writeFile(ws, workspaceWith("cache: { inputStability: { strategy: 'mutable' } }"))
      await runTask('format')
      expect(status.filter((l) => MOVED.test(l))).toEqual([])
      await addProject(root, 'app', formatter('formatted', { strategy: 'immutable' }))
      await runTask('format')
      expect(status.filter((l) => MOVED.test(l))).toEqual(WITHHELD)
    },
    TIMEOUT,
  )

  it(
    'on CI the default still withholds (2026-10-12: a concurrent task can put an input back)',
    async () => {
      const ci = process.env['CI']
      process.env['CI'] = 'true'
      try {
        await fixture('formatted')
        await runTask('format')
        expect(status.filter((l) => MOVED.test(l))).toEqual(WITHHELD)
      } finally {
        if (ci === undefined) delete process.env['CI']
        else process.env['CI'] = ci
      }
    },
    TIMEOUT,
  )

  it(
    "severity 'error': the save is withheld and the task fails, naming the file",
    async () => {
      await fixture('unformatted', { severity: 'error' })
      const r = await run({ cwd: root, tasks: ['format'], log: logger })
      expect(r.ok).toBe(false)
      expect(statusOf(r, 'app#format')).toBe('failed')
      expect(status.filter((l) => MOVED.test(l))).toEqual([
        "[vx] app#format: `packages/app/a.ts` changed after its key was taken — the result is not saved, and inputStability.severity is 'error', so the task fails; if the task writes it, declare it in cache.outputs",
      ])
      // The outcome names it too, so the label and `vx last` say why the
      // exit is 1 when the command itself passed.
      const o = r.outcomes.find((x) => x.node.id === 'app#format')!
      expect([o.exitCode, o.inputMoved]).toEqual([1, 'packages/app/a.ts'])
      expect(
        failedLabel(o.exitCode, o.timedOut, o.sandboxViolations, o.notReady, o.inputMoved),
      ).toBe('failed (packages/app/a.ts changed during the run, exit 1)')
    },
    TIMEOUT,
  )

  it(
    'VX_CACHE_INPUT_STABILITY_SEVERITY=error is the default for a task that does not say',
    async () => {
      process.env['VX_CACHE_INPUT_STABILITY_SEVERITY'] = 'error'
      await fixture('unformatted')
      const r = await run({ cwd: root, tasks: ['format'], log: logger })
      expect(statusOf(r, 'app#format')).toBe('failed')
    },
    TIMEOUT,
  )

  it(
    "'unchecked': no check, the entry is saved under the key of the bytes it rewrote",
    async () => {
      await fixture('unformatted', { strategy: 'unchecked', severity: 'error' })
      await runTask('format')
      expect(status.filter((l) => MOVED.test(l))).toEqual([])
      // The old bytes back: the entry taken before the rewrite answers.
      gitIn(root)('checkout', '--', 'packages/app/a.ts')
      expect(statusOf(await runTask('format'), 'app#format')).toBe('cache-hit')
    },
    TIMEOUT,
  )

  it(
    'VX_CACHE_INPUT_STABILITY_STRATEGY=unchecked skips the check, and a value naming no mode is refused before any task',
    async () => {
      process.env['VX_CACHE_INPUT_STABILITY_STRATEGY'] = 'unchecked'
      await fixture('unformatted')
      await runTask('format')
      expect(status.filter((l) => MOVED.test(l))).toEqual([])
      process.env['VX_CACHE_INPUT_STABILITY_STRATEGY'] = 'content'
      await expect(run({ cwd: root, tasks: ['format'], log: logger })).rejects.toThrow(
        "VX_CACHE_INPUT_STABILITY_STRATEGY must be one of 'immutable', 'mutable', 'unchecked' (got content)",
      )
      delete process.env['VX_CACHE_INPUT_STABILITY_STRATEGY']
      process.env['VX_CACHE_INPUT_STABILITY_SEVERITY'] = 'fail'
      await expect(run({ cwd: root, tasks: ['format'], log: logger })).rejects.toThrow(
        "VX_CACHE_INPUT_STABILITY_SEVERITY must be one of 'warn', 'error' (got fail)",
      )
    },
    TIMEOUT,
  )
})

describe('the other moves', () => {
  it(
    'an input the task deletes: the entry is withheld',
    async () => {
      const app = await addProject(root, 'app', {
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'mkdir -p dist; cat in/* > dist/out.txt; rm in/b.txt' },
                inputs: { files: ['in/**'] }, cache: { outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
        files: { 'in/a.txt': 'a', 'in/b.txt': 'b' },
      })
      await writeFile(path.join(root, '.gitignore'), '.vx/cache/\ndist/\n')
      commit()
      await runTask('build')
      expect(status.filter((l) => MOVED.test(l))).toEqual([
        '[vx] app#build: `packages/app/in/b.txt` changed after its key was taken — the result stands, but is not saved under a key that no longer describes it; if the task writes it, declare it in cache.outputs',
      ])
      gitIn(root)('checkout', '--', 'packages/app/in/b.txt')
      await rm(path.join(app, 'dist'), { recursive: true, force: true })
      expect(statusOf(await runTask('build'), 'app#build')).toBe('success')
    },
    TIMEOUT,
  )

  it(
    "the project's package.json, unlisted, is no input: the entry is saved",
    async () => {
      await addProject(root, 'app', {
        config: `
          export default {
            tasks: {
              bump: {
                exec: { command: 'cp next.json package.json' },
                inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
              },
            },
          }
        `,
        files: {
          'src/a.txt': 'a',
          'next.json': JSON.stringify({ name: 'app', version: '1.0.0' }),
        },
      })
      await writeFile(path.join(root, '.gitignore'), '.vx/cache/\n')
      commit()
      // Core keys no package file (2026-10-14), so a rewrite of one the
      // task does not list moves nothing it keyed.
      await runTask('bump')
      expect(status.filter((l) => MOVED.test(l))).toEqual([])
      gitIn(root)('checkout', '--', 'packages/app/package.json')
      expect(statusOf(await runTask('bump'), 'app#bump')).toBe('cache-hit')
    },
    TIMEOUT,
  )
})

describe('what the run knew about the project goes with a move', () => {
  it(
    'a same-project reader after the rewrite is keyed on the new bytes, not the index OID',
    async () => {
      // `build` folds no upstream key (`tasks: []`) and is keyed after
      // `format` (which declares an output, so `build` is not keyed up
      // front). The first run's `format` leaves `a.ts` alone and `build`
      // saves under a.ts = U. Then `format` learns to rewrite U to F: the
      // rewritten file is tracked and was clean when the run listed it, so
      // a key from that listing is the first run's, and restores U's build.
      const format = (cmd: string) => `
        export default {
          tasks: {
            format: {
              exec: { command: ${JSON.stringify(cmd)} },
              inputs: { files: ['a.ts'] }, cache: { outputs: { files: ['fmt.log'] } },
            },
            build: {
              dependsOn: ['format'],
              exec: { command: 'mkdir -p dist; cat a.ts > dist/out.txt' },
              inputs: { files: ['a.ts'], tasks: [] }, cache: { outputs: { files: ['dist/**'] } },
            },
          },
        }
      `
      const app = await addProject(root, 'app', {
        config: format('echo ok > fmt.log'),
        files: { 'a.ts': 'U\n' },
      })
      await writeFile(path.join(root, '.gitignore'), '.vx/cache/\ndist/\nfmt.log\n')
      commit()
      await runTask('build')
      expect(await readFile(path.join(app, 'dist', 'out.txt'), 'utf8')).toBe('U\n')

      await writeFile(
        path.join(app, 'vx.config.mjs'),
        format("sed -i.bak 's/U/F/' a.ts && rm a.ts.bak && echo ok > fmt.log"),
      )
      commit()
      const r = await runTask('build')
      expect(statusOf(r, 'app#build')).toBe('success')
      expect(await readFile(path.join(app, 'dist', 'out.txt'), 'utf8')).toBe('F\n')
    },
    TIMEOUT,
  )
})

describe('what a moved task wrote elsewhere is seen too', () => {
  it(
    "a workspace output it created in another project reaches that project's reader",
    async () => {
      await writeLocalWorkspace(root, [edgesSource({ app: ['lib'] })])
      // Its save would have marked the output against `app`'s listing; the
      // save is withheld, and the listing must not outlive the write.
      await addProject(root, 'lib', {
        config: `
          export default {
            tasks: {
              gen: {
                exec: { command: "sed -i.bak 's/U/F/' a.ts && rm a.ts.bak && printf G > ../app/gen.txt" },
                inputs: { files: ['a.ts'] },
                cache: {
                  outputs: { files: [], workspaceFiles: ['packages/app/gen.txt'] },
                },
              },
            },
          }
        `,
        files: { 'a.ts': 'U\n' },
      })
      await addProject(root, 'app', {
        config: `
          export default {
            tasks: {
              build: {
                dependsOn: ['^gen'],
                exec: { command: 'mkdir -p dist; cat gen.txt > dist/out.txt' },
                inputs: { files: ['gen.txt'], tasks: [] }, cache: { outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
      })
      await writeFile(path.join(root, '.gitignore'), '.vx/cache/\ndist/\n')
      commit()
      await runTask('build')
      expect(status.filter((l) => l.includes('app#build'))).toEqual([])
    },
    TIMEOUT,
  )
})

describe('an input the user edits during the run', () => {
  const BUILD = `
    export default {
      tasks: {
        build: {
          exec: { command: 'touch started; while [ ! -f go ]; do sleep 0.01; done; mkdir -p dist; cat src/a.ts > dist/out.js' },
          inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
        },
      },
    }
  `

  it(
    'while the command runs: the entry is withheld, and the restored file rebuilds',
    async () => {
      const app = await addProject(root, 'app', { config: BUILD, files: { 'src/a.ts': 'X\n' } })
      await writeFile(path.join(root, '.gitignore'), '.vx/cache/\ndist/\nstarted\ngo\n')
      commit()
      const pending = runTask('build')
      await reached(path.join(app, 'started'))
      await writeFile(path.join(app, 'src', 'a.ts'), 'EDITED\n')
      await writeFile(path.join(app, 'go'), '')
      await pending
      expect(status.filter((l) => MOVED.test(l))).toEqual([
        '[vx] app#build: `packages/app/src/a.ts` changed after its key was taken — the result stands, but is not saved under a key that no longer describes it; if the task writes it, declare it in cache.outputs',
      ])

      gitIn(root)('checkout', '--', 'packages/app/src/a.ts')
      await rm(path.join(app, 'dist'), { recursive: true, force: true })
      const again = await runTask('build')
      // Before the fix: a local hit restoring `EDITED`.
      expect(statusOf(again, 'app#build')).toBe('success')
      expect(await readFile(path.join(app, 'dist', 'out.js'), 'utf8')).toBe('X\n')
    },
    TIMEOUT,
  )

  // Edited and edited BACK while the command ran: the content matches the
  // key again, the output was built from the edit, and the entry filed it
  // under the key — the next run restored it over the original source
  // (item 1015). A write during the command withholds the save.
  it(
    'edited and reverted while the command runs: still withheld, and the next run rebuilds',
    async () => {
      const app = await addProject(root, 'app', {
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'touch started; while [ ! -f go ]; do sleep 0.01; done; mkdir -p dist; cat src/a.ts > dist/out.js; touch built; while [ ! -f done ]; do sleep 0.01; done' },
                inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
        files: { 'src/a.ts': 'X\n' },
      })
      await writeFile(
        path.join(root, '.gitignore'),
        '.vx/cache/\ndist/\nstarted\ngo\nbuilt\ndone\n',
      )
      commit()
      const pending = runTask('build')
      await reached(path.join(app, 'started'))
      await writeFile(path.join(app, 'src', 'a.ts'), 'EDITED\n')
      await writeFile(path.join(app, 'go'), '')
      await reached(path.join(app, 'built'))
      await writeFile(path.join(app, 'src', 'a.ts'), 'X\n')
      await writeFile(path.join(app, 'done'), '')
      await pending
      expect(status.filter((l) => MOVED.test(l))).toEqual([
        '[vx] app#build: `packages/app/src/a.ts` changed after its key was taken — the result stands, but is not saved under a key that no longer describes it; if the task writes it, declare it in cache.outputs',
      ])
      await rm(path.join(app, 'dist'), { recursive: true, force: true })
      for (const f of ['started', 'go', 'built', 'done']) await writeFile(path.join(app, f), '')
      const again = await runTask('build')
      // Before the fix: a local hit restoring `EDITED` over `X`.
      expect(statusOf(again, 'app#build')).toBe('success')
      expect(await readFile(path.join(app, 'dist', 'out.js'), 'utf8')).toBe('X\n')
    },
    TIMEOUT,
  )

  // `lib#gate` holds the run until the test releases it; `app#build` is
  // after it but keyed up front (another project, no outputs), so the edit
  // lands between the key and the command.
  async function gated(files: Record<string, string>): Promise<{ app: string; lib: string }> {
    const lib = await addProject(root, 'lib', {
      config: `
        export default {
          tasks: {
            gate: {
              exec: { command: 'touch started; while [ ! -f go ]; do sleep 0.01; done' },
              inputs: { files: [] },
            },
          },
        }
      `,
    })
    const app = await addProject(root, 'app', {
      config: `
        export default {
          tasks: {
            build: {
              dependsOn: ['^gate'],
              exec: { command: 'mkdir -p dist; cat src/a.ts > dist/out.js' },
              inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
            },
          },
        }
      `,
      files,
    })
    await writeFile(path.join(root, '.gitignore'), '.vx/cache/\ndist/\nstarted\ngo\n')
    return { app, lib }
  }

  it(
    'before the task starts, a TRACKED input: its index OID is not trusted past the edit',
    async () => {
      const { app, lib } = await gated({ 'src/a.ts': 'X\n' })
      commit()
      const pending = runTask('build')
      await reached(path.join(lib, 'started'))
      await writeFile(path.join(app, 'src', 'a.ts'), 'EDITED\n')
      // Past the racy window: the edit is older than the describe by more
      // than it, so only dating the OID from the enumeration (not from the
      // describe) sends the file to be hashed again.
      await Bun.sleep(FILE_HASH_RACY_MS * 2)
      await writeFile(path.join(lib, 'go'), '')
      await pending
      expect(status.filter((l) => MOVED.test(l))).toEqual([
        '[vx] app#build: `packages/app/src/a.ts` changed after its key was taken — the result stands, but is not saved under a key that no longer describes it; if the task writes it, declare it in cache.outputs',
      ])

      gitIn(root)('checkout', '--', 'packages/app/src/a.ts')
      await rm(path.join(app, 'dist'), { recursive: true, force: true })
      expect(statusOf(await runTask('build'), 'app#build')).toBe('success')
      expect(await readFile(path.join(app, 'dist', 'out.js'), 'utf8')).toBe('X\n')
    },
    TIMEOUT,
  )

  it(
    'before the task starts, an UNTRACKED input: the key re-derived at the command differs',
    async () => {
      const { app, lib } = await gated({ 'src/b.ts': 'b\n' })
      commit()
      // An empty cache keys each task as it starts, with no up-front key.
      await writeFile(path.join(app, 'src', 'a.ts'), 'seed\n')
      await writeFile(path.join(lib, 'go'), '')
      await runTask('build')
      await rm(path.join(lib, 'go'))
      await rm(path.join(lib, 'started'))
      // Untracked: hashed by content, at the up-front key and again at the describe.
      await writeFile(path.join(app, 'src', 'a.ts'), 'X\n')
      const pending = runTask('build')
      await reached(path.join(lib, 'started'))
      await writeFile(path.join(app, 'src', 'a.ts'), 'EDITED\n')
      // Past the racy window, so the file's ctime clears the describe's fact
      // and the post-command re-check alone would pass: this row holds the
      // comparison of the two keys.
      await Bun.sleep(FILE_HASH_RACY_MS * 2)
      await writeFile(path.join(lib, 'go'), '')
      await pending
      expect(status.filter((l) => MOVED.test(l))).toEqual([
        '[vx] app#build: its inputs changed after its key was taken — the result stands, but is not saved under a key that no longer describes it',
      ])

      await writeFile(path.join(app, 'src', 'a.ts'), 'X\n')
      await rm(path.join(app, 'dist'), { recursive: true, force: true })
      expect(statusOf(await runTask('build'), 'app#build')).toBe('success')
      expect(await readFile(path.join(app, 'dist', 'out.js'), 'utf8')).toBe('X\n')
    },
    TIMEOUT,
  )
})

// An input that is a symlink folds the content behind it (linked-inputs.ts),
// but the re-check looked only at the link itself, whose target string did
// not change: an edit behind it while the command ran was saved under the
// pre-edit key, and restoring the file replayed the edit as a hit.
describe('an edit behind a linked input during the run', () => {
  for (const [kind, link, target, files] of [
    ['directory', 'lib', '../../shared', 'lib/**'],
    ['file', 'src/l.txt', '../../../shared/a.txt', 'src/**'],
  ] as const) {
    it(
      `a ${kind} link: the entry is withheld, and the restored file rebuilds`,
      async () => {
        const read = kind === 'directory' ? 'lib/a.txt' : 'src/l.txt'
        const app = await addProject(root, 'app', {
          config: `
            export default {
              tasks: {
                build: {
                  exec: { command: 'touch started; while [ ! -f go ]; do sleep 0.01; done; mkdir -p dist; cat ${read} > dist/out.txt' },
                  inputs: { files: ['${files}'] }, cache: { outputs: { files: ['dist/**'] } },
                },
              },
            }
          `,
          files: { 'src/x.txt': 'x\n' },
        })
        await mkdir(path.join(root, 'shared'), { recursive: true })
        await writeFile(path.join(root, 'shared', 'a.txt'), 'A1\n')
        await mkdir(path.dirname(path.join(app, link)), { recursive: true })
        await symlink(target, path.join(app, link))
        await writeFile(path.join(root, '.gitignore'), '.vx/cache/\ndist/\nstarted\ngo\n')
        commit()
        const pending = runTask('build')
        await reached(path.join(app, 'started'))
        await writeFile(path.join(root, 'shared', 'a.txt'), 'MID\n')
        await writeFile(path.join(app, 'go'), '')
        await pending
        expect(status.filter((l) => MOVED.test(l))).toHaveLength(1)

        await writeFile(path.join(root, 'shared', 'a.txt'), 'A1\n')
        await rm(path.join(app, 'dist'), { recursive: true, force: true })
        await writeFile(path.join(app, 'go'), '')
        const r = await run({ cwd: root, tasks: ['build'], log: logger })
        // Before the fix: a local hit restoring `MID`.
        expect(statusOf(r, 'app#build')).toBe('success')
        expect(await readFile(path.join(app, 'dist', 'out.txt'), 'utf8')).toBe('A1\n')
      },
      TIMEOUT,
    )
  }
})

// The key folds the files the listing held; a file ADDED under an input glob
// while the command ran was read by it (`cat src/*`) and folded by nothing,
// and the entry replayed it after the file was gone.
describe('an input file added during the run', () => {
  const ADDS = (cmd: string, files = "['src/**']") => `
    export default {
      tasks: {
        build: {
          exec: { command: 'touch started; while [ ! -f go ]; do sleep 0.01; done; ${cmd}' },
          inputs: { files: ${files} }, cache: { outputs: { files: ['dist/**'] } },
        },
      },
    }
  `
  const BUILD = 'mkdir -p dist; cat src/* src/*/* > dist/out.txt 2>/dev/null; true'

  async function addedDuring(rel: string, config = ADDS(BUILD)): Promise<string> {
    const app = await addProject(root, 'app', { config, files: { 'src/in.txt': 'hi\n' } })
    await writeFile(path.join(root, '.gitignore'), '.vx/cache/\ndist/\nstarted\ngo\n*.log\n')
    commit()
    const pending = runTask('build')
    await reached(path.join(app, 'started'))
    await mkdir(path.dirname(path.join(app, rel)), { recursive: true })
    await writeFile(path.join(app, rel), 'NEW\n')
    await writeFile(path.join(app, 'go'), '')
    await pending
    return app
  }

  it(
    'in a listed directory: the entry is withheld, naming the file, and the next run rebuilds',
    async () => {
      const app = await addedDuring('src/new.txt')
      expect(status.filter((l) => MOVED.test(l))).toEqual([
        '[vx] app#build: `packages/app/src/new.txt` changed after its key was taken — the result stands, but is not saved under a key that no longer describes it; if the task writes it, declare it in cache.outputs',
      ])
      await rm(path.join(app, 'src', 'new.txt'))
      await rm(path.join(app, 'dist'), { recursive: true, force: true })
      const again = await runTask('build')
      // Before the fix: a local hit restoring `hi NEW`.
      expect(statusOf(again, 'app#build')).toBe('success')
      expect(await readFile(path.join(app, 'dist', 'out.txt'), 'utf8')).toBe('hi\n')
    },
    TIMEOUT,
  )

  it(
    'in a directory created during the run: the entry is withheld',
    async () => {
      await addedDuring('src/sub/new.txt')
      expect(status.filter((l) => MOVED.test(l))).toEqual([
        '[vx] app#build: `packages/app/src/sub/new.txt` changed after its key was taken — the result stands, but is not saved under a key that no longer describes it; if the task writes it, declare it in cache.outputs',
      ])
    },
    TIMEOUT,
  )

  it(
    'a literal input absent when the key was taken: the entry is withheld',
    async () => {
      await addedDuring('extra.txt', ADDS(BUILD, "['src/**', 'extra.txt']"))
      expect(status.filter((l) => MOVED.test(l))).toEqual([
        '[vx] app#build: `packages/app/extra.txt` changed after its key was taken — the result stands, but is not saved under a key that no longer describes it; if the task writes it, declare it in cache.outputs',
      ])
    },
    TIMEOUT,
  )

  it(
    'control: an ignored file, or one no glob matches, added during the run is no move',
    async () => {
      const app = await addProject(root, 'app', {
        config: ADDS(`touch src/x.log other.txt; ${BUILD}`),
        files: { 'src/in.txt': 'hi\n' },
      })
      await writeFile(path.join(root, '.gitignore'), '.vx/cache/\ndist/\nstarted\ngo\n*.log\n')
      commit()
      await writeFile(path.join(app, 'go'), '')
      await runTask('build')
      expect(status.filter((l) => MOVED.test(l))).toEqual([])
      expect(statusOf(await runTask('build'), 'app#build')).toBe('cache-hit')
    },
    TIMEOUT,
  )
})

describe('control: inputs an upstream wrote just before are not a move', () => {
  it(
    'a codegen consumer is saved on its first run and hits on its second',
    async () => {
      // `gen` writes the consumer's input milliseconds before the consumer's
      // key: inside the racy window, so the re-check hashes it — and finds
      // the digest the key folded.
      await addProject(root, 'app', {
        config: `
          export default {
            tasks: {
              gen: {
                exec: { command: 'printf generated > gen.txt' },
                inputs: { files: ['src/**'] }, cache: { outputs: { files: ['gen.txt'] } },
              },
              build: {
                dependsOn: ['gen'],
                exec: { command: 'mkdir -p dist; cat gen.txt > dist/out.txt' },
                inputs: { files: ['src/**', 'gen.txt'], tasks: [] }, cache: { outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
        files: { 'src/a.txt': 'a' },
      })
      await writeFile(path.join(root, '.gitignore'), '.vx/cache/\ndist/\n')
      commit()
      await writeLocalWorkspace(root, [edgesSource({ app: ['lib'] })])
      await runTask('build')
      expect(status.filter((l) => MOVED.test(l))).toEqual([])
      expect(statusOf(await runTask('build'), 'app#build')).toBe('cache-hit')
    },
    TIMEOUT,
  )
})

describe('movedInput — which files the re-check hashes again', () => {
  /** A cache whose `hashFile` records each call and answers `digest`. */
  const counting = (digest: string): { cache: CacheLayer; calls: string[] } => {
    const calls: string[] = []
    const cache = {
      hashFile: async (p: string) => {
        calls.push(p)
        return digest
      },
    } as unknown as CacheLayer
    return { cache, calls }
  }

  it('a file last changed well before its fact is not read at all', async () => {
    const f = path.join(root, 'old.txt')
    await writeFile(f, 'x')
    const ctime = lstatSync(f).ctimeMs
    const { cache, calls } = counting('d')
    const facts = [{ path: f, digest: 'OTHER', since: ctime + FILE_HASH_RACY_MS * 4 }]
    expect(await movedInput(facts, cache)).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('one changed inside the racy window BEFORE its fact is read again, as git reads its index', async () => {
    // A coarse clock stamps a write just after the fact with a time just
    // before it; the window is what catches that write.
    const f = path.join(root, 'racy.txt')
    await writeFile(f, 'x')
    const ctime = lstatSync(f).ctimeMs
    const same = counting('d')
    expect(
      await movedInput(
        [{ path: f, digest: 'd', since: ctime + FILE_HASH_RACY_MS / 2 }],
        same.cache,
      ),
    ).toBeUndefined()
    expect(same.calls).toEqual([f])
    const other = counting('e')
    expect(
      await movedInput(
        [{ path: f, digest: 'd', since: ctime + FILE_HASH_RACY_MS / 2 }],
        other.cache,
      ),
    ).toBe(f)
  })

  it('one written at or after the command started has moved, whatever it holds, and is not read', async () => {
    const f = path.join(root, 'during.txt')
    await writeFile(f, 'x')
    const ctime = lstatSync(f).ctimeMs
    const { cache, calls } = counting('d')
    expect(await movedInput([{ path: f, digest: 'd', since: ctime - 1000 }], cache, ctime)).toBe(f)
    expect(calls).toEqual([])
    // CONTROL: the same file written before the command is judged by content.
    expect(
      await movedInput([{ path: f, digest: 'd', since: ctime }], cache, ctime + 1),
    ).toBeUndefined()
    expect(calls).toEqual([f])
  })

  it('a file that is gone has moved, and nothing is read', async () => {
    const { cache, calls } = counting('d')
    const gone = path.join(root, 'gone.txt')
    expect(await movedInput([{ path: gone, digest: 'd', since: 0 }], cache)).toBe(gone)
    expect(calls).toEqual([])
  })
})

describe('describeTaskInputs dates each fact from where it was learned', () => {
  it(
    'an index OID from the enumeration start, a hashed file from the describe',
    async () => {
      const dir = await addProject(root, 'app', { files: { 'tracked.txt': 't' } })
      commit()
      await writeFile(path.join(dir, 'untracked.txt'), 'u')
      const before = Date.now()
      const git = new GitFilesCache()
      await applyGitEnumeration(await startGitEnumeration(root, ['.']), root, [dir], git)
      const after = Date.now()
      expect(git.enumeratedAtMs).toBeGreaterThanOrEqual(before)
      expect(git.enumeratedAtMs).toBeLessThanOrEqual(after)
      // Later than the enumeration by more than any clock step between them.
      await Bun.sleep(5)
      const cache = new Cache(path.join(root, '.vx', 'cache'))
      try {
        const described = await describeTaskInputs({
          node: {
            id: 'app#t',
            projectName: 'app',
            projectDir: dir,
            taskName: 't',
            config: {
              exec: { command: 'true' },
              inputs: { files: ['*.txt'] },
              cache: { outputs: { files: [] } },
            },
            deps: [],
            requested: true,
          } as TaskNode,
          upstream: [],
          workspaceRoot: root,
          cache,
          nestedProjectDirs: [],
          gitFilesCache: git,
        })
        const since = Object.fromEntries(
          described.facts.map((f) => [path.relative(dir, f.path), f.since]),
        )
        expect(Object.keys(since).sort()).toEqual(['tracked.txt', 'untracked.txt'])
        expect(since['tracked.txt']).toBe(git.enumeratedAtMs!)
        expect(since['untracked.txt']).toBeGreaterThan(git.enumeratedAtMs!)
      } finally {
        cache.close()
      }
    },
    TIMEOUT,
  )
})
