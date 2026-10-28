// Turbo's resend rule (`turborepo-api-client/src/retry.rs`), as both cache
// wires apply it: which answers are resent, after how long, how often.
import { describe, expect, it } from 'bun:test'
import { resolveNxCacheConfig } from '../src/nx-cache/index.js'
import { resolveTurboCacheConfig } from '../src/turbo-cache/index.js'
import { Cooldown, withRetry } from '../src/remote-retry.js'

type Answer = Response | Error

const fail = (code: string, name = 'TypeError'): Error =>
  Object.assign(new Error(code), { code, name })

/** Attempts made and waits taken when the server answers `answers` in turn. */
async function drive(
  answers: Answer[],
  retries = 1,
): Promise<{ attempts: number; waits: number[]; last: number | string }> {
  let attempts = 0
  const waits: number[] = []
  const send = async (): Promise<Response> => {
    const a = answers[Math.min(attempts++, answers.length - 1)]!
    if (a instanceof Error) throw a
    return a
  }
  // A clock only the waits move: a wait read off Date.now could be a ms short.
  let now = 0
  const clock = () => now
  const wait = async (ms: number) => {
    // An unbounded loop fails the row instead of hanging the suite.
    if (waits.length > 10) throw new Error('resent past any bound')
    waits.push(ms)
    now += ms
  }
  const last = await withRetry(send, retries, wait, new Cooldown(clock), clock).then(
    (r) => r.status,
    (e: Error) => e.message,
  )
  return { attempts, waits, last }
}

const status = (s: number, headers: Record<string, string> = {}) =>
  new Response(null, { status: s, headers })

describe('withRetry', () => {
  it('resends a 5xx once after 2 s, but not a 501, a 4xx or a success', async () => {
    expect(
      await Promise.all([500, 502, 503, 501, 404, 400, 200].map((s) => drive([status(s)]))),
    ).toEqual([
      { attempts: 2, waits: [2000], last: 500 },
      { attempts: 2, waits: [2000], last: 502 },
      { attempts: 2, waits: [2000], last: 503 },
      { attempts: 1, waits: [], last: 501 },
      { attempts: 1, waits: [], last: 404 },
      { attempts: 1, waits: [], last: 400 },
      { attempts: 1, waits: [], last: 200 },
    ])
  })

  it('a 429 waits its Retry-After, capped at 10 s; 2 s without one or with one unread; 0 not at all', async () => {
    const date = new Date(Date.now() + 60_000).toUTCString()
    const past = new Date(Date.now() - 60_000).toUTCString()
    const waits = await Promise.all(
      [
        { 'retry-after': '3' },
        { 'retry-after': '0' },
        { 'retry-after': '60' },
        { 'retry-after': date },
        { 'retry-after': past },
        { 'retry-after': 'soon' },
        {},
      ].map(async (h) => (await drive([status(429, h), status(200)])).waits),
    )
    expect(waits).toEqual([[3000], [], [10_000], [10_000], [], [2000], [2000]])
  })

  it('a 429 that says Retry-After: 0 again waits 2 s, so the budget still ends it', async () => {
    const zero = () => status(429, { 'retry-after': '0' })
    expect((await drive([zero(), zero(), status(200)])).waits).toEqual([2000])
    expect(await drive([zero()])).toEqual({
      attempts: 12,
      waits: Array(10).fill(2000),
      last: 429,
    })
  })

  it('the answer that is resent has its body cancelled, so it holds no connection', async () => {
    let cancelled = 0
    const body = () =>
      new ReadableStream({
        cancel() {
          cancelled++
        },
      })
    await drive([new Response(body(), { status: 503 }), status(200)])
    expect(cancelled).toBe(1)
  })

  it('the resend is what the caller gets', async () => {
    expect(await drive([status(503), status(200)])).toEqual({
      attempts: 2,
      waits: [2000],
      last: 200,
    })
  })

  it('a connection never made is resent; a spent deadline or another error is not', async () => {
    expect(
      await Promise.all([
        drive([fail('ECONNREFUSED'), status(200)]),
        drive([fail('ENOTFOUND'), status(200)]),
        drive([fail('timed out', 'TimeoutError'), status(200)]),
        drive([fail('ECONNRESET'), status(200)]),
      ]),
    ).toEqual([
      { attempts: 2, waits: [2000], last: 200 },
      { attempts: 2, waits: [2000], last: 200 },
      { attempts: 1, waits: [], last: 'timed out' },
      { attempts: 1, waits: [], last: 'ECONNRESET' },
    ])
  })

  it("Bun's own refused connection is resent (1.4.4 codes it ECONNREFUSED)", async () => {
    const refused = await fetch('http://127.0.0.1:1').then(
      () => new Error('port 1 answered'),
      (e: Error) => e,
    )
    expect(await drive([refused, status(200)])).toEqual({ attempts: 2, waits: [2000], last: 200 })
  })

  it('retries bounds the resends: 0 sends once, 2 sends three times', async () => {
    expect([
      await drive([status(503)], 0),
      await drive([status(503)], 2),
      await drive([fail('ECONNREFUSED')], 2),
    ]).toEqual([
      { attempts: 1, waits: [], last: 503 },
      { attempts: 3, waits: [2000, 2000], last: 503 },
      { attempts: 3, waits: [2000, 2000], last: 'ECONNREFUSED' },
    ])
  })
})

