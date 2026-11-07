// The default build is a graph node, shown in `vx show` and `vx info`,
// but no task `vx run build --all` takes: no project declares it. So
// `vx build` and `vx show build` must not name it as one (X-145).

import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { noticed } from './helpers/notice.js'
import { panelTop } from '../src/ui/index.js'

const gradientRule = (c: { enabled: boolean }, title: string): string => panelTop(title, c)

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const TEST = `export default { tasks: { test: { exec: { command: 'echo t' } } } }`

let root: string
beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-default-build-' })
  await addProject(root, 'x', TEST)
  await addProject(root, 'y', { config: TEST, deps: { x: 'workspace:*' } })
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

function vx(...args: string[]): [number, string, string] {
  const p = Bun.spawnSync({ cmd: [process.execPath, BIN, ...args], cwd: root, stdin: 'ignore' })
  return [p.exitCode, p.stdout.toString(), p.stderr.toString()]
}

describe('the default build is no declared task', () => {
  it('`vx run build --all` refuses it (the claim the others follow)', () => {
    expect(vx('run', 'build', '--all')).toEqual([
      1,
      '',
      noticed(
        'vx run: no projects declare task(s): build. Tasks: test. A run reads the lock: after editing a vx.config, run `vx lock`.\n',
      ),
    ])
  })

  it('a project-scoped typo neither lists nor hints it', () => {
    expect(vx('run', 'x#nope')[2]).toBe(
      noticed(
        "vx run: no projects declare task(s): x#nope. x's tasks: test. A run reads the lock: after editing a vx.config, run `vx lock`.\n",
      ),
    )
    expect(vx('run', 'x#buil')[2]).not.toContain('x#build')
  })

  it('`vx build` and `vx biuld` are unknown commands, not a hint to that run', () => {
    expect(vx('build')[2].split('\n')[0]).toBe('✗ vx  unknown command: build')
    expect(vx('biuld')[2].split('\n')[0]).toBe('✗ vx  unknown command: biuld')
    // Control: a declared task is still hinted.
    expect(vx('test')).toEqual([
      1,
      '',
      noticed('vx: `test` is a task here, not a command (did you mean vx run test --all?)\n'),
    ])
  })

  it('`vx show build` names no project; `vx show` still counts it', () => {
    const [code, out, err] = vx('show', 'build')
    expect([code, out]).toEqual([1, ''])
    expect(err.split('\n')[0]).toStartWith('✗ vx show  unknown project or task: "build"')
    expect(
      vx('show', 'test')[1]
        .split('\n')
        // A title line is its one word in the gutter; a field row has a value past its label.
        .filter((l) => /^ {2}\S+$/.test(l)),
    ).toEqual([
      gradientRule({ enabled: false }, 'x#test'),
      gradientRule({ enabled: false }, 'y#test'),
    ])
    expect(vx('show')[1]).toBe(
      [
        panelTop('Projects', { enabled: false }, '2'),
        '  project  dir         tasks',
        '  x        packages/x  2 tasks, default build',
        '  y        packages/y  2 tasks, default build',
        '',
      ].join('\n'),
    )
  })
})

describe('a workspace that declares no task yet', () => {
  let fresh: string
  beforeAll(async () => {
    fresh = await makeWorkspace({ prefix: 'vx-no-task-yet-' })
    await addProject(fresh, 'x', 'export default { tasks: {} }')
  })
  afterAll(async () => {
    await rm(fresh, { recursive: true, force: true })
  })

  // Right after `vx init` the lock is current: "run `vx lock`" alone sent
  // a new user to a command that changed nothing.
  it('`vx run build` says to declare a task, not only to lock', () => {
    const p = Bun.spawnSync({
      cmd: [process.execPath, BIN, 'run', 'build', '--all'],
      cwd: fresh,
      stdin: 'ignore',
    })
    expect([p.exitCode, p.stderr.toString()]).toEqual([
      1,
      noticed(
        'vx run: no projects declare task(s): build. No project declares a task yet: add one under `tasks` in a vx.config, then run `vx lock`.\n',
      ),
    ])
  })

  // From the root, the run selects the root project alone, which declares
  // nothing: that is no sign the workspace declares nothing.
  it('a run from a root that declares nothing still lists the tasks elsewhere', async () => {
    const ws = await makeWorkspace({ prefix: 'vx-root-no-task-' })
    try {
      await writeFile(path.join(ws, 'vx.config.mjs'), 'export default { tasks: {} }\n')
      await addProject(ws, 'x', TEST)
      const p = Bun.spawnSync({
        cmd: [process.execPath, BIN, 'run', 'lint'],
        cwd: ws,
        stdin: 'ignore',
      })
      expect(p.stderr.toString()).not.toContain('No project declares a task yet')
      expect(p.stderr.toString()).toContain('Tasks: test')
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })
})
