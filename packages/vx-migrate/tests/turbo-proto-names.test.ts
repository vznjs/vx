// A turbo.json task or package.json script named after an Object.prototype
// member (`constructor`, `toString`) is a task like any other: a plain
// `tasks[name]` lookup read the inherited member as already present.
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { planRun } from '@vzn/vx'
import { silent, useTurboWorkspace } from './helpers/turbo-workspace.js'

const ws = useTurboWorkspace({
  tasks: {
    build: { dependsOn: ['^build'], outputs: ['dist/**'] },
    constructor: {},
    toString: { dependsOn: ['constructor'] },
  },
})

describe('a task named after an Object.prototype member', () => {
  it('maps from its script and runs it', async () => {
    await writeFile(
      path.join(ws.root, 'packages', 'lib', 'package.json'),
      JSON.stringify({
        name: 'lib',
        version: '1.0.0',
        scripts: { constructor: 'echo c', toString: 'echo t' },
      }),
    )
    Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: ws.root })
    const log = silent()
    const plan = await planRun({
      cwd: ws.root,
      tasks: ['lib#toString', 'lib#constructor'],
      log,
    })
    const commands = Object.fromEntries(
      plan.tasks.map((t) => [t.node.id, t.node.config.exec?.command]),
    )
    expect(commands).toEqual({ 'lib#constructor': 'echo c', 'lib#toString': 'echo t' })
    // `app` has neither script: Turbo skips the task there, silently.
    expect(log.lines).toEqual([])
  }, 30_000)

  it("inherits a parent's opt-out, not Object's member", async () => {
    // app extends lib, which opts out of `constructor`: Turbo walks to
    // lib's entry. Read off Object, app's own file seemed to define it.
    const write = (pkg: string, json: unknown) =>
      writeFile(path.join(ws.root, 'packages', pkg, 'turbo.json'), JSON.stringify(json))
    await write('lib', { extends: ['//'], tasks: { constructor: { extends: false } } })
    await write('app', { extends: ['lib'], tasks: {} })
    await writeFile(
      path.join(ws.root, 'packages', 'app', 'package.json'),
      JSON.stringify({ name: 'app', version: '1.0.0', scripts: { constructor: 'echo c' } }),
    )
    Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: ws.root })
    const plan = await planRun({ cwd: ws.root, tasks: ['constructor'], log: silent() })
    expect(plan.tasks.map((t) => t.node.id)).toEqual([])
  }, 30_000)
})
