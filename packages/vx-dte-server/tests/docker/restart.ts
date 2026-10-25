// A run through the container at VX_DTE_RELAY_SMOKE across `docker restart`
// (smoke.sh): exits 1 unless the orchestrator and its worker, dialing back
// by their ids, still hear each other. The image keeps them in `--state`.
import { createProver, PROOF_HEADER } from '../../src/index.js'

const relay = process.env['VX_DTE_RELAY_SMOKE']!
const container = process.env['VX_DTE_RELAY_CONTAINER']!
const run = crypto.randomUUID()
const prover = await createProver()
const path = (query: string): string => `/v1/sessions/${run}/socket?${query}`

async function dial(query: string, host = false): Promise<{ next(): Promise<any>; ws: WebSocket }> {
  const headers: Record<string, string> = host
    ? { [PROOF_HEADER]: await prover.proof('GET', path(query), '') }
    : {}
  const ws = new WebSocket(relay.replace(/^http/, 'ws') + path(query), {
    headers,
    protocols: ['switchboard.v1'],
  } as never)
  const frames: any[] = []
  let wake: (() => void) | undefined
  ws.onmessage = (e) => {
    frames.push(JSON.parse(String(e.data)))
    wake?.()
  }
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  const next = async (): Promise<any> => {
    while (frames.length === 0) await new Promise<void>((r) => (wake = r))
    return frames.shift()
  }
  return { next, ws }
}

const deadline = setTimeout(() => {
  console.error('vx-dte-server restart: no answer in 30 s')
  process.exit(1)
}, 30_000)
const host = await dial(
  `join=${encodeURIComponent(JSON.stringify({ role: 'host', key: prover.key }))}`,
  true,
)
const o = (await host.next()).joined.id as string
const peer = await dial(`join=${encodeURIComponent('{"role":"peer"}')}`)
const a = (await peer.next()).joined.id as string
await host.next()
const restarted = Bun.spawnSync(['docker', 'restart', '-t', '5', container])
if (restarted.exitCode !== 0) {
  console.error(`vx-dte-server restart: docker restart: ${restarted.stderr.toString()}`)
  process.exit(1)
}
// Dialed back within the grace, as a client does once the relay listens.
let again: Awaited<ReturnType<typeof dial>> | undefined
for (let i = 0; again === undefined && i < 50; i++) {
  again = await dial(`id=${o}`, true).catch(async () => {
    await Bun.sleep(100)
    return undefined
  })
}
const back = await dial(`id=${a}`)
back.ws.send(JSON.stringify({ n: 1, sends: [{ to: 'host', body: 'still here' }] }))
const answer = await back.next()
const heard = await again!.next()
clearTimeout(deadline)
if (answer.n !== 1 || answer.status !== undefined || heard.messages?.[0]?.body !== 'still here') {
  console.error(`vx-dte-server restart: heard ${JSON.stringify([answer, heard])}`)
  process.exit(1)
}
console.log('vx-dte-server restart: a run carried across docker restart')
again!.ws.close()
back.ws.close()
