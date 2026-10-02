// A networked task's first dial of the run's proxy (M-20). SRT starts its
// in-sandbox bridges (`socat TCP-LISTEN:3128`, `:1080`) in the background
// and runs the command at once, so on a loaded box curl met "connection
// refused" (`000`) where the proxy's own 403 was due. A fake `socat` first
// on PATH plays the loaded box: the in-sandbox listener starts 500 ms late.

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { initSandbox, resetSandbox, resolveSandboxConfig, runSandboxed } from '../src/exec/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('sandbox proxy ready test')
const realSocat = Bun.which('socat')
const curl = Bun.which('curl')

describe.skipIf(!available || process.platform !== 'linux' || realSocat === null || curl === null)(
  "a networked task's first dial of the proxy",
  () => {
    let dir = ''
    let prevPath: string | undefined
    beforeEach(async () => {
      dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-proxy-ready-')))
      const bin = path.join(dir, 'bin')
      await mkdir(bin)
      await writeFile(
        path.join(bin, 'socat'),
        [
          '#!/bin/sh',
          'case "$1" in TCP-LISTEN:3128,*) sleep 0.5;; esac',
          `exec ${realSocat} "$@"`,
          '',
        ].join('\n'),
      )
      await chmod(path.join(bin, 'socat'), 0o755)
      prevPath = process.env['PATH']
      process.env['PATH'] = `${bin}:${prevPath ?? ''}`
      await resetSandbox()
      await initSandbox({ allowedDomains: ['a.test'] })
    })
    afterEach(async () => {
      process.env['PATH'] = prevPath
      await resetSandbox()
      // SRT keeps the last init's socat path across a reset, and the next
      // file's probe checked the fake's, gone with this directory.
      await initSandbox()
      await resetSandbox()
      await rm(dir, { recursive: true, force: true })
    })

    const dial = (config: Parameters<typeof resolveSandboxConfig>[0]) =>
      runSandboxed({
        command: `curl -s -m 5 -o /dev/null -w '%{http_code}' http://b.test/`,
        cwd: dir,
        env: process.env,
        baseAllowRead: [dir],
        baseDenyRead: [],
        reportWithin: dir,
        reportLinked: [],
        config: resolveSandboxConfig(config, dir),
      }).then((r) => [r.exitCode, r.stdout])

    it('meets the proxy, not a refusal, while the bridge starts late', async () => {
      expect(await dial({ allow: { network: ['a.test'] } })).toEqual([0, '403'])
    })

    // Control: a task with no network is not held for a bridge it cannot
    // use; its dial is refused at once, as before.
    it('a task with no network declared is not held for the bridge (control)', async () => {
      const start = performance.now()
      const r = await dial({})
      expect([r, performance.now() - start < 450]).toEqual([[7, '000'], true])
    })
  },
)
