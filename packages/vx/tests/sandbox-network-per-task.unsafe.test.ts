// The proxy is the run's and reads its allowlist from the run's init, the
// union of every task's (`initSandbox`): a task could reach a host only
// another task of the same run declared.
import { rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from './helpers/orchestrator.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const available = await sandboxAvailable('sandbox per-task network test')
const quiet = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }
const fetching = (host: string) => `"bun -e \\"await fetch('https://${host}').catch(() => {})\\""`

describe.skipIf(!available)('a network grant', () => {
  let root: string
  beforeEach(async () => {
    root = realpathSync(await makeWorkspace({ prefix: 'vx-net-per-task-' }))
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  it('reaches only its own task, not another task of the same run', async () => {
    await addProject(root, 'app', {
      config: `export default { tasks: {
        a: { exec: { command: 'true', sandbox: { allow: { read: ['.'], network: ['a.example.com'] } } } },
        b: { exec: { command: ${fetching('a.example.com')}, sandbox: { allow: { read: ['.'], network: ['b.example.com'] } } } },
      } }\n`,
    })
    const r = await run({ cwd: root, tasks: ['a', 'b'], log: quiet })
    const b = r.outcomes.find((o) => o.node.id.endsWith('#b'))
    expect([b?.status, b?.sandboxViolationLines]).toEqual([
      'failed',
      ['deny network-outbound a.example.com:443 (host is not on the allow list)'],
    ])
  })

  it('reaches nothing from a task that lists no network', async () => {
    await addProject(root, 'app', {
      config: `export default { tasks: {
        a: { exec: { command: 'true', sandbox: { allow: { read: ['.'], network: ['a.example.com'] } } } },
        b: { exec: { command: ${fetching('a.example.com')}, sandbox: { allow: { read: ['.'] } } } },
      } }\n`,
    })
    const r = await run({ cwd: root, tasks: ['a', 'b'], log: quiet })
    const b = r.outcomes.find((o) => o.node.id.endsWith('#b'))
    expect(b?.status).toBe('failed')
  })
})
