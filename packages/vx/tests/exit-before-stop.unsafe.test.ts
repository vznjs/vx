// A stop that lands after the command exited (vx still ending its streams)
// is not the command's end: the result says so (`exitedBeforeStop`), and
// `--fail-fast` judges such a task by its own exit (fail-fast.test.ts runs
// the unsandboxed one end to end). The stderr line is held while stdout's
// line is open, so it reaches `onStderr` only once the streams end, after
// the exit: the stop lands there, without a timer. `go` holds the
// stderr write until stdout's open line was read.
import { mkdtemp, rm } from 'node:fs/promises'
import { realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { initSandbox, resetSandbox } from '../src/sandbox/session.js'
import { resolveSandboxConfig } from '../src/sandbox/grants.js'
import { runSandboxed } from '../src/sandbox/runtime.js'
import { runCommand } from '../src/exec/runner.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('exit-before-stop test')
// `go` appears once vx has read the open stdout line, so the stderr line
// written after it is held behind that line.
const EXITS = "printf open; while [ ! -f go ]; do :; done; printf 'held\\n' >&2; exit 3"
const LIVES = "printf open; while [ ! -f go ]; do :; done; printf 'held\\n' >&2; echo; sleep 30"

const saved = process.env['VX_TEST_OPEN_LINE_WAIT']
beforeAll(() => {
  process.env['VX_TEST_OPEN_LINE_WAIT'] = '60s'
})
afterAll(() => {
  if (saved === undefined) delete process.env['VX_TEST_OPEN_LINE_WAIT']
  else process.env['VX_TEST_OPEN_LINE_WAIT'] = saved
})

let dir = ''
beforeEach(async () => {
  dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-exit-stop-')))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Stops the run when the held stderr line arrives, killing what still runs as the stop's sweep does. */
const stopOnHeld = () => {
  const ac = new AbortController()
  const liveChildren = new Set<ReturnType<typeof Bun.spawn>>()
  const onStderr = (chunk: string): void => {
    if (!chunk.includes('held') || ac.signal.aborted) return
    ac.abort('SIGTERM')
    for (const c of liveChildren) c.kill('SIGTERM')
  }
  const onStdout = (chunk: string): void => {
    if (chunk.includes('open')) writeFileSync(path.join(dir, 'go'), '')
  }
  return { signal: ac.signal, onStdout, onStderr, liveChildren }
}

const fact = (r: { exitCode: number; exitedBeforeStop?: true }) => [
  r.exitCode,
  r.exitedBeforeStop === true,
]

describe('unsandboxed', () => {
  const start = (command: string) =>
    runCommand({ command, cwd: dir, env: process.env, ...stopOnHeld() })

  it('a stop after the exit leaves the exit its own', async () => {
    expect(fact(await start(EXITS))).toEqual([3, true])
  })

  it('CONTROL: a stop while it runs is the stop', async () => {
    expect(fact(await start(LIVES))).toEqual([143, false])
  })
})

describe.skipIf(!available)('sandboxed', () => {
  beforeEach(async () => {
    await initSandbox()
  })
  afterEach(async () => {
    await resetSandbox()
  })

  const start = (command: string) =>
    runSandboxed({
      command,
      cwd: dir,
      env: process.env,
      baseAllowRead: [dir],
      baseDenyRead: [],
      reportWithin: dir,
      reportLinked: [],
      config: resolveSandboxConfig({}, dir),
      ...stopOnHeld(),
    })

  it('a stop after the exit leaves the exit its own', async () => {
    expect(fact(await start(EXITS))).toEqual([3, true])
  })

  it('CONTROL: a stop while it runs is the stop', async () => {
    expect(fact(await start(LIVES))).toEqual([143, false])
  })
})
