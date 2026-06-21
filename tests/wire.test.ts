import { describe, expect, it } from 'bun:test'
import {
  clientMessageToEnvelope,
  decodeEnvelope,
  encodeForNDJSON,
  encodeForSSE,
  encodeForWS,
  ENVELOPE_ERRORS,
  envelopeToClientMessage,
  envelopeToServerMessage,
  isEnvelope,
  isNotification,
  isRequest,
  makeError,
  makeNotification,
  makeRequest,
  makeResponse,
  WIRE_CHANNELS,
  WIRE_PROTOCOL_VERSION,
} from '../src/orchestrator/index.js'
import type { ClientMessage, ServerMessage, WireRequest } from '../src/orchestrator/index.js'

describe('JSON-RPC 2.0 envelope builders', () => {
  it('makeRequest produces a valid request envelope', () => {
    const r = makeRequest(1, 'submit.run', { tasks: ['build'] })
    expect(r.jsonrpc).toBe('2.0')
    expect(r.id).toBe(1)
    expect(r.method).toBe('submit.run')
    expect(r.params).toEqual({ tasks: ['build'] })
  })

  it('makeRequest omits params when undefined', () => {
    const r = makeRequest(1, 'state.snapshot')
    expect('params' in r).toBe(false)
  })

  it('makeNotification has no id', () => {
    const n = makeNotification('events.append', { 'vx.kind': 'task:start' })
    expect('id' in n).toBe(false)
    expect(n.method).toBe('events.append')
  })

  it('makeResponse wraps a result', () => {
    const r = makeResponse('a', { ok: true })
    expect(r.result).toEqual({ ok: true })
  })

  it('makeError wraps a structured error', () => {
    const e = makeError(1, ENVELOPE_ERRORS.USER_ERROR, 'bad input', { taskId: 'a#b' })
    expect(e.error.code).toBe(-32000)
    expect(e.error.message).toBe('bad input')
    expect(e.error.data).toEqual({ taskId: 'a#b' })
  })
})

describe('envelope type-guards', () => {
  it('isEnvelope rejects non-2.0 objects', () => {
    expect(isEnvelope({ jsonrpc: '1.0', method: 'x' })).toBe(false)
    expect(isEnvelope(null)).toBe(false)
    expect(isEnvelope('string')).toBe(false)
    expect(isEnvelope(makeNotification('x'))).toBe(true)
  })

  it('isRequest discriminates against notifications', () => {
    expect(isRequest(makeRequest(1, 'x'))).toBe(true)
    expect(isRequest(makeNotification('x') as never)).toBe(false)
  })

  it('isNotification discriminates against requests', () => {
    expect(isNotification(makeNotification('x'))).toBe(true)
    expect(isNotification(makeRequest(1, 'x') as never)).toBe(false)
  })
})

describe('round-trip — ServerMessage ⇄ Envelope', () => {
  it('event ⇄ events.append notification', () => {
    const msg: ServerMessage = {
      t: 'event',
      event: {
        kind: 'task:start',
        run: { id: 'r1', startedAt: 0 },
        node: { id: 'a#b' },
      } as ServerMessage extends infer S ? (S extends { t: 'event' } ? S['event'] : never) : never,
    }
    const env = envelopeToServerMessage.bind(null) // ensure import is used
    const out = envelopeToServerMessage(
      // round through the encoder
      // @ts-expect-error — accessing the typed builder via a generic
      JSON.parse(encodeForWS(serverMessageToEnvelopeWrap(msg))),
    )
    expect(out?.t).toBe('event')
    void env
  })

  it('result ⇄ submit.run response', () => {
    const msg: ServerMessage = { t: 'result', result: { ok: true, outcomes: [] } }
    const env = serverMessageToEnvelopeWrap(msg, 42)
    expect('result' in env).toBe(true)
    expect(envelopeToServerMessage(env)?.t).toBe('result')
  })

  it('error → error envelope → ServerMessage error', () => {
    const msg: ServerMessage = { t: 'error', message: 'oops' }
    const env = serverMessageToEnvelopeWrap(msg, 1)
    expect('error' in env).toBe(true)
    const back = envelopeToServerMessage(env)
    expect(back?.t).toBe('error')
    if (back?.t === 'error') expect(back.message).toBe('oops')
  })

  it('task:assign / cache:exists / coord:drain round-trip via coord.* notifications', () => {
    const msgs: ServerMessage[] = [
      {
        t: 'task:assign',
        hash: 'deadbeef',
        node: {
          id: 'pkg#build',
          projectName: 'pkg',
          projectDir: '/x/pkg',
          taskName: 'build',
          command: 'bun build',
          cacheable: true,
        },
      },
      { t: 'cache:exists', hash: 'd', present: true },
      { t: 'coord:drain' },
    ]
    for (const m of msgs) {
      const env = serverMessageToEnvelopeWrap(m)
      const back = envelopeToServerMessage(env)
      expect(back?.t).toBe(m.t)
    }
  })
})

