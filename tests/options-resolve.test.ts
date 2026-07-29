// `src/orchestrator/options.ts` declares `RunOptions` and nothing else — it
// is a types-only leaf so `prepare.ts` can import it without an upward import
// of the module entry. The BEHAVIOUR it documents lives elsewhere, in three
// precedence ladders that a refactor can silently invert:
//
//   timeout      per-task `exec.timeout` > RunOptions.timeout (`--timeout`)
//                > `VX_TASK_TIMEOUT` env > workspace `timeout`
//   retries      per-task `exec.retries` > RunOptions.retries (`--retry`)
//   concurrency  RunOptions.concurrency > workspace `concurrency`
//                > `navigator.hardwareConcurrency`
//   memory       RunOptions.memory (`--memory`) > `os.totalmem()`
//
// Two subtleties carry most of the risk, and both are the kind a plausible
// rewrite breaks without failing anything else:
//   - an explicit config `0` must WIN over a run-level default rather than
//     read as absent (`exec.retries: 0` means "never retry" — `??`, not `||`
//     and not `Math.max`);
//   - a MALFORMED env value must fall through to the next rung rather than
//     imposing or disabling a limit.
// And every one of these knobs is per-RUN, so none may reach a cache key.
//
// tests/task-timeout.test.ts and tests/retries.test.ts already pin the
// individual timeout rungs and the CLI-side retry cases; this suite covers
// what they do not: the env-rung PARSER in isolation, the retries ladder's
// unguarded direction (config beats a *smaller* run-level default), the
// entire concurrency + memory ladders, and the combined key-stability and
// wire boundaries.

import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Logger, RunOptions, TelemetrySink } from '../src/orchestrator/index.js'
import {
  createEventBus,
  optionsToRequest,
  requestToOptions,
  run,
} from '../src/orchestrator/index.js'
import { readTaskTimeoutEnv } from '../src/orchestrator/run.js'
import { parseDecimalInt } from '../src/util/index.js'

const TIMEOUT = 20_000
const MiB = 1024 * 1024
const GiB = 1024 ** 3

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
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-options-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }, null, 2),
  )
  await mkdir(path.join(root, 'packages'), { recursive: true })
  const git = (...args: string[]) => {
    const p = Bun.spawnSync({
      cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr))
  }
  git('init', '-q')
  git('config', 'user.email', 'test@vx.local')
  git('config', 'user.name', 'vx test')
  return { root, out: [], err: [] }
}

async function addProject(root: string, name: string, config: string): Promise<string> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '0.0.0' }, null, 2),
  )
  await writeFile(path.join(dir, 'vx.config.mjs'), config)
  return dir
}

