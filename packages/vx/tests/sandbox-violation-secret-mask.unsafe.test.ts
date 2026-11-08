// A sandbox violation line is the path the task tried, as it spelled it:
// a task that wrote under a name built from a secret saw `***` in its own
// stderr and the value in the SANDBOX VIOLATIONS section and the
// telemetry outcome beside it (L-11).
import { realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { decodeOutputLog } from '../src/orchestrator/output-log.js'
import { run } from './helpers/orchestrator.js'
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

// A retry after a refused write: the shell exited 0 and the refusal failed
// the attempt, yet the retry line read `after exit 1` and the refusal went
// with the attempt, absent from its kept log (`vx last --log`).
describe.skipIf(!available || process.platform !== 'linux')('a retry after a violation', () => {
  let root: string
  beforeEach(async () => {
    root = realpathSync(await makeWorkspace({ prefix: 'vx-violation-retry-' }))
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  it('names the violation and keeps its line with the attempt', async () => {
    await addProject(root, 'p', {
      config: `export default { tasks: { build: { exec: {
        command: 'if [ ! -e state/f ]; then : > state/f; echo bad > undeclared; echo OUT1; exit 0; fi; echo OUT2',
        retries: 1,
        sandbox: { allow: { write: ['state/'] } },
      } } } }\n`,
      files: { 'state/.keep': '' },
    })
    const err: string[] = []
    const r = await run({
      cwd: root,
      tasks: ['build'],
      log: { ...quiet, taskStderr: (_n: unknown, c: string) => err.push(c) },
    })
    const o = r.outcomes[0]!
    expect(o.status).toBe('success')
    expect(err.join('')).toContain('vx: retrying p#build (attempt 2/2) after 1 sandbox violation\n')
    const kept = decodeOutputLog(o.attemptOutputs![0]!)
      .map((c) => c.text)
      .join('')
    expect(kept).toContain(`${root}/packages/p/undeclared`)
  })
})
