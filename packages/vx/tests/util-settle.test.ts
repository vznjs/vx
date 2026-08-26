// `settleWithin` is the deadline that stops a hung plugin turning a RED run
// GREEN. CLAUDE.md 2026-07-27: `TelemetrySource.flush` had no bound, run()
// awaits it before closeCache() and before it returns, and bin.ts is
// `process.exit(await run(...))` — so a never-returning flush let Bun drain an
// empty event loop and exit 0 on a run that printed `failed (exit 3)`. Its two
// production callers (orchestrator/plugin-host.ts:149,159 and
// orchestrator/telemetry.ts:423) sit on that exact path.
//
// Four properties are load-bearing, and each has its own block:
//
//   1. A REJECTION PROPAGATES. plugin-host wraps the call in try/catch to
//      warn "flush failed"; telemetry reads the boolean to warn "flush timed
//      out". If a rejection were swallowed into `false`, a plugin that threw
//      would be reported as a plugin that hung — the wrong diagnosis, and the
//      wrong sentence in front of a user.
//   2. THE BOOLEAN MEANS WHAT IT SAYS. `p.then(() => true)` maps any
//      resolution to `true` before the `!== false` test, so a flush that
//      resolves the VALUE `false` is still "settled". Racing `p` raw would
//      report that flush as a timeout and claim records were lost that were
//      not.
//   3. THE TIMER NEVER OUTLIVES THE CALL. The repo bans non-unref'd timers —
//      it is why `AbortSignal.timeout` is refused here and in the cloud fetch
//      paths. The timer is armed EAGERLY (the `new Promise` executor runs
//      synchronously), so even the instant-resolve path arms one, and only
//      the `finally` stops it holding the loop open for the full budget.
//   4. NOTHING HANGS. Whatever `ms` it is handed, the call returns. A
//      deadline primitive that can itself hang is worse than no deadline.

import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { settleWithin, teardownTimeoutMs } from '../src/util/settle.js'
import { MAX_TIMEOUT_MS } from '../src/util/num.js'

/** The documented fallback, restated here so a change to it fails loudly. */
const DEFAULT_TEARDOWN_MS = 3000
// Both production callers reach these through the module CONTRACT (see
// tests/module-boundaries.test.ts), so the barrel re-export is part of the
// surface under test, not an implementation detail.
import {
  settleWithin as settleViaBarrel,
  teardownTimeoutMs as teardownViaBarrel,
} from '../src/util/index.js'

const ENV = 'VX_TEARDOWN_TIMEOUT_MS'

/** A promise that never settles — the production symptom being bounded. */
const never = <T = void>(): Promise<T> => new Promise<T>(() => {})
const resolveAfter = <T>(ms: number, value: T): Promise<T> =>
  new Promise<T>((resolve) => setTimeout(resolve, ms, value))

/** Set the env exactly as a shell would, then read the bound back. */
function timeoutFor(raw: string | undefined): number {
  if (raw === undefined) delete process.env[ENV]
  else process.env[ENV] = raw
  return teardownTimeoutMs()
}

// Bun runs every test FILE sequentially in one process (CLAUDE.md 2026-07-19),
// so a leaked env var would silently re-time a later suite's deadlines.
let originalEnv: string | undefined
beforeAll(() => {
  originalEnv = process.env[ENV]
})
afterAll(() => {
  if (originalEnv === undefined) delete process.env[ENV]
  else process.env[ENV] = originalEnv
})

describe('settleWithin — the promise wins', () => {
  it('returns true for a promise that has already resolved', async () => {
    expect(await settleWithin(Promise.resolve(), 50)).toBe(true)
  })

  it('returns true for a promise that resolves inside the budget', async () => {
    const started = Date.now()
    expect(await settleWithin(resolveAfter(10, undefined), 80)).toBe(true)
    // Proves it returned on the promise, not by waiting the budget out.
    expect(Date.now() - started).toBeLessThan(70)
  })

  // THE sharpest value case. `p.then(() => true)` exists precisely so the
  // `!== false` test never sees the caller's own payload. Racing `p` raw
  // (`Promise.race([p, deadline])`) — a tempting simplification, since the
  // value is discarded anyway — reports this flush as a TIMEOUT: verified,
  // that variant returns false here. telemetry.ts would then warn "buffered
  // records lost" about a sink that flushed perfectly.
  it('treats a promise resolving to the VALUE false as settled', async () => {
    expect(await settleWithin(Promise.resolve(false), 50)).toBe(true)
  })

  // Same trap, one step removed: every falsy resolution must read as settled.
  it('treats every falsy resolution as settled', async () => {
    for (const value of [false, undefined, null, 0, -0, '', Number.NaN]) {
      expect(await settleWithin(Promise.resolve(value), 50)).toBe(true)
    }
  })

  // The contract is a boolean, never the payload — both call sites discard
  // the resolution (plugin-host ignores the return entirely; telemetry only
  // reads `settled`). Pinned so a future "return the value" convenience
  // cannot quietly change what `!settled` means.
  it('reports settlement as a plain boolean, discarding the resolved value', async () => {
    const outcome = await settleWithin(Promise.resolve({ records: 42 }), 50)
    expect(outcome).toBe(true)
    expect(typeof outcome).toBe('boolean')
  })
})

