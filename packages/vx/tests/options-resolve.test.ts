// `src/orchestrator/options.ts` declares `RunOptions` and nothing else — it
// is a types-only leaf so `prepare.ts` can import it without an upward import
// of the module entry. The BEHAVIOUR it documents lives elsewhere, in three
// precedence ladders that a refactor can silently invert:
//
//   timeout      per-task `exec.timeout` > RunOptions.timeout (`--timeout`)
//                > `VX_RUN_TIMEOUT` env > workspace `run.timeout`
//   retries      per-task `exec.retries` > RunOptions.retries (`--retries`)
//                > `VX_RUN_RETRIES` env > workspace `run.retries`
//   concurrency  RunOptions.concurrency > `VX_RUN_CONCURRENCY` env
//                > workspace `run.concurrency` > the cores this process may use
//
// Two subtleties carry most of the risk, and both are the kind a plausible
// rewrite breaks without failing anything else:
//   - an explicit config `0` must WIN over a run-level default rather than
//     read as absent (`exec.retries: 0` means "never retry" — `??`, not `||`
//     and not `Math.max`);
//   - a MALFORMED env value is refused before any task rather than
//     imposing or disabling a limit.
// And every one of these knobs is per-RUN, so none may reach a cache key.
//
// tests/task-timeout.test.ts and tests/retries.test.ts already pin the
// individual timeout rungs and the CLI-side retry cases; this suite covers
// what they do not: the env-rung PARSER in isolation, the retries ladder's
// unguarded direction (config beats a *smaller* run-level default), the
// entire concurrency ladder, and the combined key-stability and
// wire boundaries.

import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace as makeWorkspaceRoot } from './helpers/workspace.js'
import type { Logger } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'
import { MAX_TIMEOUT_MS } from '../src/util/index.js'
import { settingEnv } from '../src/settings.js'

const TIMEOUT = 20_000

/** Long enough that spawn jitter can never fake an overlap or a serialization. */
const SPAN_SECONDS = '0.3'

interface Fixture {
  root: string
  out: string[]
  err: string[]
}

let fixture: Fixture

const capturingLogger = (f: Fixture): Logger => ({
  status() {},
  taskStdout(_node, chunk) {
    f.out.push(chunk)
  },
  taskStderr(_node, chunk) {
    f.err.push(chunk)
  },
  taskComplete() {},
})

async function makeWorkspace(): Promise<Fixture> {
  const root = await makeWorkspaceRoot({ prefix: 'vx-options-' })
  return { root, out: [], err: [] }
}

/** Rewrite the workspace file with `fields` (object-literal body) plus the local plugins. */
async function setWorkspace(root: string, fields: string): Promise<void> {
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    `export default { ${fields}, plugins: [] }\n`,
  )
}

function lineCount(file: string): number {
  return readFileSync(file, 'utf8').trim().split('\n').length
}

/**
 * A task that stamps wallclock nanoseconds either side of a fixed sleep, so
 * two tasks' spans reveal whether the scheduler admitted them together.
 */
const SPAN_CMD = `date +%s%N > start.txt && sleep ${SPAN_SECONDS} && date +%s%N > end.txt`

interface Span {
  s: number
  e: number
}

/** The two projects' spans, earliest start first. */
async function spansOf(...dirs: string[]): Promise<[Span, Span]> {
  const stamp = async (p: string) => Number(await Bun.file(p).text())
  const spans: Span[] = []
  for (const d of dirs) {
    spans.push({
      s: await stamp(path.join(d, 'start.txt')),
      e: await stamp(path.join(d, 'end.txt')),
    })
  }
  spans.sort((x, y) => x.s - y.s)
  return [spans[0]!, spans[1]!]
}

// --------------------------------------------------------------------------
// options.ts itself
// --------------------------------------------------------------------------

describe('options.ts — a types-only leaf', () => {
  it('contributes ZERO runtime exports', async () => {
    // The file's header states why it exists: internals like prepare.ts import
    // `RunOptions` from here rather than from the module entry, so the entry
    // stays cycle-free. A runtime helper added here (the tempting home for a
    // `resolveOptions()`) would become a real edge from every internal back
    // into a shared module and can re-open that cycle. Types erase; runtime
    // values do not.
    const mod: Record<string, unknown> = await import('../src/orchestrator/options.js')
    expect(Object.keys(mod)).toEqual([])
  })
})

// --------------------------------------------------------------------------
// timeout ladder — the env rung's parser
// --------------------------------------------------------------------------

