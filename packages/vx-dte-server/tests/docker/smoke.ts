// One run through a relay at VX_DTE_RELAY_SMOKE (smoke.sh): exits 1 unless
// an orchestrator and a worker join over sockets and each hears the other.
import { createProver } from '../../src/index.js'

const relay = process.env['VX_DTE_RELAY_SMOKE']!
const run = crypto.randomUUID()
const base = `${relay.replace(/^http/, 'ws')}/v1/sessions/${run}/`

interface Peer {
  id: string
  next(): Promise<any>
  ws: WebSocket
}

async function dial(role: 'host' | 'peer'): Promise<Peer> {
  const prover = role === 'host' ? await createProver() : undefined
  const join = JSON.stringify({ role, ...(prover === undefined ? {} : { key: prover.key }) })
  const query = `socket?join=${encodeURIComponent(join)}`
  const headers: Record<string, string> = {}
  if (prover !== undefined) {
    const { pathname, search } = new URL(base + query)
    headers['relay-proof'] = await prover.proof('GET', pathname + search, '')
  }
  const ws = new WebSocket(base + query, { headers, protocols: ['switchboard.v1'] } as never)
  const frames: any[] = []
  const waiting: ((f: any) => void)[] = []
  ws.onmessage = (e) => {
    const f = JSON.parse(String(e.data))
    const w = waiting.shift()
    if (w === undefined) frames.push(f)
    else w(f)
  }
  const next = () =>
    frames.length > 0
      ? Promise.resolve(frames.shift())
      : new Promise<any>((resolve) => waiting.push(resolve))
  const first = await next()
  if (first.joined === undefined) throw new Error(`${role}: ${JSON.stringify(first)}`)
  return { id: first.joined.id, next, ws }
}

/** The next frame that carries a message, past answers and notices. */
async function heard(p: Peer, from: string): Promise<unknown> {
  for (;;) {
    const f = await p.next()
    const m = f.messages?.find((x: { from: string }) => x.from === from)
    if (m !== undefined) return m.body
  }
}

const deadline = setTimeout(() => {
  console.error('vx-dte-server smoke: no answer in 10 s')
  process.exit(1)
}, 10_000)
const o = await dial('host')
const w = await dial('peer')
w.ws.send(JSON.stringify({ n: 0, sends: [{ to: 'host', body: 'up' }] }))
const up = await heard(o, w.id)
o.ws.send(JSON.stringify({ n: 0, sends: [{ to: w.id, body: 'down' }] }))
const down = await heard(w, 'host')
clearTimeout(deadline)
if (up !== 'up' || down !== 'down') {
  console.error(`vx-dte-server smoke: heard ${JSON.stringify([up, down])}`)
  process.exit(1)
}
console.log('vx-dte-server smoke: a run carried both ways')
o.ws.close()
w.ws.close()