describe('settleWithin — the deadline wins', () => {
  it('returns false for a promise that never settles', async () => {
    const started = Date.now()
    expect(await settleWithin(never(), 50)).toBe(false)
    const elapsed = Date.now() - started
    // Lower bound proves the deadline was actually armed for the budget
    // rather than firing instantly; upper bound proves it gave up at all.
    expect(elapsed).toBeGreaterThanOrEqual(35)
    expect(elapsed).toBeLessThan(5000)
  }, 10_000)

  it('returns false for a promise that settles just past the budget', async () => {
    expect(await settleWithin(resolveAfter(80, undefined), 20)).toBe(false)
  })

  // A late rejection is the nastiest shape: the race is already settled, so
  // the reason has nowhere to go. The call must have ALREADY returned false
  // and must not reject afterwards — an implementation that awaited `p` again
  // (a plausible "make sure we don't leak it" edit) would reject here instead.
  it('stays false when the promise REJECTS after the deadline', async () => {
    let unhandled = 0
    const count = (): void => {
      unhandled++
    }
    process.on('unhandledRejection', count)
    try {
      const late = new Promise<void>((_resolve, reject) => {
        setTimeout(() => reject(new Error('late boom')), 60)
      })
      expect(await settleWithin(late, 20)).toBe(false)
      // Outlive the rejection so an unhandled one would have surfaced.
      await Bun.sleep(90)
      expect(unhandled).toBe(0)
    } finally {
      process.off('unhandledRejection', count)
    }
  }, 10_000)
})

describe('settleWithin — a rejection propagates, it is not a timeout', () => {
  // The single most important discriminator in this file. A `.catch(() => false)`
  // on the mapped promise — the obvious way to make an "observability must
  // never break a run" primitive never throw — returns false here instead of
  // throwing (verified). plugin-host.ts:150 would then never warn "flush
  // failed", and telemetry.ts:436 would blame a deadline for a crash.
  it('rejects with the original error rather than resolving false', async () => {
    const boom = new Error('sink exploded')
    await expect(settleWithin(Promise.reject(boom), 50)).rejects.toThrow(boom)
  })

  it('propagates a rejection that lands inside the budget', async () => {
    const late = new Promise<void>((_resolve, reject) => {
      setTimeout(() => reject(new Error('slow explosion')), 10)
    })
    await expect(settleWithin(late, 80)).rejects.toThrow(/slow explosion/)
  })

  // plugin-host.ts:152 renders the reason as `err instanceof Error ?
  // err.message : String(err)`, so a non-Error reason must arrive intact —
  // wrapping it (or coercing it to an Error) would change the warning a user
  // reads. Identity, not just shape, because a thrown object is often the
  // diagnostic payload.
  it('preserves the rejection reason by identity, whatever its type', async () => {
    const reasons: unknown[] = ['plain string', undefined, null, 0, false, { code: 'ETIMEDOUT' }]
    for (const reason of reasons) {
      let caught: unknown
      let threw = false
      try {
        await settleWithin(Promise.reject(reason), 50)
      } catch (err) {
        threw = true
        caught = err
      }
      expect({ reason, threw }).toEqual({ reason, threw: true })
      expect(caught).toBe(reason)
    }
  })

  // A rejection must not be mistaken for a hang: the call has to unwind
  // immediately, not sit on the budget first.
  it('unwinds a rejection immediately, not after the budget', async () => {
    const started = Date.now()
    await expect(settleWithin(Promise.reject(new Error('x')), 5000)).rejects.toThrow('x')
    expect(Date.now() - started).toBeLessThan(1000)
  }, 10_000)
})

