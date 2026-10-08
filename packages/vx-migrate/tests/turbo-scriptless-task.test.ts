// documenso's `lint` and shadcn-ui's `check`: turbo.json defines the task
// and no package has a script for it. `turbo run lint` runs a no-op node per
// package and exits 0 (2.11 dry run: `app#lint` → `lib#lint`, both
// `<NONEXISTENT>`); vx refused with "no projects declare task(s): lint", so a
// migrated CI step broke.
import { describe, expect, it } from 'bun:test'
import { planRun } from '@vzn/vx'
import { silent, useTurboWorkspace } from './helpers/turbo-workspace.js'

const ws = useTurboWorkspace({
  tasks: { build: { dependsOn: ['^build'] }, lint: { dependsOn: ['^lint'] }, check: {} },
})

describe('a task no package has a script for', () => {
  it("is Turbo's no-op node in each package, edges kept", async () => {
    const plan = async (task: string) => {
      const p = await planRun({ cwd: ws.root, tasks: [task], log: silent() })
      return p.tasks
        .toSorted((a, b) => a.node.id.localeCompare(b.node.id))
        .map((t) => [t.node.id, t.node.config.exec?.command ?? null, t.node.deps])
    }
    expect([await plan('lint'), await plan('check')]).toEqual([
      [
        ['app#lint', null, ['lib#lint']],
        ['lib#lint', null, []],
      ],
      [
        ['app#check', null, []],
        ['lib#check', null, []],
      ],
    ])
  }, 30_000)
})
