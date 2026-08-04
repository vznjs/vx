// The Worker that re-evaluates a config's whole IMPORT CLOSURE.
//
// `tests/config-staleness.test.ts` covers this from ABOVE — through
// `loadProjectConfig`, where the first/repeat split lives. This file drives
// `evaluateConfigFresh` DIRECTLY, because the worker is a boundary and every
// boundary property it claims is load-bearing somewhere else:
//
//   * the config crosses as JSON, and `hashTaskConfig` derives the cache key
//     from `JSON.stringify(config)` — so any byte the hop adds, drops or
//     reorders silently changes every cache key (the argument for landing this
//     mechanism with NO CACHE_VERSION bump);
//   * `exec.command` is handed to a shell, so a mangled string runs a
//     DIFFERENT command;
//   * a non-object default must come back as `null` rather than throwing,
//     because the caller owns that error text so it reads identically
//     whichever path produced it;
//   * nothing may leave a caller awaiting forever — `vx watch` has no
//     run-level timeout, so an unsettled await is a permanent hang.
//
// Two defects are pinned here rather than fixed (see the comments at each):
// a rejected evaluation leaves its deadline timer armed, and a deliberately
// huge `VX_CONFIG_WORKER_TIMEOUT_MS` becomes an INSTANT deadline.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { configEvalWorkerCount, evaluateConfigFresh } from '../src/workspace/config-eval.js'
import { loadProjectConfig } from '../src/workspace/project-loader.js'

const BUDGET_ENV = 'VX_CONFIG_WORKER_TIMEOUT_MS'

let root: string
let seq = 0
let savedBudget: string | undefined

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-config-eval-'))
  savedBudget = process.env[BUDGET_ENV]
})

afterEach(async () => {
  // A leaked budget would change every later config load in this process —
  // `bun test` runs the whole suite in ONE process.
  if (savedBudget === undefined) delete process.env[BUDGET_ENV]
  else process.env[BUDGET_ENV] = savedBudget
  await rm(root, { recursive: true, force: true })
})

/** Write a uniquely-named config module and return its absolute path. */
async function write(body: string): Promise<string> {
  const file = path.join(root, `cfg.${seq++}.mjs`)
  await writeFile(file, body)
  return file
}

/** Settle to a plain string so a hang shows up as a comparison, never a throw. */
async function settle(p: Promise<unknown>): Promise<string> {
  return await p.then(
    (v) => `RESOLVED ${JSON.stringify(v)}`,
    (e: unknown) => `REJECTED ${(e as Error).message}`,
  )
}

/**
 * A wedged worker must never outlast the call — assert against a ceiling so a
 * regression reports "HUNG" instead of running out the file's test timeout with
 * no clue which await never settled.
 */
async function settleOrHang(p: Promise<unknown>, ceilingMs: number): Promise<string> {
  return await Promise.race([settle(p), Bun.sleep(ceilingMs).then(() => 'HUNG')])
}