describe('settleWithin — the timer never outlives the call', () => {
  // The property the repo's standing "no non-unref'd timers" rule is about,
  // proven where it actually bites: in a fresh process, where a pending timer
  // is the only thing left holding the event loop open. Measured: the shipped
  // code exits in ~35ms; deleting `clearTimeout(timer)` makes the same script
  // take the FULL 3000ms budget before the process can exit. A subprocess is
  // required — process-exit liveness is not observable from inside.
  it('does not hold a fresh process open for the unused budget', async () => {
    const src = path.join(import.meta.dir, '..', 'src', 'util', 'settle.ts')
    const script =
      `const { settleWithin } = await import(${JSON.stringify(src)});` +
      `await settleWithin(Promise.resolve(), 3000);` +
      `process.stdout.write('done')`
    const started = Date.now()
    const proc = Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'pipe' })
    const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
    const elapsed = Date.now() - started
    expect({ code, out }).toEqual({ code: 0, out: 'done' })
    // Generous margin over the ~35ms measured, far under the 3000ms budget an
    // uncleared timer would impose.
    expect(elapsed).toBeLessThan(1500)
  }, 30_000)

  // The in-process half: precise, and it pins that exactly ONE timer is armed
  // (not one per race arm) and that its handle is the one cleared.
  it('clears the very handle it armed, even when the promise wins instantly', async () => {
    const realSetTimeout = globalThis.setTimeout
    const realClearTimeout = globalThis.clearTimeout
    const armed: unknown[] = []
    const cleared: unknown[] = []
    try {
      globalThis.setTimeout = ((fn: () => void, ms?: number) => {
        const handle = realSetTimeout(fn, ms)
        armed.push(handle)
        return handle
      }) as typeof globalThis.setTimeout
      globalThis.clearTimeout = ((handle: unknown) => {
        cleared.push(handle)
        return realClearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0])
      }) as typeof globalThis.clearTimeout

      expect(await settleWithin(Promise.resolve(), 5000)).toBe(true)
    } finally {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
    }

    // Eagerly armed: the `new Promise` executor runs synchronously, so the
    // fast path is exactly where an uncleared timer does its damage.
    expect(armed).toHaveLength(1)
    expect(cleared).toContain(armed[0])
  })

  // The `finally` must run on the throwing path too, or a plugin that fails
  // fast leaves a live timer behind for every task in the run.
  it('clears the handle when the promise rejects', async () => {
    const realClearTimeout = globalThis.clearTimeout
    let cleared = 0
    try {
      globalThis.clearTimeout = ((handle: unknown) => {
        cleared++
        return realClearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0])
      }) as typeof globalThis.clearTimeout
      await expect(settleWithin(Promise.reject(new Error('boom')), 5000)).rejects.toThrow('boom')
    } finally {
      globalThis.clearTimeout = realClearTimeout
    }
    expect(cleared).toBeGreaterThanOrEqual(1)
  })
})

describe('settleWithin — every call gets its own budget', () => {
  // telemetry.ts:422 states the property for the sinks racing INSIDE one
  // call; plugin-host.ts:146-165 relies on the sibling property, awaiting one
  // `settleWithin` per sink and per plugin in sequence. Either way a wedged
  // neighbour must not spend anyone else's budget.
  it('runs three concurrent deadlines in parallel, not in series', async () => {
    const started = Date.now()
    const outcomes = await Promise.all([
      settleWithin(never(), 60),
      settleWithin(never(), 60),
      settleWithin(never(), 60),
    ])
    const elapsed = Date.now() - started
    expect(outcomes).toEqual([false, false, false])
    // One shared timer would still be ~60ms; three SERIALISED budgets would
    // be ~180ms. Measured 61ms.
    expect(elapsed).toBeGreaterThanOrEqual(35)
    expect(elapsed).toBeLessThan(150)
  }, 10_000)

  // A short deadline firing must not cancel a longer one running beside it —
  // i.e. the timer is per-call state, never module state.
  it('a neighbouring timeout does not cut short a slower healthy promise', async () => {
    const [timedOut, settled] = await Promise.all([
      settleWithin(resolveAfter(60, undefined), 20),
      settleWithin(resolveAfter(60, undefined), 95),
    ])
    expect({ timedOut, settled }).toEqual({ timedOut: false, settled: true })
  }, 10_000)

  it('a rejecting neighbour does not disturb a concurrent healthy call', async () => {
    const healthy = settleWithin(resolveAfter(20, undefined), 90)
    const failing = settleWithin(Promise.reject(new Error('neighbour')), 90)
    await expect(failing).rejects.toThrow('neighbour')
    expect(await healthy).toBe(true)
  }, 10_000)
})

