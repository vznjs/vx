// A package with no `build` script, turbo.json's `build: { dependsOn:
// ["^build"] }`: `cd packages/app && turbo run build` runs lib#build. Left
// to core's default `build`, which a bare name skips (X-102), `vx run
// build` there was refused "no projects declare task(s): build"; `lint` of
// the same shape ran.
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { planRun } from '../../vx/tests/helpers/orchestrator.js'
import { silent, useTurboWorkspace } from './helpers/turbo-workspace.js'

const ws = useTurboWorkspace({ tasks: { build: { dependsOn: ['^build'], outputs: ['dist/**'] } } })

describe('a script-less build behind ^build', () => {
  it("runs the dependencies' builds when the package is the scope", async () => {
    await writeFile(
      path.join(ws.root, 'packages', 'app', 'package.json'),
      JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { lib: 'workspace:*' } }),
    )
    Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: ws.root })
    const plan = await planRun({ cwd: ws.root, tasks: ['build'], projects: ['app'], log: silent() })
    expect(
      plan.tasks
        .map((t) => [t.node.id, t.node.config.exec?.command ?? null])
        .toSorted((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['app#build', null],
      ['lib#build', 'mkdir -p dist && echo lib > dist/lib.js'],
    ])
  }, 30_000)
})
