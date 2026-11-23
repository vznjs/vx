// A command that exits 0 but writes none of its declared outputs fails on
// vx's own exit 1. The frame and `vx last` said `failed (exit 1)` / `exit 1`,
// naming an exit the command never had; both name the unmatched glob now.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

async function vx(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NO_COLOR: '1',
    VX_LOCK_REVIEW_FILES: 'false',
  }
  delete env['CI']
  delete env['GITHUB_ACTIONS']
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out: out + err }
}

describe('a pass that wrote none of its outputs', () => {
  let root: string
  let run: { code: number; out: string }
  beforeAll(async () => {
    root = await makeWorkspace({ prefix: 'vx-missing-label-' })
    await addProject(
      root,
      'core',
      `export default { tasks: { build: { exec: { command: 'echo hi' }, cache: true,
        inputs: { files: ['vx.config.mjs'] }, outputs: { files: ['dist/index.js'] } } } }\n`,
    )
    expect((await vx(root, ['lock'])).code).toBe(0)
    run = await vx(root, ['run', 'build', '--all'])
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('fails, its frame naming the glob, not exit 1', () => {
    expect(run.code).toBe(1)
    expect(run.out).toContain('failed (exited 0, no file matched dist/index.js)')
    expect(run.out).not.toContain('failed (exit 1)')
  })

  it('reads the same in vx last', async () => {
    const { out } = await vx(root, ['last'])
    const row = out.split('\n').find((l) => l.includes('core#build') && l.includes('failed'))
    expect(row).toContain('exited 0, no file matched dist/index.js')
    expect(row).not.toContain('exit 1')
  })
})