describe('settleWithin — hostile budgets', () => {
  // With `ms = 0` the timer is a MACROtask while `p.then(...)` is a
  // microtask, so an already-settled promise still wins. That is the right
  // way round: a zero budget must not discard work that is already done.
  it('still reports an already-resolved promise as settled at ms = 0', async () => {
    expect(await settleWithin(Promise.resolve(), 0)).toBe(true)
  })

  it('gives up at ms = 0 on anything not already settled', async () => {
    expect(await settleWithin(never(), 0)).toBe(false)
    expect(await settleWithin(resolveAfter(30, undefined), 0)).toBe(false)
  })

  // The whole point of the primitive: no budget value can make it hang. A
  // negative or NaN delay is clamped to 1ms by the timer implementation (Bun
  // prints a TimeoutNegativeWarning / TimeoutNaNWarning to stderr, which is
  // the noise below and not a failure), so the deadline still fires.
  it('never hangs on a negative or NaN budget', async () => {
    expect(await settleWithin(never(), -5)).toBe(false)
    expect(await settleWithin(never(), Number.NaN)).toBe(false)
  }, 10_000)

  // FINDING (see src/util/settle.ts:25, reachable via teardownTimeoutMs).
  // A delay of 2^31 or more does not fit a 32-bit signed int, so the timer
  // silently clamps it to ONE MILLISECOND — the tightest possible deadline,
  // the exact inverse of the request. `VX_TEARDOWN_TIMEOUT_MS=99999999999`
  // ("give the flush all the time it needs") therefore makes every flush time
  // out and every buffered telemetry record get dropped, with only a
  // "flush timed out" warning to show for it. Pinned as CURRENT behaviour.
  it('silently collapses a 2^31-or-larger budget to ~1ms (documented defect)', async () => {
    const started = Date.now()
    expect(await settleWithin(never(), 2 ** 31)).toBe(false)
    // 2^31 ms is ~25 days; anything under a second proves the clamp.
    expect(Date.now() - started).toBeLessThan(1000)
  }, 10_000)

  it('the last budget that behaves as written is 2^31 - 1, and it IS enforced', () => {
    // Boundary statement, not a wait: 2147483647 is honoured (~24 days) while
    // 2147483648 collapses to 1ms at the timer. `teardownTimeoutMs` now refuses
    // to hand out anything past the ceiling.
    expect(MAX_TIMEOUT_MS).toBe(2147483647)
    expect(timeoutFor('2147483647')).toBe(2147483647)
    expect(timeoutFor('2147483648')).toBe(DEFAULT_TEARDOWN_MS)
  })
})

describe('teardownTimeoutMs — the default', () => {
  it('is 3000ms when the env var is unset', () => {
    expect(timeoutFor(undefined)).toBe(3000)
  })

  // A CI job exporting an EMPTY value (an unset shell variable expanded into
  // `VX_TEARDOWN_TIMEOUT_MS=$SOMETHING`) must fall back to the default, not to
  // Number('') === 0, which would give every flush a zero budget.
  it('falls back to the default for an empty or blank value', () => {
    expect(Number('')).toBe(0) // the divergence this guards must still exist
    expect(timeoutFor('')).toBe(3000)
    expect(timeoutFor(' ')).toBe(3000)
    expect(timeoutFor('\n')).toBe(3000)
  })

  // The docstring promises the bound is "read per call so a test can drive
  // the deadline". Caching it at module scope would break every suite that
  // sets the env after import — including tests/telemetry-lifecycle.test.ts,
  // whose hung-flush case would then wait out the real 3000ms default.
  it('re-reads the env on every call', () => {
    expect(timeoutFor('11')).toBe(11)
    expect(timeoutFor('22')).toBe(22)
    expect(timeoutFor(undefined)).toBe(3000)
  })
})

describe('teardownTimeoutMs — accepted values', () => {
  it('parses a plain decimal', () => {
    expect(timeoutFor('250')).toBe(250)
    expect(timeoutFor('3000')).toBe(3000)
  })

  // Zero is a legal, meaningful budget — "do not wait for anything that is
  // not already done" — so a `Number(raw) || DEFAULT` style guard would be
  // wrong. It is also the fastest way to drive the timeout path in a test.
  it('accepts 0 rather than treating it as absent', () => {
    expect(timeoutFor('0')).toBe(0)
    expect(timeoutFor('0')).not.toBe(3000)
  })

  it('reads leading zeros as decimal, never octal', () => {
    expect(timeoutFor('007')).toBe(7)
    expect(timeoutFor('0250')).toBe(250)
  })
})