async function setWorkspace(root: string, config: string): Promise<void> {
  await writeFile(path.join(root, 'vx.workspace.mjs'), config)
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

describe('VX_TASK_TIMEOUT — the env rung parser', () => {
  const read = (raw: string | undefined): number | undefined => {
    const prev = process.env['VX_TASK_TIMEOUT']
    if (raw === undefined) delete process.env['VX_TASK_TIMEOUT']
    else process.env['VX_TASK_TIMEOUT'] = raw
    try {
      return readTaskTimeoutEnv()
    } finally {
      if (prev === undefined) delete process.env['VX_TASK_TIMEOUT']
      else process.env['VX_TASK_TIMEOUT'] = prev
    }
  }

  it('accepts a plain positive decimal integer', () => {
    expect(read('250')).toBe(250)
    expect(read('1')).toBe(1)
    expect(read('60000')).toBe(60000)
  })

  it('an unset or empty value contributes nothing (the next rung applies)', () => {
    // Empty is the `VX_TASK_TIMEOUT="$UNSET_VAR"` shape — it must behave like
    // "not passed", never like a 0ms limit that kills every task instantly.
    expect(read(undefined)).toBeUndefined()
    expect(read('')).toBeUndefined()
    expect(read('   ')).toBeUndefined()
  })

  it('0 and negatives are IGNORED — 0 never means "no timeout"', () => {
    // Both `Number()` to a non-positive value. Returning 0 here would arm a
    // 0ms timer (kill everything); treating 0 as "disable the limit" would
    // silently defeat a workspace `timeout`. Ignoring is the third option and
    // the one that keeps the ladder honest: the next rung decides.
    expect(read('0')).toBeUndefined()
    expect(read('-1')).toBeUndefined()
    expect(read('-250')).toBeUndefined()
  })

  it('non-integer and non-numeric junk is IGNORED', () => {
    // The documented promise: "a typo never silently disables a task's own
    // `exec.timeout`" — a bad value must not arm anything at all.
    expect(read('1.5')).toBeUndefined()
    expect(read('abc')).toBeUndefined()
    expect(read('250ms')).toBeUndefined()
    expect(read('NaN')).toBeUndefined()
    expect(read('1_000')).toBeUndefined()
    expect(read('Infinity')).toBeUndefined()
    expect(read('-Infinity')).toBeUndefined()
  })

  // ---- CURRENT behaviour, suspected defect --------------------------------
  // `readTaskTimeoutEnv` (src/orchestrator/run.ts) parses with a bare
  // `Number()`. The sibling `--timeout` FLAG was moved off `Number()` onto
  // `parseDecimalInt` in the 2026-07-26 CLI-hygiene wave for exactly this
  // reason — `src/util/num.ts` says so in as many words: "`Number()` is the
  // wrong tool at an argument boundary: it silently accepts hex (`0x10` →
  // 16), exponents (`1e3` → 1000), fractions, a leading `+`, and surrounding
  // whitespace — so a typo becomes a different number instead of an error."
  // The env rung was never tightened, so the two boundaries disagree. These
  // tests pin what the code does TODAY; if the env rung is tightened they
  // should flip to `toBeUndefined()`.
  it('CURRENT: accepts non-decimal numeric forms a typo can produce', () => {
    expect(read('0x10')).toBe(16) // hex — a 16ms limit, not 10ms and not an error
    expect(read('0b101')).toBe(5)
    expect(read('0o17')).toBe(15)
    expect(read('1e3')).toBe(1000)
    expect(read('+300')).toBe(300)
    expect(read('  100  ')).toBe(100)
    expect(read('\n700\n')).toBe(700) // a trailing newline from `$(cat file)`
  })

  it('CURRENT: accepts a value past MAX_SAFE_INTEGER, silently rounded', () => {
    // The user typed …93; the run gets …92. `Number.isInteger` is true for
    // both, so the guard lets it through. `parseDecimalInt` rejects this.
    expect(read('9007199254740993')).toBe(9007199254740992)
    expect(read('1e21')).toBe(1e21)
  })

  it('the env rung and the --timeout flag disagree on the SAME input', () => {
    // The drift stated as one assertion, so it reads as the finding it is:
    // every form below is rejected at the flag boundary and accepted at the
    // env boundary. Tightening `readTaskTimeoutEnv` makes this test fail —
    // which is the signal to delete it.
    for (const v of ['0x10', '1e3', '+300', ' 100 ', '9007199254740993']) {
      expect(parseDecimalInt(v)).toBeNull()
      expect(read(v)).toBeTypeOf('number')
    }
  })
})

// --------------------------------------------------------------------------
// timeout ladder — the env rung reaching a real task
// --------------------------------------------------------------------------

describe('timeout ladder — the env rung in isolation', () => {
  beforeEach(async () => {
    fixture = await makeWorkspace()
    delete process.env['VX_TASK_TIMEOUT']
  })
  afterEach(async () => {
    delete process.env['VX_TASK_TIMEOUT']
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'VX_TASK_TIMEOUT alone bounds a task — no workspace file, no --timeout',
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
      process.env['VX_TASK_TIMEOUT'] = '250'
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
      // Nothing else in the suite asserts that `defineWorkspace({ concurrency })`
      // reaches the scheduler at all — project-loader.test.ts only proves it
      // LOADS, and the CLI tests only prove `--concurrency` parses. Two runs
      // over one fixture: the workspace value alone must serialize two
      // independent tasks, and an explicit option must then override it.
      const config = `export default { tasks: { run: { exec: { command: ${JSON.stringify(SPAN_CMD)} } } } }`
      const a = await addProject(fixture.root, 'a', config)
      const b = await addProject(fixture.root, 'b', config)
      await setWorkspace(fixture.root, 'export default { concurrency: 1 }')

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

  it(
    'the RESOLVED concurrency is also the CPU budget `exec.resources.cpus` packs against',
    async () => {
      // `run.ts` passes the resolved concurrency as `cpuBudget`, so the same
      // ladder governs resource admission. Two tasks reserving an ABSOLUTE
      // `cpus: 2` fit together under a budget of 4 and not under 2 — which
      // means a refactor that resolved concurrency correctly but stopped
      // threading it into `cpuBudget` (or resolved a different value for it)
      // flips one of these two arms. `resources.test.ts` cannot see this: its
      // `cpus: '100%'` is budget-relative and serializes at any budget.
      const config = `export default {
        tasks: {
          run: {
            exec: { command: ${JSON.stringify(SPAN_CMD)}, resources: { cpus: 2 } },
          },
        },
      }`
      const a = await addProject(fixture.root, 'a', config)
      const b = await addProject(fixture.root, 'b', config)
      await setWorkspace(fixture.root, 'export default { concurrency: 2 }')

      const serial = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a', 'b'],
        log: capturingLogger(fixture),
      })
      expect(serial.ok).toBe(true)
      const [first, second] = await spansOf(a, b)
      // budget 2, cost 2+2 → the second parks until the first releases.
      expect(second.s).toBeGreaterThanOrEqual(first.e)

      const parallel = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a', 'b'],
        concurrency: 4,
        log: capturingLogger(fixture),
      })
      expect(parallel.ok).toBe(true)
      const [p1, p2] = await spansOf(a, b)
      // budget 4, cost 2+2 → an exact fill, which admission must allow.
      expect(p2.s).toBeLessThan(p1.e)
    },
    TIMEOUT,
  )
})