/**
 * A server rate-limited from the first request until `limitMs`, each 429
 * naming the seconds left, on a clock only the waits move.
 */
function limited(limitMs: number) {
  let now = 0
  let started: number | undefined
  const sent: number[] = []
  const send = async (): Promise<Response> => {
    sent.push(now)
    started ??= now
    const left = started + limitMs - now
    if (left <= 0) return status(200)
    return status(429, { 'retry-after': String(Math.ceil(left / 1000)) })
  }
  const wait = async (ms: number): Promise<void> => {
    now += ms
  }
  return { send, wait, sent, clock: () => now }
}

describe('a rate limit (429)', () => {
  it('outlasting one capped wait is waited out, within the 20 s budget', async () => {
    // A 12 s limit: the resend at the 10 s cap met it again, and the hit
    // was lost (Growth's remote-429-cooldown.sh, 2026-10-16).
    const s = limited(12_000)
    const res = await withRetry(s.send, 1, s.wait, new Cooldown(s.clock), s.clock)
    expect([res.status, s.sent]).toEqual([200, [0, 10_000, 12_000]])
  })

  it('past the budget, the 429 is the answer', async () => {
    const s = limited(60_000)
    const res = await withRetry(s.send, 1, s.wait, new Cooldown(s.clock), s.clock)
    expect([res.status, s.sent]).toEqual([429, [0, 10_000, 20_000]])
  })

  it('holds every request of the remote behind the first 429, before its first send', async () => {
    const s = limited(3_000)
    const cooldown = new Cooldown(s.clock)
    const first = await withRetry(s.send, 1, s.wait, cooldown, s.clock)
    // Sent while the limit stood, it would have spent a try on a 429.
    const before = s.sent.length
    const cd = new Cooldown(s.clock)
    cd.until = 5_000
    const second = withRetry(s.send, 1, s.wait, cd, s.clock)
    expect([first.status, (await second).status]).toEqual([200, 200])
    expect(s.sent.slice(before)).toEqual([5_000])
    expect(s.sent.slice(0, before)).toEqual([0, 3_000])
  })

  it('retries: 0 sends once, 429 or not', async () => {
    const s = limited(3_000)
    const res = await withRetry(s.send, 0, s.wait, new Cooldown(s.clock), s.clock)
    expect([res.status, s.sent]).toEqual([429, [0]])
  })
})

describe('the retries option', () => {
  const refusal = (f: () => unknown): string => {
    try {
      f()
      return '(no refusal)'
    } catch (err) {
      return (err as Error).message
    }
  }
  // A NaN never reaches the bound: the request would be resent forever.
  it('is a whole number ≥ 0 on both wires', () => {
    const turbo = (retries: number) =>
      refusal(() => resolveTurboCacheConfig({ apiUrl: 'http://t', token: 't', retries }, {}))
    const nx = (retries: number) =>
      refusal(() => resolveNxCacheConfig({ server: 'http://n', retries }, {}))
    expect([NaN, -1, 1.5, 0, 3].map(turbo)).toEqual([
      'turboCache(): retries must be a whole number ≥ 0, got NaN',
      'turboCache(): retries must be a whole number ≥ 0, got -1',
      'turboCache(): retries must be a whole number ≥ 0, got 1.5',
      '(no refusal)',
      '(no refusal)',
    ])
    expect([NaN, -1, 1.5, 0, 3].map(nx)).toEqual([
      'nxCache(): retries must be a whole number ≥ 0, got NaN',
      'nxCache(): retries must be a whole number ≥ 0, got -1',
      'nxCache(): retries must be a whole number ≥ 0, got 1.5',
      '(no refusal)',
      '(no refusal)',
    ])
  })
})
