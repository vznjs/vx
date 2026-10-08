// opencode: `build: { dependsOn: [] }`, and `app#test` → `^build`. Turbo's
// `^build` reaches the direct dependencies' build nodes, a script-less one
// a no-op that stops there; core walked past it to the builds below, so
// vx ran and keyed builds Turbo's test never waits on.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { planRun } from '@vzn/vx'
import { silent, useTurboWorkspace } from './helpers/turbo-workspace.js'

const ws = useTurboWorkspace({
  tasks: { build: { outputs: ['dist/**'] }, test: { dependsOn: ['^build'] } },
})

describe("a script-less package's node that does not reach further", () => {
  it('stops `^build` there, as Turbo does, and keys its files', async () => {
    // app → mid (no build) → lib (build)
    await mkdir(path.join(ws.root, 'packages', 'mid', 'src'), { recursive: true })
    await writeFile(
      path.join(ws.root, 'packages', 'mid', 'package.json'),
      JSON.stringify({ name: 'mid', version: '1.0.0', dependencies: { lib: 'workspace:*' } }),
    )
    await writeFile(path.join(ws.root, 'packages', 'mid', 'src', 'index.js'), '// mid\n')
    await writeFile(
      path.join(ws.root, 'packages', 'app', 'package.json'),
      JSON.stringify({
        name: 'app',
        version: '1.0.0',
        scripts: { test: 'true' },
        dependencies: { mid: 'workspace:*' },
      }),
    )
    Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: ws.root })
    const plan = async () => await planRun({ cwd: ws.root, tasks: ['app#test'], log: silent() })
    const first = await plan()
    expect(first.tasks.map((t) => t.node.id).sort()).toEqual(['app#test', 'mid#build'])
    const key = (p: typeof first) => p.tasks.find((t) => t.node.id === 'app#test')!.hash
    await writeFile(path.join(ws.root, 'packages', 'lib', 'src', 'index.js'), '// lib edited\n')
    const libEdited = await plan()
    expect(key(libEdited)).toBe(key(first))
    await writeFile(path.join(ws.root, 'packages', 'mid', 'src', 'index.js'), '// mid edited\n')
    expect(key(await plan())).not.toBe(key(first))
  }, 30_000)
})
