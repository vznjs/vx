// The answers and body reads vx's servers share: each had its own copy,
// alike but for the words of a 405.

import { expect, it } from 'bun:test'
import { errorJson, notAllowed, readJson, Refusal } from '../src/index.js'

it('answers every refusal as { code, message }, a 405 with Allow', async () => {
  for (const [status, code] of [
    [400, 'bad_request'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [405, 'method_not_allowed'],
    [413, 'payload_too_large'],
    [500, 'internal_error'],
    [502, 'bad_gateway'],
    [418, 'error'],
  ] as const) {
    const res = errorJson(status, 'why')
    expect([res.status, await res.json()]).toEqual([status, { code, message: 'why' }])
  }
  const res = notAllowed('GET, HEAD')
  expect([res.status, res.headers.get('allow'), await res.json()]).toEqual([
    405,
    'GET, HEAD',
    { code: 'method_not_allowed', message: 'this route takes GET, HEAD' },
  ])
})

it('reads a JSON body, refusing another type, a wrong length and one past its limit as it arrives', async () => {
  const req = (body: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
    new Request('https://s.example/', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', ...headers },
    })
  const refused = async (p: Promise<unknown>) => {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(Refusal)
    return [(err as Refusal).status, (err as Refusal).message]
  }
  expect(await readJson(req('{"a":1}'), 100)).toEqual({ a: 1 })
  expect(await refused(readJson(req('{}', { 'content-type': 'text/plain' }), 100))).toEqual([
    400,
    'the body is application/json',
  ])
  expect(await refused(readJson(req('{'), 100))).toEqual([400, 'the body is not JSON'])
  expect(await refused(readJson(req('x'.repeat(101)), 100))).toEqual([
    413,
    'the body is at most 100 bytes',
  ])
  let pulled = 0
  const endless = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled++
      c.enqueue(new Uint8Array(64).fill(32))
    },
  })
  expect(await refused(readJson(req(endless), 1000))).toEqual([
    413,
    'the body is at most 1000 bytes',
  ])
  expect(pulled).toBeLessThan(40)
})
