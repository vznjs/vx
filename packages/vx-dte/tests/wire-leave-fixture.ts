// A worker that leaves while its relay holds every redial, with an ack
// owed down the socket that dropped: this process should end by itself
// once both participants left (wire.test.ts spawns it).

import { join } from '../src/wire.js'
import { servedRelay } from './served-relay.js'

const R = '00000000-0000-4000-8000-000000000003'
const served = servedRelay({ heartbeatMs: 500 })
const o = await join(served.url, R, 'orchestrator', null, undefined)
const a = await join(served.url, R, 'worker', null, undefined)
await o.poll()
await o.send(a.id, 'task')
await a.poll()
// The worker owes the orchestrator an ack, due in half a heartbeat.
const port = Number(new URL(served.url).port)
await served.stop()
// Same port, now a host that takes the connection and never answers it.
const hole = Bun.listen({
  hostname: '127.0.0.1',
  port,
  socket: { data() {} },
})
await Bun.sleep(300)
await Promise.all([a.leave(), o.leave()])
hole.stop(true)
console.log('left')
