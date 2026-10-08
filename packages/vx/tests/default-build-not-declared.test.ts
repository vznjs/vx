// The default build is a graph node, shown in `vx show` and `vx info`,
// but no task `vx run build --all` takes: no project declares it. So
// `vx build` and `vx show build` must not name it as one (X-145).

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
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
      'vx run: no projects declare task(s): build. Tasks: test.\n',
    ])
  })

  it('`vx build` and `vx biuld` are unknown commands, not a hint to that run', () => {
    expect(vx('build')[2].split('\n')[0]).toBe('vx: unknown command: build (see `vx help`)')
    expect(vx('biuld')[2].split('\n')[0]).toBe('vx: unknown command: biuld (see `vx help`)')
    // Control: a declared task is still hinted.
    expect(vx('test')).toEqual([
      1,
      '',
      'vx: `test` is a task here, not a command: vx run test --all\n',
    ])
  })

  it('`vx show build` names no project; `vx show` still counts it', () => {
    const [code, out, err] = vx('show', 'build')
    expect([code, out]).toEqual([1, ''])
    expect(err.split('\n')[0]).toStartWith('vx show: unknown project or task: "build"')
    expect(
      vx('show', 'test')[1]
        .split('\n')
        .filter((l) => l.includes(' — ')),
    ).toEqual(['x — packages/x', 'y — packages/y'])
    expect(vx('show')[1]).toBe(['x  packages/x  2 tasks', 'y  packages/y  2 tasks', ''].join('\n'))
  })
})