describe('round-trip — ClientMessage ⇄ Envelope', () => {
  it('run ⇄ submit.run request', () => {
    const msg: ClientMessage = { t: 'run', request: { cwd: '/x', tasks: ['build'] } }
    const env = clientMessageToEnvelope(msg, 1) as WireRequest
    expect(env.method).toBe('submit.run')
    const back = envelopeToClientMessage(env)
    expect(back?.t).toBe('run')
  })

  it('worker:* messages map to worker.* notifications', () => {
    const cases: ClientMessage[] = [
      { t: 'worker:hello', workerId: 'w1', capacity: 4, labels: ['linux-x64'] },
      { t: 'worker:pull', available: 2 },
      { t: 'worker:start', taskHash: 'h' },
      { t: 'worker:stdout', taskHash: 'h', chunk: 'line\n' },
      { t: 'worker:stderr', taskHash: 'h', chunk: 'err\n' },
      {
        t: 'worker:done',
        taskHash: 'h',
        outcome: { status: 'success', exitCode: 0, durationMs: 10, cacheSource: 'miss' },
      },
      { t: 'worker:bye', reason: 'shutdown' },
    ]
    for (const c of cases) {
      const env = clientMessageToEnvelope(c)
      expect(isNotification(env)).toBe(true)
      const back = envelopeToClientMessage(env)
      expect(back?.t).toBe(c.t)
    }
  })
})

describe('transport encoders', () => {
  it('encodeForWS produces compact JSON', () => {
    const out = encodeForWS(makeNotification('x', { y: 1 }))
    expect(out).toBe(`{"jsonrpc":"2.0","method":"x","params":{"y":1}}`)
  })

  it('encodeForSSE produces a data: block with double newline', () => {
    const out = encodeForSSE(makeNotification('x'))
    expect(out.startsWith('data: ')).toBe(true)
    expect(out.endsWith('\n\n')).toBe(true)
  })

  it('encodeForNDJSON appends a single newline', () => {
    const out = encodeForNDJSON(makeNotification('x'))
    expect(out.endsWith('\n')).toBe(true)
    expect(out.split('\n').filter(Boolean).length).toBe(1)
  })

  it('decodeEnvelope round-trips', () => {
    const env = makeRequest(1, 'state.snapshot')
    expect(decodeEnvelope(JSON.stringify(env))).toEqual(env)
  })

  it('decodeEnvelope rejects non-envelope JSON', () => {
    expect(() => decodeEnvelope(`{"foo":1}`)).toThrow(/JSON-RPC 2.0 envelope/)
  })
})

describe('constants', () => {
  it('protocol version', () => {
    expect(WIRE_PROTOCOL_VERSION).toBe('1.0')
  })

  it('channels expose the four documented surfaces', () => {
    expect([...WIRE_CHANNELS]).toEqual(['vx:events', 'vx:state', 'vx:rpc', 'vx:submit'])
  })

  it('error code namespace covers the documented user-level codes', () => {
    expect(ENVELOPE_ERRORS.USER_ERROR).toBe(-32000)
    expect(ENVELOPE_ERRORS.METHOD_NOT_FOUND).toBe(-32601)
  })
})

// Small wrapper so the test doesn't have to import the function name twice
import { serverMessageToEnvelope } from '../src/orchestrator/index.js'
function serverMessageToEnvelopeWrap(msg: ServerMessage, id?: number | string) {
  return serverMessageToEnvelope(msg, id)
}
