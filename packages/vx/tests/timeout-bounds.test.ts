// Every millisecond delay vx accepts is bounded against `MAX_TIMEOUT_MS`.
//
// The hazard is that an over-large delay does not saturate and does not throw —
// `setTimeout` silently reduces it to 1 ms. So a task declaring a 317-year
// timeout is SIGTERMed the instant it spawns and reported `failed`: the exact
// INVERSE of the declaration, with the only clue a `TimeoutOverflowWarning` on
// stderr that a CI log swallows.
//
// Two different treatments, and the split is deliberate:
//   - Values the user WRITES and reads back (`exec.timeout`, workspace
//     `timeout`, `--timeout`) are REFUSED. Silently substituting ~24.8 days for
//     the 317 years they asked for trades one surprise for a quieter one.
//   - `VX_TASK_TIMEOUT` is CLAMPED. Omitting a task timeout already means "no
//     limit", so the largest expressible one is indistinguishable from what the
//     user wanted, and this rung never throws by design.
//   - The teardown and config-worker deadlines FALL BACK to their defaults.
//     Those are BOUNDS, not durations: there is no "no limit" reading, because
//     each exists so something that may be wedged cannot hold the run hostage.
//     Clamping them to ~24.8 days would honour the request and hang the run —
//     trading an instant-timeout defect for a worse one.
//
// Neither treatment can ever produce the inversion, which is the point.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { MAX_TIMEOUT_MS } from '../src/util/index.js'
import type { ProjectConfig } from '../src/config.js'
import { teardownTimeoutMs } from '../src/util/settle.js'
import { validateProjectConfig } from '../src/workspace/project-loader.js'
import { loadWorkspaceConfig } from '../src/workspace/project-loader.js'
import { readTaskTimeoutEnv } from '../src/orchestrator/run.js'
import { parseRunArgs } from '../src/cli/index.js'

function taskWithTimeout(timeout: number): ProjectConfig {
  return { tasks: { build: { exec: { command: 'true', timeout } } } } as ProjectConfig
}

describe('MAX_TIMEOUT_MS is the platform bound, not a number we picked', () => {
  it('is exactly the largest delay setTimeout honours', async () => {
    // Drives REAL timers, so the constant cannot drift from the platform it
    // describes. Asserting `MAX_TIMEOUT_MS === 2 ** 31 - 1` would only restate
    // the source; this asserts the property the source is claiming.
    //
    // At the bound the timer must still be pending after a short wait; one
    // millisecond past it, the timer fires immediately — which is the whole
    // defect, reproduced here as a guard.
    const firedWithin = async (ms: number, waitMs: number): Promise<boolean> =>
      await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(true), ms)
        setTimeout(() => {
          clearTimeout(t)
          resolve(false)
        }, waitMs)
      })

    expect(await firedWithin(MAX_TIMEOUT_MS, 50)).toBe(false)
    expect(await firedWithin(MAX_TIMEOUT_MS + 1, 50)).toBe(true)
  })
})

describe('declared timeouts are REFUSED past the bound', () => {
  it('exec.timeout past the bound is refused, naming the max and the repair', () => {
    let msg = ''
    try {
      validateProjectConfig(taskWithTimeout(9_999_999_999_999), 'cfg')
    } catch (e) {
      msg = (e as Error).message
    }
    // The reader wrote a huge number meaning "no limit" and their build now
    // fails at load. The message has to say what the ceiling is AND that
    // omitting the field is the way to get what they wanted — otherwise the
    // obvious next move is to try a slightly smaller huge number.
    expect(msg).toContain('exceeds the maximum timer delay')
    expect(msg).toContain(String(MAX_TIMEOUT_MS))
    expect(msg).toContain('Omit `timeout` for no limit')
  })

  it('exec.timeout at exactly the bound is accepted', () => {
    // The boundary control. Off-by-one here would refuse a legitimate ~24.8-day
    // timeout, which is a working config broken by a correctness fix.
    expect(() => validateProjectConfig(taskWithTimeout(MAX_TIMEOUT_MS), 'cfg')).not.toThrow()
    expect(() => validateProjectConfig(taskWithTimeout(MAX_TIMEOUT_MS + 1), 'cfg')).toThrow(
      /exceeds the maximum timer delay/,
    )
  })

  it('an ordinary timeout is untouched', () => {
    expect(() => validateProjectConfig(taskWithTimeout(120_000), 'cfg')).not.toThrow()
  })

  describe('the workspace-level default is bounded by the same rule', () => {
    let root: string
    beforeEach(async () => {
      root = await mkdtemp(path.join(os.tmpdir(), 'vx-timeout-ws-'))
    })
    afterEach(async () => {
      await rm(root, { recursive: true, force: true })
    })

    it('refuses past the bound and accepts at it', async () => {
      // The workspace rung feeds every task that declares no timeout of its
      // own, so an unbounded value here kills the WHOLE run instantly rather
      // than one task — a strictly worse blast radius than `exec.timeout`.
      const write = async (v: number): Promise<void> =>
        await writeFile(path.join(root, 'vx.workspace.mjs'), `export default { timeout: ${v} }`)

      await write(MAX_TIMEOUT_MS)
      expect((await loadWorkspaceConfig(root))?.timeout).toBe(MAX_TIMEOUT_MS)

      await write(MAX_TIMEOUT_MS + 1)
      await expect(loadWorkspaceConfig(root)).rejects.toThrow(/exceeds the maximum timer delay/)
    })
  })

  it('--timeout is refused past the bound and accepted at it', () => {
    // Same treatment as the config declaration: this is a value the user typed
    // and can read back, so substituting a different one silently would be the
    // quieter surprise rather than no surprise.
    const at = parseRunArgs(['build', '--timeout', String(MAX_TIMEOUT_MS)])
    expect(at.error).toBeUndefined()
    expect(at.timeout).toBe(MAX_TIMEOUT_MS)

    const over = parseRunArgs(['build', '--timeout', String(MAX_TIMEOUT_MS + 1)])
    expect(over.error).toContain('exceeds the maximum timer delay')
    expect(over.error).toContain('reduced to 1 ms')
  })
})

