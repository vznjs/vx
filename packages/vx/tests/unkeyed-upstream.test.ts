// A task that ran over an upstream's outputs, when that upstream's key no
// longer describes them, saves nothing (A-12). `gen`'s input was edited
// while it ran: it withheld its own save (item 1015), yet `use` saved what
// it built from the edit under a key that folds `gen`'s pre-edit key, and
// once the input was put back `use` was a hit on the edit's output.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { type Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const TIMEOUT = 30_000
let root: string
let lines: string[]
const log: Logger = {
  status: (l) => lines.push(l),
  taskStdout: () => {},
  taskStderr: () => {},
  taskComplete: () => {},
}

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-unkeyed-' })
  lines = []
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it(
  'a dependant of a task whose key no longer held is not saved, nor is its own dependant',
  async () => {
    // `gen` waits for `go`, which the row writes after its edit: the edit
    // lands while `gen` runs, on a marker, never a timed wait.
    const app = await addProject(root, 'app', {
      config: `export default { tasks: {
        gen: { exec: { command: 'touch started; while [ ! -f go ]; do sleep 0.01; done; mkdir -p dist && cp src/a.txt dist/gen.txt' },
               inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } } },
        use: { dependsOn: ['gen'], exec: { command: 'mkdir -p out && cat dist/gen.txt > out/use.txt' },
               inputs: { files: ['lib/**'] }, cache: { outputs: { files: ['out/**'] } } },
        pack: { dependsOn: ['use'], exec: { command: 'mkdir -p pkg && cat out/use.txt > pkg/p.txt' },
                inputs: { files: ['lib/**'] }, cache: { outputs: { files: ['pkg/**'] } } } } }`,
      files: {
        'src/a.txt': 'one',
        'lib/x.txt': 'x',
        '.gitignore': 'dist/\nout/\npkg/\ngo\nstarted\n',
      },
    })
    gitIn(root)('add', '-A')
    gitIn(root)('commit', '-q', '-m', 'fixture')
    const go = path.join(app, 'go')
    const started = path.join(app, 'started')
    const build = async (edit?: () => void) => {
      await rm(go, { force: true })
      await rm(started, { force: true })
      const done = run({ cwd: root, tasks: ['app#pack'], log, handleSignals: false })
      // `gen`'s key is taken before its command starts, and the command
      // touches `started` first: the edit lands after the key, before the read.
      const deadline = Date.now() + 10_000
      while (!existsSync(started) && Date.now() < deadline) await Bun.sleep(10)
      edit?.()
      writeFileSync(go, '')
      return done
    }
    await build(() => writeFileSync(path.join(app, 'src/a.txt'), 'two'))
    expect(lines.filter((l) => l.includes('ran over'))).toEqual([
      "[vx] app#use: ran over app#gen's outputs, which its key no longer describes — the result stands, but is not saved",
      "[vx] app#pack: ran over app#use's outputs, which its key no longer describes — the result stands, but is not saved",
    ])
    writeFileSync(path.join(app, 'src/a.txt'), 'one')
    const second = await build()
    expect(second.outcomes.map((o) => `${o.node.id}:${o.status}`).sort()).toEqual([
      'app#gen:success',
      'app#pack:success',
      'app#use:success',
    ])
    expect(readFileSync(path.join(app, 'pkg/p.txt'), 'utf8')).toBe('one')
  },
  TIMEOUT,
)

it(
  'a task of another project that reads the moved input, with no edge to the writer, is not saved',
  async () => {
    // `lib#fmt` rewrites its input once `app#read` has started, then lets
    // `app#read` read it: the reader's key folded the bytes from before.
    await addProject(root, 'lib', {
      config: `export default { tasks: {
        fmt: { exec: { command: 'while [ ! -f ../app/started ]; do sleep 0.01; done; echo more >> src/a.txt; touch ../app/go' },
               inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } } } } }`,
      files: { 'src/a.txt': 'one\n' },
    })
    await addProject(root, 'app', {
      config: `export default { tasks: {
        read: { exec: { command: 'touch started; while [ ! -f go ]; do sleep 0.01; done; cat ../lib/src/a.txt > out.txt' },
                inputs: { files: ['src/**'], workspaceFiles: ['packages/lib/src/a.txt'] },
                cache: { 
                         outputs: { files: ['out.txt'] } } } } }`,
      files: { 'src/x.txt': 'x', '.gitignore': 'out.txt\ngo\nstarted\n' },
    })
    gitIn(root)('add', '-A')
    gitIn(root)('commit', '-q', '-m', 'fixture')
    // Two slots: the tasks wait on each other, and a one-core runner's
    // default of one slot ran one forever, waiting for the other.
    const r = await run({
      cwd: root,
      tasks: ['lib#fmt', 'app#read'],
      log,
      handleSignals: false,
      concurrency: 2,
    })
    expect(r.ok).toBe(true)
    expect(lines.filter((l) => l.startsWith('[vx] app#read:'))).toEqual([
      '[vx] app#read: `packages/lib/src/a.txt` changed after its key was taken — the result stands, but is not saved under a key that no longer describes it; if the task writes it, declare it in cache.outputs',
    ])
    // The old bytes back: no entry holds the new ones under their key.
    gitIn(root)('checkout', '--', 'packages/lib/src/a.txt')
    for (const m of ['started', 'go']) await rm(path.join(root, 'packages/app', m), { force: true })
    writeFileSync(path.join(root, 'packages/app/go'), '')
    const again = await run({ cwd: root, tasks: ['app#read'], log, handleSignals: false })
    expect(again.outcomes.find((o) => o.node.id === 'app#read')?.status).toBe('success')
  },
  TIMEOUT,
)
