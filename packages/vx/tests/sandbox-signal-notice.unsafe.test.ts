// A traced sandboxed task whose shell dies of a signal: the wrapper's bash
// reported the job on its own stderr, which is the task's, so the frame
// read `bash: line 1: 3 Killed { trap - INT QUIT; exec setsid strace … }`
// — vx's whole wrapper, proxy port and paths included — above the verdict
// (X-111). The exit code is the task's either way.

import { realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { initSandbox, resetSandbox, resolveSandboxConfig, runSandboxed } from '../src/exec/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('sandbox signal notice test')

describe.skipIf(!available || process.platform !== 'linux')(
  'a sandboxed task killed by a signal',
  () => {
    let dir = ''
    beforeEach(async () => {
      dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-sig-notice-')))
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
        config: resolveSandboxConfig({}, dir),
      })

    it.each([
      ['SIGKILL', 137],
      ['SIGSEGV', 139],
    ])('%s: its stderr is only what the task wrote', async (signal, code) => {
      const r = await run(`echo own >&2; kill -s ${signal.slice(3)} $$`)
      expect(r.exitCode).toBe(code)
      expect(r.stderr).toBe('own\n')
    })
  },
)
