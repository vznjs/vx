// A refused write in the workspace was told to grant its absolute path,
// which a committed config holds only on the machine that printed it, and
// a path holding a quote was spelled `'…q'd/'`, no JS string at all
// (2026-10-03).
import { realpathSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from '../src/orchestrator/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const available = await sandboxAvailable('sandbox hint spelling test')
const quiet = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

// Linux: macOS logs the record late or not at all.
describe.skipIf(!available || process.platform !== 'linux')('a sandbox hint spells', () => {
  let root: string
  beforeEach(async () => {
    root = realpathSync(await makeWorkspace({ prefix: 'vx-hint-spell-' }))
    await mkdir(path.join(root, "q'd"))
    await writeFile(path.join(root, "it's.json"), '{}\n')
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  const hint = async (command: string) => {
    await addProject(root, 'app', {
      config: `export default { tasks: { t: { exec: {
        command: ${JSON.stringify(command)},
        sandbox: { allow: { read: ['.'] } },
      } } } }\n`,
    })
    const r = await run({ cwd: root, tasks: ['t'], log: quiet })
    return (r.outcomes[0]?.sandboxViolationLines ?? []).map((l) => l.replace(/^.*e\.g\. /, ''))
  }

  it('a write grant in the workspace from the project, quoted as a JS string', async () => {
    expect(await hint(`echo x > "../../q'd/f"`)).toEqual(['`allow: { write: ["../../q\'d/"] }`.'])
  })

  it('a read grant with a quote, as a JS string', async () => {
    expect(await hint(`cat "../../it's.json"`)).toEqual([
      '`allow: { read: ["../../it\'s.json"] }`.',
    ])
  })
})
