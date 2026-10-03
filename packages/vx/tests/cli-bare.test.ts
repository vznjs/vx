// A bare `vx` where there is no workspace says so in one line and exits 1:
// it printed the 151-line reference and exited 0, and none of it said
// that nothing here can run. Inside a workspace, and for `--help` / `-h`
// anywhere, it is the reference as before.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { realpathSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { run } from '../src/cli/index.js'

let stdout = ''
let stderr = ''
let cwd = ''
let dir = ''
beforeEach(async () => {
  stdout = ''
  stderr = ''
  spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  })
  spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  })
  cwd = process.cwd()
  dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-bare-')))
  process.chdir(dir)
})
afterEach(async () => {
  process.chdir(cwd)
  await rm(dir, { recursive: true, force: true })
})

describe('a bare vx', () => {
  it('outside a workspace: one line naming why and what next, exit 1', async () => {
    expect(await run([])).toBe(1)
    expect({ stdout, stderr }).toEqual({
      stdout: '',
      stderr: `vx: Could not find a workspace root in any parent of ${process.cwd()} (looked for pnpm-workspace.yaml or package.json): run vx inside a project, or create a package.json (\`bun init\` or \`npm init -y\`) and run \`vx init\`; \`vx help\` lists the verbs\n`,
    })
  })

  it('inside a workspace: the reference, exit 0', async () => {
    await writeFile(path.join(dir, 'package.json'), '{"name":"x"}\n')
    expect(await run([])).toBe(0)
    expect(stdout).toStartWith('vx — open, extensible monorepo task runner\n')
    expect(stderr).toBe('')
  })

  it('--help and -h outside a workspace: the reference, exit 0 (control)', async () => {
    for (const flag of ['--help', '-h']) {
      stdout = ''
      expect(await run([flag])).toBe(0)
      expect(stdout).toStartWith('vx — open, extensible monorepo task runner\n')
    }
    expect(stderr).toBe('')
  })
})
