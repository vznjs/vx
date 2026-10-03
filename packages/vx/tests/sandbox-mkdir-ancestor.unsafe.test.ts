// The write observer records every write ATTEMPT, so `mkdir -p
// node_modules/.cache/tool` under a grant of `node_modules/.cache/` read
// as a refused write of `node_modules`: the call met EEXIST on a directory
// bwrap made to mount the bind, wrote nothing, and failed a clean task
// (2026-10-03).
import { realpathSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { refusedWrites } from '../src/exec/sandbox-violations.js'
import { run } from '../src/orchestrator/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

describe('refusedWrites › a mkdir', () => {
  const p = '/ws/p'
  it('of a directory a write bind lies in is no refusal; beside it, one is', () => {
    expect(
      refusedWrites(
        [
          `deny mkdir ${p}/node_modules`,
          `deny mkdir ${p}/node_modules/.cache`,
          `deny mkdir ${p}/other`,
          `deny openat ${p}/node_modules/x`,
        ],
        [`${p}/node_modules/.cache/`],
      ).map((v) => v.target),
    ).toEqual([`${p}/other`, `${p}/node_modules/x`])
  })
})

const available = await sandboxAvailable('sandbox mkdir ancestor test')
const quiet = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

describe.skipIf(!available || process.platform !== 'linux')(
  'mkdir -p up to a write grant, run for real',
  () => {
    let root: string
    beforeEach(async () => {
      root = realpathSync(await makeWorkspace({ prefix: 'vx-mkdir-anc-' }))
    })
    afterEach(() => rm(root, { recursive: true, force: true }))

    const outcome = async (write: string[]) => {
      const dir = await addProject(root, 'app', {
        config: `export default { tasks: { t: { exec: {
        command: 'mkdir -p node_modules/.cache/tool && echo c > node_modules/.cache/tool/f',
        sandbox: { allow: { read: ['.'], write: ${JSON.stringify(write)} } },
      } } } }\n`,
      })
      await mkdir(path.join(dir, 'node_modules', 'dep'), { recursive: true })
      await writeFile(path.join(dir, 'node_modules', 'dep', 'index.js'), 'x\n')
      const r = await run({ cwd: root, tasks: ['t'], log: quiet })
      return [r.outcomes[0]?.status, r.outcomes[0]?.sandboxViolations ?? 0]
    }

    it('passes when the cache directory is granted', async () => {
      expect(await outcome(['node_modules/.cache/'])).toEqual(['success', 0])
    })

    it('CONTROL: fails when it is not', async () => {
      const [status, count] = await outcome([])
      expect([status, (count as number) > 0]).toEqual(['failed', true])
    })
  },
)