// --------------------------------------------------------------------------
// memory ladder
// --------------------------------------------------------------------------

describe('memory ladder — RunOptions.memory > os.totalmem()', () => {
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'RunOptions.memory is the budget `exec.resources.memory` packs against',
    async () => {
      // Absolute reservations, so the arms differ only by the budget: two
      // 600MB tasks exceed a 1GB budget and fit a 2GB one. Dropping
      // `options.memory` falls back to `os.totalmem()` — many GB on any real
      // host — so both tasks would overlap and the first arm fails. `cpus` is
      // undeclared, so the CPU axis is free and cannot explain either result.
      const config = `export default {
        tasks: {
          run: {
            exec: { command: ${JSON.stringify(SPAN_CMD)}, resources: { memory: '600MB' } },
          },
        },
      }`
      const a = await addProject(fixture.root, 'a', config)
      const b = await addProject(fixture.root, 'b', config)

      const serial = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a', 'b'],
        concurrency: 4,
        memory: GiB,
        log: capturingLogger(fixture),
      })
      expect(serial.ok).toBe(true)
      const [first, second] = await spansOf(a, b)
      expect(second.s).toBeGreaterThanOrEqual(first.e)

      const parallel = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a', 'b'],
        concurrency: 4,
        memory: 2 * GiB,
        log: capturingLogger(fixture),
      })
      expect(parallel.ok).toBe(true)
      const [p1, p2] = await spansOf(a, b)
      expect(p2.s).toBeLessThan(p1.e)
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
      // memory, continueMode, flow, outputLogs, tags and command have none.
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
        memory: 4 * GiB,
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

// --------------------------------------------------------------------------
// the wire boundary — where an "absent vs 0" mistake is invisible
// --------------------------------------------------------------------------

