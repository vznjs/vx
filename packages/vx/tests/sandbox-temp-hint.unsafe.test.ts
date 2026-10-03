// A sandboxed write refused under the host's temp directory was told to
// grant it (`allow: { write: ['/tmp/'] }`), which opens the shared temp
// directory to every write of the task. The task has an empty temp
// directory of its own, so the hint names $TMPDIR (2026-10-03).
import { realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from '../src/orchestrator/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const available = await sandboxAvailable('sandbox temp hint test')
const quiet = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }
const REFUSED =
  'vx: the sandbox refused writes outside the project, which are not reported as violations:'

// Linux: macOS logs the record late or not at all.
describe.skipIf(!available || process.platform !== 'linux')('a refused write', () => {
  let root: string
  beforeEach(async () => {
    root = realpathSync(await makeWorkspace({ prefix: 'vx-temp-hint-' }))
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  const lines = async (target: string) => {
    await addProject(root, 'app', {
      config: `export default { tasks: { t: { exec: {
        command: 'echo x > ${target}',
        sandbox: { allow: { read: ['.'] } },
      } } } }\n`,
    })
    const r = await run({ cwd: root, tasks: ['t'], log: quiet })
    return r.outcomes[0]?.sandboxViolationLines
  }

  it('under the host temp directory names $TMPDIR, not a grant of it', async () => {
    const outside = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-temp-out-')))
    try {
      expect(await lines(`${outside}/f`)).toEqual([
        `${REFUSED} ${outside}/f. The task has its own temp directory, empty at its start: ` +
          'write under $TMPDIR (os.tmpdir() in Node and Bun) instead of a fixed path.',
      ])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('CONTROL: in a workspace kept under it, names the grant', async () => {
    expect(await lines('../../out.txt')).toEqual([
      `${REFUSED} ${root}/out.txt. If the task needs one, grant its directory, e.g. ` +
        "`allow: { write: ['../../'] }`.",
    ])
  })
})