// Every row below is a value `Number()` converts to something plausible but
// WRONG. The regex is the only thing between them and a timer delay, and the
// failure is silent in both directions: a rejected value falls back to 3000
// (a run that pauses three seconds longer than the operator asked), an
// accepted junk value becomes a delay nobody chose.
describe('teardownTimeoutMs — rejects what Number() silently accepts', () => {
  const silentlyAccepted: Array<{ raw: string; via: number; why: string }> = [
    { raw: '-1', via: -1, why: 'negative — a timer clamped to 1ms, i.e. no budget' },
    { raw: '-0', via: -0, why: 'negative zero' },
    { raw: '+250', via: 250, why: 'explicit plus' },
    { raw: '2.5', via: 2.5, why: 'fraction' },
    { raw: '250.0', via: 250, why: 'fraction that IS an integer' },
    { raw: '1e3', via: 1000, why: 'exponent' },
    { raw: '0x10', via: 16, why: 'hex — 16ms, not the 0x10 the author pictured' },
    { raw: '0b11', via: 3, why: 'binary literal' },
    { raw: '0o17', via: 15, why: 'octal literal' },
    { raw: 'Infinity', via: Number.POSITIVE_INFINITY, why: 'an unbounded delay' },
    { raw: ' 250', via: 250, why: 'leading space' },
    { raw: '250 ', via: 250, why: 'trailing space' },
    { raw: '250\n', via: 250, why: 'trailing newline — a piped `echo 250`' },
    { raw: '\t250', via: 250, why: 'leading tab' },
    { raw: ' 250', via: 250, why: 'NBSP, invisible — copy-pasted from a doc' },
    { raw: '﻿250', via: 250, why: 'BOM from a UTF-8-with-BOM env file' },
  ]

  for (const { raw, via, why } of silentlyAccepted) {
    it(`falls back to 3000 for ${JSON.stringify(raw)} (Number() → ${via}: ${why})`, () => {
      // The divergence this row guards must still exist.
      expect(Number(raw)).toBe(via)
      expect(timeoutFor(raw)).toBe(3000)
    })
  }

  // JS `\d` is ASCII-only outside /u, and so is Number() — both halves reject
  // in the same direction, so a locale-typed digit can never become a delay.
  it('treats non-ASCII digits as non-numeric on both halves', () => {
    for (const raw of ['٤٢', '２５０', '৪']) {
      expect(Number(raw)).toBeNaN()
      expect(timeoutFor(raw)).toBe(3000)
    }
  })

  it('falls back for structural junk without throwing', () => {
    for (const raw of [
      'abc',
      '250abc',
      '1_000',
      '1,000',
      '250 250',
      '250 ', // NUL — the classic truncate-and-accept vector
      '2​50', // zero-width space is NOT whitespace for Number()
      '\ud800', // lone surrogate
      'NaN',
    ]) {
      expect(timeoutFor(raw)).toBe(3000)
    }
  })

  // Without the `m` flag JS `$` matches only at end of input, so a trailing
  // line cannot be smuggled past the anchor and silently discarded.
  it('anchors the whole string, so an embedded newline cannot smuggle a tail', () => {
    expect(timeoutFor('250\n500')).toBe(3000)
    expect(timeoutFor('250\nrm -rf /')).toBe(3000)
  })
})

