// with-shell-commands: `build: { dependsOn: ["prebuild", "^build"] }`, and
// `tooling-config` has neither script. Its edge to `prebuild` made the
// node a group, which keys nothing, so an edit to tooling-config replayed
// every dependant's build; Turbo's no-op node hashes its files.
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { planRun } from '@vzn/vx'
import { silent, useTurboWorkspace } from './helpers/turbo-workspace.js'

const ws = useTurboWorkspace({
  tasks: {
    build: { dependsOn: ['prebuild', '^build'], outputs: ['dist/**'] },
    prebuild: {},
  },
})

describe('a no-op node with an edge of its own', () => {
  it("keys a dependant's task on the script-less package's files", async () => {
    await writeFile(
      path.join(ws.root, 'packages', 'lib', 'package.json'),
      JSON.stringify({ name: 'lib', version: '1.0.0' }),
    )
    Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: ws.root })
    const key = async () => {
      const plan = await planRun({ cwd: ws.root, tasks: ['app#build'], log: silent() })
      return plan.tasks.find((t) => t.node.id === 'app#build')!.hash
    }
    const before = await key()
    await writeFile(path.join(ws.root, 'packages', 'lib', 'src', 'index.js'), '// edited\n')
    expect(await key()).not.toBe(before)
  }, 30_000)
})
