// A hit on a task that declares `outputs: []` replays stdout from the row
// and touches no artifact: nothing to clean, nothing to extract. Until
// 2026-09-10 the hit path extracted the logs-only tar anyway — an
// `exists` and a read per hit for nothing. Pinned through VX_TIMING's
// accumulated spans: `restore: extract` must not appear for such a run.

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

async function vx(root: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([process.execPath, BIN, 'run', ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1', VX_TIMING: '1' },
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return out + err
}

describe('a cache hit on a task with no outputs', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-no-output-hit-' })
    await addProject(
      root,
      'app',
      `
        export default { tasks: {
          check: {
            exec: { command: 'echo checked' },
            cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } },
          },
          build: {
            exec: { command: 'mkdir -p dist && echo built > dist/out.txt' },
            cache: { inputs: { files: ['package.json'] }, outputs: { files: ['dist/**'] } },
          },
        } }
      `,
    )
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('replays stdout without touching the artifact; a task WITH outputs still restores (control)', async () => {
    await vx(root, ['check', 'build', '--all'])
    const hit = await vx(root, ['check', '--all'])
    // A hit (the default flow prints a hit silently; the footer counts it).
    expect(hit).toContain('1 up-to-date')
    expect(hit).not.toContain('restore: extract')
    expect(hit).not.toContain('restore: exists')
    // Control: wipe the build's outputs and hit it — the extract span shows.
    await rm(path.join(root, 'packages', 'app', 'dist'), { recursive: true, force: true })
    const restored = await vx(root, ['build', '--all'])
    expect(restored).not.toMatch(/miss/)
    expect(restored).toContain('restore: extract')
    expect(await Bun.file(path.join(root, 'packages', 'app', 'dist', 'out.txt')).text()).toBe(
      'built\n',
    )
  }, 30_000)
})