describe('teardownTimeoutMs — the upper end is bounded', () => {
  // These three began as FINDINGs pinning an UNBOUNDED upper end, where a
  // digit string past 2^53 silently rounded and 400 nines became Infinity.
  // That was "harmless" only because the timer then clamped the result to 1ms
  // — which is the defect, not the mitigation: every flush deadlined instantly
  // and every buffered record was dropped.
  //
  // Out-of-range now falls back to the DEFAULT rather than clamping to
  // MAX_TIMEOUT_MS, and the difference is the whole point. This value is a
  // BOUND, not a duration: there is no "no limit" reading, because the deadline
  // exists precisely so a plugin's flush cannot hold the run's exit hostage.
  // Clamping would honour "wait ~24.8 days" and hang the run — trading an
  // instant-timeout defect for a hang, which is worse.
  it('a value too large to survive Number() intact falls back', () => {
    expect(Number('9007199254740993')).toBe(9007199254740992)
    expect(timeoutFor('9007199254740993')).toBe(DEFAULT_TEARDOWN_MS)
  })

  it('an absurdly long digit string falls back instead of overflowing to Infinity', () => {
    expect(timeoutFor('9'.repeat(400))).toBe(DEFAULT_TEARDOWN_MS)
  })

  // The composed contract the two production callers rely on. Asserted as a
  // PROPERTY of the whole output range rather than by waiting each budget out:
  // every answer is a finite number within the timer's honoured range, which is
  // what makes both failure modes — instant deadline and unbounded hang —
  // unreachable. One real drive proves the composition still works.
  it('never yields a budget that can hang OR fire instantly', async () => {
    for (const raw of ['0', '1', '250', '2147483648', '9007199254740993', '9'.repeat(400)]) {
      const ms = timeoutFor(raw)
      expect({
        raw,
        finite: Number.isFinite(ms),
        inRange: ms >= 0 && ms <= MAX_TIMEOUT_MS,
      }).toEqual({ raw, finite: true, inRange: true })
    }
    const started = Date.now()
    expect(await settleWithin(never(), timeoutFor('120'))).toBe(false)
    expect(Date.now() - started).toBeLessThan(2000)
  }, 20_000)
})

describe('call-site contracts', () => {
  it('the barrel re-exports the same functions production imports', () => {
    // plugin-host.ts and telemetry.ts import from '../util/index.js'; a
    // barrel exporting a different symbol would make this file vacuous for
    // the paths that actually ship.
    expect(settleViaBarrel).toBe(settleWithin)
    expect(teardownViaBarrel).toBe(teardownTimeoutMs)
  })

  // plugin-host.ts:149 is `await settleWithin(Promise.resolve(sink.flush()), …)`
  // inside a try/catch. `Promise.resolve(fn())` does NOT convert a SYNCHRONOUS
  // throw into a rejection — the throw happens while evaluating the argument,
  // before settleWithin is entered. That is safe here only because the catch
  // is on the outside; pinned with the timer spy to prove no deadline is left
  // armed when the call is never made.
  it('a sink throwing synchronously never reaches settleWithin, and arms no timer', async () => {
    const realSetTimeout = globalThis.setTimeout
    let armed = 0
    let caught: unknown
    try {
      globalThis.setTimeout = ((fn: () => void, ms?: number) => {
        armed++
        return realSetTimeout(fn, ms)
      }) as typeof globalThis.setTimeout

      const flush = (): void => {
        throw new Error('sync explosion')
      }
      try {
        await settleWithin(Promise.resolve(flush()), 5000)
      } catch (err) {
        caught = err
      }
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('sync explosion')
    expect(armed).toBe(0)
  })

  // telemetry.ts:425 wraps each sink in `async (sink) => { try { await
  // sink.flush() } catch {} }`, which DOES convert a sync throw into a caught
  // rejection — so that path can only ever settle or time out, never reject.
  // Its `if (!settled)` warning is only accurate because of that.
  it('the telemetry wrapper shape converts a sync throw into a settled flush', async () => {
    const sinks = [
      {
        flush: (): void => {
          throw new Error('sync explosion')
        },
      },
      { flush: async (): Promise<void> => Bun.sleep(5) },
    ]
    const settled = await settleWithin(
      Promise.all(
        sinks.map(async (sink) => {
          try {
            await sink.flush()
          } catch {
            // a sink's flush failure can never break the run
          }
        }),
      ),
      80,
    )
    expect(settled).toBe(true)
  })

  // The same shape with one WEDGED sink: the healthy sibling still finishes
  // its work inside the shared budget, and the call reports a timeout so the
  // "buffered records lost" warning is earned rather than guessed.
  it('reports a timeout when one sink in a Promise.all wedges', async () => {
    let healthyFlushed = false
    const settled = await settleWithin(
      Promise.all([
        never(),
        (async () => {
          await Bun.sleep(10)
          healthyFlushed = true
        })(),
      ]),
      60,
    )
    expect({ settled, healthyFlushed }).toEqual({ settled: false, healthyFlushed: true })
  }, 10_000)

  // NOT pinned, deliberately: the parameter is `Promise<unknown>`, and the
  // `finally` calls `p.catch(...)` — which a bare PromiseLike does not have,
  // so widening the signature would make the CLEANUP path throw a TypeError
  // over an otherwise-successful settle. It stays a type-level guarantee
  // because a fixture for it needs a `then` member, which unicorn/no-thenable
  // forbids on exactly the reasoning that makes the hazard real. Both call
  // sites already wrap in `Promise.resolve(...)`; keep it that way.
})
