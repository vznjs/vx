// A write glob that matched nothing at the start lands in the sandbox's
// scratch, and the write observer counts it granted. The strace pass did
// not: GNU cp probes its destination (`openat(…, O_PATH|O_DIRECTORY)` =
// ENOENT) before creating it, so `cp` into a granted temp directory
// failed the task on a denial of its own output (2026-10-08).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { initSandbox, resetSandbox, resolveSandboxConfig, runSandboxed } from '../src/exec/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('sandbox scratch-probe test')

describe.skipIf(!available || process.platform !== 'linux')(
  'a probe under a scratch write glob',
  () => {
    let dir = ''
    beforeEach(async () => {
      dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-scratch-')))
      await initSandbox()
    })
    afterEach(async () => {
      await resetSandbox()
      await rm(dir, { recursive: true, force: true })
    })

    const runIn = async (command: string) => {
      const proj = path.join(dir, 'proj')
      await mkdir(path.join(proj, 'src'), { recursive: true })
      await writeFile(path.join(proj, 'src', 'x.txt'), 'hi')
      return runSandboxed({
        command,
        cwd: proj,
        env: process.env,
        baseAllowRead: [],
        baseDenyRead: [dir],
        reportWithin: proj,
        reportLinked: [],
        config: resolveSandboxConfig({ allow: { read: ['src/'], write: ['.*.tmp/**'] } }, proj),
      })
    }

    const cp = 'mkdir .a1.tmp && cp src/x.txt .a1.tmp/f && cat .a1.tmp/f && rm -r .a1.tmp'

    it('is granted', async () => {
      const r = await runIn(cp)
      expect([r.exitCode, r.stdout, r.violations.map((v) => v.line)]).toEqual([0, 'hi', []])
    })

    it('CONTROL: a probe outside the glob is reported', async () => {
      const r = await runIn(`cat gone.txt 2>/dev/null; ${cp}`)
      expect(r.violations.map((v) => String(v.target))).toContain(
        path.join(dir, 'proj', 'gone.txt'),
      )
    })
  },
)
