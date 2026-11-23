// strace's own failure in a sandboxed task (STATUS Next 24). On Linux a
// sandboxed task runs under strace, and strace failing on its own
// (`ptrace(PTRACE_LISTEN,…): Input/output error`, after a docs build had
// finished) turned green CI red five times. The attempt strace's own error
// shows up in is run once more (item 1031); since B-11 strace runs detached
// and its failure leaves the task's exit alone, so the error line, not the
// exit, says the trace stopped short. A fake `strace` first on PATH plays
// CI's: the first call traces the task to the end, then prints that error
// and exits 1 (or, with `zero`, the task's own 0).

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { initSandbox, resetSandbox } from '../src/sandbox/session.js'
import { resolveSandboxConfig } from '../src/sandbox/grants.js'
import { runSandboxed } from '../src/sandbox/runtime.js'
import { localExecutor } from '../src/orchestrator/local-executor.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('sandbox tracer retry test')
const realStrace = Bun.which('strace')

// strace is what reports where vx's own observer cannot run (a kernel
// before 5.5); `debug.strace` asks for it here.
let prevStrace: string | undefined
beforeAll(() => {
  prevStrace = process.env['VX_DEBUG_STRACE']
  process.env['VX_DEBUG_STRACE'] = '1'
})
afterAll(() => {
  if (prevStrace === undefined) delete process.env['VX_DEBUG_STRACE']
  else process.env['VX_DEBUG_STRACE'] = prevStrace
})

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
          // The detection's own probe traces `true` (B-18): passed through, uncounted.
          'for a; do last=$a; done',
          `case "$last" in */true) exec ${realStrace} "$@";; esac`,
          `n=$(cat ${dir}/count 2>/dev/null); n=\${n:-0}`,
          `echo $((n+1)) > ${dir}/count`,
          // strace names itself by its argv[0], the absolute path vx runs it by.
          `[ -e ${dir}/early ] && echo "$0: early" >&2`,
          `${realStrace} "$@"`,
          'rc=$?',
          `if [ "$n" = 0 ] && [ ! -e ${dir}/calm ]; then`,
          `  if [ -e ${dir}/split ]; then printf '%sstra' "\${0%strace}" >&2; sleep 0.3; printf 'ce: cut\\n' >&2`,
          `  elif [ -e ${dir}/bare ]; then printf '%s: bare' "$0" >&2`,
          '  else echo "$0: ptrace(PTRACE_LISTEN,pid:1,sig:0): Input/output error" >&2; fi',
          `  [ -e ${dir}/zero ] && exit $rc`,
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

    // `stop`, when given, is aborted as the first attempt's stderr streams:
    // a request aborted before its spawn runs nothing at all (B-72).
    const run = (command: string, timeoutMs?: number, stop?: AbortController) => {
      let streamed = ''
      return runSandboxed({
        command,
        cwd: dir,
        env: process.env,
        baseAllowRead: [dir],
        baseDenyRead: [],
        reportWithin: dir,
        reportLinked: [],
        // The fake runs inside the sandbox, where strace now runs (B-11).
        config: resolveSandboxConfig({ allow: { write: ['count'] } }, dir),
        onStderr: (s) => {
          streamed += s
          stop?.abort()
        },
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(stop === undefined ? {} : { signal: stop.signal }),
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
        streamed: `${dir}/bin/strace: ptrace(PTRACE_LISTEN,pid:1,sig:0): Input/output error\n[vx] the sandbox's tracer (strace) failed on its own; running the task again\n`,
        calls: 2,
      })
    })

    it("strace's own word is run once more when the task's exit is 0", async () => {
      await writeFile(path.join(dir, 'zero'), '')
      expect(await run('echo ran')).toEqual({
        exitCode: 0,
        stdout: 'ran\nran\n',
        streamed: `${dir}/bin/strace: ptrace(PTRACE_LISTEN,pid:1,sig:0): Input/output error\n[vx] the sandbox's tracer (strace) failed on its own; running the task again\n`,
        calls: 2,
      })
    })

    // The key is a LINE of strace's: one that arrives in two chunks, or
    // ends the stream with no newline, is still one.
    it("strace's word split across two chunks is still heard", async () => {
      await writeFile(path.join(dir, 'split'), '')
      const r = await run('echo ran')
      expect([r.stdout, r.calls]).toEqual(['ran\nran\n', 2])
    })

    it("strace's word as the last, unterminated line is still heard", async () => {
      await writeFile(path.join(dir, 'bare'), '')
      const r = await run('echo ran')
      expect([r.stdout, r.calls]).toEqual(['ran\nran\n', 2])
      // vx's notice starts its own line: it read `…/strace: bare[vx] the sandbox's…`.
      expect(r.streamed).toBe(
        `${dir}/bin/strace: bare\n[vx] the sandbox's tracer (strace) failed on its own; running the task again\n`,
      )
    })

    it('a task that timed out is not run again, whatever strace said', async () => {
      await writeFile(path.join(dir, 'early'), '')
      const r = await run('sleep 5', 500)
      expect(r.calls).toBe(1)
    })

    // `timeout` bounds the task's total run time (schema.md): the retry
    // gets what the first attempt left, not a fresh window. Each attempt
    // fits the window alone; both together overrun it.
    it("the retry runs only in what is left of the task's timeout", async () => {
      const r = await runSandboxed({
        command: 'sleep 1.2',
        cwd: dir,
        env: process.env,
        baseAllowRead: [dir],
        baseDenyRead: [],
        reportWithin: dir,
        reportLinked: [],
        config: resolveSandboxConfig({ allow: { write: ['count'] } }, dir),
        timeoutMs: 2000,
      })
      const calls = Number((await readFile(path.join(dir, 'count'), 'utf8')).trim())
      expect([calls, r.timedOut, r.durationMs < 3000]).toEqual([2, true, true])
    })

    // A stopping run has killed the children it holds; a retry would spawn
    // one after that kill, which nothing stops.
    it('a task whose run is stopping is not run again, whatever strace said', async () => {
      const r = await run('echo ran', undefined, new AbortController())
      expect([r.stdout, r.streamed, r.calls]).toEqual([
        'ran\n',
        `${dir}/bin/strace: ptrace(PTRACE_LISTEN,pid:1,sig:0): Input/output error\n`,
        1,
      ])
    })

    it("the local executor hands the run's stop to the sandboxed run", async () => {
      // Aborted once the first attempt has printed: an aborted request
      // spawns nothing at all (B-55), so the stop lands mid-run.
      const stop = new AbortController()
      const r = await localExecutor().execute({
        taskId: 'a#t',
        workspaceRoot: dir,
        outputs: { files: [], workspaceFiles: [] },
        command: 'echo ran',
        forwardArgs: [],
        cwd: dir,
        env: process.env,
        envDefine: {},
        capture: { stdout: true, stderr: true },
        onStdout: () => stop.abort(),
        onStderr: () => {},
        signal: stop.signal,
        sandbox: {
          baseAllowRead: [dir],
          baseDenyRead: [],
          reportWithin: dir,
          reportLinked: [],
          config: resolveSandboxConfig({ allow: { write: ['count'] } }, dir),
        },
      })
      const calls = Number((await readFile(path.join(dir, 'count'), 'utf8')).trim())
      expect([r.stdout, calls]).toEqual(['ran\n', 1])
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

// strace that cannot check the seccomp filter's order (it is itself
// traced, or the kernel answers oddly) says so on stderr and traces on
// without the filter, exit 0. The detection's probe saw the exit and took
// the fast form; inside the sandbox the same line read as the trace cut
// short, and every sandboxed task ran twice.
describe.skipIf(!available || process.platform !== 'linux' || realStrace === null)(
  'a strace that warns at start and traces on',
  () => {
    let dir = ''
    let prevPath: string | undefined
    beforeEach(async () => {
      dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-tracer-warn-')))
      const bin = path.join(dir, 'bin')
      await mkdir(bin)
      await writeFile(
        path.join(bin, 'strace'),
        [
          '#!/bin/sh',
          `[ "$1" = "--version" ] && exec ${realStrace} "$@"`,
          'for a; do last=$a; done',
          `case "$last" in */true) ;; *) echo "$*" >> ${dir}/calls;; esac`,
          'seccomp=',
          'for a; do shift; if [ "$a" = --seccomp-bpf ]; then seccomp=1; else set -- "$@" "$a"; fi; done',
          `[ -n "$seccomp" ] || [ -e ${dir}/always ] && echo "$0: check_seccomp_order_tracer: #0: unexpected exit status 1" >&2`,
          `exec ${realStrace} "$@"`,
          '',
        ].join('\n'),
      )
      await chmod(path.join(bin, 'strace'), 0o755)
      await writeFile(path.join(dir, 'calls'), '')
      prevPath = process.env['PATH']
      process.env['PATH'] = `${bin}:${prevPath ?? ''}`
      await initSandbox()
    })
    afterEach(async () => {
      process.env['PATH'] = prevPath
      await resetSandbox()
      await rm(dir, { recursive: true, force: true })
    })

    it('is used in the plain form, and the task runs once', async () => {
      let streamed = ''
      const r = await runSandboxed({
        command: 'echo ran',
        cwd: dir,
        env: process.env,
        baseAllowRead: [dir],
        baseDenyRead: [],
        reportWithin: dir,
        reportLinked: [],
        config: resolveSandboxConfig({ allow: { write: ['calls'] } }, dir),
        onStderr: (s) => void (streamed += s),
      })
      // One traced call for the task, in the plain form.
      const calls = (await readFile(path.join(dir, 'calls'), 'utf8')).split('\n').filter(Boolean)
      expect([
        r.stdout,
        streamed,
        calls.map((c) => [c.includes('-DD'), c.includes('--seccomp-bpf')]),
      ]).toEqual(['ran\n', '', [[true, false]]])
    })

    // CONTROL past the first gate: a strace that speaks in both forms is
    // not used at all, and the task runs once, untraced.
    it('is not used when the plain form speaks too', async () => {
      await writeFile(path.join(dir, 'always'), '')
      const r = await runSandboxed({
        command: 'echo ran',
        cwd: dir,
        env: process.env,
        baseAllowRead: [dir],
        baseDenyRead: [],
        reportWithin: dir,
        reportLinked: [],
        config: resolveSandboxConfig({ allow: { write: ['calls'] } }, dir),
      })
      expect([r.stdout, await readFile(path.join(dir, 'calls'), 'utf8')]).toEqual(['ran\n', ''])
    })
  },
)

// strace's filter stops a tracee only at the calls it traces, but a new
// thread is stopped at every call until its first traced one. A pool
// thread that only stats never made one: the tracer's kernel time on a
// test file was 13 s, 3 of them these stops. The trace set names a call
// glibc makes as each thread starts.
describe.skipIf(!available || process.platform !== 'linux' || realStrace === null)(
  'a thread that makes no traced call',
  () => {
    let dir = ''
    let prevPath: string | undefined
    beforeEach(async () => {
      dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-tracer-threads-')))
      const bin = path.join(dir, 'bin')
      await mkdir(bin)
      await writeFile(
        path.join(bin, 'strace'),
        [
          '#!/bin/sh',
          `[ "$1" = "--version" ] || echo "$*" >> ${dir}/calls`,
          `exec ${realStrace} "$@"`,
          '',
        ].join('\n'),
      )
      await chmod(path.join(bin, 'strace'), 0o755)
      await writeFile(path.join(dir, 'calls'), '')
      prevPath = process.env['PATH']
      process.env['PATH'] = `${bin}:${prevPath ?? ''}`
      await initSandbox()
    })
    afterEach(async () => {
      process.env['PATH'] = prevPath
      await resetSandbox()
      await rm(dir, { recursive: true, force: true })
    })

    /** The tracer's own wait4 calls, one or two a stop, over a run of pool-thread stats. */
    const stops = async (traced: string): Promise<number> => {
      const count = path.join(dir, 'count')
      await writeFile(
        path.join(dir, 'pool.ts'),
        `import { stat } from 'node:fs/promises'\nfor (let i = 0; i < 200; i++) await Promise.all(Array.from({ length: 100 }, () => stat('/')))\n`,
      )
      const p = Bun.spawn(
        [
          realStrace!,
          '-c',
          '-e',
          'trace=wait4',
          '-o',
          count,
          realStrace!,
          '-f',
          '--seccomp-bpf',
          '-qq',
          '-e',
          traced,
          '-o',
          '/dev/null',
          '--',
          process.execPath,
          path.join(dir, 'pool.ts'),
        ],
        { stdout: 'ignore', stderr: 'ignore' },
      )
      await p.exited
      const row = /^\s*[\d.]+\s+[\d.]+\s+\d+\s+(\d+).*\bwait4$/m.exec(await readFile(count, 'utf8'))
      return Number(row?.[1])
    }

    it('stops at its first call, then no more', async () => {
      await runSandboxed({
        command: 'true',
        cwd: dir,
        env: process.env,
        baseAllowRead: [dir],
        baseDenyRead: [],
        reportWithin: dir,
        reportLinked: [],
        config: resolveSandboxConfig({ allow: { write: ['calls'] } }, dir),
      })
      const calls = (await readFile(path.join(dir, 'calls'), 'utf8')).split('\n').filter(Boolean)
      const traced = calls
        .at(-1)!
        .split(' ')
        .find((a) => a.startsWith('trace='))!
      const without = traced
        .split(',')
        .filter((c) => c !== '?rseq' && c !== '?set_robust_list')
        .join(',')
      // CONTROL: the same run without the two calls stops several times more.
      const [now, before] = [await stops(traced), await stops(without)]
      expect(without).not.toBe(traced)
      expect(now * 2).toBeLessThan(before)
    }, 60_000)
  },
)
