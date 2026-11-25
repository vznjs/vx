// `compile: { dependsOn: ["^compile"], cache: false }` and `lib` has no
// compile script: Turbo's no-op `lib#compile` still hashes lib's files
// into `app#test`, cached or not. Skipped as uncached, the node keyed
// nothing, and an edit to lib replayed app#test (a stale hit).
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { planRun } from '../../vx/tests/helpers/orchestrator.js'
import { silent, useTurboWorkspace } from './helpers/turbo-workspace.js'

const ws = useTurboWorkspace({
  tasks: {
    compile: { dependsOn: ['^compile'], cache: false },
    test: { dependsOn: ['^compile'] },
  },
})

describe('an uncached no-op node', () => {
  it("keys a dependant's task on the script-less package's files", async () => {
    const pkg = (name: string, scripts: object, dependencies?: object) =>
      writeFile(
        path.join(ws.root, 'packages', name, 'package.json'),
        JSON.stringify({ name, version: '1.0.0', scripts, dependencies }),
      )
    await pkg('lib', {})
    await pkg('app', { compile: 'echo c', test: 'cat ../lib/src/index.js' }, { lib: 'workspace:*' })
    Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: ws.root })
    const key = async () => {
      const plan = await planRun({ cwd: ws.root, tasks: ['app#test'], log: silent() })
      return plan.tasks.find((t) => t.node.id === 'app#test')!.hash
    }
    const before = await key()
    await writeFile(path.join(ws.root, 'packages', 'lib', 'src', 'index.js'), '// edited\n')
    expect(await key()).not.toBe(before)
  }, 30_000)
})
