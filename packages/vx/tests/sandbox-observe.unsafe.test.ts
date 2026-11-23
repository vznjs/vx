// vx's own observer (`src/sandbox/observe/vx-observe.c`) in strace's place.
// On Linux a sandboxed task ran under strace for the report of the reads
// the sandbox refused: a stop at every call of a new process until its
// first traced one (3.5 ms of each Bun or Node spawn), and two at each
// traced call. The observer is handed those calls by the kernel and no
// other, and reports the writes too, which the runtime's observer did.
// A `strace` first on PATH that counts its runs says which one ran.
// The shell opens the refused file itself: a `cat` that stats first
// (uutils, on CI) gives up before the open that is reported.

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { initSandbox, resetSandbox } from '../src/sandbox/session.js'
import { resolveSandboxConfig } from '../src/sandbox/grants.js'
import { runSandboxed, wrapSandboxedCommand } from '../src/sandbox/runtime.js'
import { untracedReason } from '../src/sandbox/trace.js'
import { releaseBridges } from '../src/sandbox/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('sandbox observer test')
const realStrace = Bun.which('strace')

describe.skipIf(!available || process.platform !== 'linux' || realStrace === null)(
  'a sandboxed task under vx’s observer',
  () => {
    let dir = ''
    let proj = ''
    let prevPath: string | undefined
    let prevTracer: string | undefined
    beforeEach(async () => {
      dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-observe-')))
      proj = path.join(dir, 'proj')
      const bin = path.join(dir, 'bin')
      await mkdir(path.join(proj, 'sub'), { recursive: true })
      await mkdir(path.join(proj, 'ran'))
      await mkdir(bin)
      await writeFile(path.join(proj, 'secret.txt'), 'secret\n')
      await writeFile(path.join(proj, 'in.txt'), 'in\n')
      await writeFile(
        path.join(bin, 'strace'),
        `#!/bin/sh\n[ "$1" = "--version" ] || echo ran >> ${proj}/ran/strace\nexec ${realStrace} "$@"\n`,
      )
      await chmod(path.join(bin, 'strace'), 0o755)
      prevPath = process.env['PATH']
      prevTracer = process.env['VX_DEBUG_STRACE']
      delete process.env['VX_DEBUG_STRACE']
      process.env['PATH'] = `${bin}:${prevPath ?? ''}`
    })
    afterEach(async () => {
      process.env['PATH'] = prevPath
      if (prevTracer === undefined) delete process.env['VX_DEBUG_STRACE']
      else process.env['VX_DEBUG_STRACE'] = prevTracer
      await resetSandbox()
      await rm(dir, { recursive: true, force: true })
    })

    const run = async (command: string, write: string[] = []) => {
      await initSandbox()
      const r = await runSandboxed({
        command,
        cwd: proj,
        env: process.env,
        baseAllowRead: [path.join(dir, 'bin')],
        baseDenyRead: [dir],
        reportWithin: proj,
        reportLinked: [],
        config: resolveSandboxConfig(
          { allow: { read: ['in.txt', 'sub/'], write: ['ran/', ...write] } },
          proj,
        ),
      })
      return {
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        denied: r.violations.map((v) => v.target),
        strace: existsSync(path.join(proj, 'ran', 'strace')),
      }
    }

    it('reports a refused read the task swallowed, and strace never runs', async () => {
      const r = await run('{ read x < secret.txt; } 2>/dev/null; echo done')
      expect(r).toEqual({
        exitCode: 0,
        stdout: 'done\n',
        stderr: '',
        denied: [path.join(proj, 'secret.txt')],
        strace: false,
      })
      expect(await untracedReason()).toBeNull()
    })

    it('reports a refused write the task swallowed', async () => {
      const r = await run('echo x > new.txt 2>/dev/null; echo done')
      expect([r.stdout, r.denied, r.strace]).toEqual([
        'done\n',
        [path.join(proj, 'new.txt')],
        false,
      ])
      expect(existsSync(path.join(proj, 'new.txt'))).toBe(false)
    })

    it('a declared write and a read of the task’s own are no report', async () => {
      const r = await run(
        'cat in.txt > out.txt; mkdir -p d/e; mv out.txt d/e/o.txt; cat d/e/o.txt',
        ['out.txt', 'd/'],
      )
      expect(r).toEqual({ exitCode: 0, stdout: 'in\n', stderr: '', denied: [], strace: false })
    })

    it('reads a relative path against the directory the process moved to', async () => {
      const r = await run('cd sub && { read x < ../secret.txt; } 2>/dev/null; echo done')
      expect(r.denied).toEqual([path.join(proj, 'secret.txt')])
    })

    it('reports a refused cd', async () => {
      await mkdir(path.join(proj, 'hidden'))
      const r = await run('cd hidden 2>/dev/null; echo done')
      expect([r.stdout, r.denied]).toEqual(['done\n', [path.join(proj, 'hidden')]])
    })

    it('ends with the command’s status, a signal’s too', async () => {
      expect((await run('exit 7')).exitCode).toBe(7)
      expect((await run('kill -TERM $$')).exitCode).toBe(143)
    })

    it('what the command leaves running still opens files, and the task ends with the command', async () => {
      const r = await run('(sleep 0.3; cat in.txt > late.txt) & echo started', ['late.txt'])
      expect([r.exitCode, r.stdout, r.stderr]).toEqual([0, 'started\n', ''])
    })

    it('the runtime’s own write observer is left out of the wrap: one listener a task', async () => {
      await initSandbox()
      const args = {
        command: 'true',
        cwd: proj,
        env: process.env,
        baseAllowRead: [proj],
        baseDenyRead: [],
        config: resolveSandboxConfig({}, proj),
      }
      const observed = await wrapSandboxedCommand({ ...args, trace: 'observe' })
      releaseBridges(observed.tag)
      const traced = await wrapSandboxedCommand({ ...args, trace: 'seccomp' })
      releaseBridges(traced.tag)
      expect([observed.observed, observed.wrapped.includes('SRT_OBSERVE_SOCK')]).toEqual([
        true,
        false,
      ])
      expect([traced.observed, traced.wrapped.includes('SRT_OBSERVE_SOCK')]).toEqual([false, true])
    })

    it('VX_DEBUG_STRACE traces with strace', async () => {
      process.env['VX_DEBUG_STRACE'] = '1'
      const r = await run('{ read x < secret.txt; } 2>/dev/null; echo done')
      expect([r.stdout, r.denied, r.strace]).toEqual([
        'done\n',
        [path.join(proj, 'secret.txt')],
        true,
      ])
    })
  },
)
