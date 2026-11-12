// A file a person saves while a task runs withholds the save, and the line
// advised declaring it in outputs or `inputs.stability: 'mutable'`, which
// read as if the task had written it. A sandboxed task whose grants cover
// no write there could not have: the line says something else changed it.
import { existsSync, realpathSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from './helpers/orchestrator.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const available = await sandboxAvailable('mid-run edit under the sandbox test')
const MOVED = /changed after its key was taken/
const LINE =
  '[vx] app#build: `packages/app/a.ts` changed after its key was taken — the result stands, but is not saved under a key that no longer describes it'

describe.skipIf(!available)('an input edited while a sandboxed task runs', () => {
  let root: string
  beforeEach(async () => {
    root = realpathSync(await makeWorkspace({ prefix: 'vx-moved-sandbox-' }))
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  /** The run's warning lines, with the test editing a.ts while the task waits. */
  const edited = async (sandbox: string): Promise<string[]> => {
    const wait =
      'i=0; while [ ! -f sig/edited ] && [ $i -lt 1000 ]; do sleep 0.01; i=$((i+1)); done'
    const app = await addProject(root, 'app', {
      config: `export default { tasks: { build: {
        exec: { command: ${JSON.stringify(`touch sig/started; ${wait}`)}, ${sandbox} },
        inputs: { files: ['a.ts'] }, outputs: { files: [] }, cache: true,
      } } }\n`,
      files: { 'a.ts': 'const x = 1\n', 'sig/.keep': '' },
    })
    await writeFile(path.join(root, '.gitignore'), '.vx/cache/\nsig/\n')
    gitIn(root)('add', '-A')
    gitIn(root)('commit', '-q', '-m', 'fixture')
    const status: string[] = []
    const log = {
      status: (l: string) => status.push(l),
      taskStdout() {},
      taskStderr() {},
      taskComplete() {},
    }
    const editor = (async () => {
      const started = path.join(app, 'sig/started')
      while (!existsSync(started)) await Bun.sleep(5)
      await writeFile(path.join(app, 'a.ts'), 'const x = 2\n')
      await writeFile(path.join(app, 'sig/edited'), '')
    })()
    const r = await run({ cwd: root, tasks: ['build'], log })
    await editor
    expect(r.ok).toBe(true)
    return status.filter((l) => MOVED.test(l))
  }

  it('with no write grant over the file, says another process changed it, not outputs', async () => {
    expect(await edited(`sandbox: { allow: { read: ['.'], write: ['sig/'] } }`)).toEqual([
      `${LINE}; the sandbox let the task write none of it, so another process changed it during the run (an editor, a checkout); the next run runs on it`,
    ])
  }, 30_000)

  it('CONTROL: a write grant over it keeps the advice for a task that writes it', async () => {
    expect(await edited(`sandbox: { allow: { read: ['.'], write: ['sig/', 'a.ts'] } }`)).toEqual([
      `${LINE}; if the task generates it, declare it in outputs; if it rewrites it in place, set inputs.stability: { strategy: 'mutable' }`,
    ])
  }, 30_000)

  it('CONTROL: unsandboxed keeps the advice', async () => {
    expect(await edited('')).toEqual([
      `${LINE}; if the task generates it, declare it in outputs; if it rewrites it in place, set inputs.stability: { strategy: 'mutable' }`,
    ])
  }, 30_000)
})