describe('evaluateConfigFresh: what crosses back', () => {
  it('returns the default export, JSON round-tripped', async () => {
    const file = await write(
      `export default { tasks: { build: { exec: { command: 'echo hi' }, dependsOn: ['^build'] } } }\n`,
    )
    expect(await evaluateConfigFresh(file)).toEqual({
      tasks: { build: { exec: { command: 'echo hi' }, dependsOn: ['^build'] } },
    })
  })

  // The contract is `null`, NOT a throw: `loadProjectConfig` runs
  // `assertDefaultObject` on whatever it gets, so both load paths produce the
  // one "did not export a default object" message. A guard that let any of
  // these through as a VALUE would hand the loader a number/function to
  // validate — and a function passes `!mod`, so `export default defineProject`
  // (a real authoring slip) would need a second rejection site.
  const NON_OBJECTS: ReadonlyArray<readonly [string, string]> = [
    ['a number', 'export default 42\n'],
    ['a string', 'export default "echo hi"\n'],
    ['a boolean', 'export default true\n'],
    ['null', 'export default null\n'],
    ['undefined', 'export default undefined\n'],
    ['a function', 'export default function defineProject() {}\n'],
    ['no default export at all', 'export const tasks = {}\n'],
  ]

  for (const [label, body] of NON_OBJECTS) {
    it(`answers null when the config default-exports ${label}`, async () => {
      expect(await evaluateConfigFresh(await write(body))).toBeNull()
    })
  }

  it('passes an array default export through instead of judging it', async () => {
    // Deliberately NOT null: `typeof [] === 'object'`, so the in-process path
    // hands the loader an array too. Whether an array is a valid config is the
    // loader's call; this layer diverging would make the two paths disagree.
    expect(await evaluateConfigFresh(await write('export default [1, {a: 2}]\n'))).toEqual([
      1,
      { a: 2 },
    ])
  })

  it('preserves exotic command strings byte-for-byte', async () => {
    // `exec.command` is executed by a shell. A byte lost or re-encoded at the
    // JSON hop runs a DIFFERENT command than the one on disk — and, because
    // the resolved config feeds the cache key, caches the result under a key
    // derived from text nobody wrote.
    const exotic = {
      emoji: 'echo "🚀 ünïcødé 中文"',
      newline: 'echo a\necho b',
      quotes: `echo "it's \\"quoted\\""`,
      backslash: 'echo C:\\path\\to',
      nul: 'echo a\u0000b',
      loneSurrogate: 'lone\ud800surrogate',
      tab: 'a\tb',
    }
    const file = await write(`export default ${JSON.stringify(exotic)}\n`)
    expect(await evaluateConfigFresh(file)).toEqual(exotic)
  })

  it('preserves key order, which is what keeps the hop hash-neutral', async () => {
    // `hashTaskConfig` hashes `JSON.stringify(config)`, and JSON.stringify
    // emits keys in insertion order — so a worker that rebuilt the object with
    // sorted (or otherwise reordered) keys would change EVERY cache key of
    // every repeat load while every value still compared equal.
    const file = await write(`export default { z: 1, a: 2, m: 3, nested: { y: 1, b: 2 } }\n`)
    expect(JSON.stringify(await evaluateConfigFresh(file))).toBe(
      '{"z":1,"a":2,"m":3,"nested":{"y":1,"b":2}}',
    )
  })

  it('resolves a relative config path before handing it to the worker', async () => {
    // The worker is an inline `data:` URL, which has no base to resolve a
    // relative specifier against — so without the `path.resolve` this rejects
    // with "Cannot find module". Callers reach here via discovery paths that
    // are usually absolute; "usually" is not a contract.
    const abs = await write(`export default { tasks: { a: { exec: { command: 'x' } } } }\n`)
    const rel = path.relative(process.cwd(), abs)
    expect(path.isAbsolute(rel)).toBe(false)
    expect(await evaluateConfigFresh(rel)).toEqual({ tasks: { a: { exec: { command: 'x' } } } })
  })
})

describe('evaluateConfigFresh: import-closure freshness', () => {
  it('observes a preset edited since the last evaluation', async () => {
    // The bug this whole mechanism exists for. Only the PRESET changes — the
    // config's own bytes are untouched, which is exactly what the loader's
    // content-hash bust cannot see, because Bun keys an evaluated module on
    // its RESOLVED specifier and `./preset.mjs` resolves the same every time.
    const preset = path.join(root, 'preset.mjs')
    await writeFile(preset, `export const COMMAND = 'echo v1'\n`)
    const config = await write(
      `import { COMMAND } from './preset.mjs'\n` +
        `export default { tasks: { build: { exec: { command: COMMAND } } } }\n`,
    )

    expect(await evaluateConfigFresh(config)).toEqual({
      tasks: { build: { exec: { command: 'echo v1' } } },
    })

    await writeFile(preset, `export const COMMAND = 'echo v2'\n`)

    expect(await evaluateConfigFresh(config)).toEqual({
      tasks: { build: { exec: { command: 'echo v2' } } },
    })
  })

  it('evaluates a shared preset ONCE per round, and again in the next round', async () => {
    // Both halves of the round contract, measured by a side effect the preset
    // performs on evaluation:
    //   once per round  — the worker is SHARED, so two configs importing one
    //                     preset see it evaluated once, exactly as a fresh
    //                     `vx run` process would (a worker per call would
    //                     double it, and double every preset side effect);
    //   again next round — the worker is RETIRED when the round drains, so the
    //                     next watch cycle starts from an empty registry. If it
    //                     were kept alive, the staleness bug comes straight
    //                     back for every config already imported.
    const log = path.join(root, 'evals.log')
    await writeFile(
      path.join(root, 'preset.mjs'),
      `import { appendFileSync } from 'node:fs'\n` +
        `appendFileSync(${JSON.stringify(log)}, 'x')\n` +
        `export const C = 'v1'\n`,
    )
    const a = await write(
      `import { C } from './preset.mjs'\nexport default { tasks: { a: { c: C } } }\n`,
    )
    const b = await write(
      `import { C } from './preset.mjs'\nexport default { tasks: { b: { c: C } } }\n`,
    )

    const evaluations = async (): Promise<number> => {
      const f = Bun.file(log)
      return (await f.exists()) ? (await f.text()).length : 0
    }

    const before = configEvalWorkerCount()
    await Promise.all([evaluateConfigFresh(a), evaluateConfigFresh(b)])
    expect(await evaluations()).toBe(1)
    expect(configEvalWorkerCount()).toBe(before + 1)

    await Promise.all([evaluateConfigFresh(a), evaluateConfigFresh(b)])
    expect(await evaluations()).toBe(2)
    expect(configEvalWorkerCount()).toBe(before + 2)
  })
})

