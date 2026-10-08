// TMP and TEMP pass through from the host (ESSENTIAL_ENV), but only TMPDIR
// was pointed at the task's own temp directory: inside the sandbox the
// other two named a host directory mounted read-only, and a tool that
// reads them (`mktemp -p "$TMP"`, a script's `${TEMP:-/tmp}`) failed with
// "Read-only file system" (probed 2026-10-08).
import { mkdirSync, realpathSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from '../src/orchestrator/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const available = await sandboxAvailable('sandbox temp vars test')
const quiet = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

describe.skipIf(!available || process.platform !== 'linux')('a sandboxed task', () => {
  let root: string
  const saved = { TMP: process.env['TMP'], TEMP: process.env['TEMP'] }
  beforeEach(async () => {
    root = realpathSync(await makeWorkspace({ prefix: 'vx-temp-vars-' }))
    // A host temp directory outside the project: read-only in the sandbox.
    const host = path.join(root, 'host-tmp')
    mkdirSync(host)
    process.env['TMP'] = host
    process.env['TEMP'] = host
  })
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(root, { recursive: true, force: true })
  })

  it('can write where TMPDIR, TMP and TEMP point, and they agree', async () => {
    const dir = await addProject(root, 'app', {
      config: `export default { tasks: { t: { exec: {
        command: 'for v in TMPDIR TMP TEMP; do eval d=\\\\$$v; touch "$d/w" && echo "$v ok" || echo "$v refused"; done > out.txt; [ "$TMP" = "$TMPDIR" ] && [ "$TEMP" = "$TMPDIR" ] && echo same >> out.txt; true',
        sandbox: { allow: { write: ['out.txt'] } },
      } } } }\n`,
    })
    const r = await run({ cwd: root, tasks: ['t'], log: quiet })
    expect(r.outcomes[0]?.status).toBe('success')
    expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).toBe(
      'TMPDIR ok\nTMP ok\nTEMP ok\nsame\n',
    )
  })

  it('CONTROL: unsandboxed, TMP and TEMP keep the host value', async () => {
    const dir = await addProject(root, 'app', {
      config: `export default { tasks: { t: { exec: {
        command: 'echo "$TMP $TEMP" > out.txt',
      } } } }\n`,
    })
    const r = await run({ cwd: root, tasks: ['t'], log: quiet })
    expect(r.outcomes[0]?.status).toBe('success')
    const host = path.join(root, 'host-tmp')
    expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).toBe(`${host} ${host}\n`)
  })
})
