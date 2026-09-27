// strace's own failure ending a sandboxed task (STATUS Next 24). On Linux a
// sandboxed task runs under strace, whose exit is the task's, and strace
// failing on its own (`ptrace(PTRACE_LISTEN,…): Input/output error`, after a
// docs build had finished) turned green CI red five times. The attempt that
// strace's own error ends is run once more (item 1031). A fake `strace`
// first on PATH plays CI's: the first call traces the task to the end, then
// prints that error and exits 1.

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { initSandbox, resetSandbox, resolveSandboxConfig, runSandboxed } from '../src/exec/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('sandbox tracer retry test')
const realStrace = Bun.which('strace')

describe.skipIf(!available || process.platform !== 'linux' || realStrace === null)(
  'a sandboxed task strace itself ends',
  () => {
    let dir = ''
    let prevPath: string | undefined
    beforeEach(async () => {
      dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-tracer-')))
      const bin = path.join(dir, 'bin')
      await mkdir(bin)
      await writeFile(
        path.join(bin, 'strace'),
        [
          '#!/bin/sh',
          `[ "$1" = "--version" ] && exec ${realStrace} "$@"`,
          `n=$(cat ${dir}/count 2>/dev/null || echo 0)`,
          `echo $((n+1)) > ${dir}/count`,
          `${realStrace} "$@"`,
          'rc=$?',
          `if [ "$n" = 0 ] && [ ! -e ${dir}/calm ]; then`,
          '  echo "strace: ptrace(PTRACE_LISTEN,pid:1,sig:0): Input/output error" >&2',
          '  exit 1',
          'fi',
          'exit $rc',
          '',
        ].join('\n'),
      )
      await chmod(path.join(bin, 'strace'), 0o755)
      prevPath = process.env['PATH']
      process.env['PATH'] = `${bin}:${prevPath ?? ''}`
      await initSandbox()
    })
    afterEach(async () => {
      process.env['PATH'] = prevPath
      await resetSandbox()
      await rm(dir, { recursive: true, force: true })
    })

    const run = (command: string) => {
      let streamed = ''
      return runSandboxed({
        command,
        cwd: dir,
        env: process.env,
        baseAllowRead: [dir],
        baseDenyRead: [],
        reportWithin: dir,
        reportLinked: [],
        config: resolveSandboxConfig({}, dir),
        onStderr: (s) => void (streamed += s),
      }).then(async (r) => ({
        exitCode: r.exitCode,
        stdout: r.stdout,
        streamed,
        calls: Number((await readFile(path.join(dir, 'count'), 'utf8')).trim()),
      }))
    }

    it('is run once more, and the second attempt is its verdict', async () => {
      expect(await run('echo ran')).toEqual({
        exitCode: 0,
        stdout: 'ran\nran\n',
        streamed:
          "strace: ptrace(PTRACE_LISTEN,pid:1,sig:0): Input/output error\n[vx] the sandbox's tracer (strace) failed on its own; running the task again\n",
        calls: 2,
      })
    })

    it('a task that fails on its own, strace well, is run once (control)', async () => {
      await writeFile(path.join(dir, 'calm'), '')
      expect(await run('echo own >&2; exit 3')).toEqual({
        exitCode: 3,
        stdout: '',
        streamed: 'own\n',
        calls: 1,
      })
    })
  },
)
