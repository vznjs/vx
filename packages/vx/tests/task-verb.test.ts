// `vx build` from a Turbo user's hands, `vx build app` from an Nx user's:
// a task typed where the verb goes is answered with the `vx run` that
// runs it, never a bare "unknown command".

import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { PLUGIN_IMPORT, pluginSource } from './helpers/plugin.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TASKS = `export default { tasks: { build: { exec: { command: 'true' } }, dev: { exec: { command: 'true' } } } }`

let root: string
beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-task-verb-' })
  await addProject(root, 'app', TASKS)
  await addProject(root, 'lib', TASKS)
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

function vx(cwd: string, ...args: string[]): [number, string] {
  const p = Bun.spawnSync({ cmd: [process.execPath, BIN, ...args], cwd })
  return [p.exitCode, p.stderr.toString()]
}

describe('a task typed as a verb', () => {
  it('names the vx run that runs it, from the root, a project, or with a project after it', () => {
    expect(vx(root, 'build')).toEqual([
      1,
      'vx: `build` is a task here, not a command: vx run build --all\n',
    ])
    expect(vx(root, 'build', 'lib')).toEqual([
      1,
      'vx: `build` is a task here, not a command: vx run build --filter lib\n',
    ])
    expect(vx(path.join(root, 'packages', 'app'), 'build')).toEqual([
      1,
      'vx: `build` is a task here, not a command: vx run build\n',
    ])
    expect(vx(root, 'app#build')).toEqual([1, 'vx: `app#build` is a task: vx run app#build\n'])
  })

  it('a `dev` task beats the no-service note; a name no project declares stays unknown', () => {
    expect(vx(root, 'dev')).toEqual([
      1,
      'vx: `dev` is a task here, not a command: vx run dev --all\n',
    ])
    const [code, err] = vx(root, 'buidl')
    expect(code).toBe(1)
    expect(err.split('\n')[0]).toBe('vx: unknown command: buidl (see `vx help`)')
  })

  it("Nx's `project:target` on vx run names the `project#task` it means", () => {
    const run = (cwd: string, ...args: string[]): [number, string, string] => {
      const p = Bun.spawnSync({ cmd: [process.execPath, BIN, 'run', ...args], cwd })
      return [p.exitCode, p.stdout.toString(), p.stderr.toString()]
    }
    expect(run(root, 'app:build', 'lib:dev')).toEqual([
      1,
      '',
      "vx run: `app:build lib:dev` is Nx's project:target: vx run app#build lib#dev\n",
    ])
    expect(run(root, 'app:build', '--all')[1]).toBe(
      'No projects declare task(s): app:build. Did you mean app#build?\n',
    )
    expect(run(path.join(root, 'packages', 'lib'), 'lib:build')[1]).toBe(
      'No projects declare task(s): lib:build. Did you mean lib#build?\n',
    )
    // A task the project does not declare is no Nx spelling: the plain lines stand.
    expect(run(root, 'app:nope')[2]).toBe(
      'vx run: not inside a project. Pass --all for every project, --filter <pattern> to filter, or run from within a project directory.\n',
    )
    expect(run(root, 'app:nope', '--all')[1]).toBe('No projects declare task(s): app:nope.\n')
  })

  it('a plugin verb of the same name is the verb', async () => {
    const ws = path.join(root, 'vx.workspace.mjs')
    const before = await Bun.file(ws).text()
    try {
      await writeFile(
        ws,
        `${PLUGIN_IMPORT}export default { plugins: [${pluginSource(
          'verbs',
          `{ commands: { build: { description: 'x', run: () => { process.stdout.write('plugin\\n'); return 0 } } } }`,
        )}] }\n`,
      )
      const p = Bun.spawnSync({ cmd: [process.execPath, BIN, 'build'], cwd: root })
      expect([p.exitCode, p.stdout.toString()]).toEqual([0, 'plugin\n'])
    } finally {
      await writeFile(ws, before)
    }
  })
})
