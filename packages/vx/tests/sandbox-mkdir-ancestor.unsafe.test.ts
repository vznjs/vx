// The write observer records every write ATTEMPT, so `mkdir -p
// node_modules/.cache/tool` under a grant of `node_modules/.cache/` read
// as a refused write of `node_modules`: the call met EEXIST on a directory
// bwrap made to mount the bind, wrote nothing, and failed a clean task
// (2026-10-03).
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
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

// `mkdir -p src` under `read: ['src']` met EEXIST, wrote nothing, and the
// attempt failed a clean task: the directory was readable, so it existed
// where the task looked.
describe('refusedWrites › a mkdir of a directory the task can see', () => {
  let p: string
  beforeEach(async () => {
    p = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-mkdir-seen-')))
    await mkdir(path.join(p, 'src', 'lib'), { recursive: true })
    await mkdir(path.join(p, 'gen'))
  })
  afterEach(() => rm(p, { recursive: true, force: true }))

  it('under a read grant, or above one, is no refusal; one it cannot see is', () => {
    expect(
      refusedWrites(
        [
          `deny mkdir ${p}/src`,
          `deny mkdir ${p}/src/lib`,
          `deny mkdir ${p}/src/new`,
          `deny mkdir ${p}/gen`,
          `deny openat ${p}/src/lib/x`,
        ],
        [],
        [],
        [`${p}/src`],
      ).map((v) => v.target),
    ).toEqual([`${p}/src/new`, `${p}/gen`, `${p}/src/lib/x`])
    expect(
      refusedWrites([`deny mkdir ${p}/src`], [], [], [`${p}/src/lib`]).map((v) => v.target),
    ).toEqual([])
    // A grant naming nothing is not mounted: what it names, and above it, is not there.
    expect(
      refusedWrites(
        [`deny mkdir ${p}/src/none`, `deny mkdir ${p}/src`],
        [],
        [],
        [`${p}/src/none`],
      ).map((v) => v.target),
    ).toEqual([`${p}/src/none`, `${p}/src`])
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

    it('mkdir -p of a directory a read grant shows passes; of a new one, fails', async () => {
      const dir = await addProject(root, 'app', {
        config: `export default { tasks: {
        seen: { exec: { command: 'mkdir -p src/lib && echo ok', sandbox: { allow: { read: ['src'] } } } },
        made: { exec: { command: 'mkdir -p gen || true', sandbox: { allow: { read: ['src'] } } } },
      } }\n`,
      })
      await mkdir(path.join(dir, 'src', 'lib'), { recursive: true })
      const r = await run({ cwd: root, tasks: ['seen', 'made'], log: quiet })
      const by = Object.fromEntries(
        r.outcomes.map((o) => [o.node.id, [o.status, o.sandboxViolations ?? 0]]),
      )
      expect(by).toEqual({ 'app#seen': ['success', 0], 'app#made': ['failed', 1] })
    })
  },
)
