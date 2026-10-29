// A relay and a worker in a process of their own, so a test can hold its
// own event loop and see what the worker makes of its orchestrator
// (wire.test.ts spawns it). Lines in: `go` (the orchestrator joined),
// `done`. Lines out: the relay's url, `joined`, then `alive` or
// `ended <why>`.

import { join } from '../src/wire.js'
import { servedRelay } from './served-relay.js'

const R = process.argv[2]!
const served = servedRelay({ heartbeatMs: 500 })
console.log(served.url)
const lines = (async function* () {
  let rest = ''
  for await (const chunk of Bun.stdin.stream()) {
    rest += new TextDecoder().decode(chunk)
    for (let i = rest.indexOf('\n'); i !== -1; i = rest.indexOf('\n')) {
      yield rest.slice(0, i)
      rest = rest.slice(i + 1)
    }
  }
})()
await lines.next()
const a = await join(served.url, R, 'worker', null, undefined)
console.log('joined')
let ended: string | undefined
const polling = (async () => {
  for (;;) await a.poll()
})().catch((err: unknown) => (ended = err instanceof Error ? err.message : String(err)))
await lines.next()
console.log(ended === undefined ? 'alive' : `ended ${ended}`)
if (ended === undefined) await a.leave()
void polling
await served.stop()
process.exit(0)