describe('VX_RUN_TIMEOUT — the env rung parser', () => {
  const read = (raw: string | undefined): unknown =>
    settingEnv('run.timeout', raw === undefined ? {} : { VX_RUN_TIMEOUT: raw })
  const refusal = (raw: string): string => {
    try {
      read(raw)
    } catch (err) {
      return (err as Error).message
    }
    return 'NO THROW'
  }

  it('takes a duration, in ms', () => {
    expect(read('250ms')).toBe(250)
    expect(read('1s')).toBe(1000)
    expect(read('10m')).toBe(600_000)
  })

  it('an unset or empty value contributes nothing (the next rung applies)', () => {
    // Empty is the `VX_RUN_TIMEOUT="$UNSET_VAR"` shape: "not passed", never
    // a 0 ms limit that kills every task at once.
    expect(read(undefined)).toBeUndefined()
    expect(read('')).toBeUndefined()
  })

  it('refuses what is no duration, before any task, rather than guessing', () => {
    // Ignoring a typo let it disable nothing and say nothing; `Number()`
    // read hex, exponents and padding as some other limit.
    for (const raw of ['0ms', '-1s', '1.5s', 'abc', '0x10', '1e3', '+300', ' 100ms ', 'Infinity']) {
      expect(refusal(raw)).toStartWith('VX_RUN_TIMEOUT must be a duration')
    }
    expect(refusal('250')).toBe(
      "VX_RUN_TIMEOUT takes a duration with its unit, like '250ms' or '1s' (got 250)",
    )
  })

  it('refuses a value past the timer ceiling, which would fire at once', () => {
    expect(read(`${MAX_TIMEOUT_MS}ms`)).toBe(MAX_TIMEOUT_MS)
    expect(refusal(`${MAX_TIMEOUT_MS + 1}ms`)).toContain('exceeds the maximum timer delay')
  })
})

// --------------------------------------------------------------------------
// timeout ladder — the env rung reaching a real task
// --------------------------------------------------------------------------

describe('timeout ladder — the env rung in isolation', () => {
  beforeEach(async () => {
    fixture = await makeWorkspace()
    delete process.env['VX_RUN_TIMEOUT']
  })
  afterEach(async () => {
    delete process.env['VX_RUN_TIMEOUT']
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'VX_RUN_TIMEOUT alone bounds a task — no workspace file, no --timeout',
    async () => {
      // The sibling suite always pairs the env with a workspace `timeout`, so
      // it cannot distinguish "the env rung works" from "the env rung merely
      // outranks the workspace rung". With no other rung present, a kill can
      // only have come from the env.
      // `exec sleep` so the SIGTERM reaches the sleeper rather than an
      // intermediate shell that would orphan it.
      await addProject(
        fixture.root,
        'a',
        `export default { tasks: { run: { exec: { command: 'exec sleep 30' } } } }`,
      )
      process.env['VX_RUN_TIMEOUT'] = '250ms'
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(false)
      expect(r.outcomes[0]!.status).toBe('failed')
      expect(fixture.err.join('')).toContain('timed out after 250ms')
    },
    TIMEOUT,
  )
})

// --------------------------------------------------------------------------
// retries ladder
// --------------------------------------------------------------------------

describe('retries ladder — `exec.retries` vs the run-level default', () => {
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'config wins in BOTH directions; the run-level default fills only the gap',
    async () => {
      // One run, three independent projects, one attempt-counter each. The
      // resolution is `1 + (step.retries ?? args.retries ?? 0)`, and each
      // project pins a different rung of it:
      //
      //   pinned     retries: 0  + run-level 1  → 1 attempt   (0 is not absent)
      //   insistent  retries: 2  + run-level 1  → 3 attempts  (config > default,
      //                                                        even when LARGER)
      //   bare       (none)      + run-level 1  → 2 attempts  (default applies)
      //
      // The `insistent` row is the one nothing else covers: the sibling suite
      // only pins a config 0 beating a LARGER default, which a `Math.min` would
      // also satisfy. With both directions asserted together, min, max, `||`,
      // and a swapped `??` order each break at least one row.
      const failing = (retries: string) =>
        `export default { tasks: { build: { exec: { command: 'echo x >> count.txt; exit 1'${retries} } } } }`
      const pinned = await addProject(fixture.root, 'pinned', failing(', retries: 0'))
      const insistent = await addProject(fixture.root, 'insistent', failing(', retries: 2'))
      const bare = await addProject(fixture.root, 'bare', failing(''))

      const r = await run({
        cwd: fixture.root,
        tasks: ['build'],
        projects: ['pinned', 'insistent', 'bare'],
        retries: 1,
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(false)

      expect(lineCount(path.join(pinned, 'count.txt'))).toBe(1)
      expect(lineCount(path.join(insistent, 'count.txt'))).toBe(3)
      expect(lineCount(path.join(bare, 'count.txt'))).toBe(2)

      // `attempts` is set only when a task ran more than once, so it doubles
      // as an independent read on the same three numbers.
      const attempts = new Map(r.outcomes.map((o) => [o.node.id, o.attempts]))
      expect(attempts.get('pinned#build')).toBeUndefined()
      expect(attempts.get('insistent#build')).toBe(3)
      expect(attempts.get('bare#build')).toBe(2)
    },
    TIMEOUT,
  )

  it(
    'a run-level `retries: 0` still lets a task keep its own retries',
    async () => {
      // `retries: 0` at the run level is a real value, not "unset": it must
      // suppress the default for tasks that declare nothing while leaving a
      // declaring task alone. A `Math.min(step, args)` reading fails here.
      const insistent = await addProject(
        fixture.root,
        'insistent',
        `export default { tasks: { build: { exec: { command: 'echo x >> count.txt; exit 1', retries: 2 } } } }`,
      )
      const bare = await addProject(
        fixture.root,
        'bare',
        `export default { tasks: { build: { exec: { command: 'echo x >> count.txt; exit 1' } } } }`,
      )
      const r = await run({
        cwd: fixture.root,
        tasks: ['build'],
        projects: ['insistent', 'bare'],
        retries: 0,
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(false)
      expect(lineCount(path.join(insistent, 'count.txt'))).toBe(3)
      expect(lineCount(path.join(bare, 'count.txt'))).toBe(1)
    },
    TIMEOUT,
  )
})

// --------------------------------------------------------------------------
// concurrency ladder
// --------------------------------------------------------------------------

describe('concurrency ladder — options > workspace > hardwareConcurrency', () => {
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'the workspace rung is honored, and RunOptions.concurrency overrides it',
    async () => {
      // Nothing else in the suite asserts that `run: { concurrency }` in .vx/workspace
      // reaches the scheduler at all — project-loader.test.ts only proves it
      // LOADS, and the CLI tests only prove `--concurrency` parses. Two runs
      // over one fixture: the workspace value alone must serialize two
      // independent tasks, and an explicit option must then override it.
      const config = `export default { tasks: { run: { exec: { command: ${JSON.stringify(SPAN_CMD)} } } } }`
      const a = await addProject(fixture.root, 'a', config)
      const b = await addProject(fixture.root, 'b', config)
      await setWorkspace(fixture.root, 'run: { concurrency: 1 }')

      const serial = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a', 'b'],
        log: capturingLogger(fixture),
      })
      expect(serial.ok).toBe(true)
      const [first, second] = await spansOf(a, b)
      // One worker: the later task cannot have started before the earlier ended.
      expect(second.s).toBeGreaterThanOrEqual(first.e)

      const parallel = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a', 'b'],
        concurrency: 2,
        log: capturingLogger(fixture),
      })
      expect(parallel.ok).toBe(true)
      const [p1, p2] = await spansOf(a, b)
      // Two workers: both are dispatched in the same tick, so the second
      // starts well inside the first's 300ms span.
      expect(p2.s).toBeLessThan(p1.e)
    },
    TIMEOUT,
  )

  it.skipIf(navigator.hardwareConcurrency < 2)(
    'with neither rung set the hardwareConcurrency default runs tasks in parallel',
    async () => {
      // The tail of the ladder. Skipped on a single-core host, where the
      // default is legitimately 1 and there is nothing to observe.
      const config = `export default { tasks: { run: { exec: { command: ${JSON.stringify(SPAN_CMD)} } } } }`
      const a = await addProject(fixture.root, 'a', config)
      const b = await addProject(fixture.root, 'b', config)
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a', 'b'],
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(true)
      const [first, second] = await spansOf(a, b)
      expect(second.s).toBeLessThan(first.e)
    },
    TIMEOUT,
  )
})

