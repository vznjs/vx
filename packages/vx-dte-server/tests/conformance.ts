// The Switchboard conformance suite (PROTOCOL.md): what any relay that
// speaks switchboard.v1 does, over real websockets. Each relay this
// package ships runs it: Bun (relay.test.ts), workerd
// (worker-sockets.test.ts) and the Docker image (docker/smoke.sh).

import { describe, expect, it } from 'bun:test'
import { createProver, PROOF_HEADER } from '../src/index.js'

export interface Target {
  /** The relay's URL. */
  base(): string
  /** What every request carries: its bearer token, if the relay wants one. */
  headers(): Record<string, string>
}

const V1 = 'switchboard.v1'

export function conformance(name: string, target: Target): void {
  /** A socket at `path`, offering `protocols`, and the frames it got. */
  const dial = async (path: string, extra: Record<string, string> = {}, protocols = [V1]) => {
    const ws = new WebSocket(new URL(path, target.base()).href.replace(/^http/, 'ws'), {
      headers: { ...target.headers(), ...extra },
      protocols,
    } as never)
    const frames: any[] = []
    let wake: (() => void) | undefined
    let closed: number | undefined
    ws.onmessage = (e) => {
      frames.push(JSON.parse(String(e.data)))
      wake?.()
    }
    ws.onclose = (e) => {
      closed = e.code
      wake?.()
    }
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve()
      ws.onerror = () => resolve()
    })
    const next = async (): Promise<any> => {
      while (frames.length === 0) {
        if (closed !== undefined) return { closed }
        await new Promise<void>((r) => (wake = r))
      }
      return frames.shift()
    }
    const send = (frame: unknown): void => ws.send(JSON.stringify(frame))
    return { ws, next, send }
  }

  /** A session's participants, each joined on its socket. */
  const session = () => {
    const id = crypto.randomUUID()
    const host = async (key?: Awaited<ReturnType<typeof createProver>>, protocols = [V1]) => {
      const prover = key ?? (await createProver())
      const path = `/v1/sessions/${id}/socket?join=${encodeURIComponent(JSON.stringify({ role: 'host', key: prover.key }))}`
      const s = await dial(path, { [PROOF_HEADER]: await prover.proof('GET', path, '') }, protocols)
      const first = await s.next()
      return { ...s, first, id: first.joined?.id as string, prover }
    }
    const peer = async (info?: unknown) => {
      const s = await dial(
        `/v1/sessions/${id}/socket?join=${encodeURIComponent(JSON.stringify({ role: 'peer', info }))}`,
      )
      const first = await s.next()
      return { ...s, first, id: first.joined?.id as string }
    }
    return { id, host, peer }
  }

  describe(`${name} speaks switchboard.v1`, () => {
    it('chooses the highest version both speak', async () => {
      const s = session()
      const h = await s.host(undefined, ['switchboard.v9', V1])
      expect(h.ws.protocol).toBe(V1)
      expect(h.first).toEqual({
        joined: { id: expect.any(String), heartbeatMs: expect.any(Number) },
      })
    })

    it('refuses 4406 naming its range when none is shared, or none offered', async () => {
      for (const offered of [['switchboard.v9'], []]) {
        const h = await session().host(undefined, offered)
        // The frame is the refusal: workerd never ends TCP after its close.
        expect(h.first).toEqual({ close: 4406, error: 'supported: switchboard.v1-v1' })
        h.ws.close()
      }
    })

    it('passes messages between the host and its peers, a peer only to the host', async () => {
      const s = session()
      const h = await s.host()
      const p = await s.peer({ cores: 2 })
      expect(await h.next()).toEqual({
        messages: [{ from: 'relay', body: { type: 'joined', id: p.id, info: { cores: 2 } } }],
      })
      h.send({ n: 1, sends: [{ to: p.id, body: 'go' }] })
      expect([await h.next(), await p.next()]).toEqual([
        { n: 1 },
        { messages: [{ from: 'host', body: 'go' }] },
      ])
      p.send({
        n: 1,
        sends: [
          { to: 'host', body: 'done' },
          { to: h.id, body: 'x' },
        ],
      })
      expect(await p.next()).toEqual({
        n: 1,
        results: [null, { status: 404, error: 'unknown to' }],
      })
      expect(await h.next()).toEqual({ messages: [{ from: p.id, body: 'done' }] })
      // Unnumbered: answered only on a failure.
      p.send({ sends: [{ to: 'nobody' }] })
      expect(await p.next()).toEqual({ n: null, results: [{ status: 404, error: 'unknown to' }] })
    })

    it('admits one host, signed by its key, and no peer before it', async () => {
      const s = session()
      expect((await s.peer()).first).toEqual({ close: 4410, error: 'no live session' })
      const unsigned = await dial(
        `/v1/sessions/${s.id}/socket?join=${encodeURIComponent(JSON.stringify({ role: 'host', key: (await createProver()).key }))}`,
      )
      expect((await unsigned.next()).close).toBe(4403)
      await s.host()
      expect((await s.host()).first).toEqual({ close: 4409, error: 'the session has a host' })
    })

    it('tells the host a peer left the moment it leaves', async () => {
      const s = session()
      const h = await s.host()
      const p = await s.peer()
      await h.next()
      p.send({ n: 1, leave: true })
      expect(await h.next()).toEqual({
        messages: [{ from: 'relay', body: { type: 'left', id: p.id } }],
      })
    })

    // Main 8d0619f's host socket ended 1006 3 s in, and its redial 350 ms
    // on found the session closed (2026-10-24): only `leave` ends one at once.
    it('keeps a session through its host’s dropped socket, for the host’s redial', async () => {
      const s = session()
      const h = await s.host()
      const p = await s.peer()
      await h.next()
      h.ws.close()
      p.send({ n: 1, sends: [{ to: 'host', body: 'while away' }] })
      expect(await p.next()).toEqual({ n: 1 })
      const path = `/v1/sessions/${s.id}/socket?id=${h.id}`
      const again = await dial(path, { [PROOF_HEADER]: await h.prover.proof('GET', path, '') })
      again.send({ n: 1, sends: [{ to: p.id, body: 'back' }] })
      expect(await again.next()).toEqual({ n: 1 })
      expect(await p.next()).toEqual({ messages: [{ from: 'host', body: 'back' }] })
      p.send({ n: 2, sends: [{ to: 'host', body: 'heard' }] })
      expect(await p.next()).toEqual({ n: 2 })
      expect(await again.next()).toEqual({ messages: [{ from: p.id, body: 'heard' }] })
    })

    it('keeps a peer through its dropped socket, for its redial', async () => {
      const s = session()
      const h = await s.host()
      const p = await s.peer()
      await h.next()
      p.ws.close()
      const again = await dial(`/v1/sessions/${s.id}/socket?id=${p.id}`)
      h.send({ n: 1, sends: [{ to: p.id, body: 'still yours' }] })
      expect(await h.next()).toEqual({ n: 1 })
      expect(await again.next()).toEqual({ messages: [{ from: 'host', body: 'still yours' }] })
    })

    it('lets the host remove a peer, and only the host', async () => {
      const s = session()
      const h = await s.host()
      const p = await s.peer()
      await h.next()
      p.send({ n: 1, remove: p.id })
      expect(await p.next()).toEqual({ n: 1, status: 403, error: 'only the host removes' })
      h.send({ n: 2, remove: p.id })
      expect(await h.next()).toEqual({ n: 2 })
      expect(await p.next()).toEqual({ close: 4404, error: 'gone' })
    })

    it('closes the session when its host leaves', async () => {
      const s = session()
      const h = await s.host()
      const p = await s.peer()
      h.send({ n: 1, leave: true })
      expect(await p.next()).toEqual({ messages: [{ from: 'relay', body: { type: 'closed' } }] })
      expect((await s.peer()).first).toEqual({ close: 4410, error: 'no live session' })
    })

    it('takes a socket dialed again by id, and closes an unknown id 4404', async () => {
      const s = session()
      const h = await s.host()
      const p = await s.peer()
      await h.next()
      const again = await dial(`/v1/sessions/${s.id}/socket?id=${p.id}`)
      h.send({ n: 1, sends: [{ to: p.id, body: 'here' }] })
      expect(await h.next()).toEqual({ n: 1 })
      expect(await again.next()).toEqual({ messages: [{ from: 'host', body: 'here' }] })
      const stranger = await dial(`/v1/sessions/${s.id}/socket?id=nobody`)
      expect(await stranger.next()).toEqual({ close: 4404, error: 'gone' })
    })

    it('answers a frame it cannot take with its status', async () => {
      const s = session()
      const h = await s.host()
      h.ws.send('nope')
      expect(await h.next()).toEqual({ n: null, status: 400, error: 'frame is not JSON' })
      h.send({ n: 3 })
      expect(await h.next()).toEqual({
        n: 3,
        status: 400,
        error: 'frame is sends, remove or leave',
      })
      h.ws.send(`{"n":4,"sends":[{"to":"x","body":"${'a'.repeat(1 << 20)}"}]}`)
      expect(await h.next()).toEqual({ n: 4, status: 413, error: 'body over 1 MiB' })
      // Bytes, not characters: this is 1.5 MiB.
      h.ws.send(`{"n":5,"sends":[{"to":"x","body":"${'€'.repeat(1 << 19)}"}]}`)
      expect(await h.next()).toEqual({ n: 5, status: 413, error: 'body over 1 MiB' })
    })
  })
}
