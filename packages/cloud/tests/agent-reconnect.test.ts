// The agent loop reconnects a standalone helper through a transient WS drop
// (bounded backoff, a FRESH agentId per attempt), but never reconnects a
// terminal close (refused / stopped) and gives up after the budget. Driven
// through the injected `wsFactory` seam — a fake socket the test opens/drops on
// demand — so it exercises the connection lifecycle with no live serve.

import { describe, expect, it } from 'bun:test'
import {
  runAgentLoop,
  type AgentLoopOptions,
  type AgentSocket,
  type AgentSocketFactory,
} from '../src/dist/agent-loop.js'

interface FakeSocket extends AgentSocket {
  sent: string[]
  /** Simulate the connection opening (server accepted the hello). */
  open(): void
  /** Simulate the peer/network dropping the socket. */
  drop(): void
}

function fakeFactory(): { factory: AgentSocketFactory; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = []
  const factory: AgentSocketFactory = () => {
    const s: FakeSocket = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      sent: [],
      send: (d) => s.sent.push(d),
      close: () => s.onclose?.(),
      open: () => s.onopen?.(),
      drop: () => s.onclose?.(),
    }
    sockets.push(s)
    return s
  }
  return { factory, sockets }
}

const baseOpts = (
  factory: AgentSocketFactory,
  extra: Partial<AgentLoopOptions> = {},
): AgentLoopOptions => ({
  origin: 'http://serve.test',
  workspaceId: 'ws1',
  session: 'sess',
  commitSha: 'commit-a',
  capacity: 4,
  checkoutRoot: '/w',
  wsFactory: factory,
  reconnectBaseMs: 5,
  ...extra,
})

async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}

function helloIdOf(socket: FakeSocket): string {
  const hello = socket.sent.map((s) => JSON.parse(s)).find((m) => m.t === 'agent:hello')
  return hello.agentId as string
}

describe('agent loop — reconnect on transient drop', () => {
  it('reconnects with a FRESH agentId after an unexpected close, then stops cleanly', async () => {
    const { factory, sockets } = fakeFactory()
    const loop = runAgentLoop(baseOpts(factory, { maxReconnects: 3 }))

    expect(sockets).toHaveLength(1)
    sockets[0]!.open()
    const firstId = helloIdOf(sockets[0]!)

    // A transient drop — the loop should schedule a reconnect (not resolve).
    sockets[0]!.drop()
    await until(() => sockets.length === 2, 'a reconnect socket')
    sockets[1]!.open()
    const secondId = helloIdOf(sockets[1]!)
    // A fresh id keeps the two registrations independent, so the serve's
    // drop→reassign of the first socket's tasks can't be clobbered.
    expect(secondId).not.toBe(firstId)

    loop.stop()
    expect(await loop.done).toEqual({ ok: true, reason: 'stopped' })
  })

  it('does NOT reconnect after a refused close (terminal)', async () => {
    const { factory, sockets } = fakeFactory()
    const loop = runAgentLoop(baseOpts(factory))
    sockets[0]!.open()
    sockets[0]!.onmessage?.({
      data: JSON.stringify({ t: 'agent:refused', reason: 'protocol mismatch' }),
    })
    sockets[0]!.drop()
    expect(await loop.done).toEqual({ ok: false, reason: 'refused' })
    await Bun.sleep(20)
    expect(sockets).toHaveLength(1) // never reconnected
  })

  it('gives up (closed) after exhausting the reconnect budget', async () => {
    const { factory, sockets } = fakeFactory()
    const loop = runAgentLoop(baseOpts(factory, { maxReconnects: 2 }))
    sockets[0]!.open()
    sockets[0]!.drop() // attempt 1
    await until(() => sockets.length === 2, 'reconnect #1')
    sockets[1]!.drop() // never opened → attempt 2
    await until(() => sockets.length === 3, 'reconnect #2')
    sockets[2]!.drop() // budget exhausted
    expect(await loop.done).toEqual({ ok: false, reason: 'closed' })
    await Bun.sleep(20)
    expect(sockets).toHaveLength(3) // no fourth attempt
  })

  it('a submitter self-agent (ownerSubmissionId) does NOT reconnect', async () => {
    const { factory, sockets } = fakeFactory()
    const loop = runAgentLoop(
      baseOpts(factory, { ownerSubmissionId: 'sub-1', labels: ['submitter'] }),
    )
    sockets[0]!.open()
    sockets[0]!.drop()
    expect(await loop.done).toEqual({ ok: false, reason: 'closed' })
    await Bun.sleep(20)
    expect(sockets).toHaveLength(1)
  })

  it('gives up on a FLAPPING serve (open-then-immediate-close) instead of reconnecting forever', async () => {
    const { factory, sockets } = fakeFactory()
    // A long dwell so an open-then-immediate-drop never counts as "stable" and
    // never refreshes the budget — the flap must exhaust maxReconnects and stop.
    const loop = runAgentLoop(baseOpts(factory, { maxReconnects: 2, reconnectStableMs: 60_000 }))
    sockets[0]!.open()
    sockets[0]!.drop() // flap → reconnect 1
    await until(() => sockets.length === 2, 'reconnect 1')
    sockets[1]!.open()
    sockets[1]!.drop() // flap → reconnect 2
    await until(() => sockets.length === 3, 'reconnect 2')
    sockets[2]!.open()
    sockets[2]!.drop() // flap → budget exhausted, no reconnect 3
    expect(await loop.done).toEqual({ ok: false, reason: 'closed' })
    await Bun.sleep(20)
    expect(sockets).toHaveLength(3) // a bare open() never refreshed the budget
  })

  it('a connection that stays open past the dwell REFRESHES the reconnect budget', async () => {
    const { factory, sockets } = fakeFactory()
    // maxReconnects:1 with a SHORT dwell — a connection that survives the dwell
    // earns a fresh budget, so the agent survives more than one blip over its life.
    const loop = runAgentLoop(baseOpts(factory, { maxReconnects: 1, reconnectStableMs: 15 }))
    sockets[0]!.open()
    await Bun.sleep(35) // stay open past the dwell → budget refreshes to 0
    sockets[0]!.drop() // attempt 1 (0 < 1)
    await until(() => sockets.length === 2, 'first reconnect')
    sockets[1]!.open()
    await Bun.sleep(35) // stable again → budget refreshes again
    sockets[1]!.drop() // attempt 1 AGAIN (would be "give up" without the refresh)
    await until(() => sockets.length === 3, 'second reconnect after a refresh')
    loop.stop()
    expect(await loop.done).toEqual({ ok: true, reason: 'stopped' })
  })

  it('stop() while mid-backoff (no live socket) still resolves', async () => {
    const { factory, sockets } = fakeFactory()
    const loop = runAgentLoop(baseOpts(factory, { maxReconnects: 5, reconnectBaseMs: 1000 }))
    sockets[0]!.open()
    sockets[0]!.drop() // schedules a reconnect ~1s out
    // Stop before the reconnect timer fires — done must still resolve.
    loop.stop()
    expect(await loop.done).toEqual({ ok: true, reason: 'stopped' })
    await Bun.sleep(20)
    expect(sockets).toHaveLength(1) // the pending reconnect was cancelled
  })
})