// --------------------------------------------------------------------------
// none of these knobs may reach a cache key
// --------------------------------------------------------------------------

describe('run-level knobs are never folded into a cache key', () => {
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    "a run with every scheduling/presentation knob set HITS a plain run's entry",
    async () => {
      // `--retry` and `--timeout` have their own single-knob pins; concurrency,
      // continueMode, flow, outputLogs, tags and command have none.
      // Setting all of them at once is the cheap invariant: these describe HOW
      // a run is executed and reported, never WHAT it computes, so the key must
      // not move. Folding any one of them in turns this into `'success'`.
      const dir = await addProject(
        fixture.root,
        'a',
        `export default {
          tasks: {
            build: {
              exec: { command: 'echo x >> count.txt && echo built' },
              cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } },
            },
          },
        }`,
      )
      const plain = await run({
        cwd: fixture.root,
        tasks: ['build'],
        projects: ['a'],
        log: capturingLogger(fixture),
      })
      expect(plain.outcomes[0]!.status).toBe('success')

      const decorated = await run({
        cwd: fixture.root,
        tasks: ['build'],
        projects: ['a'],
        retries: 3,
        timeout: 60_000,
        concurrency: 1,
        continueMode: 'always',
        flow: 'broad',
        outputLogs: 'none',
        tags: { ci: 'nightly', shard: '3' },
        command: 'vx run build --retry 3',
        log: capturingLogger({ root: fixture.root, out: [], err: [] }),
      })
      expect(decorated.outcomes[0]!.status).toBe('cache-hit')
      // The hit replayed rather than re-executed: the counter is untouched.
      expect(lineCount(path.join(dir, 'count.txt'))).toBe(1)
    },
    TIMEOUT,
  )
})
