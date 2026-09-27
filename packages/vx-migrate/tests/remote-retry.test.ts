// Turbo's resend rule (`turborepo-api-client/src/retry.rs`), as both cache
// wires apply it: which answers are resent, after how long, how often.
import { describe, expect, it } from 'bun:test'
import { resolveNxCacheConfig, resolveTurboCacheConfig } from '../src/index.js'
import { withRetry } from '../src/remote-retry.js'

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
  const last = await withRetry(send, retries, async (ms) => {
    // An unbounded loop fails the row instead of hanging the suite.
    if (waits.length > 10) throw new Error('resent past any bound')
    waits.push(ms)
  }).then(
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

  it('a 429 waits its Retry-After, capped at 10 s; 2 s without one or with one unread', async () => {
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
    expect(waits).toEqual([[3000], [0], [10_000], [10_000], [0], [2000], [2000]])
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
        drive([fail('ConnectionRefused'), status(200)]),
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

  it('retries bounds the resends: 0 sends once, 2 sends three times', async () => {
    expect([
      await drive([status(503)], 0),
      await drive([status(503)], 2),
      await drive([fail('ConnectionRefused')], 2),
    ]).toEqual([
      { attempts: 1, waits: [], last: 503 },
      { attempts: 3, waits: [2000, 2000], last: 503 },
      { attempts: 3, waits: [2000, 2000], last: 'ConnectionRefused' },
    ])
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
      'vx/turbo-cache: retries must be a whole number ≥ 0, got NaN',
      'vx/turbo-cache: retries must be a whole number ≥ 0, got -1',
      'vx/turbo-cache: retries must be a whole number ≥ 0, got 1.5',
      '(no refusal)',
      '(no refusal)',
    ])
    expect([NaN, -1, 1.5, 0, 3].map(nx)).toEqual([
      'vx/nx-cache: retries must be a whole number ≥ 0, got NaN',
      'vx/nx-cache: retries must be a whole number ≥ 0, got -1',
      'vx/nx-cache: retries must be a whole number ≥ 0, got 1.5',
      '(no refusal)',
      '(no refusal)',
    ])
  })
})