describe('evaluateConfigFresh: errors cross the boundary', () => {
  // Each case below rejects from inside the WORKER. A rejection clears its own
  // deadline in the `finally`, so nothing is left armed to drain — these used
  // to need an afterEach that slept out the orphaned timer. The budget is still
  // ~25x a real evaluation (~10ms), so it cannot fire first, and if it ever did
  // the assertions below name it rather than passing for the wrong reason.
  const BUDGET = 250

  beforeEach(() => {
    process.env[BUDGET_ENV] = String(BUDGET)
  })

  it('rebuilds the thrown error with its name, message and the config in the stack', async () => {
    // Name and stack are what make a broken config debuggable. The worker hop
    // hands back three strings; dropping the `err.name`/`err.stack` assignment
    // would silently rename every config error to "Error" and point its stack
    // at config-eval.ts, i.e. at vx rather than at the user's file.
    const file = await write(
      `class PresetError extends Error { name = 'PresetError' }\n` +
        `throw new PresetError('preset is not configured')\n`,
    )
    const err = await evaluateConfigFresh(file).then(
      () => new Error('NO THROW'),
      (e: unknown) => e as Error,
    )
    expect(err.name).toBe('PresetError')
    expect(err.message).toBe('preset is not configured')
    expect(err.stack).toContain(path.basename(file))
  })

  it('reports the same name and message an in-process import would', async () => {
    // The repeat path must not change what a user sees for a config that
    // throws — the only difference between the two paths should be WHERE the
    // module was evaluated.
    const body = `throw new TypeError('cannot read config from undefined')\n`
    const viaWorker = await evaluateConfigFresh(await write(body)).then(
      () => null,
      (e: unknown) => e as Error,
    )
    const viaImport = await import(await write(body)).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(viaWorker).not.toBeNull()
    expect(viaImport).not.toBeNull()
    expect([viaWorker?.name, viaWorker?.message]).toEqual([viaImport?.name, viaImport?.message])
    expect(viaWorker?.name).toBe('TypeError')
  })

  const UNSERIALIZABLE: ReadonlyArray<readonly [string, string, RegExp]> = [
    ['a cyclic structure', 'const o = {}\no.self = o\nexport default o\n', /cyclic/i],
    ['a BigInt value', 'export default { size: 1n }\n', /bigint/i],
  ]

  for (const [label, body, expected] of UNSERIALIZABLE) {
    it(`rejects with a usable message when a config contains ${label}`, async () => {
      // A DELIBERATE divergence, worth knowing: both of these evaluate fine
      // in-process and only fail on the repeat path, because JSON.stringify
      // runs inside the worker. What matters is that the throw is caught there
      // and travels back as an error — an uncaught one would post no reply at
      // all and leave the caller waiting out the full deadline.
      const outcome = await settleOrHang(evaluateConfigFresh(await write(body)), 5000)
      expect(outcome).toMatch(/^REJECTED/)
      expect(outcome).toMatch(expected)
    })
  }

  it('names the config file when it cannot be read', async () => {
    // A config deleted mid-session (branch switch, rename) during `vx watch`.
    // The message must point at the file; the path is the only actionable part.
    const file = await write('export default {}\n')
    await rm(file)
    const outcome = await settleOrHang(evaluateConfigFresh(file), 5000)
    expect(outcome).toMatch(/^REJECTED/)
    expect(outcome).toContain(path.basename(file))
  })

  it('settles a mixed round without stranding the sibling or leaking the worker', async () => {
    // One broken config among many is the ordinary watch-cycle shape. The
    // sibling must still resolve, and — the part that matters most — the
    // worker must still be retired: `inFlight--` lives in a `finally`, and if
    // it did not, a single throwing config would pin the counter above zero
    // forever, keep the worker (and its stale registry) alive for the rest of
    // the session, and bring the staleness bug straight back.
    const boom = await write(`throw new Error('kaboom')\n`)
    const good = await write(`export default { tasks: { ok: {} } }\n`)

    const before = configEvalWorkerCount()
    const [bad, fine] = await Promise.all([
      settleOrHang(evaluateConfigFresh(boom), 5000),
      settleOrHang(evaluateConfigFresh(good), 5000),
    ])
    expect(bad).toBe('REJECTED kaboom')
    expect(fine).toBe('RESOLVED {"tasks":{"ok":{}}}')
    expect(configEvalWorkerCount()).toBe(before + 1)

    // The retirement is what this proves: a NEW worker, i.e. a fresh registry.
    await evaluateConfigFresh(good)
    expect(configEvalWorkerCount()).toBe(before + 2)
  })
})

