// The localBinding tests' port comes from below the kernel's ephemeral
// range: a `port: 0` pick was taken by another shard's listener on a
// shared worker before vx bound it (#4162 CI, port 39429).
import { readFileSync } from 'node:fs'
import { expect, it } from 'bun:test'
import { freePort } from './helpers/free-port.js'

it('a picked port is free and below every ephemeral port the kernel hands out', () => {
  const low =
    process.platform === 'linux'
      ? Number(
          readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/)[0],
        )
      : 49_152
  const port = freePort()
  Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } }).stop(true)
  expect(port).toBeLessThan(low)
})
