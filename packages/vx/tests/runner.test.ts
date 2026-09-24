import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { isAlive, waitForDead } from './helpers/alive.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import {
  armTimeout,
  POST_EXIT_CUT_LINE,
  execWrap,
  ownRssHighWater,
  peakRssBytes,
  resourceUsageToCpuRss,
  runCommand,
  runPersistent,
  shellQuote,
  signalExitCode,
  RSS_FLOOR_SLACK_BYTES,
} from '../src/exec/runner.js'

describe('runCommand', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), 'vx-runner-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it('returns exit code 0 for a successful command and captures stdout', async () => {
    const result = await runCommand({
      command: 'echo hello',
      cwd,
      env: { PATH: process.env.PATH ?? '' },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('hello')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('returns non-zero exit code for a failing command and captures stderr', async () => {
    const result = await runCommand({
      command: 'sh -c "echo bad >&2; exit 3"',
      cwd,
      env: { PATH: process.env.PATH ?? '' },
    })
    expect(result.exitCode).toBe(3)
    expect(result.stderr).toContain('bad')
  })

  it('streams chunks via onStdout / onStderr callbacks', async () => {
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    await runCommand({
      command: 'sh -c "echo out; echo err >&2"',
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      onStdout: (c) => stdoutChunks.push(c),
      onStderr: (c) => stderrChunks.push(c),
    })
    expect(stdoutChunks.join('')).toContain('out')
    expect(stderrChunks.join('')).toContain('err')
  })

  it('returns promptly when a backgrounded grandchild holds the pipe open (no hang)', async () => {
    // `sleep 10 & echo up` — sh backgrounds `sleep` (inheriting fd 1/2), prints
    // `up`, and exits. The orphaned `sleep` keeps the stdout pipe's write-end
    // open, so EOF never arrives while the child is alive. Without the
    // post-exit drain bound the reader would block until the sleep ends (~10s,
    // and forever for a real server); with it, runCommand returns just after
    // the child exits + the short grace.
    //
    // DELIBERATELY leaks an orphaned sleeper: a backgrounded grandchild that
    // outlives its parent IS the subject here, so it cannot be `exec`-wrapped
    // away without deleting the test. The 10s duration must stay above the 3s
    // assertion below.
    const t0 = Date.now()
    const result = await runCommand({
      command: 'sleep 10 & echo up',
      cwd,
      env: { PATH: process.env.PATH ?? '' },
    })
    const elapsed = Date.now() - t0
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('up')
    // Well under the sleep's 10s → proves we did not wait for the grandchild.
    expect(elapsed).toBeLessThan(3000)
  }, 15_000)

  it('output a backgrounded child writes after the drain bound is cut, and the frame says so', async () => {
    // The bound stays (the row above), but the cut was silent: `late-line`
    // vanished from the frame and the cached replay with no word
    // (nx#35302 reproduced on vx, 2026-09-24). One line on stderr, live
    // and on the result; the control, which leaves nothing running, gets
    // none.
    const live: string[] = []
    const result = await runCommand({
      command: '(sleep 1; echo late-line) & echo early-line',
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      onStderr: (chunk) => live.push(chunk),
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('early-line\n')
    expect(result.stderr).toBe(POST_EXIT_CUT_LINE)
    expect(live).toEqual([POST_EXIT_CUT_LINE])

    const control: string[] = []
    const clean = await runCommand({
      command: 'echo early-line',
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      onStderr: (chunk) => control.push(chunk),
    })
    expect(clean.stdout).toBe('early-line\n')
    expect(clean.stderr).toBe('')
    expect(control).toEqual([])
  }, 15_000)

  // nx#36863, nx#35302: output a task's background child printed just
  // after the task exited was missing from the log and the replay. Within
  // the post-exit drain it is kept: live, and in what the cache stores.
  it('a grandchild that prints within the post-exit drain reaches the live stream and the result', async () => {
    let live = ''
    const result = await runCommand({
      command: '(sleep 0.1; echo TAIL) & echo HEAD',
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      onStdout: (chunk) => {
        live += chunk
      },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('HEAD\nTAIL\n')
    expect(live).toBe('HEAD\nTAIL\n')
  })

  // Turbo pins `nonpersistent_task_sees_eof_on_stdin`: a task that reads
  // stdin must see EOF, never block on a terminal vx will not hand it. The
  // spawn passes `stdin: 'ignore'` — one word ('inherit') from a permanent
  // CI hang, so it is pinned.
  it('a task that reads stdin sees EOF at once, never a hang', async () => {
    const result = await runCommand({
      command: 'n=$(wc -c < /dev/stdin | tr -d " "); echo "stdin bytes=$n"',
      cwd,
      env: { PATH: process.env.PATH ?? '' },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('stdin bytes=0')
  })

  it('surfaces command-not-found as a non-zero exit (shell reports 127)', async () => {
    const result = await runCommand({
      command: 'this-binary-does-not-exist-12345',
      cwd,
      env: { PATH: process.env.PATH ?? '' },
    })
    expect(result.exitCode).not.toBe(0)
  })

  it('appends forwardArgs to the command, shell-quoted', async () => {
    const result = await runCommand({
      command: 'echo prefix:',
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      forwardArgs: ['hello', 'world with space', `it's`],
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe(`prefix: hello world with space it's`)
  })

  it('reports cpuMs from rusage; a task lighter than this process has no peak on record', async () => {
    // Burn a tiny bit of CPU so cpuMs is observably > 0. The shell loop
    // peaks at ~2 MB, under this process's own mark, and Linux hands the
    // parent's mark back as the child's — so the honest peak is unknown.
    const result = await runCommand({
      command: 'i=0; while [ $i -lt 5000 ]; do i=$((i+1)); done; echo done',
      cwd,
      env: { PATH: process.env.PATH ?? '' },
    })
    expect(result.exitCode).toBe(0)
    expect(result.cpuMs).toBeDefined()
    expect(result.cpuMs!).toBeGreaterThanOrEqual(0)
    expect(result.peakRssBytes).toBeUndefined()
  })

  it('captures rusage even when the command exits non-zero', async () => {
    const result = await runCommand({
      command: 'exit 7',
      cwd,
      env: { PATH: process.env.PATH ?? '' },
    })
    expect(result.exitCode).toBe(7)
    expect(result.cpuMs).toBeDefined()
    expect(result.peakRssBytes).toBeUndefined()
  })

  it('reports 128+signo for a SIGKILL-killed child (137)', async () => {
    const result = await runCommand({
      command: 'kill -KILL $$',
      cwd,
      env: { PATH: process.env.PATH ?? '' },
    })
    expect(result.exitCode).toBe(137)
  })

  it('reports 128+signo for a SIGTERM-killed child (143)', async () => {
    const result = await runCommand({
      command: 'kill -TERM $$',
      cwd,
      env: { PATH: process.env.PATH ?? '' },
    })
    expect(result.exitCode).toBe(143)
  })
})

// Retaining a stream costs its full byte size in heap for the whole task, so
// a caller that will not read one opts down. The contract that makes this
// safe: opting down drops the RETAINED COPY ONLY — the stream is still fully
// drained and every chunk still reaches the live callback.
describe('runCommand capture', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), 'vx-capture-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  const BOTH = 'sh -c "echo OUT; echo ERR >&2"'

  it('retains both streams when capture is omitted (the default contract)', async () => {
    const result = await runCommand({ command: BOTH, cwd, env: { PATH: process.env.PATH ?? '' } })
    expect(result.stdout).toContain('OUT')
    expect(result.stderr).toContain('ERR')
  })

  it('capture.stderr=false empties RunResult.stderr but still streams every chunk', async () => {
    const chunks: string[] = []
    const result = await runCommand({
      command: BOTH,
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      onStderr: (c) => chunks.push(c),
      capture: { stderr: false },
    })
    expect(result.stderr).toBe('')
    // The bytes were read, not skipped — the live view is unaffected.
    expect(chunks.join('')).toContain('ERR')
    // …and the other axis is independent.
    expect(result.stdout).toContain('OUT')
  })

  it('capture.stdout=false empties RunResult.stdout but still streams every chunk', async () => {
    const chunks: string[] = []
    const result = await runCommand({
      command: BOTH,
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      onStdout: (c) => chunks.push(c),
      capture: { stdout: false },
    })
    expect(result.stdout).toBe('')
    expect(chunks.join('')).toContain('OUT')
    expect(result.stderr).toContain('ERR')
  })

  it('an un-retained stream is still fully drained (the child is not blocked)', async () => {
    // A reader that stopped reading would wedge the child on a full pipe
    // buffer once it wrote past ~64 KiB. Write far past it and require a
    // clean exit plus every byte delivered live.
    let bytes = 0
    const result = await runCommand({
      command: `sh -c 'head -c 2000000 /dev/zero | tr "\\0" "z"; echo DONE'`,
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      onStdout: (c) => {
        bytes += c.length
      },
      capture: { stdout: false },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(bytes).toBeGreaterThan(2_000_000)
  }, 15_000)
})

describe('signalExitCode', () => {
  it('maps common signals via the platform signal table', () => {
    expect(signalExitCode('SIGKILL')).toBe(137)
    expect(signalExitCode('SIGTERM')).toBe(143)
    expect(signalExitCode('SIGINT')).toBe(130)
  })

  it('falls back to 130 for unknown signal names', () => {
    expect(signalExitCode('SIGNOTREAL')).toBe(130)
  })
})

// The trailing sleeper is `exec`'d in every fixture below: without it the
// tracked child is `sh`, and killing `sh` leaves the sleeper orphaned at
// PPID 1 for its full duration, stealing the next suite's machine. `exec`
// replaces the shell so the pid we kill IS the sleeper. Output printed
// before the exec still reaches the pipe (the fd survives exec).
describe('runPersistent', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), 'vx-persistent-runner-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it('resolves ready when the marker arrives without a trailing newline', async () => {
    // Prompt-style banner: no newline after the marker, child stays
    // alive. Line-by-line-only matching would hang here forever.
    const live: string[] = []
    const spawn = runPersistent({
      command: `printf 'Listening on :3000'; exec sleep 30`,
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      readyWhen: 'Listening on',
      onStdout: (c) => live.push(c),
    })
    try {
      const settled = await Promise.race([
        spawn.ready.then(() => 'ready'),
        Bun.sleep(3_000).then(() => 'timed out'),
      ])
      expect(settled).toBe('ready')
      // The banner reaches the caller through the live callback — the only
      // route a persistent task's text has (the spawn retains nothing).
      expect(live.join('')).toContain('Listening on :3000')
    } finally {
      spawn.child.kill('SIGKILL')
      await spawn.child.exited
    }
  }, 8_000)

  it('keeps streaming to the live callbacks after ready has resolved', async () => {
    // A kept-alive dev server streams for hours. `ready` resolving is not the
    // end of its output: everything it writes afterwards must keep reaching
    // the callbacks, which are the caller's ONLY route to it.
    const live: string[] = []
    const spawn = runPersistent({
      command: `printf 'server ready\\n'; sleep 0.2; printf 'later chatter\\n'; exec sleep 30`,
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      readyWhen: 'server ready',
      onStdout: (c) => live.push(c),
    })
    try {
      await spawn.ready
      const deadline = Date.now() + 3_000
      while (!live.join('').includes('later chatter') && Date.now() < deadline) {
        await Bun.sleep(25)
      }
      expect(live.join('')).toContain('server ready')
      expect(live.join('')).toContain('later chatter')
    } finally {
      spawn.child.kill('SIGKILL')
      await spawn.child.exited
    }
  }, 8_000)

  it('matches a marker split across chunks within one line', async () => {
    const spawn = runPersistent({
      command: `printf 'Listen'; sleep 0.15; printf 'ing on :3000'; exec sleep 30`,
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      readyWhen: 'Listening on',
    })
    try {
      const settled = await Promise.race([
        spawn.ready.then(() => 'ready'),
        Bun.sleep(3_000).then(() => 'timed out'),
      ])
      expect(settled).toBe('ready')
    } finally {
      spawn.child.kill('SIGKILL')
      await spawn.child.exited
    }
  }, 8_000)

  it('still matches a marker on a complete newline-terminated line', async () => {
    const spawn = runPersistent({
      command: `echo 'Local: http://localhost:5173'; exec sleep 30`,
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      readyWhen: 'Local:',
    })
    try {
      const settled = await Promise.race([
        spawn.ready.then(() => 'ready'),
        Bun.sleep(3_000).then(() => 'timed out'),
      ])
      expect(settled).toBe('ready')
    } finally {
      spawn.child.kill('SIGKILL')
      await spawn.child.exited
    }
  }, 8_000)

  it('rejects ready when the child exits before the marker appears', async () => {
    const spawn = runPersistent({
      command: 'echo nope; exit 1',
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      readyWhen: 'Listening',
    })
    await expect(spawn.ready).rejects.toThrow(/exited before becoming ready/)
  })
})

// The runner's exit bookkeeping, each line deleted in turn against the
// runner-adjacent suite (item 636). What survived guards a process the
// runner no longer owns: a timer or a set entry that outlives the child
// signals whatever holds that pid next.
describe('armTimeout — what settle() disarms and what it reaps', () => {
  it('a child that exits in time is never signalled: settle() before the deadline', async () => {
    // Detached like the runner's own spawns: killTree signals the group.
    const proc = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore', detached: true })
    try {
      const handle = armTimeout(proc, 60)
      await handle.settle()
      await Bun.sleep(150)
      // Deleting the timer's clear reddens this: the stale deadline fires on
      // a pid the runner has moved on from.
      expect(handle.timedOut()).toBe(false)
      expect(isAlive(proc.pid)).toBe(true)
      // Control, past the same gate: an armed deadline that is not cleared
      // does fire.
      const armed = armTimeout(proc, 60)
      await Bun.sleep(150)
      expect(armed.timedOut()).toBe(true)
      expect(await waitForDead(proc.pid, 1_000)).toBe(true)
    } finally {
      proc.kill('SIGKILL')
      await proc.exited
    }
  })

  it('a timed-out shell that dies on the SIGTERM: settle() SIGKILLs the grandchild that ignored it', async () => {
    // The shell exits on the SIGTERM; what it backgrounded ignores it. The
    // escalation timer was cleared with the shell's exit, so the grandchild
    // outlived the run under init (nx#11782's sibling, reproduced on vx
    // 2026-09-24). settle() waits out the grace for the GROUP and SIGKILLs
    // whoever is left.
    const prev = process.env['VX_KILL_GRACE_MS']
    process.env['VX_KILL_GRACE_MS'] = '200'
    const proc = Bun.spawn(
      ['sh', '-c', `sh -c 'trap "" TERM; echo $$; exec sleep 30' & sleep 30`],
      { stdout: 'pipe', stderr: 'ignore', detached: true },
    )
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    const gc = Number(new TextDecoder().decode((await reader.read()).value).trim())
    try {
      expect(isAlive(gc)).toBe(true)
      const handle = armTimeout(proc, 50)
      await proc.exited
      expect(handle.timedOut()).toBe(true)
      expect(isAlive(gc)).toBe(true)
      await handle.settle()
      // Unsettled, it sleeps 30 s. Settled, it is a zombie until init reaps
      // it, and under the sandbox's foreign procfs (util/procfs.ts) a zombie
      // reads as alive: CI's reaper took past 500 ms.
      expect(await waitForDead(gc, 3_000)).toBe(true)
    } finally {
      if (prev === undefined) delete process.env['VX_KILL_GRACE_MS']
      else process.env['VX_KILL_GRACE_MS'] = prev
      reader.releaseLock()
      try {
        process.kill(gc, 'SIGKILL')
      } catch {}
    }
  })
})

describe('runPersistent — what its exit bookkeeping keeps', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), 'vx-persistent-exit-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it('a server ready before the deadline outlives it', async () => {
    // Two guards hold this and mask each other: markReady clears the
    // readiness timer, and the timer's body re-checks readyAt. Deleting
    // either alone stays green; deleting both kills a ready server at the
    // deadline.
    const spawn = runPersistent({
      command: `printf 'Listening\n'; exec sleep 30`,
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      readyWhen: 'Listening',
      timeoutMs: 150,
    })
    try {
      await spawn.ready
      await Bun.sleep(400)
      expect(isAlive(spawn.child.pid)).toBe(true)
    } finally {
      spawn.child.kill('SIGKILL')
      await spawn.child.exited
    }
  })

  it('a child that exits before ready leaves the live set', async () => {
    const liveChildren = new Set<ReturnType<typeof Bun.spawn>>()
    const spawn = runPersistent({
      command: 'echo nope; exit 1',
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      readyWhen: 'Listening',
      liveChildren,
    })
    await expect(spawn.ready).rejects.toThrow(/exited before becoming ready/)
    // The exit handler is what removes it; the rejection is its second half.
    expect(liveChildren.size).toBe(0)
  })
})