describe('validation stays in the parent process', () => {
  it('reports an identical UserError from the first and the repeat load', async () => {
    // The reason validation was left in `loadProjectConfig` instead of moving
    // into the worker: no error text is marshalled, so a malformed config
    // reads the same on cycle 1 and cycle 9 of a watch session. Name, message
    // and the stack's first line are compared — modulo the config path, which
    // is necessarily different between the two files.
    const bad =
      `export default { tasks: { build: {\n` +
      `  exec: { command: 'echo hi' },\n` +
      `  cache: { inputs: { files: ['src/**'], workspaceFile: ['x'] }, outputs: { files: ['o'] } },\n` +
      `} } }\n`

    const firstFile = await write(bad)
    const firstErr = await loadProjectConfig(firstFile).then(
      () => new Error('NO THROW'),
      (e: unknown) => e as Error,
    )

    // Reaching the repeat path is exactly a watch cycle: load a good config,
    // then break it.
    const repeatFile = await write(
      `export default { tasks: { build: { exec: { command: 'x' } } } }\n`,
    )
    await loadProjectConfig(repeatFile)
    await writeFile(repeatFile, bad)
    const repeatErr = await loadProjectConfig(repeatFile).then(
      () => new Error('NO THROW'),
      (e: unknown) => e as Error,
    )

    const scrub = (s: string, file: string): string => s.split(file).join('<CONFIG>')
    expect(firstErr.message).toMatch(/cache\.inputs has unknown field "workspaceFile"/)
    expect(scrub(repeatErr.message, repeatFile)).toBe(scrub(firstErr.message, firstFile))
    expect(repeatErr.name).toBe(firstErr.name)
    expect(repeatErr.name).toBe('UserError')

    // The `.stack` first line is deliberately NOT compared. It looks like a
    // free third signal, but it pins the RUNTIME rather than vx: under memory
    // pressure JSC hands back a truncated `"Error"` where it normally returns
    // `"UserError: <message>"`, so the two paths disagree for a reason that
    // has nothing to do with either of them. Reproduced by running this file
    // against the memory suite — roughly one run in six, and it redded CI once
    // before it was understood.
    //
    // Nothing is lost: `name` and `message` ARE vx's own data, and they carry
    // the whole contract this test exists for — a malformed config reads the
    // same on cycle 1 and cycle 9 of a watch session.
  })

  it('only rejects a typo whose value JSON drops on the FIRST load', async () => {
    // KNOWN DIVERGENCE, pinned rather than fixed. Unknown-field rejection walks
    // `Object.keys`, and `JSON.stringify` drops keys whose value is `undefined`
    // — so `workspaceFile: undefined` is a hard error in-process and invisible
    // through the worker. Benign for the cache key (an undefined value hashes
    // as absent either way, so there is no stale hit), but it does mean a
    // config can fail cycle 1 of `vx watch` and pass cycle 2 unchanged.
    const bad =
      `export default { tasks: { build: {\n` +
      `  exec: { command: 'echo hi' },\n` +
      `  cache: { inputs: { files: ['src/**'], workspaceFile: undefined }, outputs: { files: ['o'] } },\n` +
      `} } }\n`

    const firstFile = await write(bad)
    await expect(loadProjectConfig(firstFile)).rejects.toThrow(/unknown field "workspaceFile"/)

    const repeatFile = await write(
      `export default { tasks: { build: { exec: { command: 'x' } } } }\n`,
    )
    await loadProjectConfig(repeatFile)
    await writeFile(repeatFile, bad)
    const config = await loadProjectConfig(repeatFile)
    expect(config.tasks?.build?.cache?.inputs).toEqual({ files: ['src/**'] })
  })
})