describe('RunOptions ⇄ RunRequest — the serialization boundary', () => {
  it('a run-level `retries: 0` SURVIVES the round trip', () => {
    // The mappers gate on `!== undefined`. A truthiness gate (`if (o.retries)`)
    // would drop the 0 here, and a delegated run would silently fall back to
    // whatever default the executing side resolves — the run-level analogue of
    // the `exec.retries: 0` subtlety, one layer out.
    const req = optionsToRequest({ cwd: '/w', tasks: ['build'], retries: 0 })
    expect(req.retries).toBe(0)
    expect(requestToOptions(req).retries).toBe(0)
  })

  it('`concurrency: 0` is REFUSED at the wire rather than hanging the run', () => {
    // This began life as a recorded-not-endorsed pin: the CLI rejects
    // `--concurrency 0` and the workspace loader rejects a non-positive
    // `concurrency`, but the wire did neither — and the scheduler's dispatch
    // loop is `while (active < concurrency)`, which never fires at 0, so
    // `outcomes.size === nodes.size` is never reached and the run's promise
    // NEVER RESOLVES. Reproduced twice out of band: a one-task workspace
    // driven through `requestToOptions({concurrency: 0})` had to be killed at
    // an 8s timeout, and on a serve the submission slot would hang with it.
    //
    // `requestToOptions` now refuses it, because a request is untrusted input
    // and that mapper is the one choke point every executing side goes
    // through. `optionsToRequest` still transmits faithfully — it maps
    // already-validated local options, and making the outbound half lossy
    // would hide a caller's mistake rather than report it.
    const req = optionsToRequest({ cwd: '/w', tasks: ['build'], concurrency: 0 })
    expect(req.concurrency).toBe(0)
    expect(() => requestToOptions(req)).toThrow(/invalid concurrency/)
  })

  it('host-side fields never reach the request, which stays JSON-serializable', () => {
    // `log`, `bus`, `inflight`, `telemetrySinks` and `remoteCache` are live
    // objects the submitting process owns; the executing side rebuilds its
    // own. Projecting one would either travel as a useless `{}` (functions
    // vanish through JSON) or throw on a cycle — both worse than the current
    // "the executing side adds what it needs".
    const sink: TelemetrySink = { onRunSummary() {} }
    const opts: RunOptions = {
      cwd: '/w',
      tasks: ['build'],
      concurrency: 2,
      retries: 1,
      timeout: 5000,
      memory: 512 * MiB,
      log: { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} },
      bus: createEventBus(),
      inflight: new Map(),
      telemetrySinks: [sink],
      handleSignals: false,
    }
    const req = optionsToRequest(opts) as unknown as Record<string, unknown>
    for (const hostOnly of [
      'log',
      'bus',
      'inflight',
      'telemetrySinks',
      'remoteCache',
      'handleSignals',
    ]) {
      expect(Object.hasOwn(req, hostOnly)).toBe(false)
    }
    expect(() => JSON.stringify(req)).not.toThrow()
    // And the knobs that DO belong on the wire survive the JSON hop intact.
    const hopped = JSON.parse(JSON.stringify(req)) as Record<string, unknown>
    expect(hopped['concurrency']).toBe(2)
    expect(hopped['retries']).toBe(1)
    expect(hopped['timeout']).toBe(5000)
    expect(hopped['memory']).toBe(512 * MiB)
  })

  it('`verify.fingerprint` degrades to false when an older client omits it', () => {
    // `RunRequest.verify.fingerprint` is additive-optional so an old submitter
    // interoperates with a new executor. `RunOptions.verify.fingerprint` is
    // required, so the rebuild must supply the safe default rather than
    // `undefined` — an undefined here would read as falsy today but violates
    // the declared type and would surface the first time it is compared.
    const rebuilt = requestToOptions({
      cwd: '/w',
      tasks: ['build'],
      verify: { determinism: true, inputs: false, allow: ['a#b'] },
    })
    expect(rebuilt.verify).toEqual({
      determinism: true,
      inputs: false,
      fingerprint: false,
      allow: new Set(['a#b']),
    })
  })
})
