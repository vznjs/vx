import { fstatSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  CAPTURE_TAIL_CHARS,
  withForwardArgs,
  RSS_FLOOR_SLACK_BYTES,
} from '../src/exec/runner.js'

/**
 * A deadline a fresh shell's first command (an `echo`, a `trap`) meets on
 * a loaded runner: 100-150 ms ones passed before it ran (M-23).
 */
const START_WINDOW_MS = 1_000

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
  // The TEST releases the grandchild: it holds the only reader of `gone`,
  // whose one writer is the shell (the exit is its EOF), and 50 ms after
  // that EOF writes `go`, which the grandchild waits on to print. Late
  // enough that a 0 ms drain loses it; and nothing after the exit forks.
  // The grandchild's own `sleep 0.05` (CI, macOS, 2026-10-03), a fixed
  // `sleep 0.1` (292 ms) and a `kill -0` loop forking `sleep 0.01` (317 ms)
  // each paid an exec under load and overran the 250 ms drain (M-68).
  it('a grandchild that prints within the post-exit drain reaches the live stream and the result', async () => {
    const gone = path.join(cwd, 'gone')
    const go = path.join(cwd, 'go')
    expect(Bun.spawnSync(['mkfifo', gone, go]).exitCode).toBe(0)
    let live = ''
    const running = runCommand({
      command: '(read _ < go; echo TAIL) & exec 3> gone; echo HEAD',
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      onStdout: (chunk) => {
        live += chunk
      },
    })
    // Opening `gone` for reading is what lets the shell's `exec 3> gone`
    // go on, so this reader is held before the shell can exit.
    await readFile(gone)
    await Bun.sleep(50)
    await writeFile(go, '\n')
    const result = await running
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
    [
      "past tput sgr0's charset reset",
      '\\033[1mListening\\033(B\\033[m on :3000\\n',
      '^Listening on',
      'ready',
    ],
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

  // The exit can land before the readers take the marker the task printed:
  // `echo READY; exit` read as never ready under CI load. A grandchild that
  // prints just after the shell exits opens the same gap on an idle box.
  it('a marker read after the shell exited, inside the drain bound, is ready', async () => {
    const spawn = runPersistent({
      command: '(sleep 0.05; echo READY) & exit 0',
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      readyWhen: 'READY',
    })
    await spawn.ready
    await spawn.child.exited
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
    // The window must outlast the child's first line under load: a 150 ms
    // one passed on CI before `echo` printed, and the row failed on its
    // premise (M-23). The wait runs from the spawn to past the deadline.
    const start = Date.now()
    const spawn = runPersistent({
      command: `printf 'Listening\n'; exec sleep 30`,
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      readyWhen: 'Listening',
      timeoutMs: START_WINDOW_MS,
    })
    try {
      await spawn.ready
      await Bun.sleep(start + START_WINDOW_MS + 250 - Date.now())
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

  it('leaves a `#` past the first character bare; a leading one opens a comment (X-45)', () => {
    expect([shellQuote('app#build'), shellQuote('#c')]).toEqual(['app#build', `'#c'`])
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
        `a#b`, // mid-word hash
        `#c`, // leading hash
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
    ['a trailing newline', '\n  echo args:\n', 'args: --fix a b\n'],
    ['trailing blank lines', 'echo args: \n\t\n', 'args: --fix a b\n'],
    ['control: a line continuation', 'echo args: \\\n', 'args: --fix a b\n'],
    ['control: an escaped trailing space', 'echo a\\ ', 'a  --fix a b\n'],
    ['control: an escaped backslash before the newline', 'echo a\\\\\n', 'a\\ --fix a b\n'],
  ])('%s', (_name, command, printed) => {
    expect(shOut(withForwardArgs(command, ['--fix', 'a b']))).toBe(printed)
  })

  // X-12: appended to the terminator, the heredoc never closed. Compared as
  // text: a shell writes a heredoc to a temp file, which macOS's sandboxed
  // shard refuses, so running these printed nothing there.
  it.each([
    ['a command ending in a heredoc', 'xargs echo <<X\nhi\nX', "xargs echo <<X --fix 'a b'\nhi\nX"],
    [
      'a quoted, tab-stripped heredoc',
      "xargs echo <<-'X'\n\thi\n\tX\n",
      "xargs echo <<-'X' --fix 'a b'\n\thi\n\tX",
    ],
    [
      'control: a command after a heredoc',
      'xargs echo <<X\nhi\nX\necho done',
      "xargs echo <<X\nhi\nX\necho done --fix 'a b'",
    ],
  ])('%s', (_name, command, forwarded) => {
    expect(withForwardArgs(command, ['--fix', 'a b'])).toBe(forwarded)
  })

  // X-110: a `<<word` the shell never reads as a heredoc (in a comment, in
  // quotes) made every later line a "body", so the args went on that line:
  // ` --fix … # …` ran `--fix` as a command. A quote in a real body left
  // the scan inside it, and a template literal's closing newline closed
  // the comment it was scanned for: either way the comment took the args.
  it.each([
    ['a trailing comment before a closing newline', 'echo args: # c\n', 'args: --fix a b\n'],
    ['a << in a comment line', '# then << check\necho args:', 'args: --fix a b\n'],
    ['a << in double quotes', 'echo "1<<x" >/dev/null\necho args:', 'args: --fix a b\n'],
    ['a << in single quotes', "echo '<<EOF' >/dev/null\necho args:", 'args: --fix a b\n'],
  ])('%s', (_name, command, printed) => {
    expect(shOut(withForwardArgs(command, ['--fix', 'a b']))).toBe(printed)
  })

  it('a quote in a heredoc body does not hide a trailing comment', () => {
    expect(withForwardArgs("cat <<X\nit's\nX\necho done # note", ['--fix'])).toBe(
      "cat <<X\nit's\nX\necho done --fix # note",
    )
  })

  it('a comment line after a heredoc leaves its terminator alone', () => {
    expect(withForwardArgs('xargs echo <<X\nhi\nX\n# done', ['--fix'])).toBe(
      'xargs echo <<X --fix\nhi\nX\n# done',
    )
  })

  it('a backslash-quoted heredoc', () => {
    expect(withForwardArgs('xargs echo <<\\X\nhi\nX', ['--fix'])).toBe(
      'xargs echo <<\\X --fix\nhi\nX',
    )
  })

  it('control: a here-string opens no heredoc', () => {
    expect(withForwardArgs('cat <<<word\necho done', ['--fix'])).toBe(
      'cat <<<word\necho done --fix',
    )
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

  // The bounds count UTF-16 units, and a cut between the two halves of a
  // character above U+FFFF left a lone surrogate on each side of the
  // dropped-output line: the replay read U+FFFD where the emoji was.
  it('never cuts a character in two at either bound', async () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    const read = (text: string) =>
      streamToString(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(text))
            c.close()
          },
        }),
      )
    // The head's bound falls inside the emoji; the tail's falls inside it.
    const atHead = await read(
      'a'.repeat(CAPTURE_HEAD_CHARS - 1) + '😀' + 'b'.repeat(CAPTURE_TAIL_CHARS + 10),
    )
    const atTail = await read(
      'a'.repeat(CAPTURE_HEAD_CHARS) + '😀' + 'b'.repeat(CAPTURE_TAIL_CHARS - 1),
    )
    expect([atHead, atTail].map((t) => [lone.test(t), t.includes('of output not kept')])).toEqual([
      [false, true],
      [false, true],
    ])
  })

  // The head stops one unit short when its bound falls inside an emoji, and
  // the chunk went to the tail; a later one-character chunk still fit the
  // head and was retained BEFORE it: `…a😀bc` read `…ac😀b`.
  it('keeps chunk order once the head stopped short of an emoji', async () => {
    const chunks = ['a'.repeat(CAPTURE_HEAD_CHARS - 1), '😀b', 'c']
    const got = await streamToString(
      new ReadableStream<Uint8Array>({
        start(c) {
          for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk))
          c.close()
        },
      }),
    )
    expect(got.slice(-4)).toBe('😀bc')
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

  it('a floor given as a function is asked with the peak, and decides as a number would', () => {
    const MB = 1024 * 1024
    const at = (maxRSS: number) =>
      ({ cpuTime: { total: 1_500_000n }, maxRSS }) as unknown as Parameters<
        typeof resourceUsageToCpuRss
      >[0]
    const asked: number[] = []
    const floorFor = (peak: number): number => {
      asked.push(peak)
      return 480 * MB
    }
    expect(resourceUsageToCpuRss(at(480 * MB), floorFor)).toEqual({ cpuMs: 1500 })
    const over = 480 * MB + RSS_FLOOR_SLACK_BYTES + 1
    expect(resourceUsageToCpuRss(at(over), floorFor)).toEqual({ cpuMs: 1500, peakRssBytes: over })
    expect(asked).toEqual([480 * MB, over])
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

  // macOS's `sh` is bash, where `[[` and `time` are reserved words, not
  // programs: `exec [[ -f x ]]` is "exec: [[: not found", exit 127, where
  // the bare command ran. Run under bash, as the guarantee.
  it("leaves bash's reserved words alone (exec cannot run them)", () => {
    for (const command of ['[[ -f /etc/passwd ]]', 'time /bin/sh -c true']) {
      const r = Bun.spawnSync(['bash', '-c', execWrap(command)], { stderr: 'pipe' })
      expect([command, r.exitCode]).toEqual([command, 0])
    }
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
    // The pid vx tracks runs sleep directly (verified via /proc comm on
    // Linux). sh's exec into sleep lands when the scheduler lets it: a fixed
    // 50 ms read "sh" on a loaded CI runner, so poll until it changes. A
    // wrapper that never execs stays "sh" through the deadline and fails.
    let comm = 'sh'
    for (const end = Date.now() + 5000; comm === 'sh' && Date.now() < end;) {
      await Bun.sleep(10)
      comm = (
        await Bun.file(`/proc/${child.pid}/comm`)
          .text()
          .catch(() => 'sleep\n')
      ).trim()
    }
    expect(comm).toBe('sleep')
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
    // A window the first line meets under load, waited out from the spawn
    // (M-23; the row above).
    const start = Date.now()
    const spawn = runPersistent({
      command: `echo up; exec sleep 30`,
      cwd: dir,
      env: env(),
      readyWhen: 'up',
      timeoutMs: START_WINDOW_MS,
    })
    try {
      expect(await within(spawn.ready, START_WINDOW_MS)).toBe('ready')
      await Bun.sleep(start + START_WINDOW_MS + 250 - Date.now())
      expect(isAlive(spawn.child.pid)).toBe(true)
    } finally {
      await stop(spawn)
    }
  })

  it('a readyWhen timeout sends SIGTERM first, and SIGKILL to what ignores it', async () => {
    const prev = process.env['VX_KILL_GRACE_MS']
    process.env['VX_KILL_GRACE_MS'] = '300'
    const heard = path.join(dir, 'heard')
    // Each shell sets its trap before the deadline only if the window
    // outlasts its start: a SIGTERM that came first killed the polite one
    // untrapped, and passed the deaf one by TERM (M-23).
    const polite = runPersistent({
      command: `trap 'echo t > ${heard}; exit 0' TERM; sleep 30 & wait`,
      cwd: dir,
      env: env(),
      readyWhen: 'never',
      timeoutMs: START_WINDOW_MS,
    })
    const deaf = runPersistent({
      command: `trap '' TERM; exec sleep 30`,
      cwd: dir,
      env: env(),
      readyWhen: 'never',
      timeoutMs: START_WINDOW_MS,
    })
    try {
      await Promise.allSettled([polite.ready, deaf.ready])
      await polite.child.exited
      expect(await Bun.file(heard).exists()).toBe(true)
      // `signalCode` is set when Bun reaps the child, after the kernel says
      // dead: read right after `waitForDead` it was null 4 times in 50 (M-32).
      const died = await Promise.race([
        deaf.child.exited.then(() => deaf.child.signalCode),
        Bun.sleep(3_000).then(() => 'still running'),
      ])
      expect(died).toBe('SIGKILL')
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

  it('a timed-out command returns only once its group is gone', async () => {
    // The shell dies on the timeout's TERM; its child ignores it. runCommand
    // waits out the grace for the group, then SIGKILLs what is left. The
    // child inherits the ignore at fork: a trap set inside a new sh raced
    // the 100 ms timeout on a slow macOS runner and the group died at 142.
    // The outer shell's own trap raced it too (a 300 ms start: 106 ms,
    // M-23), so the deadline is one a shell's start meets.
    const prev = process.env['VX_KILL_GRACE_MS']
    process.env['VX_KILL_GRACE_MS'] = '400'
    try {
      const r = await runCommand({
        command: `trap "" TERM; sleep 30 & trap - TERM; wait`,
        cwd: dir,
        env: { PATH: process.env.PATH ?? '' },
        timeoutMs: START_WINDOW_MS,
      })
      expect(r.timedOut).toBe(true)
      expect(r.durationMs).toBeGreaterThanOrEqual(START_WINDOW_MS + 400)
    } finally {
      if (prev === undefined) delete process.env['VX_KILL_GRACE_MS']
      else process.env['VX_KILL_GRACE_MS'] = prev
    }
  }, 10_000)

  it('a finished command is struck from the guard: what it left runs past a vx kill -9', async () => {
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
  }, 20_000)
})

// Bun's `'pipe'` is a socketpair, and Linux opens `/dev/stdout` through
// `/proc/self/fd/1`, which a socket refuses: `echo x > /dev/stdout` failed
// "No such device or address" in every task (X-113). macOS dups the
// descriptor instead, so the rows hold there with or without the fix.
describe("a task's stdout and stderr are pipes it can open by path", () => {
  const env = { PATH: process.env.PATH ?? '' }
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), 'vx-runner-pipes-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it('runCommand: a write to /dev/stdout and a tee to /dev/stderr succeed', async () => {
    const r = await runCommand({
      command: 'echo x > /dev/stdout; echo y | tee /dev/stderr',
      cwd,
      env,
    })
    expect({ exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }).toEqual({
      exitCode: 0,
      stdout: 'x\ny\n',
      stderr: 'y\n',
    })
  })

  it('runPersistent: a server announcing itself on /dev/stdout becomes ready', async () => {
    const live: string[] = []
    const spawn = runPersistent({
      command: 'echo Listening > /dev/stdout && exec sleep 30',
      cwd,
      env,
      readyWhen: 'Listening',
      onStdout: (c) => live.push(c),
    })
    try {
      await spawn.ready
      expect(live.join('')).toBe('Listening\n')
    } finally {
      spawn.child.kill('SIGKILL')
      await spawn.child.exited
    }
  })

  // The guard (kill-tree.ts) is spawned between a first task's pipes and
  // its own spawn, and lives as long as vx: a write end it inherited held
  // that task's stdout open, and its reader waited out the drain bound.
  it("the first task's output ends at its exit: no long-lived spawn holds its write end", async () => {
    const runner = path.resolve(import.meta.dir, '..', 'src', 'exec', 'runner.ts')
    const script = `
      const { runCommand } = await import(${JSON.stringify(runner)})
      const r = await runCommand({ command: 'echo hi', cwd: ${JSON.stringify(cwd)}, env: { PATH: process.env.PATH ?? '' } })
      process.stdout.write(JSON.stringify({ stdout: r.stdout, stderr: r.stderr }))
    `
    const proc = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'inherit' })
    const out = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    expect(JSON.parse(out)).toEqual({ stdout: 'hi\n', stderr: '' })
  })

  // Found by fstat, not /proc/self/fd: under vx's sandbox /proc is
  // another pid namespace's. A set, not a count: a descriptor an earlier
  // row left closing closed inside the window and hid nothing but read as
  // two fewer (macOS CI).
  const openFds = (): Set<number> => {
    const open = new Set<number>()
    for (let fd = 0; fd < 1024; fd++) {
      try {
        fstatSync(fd)
        open.add(fd)
      } catch {
        // not open
      }
    }
    return open
  }

  it('every descriptor a task took is closed after it: plain, cut, spawn-failed, persistent', async () => {
    await runCommand({ command: 'true', cwd, env })
    const before = openFds()
    for (let i = 0; i < 20; i++) await runCommand({ command: 'echo a; echo b >&2', cwd, env })
    // The drain bound cancels the readers while a backgrounded child holds the pipe.
    const cut = await runCommand({ command: 'sleep 2 & echo up', cwd, env })
    expect(cut.stderr).toContain(POST_EXIT_CUT_LINE)
    const failed = await runCommand({ command: 'true', cwd: path.join(cwd, 'missing'), env })
    expect(failed.spawnFailed).toBe(true)
    const spawn = runPersistent({ command: 'echo up; exec sleep 30', cwd, env, readyWhen: 'up' })
    await spawn.ready
    spawn.child.kill('SIGKILL')
    await spawn.child.exited
    await Bun.sleep(50)
    expect([...openFds()].filter((fd) => !before.has(fd))).toEqual([])
  }, 10_000)
})
