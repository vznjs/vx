// A refused write reaches SRT's store over a Unix socket vx serves, not
// with the task's exit. A task that refused a write and ended at once was
// read before its record arrived, and failed with no violation named: the
// mkdir CONTROL in sandbox-mkdir-ancestor went red on main once, and 38 of
// 200 such tasks run 16 at a time reported nothing.
import { realpathSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from './helpers/orchestrator.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const available = await sandboxAvailable('sandbox observer drain test')
const quiet = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

describe.skipIf(!available || process.platform !== 'linux')(
  'a fast task that refused a write',
  () => {
    let root: string
    beforeEach(async () => {
      root = realpathSync(await makeWorkspace({ prefix: 'vx-observer-drain-' }))
    })
    afterEach(() => rm(root, { recursive: true, force: true }))

    it('names the refusal, however many end at once', async () => {
      const projects = 32
      for (let i = 0; i < projects; i++) {
        const dir = await addProject(root, `p${i}`, {
          config: `export default { tasks: { t: { exec: {
          command: 'mkdir -p node_modules/.cache/tool',
          sandbox: { allow: { read: ['.'] } },
        } } } }\n`,
        })
        await mkdir(`${dir}/node_modules/dep`, { recursive: true })
      }
      const unnamed: string[] = []
      for (let round = 0; round < 3; round++) {
        const r = await run({ cwd: root, tasks: ['t'], concurrency: 16, log: quiet })
        expect(r.outcomes.map((o) => o.status)).toEqual(Array(projects).fill('failed'))
        for (const o of r.outcomes) if ((o.sandboxViolations ?? 0) === 0) unnamed.push(o.node.id)
      }
      expect(unnamed).toEqual([])
    }, 120_000)
  },
)
