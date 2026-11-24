// The memory-ceiling harness removes a workspace a test left half-built:
// a test that timed out inside makeWorkspace never got its path back, so
// the end-of-file removal never saw it and `vx-mem-*` stayed in TMPDIR.

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'

const HELPER = path.resolve(import.meta.dir, 'helpers', 'memory-ceiling.ts')

it('a test ending mid-build leaves no workspace behind', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-memclean-'))
  try {
    const tmp = path.join(dir, 'tmp')
    await Bun.write(path.join(tmp, '.keep'), '')
    await writeFile(
      path.join(dir, 'cut.test.ts'),
      `import { afterEach, it } from 'bun:test'
import { removeScratch, task, workspace } from ${JSON.stringify(HELPER)}
afterEach(removeScratch)
it('ends while the workspace is built', () => {
  const p: Record<string, string> = {}
  for (let i = 0; i < 500; i++) p['p' + i] = task('true')
  workspace(p).catch(() => {})
})
`,
    )
    const r = Bun.spawnSync([process.execPath, 'test', './cut.test.ts'], {
      cwd: dir,
      env: { ...process.env, TMPDIR: tmp },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(r.stderr.toString()).toContain('1 pass')
    const left = (await readdir(tmp)).filter((n) => n.startsWith('vx-mem-'))
    expect(left).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 60_000)
