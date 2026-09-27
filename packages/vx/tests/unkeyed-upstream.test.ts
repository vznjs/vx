// A task that ran over an upstream's outputs, when that upstream's key no
// longer describes them, saves nothing (A-12). `gen`'s input was edited
// while it ran: it withheld its own save (item 1015), yet `use` saved what
// it built from the edit under a key that folds `gen`'s pre-edit key, and
// once the input was put back `use` was a hit on the edit's output.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { run, type Logger } from '../src/orchestrator/index.js'
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
               cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } } },
        use: { dependsOn: ['gen'], exec: { command: 'mkdir -p out && cat dist/gen.txt > out/use.txt' },
               cache: { inputs: { files: ['lib/**'] }, outputs: { files: ['out/**'] } } },
        pack: { dependsOn: ['use'], exec: { command: 'mkdir -p pkg && cat out/use.txt > pkg/p.txt' },
                cache: { inputs: { files: ['lib/**'] }, outputs: { files: ['pkg/**'] } } } } }`,
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
