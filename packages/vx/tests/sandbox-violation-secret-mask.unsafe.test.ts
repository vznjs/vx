// A sandbox violation line is the path the task tried, as it spelled it:
// a task that wrote under a name built from a secret saw `***` in its own
// stderr and the value in the SANDBOX VIOLATIONS section and the
// telemetry outcome beside it (L-11).
import { realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from '../src/orchestrator/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const available = await sandboxAvailable('sandbox violation secret mask test')
const quiet = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }
const REFUSED =
  'vx: the sandbox refused writes outside the project, which are not reported as violations:'
const GRANT = "If the task needs one, grant its directory, e.g. `allow: { write: ['../../'] }`."

// Linux: macOS logs the record late or not at all.
describe.skipIf(!available || process.platform !== 'linux')('a violation line', () => {
  let root: string
  beforeEach(async () => {
    root = realpathSync(await makeWorkspace({ prefix: 'vx-violation-mask-' }))
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  const lines = async (name: string) => {
    await addProject(root, 'app', {
      config: `export default { tasks: { t: { exec: {
        command: 'echo x > ../../out-$${name}',
        env: { define: { ${name}: 'definedvalue77' } },
        sandbox: { allow: { read: ['.'] } },
      } } } }\n`,
    })
    const r = await run({ cwd: root, tasks: ['t'], log: quiet })
    return r.outcomes[0]?.sandboxViolationLines
  }

  it('masks a secret in the path it names', async () => {
    expect(await lines('DEPLOY_KEY')).toEqual([`${REFUSED} ${root}/out-***. ${GRANT}`])
  })

  it('CONTROL: a value under a plain name is printed as the task spelled it', async () => {
    expect(await lines('OUT_NAME')).toEqual([`${REFUSED} ${root}/out-definedvalue77. ${GRANT}`])
  })
})
