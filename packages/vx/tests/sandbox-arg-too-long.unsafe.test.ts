// A sandboxed command is one argument to `sh -c` too, its wrap included,
// and Linux caps one argument at 128 KiB. The unsandboxed spawn names the
// limit and the way under it; the sandboxed one said only E2BIG.
import { mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { initSandbox, resetSandbox, resolveSandboxConfig, runSandboxed } from '../src/exec/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('sandbox arg-too-long test')

describe.skipIf(!available || process.platform !== 'linux')(
  'a sandboxed command too long to spawn',
  () => {
    let dir = ''
    beforeEach(async () => {
      dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-e2big-')))
      await initSandbox()
    })
    afterEach(async () => {
      await resetSandbox()
      await rm(dir, { recursive: true, force: true })
    })

    it('says what the limit is and how to get under it', async () => {
      const r = await runSandboxed({
        command: 'true',
        forwardArgs: ['x'.repeat(200_000)],
        cwd: dir,
        env: process.env,
        baseAllowRead: [dir],
        baseDenyRead: [],
        reportWithin: dir,
        reportLinked: [],
        config: resolveSandboxConfig({}, dir),
      })
      expect([r.exitCode, r.spawnFailed]).toEqual([127, true])
      expect(r.stderr).toContain('E2BIG')
      expect(r.stderr).toMatch(
        /the command, with the args after -- and the sandbox's wrap, is \d+ KiB, and one argument to sh -c may hold at most 128 KiB on Linux/,
      )
    })
  },
)