describe('shellQuote', () => {
  it('leaves simple identifiers untouched', () => {
    expect(shellQuote('hello')).toBe('hello')
    expect(shellQuote('--watch')).toBe('--watch')
    expect(shellQuote('a/b.c=1')).toBe('a/b.c=1')
  })

  it('wraps strings with spaces in single quotes', () => {
    expect(shellQuote('hello world')).toBe(`'hello world'`)
  })

  it('escapes embedded single quotes', () => {
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`)
  })

  it('handles empty string', () => {
    expect(shellQuote('')).toBe(`''`)
  })

  // Adversarial inputs — verify quoting survives a literal pass
  // through `sh -c`. These would be catastrophic without proper
  // single-quoting; we want command injection to be impossible
  // through the forwardArgs path.
  it('quotes shell-injection attempts so they reach the child as literal text', async () => {
    const { runCommand } = await import('../src/exec/runner.js')
    const cwd = (await import('node:fs/promises')).mkdtemp(
      (await import('node:path')).join((await import('node:os')).tmpdir(), 'vx-runner-quote-'),
    )
    const dir = await cwd
    try {
      const payloads = [
        `; touch /tmp/vx-pwned-${process.pid}`, // statement injection
        `$(echo evaluated)`, // command substitution
        `"hello" world`, // mixed quoting
        `a 'b' c`, // single quotes inside
        `a\\b`, // backslash literal
        `multi
line`, // embedded newline
      ]
      const r = await runCommand({
        command: 'printf "%s\\n"',
        cwd: dir,
        env: { PATH: process.env.PATH ?? '' },
        forwardArgs: payloads,
      })
      expect(r.exitCode).toBe(0)
      // Each payload survives byte-for-byte (sans the literal newline
      // payload which prints across two lines — the joined output still
      // contains the originals).
      for (const p of payloads) {
        expect(r.stdout).toContain(p)
      }
      // Side effect that injection would have caused: the file MUST
      // not exist.
      const { existsSync } = await import('node:fs')
      expect(existsSync(`/tmp/vx-pwned-${process.pid}`)).toBe(false)
    } finally {
      await (await import('node:fs/promises')).rm(dir, { recursive: true, force: true })
    }
  })
})

describe('resourceUsageToCpuRss — peak RSS is bytes', () => {
  it("passes Bun's maxRSS through and converts cpu microseconds to ms", () => {
    // Only the fields the converter reads; cast through unknown for the rest.
    const usage = {
      cpuTime: { total: 1_500_000n },
      // Above the floor's slack (a bare floor of 0 still has it), so it passes through.
      maxRSS: 480 * 1024 * 1024,
    } as unknown as Parameters<typeof resourceUsageToCpuRss>[0]
    // 480 MB is far above the kilobyte threshold, so the unit rule is a
    // no-op here and this row is about the pass-through and the cpu
    // conversion (`peakRssBytes` has its own).
    const r = resourceUsageToCpuRss(usage)
    expect(r.peakRssBytes).toBe(480 * 1024 * 1024)
    expect(r.cpuMs).toBe(1500)
  })

  it('a peak within the slack above the parent’s own mark is not the child’s and is not reported', () => {
    // A light child reads ON the floor by construction, and the kernel's
    // RSS counters jitter by pages either way; an exact `>` flipped on CI.
    const MB = 1024 * 1024
    const at = (maxRSS: number) =>
      ({ cpuTime: { total: 1_500_000n }, maxRSS }) as unknown as Parameters<
        typeof resourceUsageToCpuRss
      >[0]
    const floor = 480 * MB
    // Every value here is hundreds of megabytes, so the unit rule is a no-op
    // and the floor is this row's subject.
    const conv = (maxRSS: number) => resourceUsageToCpuRss(at(maxRSS), floor)
    expect(conv(floor)).toEqual({ cpuMs: 1500 })
    expect(conv(floor - 1)).toEqual({ cpuMs: 1500 })
    expect(conv(floor + RSS_FLOOR_SLACK_BYTES)).toEqual({ cpuMs: 1500 })
    expect(conv(floor + RSS_FLOOR_SLACK_BYTES + 1)).toEqual({
      cpuMs: 1500,
      peakRssBytes: floor + RSS_FLOOR_SLACK_BYTES + 1,
    })
  })

  it('the unit is decided by the number, not by the platform', () => {
    // Both directions of this file's history are here: the unconditional
    // ×1024 that made a 64 MB suite read as 64 GB, and the "bytes on every
    // platform" that made a 200 MB child read as 235 KB and vanish under the
    // floor (item 418). No process peaks under a megabyte, so a reading below
    // that is the kernel's kilobytes; a real byte figure is never near the
    // threshold and neither is a real kilobyte one.
    const MB = 1024 * 1024
    expect(peakRssBytes(300 * MB)).toBe(300 * MB)
    expect(peakRssBytes(235_324)).toBe(235_324 * 1024)
    // A bare `true` costs a couple of megabytes, and reads correctly either way.
    expect(peakRssBytes(2 * MB)).toBe(2 * MB)
    expect(peakRssBytes(2_048)).toBe(2_048 * 1024)
    // Exactly at the threshold is bytes: the rule is strict, so a value that
    // IS a megabyte is never multiplied into a gigabyte.
    expect(peakRssBytes(MB)).toBe(MB)
    // Nothing to decide.
    expect(peakRssBytes(0)).toBe(0)
  })

  it('reads a known allocation back as bytes, on THIS platform', async () => {
    // The unit is Bun's to normalize and ours to trust only once measured:
    // a pure-function pin enshrined "kilobytes on Linux" for a year of
    // Linux peaks recorded 1024× too big. A child that allocates and
    // touches N MB must report a peak between that and a few times it
    // (the runtime's own footprint on top) — a kilobyte value read as
    // bytes would land at ~N KB, a byte value multiplied by 1024 at
    // ~N GB, and either fails. N sits 200 MB ABOVE this process's own
    // mark, not at a fixed 200 MB: the floor withholds a peak under the
    // parent's, and `bun test` runs a shard's files in one process whose
    // mark is whatever the files before this one left — a re-dealt shard
    // put a heavier file first and the fixed 200 MB read as no peak at
    // all (CI, 2026-09-16).
    const MB = 1024 * 1024
    const mb = Math.ceil(ownRssHighWater() / MB) + 200
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'vx-runner-rss-'))
    try {
      const result = await runCommand({
        command: `bun -e "const b = Buffer.alloc(${mb} * 1024 * 1024, 1); console.log(b.length)"`,
        cwd,
        env: { PATH: process.env.PATH ?? '' },
      })
      expect(result.exitCode).toBe(0)
      expect(result.peakRssBytes!).toBeGreaterThanOrEqual(mb * MB)
      expect(result.peakRssBytes!).toBeLessThan(mb * MB * 4)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('the peak is the child’s own, never the parent’s footprint handed back', async () => {
    // Linux folds the forking parent's RSS high-water mark into a child's
    // ru_maxrss at exec, so a `true` spawned from a 300 MB parent read
    // 328 MB (2026-09-12). Hold 300 MB here, then: a trivial task reports
    // no peak (it would read ≥ 300 MB without the floor), and a task that
    // outweighs this process reports its own. The mark is monotonic, so
    // this hold stays after the allocation pin above (which sizes itself
    // from the mark either way).
    const MB = 1024 * 1024
    const hold = Buffer.alloc(300 * MB, 1)
    expect(ownRssHighWater()).toBeGreaterThanOrEqual(300 * MB)
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'vx-runner-floor-'))
    try {
      const env = { PATH: process.env.PATH ?? '' }
      const light = await runCommand({ command: 'true', cwd, env })
      expect(light.exitCode).toBe(0)
      expect(light.cpuMs).toBeDefined()
      expect(light.peakRssBytes).toBeUndefined()
      const heavy = await runCommand({
        command: `bun -e "const b = Buffer.alloc(600 * 1024 * 1024, 1); console.log(b.length)"`,
        cwd,
        env,
      })
      expect(heavy.exitCode).toBe(0)
      expect(heavy.peakRssBytes!).toBeGreaterThanOrEqual(600 * MB)
      expect(heavy.peakRssBytes!).toBeLessThan(2000 * MB)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
    expect(hold.length).toBe(300 * MB)
  })

  it('reads a known CPU burn back as milliseconds, on THIS platform', async () => {
    // Same rule for the other unit: Bun's `cpuTime` is typed as
    // microseconds and the converter divides by 1000. A child that spins
    // for 500 ms of wall time reports up to 500 ms of CPU — less by
    // however much a loaded runner deschedules it (a macOS CI runner gave
    // 357 ms, 2026-09-12), so the floor is generous: the pin is on the
    // UNIT, which is off by a thousand either way. A value in
    // milliseconds divided by 1000 would read as 0.5, one in nanoseconds
    // as 500,000; neither is inside [50, 2000].
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'vx-runner-cpu-'))
    try {
      const result = await runCommand({
        command: `bun -e "const t = Date.now(); while (Date.now() - t < 500) {}"`,
        cwd,
        env: { PATH: process.env.PATH ?? '' },
      })
      expect(result.exitCode).toBe(0)
      expect(result.cpuMs!).toBeGreaterThanOrEqual(50)
      expect(result.cpuMs!).toBeLessThan(2000)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('execWrap — grandchild-orphan mitigation', () => {
  it('exec-wraps a single external program', () => {
    expect(execWrap('astro dev')).toBe('exec astro dev')
    expect(execWrap('vite')).toBe('exec vite')
    expect(execWrap('next dev --port 3000')).toBe('exec next dev --port 3000')
  })

  it('leaves shell builtins alone (exec would break them)', () => {
    expect(execWrap('exit 7')).toBe('exit 7')
    expect(execWrap('true')).toBe('true')
    expect(execWrap('echo hi')).toBe('echo hi')
    expect(execWrap(':')).toBe(':')
  })

  it('leaves compound commands and env-assignments to the shell', () => {
    expect(execWrap('a && b')).toBe('a && b')
    expect(execWrap('cmd | grep x')).toBe('cmd | grep x')
    expect(execWrap('mkdir -p dist && touch dist/x')).toBe('mkdir -p dist && touch dist/x')
    expect(execWrap('rm -rf dist/*')).toBe('rm -rf dist/*')
    expect(execWrap('PORT=3000 vite')).toBe('PORT=3000 vite')
    expect(execWrap('vite --port $PORT')).toBe('vite --port $PORT')
  })

  it('a NEWLINE-separated command keeps the shell, and every line runs', async () => {
    // The separator `&&` and `|` do not stand in for. `exec` REPLACES sh,
    // so an exec-wrapped `a\nb` runs `a` and drops `b` — silently, exit 0:
    // a task reporting success having run half its command. Asserted as the
    // guarantee (both lines ran) and not only as a property of the regex.
    //
    // `/bin/echo`, not `echo`: a builtin would keep the shell for a SECOND
    // reason, and then the newline guard could rot without this row noticing.
    const two = '/bin/echo one\n/bin/echo two'

    // The guarantee first, so it is what a regression reddens.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-runner-nl-'))
    try {
      const result = await runCommand({
        command: two,
        cwd: dir,
        env: { PATH: process.env.PATH ?? '' },
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.split('\n').filter(Boolean)).toEqual(['one', 'two'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }

    // …and the mechanism that carries it.
    expect(execWrap(two)).toBe(two)
  })

  it('an exec-wrapped process is the direct child — no orphaned shell', async () => {
    // `exec sleep` replaces sh, so the tracked child IS sleep. Killing
    // it reaps the real process; there is no surviving grandchild.
    const child = Bun.spawn(['sh', '-c', execWrap('sleep 30')], { stdout: 'pipe' })
    await Bun.sleep(50) // let sh complete the exec into sleep
    // The pid vx tracks runs sleep directly (verified via /proc comm on Linux).
    const comm = await Bun.file(`/proc/${child.pid}/comm`)
      .text()
      .catch(() => 'sleep\n')
    expect(comm.trim()).toBe('sleep')
    child.kill('SIGTERM')
    await child.exited
  })
})

// turborepo#12502: a task that touched the terminal hung the run when the
// runner itself sat on one (stopped by SIGTTIN/SIGTTOU, or blocked reading
// keys nobody typed). vx starts each task in its own session with no
// controlling terminal, so /dev/tty cannot be opened at all. The run here
// sits on a real pseudo-terminal: without that, "no terminal" is true of
// any CI box and proves nothing.
describe('a task under a vx that runs on a terminal', () => {
  it('cannot open /dev/tty, fails that open at once, and the run completes', async () => {
    const root = await makeWorkspace({ prefix: 'vx-runner-tty-' })
    try {
      await addProject(root, 'app', {
        config: `
          export default {
            tasks: {
              probe: {
                exec: {
                  command: 'if stty -echo < /dev/tty; then echo HAD-TTY; else echo NO-TTY; fi; head -c1 < /dev/tty; echo AFTER-READ',
                },
              },
            },
          }
        `,
      })
      let screen = ''
      const bin = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
      const proc = Bun.spawn([process.execPath, bin, 'run', 'app#probe', '--output-logs=full'], {
        cwd: root,
        env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
        terminal: {
          data: (_term, data) => {
            screen += new TextDecoder().decode(data)
          },
        },
      })
      const code = await proc.exited
      proc.terminal?.close()
      // The echoed command line holds every marker, so the task's own
      // output is read as whole lines.
      const lines = screen.split(/\r?\n/)
      expect({
        code,
        answers: lines.filter((l) => ['HAD-TTY', 'NO-TTY', 'AFTER-READ'].includes(l)),
        refusals: lines.filter((l) => l.includes('/dev/tty') && !l.startsWith('$ ')).length,
      }).toEqual({ code: 0, answers: ['NO-TTY', 'AFTER-READ'], refusals: 2 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)
})