describe('the evaluation deadline', () => {
  const HANG = 'await new Promise(() => {})\nexport default {}\n'

  it('rejects a wedged worker instead of awaiting it forever, then recovers', async () => {
    // Nothing else bounds this await — there is no run-level timeout — so a
    // worker the OS kills under memory pressure, or one that simply never
    // replies, would stall `vx watch` permanently on a cycle that normally
    // takes milliseconds. Driving the budget down asserts the real rejection
    // instead of the existence of a constant; without the deadline this test
    // does not fail, it HANGS, which is the point.
    process.env[BUDGET_ENV] = '250'
    const wedged = await settleOrHang(evaluateConfigFresh(await write(HANG)), 5000)
    expect(wedged).toBe('REJECTED config worker did not answer within 250ms')

    // Recovery is the other half: the timeout path nulls the worker handle, so
    // the next cycle builds a fresh one. If it did not, one hiccup would wedge
    // every later config load for the life of the process.
    const after = await settleOrHang(
      evaluateConfigFresh(await write('export default { tasks: { ok: {} } }\n')),
      5000,
    )
    expect(after).toBe('RESOLVED {"tasks":{"ok":{}}}')
  }, 15_000)

  it('rejects the whole wedged round at the FIRST deadline, not each at its own', async () => {
    // A watch cycle loads its configs concurrently and they share one worker,
    // so terminating that worker makes every sibling unanswerable — they must
    // be rejected then and there rather than left pending until their own
    // deadlines elapse (a single unsettled promise inside `Promise.all` hangs
    // the cycle exactly as the no-deadline case did).
    //
    // The two budgets are deliberately far apart so this discriminates: the
    // second call cannot settle by its own timer inside the ceiling below, so
    // a pass proves the first call's timeout rejected it.
    process.env[BUDGET_ENV] = '200'
    const first = evaluateConfigFresh(await write(HANG))
    process.env[BUDGET_ENV] = '800'
    const second = evaluateConfigFresh(await write(HANG))

    const outcomes = await Promise.all([settleOrHang(first, 5000), settleOrHang(second, 500)])
    // Both name the budget of whichever call timed out FIRST — the sibling's
    // own 800ms budget never applied to it.
    for (const o of outcomes) expect(o).toBe('REJECTED config worker did not answer within 200ms')
  }, 15_000)

  const MALFORMED = ['abc', '', ' 250', '-5', '1e3', '25.0']

  for (const raw of MALFORMED) {
    it(`ignores a malformed budget ${JSON.stringify(raw)} instead of deadlining instantly`, async () => {
      // The digits-only guard is load-bearing: `Number('abc')` is NaN and
      // `setTimeout(fn, NaN)` fires on the next tick, so dropping the regex
      // would turn any typo in this env var into "every repeat config load
      // fails with a timeout" — including the empty-string case a shell
      // produces from `VX_CONFIG_WORKER_TIMEOUT_MS=$UNSET`.
      process.env[BUDGET_ENV] = raw
      const file = await write('export default { tasks: { ok: {} } }\n')
      expect(await settleOrHang(evaluateConfigFresh(file), 5000)).toBe(
        'RESOLVED {"tasks":{"ok":{}}}',
      )
    }, 15_000)
  }

  // DEFECT PIN (current behaviour, not desired behaviour).
  //
  // `0` and any value past 2^31-1 both deadline INSTANTLY, so the two values a
  // user reaches for to disable the deadline are the two that break every
  // repeat config load:
  //   * `0` is "fire on the next tick", not "no deadline" — while elsewhere in
  //     this project 0 does mean never (`vx-cloud agent --idle-timeout 0`);
  //   * `999999999999` overflows setTimeout's 32-bit delay, which Bun clamps to
  //     1ms (printing a TimeoutOverflowWarning), and then reports the failure
  //     as "did not answer within 999999999999ms" — a message that cannot be
  //     true and points nowhere near the cause.
  // A clamp (and treating 0 as "no deadline") belongs in workerTimeoutMs.
  it('deadlines instantly on 0 \u2014 DEFECT, still pinned', async () => {
    // STILL A DEFECT, and deliberately left as one: `0` is a SEPARATE mechanism
    // from the 32-bit ceiling below, and its repair is a real design question
    // rather than a clamp. Treating `0` as "no deadline" would match this
    // project's other zero (`vx-cloud agent --idle-timeout 0` = never) \u2014 but it
    // would also let a wedged worker hang `vx watch` forever, which is the
    // exact failure this deadline was added to prevent. That tension needs
    // settling before the behaviour moves; pinned meanwhile so it cannot drift.
    process.env[BUDGET_ENV] = '0'
    const file = await write('await Bun.sleep(400)\nexport default { tasks: { ok: {} } }\n')
    const started = Date.now()
    const outcome = await settleOrHang(evaluateConfigFresh(file), 5000)
    expect(outcome).toBe('REJECTED config worker did not answer within 0ms')
    expect(Date.now() - started).toBeLessThan(300)
  }, 15_000)

  it('a budget past the timer ceiling falls back instead of firing at 1ms', async () => {
    // FIXED. Unbounded, `999999999999` overflowed the timer's 32-bit delay to
    // 1ms and then reported "did not answer within 999999999999ms" \u2014 a message
    // that cannot be true and points nowhere near the cause. Every repeat config
    // load failed, which breaks `vx watch`, the only path that reaches this.
    //
    // It falls back to the 30s default rather than clamping to ~24.8 days: this
    // is a BOUND on a worker that may be wedged, not a duration the caller is
    // choosing, so honouring the huge value would hang the watch loop forever.
    process.env[BUDGET_ENV] = '999999999999'
    const file = await write('await Bun.sleep(400)\nexport default { tasks: { ok: {} } }\n')
    const started = Date.now()
    const outcome = await settleOrHang(evaluateConfigFresh(file), 5000)
    // The ~400ms config now finishes, because the honest budget is 30s.
    expect(String(outcome)).not.toContain('did not answer within')
    expect(Date.now() - started).toBeGreaterThanOrEqual(300)
  }, 15_000)

  it('a REJECTED evaluation does not poison a later one', async () => {
    // `clearTimeout` used to sit after the `await` inside the try body, so it
    // was skipped whenever the evaluation REJECTED — leaving the timer armed
    // for its whole budget. When that orphan fired it ran `rejectAll()` and
    // terminated whatever worker was current AT THAT MOMENT, which by then
    // belonged to an unrelated, healthy round.
    //
    // The shape that matters: fix a typo during `vx watch` and the failed load
    // left a timer armed for the DEFAULT 30s; a cycle up to 30 seconds later
    // could die with "config worker did not answer within 30000ms" — naming a
    // budget nobody set for it, for a config that was fine.
    process.env[BUDGET_ENV] = '250'
    const broken = await write(`throw new Error('typo in preset')\n`)
    expect(await settleOrHang(evaluateConfigFresh(broken), 5000)).toBe('REJECTED typo in preset')

    // A healthy config with a generous budget of its own, deliberately still in
    // flight when the previous round's timer WOULD have fired (250ms). It must
    // resolve on its own terms.
    process.env[BUDGET_ENV] = '4000'
    const slow = await write('await Bun.sleep(600)\nexport default { tasks: { ok: {} } }\n')
    expect(await settleOrHang(evaluateConfigFresh(slow), 5000)).toBe('RESOLVED {"tasks":{"ok":{}}}')
  }, 15_000)
})
