// `VX_TIMING=1` prints the stage table at the end of a dry run as it does
// at the end of a run: a dry run is how the prepare stages get profiled on
// a real repo with no install to run against (refine, 2026-09-11 — the
// table was silent under `--dry` and the profile needed a 2.3 GB install).

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

async function vx(root: string, args: string[], env: Record<string, string>): Promise<string> {
  const proc = Bun.spawn([process.execPath, BIN, 'run', ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1', VX_TIMING: '', ...env },
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return out + err
}

describe('VX_TIMING on a dry run', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace()
    await addProject(
      root,
      'app',
      `export default {
  tasks: {
    build: {
      exec: { command: 'echo built' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
    },
  },
}
`,
    )
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('prints the stage table through the graph build and the close', async () => {
    const out = await vx(root, ['build', '--all', '--dry'], { VX_TIMING: '1' })
    expect(out).toContain('[vx timing]  stage')
    for (const stage of [
      'discover projects',
      'load configs',
      'git enumeration',
      'build graph',
      'close',
    ]) {
      expect(out).toContain(stage)
    }
  })

  it('prints nothing without the variable (control)', async () => {
    const out = await vx(root, ['build', '--all', '--dry'], {})
    expect(out).not.toContain('[vx timing]')
    expect(out).toContain('app#build')
  })
})
