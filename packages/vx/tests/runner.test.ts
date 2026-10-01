import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { isAlive, waitForDead } from './helpers/alive.js'
import {
  armTimeout,
  POST_EXIT_CUT_LINE,
  execWord,
  execWrap,
  ownRssHighWater,
  peakRssBytes,
  resourceUsageToCpuRss,
  runCommand,
  runPersistent,
  shellQuote,
  signalExitCode,
  streamToString,
  CAPTURE_HEAD_CHARS,
  withForwardArgs,
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
  // The grandchild prints once its parent is gone, not after a fixed
  // sleep: `sleep 0.1` plus a loaded macOS runner's start-up overran the
  // 250 ms drain (CI, 292 ms), and the claim is "just after the exit".
  it('a grandchild that prints within the post-exit drain reaches the live stream and the result', async () => {
    let live = ''
    const result = await runCommand({
      command: '(while kill -0 $$ 2>/dev/null; do sleep 0.01; done; echo TAIL) & echo HEAD',
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

  // The pattern is tested per line, without the break and without terminal
  // escapes (item 1059). Each command writes its lines in ONE printf, so they
  // reach the matcher as one chunk: the whole-fragment test failed every
  // anchored row, and `Local:` never matched Vite's bold `Local` under
  // FORCE_COLOR. The last two rows are the controls: a line that only
  // CONTAINS the anchored word, and an escape that splits the word.
  const settleWithin = async (printf: string, readyWhen: string): Promise<string> => {
    const spawn = runPersistent({
      command: `printf '${printf}'; exec sleep 30`,
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      readyWhen,
    })
    try {
      return await Promise.race([
        spawn.ready.then(() => 'ready'),
        Bun.sleep(1_500).then(() => 'timed out'),
      ])
    } finally {
      spawn.child.kill('SIGKILL')
      await spawn.child.exited
    }
  }
  it.each([
    ['^ on a later line of one chunk', 'booting\\nready\\n', '^ready', 'ready'],
    ['$ before a newline', 'ready\\n', 'ready$', 'ready'],
    ['^…$ on a CRLF line', 'booting\\r\\nready\\r\\n', '^ready$', 'ready'],
    ['^ after a progress frame', '50%%\\rready', '^ready', 'ready'],
    ['an SGR-bolded word', '\\033[1mLocal\\033[22m: http://localhost:5173\\n', 'Local:', 'ready'],
    ['^ past an OSC title', '\\033]0;vite\\007Local: http://x\\n', '^Local:', 'ready'],
    ['control: ^ mid-line', 'not ready\\n', '^ready', 'timed out'],
    ['control: $ mid-line', 'ready now\\n', 'ready$', 'timed out'],
  ])(
    'readyWhen per line: %s',
    async (_name, printf, readyWhen, expected) => {
      expect(await settleWithin(printf, readyWhen)).toBe(expected)
    },
    8_000,
  )

  it('readyWhen matches a character split across two writes', async () => {
    // `€` is three bytes; the child writes two, pauses, then the third.
    const spawn = runPersistent({
      command: `printf '\\342\\202'; sleep 0.2; printf '\\254 up\\n'; exec sleep 30`,
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      readyWhen: '€ up',
    })
    try {
      const settled = await Promise.race([
        spawn.ready.then(() => 'ready'),
        Bun.sleep(1_500).then(() => 'timed out'),
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
  it('settle() lets a grandchild that traps the SIGTERM finish inside the grace', async () => {
    // The grace is the time a TERM handler is promised; settle() SIGKILLs
    // only what is left when it runs out, never at once.
    const prev = process.env['VX_KILL_GRACE_MS']
    process.env['VX_KILL_GRACE_MS'] = '600'
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-grace-'))
    const marker = path.join(dir, 'done')
    const proc = Bun.spawn(
      [
        'sh',
        '-c',
        `sh -c 'trap "sleep 0.15; echo ok > ${marker}; exit 0" TERM; echo $$; sleep 30 & wait' & sleep 30`,
      ],
      { stdout: 'pipe', stderr: 'ignore', detached: true },
    )
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    const gc = Number(new TextDecoder().decode((await reader.read()).value).trim())
    try {
      const handle = armTimeout(proc, 50)
      await proc.exited
      await handle.settle()
      expect(await Bun.file(marker).exists()).toBe(true)
    } finally {
      if (prev === undefined) delete process.env['VX_KILL_GRACE_MS']
      else process.env['VX_KILL_GRACE_MS'] = prev
      reader.releaseLock()
      try {
        process.kill(gc, 'SIGKILL')
      } catch {}
      await rm(dir, { recursive: true, force: true })
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

// The args after `--` go before a comment still open at the command's end,
// and nowhere else moves (item 1060): each row runs the joined line through
// sh, the way the runner does, and reads what the command printed.
describe('withForwardArgs', () => {
  const shOut = (command: string): string =>
    Bun.spawnSync(['sh', '-c', command], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString()
  it.each([
    ['a trailing comment', 'echo args: # print them', 'args: --fix a b\n'],
    ['a comment on its own last line', 'echo args:\n# print them', 'args: --fix a b\n'],
    ['control: a comment on an earlier line', 'echo one # c\necho two', 'one\ntwo --fix a b\n'],
    ['control: a quoted #', `echo '#' "# x"`, '# # x --fix a b\n'],
    ['control: # inside a word', 'echo a#b', 'a#b --fix a b\n'],
    ['control: $# and an escaped #', 'echo $# \\#', '0 # --fix a b\n'],
    ['control: # after an escaped space', 'echo a\\ #b', 'a #b --fix a b\n'],
    ['a comment line after a commented line', 'echo one # c\n# two', 'one --fix a b\n'],
    ['a trailing comment after a single-quoted word', `echo 'a' # c`, 'a --fix a b\n'],
    ['a trailing comment after a double-quoted word', 'echo "a" # c', 'a --fix a b\n'],
    ['control: # right after a closing quote', `echo 'a'#b`, 'a#b --fix a b\n'],
  ])('%s', (_name, command, printed) => {
    expect(shOut(withForwardArgs(command, ['--fix', 'a b']))).toBe(printed)
  })

  it('a # after a separator opens a comment', () => {
    expect(withForwardArgs('echo a;# c', ['x'])).toBe('echo a; x # c')
  })

  it('leaves the command alone with no args', () => {
    expect(withForwardArgs('echo hi # c', [])).toBe('echo hi # c')
    expect(withForwardArgs('echo hi # c', undefined)).toBe('echo hi # c')
  })
})

describe('execWord', () => {
  it.each([
    ['a plain program', 'tool x', 'tool'],
    ['leading blanks', '  tool x', 'tool'],
    ['empty', '', undefined],
    ['blank', '   ', undefined],
    ['a tilde path', '~/bin/tool x', undefined],
    ['a negation', '! tool', undefined],
    ['an escaped blank', 'tool a\\ b', undefined],
    ['cd', 'cd dist', undefined],
    ['.', '. ./env.sh', undefined],
    ['kill', 'kill 1', undefined],
    ['ulimit', 'ulimit -n 64', undefined],
    ['command', 'command -v tool', undefined],
  ])('%s', (_name, command, word) => {
    expect(execWord(command)).toBe(word)
  })
})

describe('streamToString', () => {
  const bytes = (...chunks: number[][]): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(c) {
        for (const b of chunks) c.enqueue(new Uint8Array(b))
        c.close()
      },
    })

  it('joins a character split across chunks', async () => {
    expect(await streamToString(bytes([0xe2, 0x82], [0xac]))).toBe('€')
  })

  it('flushes a truncated last character to the text and to onChunk', async () => {
    const seen: string[] = []
    expect(await streamToString(bytes([0x61, 0xe2]), (s) => seen.push(s))).toBe('a\ufffd')
    expect(seen.join('')).toBe('a\ufffd')
  })

  it('keeps every character across the head/tail seam', async () => {
    const text = 'a'.repeat(CAPTURE_HEAD_CHARS) + 'bcd'
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(text))
        c.close()
      },
    })
    const got = await streamToString(stream)
    expect([got.length, got.slice(-4)]).toEqual([text.length, 'abcd'])
  })

  it('reads nothing from an inherited fd or no stream', async () => {
    expect([await streamToString(1), await streamToString(undefined)]).toEqual(['', ''])
  })

  it('stops at once on a signal already aborted', async () => {
    const endless = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) })
    expect(await streamToString(endless, undefined, AbortSignal.abort())).toBe('')
  })
})

describe('resourceUsageToCpuRss — peak RSS is bytes', () => {
  it('reports nothing without a usage', () => {
    expect(resourceUsageToCpuRss(undefined)).toEqual({})
  })

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

  // These rows allocate hundreds of MB and spawn a bun that burns or
  // allocates more; alone the heaviest takes about 0.6 s. Under the gate's
  // twelve shards it ran past bun's 5 s default twice (2026-09-26, item
  // 875), its neighbour 30 times its own time, the slowdown's cause
  // unproven. They make no claim about time, so their budget is the
  // work's under load, not the default.
  const HEAVY_ROW_MS = 20_000

  it(
    'reads a known allocation back as bytes, on THIS platform',
    async () => {
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
    },
    HEAVY_ROW_MS,
  )

  it(
    'the peak is the child’s own, never the parent’s footprint handed back',
    async () => {
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
        // Sized from the floor, as the row above is: the shard's files
        // before this one set it, and a fixed 600 MB read as no peak on a
        // macOS shard (M-2).
        // The claim is that its own peak is reported, above the parent's
        // mark: the full allocation read 690 of 713 MB on macOS (M-6), and
        // the unit is the row above's to pin.
        const floor = ownRssHighWater()
        const mb = Math.ceil(floor / MB) + 300
        const heavy = await runCommand({
          command: `bun -e "const b = Buffer.alloc(${mb} * 1024 * 1024, 1); console.log(b.length)"`,
          cwd,
          env,
        })
        expect(heavy.exitCode).toBe(0)
        expect(heavy.peakRssBytes!).toBeGreaterThan(floor + RSS_FLOOR_SLACK_BYTES)
        expect(heavy.peakRssBytes!).toBeLessThan(mb * MB * 4)
      } finally {
        await rm(cwd, { recursive: true, force: true })
      }
      expect(hold.length).toBe(300 * MB)
    },
    HEAVY_ROW_MS,
  )

  it(
    'reads a known CPU burn back as milliseconds, on THIS platform',
    async () => {
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
    },
    HEAVY_ROW_MS,
  )
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

describe('runPersistent — the rows its sweep asked for', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-persist-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const env = (): Record<string, string> => ({ PATH: process.env.PATH ?? '' })
  const stop = async (spawn: ReturnType<typeof runPersistent>): Promise<void> => {
    spawn.child.kill('SIGKILL')
    await spawn.child.exited
  }
  const within = (p: Promise<unknown>, ms: number): Promise<string> =>
    Promise.race([p.then(() => 'ready'), Bun.sleep(ms).then(() => 'timed out')])

  it('routes each stream to its own callback, and never an empty chunk', async () => {
    const out: string[] = []
    const err: string[] = []
    const spawn = runPersistent({
      command: `printf 'o\\n'; printf 'e\\342' >&2`,
      cwd: dir,
      env: env(),
      onStdout: (c) => out.push(c),
      onStderr: (c) => err.push(c),
    })
    await spawn.child.exited
    await Bun.sleep(50)
    // The stderr stream ends on a truncated character: the flush reports it.
    expect([out.join(''), err.join(''), [...out, ...err].includes('')]).toEqual([
      'o\n',
      'e�',
      false,
    ])
  })

  it('is ready at once without readyWhen, and readyMs stays where it landed', async () => {
    const spawn = runPersistent({ command: 'exec sleep 30', cwd: dir, env: env() })
    try {
      expect(await within(spawn.ready, 1_000)).toBe('ready')
      const first = spawn.readyMs()
      await Bun.sleep(120)
      expect(spawn.readyMs()).toBe(first)
    } finally {
      await stop(spawn)
    }
  })

  it('lists the child as live until it exits', async () => {
    const live = new Set<ReturnType<typeof Bun.spawn>>()
    const spawn = runPersistent({
      command: 'exec sleep 0.2',
      cwd: dir,
      env: env(),
      liveChildren: live,
    })
    expect(live.has(spawn.child)).toBe(true)
    await spawn.child.exited
    await Bun.sleep(20)
    expect(live.has(spawn.child)).toBe(false)
  })

  it('matches readyWhen across a chunk seam past a long unbroken line', async () => {
    // One write (cat's buffer) of 70 KiB with no newline ending in `rea`,
    // and later `dy`: the window keeps the recent tail, so a marker split
    // by the seam still matches.
    const long = path.join(dir, 'long')
    await writeFile(long, 'x'.repeat(70 * 1024) + 'rea')
    const spawn = runPersistent({
      command: `cat ${long}; sleep 0.2; printf dy; exec sleep 30`,
      cwd: dir,
      env: env(),
      readyWhen: 'ready',
    })
    try {
      expect(await within(spawn.ready, 2_000)).toBe('ready')
    } finally {
      await stop(spawn)
    }
  }, 8_000)

  it('says the pattern never matched when the child exits first', async () => {
    const why = async (readyWhen?: string): Promise<string> => {
      const spawn = runPersistent({
        command: 'exit 3',
        cwd: dir,
        env: env(),
        ...(readyWhen === undefined ? {} : { readyWhen }),
      })
      return spawn.ready.then(
        () => 'ready',
        (e: Error) => e.message,
      )
    }
    expect(await why('up')).toBe(
      'persistent task exited before becoming ready (exit 3) — readyWhen pattern never matched',
    )
  })

  it('keeps a ready server alive past its readyWhen timeout', async () => {
    const spawn = runPersistent({
      command: `echo up; exec sleep 30`,
      cwd: dir,
      env: env(),
      readyWhen: 'up',
      timeoutMs: 150,
    })
    try {
      expect(await within(spawn.ready, 1_000)).toBe('ready')
      await Bun.sleep(400)
      expect(isAlive(spawn.child.pid)).toBe(true)
    } finally {
      await stop(spawn)
    }
  })

  it('a readyWhen timeout sends SIGTERM first, and SIGKILL to what ignores it', async () => {
    const prev = process.env['VX_KILL_GRACE_MS']
    process.env['VX_KILL_GRACE_MS'] = '300'
    const heard = path.join(dir, 'heard')
    const polite = runPersistent({
      command: `trap 'echo t > ${heard}; exit 0' TERM; sleep 30 & wait`,
      cwd: dir,
      env: env(),
      readyWhen: 'never',
      timeoutMs: 100,
    })
    const deaf = runPersistent({
      command: `trap '' TERM; exec sleep 30`,
      cwd: dir,
      env: env(),
      readyWhen: 'never',
      timeoutMs: 100,
    })
    try {
      await Promise.allSettled([polite.ready, deaf.ready])
      await polite.child.exited
      expect(await Bun.file(heard).exists()).toBe(true)
      expect(await waitForDead(deaf.child.pid, 3_000)).toBe(true)
    } finally {
      if (prev === undefined) delete process.env['VX_KILL_GRACE_MS']
      else process.env['VX_KILL_GRACE_MS'] = prev
      polite.child.kill('SIGKILL')
      deaf.child.kill('SIGKILL')
    }
  })
})

describe('runCommand — the rows its sweep asked for', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-runcmd-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('a missing working directory is a spawn failure, not a missing sh', async () => {
    const r = await runCommand({
      command: 'true',
      cwd: path.join(dir, 'gone'),
      env: { PATH: process.env.PATH ?? '' },
    })
    expect([r.exitCode, r.spawnFailed, r.stderr.includes('failed to spawn task')]).toEqual([
      127,
      true,
      true,
    ])
    expect(r.stderr).not.toContain('Install a POSIX sh')
  })

  it.skipIf(process.platform === 'win32')(
    'a timed-out command returns only once its group is gone',
    async () => {
      // The shell dies on the timeout's TERM; its child ignores it. runCommand
      // waits out the grace for the group, then SIGKILLs what is left. The
      // child inherits the ignore at fork: a trap set inside a new sh raced
      // the 100 ms timeout on a slow macOS runner and the group died at 142.
      const prev = process.env['VX_KILL_GRACE_MS']
      process.env['VX_KILL_GRACE_MS'] = '400'
      try {
        const r = await runCommand({
          command: `trap "" TERM; sleep 30 & trap - TERM; wait`,
          cwd: dir,
          env: { PATH: process.env.PATH ?? '' },
          timeoutMs: 100,
        })
        expect(r.timedOut).toBe(true)
        expect(r.durationMs).toBeGreaterThanOrEqual(400)
      } finally {
        if (prev === undefined) delete process.env['VX_KILL_GRACE_MS']
        else process.env['VX_KILL_GRACE_MS'] = prev
      }
    },
    10_000,
  )

  it.skipIf(process.platform === 'win32')(
    'a finished command is struck from the guard: what it left runs past a vx kill -9',
    async () => {
      const runner = path.resolve(import.meta.dir, '..', 'src', 'exec', 'runner.ts')
      const script = `
        const { runCommand } = await import(${JSON.stringify(runner)})
        await runCommand({
          command: '(sleep 1; echo late > late.txt) >/dev/null 2>&1 & echo up > up.txt',
          cwd: ${JSON.stringify(dir)},
          env: { PATH: process.env.PATH ?? '' },
        })
        process.kill(process.pid, 'SIGKILL')
      `
      const proc = Bun.spawn([process.execPath, '-e', script], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      expect(await proc.exited).toBe(137)
      expect(await Bun.file(path.join(dir, 'up.txt')).exists()).toBe(true)
      await Bun.sleep(2_000)
      expect(await Bun.file(path.join(dir, 'late.txt')).exists()).toBe(true)
    },
    20_000,
  )
})