describe('env knobs are CLAMPED, because their contract never throws', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('VX_TASK_TIMEOUT clamps instead of inverting', () => {
    // Falling back to "no run-level default" would also be safe, but it
    // discards a clear intent. The largest expressible timeout is ~24.8 days,
    // which is what someone typing eleven digits actually wants.
    process.env['VX_TASK_TIMEOUT'] = '9999999999999'
    expect(readTaskTimeoutEnv()).toBe(MAX_TIMEOUT_MS)

    process.env['VX_TASK_TIMEOUT'] = String(MAX_TIMEOUT_MS)
    expect(readTaskTimeoutEnv()).toBe(MAX_TIMEOUT_MS)

    process.env['VX_TASK_TIMEOUT'] = '120000'
    expect(readTaskTimeoutEnv()).toBe(120_000)
  })

  it('VX_TASK_TIMEOUT still IGNORES a malformed value', () => {
    // The pre-existing contract, pinned so the clamp did not quietly replace
    // it: a typo must not disable a task's own `exec.timeout`, so it yields
    // undefined rather than a number.
    for (const bad of ['abc', '0', '-5', '1.5', '']) {
      process.env['VX_TASK_TIMEOUT'] = bad
      expect({ bad, got: readTaskTimeoutEnv() }).toEqual({ bad, got: undefined })
    }
  })

  it('VX_TEARDOWN_TIMEOUT_MS FALLS BACK rather than clamping — it is a bound', () => {
    // The exception to this block's title, and the distinction is load-bearing.
    //
    // Unbounded, this is the sharpest instance of the class: the deadline
    // becomes 1 ms, so EVERY telemetry flush times out and every buffered
    // record is dropped — an operator asking for "never give up" gets "always
    // give up", and observability fails silently.
    //
    // But CLAMPING it to MAX_TIMEOUT_MS is wrong too, and the existing
    // `never yields a budget that can hang` test in util-settle.test.ts caught
    // that when this file first asserted it: ~24.8 days is honoured, so the run
    // hangs waiting for a flush that will never come. Trading an
    // instant-timeout defect for a hang is not a fix.
    //
    // A teardown deadline is a BOUND, not a duration — there is no "no limit"
    // reading, because the deadline exists precisely so a plugin's flush cannot
    // hold the run's exit hostage. Out-of-range therefore falls back to the
    // default, which keeps the bound real at both ends.
    process.env['VX_TEARDOWN_TIMEOUT_MS'] = '9999999999999'
    expect(teardownTimeoutMs()).toBe(3000)

    process.env['VX_TEARDOWN_TIMEOUT_MS'] = String(MAX_TIMEOUT_MS + 1)
    expect(teardownTimeoutMs()).toBe(3000)

    // At the ceiling it is honoured, so the fallback is a bound and not a cap
    // on anything a user can reasonably ask for.
    process.env['VX_TEARDOWN_TIMEOUT_MS'] = String(MAX_TIMEOUT_MS)
    expect(teardownTimeoutMs()).toBe(MAX_TIMEOUT_MS)

    process.env['VX_TEARDOWN_TIMEOUT_MS'] = '250'
    expect(teardownTimeoutMs()).toBe(250)

    delete process.env['VX_TEARDOWN_TIMEOUT_MS']
    expect(teardownTimeoutMs()).toBe(3000)
  })
})

describe('the refusal reaches a real run', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-timeout-e2e-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('a 317-year timeout fails the load instead of killing the task in 4ms', async () => {
    // The end-to-end shape this whole file exists for. Before the bound, this
    // exact config ran the CLI to completion reporting `1 failed` in 4 ms with
    // no output produced — a red run whose cause looked nothing like a timeout.
    const dir = path.join(root, 'packages/a')
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(path.join(root, 'package.json'), '{"name":"r","workspaces":["packages/*"]}')
    await writeFile(path.join(dir, 'package.json'), '{"name":"a","version":"1.0.0"}')
    await writeFile(path.join(dir, 'src', 'a.ts'), 'x')
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      'export default { tasks: { build: { exec: { command: "sleep 2 && echo BUILT > out.txt", ' +
        'timeout: 9999999999999 }, cache: { inputs: { files: ["src/**"] }, ' +
        'outputs: { files: ["out.txt"] } } } } }',
    )
    Bun.spawnSync(['git', 'init', '-q'], { cwd: root })

    const proc = Bun.spawnSync({
      cmd: ['bun', path.join(import.meta.dir, '..', 'src', 'bin.ts'), 'run', 'build'],
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr)
    expect(out).toContain('exceeds the maximum timer delay')
    expect(proc.exitCode).not.toBe(0)
    // And the task genuinely never ran — the refusal is at load, before any
    // scheduling, so nothing was spawned and then killed.
    expect(await Bun.file(path.join(dir, 'out.txt')).exists()).toBe(false)
  }, 60_000)
})
