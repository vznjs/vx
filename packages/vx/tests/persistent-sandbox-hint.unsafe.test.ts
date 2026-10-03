// A server is never traced, so a sandboxed dev server that died on a file
// outside its grants read only as the tool's own "not found", with no word
// of the sandbox (2026-10-03).
import { realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from '../src/orchestrator/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const available = await sandboxAvailable('persistent sandbox hint test')
const HINT =
  '[vx] app#dev ran in the sandbox, which reports nothing for a server: a path outside its ' +
  'grants reads as missing (ENOENT), a refused write as read-only (EROFS). Check ' +
  'exec.sandbox.allow, or run the command as a one-shot sandboxed task to see what it was refused.'

describe.skipIf(!available)('a server that exits before it is ready', () => {
  let root: string
  beforeEach(async () => {
    root = realpathSync(await makeWorkspace({ prefix: 'vx-server-hint-' }))
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  const said = async (command: string, sandbox: string) => {
    await addProject(root, 'app', {
      config: `export default { tasks: { dev: { exec: {
        command: ${JSON.stringify(command)},
        persistent: { readyWhen: 'READY' },
        ${sandbox}
      } } } }\n`,
    })
    const lines: string[] = []
    const log = {
      status() {},
      taskStdout() {},
      taskStderr(_n: unknown, chunk: string) {
        lines.push(...chunk.split('\n'))
      },
      taskComplete() {},
    }
    const r = await run({ cwd: root, tasks: ['dev'], log })
    return [r.outcomes[0]?.status, lines.filter((l) => l.includes('ran in the sandbox'))]
  }

  it('in the sandbox, failing, is told the sandbox reports nothing for it', async () => {
    expect(await said('exit 1', `sandbox: { allow: { read: ['.'] } },`)).toEqual(['failed', [HINT]])
  })

  it('CONTROL: unsandboxed, is not', async () => {
    expect(await said('exit 1', '')).toEqual(['failed', []])
  })

  it('CONTROL: in the sandbox, exiting 0, is not', async () => {
    expect(await said('exit 0', `sandbox: { allow: { read: ['.'] } },`)).toEqual(['failed', []])
  })
})
