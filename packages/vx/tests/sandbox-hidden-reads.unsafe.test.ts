// A sandboxed task that failed on a read the wall refused said only what
// its tool says for a missing file: `tsc` extending a root
// `tsconfig.base.json` read "File not found" and nothing named the
// sandbox. A failed task now names the hidden paths that exist on the
// host (2026-10-02).
import { realpathSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from '../src/orchestrator/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const available = await sandboxAvailable('sandbox hidden reads test')
const quiet = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

describe.skipIf(!available || process.platform !== 'linux')('a read hidden by the wall', () => {
  let root: string
  beforeEach(async () => {
    root = realpathSync(await makeWorkspace({ prefix: 'vx-hidden-read-' }))
    await writeFile(path.join(root, 'tsconfig.base.json'), '{}\n')
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  const outcome = async (command: string) => {
    await addProject(root, 'app', {
      config: `export default { tasks: { t: { exec: {
        command: ${JSON.stringify(command)},
        sandbox: { allow: { read: ['.'] } },
      } } } }\n`,
    })
    const r = await run({ cwd: root, tasks: ['t'], log: quiet })
    return [r.outcomes[0]?.status, r.outcomes[0]?.sandboxViolationLines ?? []]
  }

  it('is named beside a failed task, with the grant', async () => {
    expect(await outcome('cat ../../tsconfig.base.json')).toEqual([
      'failed',
      [
        `vx: the sandbox hid paths outside the project that exist on this machine, which are ` +
          `not reported as violations: ${root}/tsconfig.base.json. If the task reads one, grant ` +
          "it, e.g. `allow: { read: ['../../tsconfig.base.json'] }`.",
      ],
    ])
  })

  it('CONTROL: never beside a passing task', async () => {
    expect(await outcome('cat ../../tsconfig.base.json || true')).toEqual(['success', []])
  })

  it('CONTROL: a path the host lacks too is the tool’s own miss', async () => {
    expect(await outcome('cat ../../nope.json')).toEqual(['failed', []])
  })
})
