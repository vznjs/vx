// `rm -rf dist && tsc` under `write: ['dist/']` (X-90). On Linux the grant
// is a bind mount, which the task can empty but not remove: rm failed with
// "Read-only file system", naming neither vx nor the grant. The failure
// now carries a hint naming the grant and the removal that works.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { initSandbox, resetSandbox, resolveSandboxConfig, runSandboxed } from '../src/exec/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('sandbox grant removal test')

describe.skipIf(!available || process.platform !== 'linux')('removing a write grant', () => {
  let dir = ''
  beforeEach(async () => {
    dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-grant-rm-')))
    await mkdir(path.join(dir, 'dist'))
    await writeFile(path.join(dir, 'dist', 'old.js'), 'old')
    await initSandbox()
  })
  afterEach(async () => {
    await resetSandbox()
    await rm(dir, { recursive: true, force: true })
  })

  const run = (command: string) =>
    runSandboxed({
      command,
      cwd: dir,
      env: process.env,
      baseAllowRead: [dir],
      baseDenyRead: [],
      reportWithin: dir,
      reportLinked: [],
      config: resolveSandboxConfig({ allow: { read: ['.'], write: ['dist/'] } }, dir),
    })
  const hints = (r: Awaited<ReturnType<typeof run>>) =>
    r.violations.filter((v) => v.hint === true).map((v) => v.line)

  it.each([
    ['rm -rf dist && echo new > dist/new.js'],
    [`node -e "require('fs').rmSync('dist', { recursive: true, force: true })"`],
    [`node -e "require('fs').rmSync(require('path').resolve('dist'), { recursive: true })"`],
  ])(
    'a failed removal of the grant names it: %s',
    async (command) => {
      const r = await run(command)
      expect([r.exitCode, hints(r)]).toEqual([
        1,
        [
          `vx: the write grant 'dist/' is mounted in place on Linux: the task may empty it ` +
            `but not remove or rename it ("Read-only file system"). Remove its contents ` +
            'instead, e.g. `rm -rf dist/*`.',
        ],
      ])
    },
    30_000,
  )

  it('the hinted removal works and the recreate lands in the grant', async () => {
    const r = await run('rm -rf dist/* && echo new > dist/new.js')
    expect([r.exitCode, hints(r), readdirSync(path.join(dir, 'dist'))]).toEqual([0, [], ['new.js']])
  }, 30_000)

  it('a read-only failure that names no grant gets no hint', async () => {
    const r = await run(
      `echo "rm: cannot remove 'distant': Read-only file system" >&2; ` +
        `echo "rm: cannot remove 'out/dist': Read-only file system" >&2; exit 1`,
    )
    expect([r.exitCode, hints(r), existsSync(path.join(dir, 'dist'))]).toEqual([1, [], true])
  }, 30_000)
})
