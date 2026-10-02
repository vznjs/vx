// A denied `chdir` is a denied read of the directory. strace traced it
// (B-61) and the parse used only the successful ones, so `cd src` into a
// directory no grant holds failed with no violation, and `cd src || …`
// passed and cached (B-67).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { initSandbox, resetSandbox, resolveSandboxConfig, runSandboxed } from '../src/exec/index.js'
import { deniedCalls } from '../src/exec/sandbox-violations.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

describe('deniedCalls › a denied chdir', () => {
  it('is a denial in either line shape, resolved where its process stood', () => {
    const trace = [
      '10 chdir("src") = -1 ENOENT (No such file or directory)',
      '10 chdir("lib" <unfinished ...>',
      '10 <... chdir resumed>) = -1 EACCES (Permission denied)',
      '10 chdir("ok") = 0',
      '10 chdir("deep") = -1 ENOENT (No such file or directory)',
      '',
    ].join('\n')
    expect(deniedCalls(trace, '/ws').map((c) => [c.syscall, c.rawPath, c.errno, c.dir])).toEqual([
      ['chdir', 'src', 'ENOENT', undefined],
      ['chdir', 'lib', 'EACCES', undefined],
      ['chdir', 'deep', 'ENOENT', '/ws/ok'],
    ])
  })
})

const available = await sandboxAvailable('sandbox chdir denial test')

describe.skipIf(!available || process.platform !== 'linux')(
  'a sandboxed cd into an ungranted directory',
  () => {
    let dir = ''
    beforeEach(async () => {
      dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-chdir-')))
      await initSandbox()
    })
    afterEach(async () => {
      await resetSandbox()
      await rm(dir, { recursive: true, force: true })
    })

    it('is reported, though the command swallowed it', async () => {
      const proj = path.join(dir, 'proj')
      await mkdir(path.join(proj, 'src'), { recursive: true })
      await writeFile(path.join(proj, 'package.json'), '{}')
      const r = await runSandboxed({
        command: 'cd src || true',
        cwd: proj,
        env: process.env,
        baseAllowRead: [],
        baseDenyRead: [dir],
        reportWithin: proj,
        reportLinked: [],
        config: resolveSandboxConfig({ allow: { read: ['package.json'] } }, proj),
      })
      expect([r.exitCode, r.violations.map((v) => v.target)]).toEqual([0, [path.join(proj, 'src')]])
    })
  },
)
